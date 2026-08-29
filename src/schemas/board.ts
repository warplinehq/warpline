import { z } from 'zod'

/**
 * Task lifecycle states.
 * State machine:
 *   pending -> active -> completed
 *                     -> deferred (with snooze expiry)
 *   deferred -> pending (when snooze expires)
 */
export const TaskState = z.enum(['pending', 'active', 'completed', 'deferred'])
export type TaskState = z.infer<typeof TaskState>

/**
 * User actions on board items.
 * acknowledge — mark as seen; hides from active view, retained in history
 * action      — open associated task to act on it
 * defer       — snooze with expiry (reappears when deferred_until passes)
 * mark_done   — confirm self-directed task is complete
 */
export const ActionType = z.enum(['acknowledge', 'action', 'defer', 'mark_done'])
export type ActionType = z.infer<typeof ActionType>

/**
 * Severity levels — the same three `TaskAgingSchema.severity` carries in
 * engine-state.ts. Drives sort order (critical first) and the icon a board
 * surface puts on the row.
 */
export const Severity = z.enum(['critical', 'warning', 'info'])
export type Severity = z.infer<typeof Severity>

/**
 * Board event — one JSON line in .warpline/state/events.jsonl.
 *
 * Every renderable field is flat and scalar, and anything richer is serialised
 * into `metadata_json`. Two reasons, both current: the log is append-only and
 * read with a per-line `safeParse` that drops what it cannot validate, so a
 * nested shape arriving where a scalar was expected costs the whole line
 * rather than one field; and an event is rendered as one row, which has
 * nothing to do with a nested object anyway.
 */
export const BoardEventSchema = z.object({
  /** Unique event identifier */
  event_id: z.string(),

  /** Event category */
  type: z.enum([
    'task_created',
    'task_updated',
    'task_completed',
    'task_deferred',
    'run_started',
    'run_completed',
    'plugin_result',
    'error',
    'notice',
  ]),

  /** ISO 8601 timestamp */
  timestamp: z.string(),

  /** Plugin key or 'engine' — identifies the emitter */
  source: z.string(),

  /**
   * Single-line human-readable summary.
   * Capped at 200 characters: an event is one row in a list, and a summary
   * longer than the row overflows it rather than saying more. Anything that
   * needs the space is opened, not inlined.
   */
  summary: z.string().max(200),

  /** Visual priority level */
  severity: Severity.default('info'),

  /**
   * Reference to a TaskItem if this event relates to an active task.
   * null for non-task events (run lifecycle, notices).
   */
  task_id: z.string().nullable().default(null),

  /**
   * The engine advance that emitted this event — a sibling of `task_id`, never
   * a key inside `metadata_json`: a Board that has to JSON.parse a string to
   * find the run cannot index or filter on it.
   *
   * null means the event was emitted outside any run, which is a fact rather
   * than a gap. Distinct from a run id whose log has since been pruned, which
   * resolves through `resolveRunRef` in `schemas/run-log.ts`.
   *
   * `.default(null)` is a read-compat shim and nothing else. `state-manager.ts`
   * safeParses each events.jsonl line on its own and pushes only on success, so
   * a required field here would silently drop every line written before run
   * linkage existed — the whole history, from every board view, with no error.
   */
  run_id: z.string().nullable().default(null),

  /**
   * Serialized JSON string for extra data not rendered directly.
   * A string, never a nested object: see the flat/scalar note on the schema
   * above. This is also where a sub-typed `notice` carries its discriminator,
   * which is why the `type` enum stays closed.
   */
  metadata_json: z.string().nullable().default(null),
})
export type BoardEvent = z.infer<typeof BoardEventSchema>

/**
 * Single acknowledgement record.
 */
export const AcknowledgementSchema = z.object({
  /** ISO 8601 */
  acknowledged_at: z.string(),
  /** What the user did with this event */
  action_taken: ActionType,
})
export type Acknowledgement = z.infer<typeof AcknowledgementSchema>

/**
 * Acknowledgements file — persisted at .warpline/state/acknowledgements.json.
 * Maps event_id -> acknowledgement state.
 * Survives across sessions so the board doesn't re-show already-actioned items.
 */
export const AcknowledgementsSchema = z.record(z.string(), AcknowledgementSchema)
export type Acknowledgements = z.infer<typeof AcknowledgementsSchema>
