/**
 * Engine state — the single JSON document the engine persists between runs.
 *
 * Deliberately narrow: only fields the engine itself reads or writes. Anything
 * application-specific belongs to the host, which hangs it off the explicit
 * `extensions` records rather than widening this schema. Core fields stay
 * strict, so a typo'd one still fails validation loudly.
 */
import { z } from 'zod'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { OutputRecordSchema, SkillResultSchema } from './skill-result.js'

// ── Task-board records ────────────────────────────────────────────────────

export const DeferralSchema = z.object({
  task_id: z.string(),
  reason: z.string(),
  deferred_at: z.string(),
  expires_at: z.string(),
})
export type Deferral = z.infer<typeof DeferralSchema>

export const TaskAgingSchema = z.object({
  task_id: z.string(),
  first_flagged: z.string(),
  description: z.string(),
  severity: z.enum(['critical', 'warning', 'info']),
  run_count: z.number().default(1),
  /**
   * Consecutive runs in which this task's source check ran clean without
   * re-flagging it. Gates resolution of recheck-resolved task types behind a
   * confirmation window instead of resolving on one clean run. Reset to 0 on
   * re-flag.
   */
  clean_streak: z.number().default(0),
  last_detail: z.string().default(''),
  /** The action-signal type that produced this task. */
  source_check: z.string().default(''),
  /**
   * The check that produced this task. Distinct from `source_check` (the
   * signal *type*): resolution matches this against the run's checks-ran set,
   * since two checks can share a type. Legacy tasks without it fall back to
   * `source_check` during resolution.
   */
  origin_check: z.string().optional(),
  /**
   * The run that first raised this task, and the most recent run to re-flag it.
   * An Ask links the latter — it answers "which advance is telling me this
   * now", where `first_run_id` answers "how long has this been true".
   *
   * A run that raises a task and re-flags it in the same advance writes the
   * same id into both. That is the ordinary first-advance case, not a
   * corruption to reject.
   *
   * Nullable with a default for the same read-compat reason as
   * `BoardEventSchema.run_id`: task_aging entries written before run linkage
   * existed carry neither field, and the engine's own state document must not
   * fail validation over it.
   */
  first_run_id: z.string().nullable().default(null),
  last_flagged_run_id: z.string().nullable().default(null),
  action_type: z.enum(['guided', 'self_directed']).default('self_directed'),
  /** Tasks with null due_date are NEVER classified as overdue. */
  due_date: z.string().nullable().default(null),
  /** Soft-archive timestamp (suspended tier). Archived tasks are hidden, recoverable. */
  archived_at: z.string().optional(),
  /** Host extension bag — calendar mirrors, reply-tracking, sync opt-outs, … */
  extensions: z.record(z.string(), z.unknown()).default({}),
})
export type TaskAging = z.infer<typeof TaskAgingSchema>

/** Tasks move here on completion — preserves the audit trail. */
export const CompletedTaskSchema = z.object({
  task_id: z.string(),
  description: z.string(),
  severity: z.enum(['critical', 'warning', 'info']),
  source_check: z.string().default(''),
  completed_at: z.string(),
  extensions: z.record(z.string(), z.unknown()).default({}),
})
export type CompletedTask = z.infer<typeof CompletedTaskSchema>

export const TaskStateEnum = z.enum(['pending', 'active', 'completed', 'deferred'])
export type TaskState = z.infer<typeof TaskStateEnum>

export const TaskDisplaySchema = TaskAgingSchema.extend({
  state: TaskStateEnum,
  deferred_until: z.string().nullable().default(null),
  age_badge: z.string(),
  created_at: z.string(), // mapped from first_flagged
})
export type TaskDisplay = z.infer<typeof TaskDisplaySchema>

// ── Engine bookkeeping ────────────────────────────────────────────────────

/**
 * Per-plugin run tracking entry, keyed by plugin name. Drives TTL staleness
 * checks.
 *
 * `gated` records that a supervised plugin ran and was parked. It IS a run —
 * the handler executed and its declared side effects fired before the
 * supervision gate ever saw the result — so it belongs here for exactly the
 * reason the other four do. `isPluginFresh` reads only `last_run_at`, never
 * `status`, so adding the member changes no staleness arithmetic.
 *
 * Same vocabulary as the sibling `PluginLogEntrySchema.status` in
 * `run-log.ts` and as `PluginFsmState`. Not `partial`: that is what the
 * pending-gate stub already fabricates, and conflating the two is the thing
 * this phase exists to stop.
 */
export const PluginRunSchema = z.object({
  last_run_at: z.string(),
  status: z.enum(['success', 'partial', 'failed', 'skipped', 'gated']),
  duration_ms: z.number().int().optional(),
  /**
   * The most recent Output this plugin produced, so the Board can name it
   * without scanning the runs directory. The same record shape a `SkillResult`
   * carries — not a second one that could disagree with it.
   *
   * `.optional()` rather than `.nullable()`: an absent optional is omitted by
   * Zod and dropped by `JSON.stringify`, so a plugin that produced nothing
   * carries no key at all rather than a `null` or an empty object a reader
   * would have to interpret.
   *
   * The `run_id` inside it may name a run log that has been pruned — logs go
   * at 30 days by mtime. That is a dangling pointer by design: it resolves to
   * not-retained, and deleting the pointer to avoid the case would throw away
   * the only record that the Output existed.
   */
  last_output: OutputRecordSchema.optional(),
})
export type PluginRun = z.infer<typeof PluginRunSchema>

/**
 * A supervised plugin's result parked pending human approval of its side
 * effects.
 *
 * `plugin_result` is the REAL result the handler returned, Outputs and all.
 * Earlier builds fabricated it — `status: 'partial'`, an empty
 * `artifacts_produced` — and the thing the plugin actually produced was
 * dropped. Approval is acceptance of an observed outcome, so a gate that does
 * not carry the outcome cannot be approved in any meaningful sense.
 */
export const PendingGateSchema = z.object({
  plugin: z.string(),
  run_id: z.string(),
  created_at: z.string(),
  payload_summary: z.string(),
  plugin_result: SkillResultSchema,
  /**
   * When the gated run STARTED. The dependency-staleness refusal compares each
   * dependency's `last_run_at` against this: a dependency that moved after the
   * gated run began means the parked result was computed against inputs that
   * have since changed.
   *
   * Nullable with a null default, following `TaskAgingSchema.first_run_id` —
   * a gate written by an earlier build carries neither clock, and the engine's own
   * state document must not fail validation over it. **Null here is not a
   * missing field to backfill: it is the marker of a gate this build refuses
   * to apply.** See {@link isStubGate}. That is a deliberate data drop, the
   * only one in this phase — a pre-Phase-8 gate has no real result to migrate,
   * so there is nothing to carry forward and applying it would record an
   * outcome the plugin never produced.
   */
  run_started_at: z.string().nullable().default(null),
  /**
   * When the gated run ENDED. Two things anchor on it: gate expiry counts from
   * here, and on apply `plugin_runs.last_run_at` is set to it rather than to
   * the time the operator said yes. A later approval is a separate event and
   * must not retroactively move when the work happened.
   *
   * It is written from the same string as the `plugin_runs` entry the engine
   * writes on the same branch, not from a second `new Date()` — the two must
   * not disagree by a millisecond.
   */
  run_completed_at: z.string().nullable().default(null),
  /**
   * When this gate was applied, or null while it is still live.
   *
   * The gate is marked rather than deleted so a second `warpline approve` sees
   * an already-applied gate and refuses. Deleting it would leave no gate to
   * find, and the verb would fall through to merging a Grant — writing the one
   * file an outcome approval must never touch.
   */
  applied_at: z.string().nullable().default(null),
})
export type PendingGate = z.infer<typeof PendingGateSchema>

/**
 * Is this a gate written by an older build — a fabricated partial with no real
 * result behind it?
 *
 * The discriminator is the clock fields, because they are the fields a
 * pre-Phase-8 build could not have written and a gate this build writes always
 * has. Discriminating on `status === 'partial'` instead would misfire on a
 * genuine partial result, which is a real outcome a plugin may return.
 *
 * A named predicate rather than an inline filter so the recogniser is testable
 * on its own, in both directions.
 */
export function isStubGate(gate: PendingGate): boolean {
  return gate.run_started_at === null || gate.run_completed_at === null
}

/**
 * The newest schema version this build understands. A file at or below it
 * loads; one above it is refused by `readStateFile`, with a reason that says
 * the build is behind rather than that the file is broken.
 */
export const ENGINE_STATE_MAX_SCHEMA_VERSION = 1

/**
 * `.catchall(z.unknown())` is on this object so unknown top-level keys survive
 * a read-then-write round trip instead of being stripped — rolling back to an
 * older build must not silently delete the fields a newer one wrote.
 *
 * The accepted cost, recorded so it is not a surprise later: a typo'd
 * top-level key — `plugin_run` for `plugin_runs` — now round-trips silently
 * where it used to fail validation loudly. The named fields are still strict,
 * so the typo surfaces as a missing value rather than as a rejected file.
 */
export const EngineStateSchema = z.object({
  /**
   * Read tolerantly on purpose: an older build must still load a file it
   * wrote, and a version it has never heard of is a separate, explicit check
   * in `readStateFile` rather than a validation failure. A non-integer or
   * negative value is not a version at all, so it fails here and lands on the
   * ordinary invalid-content refusal.
   */
  schema_version: z.number().int().nonnegative().default(1),
  last_run_id: z.string().nullable().default(null),
  last_run_at: z.string().nullable().default(null),
  /**
   * Last time the engine was invoked (interactive or headless). Drives the
   * degradation tier; null on fresh install → tier 'normal'.
   */
  last_interaction_at: z.string().nullable().default(null),
  plugin_runs: z.record(z.string(), PluginRunSchema).default({}),
  deferrals: z.array(DeferralSchema).default([]),
  task_aging: z.array(TaskAgingSchema).default([]),
  completed_tasks: z.array(CompletedTaskSchema).default([]),
  pending_gates: z.array(PendingGateSchema).default([]),
  /** Host extension bag for anything the engine itself does not read. */
  extensions: z.record(z.string(), z.unknown()).default({}),
}).catchall(z.unknown())
export type EngineState = z.infer<typeof EngineStateSchema>

export function defaultEngineState(): EngineState {
  return EngineStateSchema.parse({ schema_version: 1 })
}

// ── Persistence ───────────────────────────────────────────────────────────

/**
 * Raised when a state document exists but cannot be used. Carries the `path`
 * and the `reason` separately so a caller can surface either without
 * re-parsing the message.
 *
 * `name` is assigned the literal in the constructor and that is load-bearing:
 * it is how `src/cli/warpline.ts` catches this without importing this module.
 * Both that dispatcher and `src/bin/warpline.ts` forbid static imports — the
 * whole point is that `--help` never loads zod — so the catch is duck-typed on
 * the name. Renaming the class without renaming the string breaks the mapping
 * silently.
 */
export class EngineStateInvalidError extends Error {
  readonly path: string
  readonly reason: string

  constructor(path: string, reason: string) {
    super(`engine state at ${path} is unusable: ${reason}`)
    this.name = 'EngineStateInvalidError'
    this.path = path
    this.reason = reason
  }
}

/** What a read does with a document it cannot validate. */
type ReadPolicy = 'fail-closed' | 'tolerant'

/**
 * The one read implementation. `policy` decides what an unusable document
 * does; both public entry points route through here so the two cannot drift by
 * a comparison.
 *
 * `fail-closed` throws and touches nothing. That is the whole point: the read
 * used to return `defaultEngineState()`, and the next engine write persisted
 * that reset over the operator's `task_aging`, `deferrals` and
 * `completed_tasks`. A file we cannot read is a file we must not overwrite.
 *
 * `tolerant` returns defaults, for the read-only callers that are contracted
 * never to fail — `warpline plan` above all. It writes nothing either.
 *
 * Nothing here copies the file aside any more. The old `{path}.corrupt` backup
 * was a write on a read path, and it only existed to preserve evidence before
 * defaults destroyed it; failing closed preserves the original in place.
 *
 * A missing file is not an unusable one: ENOENT yields defaults under both
 * policies, so a fresh install still works.
 */
async function readStateFile(
  statePath: string,
  policy: ReadPolicy,
  eventsPath?: string,
): Promise<EngineState> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(statePath, 'utf-8'))
  } catch (err: unknown) {
    const isNotFound = err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT'
    if (isNotFound) return defaultEngineState()
    if (policy === 'tolerant') return defaultEngineState()
    throw new EngineStateInvalidError(statePath, err instanceof Error ? err.message : String(err))
  }

  const result = EngineStateSchema.safeParse(parsed)
  if (!result.success) {
    if (policy === 'tolerant') return defaultEngineState()
    throw new EngineStateInvalidError(statePath, describeIssues(result.error))
  }

  // Checked after a successful parse, not inside the schema: a version we have
  // never heard of is a different problem from a broken document, and the
  // operator's fix is different too. Refusing it is what stops an older build
  // from round-tripping a newer file down to the fields it happens to know.
  if (result.data.schema_version > ENGINE_STATE_MAX_SCHEMA_VERSION) {
    if (policy === 'tolerant') return defaultEngineState()
    throw new EngineStateInvalidError(
      statePath,
      `schema_version ${result.data.schema_version} is newer than this build understands ` +
        `(highest known: ${ENGINE_STATE_MAX_SCHEMA_VERSION}) — your build is older than this file, ` +
        `so upgrade warpline rather than letting this build rewrite it`,
    )
  }

  return discardStubGates(result.data, policy, eventsPath)
}

/**
 * Throw away any pre-Phase-8 parked gate, naming the plugin in the event log.
 *
 * A stub gate carries a fabricated status and no Outputs, so applying it
 * would record an outcome the plugin never produced. There is nothing to
 * migrate — the real result was never written — so the only honest thing to do
 * is drop it and say so.
 *
 * **The notice is emitted on the write-capable read only.** The tolerant read
 * still discards, silently. `warpline plan` is contracted to write nothing at
 * all, and `plan-prohibition.test.ts` snapshots the entire warpline home to
 * prove it — an append to `events.jsonl` from a read path fails that test as
 * loudly as a state rewrite, and rightly so. `withoutStateBackups` forces the
 * tolerant policy across `plan`'s indirect reads too, so this one comparison
 * covers every path it reaches.
 *
 * Emission is awaited, not fired and forgotten: a caller that reads the event
 * log straight after the state read must see the notice. It is still
 * best-effort — a log that cannot be written must not stop a state read.
 */
async function discardStubGates(
  state: EngineState,
  policy: ReadPolicy,
  eventsPath?: string,
): Promise<EngineState> {
  const stubs = state.pending_gates.filter(isStubGate)
  if (stubs.length === 0) return state

  if (policy === 'fail-closed') {
    try {
      // Dynamic import: `engine-events` is not otherwise on this module's
      // dependency graph, and a static one would pull the board's event
      // surface into every consumer of the state schema.
      const { emitGateInvalidated } = await import('../board/engine-events.js')
      await Promise.all(
        stubs.map((g) => emitGateInvalidated(g.plugin, g.run_id, 'stub', eventsPath)),
      )
    } catch {
      /* a discard notice that cannot be written must not fail the read */
    }
  }

  return { ...state, pending_gates: state.pending_gates.filter((g) => !isStubGate(g)) }
}

/** First issue, path-qualified. The reason a human acts on, not a dump. */
function describeIssues(error: z.ZodError): string {
  const issue = error.issues[0]
  if (!issue) return 'failed schema validation'
  const where = issue.path.length > 0 ? issue.path.join('.') : '(root)'
  return `${where}: ${issue.message}`
}

let tolerantReads = false

/**
 * Read engine state on a path that may go on to write it.
 *
 * Missing file → defaults. Unusable file → `EngineStateInvalidError`, with the
 * document left exactly as it was on disk. Callers return a non-zero code and
 * surface the message; only `src/bin/warpline.ts` exits.
 *
 * `opts.eventsPath` redirects the stub-gate discard notice. It is threaded
 * rather than defaulted at the emitter so a caller that already redirected its
 * own event log — every engine test does — does not have one notice escape to
 * a different file than the rest of the run's.
 */
export async function readEngineState(
  statePath: string,
  opts: { eventsPath?: string } = {},
): Promise<EngineState> {
  return readStateFile(statePath, tolerantReads ? 'tolerant' : 'fail-closed', opts.eventsPath)
}

/**
 * Read engine state for a command that will not write.
 *
 * Always tolerant: an unusable document yields defaults rather than stopping
 * the caller. `warpline plan` is a preview and is contracted never to fail, so
 * a corrupt state file must degrade the preview, not end it. This is a product
 * decision, not a test convenience — guaranteeing a valid fixture state file
 * would make the prohibition test pass and leave the shipped claim false.
 */
export async function readEngineStateReadOnly(statePath: string): Promise<EngineState> {
  return readStateFile(statePath, 'tolerant')
}

/**
 * Read tolerantly for the duration of `fn`.
 *
 * The name is older than the meaning: it once suppressed a `{path}.corrupt`
 * backup write, and that backup no longer exists. What it does now is force
 * the tolerant policy — which is the same job it was always really doing,
 * namely keeping a read-only command out of the write-capable path.
 *
 * `readEngineStateReadOnly` covers the reads a caller makes directly. This
 * covers the ones it cannot see: `state-manager.checkTaskLock` reads state
 * through `readEngineState` off a module global and takes no options, and
 * `evaluatePlugin` calls it, so `warpline plan` reaches the write-capable read
 * indirectly no matter how carefully its own call sites are written. Without
 * this, the one command contracted never to fail throws on the exact input it
 * was hardened against. One guard in the shared read is a smaller and safer
 * change than a variant threaded through every intermediate caller.
 *
 * ponytail: process-global, restored in a `finally`. Fine for a one-shot CLI
 * command; if two concurrent callers ever need different answers, make it an
 * AsyncLocalStorage context.
 */
export async function withoutStateBackups<T>(fn: () => Promise<T>): Promise<T> {
  const previous = tolerantReads
  tolerantReads = true
  try {
    return await fn()
  } finally {
    tolerantReads = previous
  }
}

/** Atomic write: temp file + rename, so a crash never leaves a half-written state. */
export async function writeEngineState(state: EngineState, statePath: string): Promise<void> {
  await mkdir(path.dirname(statePath), { recursive: true })
  const tmp = `${statePath}.tmp`
  await writeFile(tmp, JSON.stringify(state, null, 2) + '\n', 'utf-8')
  await rename(tmp, statePath)
}
