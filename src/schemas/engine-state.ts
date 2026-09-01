/**
 * Engine state — shapes only, for the single JSON document the engine persists
 * between runs. This module is reachable as `warpline/schemas/engine-state`,
 * and `./schemas/*` is a wildcard entry in the `exports` map — so anything
 * written here is public API from the release it appears in, with no review
 * step in between.
 *
 * The five persistence exports that used to sit below these schemas now live in
 * `src/runtime/engine-state-store.ts`. There is no back-compat re-export: a
 * subpath named `schemas` was public API for `readFile`, `writeFile`, `mkdir`
 * and `rename` over the engine's own state document, and the bridge that would
 * soften the break is the same bridge that keeps the old path working.
 * `src/__tests__/no-orphan-schema-fields.test.ts` asserts no file under
 * `src/schemas/` imports the Node filesystem or path built-ins, so the boundary
 * holds for the next schema module as well as for this one.
 *
 * Deliberately narrow: only fields the engine itself reads or writes. Anything
 * application-specific belongs to the host, which hangs it off the explicit
 * `extensions` records rather than widening this schema. Core fields stay
 * strict, so a typo'd one still fails validation loudly.
 */
import { z } from 'zod'
import { OutputRecordSchema, SkillResultSchema } from './skill-result.js'

// ── Task-board records ────────────────────────────────────────────────────

export const DeferralSchema = z.object({
  task_id: z.string(),
  reason: z.string(),
  deferred_at: z.string(),
  expires_at: z.string(),
})
export type Deferral = z.infer<typeof DeferralSchema>

/**
 * A human's "no" to what a plugin proposed, recorded so the next advance reads
 * it instead of asking again.
 *
 * Bound to a `fingerprint` of the proposal, not to the plugin alone. A denial
 * that outlived what it was answering would suppress a question nobody has
 * answered — so the fingerprint is recomputed on every advance and a proposal
 * that has materially moved is asked again. See `proposalFingerprint` in
 * `src/runtime/engine.ts` for what the value covers.
 *
 * `plugin` is stored as a field as well as being the record key. The key is how
 * the record is looked up; the field is what survives being read out of the
 * record on its own, and it costs one string.
 */
export const DenialSchema = z.object({
  plugin: z.string(),
  /** Why the engine is not asking — rendered to the operator on the next plan. */
  reason: z.string(),
  denied_at: z.string(),
  /** The operator's own words, if they gave any. Null rather than absent so a reader has one shape. */
  note: z.string().nullable().default(null),
  /** Hex sha256 of the proposal this answered, whole and untruncated. */
  fingerprint: z.string(),
})
export type Denial = z.infer<typeof DenialSchema>

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
   *
   * **Reserved and unwritten.** `createTask` accepts both and no caller
   * supplies one, so in shipped operation they are permanently null and
   * nothing reads them. Threading the advance's run id into task creation is
   * Board-build work — nothing in the engine raises a task yet. Read this as
   * the contract that build fills in, not as data that arrives today.
   * `docs/board-spec.md` § 7 item 2 says the same, so a planner meets it either way.
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
 * loads; one above it is refused by `readStateFile` in
 * `src/runtime/engine-state-store.ts`, with a reason that says
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
   * in `readStateFile` (`src/runtime/engine-state-store.ts`) rather than a
   * validation failure. A non-integer or negative value is not a version at
   * all, so it fails here and lands on the ordinary invalid-content refusal.
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
  /**
   * Live denials, keyed by plugin name.
   *
   * A record and not an array, which is the whole idempotency story: one live
   * denial per plugin by construction, so re-denying lands on the same key
   * rather than accumulating, and there is no de-dupe scan to get wrong. It
   * also makes a fleet-wide denial inexpressible — no key means every plugin.
   * `deferrals` stays an array because a task can carry several; a denial
   * cannot.
   *
   * `.default({})` so a state document written before denials existed still
   * loads and reads as none.
   */
  denials: z.record(z.string(), DenialSchema).default({}),
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
