/**
 * The exit code `warpline advance` reports, computed from one advance's own
 * state.
 *
 * Published contract surface. The codes and their meanings live in
 * `docs/runtime-spec.md` § 11 and a scheduler unit in the field keys on them, so
 * changing what a value means here breaks every installed unit file. This module
 * is the single call site the command and the suite share; two call sites would
 * be two answers that can disagree about the same run.
 *
 * The landmine, stated first because it is the one that gets written wrong:
 * do NOT test for terminality, and do NOT use an allow-list of good states.
 * `runAdvance` seeds `plugin_states` with `'pending'` for every manifest it
 * loaded, and it breaks out of its level loop the moment a level gates — so on
 * the ordinary gated path every plugin in every later level is still `'pending'`
 * when the advance returns. A mapper written as "every plugin reached a terminal
 * state and none failed" therefore returns `1` on every gated advance over a
 * multi-level fleet. That is the exact inversion this function exists to
 * prevent: a held approval gate is the runtime doing its job, and reporting it
 * as a failure trains an operator to ignore the code.
 *
 * `'pending'`, `'running'`, `'skipped'`, `'approved'` and `'completed'` all land
 * on `0`. Only `'failed'` and an empty map do not.
 *
 * `75` and `130` are produced outside this function. A pure function over an
 * advance result cannot know that a lock was held or that a signal arrived,
 * because in those cases there is no result to hand it.
 */
import type { AdvanceResult } from './engine.js'

/** The only four fields of an advance the exit code is allowed to read. */
export type AdvanceOutcome = Pick<
  AdvanceResult,
  'plugin_states' | 'gated_plugins' | 'refused_plugins' | 'pending_gates'
>

export interface AdvanceCounts {
  /**
   * How many plugins THIS advance parked at an approval gate.
   *
   * It reads `0` on every later advance while the same gate still waits.
   * `pending_gates` is the count that does not forget.
   */
  gated: number
  /**
   * How many approval gates are still waiting on a human, whichever advance
   * parked them. Carried from the result, never recounted here: the engine
   * counts it once, from the state document, and this is a pass-through.
   */
  pending_gates: number
  /** How many plugins ended in `'failed'`, load failures included. */
  failed: number
  /**
   * How many plugins a content approval declined to authorise.
   *
   * A count, never the reasons. The structured reasons are on the result and
   * reach a consumer through `warpline advance --json`; a plugin-derived list
   * in the dead-man file would widen that document past what it permits, and
   * this is the type that document's writer reads.
   */
  refused: number
}

/**
 * The gated, pending-gate, failed and refused counts for the run's own record.
 *
 * Exported so the record a monitor reads and the code it reads are derived from
 * one walk over one map. A second count computed somewhere else is a second
 * account of the same advance, and the two only have to disagree once.
 */
export function advanceCounts(result: AdvanceOutcome): AdvanceCounts {
  let failed = 0
  for (const state of result.plugin_states.values()) {
    // A bare literal, not a widened string: `plugin_states` is typed over the
    // state union, so a rename in the engine makes this comparison a type
    // error rather than a silently-always-false branch.
    if (state === 'failed') failed += 1
  }
  return {
    gated: result.gated_plugins.length,
    pending_gates: result.pending_gates,
    failed,
    // `.length` over the structured array the engine already populated. No
    // second walk: a refusal is counted where the advance recorded it.
    refused: result.refused_plugins.length,
  }
}

/**
 * `0` or `1` for one advance.
 *
 * An empty `plugin_states` is exactly the zero-manifest signature and nothing
 * else. The engine seeds that map from the manifests it loaded and only ever
 * adds to it afterwards — a manifest that failed to import is added as
 * `'failed'` — so an empty map means the plugin root held nothing importable.
 * It is not a count of failures and must not be read as one.
 *
 * `opts.strict` promotes a held gate to `1`, and a content refusal with it. A
 * gate still waiting is promoted on every advance while it waits, not only on
 * the advance that parked it. It changes none of the `1` cases: a plugin
 * failure and a zero-manifest root are `1` with it or without it.
 *
 * A refusal on its own is `0`. For `indeterminate`, `outside_window` and
 * `content_moved` that is the reason stated at the top of this file: a held
 * approval gate is the runtime doing its job, and these three are the same gate
 * holding, because the authority a human gave no longer covers what would ship.
 * Reporting it as a failure trains an operator to ignore the code.
 *
 * `mark_unavailable` and `mark_uncertain` are NOT the gate holding. They are the
 * spend mark's own state-document I/O failing, and they exit `0` as well. That
 * is a decision, and it is safe only because of the advance around the mark,
 * never because of anything this function reads:
 *
 * - The end-of-run locked write in `runAdvance` (lock, read, write the state
 *   document) sits in no `try` that catches. A full disk or a read-only home that
 *   failed the mark fails that write too, and the advance exits `75`.
 * - The top-of-run read sits in no catching `try` either, so a state document
 *   too corrupt to read fails the next advance with `75`.
 * - A lock the mark could not take because it cannot be broken at all fails the
 *   end-of-run acquire the same way, `75`.
 * - A lock that was only busy exits `0` with nothing marked and nothing sent,
 *   and the next tick retries and fires. That is the right outcome.
 *
 * One case stays quiet and leaves stuck state: a write that throws AFTER its
 * rename landed. That advance exits `0`, and the next one refuses with
 * `indeterminate`, which no operator gesture resolves today. It shows through
 * `refused`, `--json`, the dead-man file and `--strict`, and nowhere louder.
 *
 * **This decision is coupled to that end-of-run write.** If anyone ever wraps it
 * in a `catch`, storage faults stop failing the advance, both mark reasons
 * become quiet `0`s, and this has to be decided again. The same warning sits on
 * the write itself.
 *
 * Reporting a refusal as nothing is the other failure — an unattended fleet can
 * refuse every send for a week while every monitor reads healthy — which is why
 * the count reaches `--json` and the dead-man file whatever this returns, and
 * why `--strict` covers it.
 */
export function advanceExitCode(
  result: AdvanceOutcome,
  opts: { strict?: boolean } = {},
): 0 | 1 {
  if (result.plugin_states.size === 0) return 1

  const { gated, pending_gates, failed, refused } = advanceCounts(result)
  if (failed > 0) return 1
  // Gated OR refused OR still waiting, one clause and one `1`. Not additive
  // over exit codes: two reasons to report a held gate are still one held
  // advance. `gated > 0` is implied by `pending_gates > 0` on the normal arm,
  // and kept so the parking advance's `1` does not depend on the merge.
  // Evaluated below the `failed` check so a failure outranks all three, which
  // is the precedence every installed scheduler unit already keys on.
  if (gated > 0 || refused > 0 || pending_gates > 0) return opts.strict === true ? 1 : 0

  return 0
}
