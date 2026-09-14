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
import { join, dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { checkApproval } from './approval-gate.js'
import {
  sessionApprovalPath,
  preferencesPath as defaultPreferencesPath,
  pluginsDir as pluginsDirDefault,
  engineStatePath,
  runsDir as runsDirDefault,
  lockPath as defaultLockPath,
  lastSuccessfulAdvancePath as defaultDeadManPath,
  warplineHome,
} from '../lib/paths.js'
import { atomicWriteText } from '../lib/fs-atomic.js'
import { resolveWallClock } from '../lib/wall-clock.js'
import { advanceCounts } from './exit-codes.js'
// The account's own type, imported rather than re-spelled as a `Pick` here: a
// second spelling is a second answer about which fields of an advance the
// record is derived from, and the two only have to disagree once.
import type { AdvanceOutcome } from './exit-codes.js'
import { acquireLock, releaseLock } from './lock.js'
import { JsonlRunLogger } from '../lib/jsonl-logger.js'
import type { PluginManifest } from '../schemas/plugin-manifest.js'
import { invokePlugin } from './invoke-plugin.js'
import type { CapabilityGrantWitness, DependencyRun } from './capabilities.js'

/**
 * The grant witness for a plugin the engine has already cleared to run.
 *
 * **Read the name before the body.** This function does not read the Grant and
 * must never be called by anything that has not read it. It is only correct
 * downstream of the dueness check below, which reads the Grant ONCE: a plugin
 * declaring side effects reaches that call site only when the read returned
 * true, and a plugin declaring none never consulted it at all. Called from
 * anywhere else it would fabricate a granted witness nobody checked, which is
 * the failure the single-read rule exists to prevent — and no guard in this
 * repository catches fabrication, only re-reads. `run-plugin.ts` reads no
 * grant and passes its own explicit not-granted arm rather than calling this.
 *
 * The granted arm records the scope the read ASKED about, which is the plugin
 * name. The reader answers true for every scope once a grant carries the
 * wildcard and does not report which one matched, so the requested scope is
 * the strongest true statement available here.
 *
 * It is a named function rather than the ternary it replaced because a ternary
 * inlined at the call site cannot be told apart from its own opposite: with no
 * gated member registered, swapping the two arms was green across the entire
 * suite. `grant-witness.test.ts` covers all three arms and asserts this file
 * carries no inline literal that could drift from them.
 *
 * **The content arm is produced HERE and nowhere else**, for the same reason.
 * A literal at the invocation site would be a witness nobody computed — the
 * exact fabrication the paragraph above says no guard in this repository
 * catches. `content` is the authority the dueness check already decided, passed
 * forward rather than asked about again; when it is present the plugin reached
 * the invocation on approved bytes and no scope was ever read, which is why the
 * arm carries no scope to report.
 */
export function witnessAfterGrantRead(
  pluginName: string,
  declaredSideEffects: PluginManifest['side_effects'],
  content?: ContentAuthority,
): CapabilityGrantWitness {
  if (content !== undefined) {
    return {
      granted: true,
      via: 'content-approval',
      fingerprint: content.fingerprint,
      effectId: content.effect_id,
    }
  }
  return declaredSideEffects.length === 0
    ? { granted: false, reason: 'no-declared-side-effects' }
    : { granted: true, scope: pluginName }
}
import { computeTier, isEligibleForTier } from './tier.js'
import type { TierName } from './tier.js'
import { isPluginFresh } from './staleness.js'
import type { FreshnessResult } from './staleness.js'
import {
  readEngineState,
  writeEngineState,
} from './engine-state-store.js'
import { ENGINE_STATE_MAX_SCHEMA_VERSION } from '../schemas/engine-state.js'
import type { Approval, Denial, EngineState, PendingGate, PluginRun } from '../schemas/engine-state.js'
import { writeRunLog, pruneRunLogs } from './run-log-store.js'
import type { RefusalReason, RunLog } from '../schemas/run-log.js'
import type { OutputRecord, SkillResult } from '../schemas/skill-result.js'
import {
  emitBoardEvent,
  makeEvent,
  emitRunStarted,
  emitRunCompleted,
  emitPluginStarted,
  emitPluginCompleted,
  emitPluginFailed,
  emitPluginRefused,
  emitPluginSkipped,
  emitPluginGated,
  emitGateInvalidated,
  emitPluginDenied,
} from '../board/engine-events.js'
import { readPreferences, isQuietHours } from '../lib/preferences.js'
import {
  checkTaskLock as smCheckTaskLock,
  pathsForStateFile,
  /**
   * DERIVED, never the bare `withStateLock`: that one resolves through
   * `activePaths()`, falls back to `defaultPaths()`, and can end up locking a
   * path a sibling test file already deleted — a lock that reports success and
   * protects a different home.
   *
   * Used through `lockStateDocument` below and nowhere else. This file's gate
   * counts OCCURRENCES of this name rather than call sites and holds them at
   * two: this line and the one call inside that wrapper. The bound is not
   * style — the acquire is a non-reentrant `O_EXCL` file lock, so a second
   * region nested inside the first self-deadlocks for the full 10 s ceiling and
   * then throws, and a bound on the name is the cheapest way to notice one
   * appearing.
   */
  withStateLockAt,
} from '../board/state-manager.js'

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
 * Read in exactly one place — the profile tier gate, which derives the tier
 * from `EvalContext.profile` as it evaluates. Preview and run therefore share
 * the map by construction rather than by two callers agreeing to build the same
 * set, which is the one-comparison disagreement this exists to prevent.
 * `RUN_PROFILES` below is derived from it for the same reason.
 */
const PROFILE_ALLOWED_SCHEDULES: Record<RunProfile, ReadonlySet<string>> = {
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
   * The instant the DUE-NESS decision is made against, epoch milliseconds.
   *
   * Epoch ms and not a `Date`, matching every clock seam already in this tree;
   * and not a getter, because a getter lets two reads inside one advance
   * disagree, which is the disagreement the seam exists to remove.
   *
   * It reaches `evaluatePlugin`, and through `approvalNow` it reaches the two
   * `windowClosed` consumers — the retention protected set near the top of the
   * advance and the approval expiry sweep at the end-of-run assembly. Those two
   * read one captured value rather than the option directly, which is what stops
   * protection and deletion disagreeing about an instant as well as about a
   * rule. Nothing else reads it. `entryStart` stays a live
   * `Date.now()` and remains the `elapsed_ms` baseline for every row in the run
   * log — freezing that to an injected past instant would make each duration a
   * large positive number describing time that did not pass. It is deliberately
   * NOT threaded into `run_id`, `started_at` or either `completed_at`: those are
   * four unseeded clock reads, and a seeded `run_id` collides with itself, which
   * collides the run-log filenames with it.
   *
   * With nothing injected the split is byte-identical to a run without it.
   */
  now?: number
  /**
   * Headless run profile. When set, the engine filters plugins by
   * schedule tier and treats the run as non-interactive (see RunProfile).
   * When undefined, the engine applies no schedule tier but still excludes
   * `schedule: 'manual'`, and supervised plugins gate normally — this
   * preserves pre-profile interactive behavior.
   */
  profile?: RunProfile
  /**
   * The plugin root this advance reads from. Precedence is exactly
   * option -> default: this value when supplied, otherwise
   * `<warplineHome()>/plugins`. One root, not a search path.
   *
   * A host may point this outside the home; state, runs, the event log, the
   * session-approval grant and per-plugin config stay home-derived either way.
   * A root that is absent, is not a directory, or cannot be read is refused
   * before any write.
   */
  pluginsDir?: string
  /** Override state file path (for testing — full path to engine-state.json) */
  stateDir?: string
  /**
   * The run lock this advance takes, so two advances cannot write one home.
   * Defaults to `.lock` beside the state file — `<state>/.lock` under an
   * ordinary home, and the state override's own directory when one is given.
   *
   * What it does NOT guard, because both readings have been made in this
   * repository before and written down as errors: it does not guard
   * `engine-state.json`, whose read-modify-write window spans plugin execution
   * and is serialised by the board's separate `.state.lock` for the board's own
   * writers and by nothing at all for this one; and it does not guard the
   * session-approval grant, which the approve verb writes and this advance only
   * reads. It serialises advance against advance, and that is the whole of it.
   */
  lockPath?: string
  /** Override runs directory (for testing) */
  runsDir?: string
  /**
   * Directory the headless JSONL run log is written under. Defaults to
   * `<warplineHome()>/logs`, which puts the daily files at
   * `<home>/logs/runs/YYYY-MM-DD.jsonl`.
   *
   * Named as `logs` and never as the home root, because `JsonlRunLogger`
   * appends its own `runs/` segment and `runsDir()` is
   * `join(warplineHome(), 'runs')` — handing it the home root would write the
   * daily JSONL straight into the directory `pruneRunLogs` and
   * `trimPluginHistory` scan for run artifacts, where a `.jsonl` file is not
   * one of the two shapes either of them expects to find.
   */
  logsDir?: string
  /** Override events.jsonl path (for test isolation) */
  eventsPath?: string
  /** Override preferences.json path (for test isolation) */
  preferencesPath?: string
  /** Override session approval file path (for test isolation) */
  approvalPath?: string
  /** Called before each plugin begins execution (for streaming CLI output) */
  onPluginStart?: (plugin: string) => void
  /**
   * Called after each plugin resolves with final FSM state and elapsed_ms (for
   * streaming CLI output).
   *
   * NOT paired with `onPluginStart`. Two not-due arms — `unapproved` and
   * `dependency_failed` — call this without a preceding start, because both are
   * actionable skips worth a line while neither is an attempt. A host keying
   * state off `onPluginStart` must tolerate an unmatched end.
   *
   * The asymmetry is the correct one and is not a candidate for repair from the
   * other side: `plan.test.ts` defines "what a run attempted" as start-hook
   * membership, and a gated plugin belongs outside that set.
   */
  onPluginEnd?: (plugin: string, status: string, elapsed: number, reason?: string) => void
  /**
   * Called exactly once with a human-readable reason whenever the overall run
   * status is non-complete — any of 'partial', 'failed' or 'interrupted'. On
   * the normal path it fires after state persistence and the run-log write,
   * before runAdvance returns. The quiet-hours skip writes neither, so a
   * cycle refused there for loading no manifests fires the hook from that arm
   * instead: the contract holds on both paths, with no exception to remember.
   */
  onRunFailure?: (reason: string) => void
}

export interface AdvanceResult {
  run_id: string
  /**
   * `failed` is produced when the run loaded no plugin manifests at all — a
   * readable root holding nothing importable, or one whose every manifest
   * threw. Distinct from `partial`, which means some plugins ran and others
   * did not. Widening this union changed no published shape: the run log's
   * own status enum has admitted all four values since 0.1.0, and the engine
   * had simply never produced this one.
   */
  status: 'complete' | 'partial' | 'failed' | 'interrupted'
  plugin_states: Map<string, PluginFsmState | 'skipped'>
  gated_plugins: string[]
  /**
   * The plugins a content approval did NOT authorise this advance, each paired
   * with the closed-set reason its authority stopped applying.
   *
   * An array of pairs, and deliberately neither of the two shapes that read as
   * shorter: a `string[]` drops the reason, which is the whole point of the
   * field, and a record keyed by plugin name alongside a name list is two
   * accounts of one advance. Not a `Map` either — it does not survive
   * `JSON.stringify`, and this result is rendered by `--json` and read back
   * out of the dead-man file.
   *
   * Additive, on the argument `pruned` already makes above: nothing embeds
   * this result, and the run-log parse downstream strips unknown keys.
   */
  refused_plugins: Array<{ plugin: string; reason: RefusalReason }>
  run_log_path: string
  /**
   * How many run records this advance's retention prune removed. Zero on the
   * quiet-hours arm, which returns above the prune — nothing was reclaimed
   * because nothing looked.
   *
   * Additive, and additive is safe here: the benchmark harness stores derived
   * scalars off this result rather than embedding it, and the run-log parse it
   * does afterwards strips unknown keys.
   */
  pruned: number
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
 * from a parked gate. `plugin_runs` survives, and it is written on the same
 * branch that parks the gate, so it holds the same run's Output.
 *
 * A gate now outlives the advance that parked it, up to the gate ceiling, so
 * the original argument — that a fingerprint drawn on one would change the day
 * after it was recorded — no longer holds as stated. The choice does. A gate is
 * still the shorter-lived object of the two: it is discarded on apply, on
 * denial, when superseded, and at the ceiling, while `plugin_runs` outlives all
 * four. Binding an answer to the longer-lived record is what keeps a denial
 * from expiring for a reason the operator never sees.
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
 * Where a plugin stands with the denial record. THE one place that answers it:
 * "is this plugin denied?" is two questions wearing one coat — is there a
 * record, and does it still answer the proposal in front of us — and every
 * caller needs a different pair of them. The evaluator suppresses on `live`
 * and narrates `superseded`; `discard` re-stamps a `live` record and leaves a
 * `superseded` one stale; `approve` refuses on `live` and ignores the rest.
 *
 * Spelled out at each site, the pair drifted: the lookup has to be an
 * own-property one (`denials` is a plain object, so `denials['toString']`
 * answers with an inherited function and an existence test believes it), and a
 * caller that forgets the fingerprint comparison suppresses on an answer to a
 * question that no longer exists. Both mistakes were live in this file. A
 * caller added tomorrow meets the whole predicate or none of it.
 *
 * `denial` is the record itself, not a copy — `discard` re-binds its
 * fingerprint through this reference.
 */
export type DenialStanding =
  | { standing: 'none' }
  | { standing: 'live'; denial: Denial }
  | { standing: 'superseded'; denial: Denial }

export function denialStanding(
  state: EngineState,
  plugin: string,
  manifest: PluginManifest,
): DenialStanding {
  const denial = Object.hasOwn(state.denials, plugin) ? state.denials[plugin] : undefined
  if (denial === undefined) return { standing: 'none' }
  return denial.fingerprint === proposalFingerprint(state, plugin, manifest)
    ? { standing: 'live', denial }
    : { standing: 'superseded', denial }
}

// -----------------------------------------------------------------------
// Content approvals — what a "yes to these exact bytes" is bound to
// -----------------------------------------------------------------------

/**
 * The identity of one content-authorised fire.
 *
 * `sha256` over the consumer, the fingerprint that authorised it and the
 * instant it fires. Key order in the hashed object is fixed by the literal, as
 * it is in `denialFingerprint` above, which is what makes this stable without a
 * canonical-JSON dependency.
 *
 * State the claim precisely, because the overclaim is easy and wrong: the id is
 * RECOMPUTABLE by anyone holding the stored `(plugin, fingerprint,
 * fire_instant)` triple. It is not a value a retried advance regenerates — a
 * retry READS the stored id. Recomputability is what lets a reader check an id
 * they were handed; it is not a promise that two separate advances produce one.
 */
export function contentEffectId(
  plugin: string,
  fingerprint: string,
  fireInstant: string,
): string {
  return sha256(JSON.stringify({ plugin, fingerprint, fire_instant: fireInstant }))
}

/**
 * Where a plugin stands with the approvals record — the sibling of
 * `DenialStanding` above, and deliberately not a generalisation of it.
 *
 * Generalising the two would cost the three existing `denialStanding` callers
 * something for a shape none of them wants, and it would invite a reader to
 * treat "approved" as "not denied". They answer opposite questions over
 * different records and they stay apart.
 *
 * Seven arms, and two of them are not refusals. `spent` and `indeterminate` are
 * STATE REPORTS: the runtime already fired, or began firing and cannot prove it
 * finished, and neither is the operator having done something wrong. The other
 * five order as the refusal precedence: nothing recorded, then the two marks,
 * then the window, then the content.
 *
 * `approval` is the record itself, never a copy. The mid-run mark mutates
 * `state.approvals` through this reference; a clone would leave it writing to
 * an object nobody reads.
 */
export type ApprovalStanding =
  | { standing: 'none' }
  | { standing: 'spent'; approval: Approval }
  | { standing: 'indeterminate'; approval: Approval }
  | { standing: 'outside_window'; approval: Approval }
  | { standing: 'before_window'; approval: Approval }
  | { standing: 'content_moved'; approval: Approval }
  | { standing: 'live'; approval: Approval }

/**
 * THE one place that answers "may this plugin's approved bytes fire right now?"
 *
 * The manifest map is a parameter and not something the caller resolves first,
 * because the fingerprint's subject is the PRODUCER — whose name is on the
 * record, which the caller has not read yet. Asking the caller to hand in the
 * producer's manifest would require it to read the record to find out which
 * manifest to hand in.
 *
 * @param now - epoch ms, injected. Every window comparison here reads it and
 *   nothing else, so two evaluations at one instant cannot disagree.
 */
export function approvalStanding(
  state: EngineState,
  plugin: string,
  manifests: ReadonlyMap<string, PluginManifest>,
  now: number,
): ApprovalStanding {
  // Own-property, as the denial lookup is: a bare index answers `toString` with
  // an inherited member rather than with the absence that is the truth.
  const approval = Object.hasOwn(state.approvals, plugin) ? state.approvals[plugin] : undefined
  if (approval === undefined) return { standing: 'none' }

  if (approval.confirmed_at !== null) return { standing: 'spent', approval }
  if (approval.marked_at !== null) return { standing: 'indeterminate', approval }

  // Both bounds inside the try. A host tz database that no longer knows the
  // zone is the backstop edge, and the conservative direction is refusal: a
  // throw escaping here would reach `evaluatePlugin`, and `plan` — which is
  // contracted never to fail — would crash on a preview.
  let opensAt: number
  let closesAt: number
  try {
    closesAt = resolveWallClock(approval.not_after, approval.zone)
    opensAt =
      approval.not_before === null
        ? Date.parse(approval.approved_at)
        : resolveWallClock(approval.not_before, approval.zone)
  } catch {
    return { standing: 'outside_window', approval }
  }

  if (now >= closesAt) return { standing: 'outside_window', approval }
  if (now < opensAt) return { standing: 'before_window', approval }

  // The producer's manifest is what the fingerprint is computed over. Absent
  // from the map, the runtime cannot confirm the bytes are the ones approved,
  // and not-confirmable is refusal rather than a fire.
  const producerManifest = manifests.get(approval.producer)
  if (producerManifest === undefined) return { standing: 'content_moved', approval }

  // The producer-identity conjunct closes the one drift path a fingerprint
  // comparison cannot see. At fire time the handler reads the LAST OUTPUT of
  // `manifest.dependencies[0]`. Rewrite that dependency from X to Y after
  // approving and the record still names X, X's Output has not moved, the
  // fingerprint still matches — and Y's bytes ship, which no human reviewed.
  const consumerManifest = manifests.get(plugin)
  if (consumerManifest?.dependencies[0] !== approval.producer) {
    return { standing: 'content_moved', approval }
  }

  return approval.fingerprint === proposalFingerprint(state, approval.producer, producerManifest)
    ? { standing: 'live', approval }
    : { standing: 'content_moved', approval }
}

/**
 * Has this approval's fire window closed at `now`?
 *
 * **One predicate, two consumers, and that is the whole reason it is a
 * function.** An advance asks this question twice, at two ends of `runAdvance`:
 * once near the top, to decide which runs the prune must exempt, and once at
 * the end-of-run assembly, to decide which bindings to sweep. Those two sites
 * are a thousand lines apart and cannot share one computed value, so they share
 * this — because two independently written window checks are two answers that
 * can disagree about the same record. A run released while its binding is
 * retained is a dangling approval; a binding deleted while its run is pinned is
 * retain-forever wearing a deletion policy.
 *
 * It is NOT the same question `approvalStanding` answers, and must not be
 * mistaken for it. That function decides AUTHORITY — window, fingerprint,
 * producer identity, mark state, all of it — at the single call site the fire
 * decision is read from. This one reads one bound, is consumed by two readers
 * that never fire anything, and is deliberately a hair wider: strictly-less-than
 * rather than the standing's `>=`, so an approval sitting exactly on its
 * closing instant keeps its payload for one more advance. Wider in the
 * retaining direction is the safe error; narrower would delete bytes an
 * authority read still considers.
 *
 * **A zone the host tz database no longer knows RETAINS.** `resolveWallClock`
 * throws on one, and both alternatives to catching it are worse than the edge:
 * letting the throw escape fails the whole advance over a single unparseable
 * record, and treating the throw as "closed" deletes recipient-bound data
 * because the host forgot a timezone. That is not a deletion policy, it is data
 * loss. The conservative answer is the record stays.
 */
function windowClosed(approval: Approval, now: number): boolean {
  try {
    return resolveWallClock(approval.not_after, approval.zone) < now
  } catch {
    return false
  }
}

/**
 * What a content-authorised fire carries forward to the invocation.
 *
 * A pure function of `(state, manifest, now)`: the fingerprint comes from the
 * one entry point, and `fire_instant` is derived from the same `now` the window
 * was resolved against. That is what makes two advances at one injected instant
 * produce an identical decision rather than a nearly identical one.
 */
export interface ContentAuthority {
  producer: string
  fingerprint: string
  effect_id: string
  fire_instant: string
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
  | 'dependency_failed'
  | 'unapproved'

export type EvalResult =
  /**
   * `content` is present exactly when the plugin is due on an operator's
   * content approval rather than on a session grant. It is built from the one
   * standing the scan already computed, never from a second read, and it is
   * what the invocation hands to `witnessAfterGrantRead`.
   */
  | { due: true; content?: ContentAuthority }
  /**
   * `refusal` is present exactly when a content approval EXISTS and does not
   * authorise this fire — never on a session-class plugin, and never on the
   * two standings that are state reports rather than refusals.
   *
   * It rides the not-due arm rather than being recomputed downstream: the
   * orchestrator holding a reason it derived from a second `approvalStanding`
   * call would be a second read of the authority for one fire decision, which
   * is the thing this phase refuses by name. `detail` is the prose for the
   * same fact; this is the machine-readable half.
   */
  | { due: false; reason: NotDueReason; detail: string; refusal?: RefusalReason }

/** Everything `evaluatePlugin` needs that is not the plugin itself. */
export interface EvalContext {
  /**
   * The requested run profile, and the only field that answers "was a profile
   * asked for?".
   *
   * The schedule tier and headless mode are both derived from it where they are
   * read, never carried alongside it. Three separately settable fields could
   * disagree, and a context saying `weekly` beside a tier nobody built would
   * produce a skip naming a profile the run never asked for — the same
   * predicate/prose disagreement the gates below exist to make impossible,
   * displaced one level up.
   *
   * Undefined means no profile was requested, and that is not the same as every
   * schedule passing: a `manual` schedule is excluded in that case too, because
   * it runs only when something asked for it by name.
   */
  profile?: RunProfile
  currentTier: TierName
  force: boolean
  state: EngineState
  /** Already-resolved session approval path — the evaluator does no path defaulting. */
  approvalPath: string
  /**
   * Every manifest this run or preview loaded, by name.
   *
   * REQUIRED, not optional, and the compiler finding every construction site is
   * the point. A content approval names a PRODUCER, and the fingerprint is
   * computed over that producer's manifest — so a context missing the map would
   * leave the producer silently unresolvable and the standing silently wrong,
   * in the conservative direction but for the wrong reason. Optional would make
   * that a runtime surprise instead of a compile error.
   */
  manifests: ReadonlyMap<string, PluginManifest>
  /**
   * Plugins an EARLIER LEVEL of this same preview already found due.
   *
   * Set only by `plan`, which evaluates against a static state document and so
   * cannot see the clearing that a run performs as it goes. `runAdvance` leaves
   * it undefined: its `state.plugin_runs` is mutated by its own level loop and
   * is already the truth, so a projection here would be a second answer to a
   * question the state already answers.
   *
   * Named for what it knows: `dueAtEarlierLevel` does not know the producer
   * will succeed — only that this preview decided the producer runs. A producer
   * that runs and fails again leaves the run skipping a dependent this preview
   * called due, which is the residual disclosed as the fifth entry under
   * docs/runtime-spec.md § "What the dependency gate does not cover".
   */
  dueAtEarlierLevel?: ReadonlySet<string>
}

/**
 * Everything a gate predicate is allowed to read.
 *
 * The three derived values are computed ONCE, before the scan, because more
 * than one entry reads them and because an entry recomputing them would be
 * free to disagree with the entry next door. All three are pure reads over the
 * state snapshot already in hand — no I/O, nothing that can throw on a plugin
 * an earlier gate would have filtered out — so computing them ahead of the
 * gates that used to short-circuit them changes nothing an operator can see.
 */
interface GateInput {
  plugin: string
  manifest: PluginManifest
  ctx: EvalContext
  now: number
  freshness: FreshnessResult
  standing: DenialStanding
  /**
   * Prefix for whatever the operator sees next when a denial has been
   * superseded; empty when there is nothing to say. Produced from the denial
   * standing, consumed by the approval entry's detail — the one value in this
   * chain that travels between two entries.
   */
  supersededNote: string
  /**
   * Where this plugin stands with the approvals record, for a plugin whose
   * declared class consults it, and `none` for every other plugin.
   *
   * Stashed here rather than read inside the entry, on the rule the docstring
   * above states: both the content predicate and the content detail read it,
   * and an entry recomputing it would be free to disagree with itself one line
   * later. It carries the ONE read forward; it does not add one. A second read
   * of the authority is the thing this phase refuses by name.
   */
  contentStanding: ApprovalStanding
}

/**
 * One entry in the declared guard chain: a reason code, the predicate that
 * fires it, and the prose the run log and the preview both render.
 */
export interface Gate {
  reason: NotDueReason
  /** True = the plugin is not due, for this entry's reason. */
  applies: (g: GateInput) => boolean | Promise<boolean>
  detail: (g: GateInput) => string
}

/**
 * The declared dependencies whose LAST RECORDED RUN failed, in the order the
 * manifest declares them.
 *
 * `manifest.dependencies` order and not sorted order, because that is the order
 * the dependency-run projection below already preserves and the order the author
 * wrote; two orderings of the same list is one more place for two answers to
 * disagree.
 *
 * The read is `plugin_runs[d]?.status` and nothing else. There is no second
 * check for "did this dependency legitimately not run": the run record is
 * written only where a run actually happened, so no not-due reason can ever
 * appear in it, and a defensive check would imply a second source of truth for
 * a fact this record already holds alone. Nor is there a roster check for a
 * declared name that is not installed — that would be a second dependency
 * signal, and the case is named in `docs/runtime-spec.md` instead.
 *
 * A name with no entry answers `undefined`, which is not `'failed'`, so a
 * dependency that never ran cannot gate anything. That is also what makes the
 * plain index read safe on an inherited key: `plugin_runs['toString']` answers
 * with a function whose `.status` is `undefined`, and `undefined !== 'failed'`.
 *
 * The second clause is the caller's own projection, and only `plan` supplies
 * one: a dependency this same preview already decided is due is a dependency
 * whose latch this advance is about to overwrite, so reporting its dependent as
 * gated would publish a skip that is not going to happen. The whole `ctx` is
 * taken rather than `ctx.state` because of it — one chokepoint for both the
 * predicate and the detail, so a filtered dependency cannot be dropped from one
 * and named in the other.
 */
/**
 * The content class's half of the approval entry, as a NAMED module-level
 * function rather than a ternary inside the entry's arrow.
 *
 * Not style. The structural guard that pins "the fire decision is reached
 * through exactly one predicate for every approval class" roots its closure
 * walk at named function declarations. Inlined, the legitimate session-grant
 * read and this branch would share one function body, and the
 * function-granularity assertion would be unstatable — the guard would have no
 * root to stand on and no way to say so.
 *
 * The entry APPLIES — the plugin is not due — on everything that is not `live`.
 * `none` included: a plugin declaring the content class with no record has no
 * authority at all, which is the ordinary state of an unapproved batch.
 */
function contentGateApplies(g: GateInput): boolean {
  return g.contentStanding.standing !== 'live'
}

/**
 * The prose for the arm above, one line per standing.
 *
 * **Interpolation is closed by construction.** Declared plugin names, closed
 * enum values, and runtime-derived closed-form values — a hex fingerprint, a
 * hex effect id, an ISO instant the runtime produced. Never the approved bytes,
 * never anything read out of `last_output`, and never a field an operator typed
 * and this runtime merely stored: the window bounds and the zone are all three
 * operator-supplied, and the approvals record on disk is hand-editable besides.
 * These strings reach the run log's summary, the board event and the preview,
 * all of which are read and shared, and this repository has twice paid for an
 * operator-configured value arriving in a result summary.
 *
 * The cost is that a refusal says WHICH bound failed rather than what it was.
 * That is the right way round: the operator can read their own record back with
 * `warpline plan`, and cannot take back a value that has already been shared.
 */
function contentGateDetail(g: GateInput): string {
  const s = g.contentStanding
  switch (s.standing) {
    case 'none':
      return `unapproved: no content approval on file for '${g.plugin}'`
    case 'spent':
      return `unapproved: the content approval was already spent at ${s.approval.confirmed_at}`
    case 'indeterminate':
      return (
        `unapproved: a content fire was marked at ${s.approval.marked_at} and never confirmed, ` +
        'so the runtime cannot tell whether it completed'
      )
    // The window bounds and the zone are OPERATOR-TYPED strings that arrived on
    // a command line and were stored verbatim, so neither may be interpolated
    // here however harmless it looks — the operator can read their own window
    // back with `warpline plan`, and these strings go somewhere they cannot
    // take it back from.
    case 'before_window':
      return 'unapproved: the content approval window has not opened yet'
    case 'outside_window':
      return 'unapproved: the content approval window has closed'
    // The fingerprint is a runtime-derived closed-form value and is safe; the
    // record's `producer` is not. In THIS arm it may be the very name that no
    // longer matches the declared dependency, so it is not a declared plugin
    // name at all, and the arm cannot tell that case from the fingerprint-drift
    // one without a second read.
    case 'content_moved':
      return (
        `unapproved: the approved content has moved — the fingerprint on file ` +
        `(${s.approval.fingerprint}) is no longer what would ship`
      )
    case 'live':
      // Unreachable behind the predicate above; written out so the record
      // narrows and so a future arm cannot land here silently.
      return 'unapproved: content approval is live'
  }
}

/**
 * The machine-readable half of the arm above: which of the three refusals this
 * standing is, or `undefined` when it is not a refusal at all.
 *
 * Three arms map through and four do not. `none` is the ordinary state of an
 * unapproved batch and names no authority that lapsed; `before_window` is the
 * operator's own instruction arriving on time; `spent` is the runtime having
 * already fired those bytes; `live` never reaches a not-due arm at all. A
 * scheduler switching on a reason wants the three where a yes existed and
 * stopped applying, and a state report in that set would have it acting on
 * news that nothing went wrong.
 *
 * Written out arm by arm rather than passing the standing's own tag through
 * the schema's parser: the two vocabularies coincide today by design and the
 * switch is what makes a fourth standing arm a compile error here instead of
 * a silent `undefined` at the sink.
 */
function refusalFor(standing: ApprovalStanding): RefusalReason | undefined {
  switch (standing.standing) {
    case 'indeterminate':
      return 'indeterminate'
    case 'outside_window':
      return 'outside_window'
    case 'content_moved':
      return 'content_moved'
    case 'none':
    case 'before_window':
    case 'spent':
    case 'live':
      return undefined
  }
}

/**
 * Hold the lock beside a NAMED state document, for the length of one
 * read-modify-write.
 *
 * Two regions in this file take it — the mid-run spend mark and the end-of-run
 * write — and they derive the path identically because they derive it HERE. A
 * lock path spelled out at two call sites is two chances for one of them to
 * lock a file it is not writing, which is a lock that reports success and
 * protects nothing.
 *
 * **Strictly sequential, never nested.** The mark's region is released inside
 * the level fan-out, long before the end-of-run write begins. The imported lock
 * is a non-reentrant `O_EXCL` file lock: a nested acquire would block for the
 * state manager's full 10 s ceiling and then throw. Its name is spelled once on
 * the import and once on the call below, and nowhere in prose, because the gate
 * on it counts occurrences of the word.
 */
function lockStateDocument<T>(statePath: string, fn: () => Promise<T>): Promise<T> {
  return withStateLockAt(pathsForStateFile(statePath).lockPath, fn)
}

/**
 * The per-key merge rule for the `approvals` subtree, written out as a table
 * and implemented row for row.
 *
 * Three sentences of prose get implemented three ways; this table does not. The
 * SAME table governs the end-of-run merge at the tail of `runAdvance`, and both
 * writers cite it rather than restating it.
 *
 * | key present          | in-memory state                       | result |
 * |----------------------|---------------------------------------|--------|
 * | on disk only         | —                                     | **keep the disk record** (another attachment approved mid-advance) |
 * | in memory only, marked-unconfirmed | `marked_at` set, `confirmed_at` null | **keep the in-memory record** (never replaced by absence) |
 * | in memory only, unmarked | `marked_at` null                  | **removal wins** (the operator ran `--remove`) |
 * | both, in-memory marked | `marked_at` set                     | **in-memory wins** (the same record, progressed) |
 * | both, in-memory unmarked | `marked_at` null                  | **disk wins** (a fresher operator write) |
 *
 * `marked_at !== null` is the one discriminator, which is what collapses the
 * five rows into two loops. A record carrying `confirmed_at` also carries
 * `marked_at`, so it is preserved by the same arm — losing did-it-ship evidence
 * to a mid-advance removal is the repudiation this rule exists to prevent.
 */
function mergeApprovals(
  disk: EngineState['approvals'],
  memory: EngineState['approvals'],
): EngineState['approvals'] {
  // Rows 1 and 5: the disk record is the floor.
  const merged: EngineState['approvals'] = { ...disk }
  // Rows 2 and 4: a marked in-memory record wins over disk and over absence.
  // Row 3 is what this loop does NOT do — an unmarked in-memory record is
  // skipped, so a removal that landed on disk stays removed.
  for (const [plugin, record] of Object.entries(memory)) {
    if (record.marked_at !== null) merged[plugin] = record
  }
  return merged
}

/**
 * Drop every approval whose fire window has closed, except the did-it-ship
 * evidence.
 *
 * The deletion path the fourth Prohibition requires, stated as one filter. A
 * frozen batch is recipient data: EDPB ¶82 wants its deletion automated and
 * tested rather than left to operator hygiene, and this runs inside every
 * advance.
 *
 * **Two objects, two halves, and only one of them is here.** The PAYLOAD is not
 * in this record — the record holds a hex fingerprint, a producer name, a run id
 * and timestamps, while the bytes live in the producer's run log. That half is
 * closed by `protectedRunIds` releasing the run the moment the window closes,
 * which hands the bytes to ordinary retention. This is the other half: the
 * BINDING, once there is nothing left for it to bind to.
 *
 * **The marked-unconfirmed exception is D-11a, and it is not a leak.** A record
 * with `marked_at` set and `confirmed_at` null is the runtime's account of a
 * fire it began and cannot prove it finished. Deleting it would destroy the
 * did-it-ship evidence for a send that may well have landed — repudiation, not
 * hygiene — and it is safe to keep because the payload went with the run log.
 * The operator resolves it at the sink with the effect id.
 *
 * A CONFIRMED record past its window is dropped, which means the state report
 * naming a spent approval stops being rendered once the window closes. Said out
 * loud here so it reads as a decision rather than as a surprise.
 *
 * **Two ceilings, stated rather than hidden.**
 * `state.plugin_runs[producer].last_output` is NOT deleted by this: it is the
 * producer's own record, preserved across a run that produced nothing and
 * overwritten by the producer's next Output, and deleting it would break a
 * contract this change did not open. And there is still no operator gesture that
 * resolves an `indeterminate` record — so a marked-unconfirmed one survives
 * here indefinitely, by design and for want of a verb.
 */
function sweepExpiredApprovals(
  approvals: EngineState['approvals'],
  now: number,
): EngineState['approvals'] {
  const kept: EngineState['approvals'] = {}
  for (const [plugin, record] of Object.entries(approvals)) {
    const markedUnconfirmed = record.marked_at !== null && record.confirmed_at === null
    if (!windowClosed(record, now) || markedUnconfirmed) kept[plugin] = record
  }
  return kept
}

/**
 * Mark a content approval spent BEFORE its handler is invoked.
 *
 * The only mark-before-effect in this tree besides the run lock. `applied_at`,
 * `plugin_runs` and both example ledgers are mark-after-effect, so without this
 * a crash mid-send is indistinguishable from a send that never happened and the
 * next advance fires again.
 *
 * **Serialisation.** One `O_EXCL` mechanism with a polling acquire serialises
 * two content-class siblings inside one level's `Promise.all` AND another
 * attachment's concurrent `approve --content`. Accepted cost: up to the state
 * manager's 10 s lock timeout per contention, and N sequential round-trips for
 * N content plugins in one level — a shape no shipped fleet has today.
 * **Held per mark, never around the level loop**, which would deadlock: the
 * mark sits inside the fan-out and the end-of-run merge sits after it.
 *
 * **What it persists.** Only the `approvals` subtree, merged onto a fresh read,
 * with the rest of that fresh document untouched. It deliberately does NOT
 * flush the advance's in-memory `state`: `runAdvance` mutates `plugin_runs`
 * throughout the level loop and persists once at the end, and flushing mid-run
 * would make `plugin_runs` durable for a run that has not returned — re-arming
 * the freshness latch for a plugin still in flight, which is the class of
 * misreport the dueness check refuses to create.
 *
 * **The stale-authority window, failed closed.** The gate evaluated the
 * approval without the lock. If, by the time the lock is held and the document
 * re-read, the record is gone or its fingerprint differs, the authority the
 * gate decided on is no longer the authority on disk; if it is already marked,
 * something else is mid-fire on it. Either way: no mark, no invoke, a refusal.
 * This is the mark's own PRECONDITION, in the same shape the run lock's
 * `O_EXCL` acquire is a precondition — not a second read of the authority for
 * the fire decision, which was already made and is not revisited.
 *
 * The BATCH alternative — one pre-fan-out write for every content plugin — is
 * recorded here so it is rejected rather than rediscovered. It is feasible:
 * `topoSort` puts a declared dependency at a strictly earlier level, so a
 * consumer's producer `last_output` is settled before its own level begins. It
 * is refused because it requires deciding the fire question outside the gate
 * chain and again inside it — two answers to a question that is read at exactly
 * one call site.
 *
 * **The durability ceiling, stated once and honestly.** `fs-atomic.ts` provides
 * rename atomicity, NOT power-loss durability — it has no `fsync`. The
 * guarantee here is against PROCESS CRASH. The outcome is not durable until the
 * single end-of-run write, so a crash after a successful send but before that
 * write also reads `indeterminate` on the next advance. That is the
 * conservative and correct reading — the runtime genuinely does not know — and
 * the effect id is the remedy: the operator resolves it at the sink.
 *
 * @returns the refusal to report, or undefined when the mark was taken.
 */
async function markContentApprovalSpent(
  state: EngineState,
  statePath: string,
  eventsPath: string | undefined,
  plugin: string,
  authority: ContentAuthority,
): Promise<RefusalReason | undefined> {
  // The lock that guards THIS document, derived from the path this advance
  // actually writes rather than from the state manager's module globals.
  return lockStateDocument(statePath, async () => {
    // Inside the lock, and it has to be: a read outside it is a read of a
    // document another writer may replace before the write lands.
    // `announceDiscards: false` because the top-of-advance read already
    // announced anything discardable — a second notice mid-run is the same news
    // twice.
    const disk = await readEngineState(statePath, { eventsPath, announceDiscards: false })
    // Own-property, never a bare index: on a plain-object record `approvals`
    // answers `toString` with an inherited member rather than with absence.
    const record = Object.hasOwn(disk.approvals, plugin) ? disk.approvals[plugin] : undefined

    if (record === undefined || record.fingerprint !== authority.fingerprint) return 'content_moved'
    if (record.marked_at !== null) return 'indeterminate'

    // `marked_at` IS the fire instant, and the identity is load-bearing: it is
    // what makes the effect id RECOMPUTABLE from the stored record, so a reader
    // holding `(plugin, fingerprint, marked_at)` can check an id they were
    // handed. It is not a promise that a retry regenerates one — a retry reads
    // the stored id.
    //
    // `confirmed_at` is untouched here. One timestamp cannot express both
    // post-fire states: written before the handler it makes every successful
    // send read indeterminate forever, turning a content-approved plugin into a
    // one-shot; written after, it silently loses the crash case.
    const marked: Approval = {
      ...record,
      marked_at: authority.fire_instant,
      effect_id: authority.effect_id,
    }
    // The in-memory record, replaced rather than mutated field by field, so the
    // end-of-run write carries the mark without a second merge there. The disk
    // copy is the base because it may hold a fresher operator write of the
    // fields this mark does not touch.
    state.approvals[plugin] = marked

    await writeEngineState(
      { ...disk, approvals: mergeApprovals(disk.approvals, state.approvals) },
      statePath,
    )
    return undefined
  })
}

/**
 * The operator string for a mark that could not be taken.
 *
 * Interpolation is closed by construction, on `contentGateDetail`'s rule: a
 * declared plugin name, a closed enum value and a runtime-derived hex
 * fingerprint. Never the window bounds, never the zone, never the record's
 * `producer`, and never anything read out of `last_output` — these strings
 * reach the run log and are read and shared.
 *
 * A separate author from `contentGateDetail` because this is a separate FACT.
 * That function narrates what the GATE decided; this narrates the mark's own
 * precondition failing between the gate and the handler, which is a window the
 * gate never saw.
 */
function markRefusalDetail(reason: RefusalReason, plugin: string, fingerprint: string): string {
  return reason === 'indeterminate'
    ? `refused (indeterminate): the content approval for '${plugin}' was already marked spent ` +
        'before this fire could mark it, so the runtime cannot tell whether that fire completed'
    : `refused (content_moved): the approved content moved between the gate and the spend mark — ` +
        `the fingerprint the gate decided on (${fingerprint}) is no longer the one on file`
}

/**
 * Stamp `confirmed_at` on every record this advance marked and whose handler
 * then returned without failing. The ONE place that field is written.
 *
 * A handler returning `failed` is deliberately absent: its record stays
 * marked-unconfirmed and the mark is NOT cleared. FREEZE-06 forbids a re-fire,
 * and a `failed` return does not prove the sink never received the bytes — the
 * operator resolves it at the sink with the effect id.
 *
 * The marked-record guard is not belt and braces: a confirmation stamped on a
 * record nothing marked would claim a fire the document has no account of.
 */
function confirmContentMarks(
  approvals: EngineState['approvals'],
  confirmed: ReadonlySet<string>,
): EngineState['approvals'] {
  if (confirmed.size === 0) return approvals
  // One instant for the whole advance, so two fires in one run cannot disagree
  // about when the run that confirmed them ended.
  const instant = new Date().toISOString()
  const out: EngineState['approvals'] = { ...approvals }
  for (const plugin of confirmed) {
    const record = out[plugin]
    if (record === undefined || record.marked_at === null) continue
    out[plugin] = { ...record, confirmed_at: instant }
  }
  return out
}

function failedDependencies(manifest: PluginManifest, ctx: EvalContext): string[] {
  return manifest.dependencies.filter(
    (d) => ctx.state.plugin_runs[d]?.status === 'failed' && !ctx.dueAtEarlierLevel?.has(d),
  )
}

/**
 * The guard chain, in the order it is evaluated.
 *
 * This array IS the order. It exists so an operator can read the sequence off
 * one declaration instead of reconstructing it from the longest function in
 * the runtime, and so a proposal for a new gate has a line in a list to argue
 * about rather than a paragraph of control flow. The scan returns on the first
 * entry that fires and evaluates nothing below it, which matters because two
 * of these predicates perform real reads.
 *
 * Not here, deliberately: the dry-run side-effect block. It needs the dry-run
 * flag and the finished verdict, so it lives in the orchestrator and is the
 * last gate before invocation on a dry run. On a real run the last gate is the
 * final entry below, and nothing may be added after it.
 */
export const GATES: readonly Gate[] = [
  // -- Profile tier filter ---------------
  // A requested profile carries a tier of schedules and the plugin is in it or
  // it is not. No profile is the second question, and the answer is not "no
  // filter": `manual` reads as opt-in, and an advance nobody asked for the
  // manual profile is not that opt-in. So the undefined branch excludes that
  // one schedule and admits the other three, and it says so in a detail that
  // names the profile the operator would have to ask for.
  //
  // Both arms switch on `ctx.profile`, the one field that carries the answer,
  // and the tier is looked up here rather than handed in. So the branch that
  // hardcodes 'manual' is reached only when no profile was requested, by
  // construction — it cannot name a profile somebody did ask for.
  {
    reason: 'profile_schedule',
    applies: ({ manifest, ctx }) =>
      ctx.profile !== undefined
        ? !PROFILE_ALLOWED_SCHEDULES[ctx.profile].has(manifest.schedule)
        : manifest.schedule === 'manual',
    detail: ({ manifest, ctx }) =>
      ctx.profile !== undefined
        ? `profile '${ctx.profile}' filter: schedule '${manifest.schedule}' not in tier`
        : `schedule 'manual': requires profile 'manual'`,
  },

  // -- Tier filter: coarser gate than staleness ---------------
  {
    reason: 'min_tier',
    applies: ({ manifest, ctx }) =>
      !isEligibleForTier(manifest.min_tier ?? 'normal', ctx.currentTier),
    detail: ({ manifest, ctx }) =>
      `tier filter: current '${ctx.currentTier}' exceeds plugin min_tier '${manifest.min_tier ?? 'normal'}'`,
  },

  // -- Headless supervised bypass (A2) --
  // Headless is defined as "a profile was requested" (A2), so it is read off
  // `ctx.profile` here rather than carried as a second field that could say
  // otherwise.
  {
    reason: 'headless_supervised',
    applies: ({ manifest, ctx }) =>
      ctx.profile !== undefined && manifest.autonomy_level === 'supervised',
    detail: () => 'headless mode: supervised plugin bypassed (no interactive gate)',
  },

  // -- Manual: always skip --
  {
    reason: 'manual',
    applies: ({ manifest }) => manifest.autonomy_level === 'manual',
    detail: () => 'manual — requires explicit invocation',
  },

  // -- Staleness check: skip if fresh --
  {
    reason: 'fresh',
    applies: ({ freshness }) => freshness.fresh,
    detail: ({ freshness }) => freshness.reason ?? 'fresh',
  },

  // -- Task lock check: active task for this plugin on the board --
  {
    reason: 'task_locked',
    applies: ({ plugin }) => smCheckTaskLock(plugin),
    detail: () => 'task locked — active on board',
  },

  // -- Dependency failed: it ran, and its last run ended failed ------
  // Ordered after the staleness check and after the task lock, and BEFORE both
  // the denial entry and the approval entry. That placement is argued rather
  // than assumed, because it is the one thing about this gate that was chosen
  // against standing advice.
  //
  // AFTER STALENESS. A plugin that is still fresh is not going to read anything
  // this cycle, and "still fresh" is the smaller, older answer; putting this
  // above it would relabel every fresh dependent of a failed producer.
  //
  // AFTER THE TASK LOCK. A task lock is a human holding this plugin open on the
  // board. That answer outranks a statement about the plugin's inputs, and a
  // locked plugin should be reported as locked — the operator already knows why
  // it is not running, and it is not this.
  //
  // BEFORE THE DENIAL. The denial entry below gives the reason in its own
  // comment: a denied plugin is not asked about at all, so it must not first be
  // reported as needing a Grant it does not need. The same sentence applies one
  // step earlier. A plugin that cannot usefully run must not first be reported
  // as STILL DENIED, because the denial answers a proposal this plugin will not
  // be making in this advance. Sitting ahead of the denial also keeps this
  // detail clear of `supersededNote`, which is computed between the denial and
  // the approval entries and would otherwise decorate a dependency-failure
  // message with a paragraph about a returning question nobody asked.
  //
  // BEFORE THE APPROVAL CHECK, AND WHY THE STANDING ADVICE IS WRONG HERE. The
  // standing advice in this project's own notes is to add new gates at the END
  // of the chain, on the grounds that appending cannot reorder what is already
  // there. That advice is wrong for this gate, for the reason the denial arm
  // already gives: a plugin that cannot usefully run must not first be reported
  // as needing a session grant it does not need, and appending would produce
  // exactly that report. The contradiction is deliberate.
  //
  // What makes it safe is that this gate only ever moves a plugin from due to
  // not-due. It admits nothing. It cannot let a side-effecting plugin holding no
  // grant reach a handler, because every path out of it is a skip. The operator
  // sees a different reason; nobody sees a different outcome.
  //
  // Both halves are falsifiable rather than merely argued. The declared order is
  // pinned as a list by `gate-order.test.ts`, which also asserts that the
  // approval entry is still the last gate before invocation on a real run. The
  // pairwise cases in `dependency-failed.test.ts` arm two guards on one plugin
  // at once and read which one the run log names, and the approval pair asserts
  // the outcome as well as the reason: the side-effecting consumer gets no run
  // record and its handler is never entered.
  //
  // What arms it is one status on one existing record, and only that one.
  // `skipped` does not: a plain skip and a `[needs-llm]` handoff lead a consumer
  // to the same action, which is to read the carried-forward Output, and gating
  // on it would break every judgment chain in the repository. `gated` does not:
  // the gated arm writes a real Output, and a level holding a gate stops the
  // advance, so no dependent is evaluated behind it. `partial` does not: the
  // dependency published data and the authoring guide tells consumers to read
  // it. An absent entry does not: a dependency that never ran cannot invalidate
  // anything.
  {
    reason: 'dependency_failed',
    applies: ({ manifest, ctx }) => failedDependencies(manifest, ctx).length > 0,
    // Declared plugin names and one closed enum value. Nothing else may be
    // interpolated here: this string reaches the run log's `result_summary`, the
    // board event and `warpline plan`, all of which are read and shared, and
    // this repository has twice paid for an operator-configured value reaching a
    // result summary. The test asserts it as an exact string rather than a
    // substring, so an appended leak fails.
    //
    // No `skipped: ` prefix, matching the `fresh` arm: the orchestrator adds one
    // for the run log and nothing else does. It used to be written here on the
    // grounds that a prefix added downstream would be a second author for one
    // string — but the second author already exists and is `emitPluginSkipped`,
    // which formats `${plugin}: skipped — ${reason}`, so the prefix here made
    // the board say `skipped` twice about one plugin.
    detail: ({ manifest, ctx }) =>
      `dependency failed — ${failedDependencies(manifest, ctx)
        .map((d) => `'${d}'`)
        .join(', ')} last recorded status 'failed'`,
  },

  // -- Denial: a human already said no to this exact proposal --------
  // Ordered after the task lock and BEFORE the approval gate. A denied plugin
  // is not asked about at all, so it must not first be reported as needing a
  // Grant it does not need.
  //
  // The denial holds only while the fingerprint still matches. When it moves,
  // the answer is stale and the plugin is asked again — but the question is a
  // returning one, and `supersededNote` makes the difference visible rather
  // than letting it reappear looking new.
  {
    reason: 'denied',
    applies: ({ standing }) => standing.standing === 'live',
    // The `none` arm is unreachable behind the predicate above; it is written
    // out so the record narrows to one that has a denial to quote.
    detail: ({ standing }) =>
      standing.standing === 'none'
        ? ''
        : `denied ${standing.denial.denied_at}: ${standing.denial.reason}`,
  },

  // -- Side-effect approval gate ---------------------------------
  // The last gate before invocation on a real run. Nothing goes after it.
  //
  // ONE entry, two authorities, and the branch on the declared class sits ABOVE
  // the grant read rather than beside it. That ordering is the whole mitigation:
  // a content-class plugin does not consult the session grant AT ALL, so a live
  // wildcard cannot compose additively with a frozen batch and render the freeze
  // decorative. The two classes are disjoint by construction here, not merely
  // ordered — which is a stronger property than "both are checked", and the only
  // one that survives someone adding a grant later.
  //
  // A second ENTRY was the refused alternative. The chain's contract is that a
  // gate only moves a plugin from due to not-due; two entries answering one
  // question would be two places authority is read, free to disagree.
  {
    reason: 'unapproved',
    applies: async (g) => {
      const { plugin, manifest, ctx, now } = g
      if (manifest.side_effects.length === 0) return false
      if (manifest.approval_class === 'content') return contentGateApplies(g)
      return !(await checkApproval(plugin, ctx.approvalPath, { now }))
    },
    // No `skipped` in this string, for the reason the `dependency_failed` arm
    // above spells out at length: the detail has a second author downstream.
    // `emitPluginSkipped` formats `${plugin}: skipped — ${reason}`, so the old
    // `skipped (unapproved): ` prefix made the board say `skipped` twice about
    // one plugin — the exact shape 60e9228 fixed for the dependency gate and
    // deferred here. The word survives as `unapproved: ` so the reason stays
    // greppable in `warpline plan` output, which renders `${plugin} — ${detail}`
    // and has no prefix of its own.
    //
    // The run log keeps `skipped (unapproved): ` and names the specific
    // effects; that string is authored at the arm below and is deliberately not
    // this one. `docs/why-the-gate-holds.md` calls it the one-command check.
    // `__tests__/dependency-failed.test.ts` pins the pair on the one event that
    // wrote both, so the two cannot drift apart unnoticed. Editing either string
    // alone reddens there, which is why they are read in one assertion block
    // rather than two files apart.
    detail: (g) =>
      g.manifest.approval_class === 'content'
        ? `${g.supersededNote}${contentGateDetail(g)}`
        : `${g.supersededNote}unapproved: side effects require session approval`,
  },
]

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
  const standing = denialStanding(ctx.state, pluginName, manifest)

  // The ONE read of the content authority, here beside the denial read and for
  // the same reason the block below states: two entries consume it. A
  // `session`-class plugin never reaches this call at all, which is what makes
  // "the approvals record for a non-content-class plugin is never consulted"
  // true by construction rather than by inspection.
  const contentStanding: ApprovalStanding =
    manifest.approval_class === 'content'
      ? approvalStanding(ctx.state, pluginName, ctx.manifests, now)
      : { standing: 'none' }

  /**
   * The cross-entry values, resolved before the scan starts.
   *
   * `supersededNote` is why this block exists rather than living inside the
   * entries that read it: it is produced by the denial check and consumed by
   * the approval check, and a scan has nowhere to put a value that travels
   * between two entries. A returning Ask that says nothing looks like a
   * first-time one, and the operator has no way to tell they already answered
   * it.
   *
   * It keeps saying so until the denial is taken back. That is deliberate: the
   * record is still there, still answering a proposal that no longer exists,
   * and the operator is the only one who can retire it.
   */
  const input: GateInput = {
    plugin: pluginName,
    manifest,
    ctx,
    now,
    freshness: isPluginFresh(pluginName, manifest, ctx.state, { force: ctx.force, now }),
    standing,
    contentStanding,
    supersededNote:
      standing.standing === 'superseded'
        ? `previously denied ${standing.denial.denied_at} ('${standing.denial.reason}') — the ` +
          'proposal has changed since, so this is a returning question, not a new one. '
        : '',
  }

  // Declared order, first match wins. Awaited one at a time on purpose: the
  // later predicates perform real reads, and a gate that already fired must
  // not cause them.
  for (const gate of GATES) {
    if (await gate.applies(input)) {
      const detail = gate.detail(input)
      // The reason travels on the APPROVAL entry only. A content-class plugin
      // held by an earlier gate — still fresh, holding a failed dependency —
      // was not refused by anything, and filing its standing as a refusal
      // there would publish a verdict no gate reached. The standing itself is
      // `none` for every session-class plugin, so that half needs no guard.
      const refusal = gate.reason === 'unapproved' ? refusalFor(contentStanding) : undefined
      return refusal === undefined
        ? { due: false, reason: gate.reason, detail }
        : { due: false, reason: gate.reason, detail, refusal }
    }
  }

  // A content-class plugin that fires is this FALL-THROUGH, never an admit. No
  // entry above returned false-and-therefore-due on its behalf, which is what
  // keeps the chain's contract — a gate only ever moves a plugin from due to
  // not-due — true across the addition.
  //
  // The authority triple is built from the ONE standing local above. Every
  // component is a pure function of `(state, manifest, now)`: the fingerprint
  // comes from the single entry point, and `fire_instant` is derived from the
  // same `now` the window was resolved against — so two evaluations at one
  // instant produce the same verdict, the same fingerprint and the same id.
  if (contentStanding.standing === 'live') {
    const fireInstant = new Date(now).toISOString()
    const fingerprint = contentStanding.approval.fingerprint
    return {
      due: true,
      content: {
        producer: contentStanding.approval.producer,
        fingerprint,
        effect_id: contentEffectId(pluginName, fingerprint, fireInstant),
        fire_instant: fireInstant,
      },
    }
  }

  return { due: true }
}

/**
 * What a dispatch on `NotDueReason` does with a member it has no arm for.
 *
 * The compile error is the point: reached with a value the compiler still
 * thinks is possible, the argument does not type as `never` and the build
 * fails before any test runs. The throw is for the other case — a value
 * arriving from a boundary the compiler never saw — where silence would file
 * the run under whichever arm happened to have no guard.
 */
function assertNever(value: never): never {
  throw new Error(`unhandled not-due reason: ${String(value)}`)
}

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
    logsDir = getDefaultLogsDir(),
    eventsPath,
    preferencesPath,
    approvalPath,
    onPluginStart,
    onPluginEnd,
    onRunFailure,
  } = options

  // The destructure above defaults only `undefined`, so an empty string
  // arrives here unchanged — and `resolve('')` is the current working
  // directory, which reads fine. Left alone, "no plugin root" would silently
  // become "load whatever is in the working directory", or would report a
  // directory that plainly exists as absent. Refused before anything resolves
  // it, with a message of its own so the two cases stay tellable apart.
  if (pluginsDir === '') {
    throw new Error(
      `warpline: plugin root is an empty string\n` +
        `      Cause: an empty path resolves to the current working directory,\n` +
        `             so this would load whatever happens to be there.\n` +
        `      Fix:   pass a real directory as the plugin root, or omit the\n` +
        `             option to use the default at ${getDefaultPluginsDir()}`,
    )
  }

  // Load the plugin manifests FIRST, and refuse a root that cannot be read
  // before anything below writes. State, the run log, the event log and the
  // lock all come after this point, so a refused advance leaves the home
  // byte-identical — there is no half-run to explain and nothing to clean up.
  const { manifests: plugins, failures: loadFailures, root_error } = await loadPluginManifests(pluginsDir)
  if (root_error) {
    throw new Error(
      `warpline: cannot read plugin root ${root_error.path}: ${root_error.code}\n` +
        `      Fix:   pass an existing directory as the plugin root, or create\n` +
        `             the default one at ${getDefaultPluginsDir()}`,
    )
  }
  // The run lock. Acquired HERE — below the plugin-root refusal above, above
  // the state read below — so a refused root still leaves the home
  // byte-identical, while every write this advance makes sits inside the span.
  // Inside the engine and not in the CLI, because a programmatic host has to be
  // guarded too: the benchmark harness calls this function with no options at
  // all under a per-iteration home swap.
  //
  // The release is the single `finally` at the bottom of this function, which
  // closes below the return. That span includes the quiet-hours early return,
  // and it has to: a `try` ending above that arm, or a `finally` starting
  // below it, leaks the lock on the one arm nobody looks at — and a leaked lock
  // refuses every later advance for two hours, reporting "retry later" to a
  // monitor that believes the fleet is merely busy.
  //
  // Two locks, and neither merges into the other. This one and the board's
  // `<state>/.state.lock` are different files with different semantics and
  // different holders. The board's is a non-reentrant O_EXCL lock held around
  // its own read-modify-write of the state document, so this one cannot move
  // down into the state writer without self-deadlocking the moment the board
  // calls it. Holding this one across the state write at the end of this
  // function fixes their acquisition order as advance-first. That is the fact
  // to record; do not add a second lock, and do not read it as a hierarchy the
  // code implements.
  //
  // `'advance'` is a fixed literal. The lock's mode field must never carry
  // anything read off disk or off argv.
  const resolvedLockPath = options.lockPath ?? getDefaultLockPath(options.stateDir)
  const heldLock = await acquireLock(resolvedLockPath, 'advance')

  try {

    // A readable root that produced no manifests is its own outcome, not a
    // clean run over nothing. Computed once, here, above the quiet-hours guard
    // — one condition decides both exits, so there is no arm left where a root
    // that loaded nothing can still report a complete run.
    const noManifestsLoaded = plugins.size === 0
    const emptyRootReason = `no plugin manifests loaded from ${resolve(pluginsDir)}`

    /**
     * The failure hook, called from the two places a run can end non-complete:
     * the quiet-hours early return and the end of the normal path. A hook that
     * throws is reported and swallowed — a host's notifier failing is not the
     * engine failing to report.
     */
    const fireRunFailure = (reason: string): void => {
      if (!onRunFailure) return
      try {
        onRunFailure(reason)
      } catch (hookErr) {
        const msg = hookErr instanceof Error ? hookErr.message : String(hookErr)
        console.error(`[engine] onRunFailure hook threw: ${msg}`)
      }
    }

    /**
     * The dead-man file — `<state>/last-successful-advance`, the whole of this
     * runtime's monitor interface.
     *
     * There is no HTTP surface here and no alerting hook, and a warpline that
     * has stopped cannot alert that it has stopped, so the signal an outside
     * detector reads is this file's own age. `docs/runtime-spec.md` § 13 is the
     * contract; `dead-man.test.ts` holds it.
     *
     * Called from every arm that returns a result — the quiet-hours early
     * return included, because a configured window is hours wide and a detector
     * that had to tolerate a silent night would throw away the resolution a
     * fifteen-minute tick buys. NEVER called on a throw, and deliberately not
     * placed in the release block below: a held lock, a missing home or an
     * unreadable state document is exactly when the LAST good file, left
     * standing and going stale, is the thing the operator needs to see.
     *
     * The counts come from `advanceCounts`, the walk the exit code itself uses.
     * Two counters computed in two places is how this file and the monitor
     * reading it start disagreeing about one advance.
     *
     * Nothing else goes in this document. A run id, a timestamp, the advance's
     * own status, a reason token and four integers — no plugin summary, no
     * plugin output, no operator configuration value, no path. The key set is
     * enumerated by a test so that adding a field is a deliberate act.
     *
     * `refused` is the COUNT and never the reasons. The structured reasons a
     * content refusal carries are plugin-derived, and a list of them here would
     * be exactly the free-text channel the paragraph above refuses. A consumer
     * that wants them reads `warpline advance --json`.
     */
    const writeDeadMan = async (
      outcome: AdvanceOutcome,
      fields: { run_id: string; status: AdvanceResult['status']; skipped_reason: string | null; pruned: number },
    ): Promise<void> => {
      const { gated, failed, refused } = advanceCounts(outcome)
      await atomicWriteText(
        options.stateDir === undefined
          ? defaultDeadManPath()
          : join(dirname(options.stateDir), 'last-successful-advance'),
        JSON.stringify(
          {
            run_id: fields.run_id,
            completed_at: new Date().toISOString(),
            // The advance's own status, NOT the exit code. They answer
            // different questions: a gated advance is `partial` here and `0`
            // there, and conflating them reads a held gate as a failure.
            status: fields.status,
            skipped_reason: fields.skipped_reason,
            gated,
            failed,
            refused,
            pruned: fields.pruned,
          },
          null,
          2,
        ) + '\n',
      )
    }

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
      // stderr, not stdout: the output stream is the document. `warpline
      // advance --json` emits one JSON object there and a monitor outside this
      // repository parses it, so a diagnostic above that object is a parse
      // failure nobody can patch from here — and quiet hours is a NORMAL arm,
      // so it would arrive on an ordinary scheduled night. The same argument
      // the plan command makes about its own cycle report.
      process.stderr.write('[engine] Quiet hours active — skipping run\n')
      // The zero-manifest verdict is the same on this path as on the normal
      // one. A skipped cycle over a root that loaded nothing is still a root
      // that loaded nothing, and a carve-out here would be a quiet hour in
      // which the one status worth reporting stops being reported. A root that
      // DID load manifests is unaffected: it still reports a complete skip and
      // still hands back an empty run-log path.
      // Two conditions, in the same precedence the normal path uses: a root that
      // loaded NOTHING is `failed`, a root that loaded something but not all of
      // it is `partial`, and only a root that loaded cleanly is `complete`. The
      // zero-manifest half was hoisted above this guard when it was written; the
      // load-failure half was not, so the two arms disagreed on the same root —
      // `partial` awake and `complete` asleep — against the spec's own statement
      // that the skip reports the status a normal advance would. No plugin runs
      // on this path, so load failures are the only way to be partial here.
      const quietStatus: AdvanceResult['status'] = noManifestsLoaded
        ? 'failed'
        : loadFailures.length > 0
          ? 'partial'
          : 'complete'
      await emitRunCompleted(run_id, quietStatus, eventsPath)
      // This arm sits above the failure-hook block at the end of the function,
      // so without this call the hook would never fire here and the contract
      // stated on the option would be false the day it was written.
      //
      // Fired for `partial` too, not only `failed`. The end-of-path block fires
      // on ANY non-complete status, so hooking only the zero-manifest case would
      // leave the two arms disagreeing about whether the host hears — the same
      // asymmetry the status fix above just closed, one layer down. Reason shape
      // matches that block's, so a host cannot tell which arm produced it.
      if (quietStatus !== 'complete') {
        const failed = loadFailures.map((f) => f.plugin)
        fireRunFailure(
          failed.length > 0
            ? `run ${quietStatus}: ${failed.length} plugin(s) failed [${failed.join(', ')}]`
            : `run ${quietStatus}: ${emptyRootReason}`,
        )
      }
      // The states map, seeded exactly as the normal path seeds it — the two
      // loops below the guard, with one literal changed. A skip is what
      // happened to every manifest that loaded, and a manifest that never
      // loaded is `failed` here for the same reason it is `failed` there.
      //
      // This arm used to hand back a fresh empty map whatever the root held,
      // and an empty map is not a neutral value: `exit-codes.ts` reads it as
      // the zero-manifest signature and nothing else, which is what lets a
      // gated advance exit `0`. So a fleet with a configured quiet window
      // reported "no manifests loaded" on every tick until morning — under a
      // fifteen-minute timer, dozens of false failures a night. The fix
      // belongs here rather than in the mapper: the invariant is that an
      // empty map means one thing on every arm, and a quiet-hours carve-out
      // inside the mapper would trade that invariant for a special case in
      // the one function the command and the suite share.
      const quietStates = new Map<string, PluginFsmState | 'skipped'>()
      for (const [name] of plugins) {
        quietStates.set(name, 'skipped')
      }
      for (const failure of loadFailures) {
        quietStates.set(failure.plugin, 'failed')
      }
      // `pruned: 0` and it is honest: the prune runs below this guard, so a
      // skipped advance reclaims nothing. Nothing looked, so nothing went.
      await writeDeadMan(
        // Nothing was evaluated, so nothing was refused — the same honesty
        // `pruned: 0` makes below, and the same empty array this arm returns.
        { plugin_states: quietStates, gated_plugins: [], refused_plugins: [] },
        { run_id, status: quietStatus, skipped_reason: 'quiet_hours', pruned: 0 },
      )
      return {
        run_id,
        status: quietStatus,
        plugin_states: quietStates,
        gated_plugins: [],
        // Nothing was evaluated, so nothing was refused. Empty because the
        // question was never asked, which is the same honesty `pruned: 0` makes
        // one line below.
        refused_plugins: [],
        run_log_path: '',
        pruned: 0,
      }
    }

    // Guardrail: review_gate — if enabled, treat all autonomous plugins as supervised
    const reviewGateActive = prefs.review_gate

    // 3. Prune old run logs.
    //
    // At the TOP of the advance, and it stays here. A consumer reads the run-log
    // path off disk AFTER the advance returns, so a byte eviction at the end of
    // an advance with a small budget would delete the log that consumer needs.
    // Accepted cost: an advance is bounded by what it inherited, not by what it
    // is about to write.
    //
    // The protected set is the pending gates' run ids and the runs an OPEN
    // content approval still names. A `last_output` pointer and a stored last
    // run id are documented to dangle by design; treating either as protective
    // would be retain-forever by accident. Built from the state already read
    // above rather than from a second read.
    //
    // The approval arm is the second kind of held record `pruneRunLogs`'s own
    // docstring anticipated — "a later release adds a second kind of held
    // record and joins the same set by the same mechanism" — so
    // `run-log-store.ts` is unchanged: its parameter is already a
    // `ReadonlySet<string>`, and dedup is free because it is a `Set`, which is
    // why an id named by both a gate and an approval is protected once.
    //
    // **Only while the window is OPEN**, which is the deletion path the fourth
    // Prohibition requires. A frozen batch is recipient data and its bytes live
    // in the producer's run log; a set that never releases would pin them
    // forever. Releasing on close hands them straight back to ordinary
    // retention — already running, already tested, no new mechanism — and the
    // binding itself is swept at the end-of-run assembly below.
    //
    // **`windowClosed` and not a second window comparison**, and the two sites
    // are far enough apart that the sharing has to be the FUNCTION rather than
    // a computed value: this runs before the level loop and the sweep runs
    // after it. `approvalNow` is what keeps them from disagreeing about the
    // instant as well as about the rule — one clock read, both readers.
    //
    // **This is a CONSUMER of the record, not a second read of the authority
    // for the fire decision.** R2's Acceptance names this set among the readers
    // that "consume the record and never decide whether to fire", beside R8's
    // merge and R11's carve-out. A protected set admits nothing; the widest
    // thing it can do is keep a file on disk.
    //
    // `run_id` is nullable: an Output that carried none came from a run the
    // store cannot name, and null protects nothing rather than protecting
    // everything.
    const approvalNow = options.now ?? Date.now()
    const protectedRunIds = new Set(state.pending_gates.map((gate) => gate.run_id))
    for (const approval of Object.values(state.approvals)) {
      if (approval.run_id !== null && !windowClosed(approval, approvalNow)) {
        protectedRunIds.add(approval.run_id)
      }
    }

    // Held rather than discarded. The count reaches this advance's result and
    // its dead-man file below, and the machine-readable output renders it from
    // the result. A bare call is how a count stops being threaded.
    const prunedRunLogs = await pruneRunLogs(runsDir, prefs.retention, protectedRunIds)

    // 3a. The headless JSONL run log.
    //
    // Constructed HERE, below the plugin-root refusal near the top of this
    // function and below the quiet-hours early return. The two arms are no
    // longer the same promise, and this comment used to say they were. The
    // plugin-root refusal leaves the home byte-identical; the quiet-hours arm
    // deliberately does not, because it writes the run-completed event into
    // `events.jsonl` and the dead-man file. What it does NOT write is a run
    // log, and that is the property this placement keeps: a skipped advance
    // leaves no record of a run that did not happen. Constructing the logger is
    // itself write-free — `appendEvent` is what creates the directory — but
    // placing it after both arms means the ordering does not depend on that
    // remaining true.
    //
    // The window comes from the operator's policy rather than a literal here.
    // This is the third record warpline keeps of a run, alongside the per-plugin
    // run artifact and the engine's own run log, and three formats pruned on
    // three literals is three retention rules that agree until somebody tunes
    // one.
    const runLogger = new JsonlRunLogger({ logsDir, runId: run_id })
    await runLogger.prune(prefs.retention.days)
    await runLogger.appendEvent({ level: 'info', event: 'run_start' })

    // 3b. Emit run_started event
    await emitRunStarted(run_id, eventsPath)

    // 5. Topological sort over the manifests loaded at the top of this function.
    //    (Step 4 was the load; it now happens above every write.)
    const levels = topoSort(plugins)

    // 6. Per-plugin FSM state
    const plugin_states = new Map<string, PluginFsmState | 'skipped'>()
    for (const [name] of plugins) {
      plugin_states.set(name, 'pending')
    }

    const gated_plugins: string[] = []
    /**
     * Filled from the approval arm below, from the reason the evaluator already
     * carried out. Nothing here re-reads the approvals record to build it.
     */
    const refused_plugins: AdvanceResult['refused_plugins'] = []
    /**
     * The content-authorised fires this advance MARKED and whose handler then
     * returned without failing. Read once, at the end-of-run assembly, which is
     * where `confirmed_at` is written and the only place it is.
     */
    const confirmedContentFires = new Set<string>()
    /**
     * The gates parked by this advance, assembled inside the gated arm where the
     * plugin's real `SkillResult` is still in scope.
     */
    const parked_gates: PendingGate[] = []
    const plugin_entries: RunLog['plugin_entries'] = []

    // Seeded BEFORE the overall-status block below, and the ordering is the
    // point: that block promotes complete to partial when any plugin is
    // recorded failed, so an all-fail root reports failed only because failed
    // is already in hand when it runs. Reverse the two and "the root produced
    // nothing" becomes "some plugins failed" — the conflation this exists to
    // remove.
    let engineStatus: AdvanceResult['status'] = noManifestsLoaded ? 'failed' : 'complete'
    let stopped = false

    // 6b. Evaluation context shared by every plugin in this run. The
    // approval path is resolved once here so the evaluator does no defaulting.
    // `profile` alone: headless mode (A2) and the schedule tier are both derived
    // from it inside the gates, so this run and a `warpline plan` preview cannot
    // reach the gates carrying different answers to the same question.
    const evalCtx: EvalContext = {
      profile,
      currentTier,
      force,
      state,
      approvalPath: approvalPath ?? sessionApprovalPath(),
      // The map this advance already loaded. A content approval names a
      // producer, and the fingerprint is computed over that producer's
      // manifest.
      manifests: plugins,
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
          const ev = await evaluatePlugin(pluginName, manifest, evalCtx, options.now ?? entryStart)

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
          // One arm per reason code, dispatched so the compiler owns the
          // completeness of the set. The arms differ only in their run-log prose,
          // which is a run-log concern and stays here rather than travelling in
          // the evaluator's structured reason.
          //
          // A `switch` and not a chain of `if`/`return`, because the chain's last
          // block had no guard: every reason without an arm of its own fell into
          // it and was recorded as an approval-gate skip, naming session approval
          // and side effects on a plugin that may declare neither. The `default`
          // arm below is what a chain cannot have — a place the compiler checks.
          if (!ev.due) {
            plugin_states.set(pluginName, 'skipped')

            // Narrowed through a local: a `switch` over a `const` of a literal
            // union narrows the `default` arm to `never` reliably, which is the
            // whole mechanism here.
            const reason = ev.reason

            switch (reason) {
              // -- Profile tier filter, tier filter, headless supervised bypass
              //    (A2), manual, task lock --
              // Five reasons, one arm: they differ only in the detail string the
              // evaluator already produced, and five copies of the same six lines
              // hid that the differences below are the real ones.
              case 'profile_schedule':
              case 'min_tier':
              case 'headless_supervised':
              case 'manual':
              case 'task_locked': {
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
              case 'fresh': {
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

              // -- Dependency failed: it ran, it failed, and this plugin would
              //    otherwise read what it left behind on an earlier cycle --
              // The run log's prefix is added HERE, exactly as the freshness arm
              // above adds it, and the evaluator's detail stays bare. The board
              // event takes that bare detail and formats its own
              // `${plugin}: skipped — ${reason}`, so one `skipped` reaches an
              // operator instead of two.
              //
              // The second not-due arm to call the progress end hook, and the
              // reason is the approval gate's reason: a dependency failure is
              // actionable in the way a missing Grant is actionable and unlike
              // "still fresh", so the operator watching a long advance gets a line
              // for the plugin they were waiting on instead of silence.
              //
              // Not the older rationale, which does not survive a read of source:
              // that the plan-versus-run harness keys its attempted-set off the
              // end hook. It keys off `onPluginStart` only (`plan.test.ts`,
              // `attemptedByRun`), and a gated plugin is correctly outside the
              // attempted set either way, because this arm returns before the
              // start hook fires.
              //
              // No `plugin_runs` write, for the reason spelled out on the denial
              // arm below: `runAdvance` has exactly three write sites for that
              // record and this is not a fourth. A write here would move
              // `last_run_at` for a plugin that never ran, re-arm the freshness
              // latch against a run that did not happen, and make a plugin that
              // never ran indistinguishable from one that ran and produced
              // nothing — which is the exact confusion this gate exists to end.
              case 'dependency_failed': {
                const dependencyFailedElapsed = Date.now() - entryStart
                plugin_entries.push({
                  plugin: pluginName,
                  status: 'skipped',
                  started_at: entryStartedAt,
                  elapsed_ms: dependencyFailedElapsed,
                  result_summary: `skipped: ${ev.detail}`,
                  retried: false,
                })
                await emitPluginSkipped(pluginName, ev.detail, run_id, eventsPath)
                onPluginEnd?.(pluginName, 'skipped', dependencyFailedElapsed, 'dependency failed')
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
              // exactly three write sites for that record — the catch around
              // `invokePlugin`, the gated arm and the autonomous arm, all below —
              // and neither this arm nor the dependency-failed one above is a
              // fourth. (`applyPendingGate`
              // holds the only other one, plus the delete in its discard closure;
              // both are outside this function and answer a parked gate rather than
              // an advance.)
              case 'denied': {
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
              // Guarded now, where it used to be the block everything unmatched
              // fell into, which is why it must never inherit another reason's
              // run: it ends the progress hook, and it is one of the two not-due
              // arms that do — the dependency-failed arm above is the other, on
              // the same argument that an actionable skip earns the operator a
              // line where "still fresh" does not.
              //
              // TWO CLASSES, and the split is deliberate. A `session`-class
              // plugin is held for want of a Grant, and the run log names the
              // specific effects it would have performed — authored here, as it
              // has been. A `content`-class one is held by an approvals record,
              // and every operator string on that path has ONE author,
              // `contentGateDetail`, whose output arrives as `ev.detail` and is
              // used verbatim. A second author here is the `skipped` twice trap:
              // two strings for one fact, free to disagree.
              //
              // The branch reads `manifest.approval_class` — a manifest read,
              // not an authority read — so `approvalStanding` still has exactly
              // one caller.
              case 'unapproved': {
                const unapprovedElapsed = Date.now() - entryStart
                const contentClass = manifest.approval_class === 'content'
                // `ev.refusal` is set only where a content approval existed and
                // stopped applying — so it is already `undefined` for every
                // session-class plugin, for a content-class one with no record
                // on file, and for a window that has not opened. One guard, and
                // no second test of the same fact.
                // The RUN-LOG status, which has six members. Not the FSM
                // state: `plugin_states.set(pluginName, 'skipped')` above this
                // switch is what a refused plugin's FSM entry is, and it stays
                // that way — R4 adds no `PluginFsmState` member.
                const entryStatus = ev.refusal === undefined ? 'skipped' : 'refused'
                if (ev.refusal !== undefined) {
                  refused_plugins.push({ plugin: pluginName, reason: ev.refusal })
                }
                plugin_entries.push({
                  plugin: pluginName,
                  status: entryStatus,
                  started_at: entryStartedAt,
                  elapsed_ms: unapprovedElapsed,
                  result_summary: contentClass
                    ? ev.detail
                    : `skipped (unapproved): side effects [${manifest.side_effects.join(', ')}] require session approval`,
                  reason: ev.refusal,
                  retried: false,
                })
                // The non-refusal cases keep the skip: no record on file, and a
                // window that has not opened, genuinely ARE skips. Only an
                // authority that existed and stopped applying is news of a
                // different kind.
                //
                // The emitter authors its own summary from the plugin name and
                // the closed enum value. `ev.detail` is deliberately not passed:
                // one persisted string, one author.
                await (ev.refusal === undefined
                  ? emitPluginSkipped(pluginName, ev.detail, run_id, eventsPath)
                  : emitPluginRefused(pluginName, ev.refusal, run_id, eventsPath))
                // The FSM state, per this hook's contract — and a refusal
                // leaves it at `skipped`. Passing the run-log status here would
                // put a sixth value through an exported interface documented to
                // carry the FSM's, which is the member R4 declines to add,
                // arriving by the back door. The REASON is where the two
                // classes differ, and it keeps one author per class.
                onPluginEnd?.(
                  pluginName,
                  'skipped',
                  unapprovedElapsed,
                  contentClass ? ev.detail : 'unapproved side effects',
                )
                return
              }

              default:
                assertNever(reason)
            }
          }

          // -- Set FSM to running --
          plugin_states.set(pluginName, 'running')

          // -- The spend mark ------------------------------------------------
          // Below the dry-run block above — which no dry run reaches for a
          // side-effecting plugin, and `approval_class: 'content'` requires at
          // least one declared side effect at `.parse()` time, so no
          // content-class manifest slips past it — and above `invokePlugin`.
          // Above `onPluginStart` and `emitPluginStarted` as well, so a
          // fail-closed refusal never publishes a start that did not happen.
          //
          // It fires only when the widened due arm carries a content
          // authority, so nothing happens for any other plugin. The whole
          // rationale — serialisation, the merge rule, the stale-authority
          // window and the durability ceiling — is on
          // `markContentApprovalSpent`, in one copy.
          if (ev.content !== undefined) {
            const markRefusal = await markContentApprovalSpent(
              state,
              stateDir,
              eventsPath,
              pluginName,
              ev.content,
            )
            if (markRefusal !== undefined) {
              // The FSM state, not the run-log status: a refusal leaves it at
              // `skipped`, exactly as the approval gate's own refusal arm does.
              plugin_states.set(pluginName, 'skipped')
              const markElapsed = Date.now() - entryStart
              const markDetail = markRefusalDetail(
                markRefusal,
                pluginName,
                ev.content.fingerprint,
              )
              refused_plugins.push({ plugin: pluginName, reason: markRefusal })
              plugin_entries.push({
                plugin: pluginName,
                status: 'refused',
                started_at: entryStartedAt,
                elapsed_ms: markElapsed,
                result_summary: markDetail,
                reason: markRefusal,
                retried: false,
              })
              // The emitter authors its own summary from the plugin name and
              // the closed enum value; `markDetail` is deliberately not passed.
              // One persisted string, one author.
              await emitPluginRefused(pluginName, markRefusal, run_id, eventsPath)
              onPluginEnd?.(pluginName, 'skipped', markElapsed, markDetail)
              return
            }
          }

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
            //
            // The Grant was read ONCE, by the dueness check above, and the
            // witness carries that answer forward instead of asking again. Why
            // that is sound, and why the arms are what they are, is on
            // `witnessAfterGrantRead` — one copy, because two copies of an
            // argument drift and the copy that drifts is the one nobody reads.
            const witness = witnessAfterGrantRead(pluginName, manifest.side_effects, ev.content)

            // What each DECLARED dependency last produced and how its last run
            // ended, projected HERE and not from the state read at the top of the
            // advance. `plugin_runs` is mutated by each level's own writes below,
            // and level ordering is what puts a level-0 producer's write before a
            // level-1 consumer's invocation. A projection hoisted out of this
            // closure is a snapshot taken before any producer ran: the consumer
            // would read nothing on every advance while every test handing a
            // literal stayed green.
            //
            // Declared names only, so the record never carries a key the
            // consumer's manifest does not list. `null` for a name with no entry
            // at all; within an entry, `last_output` is ABSENT rather than null
            // for a run that produced none, which the member's `?? null` covers.
            //
            // ONE projection for both facts. Two would be two reads of a map this
            // loop mutates, and the one that drifted would be the one nobody
            // read — the same failure the paragraph above describes for a hoisted
            // snapshot. `DependencyRun` is a `Pick` of exactly the two fields the
            // two members expose: this is the boundary where a field is chosen
            // for exposure to a different plugin, and widening it is what the
            // leak test watches for.
            const dependencyRuns = Object.fromEntries(
              manifest.dependencies.map((d): [string, DependencyRun | null] => {
                const run = state.plugin_runs[d]
                return [
                  d,
                  run
                    ? {
                        status: run.status,
                        // A COPY, and the copy is the point. The record lives in
                        // `state.plugin_runs`, `writeEngineState` persists that
                        // map unvalidated at the end of the advance, and
                        // `capabilities.ts` hands whatever is here straight to
                        // the handler. Passing the live object made a consumer's
                        // in-place edit — `rec.body = JSON.stringify(patched)` is
                        // the obvious shape — the engine's persisted state: a
                        // body over the 16 KiB `OutputRecordSchema` cap bricks
                        // every later fail-closed read, and because
                        // `proposalFingerprint` hashes this field, the edit moves
                        // the PRODUCER's fingerprint and re-arms side effects an
                        // operator already denied. `status` needs no copy; it is
                        // a string.
                        last_output:
                          run.last_output === undefined
                            ? undefined
                            : structuredClone(run.last_output),
                      }
                    : null,
                ]
              }),
            )

            invocationResult = await invokePlugin(
              pluginName,
              {},
              { pluginsDir, runId: run_id, dependencyRuns },
              witness,
            )
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
            // The run happened and it ended failed, so it is recorded like any
            // other. Returning here without this write left the PREVIOUS run's
            // entry in place, and `lastRun` answered with it — "how its last run
            // ended" naming a run two advances back. `failed` is right for every
            // path in, not just the invocation: the try also covers
            // `witnessAfterGrantRead` and the dependency projection, and a throw
            // out of either is as much a failed run as one out of `invokePlugin`.
            // Note what does NOT arrive here — a handler that throws is caught
            // inside `invokePlugin` and comes back as a `failed` result, which
            // the autonomous write below handles; the reachable `invokePlugin`
            // case is `loadPluginConfig` rethrowing a non-`PluginConfigError`.
            //
            // `lastOutputOf` takes the same carry-forward as the other three
            // write sites: this run produced nothing, and an Output is a fact
            // about the plugin rather than about its latest run.
            const priorThrownEntry = state.plugin_runs[pluginName]
            state.plugin_runs[pluginName] = {
              last_run_at: new Date().toISOString(),
              status: 'failed',
              duration_ms: failedElapsed,
              ...lastOutputOf(null, priorThrownEntry),
            }
            await emitPluginFailed(pluginName, errMsg, run_id, eventsPath)
            onPluginEnd?.(pluginName, 'failed', failedElapsed, errMsg)
            return
          }

          const { result, retried } = invocationResult

          // -- Supervised: gate (unless dry-run) --
          // review_gate forces autonomous plugins to be treated as supervised
          //
          // EXCEPT a content-class plugin, and the exemption is not a
          // convenience. A content approval IS the review — the operator read
          // the exact bytes and said yes before they shipped, rather than after
          // — so promoting one asks the same human the same question twice.
          // And because a parked gate stops the level loop below, a plugin that
          // fires on an approval and then parks would halt the fleet behind
          // itself on every advance, for a review that already happened.
          //
          // What makes it safe to exempt is the manifest's own cross-field
          // rule: a content-class manifest is validated `autonomous` at
          // `.parse()` time, which is a hard stop at import. So this arm cannot
          // be reached by a `supervised` plugin sneaking past the review gate —
          // such a manifest does not load at all.
          const effectiveAutonomy =
            reviewGateActive &&
            manifest.autonomy_level === 'autonomous' &&
            manifest.approval_class !== 'content'
              ? 'supervised'
              : manifest.autonomy_level
          if (effectiveAutonomy === 'supervised') {
            if (dryRun) {
              // Dry-run: report "would pause here" and continue. On stderr like
              // the quiet-hours line above, even though `advance` cannot reach
              // this arm — a dry-run flag on that verb is refused by name. A
              // source guard that allows one exception is a guard with a hole.
              process.stderr.write(
                `[engine] would pause here for supervised plugin: ${pluginName}\n`,
              )
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
              // Read before the overwrite, or the carry-forward has nothing to
              // carry. There may be no entry yet — a plugin's first run.
              const priorGatedEntry = state.plugin_runs[pluginName]
              state.plugin_runs[pluginName] = {
                last_run_at: completedAt,
                status: 'gated',
                duration_ms: Date.now() - entryStart,
                // last_output: written here as well as on the autonomous path. A
                // gated run produced its Outputs before the gate saw them — and
                // a gated run that produced none leaves the plugin's prior Output
                // where it was.
                ...lastOutputOf(result, priorGatedEntry),
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
          // A content-authorised fire whose handler RETURNED. Recorded here and
          // stamped at the end-of-run write; `failed` is excluded deliberately,
          // which leaves its record marked-unconfirmed rather than clearing the
          // mark — see `confirmContentMarks`.
          if (finalStatus === 'completed' && ev.content !== undefined) {
            confirmedContentFires.add(pluginName)
          }
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
          // Read before the overwrite, or the carry-forward has nothing to carry.
          const priorAutonomousEntry = state.plugin_runs[pluginName]
          state.plugin_runs[pluginName] = {
            last_run_at: new Date().toISOString(),
            // The plugin's own terminal status, carried through rather than
            // narrowed. `skipped` is the one that used to be lost: it is every
            // dispatched `[needs-llm]` handoff, and the `else` arm folded it to
            // `success`. That was internal until `lastRun` published the field —
            // after which a consumer following the four-state table read
            // "produced, and its latest run is healthy" for a producer that had
            // handed its work to an LLM and produced nothing, beside a
            // carried-forward record that made the claim look corroborated.
            // `PluginRunSchema` has always admitted `skipped`; only this mapping
            // refused to emit it.
            //
            // Deliberately NOT `delegated`: that value belongs to
            // `deriveRunStatus`, which feeds the RunArtifact and the board events
            // and answers a different question. A plain `skipped` and a handoff
            // lead a consumer to the same action — read the carried-forward
            // Output, do not treat it as a failure — so a second value here would
            // be a distinction nothing acts on. Widen if a caller ever needs to
            // tell them apart.
            status:
              result.status === 'failed'
                ? 'failed'
                : result.status === 'partial'
                  ? 'partial'
                  : result.status === 'skipped'
                    ? 'skipped'
                    : 'success',
            duration_ms: Date.now() - entryStart,
            // last_output: this run's Output when it produced one, the plugin's
            // prior Output when it did not, and absent — not null — when there
            // has never been one.
            ...lastOutputOf(result, priorAutonomousEntry),
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

    // A manifest that never imported gets a row AND a state entry. The row is
    // what tells an all-fail root apart from an empty one on the artifact; the
    // state entry is what lets the overall-status computation below see it at
    // all, because that map is seeded from the manifests that loaded. The row
    // on its own would leave a mixed root reporting a complete run over a log
    // carrying failure rows.
    //
    // Placed here rather than beside the seeding above, so the level loop —
    // built from the loaded manifests only — never gets the chance to look up a
    // name that never loaded. The loader's error text goes in unchanged: the
    // module-resolution detail is the only part an operator can act on.
    for (const failure of loadFailures) {
      plugin_entries.push({
        plugin: failure.plugin,
        status: 'failed',
        started_at,
        elapsed_ms: 0,
        result_summary: `manifest did not load: ${failure.error}`,
        retried: false,
      })
      plugin_states.set(failure.plugin, 'failed')
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
      // Migrate-on-write, and the ONLY site there is.
      //
      // The spread above carries `schema_version` straight through from the
      // read, so without this line a v1 document read by a v2 build is written
      // back as v1 and the home never advances — there was no migration site
      // at all, only a constant that nothing stamped.
      //
      // Here rather than in `writeEngineState`: that helper is also how the
      // board writes state, on four paths that never read the home version, so
      // migration there would stamp a layout version nothing had validated.
      // The advance is the one writer that read both versions on the way in.
      schema_version: ENGINE_STATE_MAX_SCHEMA_VERSION,
      // `confirmed_at` is written HERE and nowhere else — the second half of
      // the two-field mark, and the reason the mark is two fields rather than
      // one. Everything about which fires are in the set, and why a `failed`
      // return is not, is on `confirmContentMarks`.
      approvals: confirmContentMarks(state.approvals, confirmedContentFires),
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
    // **An UNAPPLIED gate survives too, under the same ceiling.** It did not,
    // and the split was never chosen: markers lived a full ceiling while a
    // parked result lived zero advances, so a daily engine destroyed Monday's
    // proposal on Tuesday morning before anyone could review it. The ceiling
    // itself was unreachable in live operation — a limit the spec states and
    // only seeded-clock tests could ever observe.
    //
    // One rule for the whole array now: a gate survives while it is younger than
    // the ceiling and has not been superseded by a fresh gate for its plugin.
    // The clock differs because the question does — a marker ages from when the
    // result was ACCEPTED, a parked gate from when the run PRODUCED it, which is
    // the clock `applyPendingGate` already expires against.
    //
    // A gate missing `run_completed_at` does not survive. Such a gate is refused
    // at apply time anyway ("carries no record of when its run happened"), so
    // keeping it would only park something that can never be answered.
    const gateFloorMs = Date.now() - GATE_MAX_AGE_MS
    const survivors = state.pending_gates.filter((g) => {
      if (parked_gates.some((p) => p.plugin === g.plugin)) return false
      const clock = g.applied_at ?? g.run_completed_at
      return clock !== null && new Date(clock).getTime() > gateFloorMs
    })
    ;(updatedState as Record<string, unknown>)['pending_gates'] = [
      ...survivors,
      ...parked_gates,
    ]

    // The single end-of-run write, and the second of this file's two locked
    // regions — sequential with the spend mark's, never nested (see
    // `lockStateDocument`).
    //
    // Everything except `approvals` is still the advance's own in-memory state,
    // spread above: this closes the read-modify-write window of #25 for that ONE
    // subtree and leaves the general case — `plugin_runs`, `pending_gates`,
    // `last_run_id` — open, which is where `engine-state-store.ts` files it.
    // Widening it here would be a second control-flow change wearing the same
    // commit.
    //
    // `approvals` is the subtree that needs it because it is the only one
    // another ATTACHMENT writes. One home can be attached from several machines,
    // so an `approve --content` lands at an instant this process cannot predict,
    // and the window it lands in is as wide as the run — hours, in the shape
    // this runtime is built for. The rule applied per key is the five-row table
    // on `mergeApprovals`, the same one the mid-run mark implements; two prose
    // statements of one rule is how two writers come to disagree.
    //
    // The re-read is INSIDE the lock, and it has to be: a read outside it is a
    // read of a document a concurrent writer may replace before this write
    // lands, which would reintroduce the window one layer down.
    // `announceDiscards: false` because the top-of-advance read already
    // announced anything discardable.
    //
    // **The expiry sweep runs AFTER the merge, and the order is deliberate.**
    // `mergeApprovals` begins from `{ ...disk }` — the disk record is the floor,
    // because another attachment's approval must not be erased by a snapshot
    // taken before it existed. So a key swept out of the in-memory subtree
    // BEFORE the merge is put straight back by that spread: it is on disk, this
    // process is not claiming otherwise, and the floor wins. Sweeping the merged
    // result is what actually deletes the binding, and it is also the more
    // correct answer: an expired record another attachment wrote mid-advance is
    // expired too, and there is no reason this advance should be the one that
    // preserves it.
    //
    // It cannot destroy the mark, which is the one thing this ordering had to be
    // checked against. `confirmContentMarks` ran above, on the in-memory
    // subtree; a record it stamped is marked, and the merge's marked arm carries
    // it over disk. The sweep then drops it only if its window has ALSO closed,
    // and a record confirmed inside this advance is a record whose window was
    // open when the fire was authorised.
    await lockStateDocument(stateDir, async () => {
      const disk = await readEngineState(stateDir, { eventsPath, announceDiscards: false })
      updatedState.approvals = sweepExpiredApprovals(
        mergeApprovals(disk.approvals, updatedState.approvals),
        approvalNow,
      )
      await writeEngineState(updatedState as EngineState, stateDir)
      // The home's layout version, stamped beside the document it describes and
      // inside the same lock, so the two halves of the migration cannot land
      // apart. `stateDir` is the state FILE path, so its grandparent is the home
      // root — the same derivation the read uses, and never `warplineHome()`,
      // which under a `stateDir` override would stamp the live operator home.
      // The trailing newline is the format's: the reader trims exactly one.
      await atomicWriteText(
        join(dirname(dirname(stateDir)), 'version'),
        `${ENGINE_STATE_MAX_SCHEMA_VERSION}\n`,
      )
    })

    // 9. Write run log
    const completed_at = new Date().toISOString()
    const runLog: RunLog = {
      run_id,
      started_at,
      completed_at,
      // The artifact carries the engine's own status, unmapped. Folding
      // everything that was neither complete nor partial into interrupted
      // recorded an empty root as a killed run — and the verdict is read from
      // this file, not from the value the caller happened to receive.
      status: engineStatus,
      resumed_from: null,
      summary: `Engine run ${run_id}: ${plugin_entries.length} plugins processed`,
      plugin_entries,
      // What the loader FOUND, not what the loop got through. The level loop
      // breaks when a level gates, so later levels' plugins load and never push
      // an entry — deriving this from `plugin_entries.length` would under-report
      // on this runtime's ordinary path.
      manifests_loaded: plugins.size,
    }

    await mkdir(runsDir, { recursive: true })
    const run_log_path = await writeRunLog(runLog, runsDir)

    // 9b. The same run, as JSONL lines.
    //
    // Read off `plugin_entries` after the level loop rather than emitted from
    // each of the eight arms that push one. The arms already agree on what a
    // plugin's outcome was; a second emission site per arm is eight chances for
    // the two records of one advance to disagree.
    for (const entry of runLog.plugin_entries) {
      await runLogger.appendEvent({
        level: entry.status === 'failed' ? 'error' : 'info',
        event: 'plugin_result',
        plugin: entry.plugin,
        status: entry.status,
        elapsed_ms: entry.elapsed_ms,
        detail: entry.result_summary,
      })
    }
    await runLogger.appendEvent({
      level: engineStatus === 'complete' ? 'info' : 'warn',
      event: 'run_end',
      status: engineStatus,
      detail: runLog.summary,
    })

    // 10. Emit run_completed event
    await emitRunCompleted(run_id, engineStatus, eventsPath)

    // 11. Fire onRunFailure exactly once if the run did not complete cleanly.
    // 'partial' covers any failed or gated plugin, 'failed' a root that loaded
    // no manifests, 'interrupted' a non-terminating stop. The success path does
    // not invoke the hook.
    if (engineStatus !== 'complete') {
      const failedPlugins = Array.from(plugin_states.entries())
        .filter(([, s]) => s === 'failed')
        .map(([name]) => name)
      // An empty root has no failed plugin to name, and saying the engine did
      // not complete cleanly tells an operator nothing about an empty
      // directory. Name the root instead.
      const reason =
        failedPlugins.length > 0
          ? `run ${engineStatus}: ${failedPlugins.length} plugin(s) failed [${failedPlugins.join(', ')}]`
          : noManifestsLoaded
            ? `run ${engineStatus}: ${emptyRootReason}`
            : `run ${engineStatus}: engine did not complete cleanly`
      fireRunFailure(reason)
    }

    // 12. The dead-man file, last and inside the lock.
    //
    // After the run-log write above, which is what makes a detector that finds
    // this file certain the log it names already exists. Before the release
    // below, so two advances cannot interleave writes to it. Not in the release
    // block: a throw must leave the previous file standing.
    await writeDeadMan(
      { plugin_states, gated_plugins, refused_plugins },
      { run_id, status: engineStatus, skipped_reason: null, pruned: prunedRunLogs },
    )

    return {
      run_id,
      status: engineStatus,
      plugin_states,
      gated_plugins,
      refused_plugins,
      run_log_path,
      pruned: prunedRunLogs,
    }
  } finally {
    // By run id, so this release cannot remove a lock this advance no longer
    // holds — an advance whose own lock aged past the TTL is healed and
    // reacquired by the next tick, and an unconditional unlink here deleted
    // that one on the way out.
    await releaseLock(resolvedLockPath, heldLock.run_id)
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
  /**
   * Set when the plugin root itself could not be listed — absent, not a
   * directory, or unreadable. Distinct from `failures`, which is per-plugin: a
   * root that cannot be read has no plugins to attribute a failure to, and an
   * empty map is otherwise indistinguishable from a root with nothing in it.
   *
   * Reported rather than thrown. `warpline plan` renders the loader's result
   * without failing, and a preview that started throwing on a home with no
   * plugins directory would be a worse answer than the one it gives today.
   * `runAdvance` applies the stricter policy and rejects.
   */
  root_error?: { path: string; code: string }
}> {
  const { readdir, stat } = await import('node:fs/promises')
  const plugins = new Map<string, PluginManifest>()
  const failures: LoadFailure[] = []

  let entries: string[]
  try {
    // `withFileTypes` is load-bearing, not a tidy-up. A plugin is a DIRECTORY
    // holding a manifest, so a plain `readdir` hands back stray files too and
    // each one becomes an `<entry>/manifest.ts` import that can only fail.
    // That was invisible while `runAdvance` discarded `failures`; it stopped
    // being invisible the moment a load failure started setting
    // `plugin_states` and flipping the run to `partial`. A `.DS_Store` — which
    // appears in any plugin root a macOS operator has opened in Finder — would
    // otherwise mean every advance reports `partial` forever and calls
    // `onRunFailure` on every run.
    //
    // Non-directories are dropped, NOT reported as failures: a file in the
    // root was never a plugin, so there is nothing to attribute a failure to.
    // A directory that holds no manifest still fails loudly, because that IS a
    // misconfiguration an operator can act on — a `Manifest.ts` misname or a
    // half-finished scaffold. The distinction is the whole fix: filtering on
    // "has a manifest" instead would silence both.
    // A SYMLINK to a plugin directory is a directory for this purpose. Dirent
    // reports the link itself, so `isDirectory()` is false for one and a bare
    // `isDirectory()` filter would silently drop a plugin that loaded fine
    // before — a developer symlinking a plugin under development into the root
    // is the ordinary case. `stat` follows the link; a broken link or one
    // pointing at a file throws or reports non-directory and is dropped with
    // the other non-directories.
    const dirents = await readdir(pluginsDir, { withFileTypes: true })
    const named = await Promise.all(
      dirents.map(async (d) => {
        if (d.isDirectory()) return d.name
        if (!d.isSymbolicLink()) return null
        try {
          return (await stat(join(pluginsDir, d.name))).isDirectory() ? d.name : null
        } catch {
          return null
        }
      }),
    )
    entries = named.filter((n): n is string => n !== null)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN'
    return { manifests: plugins, failures, root_error: { path: resolve(pluginsDir), code } }
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
 * read 23 hours. That one bounds how long side-effect AUTHORITY lives; this one
 * bounds how long an OBSERVED OUTCOME stays acceptable. Sharing the constant
 * would tie two clocks that answer different questions, and the first time one
 * needs to move the other would move with it silently.
 *
 * 23 rather than 24 for the same reason the grant ceiling is: on a daily
 * cadence a 24-hour window expires exactly as the next advance runs, so whether
 * a parked result is still reviewable depends on scheduler jitter. At 23 the
 * operator gets one whole daily cycle to answer, and a result they did not
 * answer is definitively stale before the next one is parked.
 */
export const GATE_MAX_AGE_MS = 23 * 60 * 60 * 1000

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
 *
 * `opts.manifests` is required rather than optional, and the whole `opts`
 * default is gone with it. The discard's carve-out below asks
 * `approvalStanding` whether an outstanding content approval is bound to this
 * plugin's bytes, and that question cannot be answered from `manifest` alone —
 * the record names a PRODUCER, whose manifest is what the fingerprint is
 * computed over. A defaulted empty map would answer "no approval" for every
 * caller that forgot one, which is the destructive direction: the delete would
 * go ahead and the binding would be gone permanently. A required parameter
 * makes that omission a compile error instead of a silent data loss.
 */
export async function applyPendingGate(
  state: EngineState,
  gate: PendingGate,
  manifest: PluginManifest,
  opts: {
    statePath: string
    manifests: ReadonlyMap<string, PluginManifest>
    eventsPath?: string
    now?: number
  },
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
    // The `plugin_runs` delete is what makes the plugin due again: its parked
    // result was computed against inputs that have moved, so it should re-run.
    //
    // **Not while a denial is live.** `proposalFingerprint` reads that entry's
    // Output, so deleting it moves the fingerprint the denial was bound to; the
    // answer stops matching, and the plugin runs again on the next advance,
    // re-firing the side effects the operator said no to. Silently, under a live
    // Grant — the superseded-denial note only rides the `unapproved` arm, which
    // a denied plugin never reaches.
    //
    // The delete is also pointless in exactly that case. A denied plugin does
    // not run, so making it due achieves nothing; the only thing the delete
    // accomplishes is breaking the binding.
    //
    // Leaving the entry in place is the structural fix, and it is what the
    // earlier re-fingerprint compensated for. That one re-bound the denial to
    // `hash(plugin, side_effects, [])`, which nothing can move — the plugin is
    // suppressed before the approval gate, so it can never produce a new Output
    // — making the denial permanent by name. Keeping the entry means the denial
    // stays bound to the REAL proposal and lapses on its own if the plugin ever
    // genuinely re-runs with a different Output, which is what a
    // proposal-bound answer is supposed to do.
    //
    // Structural rather than guarded, deliberately. The re-fingerprint was
    // unreachable from the CLI once `approve` began refusing on a live denial,
    // so it protected nothing a caller could reach while still being the thing
    // a future second caller would depend on. This holds wherever
    // `applyPendingGate` is called from.
    //
    // A superseded denial does not protect the entry: it is already stale, and
    // the plugin being due again is the correct outcome.
    //
    // **The delete takes `last_output` with it, and that loss is permanent.**
    // The Output pointer lives inside the entry, so deleting the entry deletes
    // it. The three write sites carry a plugin's prior Output forward across a
    // run that produced none, and they do it by reading the entry that is about
    // to be overwritten — after this delete there is no entry to read, so the
    // key comes back only from a FRESH Output on a later advance. The destroyed
    // record itself never returns. An advance that again produces nothing
    // leaves the plugin reading as having run and never produced, which is
    // exactly the misreport the carry-forward exists to stop, reached through a
    // second door.
    //
    // The bound is on the TRIGGER, not on the loss. This path fires only on
    // `dependency_moved` or `expired`, and the delete is already skipped while
    // a denial is live. The plugin being due again is a re-run OPPORTUNITY and
    // not a repair: writing that the loss is bounded to one advance would be a
    // false claim in this docstring.
    //
    // The delete stands anyway, because the entry is what makes the plugin due
    // and dueness is the whole point of the refusal. The change that would
    // remove the residual is structural rather than local: lifting
    // `last_output` out of `plugin_runs` into a sibling top-level key, so an
    // Output's lifetime stops being bound to a run record's. That is a change
    // to a published schema shape with a migration for every state file on
    // disk, and it is not made here.
    const standing = denialStanding(state, gate.plugin, manifest)

    // **Not while a live content approval is bound to it either**, and on the
    // identical argument the denial arm above makes at length. An approval is a
    // standing yes to SPECIFIC BYTES, and those bytes are
    // `plugin_runs[producer].last_output`. Delete that entry and the
    // fingerprint the operator's yes was bound to can never be recomputed: the
    // record survives, matches nothing, and the answer becomes unhonourable —
    // permanently, because the destroyed Output never returns. The two
    // carve-outs are joined by an `or` rather than one replacing the other, so
    // a plugin with no approval reaches exactly the behaviour it reached
    // before.
    //
    // The reference runs BOTH WAYS, which is why this is a scan and not a
    // lookup. `approvals` is keyed by the CONSUMER, and the bytes belong to the
    // PRODUCER — so the plugin whose gate is being discarded is protected when
    // it is named as either. The producer case is the one the delete actually
    // destroys; the consumer case is included because a consumer's own entry is
    // what the next advance's freshness latch reads.
    //
    // **This is a CONSUMER of the record, not a second read of the authority
    // for the fire decision.** R2's Acceptance says it in those words: other
    // readers — R8's merge, this carve-out, R15's protected set — "consume the
    // record and never decide whether to fire". Authority for the fire decision
    // is read at exactly one call site, and it is not this one. Nothing here
    // admits anything; every path out of it is a skipped delete.
    //
    // `approvalStanding` rather than a hand-rolled window-and-fingerprint
    // predicate, for the reason the denial lookup is a function too: a
    // re-derived predicate is a second answer that can disagree with the first.
    const approvalHolds = Object.entries(state.approvals).some(
      ([consumer, approval]) =>
        (consumer === gate.plugin || approval.producer === gate.plugin) &&
        approvalStanding(state, consumer, opts.manifests, now).standing === 'live',
    )

    state.pending_gates = state.pending_gates.filter((g) => g !== gate)
    if (standing.standing !== 'live' && !approvalHolds) {
      delete state.plugin_runs[gate.plugin]
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
  //
  // The prior entry read here is the `gated` one this same run wrote, so a
  // gated run that produced no Output has already had the plugin's prior Output
  // carried through the park — this site reads what is there and carries it one
  // step further, rather than reconstructing it.
  const priorApprovedEntry = state.plugin_runs[gate.plugin]
  state.plugin_runs[gate.plugin] = {
    last_run_at: completedAt,
    status: gate.plugin_result.status,
    duration_ms: Math.max(0, new Date(completedAt).getTime() - startedMs),
    ...lastOutputOf(gate.plugin_result, priorApprovedEntry),
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
 * The run's own most recent Output when it produced one, otherwise whatever the
 * entry being overwritten already held, otherwise nothing.
 *
 * **Why the carry-forward.** `last_output` is a fact about the PLUGIN — "the
 * most recent Output this plugin produced", as `PluginRunSchema` defines it in
 * `schemas/engine-state.ts` — and not a fact about its last run. It only lives
 * inside the run entry because that is where the pointer was put. So a run that
 * produced no Output has said nothing about what the plugin produced, and a
 * write that dropped the key was answering a question it had not been asked.
 * The same schema comment already argues this for the pruned-log case: deleting
 * the pointer to avoid a dangling `run_id` would throw away the only record
 * that the Output existed. An Output-less run is that argument's other half.
 *
 * **Status-blind, deliberately.** What survives is keyed on the run producing
 * nothing, never on how the run ended. A throw, a returned `failed`, and a
 * SUCCESS carrying an empty `artifacts_produced` are one case here. Gating the
 * carry-forward on `failed` would make the field mean a fourth thing — "the
 * last Output, unless the plugin last succeeded without producing one" — which
 * no reader could state and none of the three writers agree on.
 *
 * **This is the lifetime of the seam.** `dependencyRuns` above projects this
 * key straight into a declared consumer's `capabilities.dependencies`, so how
 * long it survives here is exactly how long a consumer can read its producer.
 * A consumer that reads `null` from `lastOutput` concludes the producer has
 * never produced. That conclusion is now sound because of the carry-forward
 * below, and a consumer that needs to know how the producer's LAST run went
 * asks `lastRun` for it instead of inferring health from this field.
 *
 * Returns an EMPTY object when there is nothing to write, so the key is absent
 * from the JSON rather than present as `null` or `{}` — a reader should not
 * have to tell an unproductive run from a malformed pointer. That contract is
 * unchanged: a plugin that has never produced still carries no key at all.
 *
 * "Most recent" is the last element: `artifacts_produced` is written in the
 * order the handler produced them.
 */
function lastOutputOf(
  result: SkillResult | null,
  prior: PluginRun | undefined,
): { last_output?: OutputRecord } {
  // `null` is the third caller: an invocation that threw has no result at all,
  // which is the strongest form of "this run produced nothing" and takes the
  // carry-forward for the same reason the other two do. Widened here rather
  // than inlined at that site, so all three writers keep sharing one rule.
  const last = result?.artifacts_produced.at(-1)
  if (last !== undefined) return { last_output: last }
  const carried = prior?.last_output
  return carried === undefined ? {} : { last_output: carried }
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

function getDefaultLogsDir(): string {
  return join(warplineHome(), 'logs')
}

/**
 * Where the run lock lives, decided at call time and never at import time.
 *
 * `AdvanceOptions.stateDir` is the full path to the state FILE, so its
 * directory IS the state directory, and the lock lands beside
 * `engine-state.json` — the same derivation the preferences path uses higher up
 * for the same reason. A relocated home keeps its own lock.
 *
 * A module-load-time constant here would freeze whichever home was resolved
 * when this module was first imported. The benchmark harness swaps the home per
 * iteration and calls the advance with no options at all, so a frozen default
 * would put one iteration's lock in another iteration's home and let two
 * advances both acquire — the one failure the lock exists to prevent.
 */
function getDefaultLockPath(stateFilePath?: string): string {
  return stateFilePath === undefined
    ? defaultLockPath()
    : join(dirname(stateFilePath), '.lock')
}
