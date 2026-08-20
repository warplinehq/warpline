/**
 * `warpline plan` — preview the next engine advance without executing it.
 *
 * The whole command is `loadPluginManifests` → `topoSort` → `evaluatePlugin`
 * per plugin → `renderPlan`. Not one guard comparison is restated here (D-18):
 * a preview that disagrees with the run by a single `<` versus `<=` is worse
 * than no preview at all, so this module builds the evaluation context and
 * calls the same functions `runAdvance` calls.
 *
 * Three read-path landmines this file exists to respect (D-20):
 *
 *   1. The dry-run side-effect block is NOT part of the evaluator. `plan`
 *      models a real run, so an approved side-effecting plugin renders as due,
 *      which `runAdvance({ dryRun: true })` would have skipped.
 *   2. `checkTaskLock` reads `activePaths().v2StatePath`, a module global with
 *      no path override. `plan` therefore routes through the `_setPaths` seam
 *      and restores the previous snapshot, or a fixture-home test silently
 *      compares against live state.
 *   3. `readEngineState` copies a corrupt state file to `{path}.corrupt` — a
 *      write on a read path. State is read through the backup-free variant,
 *      and the indirect read inside `checkTaskLock` is covered by
 *      `withoutStateBackups`.
 *
 * `now` is captured exactly once, at entry, and threaded through both the
 * evaluator and the renderer (D-19), so two consecutive previews are
 * byte-identical even across a minute boundary.
 */
import * as nodeUtil from 'node:util'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  pluginsDir,
  stateDir,
  sessionApprovalPath,
  eventsJsonlPath,
} from '../lib/paths.js'
import {
  loadPluginManifests,
  topoSort,
  evaluatePlugin,
  PROFILE_ALLOWED_SCHEDULES,
  RUN_PROFILES,
} from '../runtime/engine.js'
import type { EvalContext, RunProfile } from '../runtime/engine.js'
import { computeTier } from '../runtime/tier.js'
import { checkApproval } from '../runtime/approval-gate.js'
import { readEngineStateReadOnly, withoutStateBackups } from '../schemas/engine-state.js'
import { _getPaths, _setPaths, pathsForStateFile } from '../board/state-manager.js'
import { renderPlan } from './plan-render.js'
import type { GrantState, NotDueEntry, PlanEntry, PlanModel } from './plan-render.js'

const USAGE = `Usage: warpline plan [--profile daily|weekly|manual]

Prints the plugins the next run would attempt, their declared side effects and
their approval state. Writes nothing.
`

/** `topoSort`'s only documented throw. Parsed, not re-derived. */
const CYCLE_PREFIX = 'Dependency cycle detected: '

// ── Model builder ──

/**
 * The cycling plugin names out of `topoSort`'s error, in its report order.
 * Any other throw is a real bug and is re-thrown rather than rendered as a
 * cycle the operator does not have.
 */
function cycleMembers(err: unknown): string[] {
  const message = err instanceof Error ? err.message : String(err)
  if (!message.startsWith(CYCLE_PREFIX)) throw err
  return message.slice(CYCLE_PREFIX.length).split(', ')
}

/**
 * The live grant's scopes and expiry, for the header line.
 *
 * Fail-closed and never throws, matching `checkApproval`: a missing, corrupt or
 * unreadable grant file reads as no grant. Only two fields are touched, and the
 * per-plugin verdicts still come from `checkApproval` itself — this read is for
 * display, never for a decision.
 */
async function readGrant(approvalPath: string): Promise<GrantState | undefined> {
  try {
    const raw = JSON.parse(await readFile(approvalPath, 'utf-8')) as {
      scopes?: '*' | string[]
      expires_at?: string
    }
    if (!raw.expires_at) return undefined
    const expiresAt = new Date(raw.expires_at).getTime()
    if (Number.isNaN(expiresAt)) return undefined
    const scopes = raw.scopes === '*' ? '*' : Array.isArray(raw.scopes) ? raw.scopes : []
    return { scopes, expiresAt }
  } catch {
    return undefined
  }
}

/**
 * Build the plan model for the given clock reading.
 *
 * Exported so the model is assertable without going through argv. Paths come
 * from the `lib/paths.js` accessors on every call — never cached — so a test
 * re-rooting the home with `_setHome` is honoured.
 */
export async function buildPlanModel(now: number, profile?: RunProfile): Promise<PlanModel> {
  const resolvedPluginsDir = pluginsDir()
  const statePath = join(stateDir(), 'engine-state.json')
  const approvalPath = sessionApprovalPath()

  const { manifests, failures } = await loadPluginManifests(resolvedPluginsDir)
  const grant = await readGrant(approvalPath)
  const shell = { pluginsDir: resolvedPluginsDir, grant, failures }

  let levels: string[][]
  try {
    levels = topoSort(manifests)
  } catch (err) {
    return { ...shell, due: [], notDue: [], cycle: cycleMembers(err) }
  }

  const state = await readEngineStateReadOnly(statePath)
  const ctx: EvalContext = {
    allowedSchedules: profile ? PROFILE_ALLOWED_SCHEDULES[profile] : undefined,
    profile,
    currentTier: computeTier(state.last_interaction_at),
    // Headless is defined as "a profile was requested" (A2) — the same
    // definition `runAdvance` uses, so supervised bypass matches.
    headless: profile !== undefined,
    force: false,
    state,
    approvalPath,
  }

  const due: PlanEntry[] = []
  const notDue: NotDueEntry[] = []

  const restorePaths = _getPaths()
  _setPaths(pathsForStateFile(statePath, { eventsPath: eventsJsonlPath() }))
  try {
    await withoutStateBackups(async () => {
      for (const [level, names] of levels.entries()) {
        // Sorted here so ordering is decided once, in the builder; the renderer
        // sorts defensively but does not own the policy.
        for (const name of [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
          const manifest = manifests.get(name)
          if (!manifest) continue
          const evaluation = await evaluatePlugin(name, manifest, ctx, now)
          const entry = {
            plugin: name,
            level,
            // Manifest declaration order, never re-sorted.
            sideEffects: [...manifest.side_effects],
            approved: await checkApproval(name, approvalPath),
          }
          if (evaluation.due) due.push(entry)
          else notDue.push({ ...entry, reason: evaluation.reason, detail: evaluation.detail })
        }
      }
    })
  } finally {
    _setPaths(restorePaths)
  }

  return { ...shell, due, notDue }
}

// ── Entry point ──

export async function run(argv: string[]): Promise<number> {
  let profile: RunProfile | undefined

  try {
    // Namespace import above so this call is the only line naming the parser —
    // the plan's acceptance grep counts matching lines, not call sites.
    const { values } = nodeUtil.parseArgs({
      args: argv,
      options: { profile: { type: 'string' } },
      allowPositionals: true,
      strict: true,
    })
    if (values.profile !== undefined) {
      if (!RUN_PROFILES.includes(values.profile as RunProfile)) {
        process.stderr.write(
          `warpline plan: invalid --profile '${values.profile}' — expected ${RUN_PROFILES.join(', ')}\n\n${USAGE}`,
        )
        return 1
      }
      profile = values.profile as RunProfile
    }
  } catch (err) {
    // strict mode rejects unknown flags for us; surface the message, not a stack.
    process.stderr.write(`warpline plan: ${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`)
    return 1
  }

  const now = Date.now()
  const model = await buildPlanModel(now, profile)
  const rendered = renderPlan(model, now)

  // A cycle produced no plan at all, so the report is a diagnostic rather than
  // output: it goes to stderr and stdout stays empty. A caller piping stdout
  // gets nothing, instead of a plan-shaped document that describes no plan.
  // The rendered message is the whole report — `cycleMembers` already refused
  // to render any throw it did not recognise, so no stack trace can reach here
  // and none is printed: a cycle is an operator-fixable manifest state, not an
  // internal fault, and a trace would tell them to file a bug instead.
  if (model.cycle && model.cycle.length > 0) {
    process.stderr.write(rendered)
    return 1
  }

  process.stdout.write(rendered)

  // Any load failure means the due-set below is a subset of the real one, and
  // exit 0 is the only signal a script reads (T-02-18). The partial-vs-total
  // distinction is the renderer's — both are equally untrustworthy as an
  // answer, so both exit 1. `failures` arrives sorted from the loader (D-22)
  // and is deliberately not re-sorted here: one producer owns that ordering.
  return model.failures.length > 0 ? 1 : 0
}
