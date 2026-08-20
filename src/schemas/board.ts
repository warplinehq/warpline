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
 * Severity levels — matches TaskAgingSchema.severity in warpline-state.ts.
 * Used for sorting (critical first) and icon rendering in Ink UI.
 */
export const Severity = z.enum(['critical', 'warning', 'info'])
export type Severity = z.infer<typeof Severity>

/**
 * Board event — one JSON line in .warpline/state/events.jsonl.
 *
 * Ink constraint (Pitfall 6): All renderable fields MUST be flat/scalar.
 * Complex data goes into metadata_json (serialized string) to avoid
 * React key/render issues in Ink's reconciler.
 *
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
   * Max 200 chars enforced: Ink renders one line per event — longer summaries
   * would overflow terminal columns and corrupt the layout.
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
   * Serialized JSON string for extra data not rendered directly.
   * Never a nested object — Ink constraint requires flat field structure.
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
