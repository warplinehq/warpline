/**
 * Auto-advance engine for warpline.
 *
 * Provides:
 *   topoSort()    — topological sort of plugin dependency graph into execution levels
 *   runAdvance()  — full engine loop: resolve order, check staleness, execute, gate supervised, log
 *
 * Design decisions:
 *   D-14: Per-plugin FSM tracks 6 states + skipped
 *   D-15: Kahn's algorithm for topological sort (cycle detection included)
 *   D-16: Level-parallel execution via Promise.all with individual try/catch per plugin
 *   D-17: Supervised plugins pause the engine (non-dry-run) and store payloads in pending_gates
 */
import { mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
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
import type { SkillResult } from '../schemas/skill-result.js'
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
 * Headless run profile (D-04/D-05).
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

/** Profile tier → set of schedules that run under that profile. */
const PROFILE_ALLOWED_SCHEDULES: Record<RunProfile, ReadonlySet<string>> = {
  daily: new Set(['on_run', 'daily']),
  weekly: new Set(['on_run', 'daily', 'weekly']),
  manual: new Set(['manual']),
}

/**
 * Runtime source of truth for the valid `--profile` values, derived from the tier
 * map above rather than restated — a new tier cannot be added to one and
 * forgotten in the other. `advance.ts` validates the CLI flag against this.
 */
export const RUN_PROFILES = Object.keys(PROFILE_ALLOWED_SCHEDULES) as RunProfile[]

export interface AdvanceOptions {
  dryRun?: boolean
  force?: boolean
  /**
   * Headless run profile (D-04/D-05). When set, the engine filters plugins by
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
   * D-13: Called exactly once with a human-readable reason when the overall
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

  // 2a. Compute degradation tier (D-04) — from PREVIOUS last_interaction_at (before we update it)
  const previousLastInteraction = state.last_interaction_at
  const currentTier: TierName = computeTier(previousLastInteraction)

  // 2b. Update last_interaction_at (D-02) — persisted in final writeEngineState
  state.last_interaction_at = new Date().toISOString()

  // 2c. Tier transition BoardEvent (D-10) — emit when tier is not normal
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

  // 4. Load all plugin manifests from pluginsDir
  const plugins = await loadPluginManifests(pluginsDir)

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

  // 7. Execute each level
  for (const level of levels) {
    if (stopped) break

    // Execute all plugins in this level concurrently
    await Promise.all(
      level.map(async (pluginName) => {
        const manifest = plugins.get(pluginName)!
        const entryStartedAt = new Date().toISOString()
        const entryStart = Date.now()

        // -- Profile tier filter (D-04, D-05) --
        // When a headless profile is set, only plugins whose schedule is
        // allowed under that profile tier may run. All others are skipped.
        if (allowedSchedules && !allowedSchedules.has(manifest.schedule)) {
          plugin_states.set(pluginName, 'skipped')
          const reason = `profile '${profile}' filter: schedule '${manifest.schedule}' not in tier`
          plugin_entries.push({
            plugin: pluginName,
            status: 'skipped',
            started_at: entryStartedAt,
            elapsed_ms: Date.now() - entryStart,
            result_summary: reason,
            retried: false,
          })
          await emitPluginSkipped(pluginName, reason, eventsPath)
          return
        }

        // -- Tier filter (D-21, D-22): coarser gate than staleness --
        if (!isEligibleForTier(manifest.min_tier ?? 'normal', currentTier)) {
          plugin_states.set(pluginName, 'skipped')
          const reason = `tier filter: current '${currentTier}' exceeds plugin min_tier '${manifest.min_tier ?? 'normal'}'`
          plugin_entries.push({
            plugin: pluginName,
            status: 'skipped',
            started_at: entryStartedAt,
            elapsed_ms: Date.now() - entryStart,
            result_summary: reason,
            retried: false,
          })
          await emitPluginSkipped(pluginName, reason, eventsPath)
          return
        }

        // -- Headless supervised bypass (A2) --
        // In headless mode, supervised plugins cannot be gated (no human in
        // the loop to approve). Mark them 'skipped' before we invoke anything.
        if (headless && manifest.autonomy_level === 'supervised') {
          plugin_states.set(pluginName, 'skipped')
          const reason = 'headless mode: supervised plugin bypassed (no interactive gate)'
          plugin_entries.push({
            plugin: pluginName,
            status: 'skipped',
            started_at: entryStartedAt,
            elapsed_ms: Date.now() - entryStart,
            result_summary: reason,
            retried: false,
          })
          await emitPluginSkipped(pluginName, reason, eventsPath)
          return
        }

        // -- Manual: always skip --
        if (manifest.autonomy_level === 'manual') {
          plugin_states.set(pluginName, 'skipped')
          plugin_entries.push({
            plugin: pluginName,
            status: 'skipped',
            started_at: entryStartedAt,
            elapsed_ms: Date.now() - entryStart,
            result_summary: 'manual — requires explicit invocation',
            retried: false,
          })
          await emitPluginSkipped(pluginName, 'manual — requires explicit invocation', eventsPath)
          return
        }

        // -- Staleness check: skip if fresh --
        const freshness = isPluginFresh(pluginName, manifest, state, { force })
        if (freshness.fresh) {
          plugin_states.set(pluginName, 'skipped')
          plugin_entries.push({
            plugin: pluginName,
            status: 'skipped',
            started_at: entryStartedAt,
            elapsed_ms: Date.now() - entryStart,
            result_summary: `skipped: ${freshness.reason}`,
            retried: false,
          })
          await emitPluginSkipped(pluginName, freshness.reason ?? 'fresh', eventsPath)
          return
        }

        // -- Task lock check: read v2 task_aging, skip if active task for this plugin --
        const isLocked = await smCheckTaskLock(pluginName)
        if (isLocked) {
          plugin_states.set(pluginName, 'skipped')
          plugin_entries.push({
            plugin: pluginName,
            status: 'skipped',
            started_at: entryStartedAt,
            elapsed_ms: Date.now() - entryStart,
            result_summary: 'task locked — active on board',
            retried: false,
          })
          await emitPluginSkipped(pluginName, 'task locked — active on board', eventsPath)
          return
        }

        // -- Dry-run side-effect block (D-03, D-04, OBS-02) --
        if (dryRun && manifest.side_effects.length > 0) {
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

        // -- Side-effect approval gate (D-01, D-02, INTG-02, INTG-03) --
        if (manifest.side_effects.length > 0) {
          const resolvedApprovalPath = approvalPath ?? sessionApprovalPath()
          const approved = await checkApproval(pluginName, resolvedApprovalPath)
          if (!approved) {
            plugin_states.set(pluginName, 'skipped')
            const unapprovedElapsed = Date.now() - entryStart
            plugin_entries.push({
              plugin: pluginName,
              status: 'skipped',
              started_at: entryStartedAt,
              elapsed_ms: unapprovedElapsed,
              result_summary: `skipped (unapproved): side effects [${manifest.side_effects.join(', ')}] require session approval`,
              retried: false,
            })
            await emitPluginSkipped(pluginName, `skipped (unapproved): side effects require session approval`, eventsPath)
            onPluginEnd?.(pluginName, 'skipped', unapprovedElapsed, 'unapproved side effects')
            return
          }
        }

        // -- Set FSM to running --
        plugin_states.set(pluginName, 'running')
        onPluginStart?.(pluginName)
        await emitPluginStarted(pluginName, eventsPath)

        // -- Invoke plugin --
        let invocationResult: Awaited<ReturnType<typeof invokePlugin>>
        try {
          invocationResult = await invokePlugin(pluginName, {}, { pluginsDir })
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

  // -- Tier-based task mutations (D-05, D-07) --
  if (currentTier === 'suspended') {
    // Soft-archive info-severity tasks that aren't already archived
    for (const task of state.task_aging) {
      if (task.severity === 'info' && !task.archived_at) {
        task.archived_at = new Date().toISOString()
      }
    }
  } else if (currentTier === 'degraded' || currentTier === 'extended') {
    // Auto-defer info-severity tasks (D-05): critical + warning stay active
    const now = new Date().toISOString()
    const existingDeferralIds = new Set(state.deferrals.map(d => d.task_id))
    for (const task of state.task_aging) {
      if (task.severity === 'info' && !existingDeferralIds.has(task.task_id) && !task.archived_at) {
        state.deferrals.push({
          task_id: task.task_id,
          reason: `Auto-deferred: ${currentTier} tier (D-05)`,
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

  // 11. D-13: fire onRunFailure hook exactly once if the run did not complete
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

export async function loadPluginManifests(pluginsDir: string): Promise<Map<string, PluginManifest>> {
  const { readdir } = await import('node:fs/promises')
  const plugins = new Map<string, PluginManifest>()

  let entries: string[]
  try {
    entries = await readdir(pluginsDir)
  } catch {
    return plugins // empty if dir doesn't exist
  }

  await Promise.all(
    entries.map(async (entry) => {
      const manifestPath = join(pluginsDir, entry, 'manifest.ts')
      try {
        const mod = await import(manifestPath)
        if (mod.manifest) {
          plugins.set(entry, mod.manifest as PluginManifest)
        }
      } catch {
        // Skip invalid/missing manifests
      }
    }),
  )

  // Phase 112-08: warn on unresolved dependencies (hygiene — topoSort silently ignores these today).
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

  return plugins
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
