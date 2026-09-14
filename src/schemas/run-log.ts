/**
 * Shapes only. This module is reachable as `warpline/schemas/run-log`, and
 * `./schemas/*` is a wildcard entry in the `exports` map — so anything written
 * here is public API from the release it appears in, with no review step in
 * between.
 *
 * The seven filesystem helpers that used to sit below these schemas now live in
 * `src/runtime/run-log-store.ts`. There is no back-compat re-export: a subpath
 * named `schemas` was public API for `mkdir`, `writeFile` and `unlink`, and the
 * bridge that would soften the break is the same bridge that keeps the old path
 * working. `src/__tests__/no-orphan-schema-fields.test.ts` asserts no file under
 * `src/schemas/` imports the Node filesystem or path built-ins, so the boundary
 * holds for the next schema module as well as for this one.
 */
import { z } from 'zod'

/**
 * Why a content approval that exists did not authorise a fire.
 *
 * A closed set of exactly three, validated on parse, because this value is
 * what an unattended scheduler switches on. An open-ended reason string would
 * let a value the runtime did not author reach that switch, and a consumer
 * parsing prose breaks the first time the wording changes.
 *
 * The three are decided in the order `indeterminate` → `outside_window` →
 * `content_moved`, and the order is not arbitrary: an `indeterminate` mark
 * means the runtime cannot tell whether the bytes already shipped, and that
 * question outranks both "the window closed" and "the bytes moved", neither of
 * which can be answered honestly while the first is open.
 *
 * **A spent approval is deliberately not a fourth member.** It is no live
 * authority and no operator error — the runtime already fired those
 * bytes, which is the instruction having been carried out. It is a state
 * report, and there is nothing in it for a consumer to switch on.
 */
export const RefusalReasonSchema = z.enum(['content_moved', 'outside_window', 'indeterminate'])
export type RefusalReason = z.infer<typeof RefusalReasonSchema>

export const PluginLogEntrySchema = z.object({
  plugin: z.string(),
  /**
   * `denied` sits beside `gated` as the other outcome of supervision: a human
   * was asked and said no, and the log says so. Recording it as `skipped`
   * instead would put it in the same bucket as "no session Grant" and "still
   * fresh", so the log could no longer tell an unanswered question from an
   * answered one — the conflation a denied outcome exists to remove.
   */
  status: z.enum(['completed', 'failed', 'skipped', 'gated', 'denied']),
  started_at: z.string(),
  elapsed_ms: z.number().int(),
  result_summary: z.string(),
  reversible: z.boolean().optional(),
  undo_instruction: z.string().optional(),
  retried: z.boolean().default(false),
})
export type PluginLogEntry = z.infer<typeof PluginLogEntrySchema>

/**
 * The document an advance writes to `<home>/runs/<run_id>.json`.
 *
 * Deliberately narrow, and narrower than it used to be. Six fields shipped here
 * that nothing in this runtime ever wrote and no document ever described —
 * aggregates and task-board counters carried over from the closed system this
 * core was extracted from. They were public API through `warpline/schemas/*`
 * from 0.1.0 and were removed before an announcement made removal expensive.
 * `src/__tests__/no-orphan-schema-fields.test.ts` is what keeps that condition
 * enforced rather than re-checked by reading.
 *
 * A host that wants run telemetry derives it from `plugin_entries` — the only
 * accumulated field here, and the one the engine actually fills.
 */
export const RunLogSchema = z.object({
  run_id: z.string(),
  started_at: z.string(),
  completed_at: z.string().nullable(),
  status: z.enum(['complete', 'partial', 'failed', 'interrupted']),
  resumed_from: z.string().nullable().default(null),
  summary: z.string(),
  /** Per-plugin execution log entries, written by the engine loop. */
  plugin_entries: z.array(PluginLogEntrySchema).default([]),
  /**
   * How many plugin manifests the loader found for this run.
   *
   * Optional deliberately — neither defaulted nor required. Zero is the
   * failure mode's own signature, the exact value that means the run loaded
   * nothing and reported success, so a default of zero would make every
   * artifact written before this field read back as that failure rather than
   * as a document that predates the question. Required was refused for the
   * mirror reason: it is permanent published contract, and it would break a
   * host reading its own history over artifacts that are not at fault.
   * Optional keeps "this predates the field" and "the root was genuinely
   * empty" tellable apart forever.
   *
   * Not derivable from `plugin_entries`. A run that stops at a gate never
   * reaches the later levels, so it holds entries for fewer plugins than it
   * loaded.
   */
  manifests_loaded: z.number().int().optional(),
})

export type RunLog = z.infer<typeof RunLogSchema>
