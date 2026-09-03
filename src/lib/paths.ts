/**
 * Warpline home + path resolution.
 *
 * There are two roots, not one. State and configuration — engine state, run
 * artifacts, the event log, the session-approval grant, per-plugin config —
 * resolve from the home below. The PLUGIN root is separate: a host may supply
 * its own through `AdvanceOptions.pluginsDir`, and it defaults to
 * `<home>/plugins` only when none is given. The two are independent and are
 * not required to be disjoint.
 *
 * The home resolves as:
 *
 *   1. `WARPLINE_HOME` env var, when set (must exist or be creatable)
 *   2. the nearest ancestor of cwd containing a `.warpline/` directory
 *   3. `<cwd>/.warpline` (created on first write)
 *
 * Paths are exposed as accessor FUNCTIONS, not module-load-time constants.
 * The source system this was extracted from froze paths at import time and
 * needed a bunfig test preload to re-root them before any import ran; tests
 * that forgot the preload silently wrote live operational state. Accessors +
 * the `_setHome()` seam make the re-root ordering-independent.
 */
import { existsSync } from 'node:fs'
import path from 'node:path'

let homeOverride: string | null = null

function resolveHome(): string {
  if (homeOverride) return homeOverride
  const env = process.env.WARPLINE_HOME
  if (env) return path.resolve(env)
  let dir = process.cwd()
  for (;;) {
    const candidate = path.join(dir, '.warpline')
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return path.join(process.cwd(), '.warpline')
}

/** Test seam: override the resolved home. Pass null to restore normal resolution. */
export function _setHome(dir: string | null): void {
  homeOverride = dir ? path.resolve(dir) : null
}

/** The warpline home directory (see resolution order above). */
export function warplineHome(): string {
  return resolveHome()
}

/** Directory holding engine state (events.jsonl, acknowledgements, engine state). */
export function stateDir(): string {
  return path.join(warplineHome(), 'state')
}

/** Directory holding per-run artifacts (<run_id>.json + <run_id>.log). */
export function runsDir(): string {
  return path.join(warplineHome(), 'runs')
}

/**
 * The DEFAULT plugin root (<name>/manifest.ts + handler.ts under it).
 *
 * Not necessarily the root a given advance reads: `AdvanceOptions.pluginsDir`
 * takes precedence when a host supplies one.
 */
export function pluginsDir(): string {
  return path.join(warplineHome(), 'plugins')
}

/** The engine's persisted state document. */
export function engineStatePath(): string {
  return path.join(stateDir(), 'engine-state.json')
}

/** Session approval marker consumed by the approval gate. */
export function sessionApprovalPath(): string {
  return path.join(warplineHome(), '.session-approval')
}

/** Append-only board event log. */
export function eventsJsonlPath(): string {
  return path.join(stateDir(), 'events.jsonl')
}

/** Operator guardrail preferences (quiet hours, send caps, review gate). */
export function preferencesPath(): string {
  return path.join(warplineHome(), 'preferences.json')
}

/**
 * Operator-authored configuration for one plugin.
 *
 * Home-level rather than inside the plugin directory: a plugin directory is
 * shipped material, not user-writable territory, and an operator editing a file
 * there loses it on the next update. One file per plugin rather than one
 * aggregate document, so a single bad edit fails a single plugin instead of
 * every plugin in the same advance.
 *
 * Internal. This is NOT re-exported from `paths-public.ts`.
 */
export function pluginConfigPath(pluginName: string): string {
  return path.join(warplineHome(), 'config', `${pluginName}.json`)
}

/** Engine run lock. */
export function lockPath(): string {
  return path.join(stateDir(), '.lock')
}
