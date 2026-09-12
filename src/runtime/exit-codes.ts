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

/** The only two fields of an advance the exit code is allowed to read. */
export type AdvanceOutcome = Pick<AdvanceResult, 'plugin_states' | 'gated_plugins'>

export interface AdvanceCounts {
  /** How many plugins are holding at an approval gate. */
  gated: number
  /** How many plugins ended in `'failed'`, load failures included. */
  failed: number
}

/**
 * The gated and failed counts for the run's own record.
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
  return { gated: result.gated_plugins.length, failed }
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
 * `opts.strict` promotes a held gate to `1`. It changes none of the `1` cases:
 * a plugin failure and a zero-manifest root are `1` with it or without it.
 */
export function advanceExitCode(
  result: AdvanceOutcome,
  opts: { strict?: boolean } = {},
): 0 | 1 {
  if (result.plugin_states.size === 0) return 1

  const { gated, failed } = advanceCounts(result)
  if (failed > 0) return 1
  if (gated > 0) return opts.strict === true ? 1 : 0

  return 0
}
