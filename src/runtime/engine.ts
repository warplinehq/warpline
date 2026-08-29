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
import { randomUUID } from 'node:crypto'
import { checkApproval } from './approval-gate.js'
import {
  sessionApprovalPath,
  preferencesPath as defaultPreferencesPath,
  pluginsDir as pluginsDirDefault,
  stateDir as stateDirDefault,
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
import type { EngineState } from '../schemas/engine-state.js'
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

  // -- Side-effect approval gate ---------------------------------
  if (
    manifest.side_effects.length > 0 &&
    !(await checkApproval(pluginName, ctx.approvalPath, { now }))
  ) {
    return {
      due: false,
      reason: 'unapproved',
      detail: 'skipped (unapproved): side effects require session approval',
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
  const state = await readEngineState(stateDir)

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
    await emitBoardEvent(
      makeEvent('notice', 'engine:tier-transition', tierTransitionSummary),
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
          await emitPluginSkipped(pluginName, `blocked (dry-run): declares side effects [${manifest.side_effects.join(', ')}]`, eventsPath)
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
            await emitPluginSkipped(pluginName, ev.detail, eventsPath)
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
            await emitPluginSkipped(pluginName, ev.detail, eventsPath)
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
            await emitPluginSkipped(pluginName, ev.detail, eventsPath)
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
            await emitPluginSkipped(pluginName, ev.detail, eventsPath)
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
            await emitPluginSkipped(pluginName, ev.detail, eventsPath)
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
            await emitPluginSkipped(pluginName, ev.detail, eventsPath)
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
          await emitPluginSkipped(pluginName, ev.detail, eventsPath)
          onPluginEnd?.(pluginName, 'skipped', unapprovedElapsed, 'unapproved side effects')
          return
        }

        // -- Set FSM to running --
        plugin_states.set(pluginName, 'running')
        onPluginStart?.(pluginName)
        await emitPluginStarted(pluginName, eventsPath)

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
          await emitPluginFailed(pluginName, errMsg, eventsPath)
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
            await emitPluginCompleted(pluginName, `[dry-run] would pause here: ${result.summary}`, eventsPath)
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
            await emitPluginGated(pluginName, eventsPath)
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
            state.plugin_runs[pluginName] = {
              last_run_at: new Date().toISOString(),
              status: 'gated',
              duration_ms: Date.now() - entryStart,
              // last_output: written here as well as on the autonomous path. A
              // gated run produced its Outputs before the gate saw them.
              ...lastOutputOf(result),
            }
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
          await emitPluginFailed(pluginName, result.summary, eventsPath)
        } else {
          await emitPluginCompleted(pluginName, result.summary, eventsPath)
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

  // Add pending_gates to state for gated plugins
  if (gated_plugins.length > 0) {
    const gates = gated_plugins.map(pluginName => {
      const entry = plugin_entries.find(e => e.plugin === pluginName)
      return {
        plugin: pluginName,
        run_id,
        created_at: new Date().toISOString(),
        payload_summary: entry?.result_summary ?? '',
        plugin_result: {
          status: 'partial' as const,
          phases_completed: [],
          phases_failed: [],
          errors: [],
          data_freshness: {},
          summary: entry?.result_summary ?? '',
          artifacts_produced: [],
          schema_version: 1,
        } satisfies SkillResult,
      }
    })
    ;(updatedState as Record<string, unknown>)['pending_gates'] = gates
  } else {
    ;(updatedState as Record<string, unknown>)['pending_gates'] = []
  }

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
  return join(stateDirDefault(), 'engine-state.json')
}

function getDefaultRunsDir(): string {
  return runsDirDefault()
}
