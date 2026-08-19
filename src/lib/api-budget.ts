/**
 * Per-domain API call tracking and budget headroom for Warpline plugins.
 *
 * Tracks call counts per API domain and per plugin, persists state to
 * .warpline/state/api-budget.json, and exposes headroom for `warpline status --budget`.
 *
 * Security (T-87-02): Logs warning when domain approaches max_per_window.
 * No automatic blocking — manual CLI visibility only.
 * Security (T-87-03): fromSnapshot falls back to defaults on corrupt input.
 */

// ── Types ──────────────────────────────────────────────────────────────────

export interface DomainBudgetConfig {
  domain: string
  max_per_window: number
  /**
   * Length of the budget window in seconds — the authoritative field (D-13).
   * Replaces the old hours-only `window_hours`, which could not express the
   * Companies House 600-per-5-MINUTES limit (the prior encoding was 60× wrong).
   */
  window_seconds: number
  /** @deprecated legacy hours field; retained only to read pre-D-13 snapshots. */
  window_hours?: number
}

export interface DomainSnapshot {
  domain: string
  calls_this_window: number
  max_per_window: number
  /** Authoritative window length in seconds (D-13). */
  window_seconds: number
  /** @deprecated legacy hours field; retained only to read pre-D-13 snapshots. */
  window_hours?: number
  remaining: number
  by_plugin: Record<string, number>
}

export interface BudgetSnapshot {
  window_start: string
  domains: DomainSnapshot[]
}

// ── Default domain budgets ─────────────────────────────────────────────────

export const DEFAULT_BUDGETS: DomainBudgetConfig[] = [
  { domain: 'posthog', max_per_window: 600, window_seconds: 3600 },
  { domain: 'github', max_per_window: 5000, window_seconds: 3600 },
  // D-13: real Companies House limit is 600 requests per 5 MINUTES. The prior
  // encoding `window_hours: 5` expressed 600 / 5 HOURS — a 60× overstatement of
  // headroom. Enforcement lives in ch-client.ts; this tracker is warn-only.
  { domain: 'companies-house', max_per_window: 600, window_seconds: 300 },
  { domain: 'epc', max_per_window: 500, window_seconds: 3600 },
  { domain: 'supabase', max_per_window: 1000, window_seconds: 3600 },
]

// ── Internal state ─────────────────────────────────────────────────────────

interface DomainState {
  config: DomainBudgetConfig
  calls: number
  by_plugin: Record<string, number>
}

// ── ApiBudgetTracker ───────────────────────────────────────────────────────

export class ApiBudgetTracker {
  private domains: Map<string, DomainState>
  private windowStart: string

  constructor(configs: DomainBudgetConfig[] = DEFAULT_BUDGETS) {
    this.windowStart = new Date().toISOString()
    this.domains = new Map()
    for (const config of configs) {
      this.domains.set(config.domain, { config, calls: 0, by_plugin: {} })
    }
  }

  /**
   * Record API calls made to a domain (not attributed to a specific plugin).
   */
  recordCalls(domain: string, count: number): void {
    const state = this.getOrCreate(domain)
    state.calls += count
    this.warnIfOverBudget(domain, state)
  }

  /**
   * Record API calls attributed to a specific plugin.
   * Increments both the domain total and per-plugin breakdown.
   */
  recordPluginCalls(plugin: string, domain: string, count: number): void {
    const state = this.getOrCreate(domain)
    state.calls += count
    state.by_plugin[plugin] = (state.by_plugin[plugin] ?? 0) + count
    this.warnIfOverBudget(domain, state)
  }

  /**
   * Returns the current budget snapshot for all tracked domains.
   */
  snapshot(): BudgetSnapshot {
    const domains: DomainSnapshot[] = []
    for (const [domain, state] of this.domains) {
      domains.push({
        domain,
        calls_this_window: state.calls,
        max_per_window: state.config.max_per_window,
        window_seconds: state.config.window_seconds,
        remaining: Math.max(0, state.config.max_per_window - state.calls),
        by_plugin: { ...state.by_plugin },
      })
    }
    return {
      window_start: this.windowStart,
      domains,
    }
  }

  /**
   * Reset all counters and start a new window.
   */
  reset(): void {
    this.windowStart = new Date().toISOString()
    for (const state of this.domains.values()) {
      state.calls = 0
      state.by_plugin = {}
    }
  }

  /**
   * Restore a tracker from a persisted BudgetSnapshot.
   * Falls back to defaults if snapshot is malformed (T-87-03).
   */
  static fromSnapshot(snap: BudgetSnapshot): ApiBudgetTracker {
    try {
      // Build config list from snapshot domains, falling back to DEFAULT_BUDGETS for known domains
      const defaultMap = new Map(DEFAULT_BUDGETS.map(b => [b.domain, b]))
      const configs: DomainBudgetConfig[] = snap.domains.map(d => {
        const def = defaultMap.get(d.domain)
        // D-13 back-compat: prefer window_seconds; fall back to a legacy
        // window_hours snapshot (×3600) so pre-D-13 persisted state still loads
        // without a silent semantic flip; finally the default.
        const window_seconds =
          d.window_seconds ??
          (d.window_hours != null ? d.window_hours * 3600 : undefined) ??
          def?.window_seconds ??
          3600
        return {
          domain: d.domain,
          max_per_window: d.max_per_window ?? def?.max_per_window ?? 1000,
          window_seconds,
        }
      })

      // Add any default domains not in the snapshot
      for (const def of DEFAULT_BUDGETS) {
        if (!configs.find(c => c.domain === def.domain)) {
          configs.push(def)
        }
      }

      const tracker = new ApiBudgetTracker(configs)
      tracker.windowStart = snap.window_start ?? new Date().toISOString()

      // Restore domain state from snapshot
      for (const d of snap.domains) {
        const state = tracker.domains.get(d.domain)
        if (state) {
          state.calls = d.calls_this_window ?? 0
          state.by_plugin = { ...(d.by_plugin ?? {}) }
        }
      }

      return tracker
    } catch {
      // Fallback: return fresh tracker with defaults (T-87-03)
      return new ApiBudgetTracker()
    }
  }

  /**
   * Serialise to BudgetSnapshot (alias for snapshot()).
   */
  toJSON(): BudgetSnapshot {
    return this.snapshot()
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private getOrCreate(domain: string): DomainState {
    let state = this.domains.get(domain)
    if (!state) {
      // Unknown domain — create with conservative defaults
      state = {
        config: { domain, max_per_window: 1000, window_seconds: 3600 },
        calls: 0,
        by_plugin: {},
      }
      this.domains.set(domain, state)
    }
    return state
  }

  private warnIfOverBudget(domain: string, state: DomainState): void {
    const pct = state.calls / state.config.max_per_window
    if (pct >= 0.9) {
      const remaining = Math.max(0, state.config.max_per_window - state.calls)
      console.warn(
        `[api-budget] WARNING: ${domain} at ${Math.round(pct * 100)}% of budget (${remaining} remaining / ${state.config.max_per_window} limit)`,
      )
    }
  }
}
