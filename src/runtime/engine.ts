/**
 * Auto-advance engine for warpline.
 *
 * Provides:
 *   topoSort()    — topological sort of plugin dependency graph into execution levels
 *   runAdvance()  — full engine loop: resolve order, check staleness, execute, gate supervised, log
 *
 * Design decisions:
 *   A per-plugin FSM tracks six states plus `skipped`.
 *   Kahn's algorithm for the topological sort, which detects cycles as a
 *   by-product rather than needing a separate pass.
 *   Each level runs in parallel via Promise.all, with try/catch around each
 *   plugin individually — one failing plugin must not cancel its siblings.
 *   Supervised plugins pause the engine outside dry-run and park their payloads
 *   in `pending_gates`.
 */
import { mkdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { checkApproval } from './approval-gate.js'
import {
  sessionApprovalPath,
  preferencesPath as defaultPreferencesPath,
  pluginsDir as pluginsDirDefault,
  engineStatePath,
  runsDir as runsDirDefault,
} from '../lib/paths.js'
import type { PluginManifest } from '../schemas/plugin-manifest.js'
import { invokePlugin } from './invoke-plugin.js'
import { computeTier, isEligibleForTier } from './tier.js'
import type { TierName } from './tier.js'
import { isPluginFresh } from './staleness.js'
import {
  readEngineState,
  writeEngineState,
} from '../schemas/engine-state.js'
import type { EngineState, PendingGate } from '../schemas/engine-state.js'
import { writeRunLog, pruneRunLogs } from '../schemas/run-log.js'
import type { RunLog } from '../schemas/run-log.js'
import type { OutputRecord, SkillResult } from '../schemas/skill-result.js'
import {
  emitBoardEvent,
  makeEvent,
  emitRunStarted,
  emitRunCompleted,
  emitPluginStarted,
  emitPluginCompleted,
  emitPluginFailed,
  emitPluginSkipped,
  emitPluginGated,
  emitGateInvalidated,
  emitPluginDenied,
} from '../board/engine-events.js'
import { readPreferences, isQuietHours } from '../lib/preferences.js'
import { checkTaskLock as smCheckTaskLock } from '../board/state-manager.js'

// -----------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------

export type PluginFsmState = 'pending' | 'running' | 'gated' | 'approved' | 'completed' | 'failed'

/**
 * A plugin directory whose `manifest.ts` could not be imported.
 * `plugin` is the directory name — a broken manifest has no trustworthy `name`
 * field to key off. `error` is the thrown `Error.message`, no stack trace.
 */
export interface LoadFailure {
  plugin: string
  error: string
}

/**
 * Headless run profile.
 * Controls which plugin schedules are eligible to run in non-interactive mode.
 *
 *   'daily'  → runs on_run + daily plugins; skips weekly + manual
 *   'weekly' → runs on_run + daily + weekly plugins; skips manual
 *   'manual' → only plugins with schedule === 'manual' run
 *
 * When `profile` is set, the engine is in headless mode: supervised plugins
 * are marked 'skipped' (not 'gated') because review_gate is a human-in-the-loop
 * concept that does not apply to headless runs (assumption A2).
 */
export type RunProfile = 'daily' | 'weekly' | 'manual'

/**
 * Profile tier → set of schedules that run under that profile.
 *
 * Exported so `warpline plan` can build the same `EvalContext.allowedSchedules`
 * a run builds instead of restating the tier map — a second copy is exactly the
 * one-comparison disagreement between preview and run that this exists to
 * prevent.
 */
export const PROFILE_ALLOWED_SCHEDULES: Record<RunProfile, ReadonlySet<string>> = {
  daily: new Set(['on_run', 'daily']),
  weekly: new Set(['on_run', 'daily', 'weekly']),
  manual: new Set(['manual']),
}

/**
 * Runtime source of truth for the valid `--profile` values, derived from the tier
 * map above rather than restated — a new tier cannot be added to one and
 * forgotten in the other. `src/cli/plan.ts` validates `warpline plan --profile`
 * against this.
 */
export const RUN_PROFILES = Object.keys(PROFILE_ALLOWED_SCHEDULES) as RunProfile[]

export interface AdvanceOptions {
  dryRun?: boolean
  force?: boolean
  /**
   * Headless run profile. When set, the engine filters plugins by
   * schedule tier and treats the run as non-interactive (see RunProfile).
   * When undefined, all plugins are eligible and supervised plugins gate
   * normally — this preserves pre-profile interactive behavior.
   */
  profile?: RunProfile
  /** Override plugins directory (for testing) */
  pluginsDir?: string
  /** Override state file path (for testing — full path to engine-state.json) */
  stateDir?: string
  /** Override runs directory (for testing) */
  runsDir?: string
  /** Override events.jsonl path (for test isolation) */
  eventsPath?: string
  /** Override preferences.json path (for test isolation) */
  preferencesPath?: string
  /** Override session approval file path (for test isolation) */
  approvalPath?: string
  /** Called before each plugin begins execution (for streaming CLI output) */
  onPluginStart?: (plugin: string) => void
  /** Called after each plugin resolves with final FSM state and elapsed_ms (for streaming CLI output) */
  onPluginEnd?: (plugin: string, status: string, elapsed: number, reason?: string) => void
  /**
   * Called exactly once with a human-readable reason when the overall
   * run status is non-complete (i.e. 'partial' or 'interrupted'). Fires after
   * state persistence and run-log write, before runAdvance returns.
   */
  onRunFailure?: (reason: string) => void
}

export interface AdvanceResult {
  run_id: string
  status: 'complete' | 'partial' | 'interrupted'
  plugin_states: Map<string, PluginFsmState | 'skipped'>
  gated_plugins: string[]
  run_log_path: string
}

// -----------------------------------------------------------------------
// evaluatePlugin — the guard chain, without the writes
// -----------------------------------------------------------------------

// -----------------------------------------------------------------------
// Denials — what a "no" is bound to
// -----------------------------------------------------------------------

/** Hex sha256 of a UTF-8 string. Whole, never truncated. */
function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

/**
 * How one Output enters the fingerprint: its semantic `type`, then its path or
 * a hash of its inline body.
 *
 * A path enters by its path; an inline Output enters by a hash of its body,
 * which keeps the fingerprint 64 characters whatever the inline cap allows and
 * keeps the content of an Output out of the denials record entirely. The
 * prefixes stop a path and a body of the same text colliding.
 *
 * **`type` is hashed because R3 names it and because it is a change of
 * proposal.** Without it a plugin that turned the file at `report.md` from a
 * `draft` into a `report` produced a byte-identical fingerprint, so a denial
 * recorded against the draft went on silently suppressing the report — an
 * answer to a question the operator was never asked.
 */
function outputFingerprintKey(output: OutputRecord): string {
  const body =
    output.path !== undefined ? `path:${output.path}` : `body:${sha256(output.body ?? '')}`
  return `${output.type}|${body}`
}

/**
 * The fingerprint a denial binds to: hex sha256 over the plugin's name, its
 * declared side effects and the Outputs it produced.
 *
 * **Both sets are sorted before hashing.** Declaration order in a manifest is
 * an editing accident, not a change of proposal, and without the sort moving
 * one line would re-raise an Ask the operator already answered.
 *
 * **The plugin name is inside the hashed object**, not merely the record key.
 * Two plugins with byte-identical payloads therefore produce different values,
 * so no denial can be made to answer for another plugin's proposal.
 *
 * A plugin with no side effects and no Outputs hashes the empty sets. That is
 * a stable value scoped by its name, not an error: it is denied by name.
 *
 * This is a non-secret integrity fingerprint — not a MAC, not a password hash,
 * not a key derivation. No salt, no HMAC, no constant-time comparison. Key
 * order in the hashed object is fixed by the literal and both arrays are
 * sorted, so no canonical-JSON library is involved.
 */
export function denialFingerprint(
  plugin: string,
  sideEffects: readonly string[],
  outputs: readonly OutputRecord[],
): string {
  return sha256(
    JSON.stringify({
      plugin,
      side_effects: [...sideEffects].sort(),
      outputs: outputs.map(outputFingerprintKey).sort(),
    }),
  )
}

/**
 * The fingerprint of what this plugin is proposing right now.
 *
 * The one entry point: the evaluator recomputes it on every advance and the
 * deny verb records it, so the value written when the operator said no and the
 * value checked on the next advance cannot be produced by two different pieces
 * of arithmetic.
 *
 * The Outputs come from `plugin_runs[plugin].last_output` and deliberately NOT
 * from a parked gate. An unapplied gate is destroyed by the next advance —
 * `pending_gates` is overwritten, and only an APPLIED gate survives, as a
 * marker — so a fingerprint drawing on one would change the day after it was
 * recorded and re-raise an answered question for a reason the operator could
 * not see. `plugin_runs` survives, and it is written on the same branch that
 * parks the gate, so it holds the same run's Output.
 *
 * The narrowing that buys: `last_output` is the LAST Output of the run
 * (`lastOutputOf` takes `.at(-1)`), so a change confined to an earlier Output
 * of a multi-Output result does not re-raise. Durability was worth more than
 * that edge, because the alternative fails in the common case rather than a
 * rare one.
 */
export function proposalFingerprint(
  state: EngineState,
  plugin: string,
  manifest: PluginManifest,
): string {
  const lastOutput = state.plugin_runs[plugin]?.last_output
  return denialFingerprint(
    plugin,
    manifest.side_effects,
    lastOutput === undefined ? [] : [lastOutput],
  )
}

/**
 * Why a plugin is not due. Structured codes, not display copy: the
 * run-log prose these guards used to inline is a run-log concern, and a
 * renderer that switched on prose would break the first time the wording
 * changed.
 */
export type NotDueReason =
  | 'profile_schedule'
  | 'min_tier'
  | 'headless_supervised'
  | 'manual'
  | 'fresh'
  | 'denied'
  | 'task_locked'
  | 'unapproved'

export type EvalResult =
  | { due: true }
  | { due: false; reason: NotDueReason; detail: string }

/** Everything `evaluatePlugin` needs that is not the plugin itself. */
export interface EvalContext {
  /** Schedules allowed by the headless profile tier; undefined = unfiltered. */
  allowedSchedules?: ReadonlySet<string>
  /** The requested profile, for the profile-filter detail string. */
  profile?: RunProfile
  currentTier: TierName
  headless: boolean
  force: boolean
  state: EngineState
  /** Already-resolved session approval path — the evaluator does no path defaulting. */
  approvalPath: string
}

/**
 * Decide whether a plugin is due, with no writes of any kind.
 *
 * This is the guard chain lifted out of `runAdvance`'s per-plugin body. Every
 * FSM mutation, run-log entry, skip event and progress callback stayed behind
 * in `runAdvance`, keyed off the returned reason — that separation is what
 * makes `warpline plan` read-only by construction rather than by audit, and it
 * is why `plan` cannot disagree with a run by one comparison operator.
 *
 * Deliberately NOT here: the dry-run side-effect block. The evaluator
 * models a *real* run; `runAdvance` applies the dry-run block on its own side,
 * in the same position in the chain it always occupied.
 *
 * `now` is injected, never read: `plan` captures one timestamp and
 * threads it through the evaluator and the renderer so two consecutive
 * previews are byte-identical.
 *
 * `now` reaches every clock read this function makes, not just its own: it is
 * threaded into `isPluginFresh` (`staleness.ts`) and `checkApproval`
 * (`approval-gate.ts`), which grew a `now` option for exactly this. That is
 * what makes the promise above literally true rather than nearly true. Pass a
 * past `now` and the freshness verdicts, the approval rows and the header all
 * move together; before the seam existed they did not, and the render
 * disagreed with itself.
 */
export async function evaluatePlugin(
  pluginName: string,
  manifest: PluginManifest,
  ctx: EvalContext,
  now: number,
): Promise<EvalResult> {
  // -- Profile tier filter ---------------
  if (ctx.allowedSchedules && !ctx.allowedSchedules.has(manifest.schedule)) {
    return {
      due: false,
      reason: 'profile_schedule',
      detail: `profile '${ctx.profile}' filter: schedule '${manifest.schedule}' not in tier`,
    }
  }

  // -- Tier filter: coarser gate than staleness ---------------
  if (!isEligibleForTier(manifest.min_tier ?? 'normal', ctx.currentTier)) {
    return {
      due: false,
      reason: 'min_tier',
      detail: `tier filter: current '${ctx.currentTier}' exceeds plugin min_tier '${manifest.min_tier ?? 'normal'}'`,
    }
  }

  // -- Headless supervised bypass (A2) --
  if (ctx.headless && manifest.autonomy_level === 'supervised') {
    return {
      due: false,
      reason: 'headless_supervised',
      detail: 'headless mode: supervised plugin bypassed (no interactive gate)',
    }
  }

  // -- Manual: always skip --
  if (manifest.autonomy_level === 'manual') {
    return { due: false, reason: 'manual', detail: 'manual — requires explicit invocation' }
  }

  // -- Staleness check: skip if fresh --
  const freshness = isPluginFresh(pluginName, manifest, ctx.state, { force: ctx.force, now })
  if (freshness.fresh) {
    return { due: false, reason: 'fresh', detail: freshness.reason ?? 'fresh' }
  }

  // -- Task lock check: active task for this plugin on the board --
  if (await smCheckTaskLock(pluginName)) {
    return { due: false, reason: 'task_locked', detail: 'task locked — active on board' }
  }

  // -- Denial: a human already said no to this exact proposal --------
  // Ordered after the task lock and BEFORE the approval gate. A denied plugin
  // is not asked about at all, so it must not first be reported as needing a
  // Grant it does not need.
  //
  // The denial holds only while the fingerprint still matches. When it moves,
  // the answer is stale and the plugin is asked again — but the question is a
  // returning one, and `supersededNote` below makes the difference visible
  // rather than letting it reappear looking new.
  //
  // An own-property lookup: `denials` is a plain object, so `denials[name]`
  // answers with an inherited member for any name off `Object.prototype`. The
  // manifest schema refuses such a name, and this holds whether or not it does.
  const denial = Object.hasOwn(ctx.state.denials, pluginName)
    ? ctx.state.denials[pluginName]
    : undefined
  const currentProposal =
    denial === undefined ? undefined : proposalFingerprint(ctx.state, pluginName, manifest)
  if (denial !== undefined && denial.fingerprint === currentProposal) {
    return {
      due: false,
      reason: 'denied',
      detail: `denied ${denial.denied_at}: ${denial.reason}`,
    }
  }

  /**
   * Prefix for whatever the operator sees next when a denial has been
   * superseded. A returning Ask that says nothing looks like a first-time one,
   * and the operator has no way to tell they already answered it.
   *
   * It keeps saying so until the denial is taken back. That is deliberate: the
   * record is still there, still answering a proposal that no longer exists,
   * and the operator is the only one who can retire it.
   */
  const supersededNote =
    denial === undefined
      ? ''
      : `previously denied ${denial.denied_at} ('${denial.reason}') — the proposal has ` +
        'changed since, so this is a returning question, not a new one. '

  // -- Side-effect approval gate ---------------------------------
  if (
    manifest.side_effects.length > 0 &&
    !(await checkApproval(pluginName, ctx.approvalPath, { now }))
  ) {
    return {
      due: false,
      reason: 'unapproved',
      detail: `${supersededNote}skipped (unapproved): side effects require session approval`,
    }
  }

  return { due: true }
}

// (Extraction note: the source engine attached a domain metrics_summary to
// each run. Cut from core — hosts that want run telemetry derive it from the
// run log's plugin_entries.)

// -----------------------------------------------------------------------
// topoSort — Kahn's algorithm
// -----------------------------------------------------------------------

/**
 * Topological sort of plugin manifests into execution levels.
 *
 * @param plugins - Map of plugin name → PluginManifest
 * @returns Array of levels; each level is an array of plugin names that can run concurrently.
 * @throws Error if a dependency cycle is detected.
 */
export function topoSort(plugins: Map<string, PluginManifest>): string[][] {
  if (plugins.size === 0) return []

  // Build adjacency and in-degree map
  // Only consider dependencies that are in the plugin map (ignore external deps)
  const inDegree = new Map<string, number>()
  const dependents = new Map<string, string[]>() // dep → [plugins that depend on it]

  for (const [name] of plugins) {
    inDegree.set(name, 0)
    dependents.set(name, [])
  }

  for (const [name, manifest] of plugins) {
    for (const dep of manifest.dependencies) {
      if (!plugins.has(dep)) continue // external dep, ignore
      inDegree.set(name, (inDegree.get(name) ?? 0) + 1)
      dependents.get(dep)!.push(name)
    }
  }

  const levels: string[][] = []
  let frontier = Array.from(inDegree.entries())
    .filter(([, deg]) => deg === 0)
    .map(([name]) => name)

  while (frontier.length > 0) {
    levels.push([...frontier])
    const nextFrontier: string[] = []
    for (const name of frontier) {
      for (const dependent of dependents.get(name) ?? []) {
        const newDeg = (inDegree.get(dependent) ?? 0) - 1
        inDegree.set(dependent, newDeg)
        if (newDeg === 0) {
          nextFrontier.push(dependent)
        }
      }
    }
    frontier = nextFrontier
  }

  // Cycle detection: any node still with in-degree > 0 is in a cycle
  const cycled = Array.from(inDegree.entries())
    .filter(([, deg]) => deg > 0)
    .map(([name]) => name)

  if (cycled.length > 0) {
    throw new Error(`Dependency cycle detected: ${cycled.join(', ')}`)
  }

  return levels
}

// -----------------------------------------------------------------------
// runAdvance — engine loop
// -----------------------------------------------------------------------

/**
 * Execute all plugins in dependency order, tracking per-plugin FSM state.
 *
 * Autonomy gating:
 *   manual     → always skipped (reason: "manual — requires explicit invocation")
 *   supervised → gated after execution (pending human approval), unless dryRun
 *   autonomous → executed and completed/failed based on result
 *
 * Staleness:
 *   If isPluginFresh() returns true and !force, plugin is skipped.
 *
 * Level parallelism:
 *   All plugins within a level execute concurrently via Promise.all.
 *   Failures in one plugin do not block others in the same level.
 *
 * Gate behavior:
 *   After a level, if any plugin is 'gated' and !dryRun, engine stops (no further levels).
 */
export async function runAdvance(options: AdvanceOptions = {}): Promise<AdvanceResult> {
  const {
    dryRun = false,
    force = false,
    profile,
    pluginsDir = getDefaultPluginsDir(),
    stateDir = getDefaultStatePath(),
    runsDir = getDefaultRunsDir(),
    eventsPath,
    preferencesPath,
    approvalPath,
    onPluginStart,
    onPluginEnd,
    onRunFailure,
  } = options

  // Headless mode is defined as "a profile was explicitly requested" (A2).
  // In headless mode, supervised plugins are skipped rather than gated, and
  // plugin schedules are filtered by the profile tier.
  const headless = profile !== undefined
  const allowedSchedules = profile ? PROFILE_ALLOWED_SCHEDULES[profile] : undefined

  // 1. Generate run_id
  const run_id = `${new Date().toISOString().replace(/[:.]/g, '')}-${randomUUID().slice(0, 8)}`
  const started_at = new Date().toISOString()

  // 2. Read v2 state
  // `eventsPath` is threaded so a stub-gate discard notice lands in this run's
  // event log rather than escaping to the default one.
  const state = await readEngineState(stateDir, { eventsPath })

  // 2a. Compute degradation tier — from PREVIOUS last_interaction_at (before we update it)
  const previousLastInteraction = state.last_interaction_at
  const currentTier: TierName = computeTier(previousLastInteraction)

  // 2b. Update last_interaction_at — persisted in final writeEngineState
  state.last_interaction_at = new Date().toISOString()

  // 2c. Tier transition BoardEvent — emit when tier is not normal
  if (currentTier !== 'normal') {
    const previousMs = previousLastInteraction
      ? new Date(previousLastInteraction).getTime()
      : Date.now()
    const idleDays = Math.round((Date.now() - previousMs) / 86_400_000)
    const tierTransitionSummary = `Entered ${currentTier} mode (${idleDays}d absent)`
    // Deliberately null, not `run_id`. The tier transition is a property of
    // how long the operator has been away — it is observed at the top of an
    // advance but is not something this advance did, and attributing it to a
    // run would make "which run raised this" answer a question it did not ask.
    await emitBoardEvent(
      makeEvent('notice', 'engine:tier-transition', tierTransitionSummary, null),
      eventsPath,
    )
  }

  // 2d. Read preferences — derive from the state file's directory when a
  // custom stateDir was given (test isolation / relocated homes), else the
  // warpline home default. The source system's comment promised this
  // derivation but never implemented it, so its engine tests silently read
  // the LIVE preferences file.
  const resolvedPrefsPath =
    preferencesPath ??
    (options.stateDir ? join(dirname(options.stateDir), 'preferences.json') : defaultPreferencesPath())
  const prefs = await readPreferences(resolvedPrefsPath)

  // Guardrail: quiet hours — skip run if active (unless dryRun or force)
  if (isQuietHours(prefs) && !dryRun && !force) {
    console.log('[engine] Quiet hours active — skipping run')
    await emitRunCompleted(run_id, 'complete', eventsPath)
    return {
      run_id,
      status: 'complete',
      plugin_states: new Map(),
      gated_plugins: [],
      run_log_path: '',
    }
  }

  // Guardrail: review_gate — if enabled, treat all autonomous plugins as supervised
  const reviewGateActive = prefs.review_gate

  // 3. Prune old run logs
  await pruneRunLogs(runsDir)

  // 3b. Emit run_started event
  await emitRunStarted(run_id, eventsPath)

  // 4. Load all plugin manifests from pluginsDir. The loader also returns
  // per-plugin `failures`; a run does not surface them yet, so only
  // `manifests` is taken here and run behaviour is unchanged.
  const { manifests: plugins } = await loadPluginManifests(pluginsDir)

  // 5. Topological sort
  const levels = topoSort(plugins)

  // 6. Per-plugin FSM state
  const plugin_states = new Map<string, PluginFsmState | 'skipped'>()
  for (const [name] of plugins) {
    plugin_states.set(name, 'pending')
  }

  const gated_plugins: string[] = []
  /**
   * The gates parked by this advance, assembled inside the gated arm where the
   * plugin's real `SkillResult` is still in scope.
   */
  const parked_gates: PendingGate[] = []
  const plugin_entries: RunLog['plugin_entries'] = []

  let engineStatus: AdvanceResult['status'] = 'complete'
  let stopped = false

  // 6b. Evaluation context shared by every plugin in this run. The
  // approval path is resolved once here so the evaluator does no defaulting.
  const evalCtx: EvalContext = {
    allowedSchedules,
    profile,
    currentTier,
    headless,
    force,
    state,
    approvalPath: approvalPath ?? sessionApprovalPath(),
  }

  // 7. Execute each level
  for (const level of levels) {
    if (stopped) break

    // Execute all plugins in this level concurrently
    await Promise.all(
      level.map(async (pluginName) => {
        const manifest = plugins.get(pluginName)!
        const entryStartedAt = new Date().toISOString()
        const entryStart = Date.now()

        // -- Due-ness evaluation ---------
        // Every guard predicate now lives in evaluatePlugin; every write below
        // stays on this side of the seam, keyed off the returned reason.
        // `entryStart` is the single clock read threaded in as `now`.
        const ev = await evaluatePlugin(pluginName, manifest, evalCtx, entryStart)

        // -- Dry-run side-effect block -----------------------
        // Run-only, so it is deliberately outside the evaluator. In
        // the original chain it sat between the task-lock guard and the
        // approval guard, so it applies exactly to the outcomes reached after
        // those guards passed: due, or not-due-because-unapproved.
        if (dryRun && manifest.side_effects.length > 0 && (ev.due || ev.reason === 'unapproved')) {
          plugin_states.set(pluginName, 'skipped')
          const dryBlockElapsed = Date.now() - entryStart
          plugin_entries.push({
            plugin: pluginName,
            status: 'skipped',
            started_at: entryStartedAt,
            elapsed_ms: dryBlockElapsed,
            result_summary: `blocked (dry-run): declares side effects [${manifest.side_effects.join(', ')}]`,
            retried: false,
          })
          await emitPluginSkipped(pluginName, `blocked (dry-run): declares side effects [${manifest.side_effects.join(', ')}]`, run_id, eventsPath)
          onPluginEnd?.(pluginName, 'skipped', dryBlockElapsed, 'blocked (dry-run)')
          return
        }

        // -- Not-due: record the skip the evaluator decided on --
        // One arm per reason code. The arms differ only in their run-log prose,
        // which is a run-log concern and stays here rather than travelling in
        // the evaluator's structured reason.
        if (!ev.due) {
          plugin_states.set(pluginName, 'skipped')

          // -- Profile tier filter ---------------
          if (ev.reason === 'profile_schedule') {
            plugin_entries.push({
              plugin: pluginName,
              status: 'skipped',
              started_at: entryStartedAt,
              elapsed_ms: Date.now() - entryStart,
              result_summary: ev.detail,
              retried: false,
            })
            await emitPluginSkipped(pluginName, ev.detail, run_id, eventsPath)
            return
          }

          // -- Tier filter: coarser gate than staleness ---------------
          if (ev.reason === 'min_tier') {
            plugin_entries.push({
              plugin: pluginName,
              status: 'skipped',
              started_at: entryStartedAt,
              elapsed_ms: Date.now() - entryStart,
              result_summary: ev.detail,
              retried: false,
            })
            await emitPluginSkipped(pluginName, ev.detail, run_id, eventsPath)
            return
          }

          // -- Headless supervised bypass (A2) --
          if (ev.reason === 'headless_supervised') {
            plugin_entries.push({
              plugin: pluginName,
              status: 'skipped',
              started_at: entryStartedAt,
              elapsed_ms: Date.now() - entryStart,
              result_summary: ev.detail,
              retried: false,
            })
            await emitPluginSkipped(pluginName, ev.detail, run_id, eventsPath)
            return
          }

          // -- Manual: always skip --
          if (ev.reason === 'manual') {
            plugin_entries.push({
              plugin: pluginName,
              status: 'skipped',
              started_at: entryStartedAt,
              elapsed_ms: Date.now() - entryStart,
              result_summary: ev.detail,
              retried: false,
            })
            await emitPluginSkipped(pluginName, ev.detail, run_id, eventsPath)
            return
          }

          // -- Fresh within TTL: the run log prefixes the freshness prose --
          if (ev.reason === 'fresh') {
            plugin_entries.push({
              plugin: pluginName,
              status: 'skipped',
              started_at: entryStartedAt,
              elapsed_ms: Date.now() - entryStart,
              result_summary: `skipped: ${ev.detail}`,
              retried: false,
            })
            await emitPluginSkipped(pluginName, ev.detail, run_id, eventsPath)
            return
          }

          // -- Task locked: active task for this plugin on the board --
          if (ev.reason === 'task_locked') {
            plugin_entries.push({
              plugin: pluginName,
              status: 'skipped',
              started_at: entryStartedAt,
              elapsed_ms: Date.now() - entryStart,
              result_summary: ev.detail,
              retried: false,
            })
            await emitPluginSkipped(pluginName, ev.detail, run_id, eventsPath)
            return
          }

          // -- Denied: a human answered, and the answer still applies --
          // The only arm here that does not write `status: 'skipped'`. A
          // denial is an outcome of supervision, like `gated`, and filing it
          // as a skip would put it in the same bucket as "no Grant" and
          // "still fresh" — the log could then no longer tell an unanswered
          // question from an answered one. The BOARD event carries the same
          // distinction, via `emitPluginDenied`: making that argument about the
          // run log and then emitting `plugin: skipped — denied …` next door
          // left the two logs disagreeing about the same advance.
          //
          // No `plugin_runs` write: the plugin did not run. `runAdvance` has
          // exactly two write sites for that record — the gated arm and the
          // autonomous arm below — and this is not a third. (`applyPendingGate`
          // holds the only other one, plus the delete in its discard closure;
          // both are outside this function and answer a parked gate rather than
          // an advance.)
          if (ev.reason === 'denied') {
            plugin_entries.push({
              plugin: pluginName,
              status: 'denied',
              started_at: entryStartedAt,
              elapsed_ms: Date.now() - entryStart,
              result_summary: ev.detail,
              retried: false,
            })
            await emitPluginDenied(pluginName, ev.detail, run_id, eventsPath)
            return
          }

          // -- Side-effect approval gate ---------------------------------
          // The run log names the specific effects; the board event does not.
          const unapprovedElapsed = Date.now() - entryStart
          plugin_entries.push({
            plugin: pluginName,
            status: 'skipped',
            started_at: entryStartedAt,
            elapsed_ms: unapprovedElapsed,
            result_summary: `skipped (unapproved): side effects [${manifest.side_effects.join(', ')}] require session approval`,
            retried: false,
          })
          await emitPluginSkipped(pluginName, ev.detail, run_id, eventsPath)
          onPluginEnd?.(pluginName, 'skipped', unapprovedElapsed, 'unapproved side effects')
          return
        }

        // -- Set FSM to running --
        plugin_states.set(pluginName, 'running')
        onPluginStart?.(pluginName)
        await emitPluginStarted(pluginName, run_id, eventsPath)

        // -- Invoke plugin --
        let invocationResult: Awaited<ReturnType<typeof invokePlugin>>
        try {
          // `runId` is threaded so the Outputs this handler returns are stamped
          // with the advance that produced them, not with a per-invocation id
          // nothing else knows. `persistArtifact` stays off deliberately — see
          // the rationale in invoke-plugin.ts; an advance writes a RunLog, not
          // a RunArtifact.
          invocationResult = await invokePlugin(pluginName, {}, { pluginsDir, runId: run_id })
        } catch (err) {
          plugin_states.set(pluginName, 'failed')
          const errMsg = err instanceof Error ? err.message : String(err)
          const failedElapsed = Date.now() - entryStart
          plugin_entries.push({
            plugin: pluginName,
            status: 'failed',
            started_at: entryStartedAt,
            elapsed_ms: failedElapsed,
            result_summary: `invocation threw: ${errMsg}`,
            retried: false,
          })
          await emitPluginFailed(pluginName, errMsg, run_id, eventsPath)
          onPluginEnd?.(pluginName, 'failed', failedElapsed, errMsg)
          return
        }

        const { result, retried } = invocationResult

        // -- Supervised: gate (unless dry-run) --
        // review_gate forces autonomous plugins to be treated as supervised
        const effectiveAutonomy =
          reviewGateActive && manifest.autonomy_level === 'autonomous'
            ? 'supervised'
            : manifest.autonomy_level
        if (effectiveAutonomy === 'supervised') {
          if (dryRun) {
            // Dry-run: log "would pause here" and continue
            console.log(`[engine] would pause here for supervised plugin: ${pluginName}`)
            plugin_states.set(pluginName, 'completed')
            const dryRunElapsed = Date.now() - entryStart
            plugin_entries.push({
              plugin: pluginName,
              status: 'completed',
              started_at: entryStartedAt,
              elapsed_ms: dryRunElapsed,
              result_summary: `[dry-run] would pause here: ${result.summary}`,
              reversible: result.reversible,
              undo_instruction: result.undo_instruction,
              retried,
            })
            await emitPluginCompleted(pluginName, `[dry-run] would pause here: ${result.summary}`, run_id, eventsPath)
            onPluginEnd?.(pluginName, 'completed', dryRunElapsed, '[dry-run] would pause here')
          } else {
            plugin_states.set(pluginName, 'gated')
            gated_plugins.push(pluginName)
            const gatedElapsed = Date.now() - entryStart
            plugin_entries.push({
              plugin: pluginName,
              status: 'gated',
              started_at: entryStartedAt,
              elapsed_ms: gatedElapsed,
              result_summary: result.summary,
              reversible: result.reversible,
              undo_instruction: result.undo_instruction,
              retried,
            })
            await emitPluginGated(pluginName, run_id, eventsPath)
            onPluginEnd?.(pluginName, 'gated', gatedElapsed)

            // -- Record the gated run in state --
            // Inside this arm, not before the shared `return` below: the
            // dry-run arm above must stay write-free.
            //
            // This is what stops the side effects re-firing. They already went
            // out — the handler was invoked well above, and the gate only
            // decides what happens to the RESULT — so without a run record the
            // plugin was due again on the next advance, and did it all again,
            // every advance, for the whole grant window, on one human "yes".
            //
            // Anchored at the gate's completion time, which is when the run
            // ended. A later approval is a separate event and must not
            // retroactively move when the work happened.
            //
            // ONE string, used twice. The parked gate below records the same
            // instant, and the approve verb anchors `plugin_runs.last_run_at`
            // at the gate's copy when it applies — so two `new Date()` calls
            // here would let the two disagree by a millisecond and make that
            // anchoring a lie.
            const completedAt = new Date().toISOString()
            state.plugin_runs[pluginName] = {
              last_run_at: completedAt,
              status: 'gated',
              duration_ms: Date.now() - entryStart,
              // last_output: written here as well as on the autonomous path. A
              // gated run produced its Outputs before the gate saw them.
              ...lastOutputOf(result),
            }

            // -- Park the REAL result ------------------------------------
            // Built here, where `result` is in scope, rather than
            // reconstructed from `plugin_entries` after the level loop. The
            // reconstruction is what fabricated a partial with an empty
            // artifacts array: by then the only thing left of the run was its
            // summary string, so a summary string is all the gate could hold.
            parked_gates.push({
              plugin: pluginName,
              run_id,
              created_at: completedAt,
              payload_summary: result.summary,
              plugin_result: result,
              run_started_at: entryStartedAt,
              run_completed_at: completedAt,
              applied_at: null,
            })
          }
          return
        }

        // -- Autonomous: completed or failed --
        const finalStatus = result.status === 'failed' ? 'failed' : 'completed'
        plugin_states.set(pluginName, finalStatus)
        const autonomousElapsed = Date.now() - entryStart
        plugin_entries.push({
          plugin: pluginName,
          status: finalStatus,
          started_at: entryStartedAt,
          elapsed_ms: autonomousElapsed,
          result_summary: result.summary,
          reversible: result.reversible,
          undo_instruction: result.undo_instruction,
          retried,
        })
        if (finalStatus === 'failed') {
          await emitPluginFailed(pluginName, result.summary, run_id, eventsPath)
        } else {
          await emitPluginCompleted(pluginName, result.summary, run_id, eventsPath)
        }
        onPluginEnd?.(pluginName, finalStatus, autonomousElapsed)

        // -- Update plugin_runs in state --
        state.plugin_runs[pluginName] = {
          last_run_at: new Date().toISOString(),
          status: result.status === 'failed' ? 'failed' : result.status === 'partial' ? 'partial' : 'success',
          duration_ms: Date.now() - entryStart,
          // last_output: absent, not null, when this run produced no Output.
          ...lastOutputOf(result),
        }
      }),
    )

    // After level: if any plugin is gated and not dry-run, stop
    const levelHasGates = level.some(name => plugin_states.get(name) === 'gated')
    if (levelHasGates && !dryRun) {
      stopped = true
      engineStatus = 'partial'
    }
  }

  // Determine overall status
  const allStates = Array.from(plugin_states.values())
  const hasFailed = allStates.some(s => s === 'failed')
  if (engineStatus === 'complete' && hasFailed) {
    engineStatus = 'partial'
  }

  // -- Tier-based task mutations ---------------
  if (currentTier === 'suspended') {
    // Soft-archive info-severity tasks that aren't already archived
    for (const task of state.task_aging) {
      if (task.severity === 'info' && !task.archived_at) {
        task.archived_at = new Date().toISOString()
      }
    }
  } else if (currentTier === 'degraded' || currentTier === 'extended') {
    // Auto-defer info-severity tasks: critical + warning stay active
    const now = new Date().toISOString()
    const existingDeferralIds = new Set(state.deferrals.map(d => d.task_id))
    for (const task of state.task_aging) {
      if (task.severity === 'info' && !existingDeferralIds.has(task.task_id) && !task.archived_at) {
        state.deferrals.push({
          task_id: task.task_id,
          reason: `Auto-deferred: ${currentTier} tier`,
          deferred_at: now,
          expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        })
      }
    }
  }

  // 8. Write updated state (with pending_gates)
  const updatedState: EngineState & { pending_gates?: unknown[] } = {
    ...state,
    last_run_id: run_id,
    last_run_at: new Date().toISOString(),
  }

  // Add pending_gates to state for gated plugins. Assembled in the gated arm
  // above, where the plugin's real result is still in hand.
  //
  // **An APPLIED gate survives the advance.** `applyPendingGate` marks rather
  // than deletes precisely so a second `approve` finds the gate and refuses
  // instead of falling through to the Grant path — and assigning `parked_gates`
  // over the whole array destroyed that marker on the next advance, so the
  // sequence apply, advance, approve minted a session Grant. That is the
  // wrong-gesture outcome mark-not-delete was chosen to prevent, reintroduced
  // one advance later.
  //
  // They are dropped once older than the gate ceiling, so the array does not
  // grow without bound, and a plugin that has gated again supersedes its own
  // marker: the new parked gate is the live answer and the old marker has
  // nothing left to refuse.
  //
  // UNAPPLIED gates are still overwritten wholesale. That limitation is the
  // phase's recorded deferred item and is deliberately not what this changes —
  // `proposalFingerprint` reads `plugin_runs` rather than a gate BECAUSE an
  // unapplied gate does not outlive the next advance.
  const gateFloorMs = Date.now() - GATE_MAX_AGE_MS
  const appliedSurvivors = state.pending_gates.filter(
    (g) =>
      g.applied_at !== null &&
      new Date(g.applied_at).getTime() > gateFloorMs &&
      !parked_gates.some((p) => p.plugin === g.plugin),
  )
  ;(updatedState as Record<string, unknown>)['pending_gates'] = [
    ...appliedSurvivors,
    ...parked_gates,
  ]

  await writeEngineState(updatedState as EngineState, stateDir)

  // 9. Write run log
  const completed_at = new Date().toISOString()
  const runLog: RunLog = {
    run_id,
    started_at,
    completed_at,
    status: engineStatus === 'complete' ? 'complete' : engineStatus === 'partial' ? 'partial' : 'interrupted',
    modes_run: [],
    resumed_from: null,
    summary: `Engine run ${run_id}: ${plugin_entries.length} plugins processed`,
    tasks_surfaced: [],
    tasks_resolved: [],
    deferrals_active: 0,
    verification_results: [],
    plugin_entries,
  }

  await mkdir(runsDir, { recursive: true })
  const run_log_path = await writeRunLog(runLog, runsDir)

  // 10. Emit run_completed event
  await emitRunCompleted(run_id, engineStatus, eventsPath)

  // 11. Fire onRunFailure exactly once if the run did not complete
  // cleanly. 'partial' covers any failed/gated plugin; 'interrupted' covers
  // non-terminating stops. Success path does not invoke the hook.
  if (onRunFailure && engineStatus !== 'complete') {
    const failedPlugins = Array.from(plugin_states.entries())
      .filter(([, s]) => s === 'failed')
      .map(([name]) => name)
    const reason =
      failedPlugins.length > 0
        ? `run ${engineStatus}: ${failedPlugins.length} plugin(s) failed [${failedPlugins.join(', ')}]`
        : `run ${engineStatus}: engine did not complete cleanly`
    try {
      onRunFailure(reason)
    } catch (hookErr) {
      const msg = hookErr instanceof Error ? hookErr.message : String(hookErr)
      console.error(`[engine] onRunFailure hook threw: ${msg}`)
    }
  }

  return {
    run_id,
    status: engineStatus,
    plugin_states,
    gated_plugins,
    run_log_path,
  }
}

// -----------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------

/**
 * Turn one load failure into something a reader can act on.
 *
 * `Cannot use import statement outside a module` is Node saying the manifest
 * was loaded as CommonJS. For a warpline plugin that has exactly one cause: no
 * `package.json` marking the home as ESM. Warpline 0.1.0 shipped without
 * writing one, so any home scaffolded by that version still fails this way
 * after upgrading — `scaffold` heals the home, but a user who only runs `plan`
 * never triggers it and sees a message that names neither the cause nor the
 * cure.
 *
 * Diagnosis only. `plan` writes nothing under the home by design, and healing
 * from here would break that guarantee to fix an error message. The point is
 * to say what to do, not to do it.
 *
 * Exported for tests because the condition it detects CANNOT be reproduced
 * under Bun: Bun loads .ts as ESM unconditionally, so a real import here never
 * yields the CommonJS message. That is the same blind spot that let 0.1.0 ship
 * broken, so the unit is tested against the message and the end-to-end path is
 * proven under real Node in scripts/verify-tarball.sh.
 */
export function explainLoadFailure(message: string, pluginsDir: string): string {
  if (!message.includes('Cannot use import statement outside a module')) return message

  const home = dirname(pluginsDir)
  const marker = join(home, 'package.json')
  let declaresEsm = false
  try {
    declaresEsm = JSON.parse(readFileSync(marker, 'utf8')).type === 'module'
  } catch {
    declaresEsm = false // absent, unreadable, or not JSON — all mean "not marked"
  }
  if (declaresEsm) return message

  // Name the exact file and give a command that works, because the bare Node
  // message does neither. `warpline scaffold` prepares the home before it
  // looks at the plugin name, so it heals whether or not that plugin exists.
  return (
    `${message}\n` +
    `      Cause: no "type": "module" in ${marker}, so Node loads the\n` +
    `      plugin as CommonJS. Homes created by warpline 0.1.0 lack this file.\n` +
    `      Fix:   run \`warpline scaffold <any-name>\`, which writes it,\n` +
    `             or: echo '{"type":"module"}' > ${marker}`
  )
}

/**
 * `loadPluginManifests` reports what it could not load instead of
 * discarding it. A broken plugin used to vanish inside a bare `catch {}`,
 * which made an incomplete due-set indistinguishable from a complete one.
 */
export async function loadPluginManifests(pluginsDir: string): Promise<{
  manifests: Map<string, PluginManifest>
  failures: LoadFailure[]
}> {
  const { readdir } = await import('node:fs/promises')
  const plugins = new Map<string, PluginManifest>()
  const failures: LoadFailure[] = []

  let entries: string[]
  try {
    entries = await readdir(pluginsDir)
  } catch {
    return { manifests: plugins, failures } // empty if dir doesn't exist
  }

  await Promise.all(
    entries.map(async (entry) => {
      // The DIRECTORY name is the record key, so it is the string that has to
      // be safe. Every downstream key comes out of this map: `runAdvance`
      // iterates it and writes `state.plugin_runs[name]`, `deny` validates
      // positionals against it and writes `state.denials[plugin]`. A
      // `__proto__` directory would invoke the prototype setter and drop the
      // write silently — no `plugin_runs` record after a gated run, which is
      // the re-firing defect the record exists to close, and a `Denied
      // __proto__` line over a state file that gained nothing.
      //
      // `PluginManifestSchema.name` carries the same refusal, deliberately
      // independently: the two strings are not the same string, `manifest.name`
      // is decorative here (a warning string and a dependency fallback set),
      // and a future keying change should meet a guard wherever it lands.
      // Derived from the prototype rather than listed, so it cannot go stale.
      if (entry in Object.prototype) {
        failures.push({
          plugin: entry,
          error:
            `directory name '${entry}' is a member of Object.prototype and cannot be a record ` +
            `key — rename the directory`,
        })
        return
      }
      const manifestPath = join(pluginsDir, entry, 'manifest.ts')
      try {
        // import() needs a file:// URL, not a bare absolute path.
        const mod = await import(pathToFileURL(manifestPath).href)
        if (mod.manifest) {
          plugins.set(entry, mod.manifest as PluginManifest)
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        failures.push({ plugin: entry, error: explainLoadFailure(message, pluginsDir) })
      }
    }),
  )

  // Sorted INSIDE the loader so alphabetical ordering is a property of the data
  // rather than of one renderer — a second surface cannot get it wrong. Plain
  // codepoint comparison, not localeCompare: locale-dependent ordering would
  // leak into the byte-identity guarantee `warpline plan` has to make.
  failures.sort((a, b) => (a.plugin < b.plugin ? -1 : a.plugin > b.plugin ? 1 : 0))

  // Warn on unresolved dependencies — topoSort silently ignores them today.
  // Loaded keys are directory names (what `entries` returned). Manifests also declare their own
  // `name` field; in practice directory and manifest name match, but match against both sets so the
  // warning only fires on genuinely dangling references.
  const loadedKeys = new Set<string>(plugins.keys())
  const loadedNames = new Set<string>(
    Array.from(plugins.values()).map((m) => m.name),
  )
  for (const [key, m] of plugins.entries()) {
    for (const dep of m.dependencies ?? []) {
      if (!loadedKeys.has(dep) && !loadedNames.has(dep)) {
        console.warn(
          `  [engine] plugin '${m.name ?? key}' declares unresolved dependency '${dep}' — ordering is not enforced`,
        )
      }
    }
  }

  return { manifests: plugins, failures }
}

/**
 * Absolute ceiling on how long a parked gate may be applied after its run
 * finished. The effective ceiling is the EARLIER of this and the plugin's own
 * `ttl_hours`: a plugin that considers its work stale after an hour cannot have
 * a day-old result accepted on its behalf.
 *
 * A separate object from `MAX_GRANT_WINDOW_MS`, deliberately, even though both
 * read 24 hours. That one bounds how long side-effect AUTHORITY lives; this one
 * bounds how long an OBSERVED OUTCOME stays acceptable. Sharing the constant
 * would tie two clocks that answer different questions, and the first time one
 * needs to move the other would move with it silently.
 */
export const GATE_MAX_AGE_MS = 24 * 60 * 60 * 1000

/** What {@link applyPendingGate} did, so the caller can print it and pick a code. */
export type GateApplyOutcome =
  | {
      outcome: 'applied'
      /** The FSM state the plugin reached. This is what finally makes `approved` reachable. */
      fsm_state: Extract<PluginFsmState, 'approved'>
      run_id: string
      run_completed_at: string
      summary: string
    }
  | { outcome: 'already_applied'; applied_at: string }
  | { outcome: 'refused'; reason: 'dependency_moved' | 'expired'; detail: string }

/**
 * The most recent parked gate for a plugin, applied or not.
 *
 * An ALREADY-APPLIED gate is returned on purpose: callers need to SEE a spent
 * marker, not be shielded from it. `approve` names it in the note it prints
 * before merging a Grant, and `deny` checks it so its reason cannot claim the
 * operator declined a result they in fact accepted.
 *
 * What the marker must NOT do is choose the branch. A caller deciding between
 * "apply the parked result" and "grant permission to run" has to filter on
 * `applied_at === null` itself — branching on mere existence locked the Grant
 * verb out for as long as the marker lived. A spent marker refuses a second
 * APPLY, which `applyPendingGate` enforces on its own `applied_at` check; it is
 * not a bar on granting the plugin permission to run again.
 *
 * Stub gates never reach here: they are discarded when the state document is
 * read.
 */
export function findPendingGate(state: EngineState, plugin: string): PendingGate | undefined {
  return state.pending_gates.filter((g) => g.plugin === plugin).at(-1)
}

/**
 * Apply a parked gate: record the result the plugin already produced, and never
 * re-invoke anything.
 *
 * Approval is acceptance of an observed outcome, never permission to re-run.
 * The handler was invoked and its declared side effects fired long before the
 * supervision gate saw the result, so re-running would double effects that
 * already happened. Nothing in this function reaches `invokePlugin`.
 *
 * Nothing here reaches `approval-gate.ts` either. That is what makes "approving
 * a parked result mints no Grant" true by structure rather than by test: there
 * is no code path from here to a grant write.
 *
 * Three refusals, all checked BEFORE anything is written:
 *
 *   - **already applied** — the gate carries an `applied_at`. Nothing is
 *     written at all, so a double `approve` cannot double-record.
 *   - **a dependency moved** — some dependency's `last_run_at` is newer than
 *     the gated run's start, so the parked result was computed against inputs
 *     that have since changed.
 *   - **expired** — the gate is older than the earlier of `ttl_hours` and
 *     {@link GATE_MAX_AGE_MS} from its completion.
 *
 * Expiry is decided HERE, as a state transition this function makes, rather
 * than inferred by whatever is rendering the gate. That is what stops an
 * approval and an expiry racing into a double apply: there is one place that
 * decides, and it decides while holding the state it is about to write.
 *
 * On either refusal the gate is discarded and the plugin's `plugin_runs` entry
 * is deleted, which leaves the plugin due on the next advance. That is the
 * point: the parked result was never accepted, so there is no accepted run to
 * hold it back, and the work should happen again. The `gated` entry existed to
 * stop the effects re-firing during the hold, and the hold is over.
 *
 * Downstream dependents are NOT run from here. They run on the next advance,
 * under the normal guard chain — a CLI command that ran them would have
 * bypassed every gate that chain applies.
 */
export async function applyPendingGate(
  state: EngineState,
  gate: PendingGate,
  manifest: PluginManifest,
  opts: { statePath: string; eventsPath?: string; now?: number } = { statePath: engineStatePath() },
): Promise<GateApplyOutcome> {
  const now = opts.now ?? Date.now()

  if (gate.applied_at !== null) {
    return { outcome: 'already_applied', applied_at: gate.applied_at }
  }

  // Narrowing, not a guard against real input: a gate reaching here has both
  // clocks, because one without them is discarded at read time.
  const { run_started_at: startedAt, run_completed_at: completedAt } = gate
  if (startedAt === null || completedAt === null) {
    return { outcome: 'refused', reason: 'expired', detail: 'the gate carries no record of when its run happened' }
  }

  const discard = async (
    reason: 'dependency_moved' | 'expired',
    detail: string,
  ): Promise<GateApplyOutcome> => {
    // Carry a live denial across the delete below. The denial was recorded
    // against the proposal as it stood WITH this run's Output, and
    // `proposalFingerprint` reads that Output out of `plugin_runs` — so
    // deleting the entry moves the live fingerprint, the answer stops
    // matching, and the plugin runs again on the next advance, re-firing the
    // side effects the operator said no to. Silently, under a live Grant: the
    // superseded-denial note only rides the `unapproved` arm.
    //
    // Measured BEFORE the delete, and only carried when it still matched. A
    // denial that was already stale stays stale — re-stamping it would revive
    // an answer to a proposal that no longer exists.
    const denial = Object.hasOwn(state.denials, gate.plugin)
      ? state.denials[gate.plugin]
      : undefined
    const denialWasLive =
      denial !== undefined &&
      denial.fingerprint === proposalFingerprint(state, gate.plugin, manifest)

    state.pending_gates = state.pending_gates.filter((g) => g !== gate)
    delete state.plugin_runs[gate.plugin]
    if (denial !== undefined && denialWasLive) {
      denial.fingerprint = proposalFingerprint(state, gate.plugin, manifest)
      // Say what the re-binding did, because it changed what the denial MEANS.
      // With `plugin_runs` gone the fingerprint is `hash(plugin, side_effects,
      // [])`, which can only stop matching if the manifest's side effects
      // change: the plugin is suppressed at the denial check, which sits before
      // the approval gate, so it never runs and can never produce a new Output
      // to move the proposal. The denial is now permanent by name. That is the
      // right call — the alternative is re-firing side effects the operator
      // said no to — but the old reason names a parked result this discard just
      // threw away, and that sentence is what `deny --list` prints, what the
      // `denial_recorded` notice carries, and what the evaluator quotes on
      // every suppressed advance. Nothing else narrates the transition:
      // `emitGateInvalidated` below reports the GATE discard, and the
      // superseded note only rides the `unapproved` arm, which a denied plugin
      // never reaches.
      denial.reason =
        `the operator declined the parked result from run ${gate.run_id}, which was then ` +
        `discarded (${reason}) — ${gate.plugin} is denied by name until the denial is taken ` +
        `back with warpline deny --remove ${gate.plugin}`
    }
    await writeEngineState(state, opts.statePath)
    await emitGateInvalidated(gate.plugin, gate.run_id, reason, opts.eventsPath).catch(() => {
      /* a discard notice that cannot be written must not undo the discard */
    })
    return { outcome: 'refused', reason, detail }
  }

  const startedMs = new Date(startedAt).getTime()
  const moved = manifest.dependencies.filter((dep) => {
    const last = state.plugin_runs[dep]?.last_run_at
    return last !== undefined && new Date(last).getTime() > startedMs
  })
  if (moved.length > 0) {
    return discard(
      'dependency_moved',
      `dependency ${moved.join(', ')} re-ran after this run started, so the parked result was computed against inputs that have moved`,
    )
  }

  const ceilingMs = Math.min(manifest.ttl_hours * 60 * 60 * 1000, GATE_MAX_AGE_MS)
  const ageMs = now - new Date(completedAt).getTime()
  if (ageMs > ceilingMs) {
    return discard(
      'expired',
      `the gate expired — it is ${Math.round(ageMs / 3_600_000)}h old, past the ${Math.round(ceilingMs / 3_600_000)}h ceiling for this plugin`,
    )
  }

  // Overwrite the `gated` entry IN PLACE: same anchor, real terminal status,
  // and the Output pointer the run already carried. `last_run_at` is the gate's
  // completion, not `now` — a later approval must not move when the work
  // happened.
  state.plugin_runs[gate.plugin] = {
    last_run_at: completedAt,
    status: gate.plugin_result.status,
    duration_ms: Math.max(0, new Date(completedAt).getTime() - startedMs),
    ...lastOutputOf(gate.plugin_result),
  }
  // Marked, not deleted. A deleted gate is an invisible one, and the next
  // `approve` would fall through to the Grant path instead of refusing.
  gate.applied_at = new Date(now).toISOString()
  await writeEngineState(state, opts.statePath)

  return {
    outcome: 'applied',
    fsm_state: 'approved',
    run_id: gate.run_id,
    run_completed_at: completedAt,
    summary: gate.plugin_result.summary,
  }
}

/**
 * The `last_output` slice of a `plugin_runs` entry, spread into the write.
 *
 * Returns an EMPTY object when the result produced no Output, so the key is
 * absent from the JSON rather than present as `null` or `{}` — a reader should
 * not have to tell an unproductive run from a malformed pointer.
 *
 * "Most recent" is the last element: `artifacts_produced` is written in the
 * order the handler produced them.
 */
function lastOutputOf(result: SkillResult): { last_output?: OutputRecord } {
  const last = result.artifacts_produced.at(-1)
  return last === undefined ? {} : { last_output: last }
}

function getDefaultPluginsDir(): string {
  return pluginsDirDefault()
}

function getDefaultStatePath(): string {
  return engineStatePath()
}

function getDefaultRunsDir(): string {
  return runsDirDefault()
}
