/**
 * Per-domain API call tracking and budget headroom for Warpline plugins.
 *
 * Tracks call counts per API domain and per plugin, persists state to
 * .warpline/state/api-budget.json, and exposes headroom for `warpline status --budget`.
 *
 * Warn-only by design: the tracker logs when a domain approaches
 * max_per_window but never blocks a call. Enforcement belongs to whichever
 * client actually talks to the API — a tracker that blocks would fail closed
 * on its own bookkeeping error. `fromSnapshot` falls back to defaults rather
 * than throwing, for the same reason.
 */

// ── Types ──────────────────────────────────────────────────────────────────

export interface DomainBudgetConfig {
  domain: string
  max_per_window: number
  /**
   * Length of the budget window in seconds — the authoritative field.
   * Seconds rather than hours because sub-hour windows are common (a
   * 600-per-5-minutes limit is not expressible in whole hours, and rounding
   * it to one overstates headroom by 12×).
   */
  window_seconds: number
  /** @deprecated legacy hours field; read-only, for snapshots written before
   *  `window_seconds` existed. Never written. */
  window_hours?: number
}

export interface DomainSnapshot {
  domain: string
  calls_this_window: number
  max_per_window: number
  /** Authoritative window length in seconds. */
  window_seconds: number
  /** @deprecated legacy hours field; read-only. See DomainBudgetConfig. */
  window_hours?: number
  remaining: number
  by_plugin: Record<string, number>
}

export interface BudgetSnapshot {
  window_start: string
  domains: DomainSnapshot[]
}

// ── Default domain budgets ─────────────────────────────────────────────────

/**
 * Seed budgets. Deliberately minimal: warpline knows nothing about which APIs
 * your plugins call, so shipping a roster of guesses would encode someone
 * else's deployment as everyone's default. `github` is here because the
 * bundled example plugin calls it and its published limit is stable.
 *
 * Pass your own list to the constructor for anything else — unknown domains
 * are also auto-created on first use with conservative defaults.
 */
export const DEFAULT_BUDGETS: DomainBudgetConfig[] = [
  { domain: 'github', max_per_window: 5000, window_seconds: 3600 },
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
   * Falls back to defaults if the snapshot is malformed.
   */
  static fromSnapshot(snap: BudgetSnapshot): ApiBudgetTracker {
    try {
      // Build config list from snapshot domains, falling back to DEFAULT_BUDGETS for known domains
      const defaultMap = new Map(DEFAULT_BUDGETS.map(b => [b.domain, b]))
      const configs: DomainBudgetConfig[] = snap.domains.map(d => {
        const def = defaultMap.get(d.domain)
        // Prefer window_seconds; fall back to a legacy window_hours snapshot
        // (×3600) so older persisted state still loads without a silent
        // semantic flip; finally the default.
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
      // Fallback: return a fresh tracker with defaults.
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
