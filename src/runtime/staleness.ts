/**
 * Two-gate staleness check for warpline plugin execution.
 *
 * Design decisions:
 *   D-14: TTL-based freshness — if plugin ran within ttl_hours, skip (TTL gate)
 *   D-16: Force flag overrides everything
 *
 * SUPERSEDES Phase 83 D-14 gate 2 (reversed 2026-07-28).
 *
 * D-14 originally read: "if TTL expired but no upstream dependency has re-run
 * since the plugin's last run, ALSO SKIP". That made a newer dependency a
 * PRECONDITION for running rather than an extra trigger, and since 20 of the 25
 * plugins declare `dependencies: []`, `anyDepNewer` was permanently false for
 * them — so TTL became a one-way latch: run once, then never again. `github-poll`
 * declares `ttl_hours: 0.001` with the comment "always polls on every run", which
 * was unreachable. Measured effect: the pipeline ran nothing from 2026-04-14 to
 * 2026-07-28 except two manual `--force` runs; `intel-scan` alone logged 126
 * consecutive "TTL expired but no dependency re-ran" skips.
 *
 * The reversal restores what 83-DISCUSSION-LOG actually described — "TTL as
 * primary gate + dependency invalidation as secondary gate ... adds chain
 * awareness" — by making invalidation additive and checking it FIRST, so it can
 * also fire inside the TTL window. Past TTL now means stale, as ttl_hours implies.
 *
 * (Analysis of the incident that motivated the two gates lives in the source repo.)
 *
 * Security (T-83-09):
 *   plugin_runs timestamps are written by writeStateV2Atomically (Zod-validated);
 *   manual file edits caught by safeParse on next read.
 */
import type { PluginManifest } from '../schemas/plugin-manifest.js'
import type { EngineState } from '../schemas/engine-state.js'

// -------------------------------------------------------------------------
// Types
// -------------------------------------------------------------------------

export interface FreshnessResult {
  /** true = plugin is fresh and should be skipped; false = plugin should run */
  fresh: boolean
  /** Human-readable reason for the decision */
  reason: string
}

// -------------------------------------------------------------------------
// isPluginFresh
// -------------------------------------------------------------------------

/**
 * Determine whether a plugin should be skipped due to freshness.
 *
 * Order (see the D-14 gate-2 reversal in the module docstring):
 *   1. force            → run
 *   2. never run        → run
 *   3. dependency newer → run (fires inside the TTL window too)
 *   4. within ttl_hours → skip
 *   5. otherwise        → run (TTL expired)
 *
 * Returns { fresh: false } when the plugin SHOULD run.
 * Returns { fresh: true }  when the plugin SHOULD be skipped.
 *
 * @param pluginName - Plugin key (matches plugin_runs entry key)
 * @param manifest   - Plugin manifest (provides ttl_hours and dependencies)
 * @param state      - Current v2 state (provides plugin_runs timestamps)
 * @param options.force - Override both gates; always returns { fresh: false, reason: 'forced' }
 */
export function isPluginFresh(
  pluginName: string,
  manifest: PluginManifest,
  state: EngineState,
  options: { force?: boolean } = {},
): FreshnessResult {
  // -- Force override (D-16) --
  if (options.force) {
    return { fresh: false, reason: 'forced' }
  }

  // -- Never-run check --
  const pluginState = state.plugin_runs?.[pluginName]
  if (!pluginState?.last_run_at) {
    return { fresh: false, reason: 'never run' }
  }

  const lastRunMs = new Date(pluginState.last_run_at).getTime()
  const now = Date.now()

  // -- Dependency invalidation (additive, checked first) --
  // A dependency that ran more recently than this plugin invalidates it. This is an
  // EXTRA reason to run and is deliberately checked BEFORE the TTL gate, so a
  // refreshed upstream pulls its downstream through even inside the TTL window.
  // A dependency with no last_run_at (never ran) cannot invalidate the plugin.
  const anyDepNewer = manifest.dependencies.some(dep => {
    const depState = state.plugin_runs?.[dep]
    if (!depState?.last_run_at) return false
    return new Date(depState.last_run_at).getTime() > lastRunMs
  })

  if (anyDepNewer) {
    return { fresh: false, reason: 'dependency re-ran since last run' }
  }

  // -- TTL gate (primary) --
  const ttlMs = manifest.ttl_hours * 60 * 60 * 1000
  if (now - lastRunMs < ttlMs) {
    const minutesAgo = Math.round((now - lastRunMs) / 60_000)
    return {
      fresh: true,
      reason: `within TTL (${manifest.ttl_hours}h) — last run ${minutesAgo}m ago`,
    }
  }

  const hoursAgo = Math.round((now - lastRunMs) / 3_600_000)
  return {
    fresh: false,
    reason: `TTL expired (${manifest.ttl_hours}h) — last run ${hoursAgo}h ago`,
  }
}
