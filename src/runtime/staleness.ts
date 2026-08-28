/**
 * Two-gate staleness check for warpline plugin execution.
 *
 * Two gates decide whether a plugin is due:
 *   1. Dependency invalidation — an upstream plugin re-ran since this one did.
 *   2. TTL expiry — the last successful run is older than `ttl_hours`.
 * `--force` overrides both.
 *
 * READ THIS BEFORE CHANGING THE GATE ORDER. An earlier design ANDed the two:
 * "if TTL expired but no upstream dependency has re-run since the plugin's last
 * run, also skip". That makes a newer dependency a PRECONDITION for running
 * rather than an additional trigger — and a plugin declaring `dependencies: []`
 * can never satisfy it, so `anyDepNewer` is permanently false and TTL becomes a
 * one-way latch: the plugin runs once and then never again. Dependency-free
 * plugins are the common case, and a short `ttl_hours` meant to say "poll every
 * run" is exactly the declaration the latch silences. The failure is silent by
 * construction — every skip is logged as a correct decision — so it survives
 * until someone asks why a scheduled plugin stopped producing output.
 *
 * Hence: invalidation is ADDITIVE and checked FIRST, so it can also fire inside
 * the TTL window; and past TTL means stale, as `ttl_hours` implies on its face.
 *
 * `plugin_runs` timestamps are written by writeStateV2Atomically and so are
 * Zod-validated; a hand-edited state file is caught by safeParse on next read.
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
 * Order (see the gate-ordering note in the module docstring):
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
 * @param options.now - Clock seam, epoch ms. Defaults to the wall clock. A
 *   caller holding an injected clock MUST pass it, or its freshness verdicts
 *   silently disagree with the rest of the view it is building.
 */
export function isPluginFresh(
  pluginName: string,
  manifest: PluginManifest,
  state: EngineState,
  options: { force?: boolean; now?: number } = {},
): FreshnessResult {
  // -- Force override ---------
  if (options.force) {
    return { fresh: false, reason: 'forced' }
  }

  // -- Never-run check --
  const pluginState = state.plugin_runs?.[pluginName]
  if (!pluginState?.last_run_at) {
    return { fresh: false, reason: 'never run' }
  }

  const lastRunMs = new Date(pluginState.last_run_at).getTime()
  const now = options.now ?? Date.now()

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
