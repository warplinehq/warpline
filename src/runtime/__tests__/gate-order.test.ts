/**
 * The declared guard chain is in the order it says it is, and the approval
 * check is the last thing standing between a declared side effect and a real
 * one.
 *
 * ON A REAL RUN. The qualifier is load-bearing and is in the test titles for
 * that reason. `GATES` is the whole chain for a real advance, so its final
 * entry is the last gate before invocation. A dry run has one more: the
 * dry-run side-effect block in `runAdvance`, which needs both the dry-run flag
 * and the finished verdict and so cannot join an array of predicates over the
 * plugin alone. It sits after the scan and blocks every side-effecting plugin
 * that got this far. A test asserting the unqualified claim would be asserting
 * something false about half the runs.
 *
 * On the count, since a reader arrives with the wrong one: the requirement
 * these assertions answer speaks of a sixteen-gate chain. That figure traces
 * to an approximation in an older audit and is not reproducible against
 * source. What is countable is the members of the `NotDueReason` union, one
 * array entry each, plus the single dry-run predicate that lives outside the
 * union and outside the array.
 *
 * The expected order below is written out by hand. A list mapped from `GATES`
 * would agree with whatever the source says on any given day and pin nothing —
 * the same reason the older source-text guard beside this file writes its
 * members out. That guard's MECHANISM is not copied: it reads source text
 * because a TypeScript union has no runtime shape to inspect, and this array
 * does have one.
 */
import { describe, expect, test } from 'bun:test'
import { GATES } from '../engine.js'

/**
 * Every gate, in evaluation order.
 *
 * Not the order the union declares — that one puts `denied` before
 * `task_locked`, and the chain does not. The chain is what an operator sees.
 */
const DECLARED_ORDER = [
  'profile_schedule',
  'min_tier',
  'headless_supervised',
  'manual',
  'fresh',
  'task_locked',
  'denied',
  'unapproved',
]

describe('the guard chain declares its order', () => {
  test('GATES names its reasons in evaluation order', () => {
    // Widened to `string[]`: the expectation is a hand-written list, and
    // annotating it with the union would make the comparison check the source
    // against itself in the one place this file exists not to.
    const declared: string[] = GATES.map((g) => g.reason)
    expect(declared).toEqual(DECLARED_ORDER)
  })

  test('the side-effect approval check is the last gate before invocation on a real run', () => {
    expect(GATES.at(-1)?.reason).toBe('unapproved')
  })

  /**
   * Without this, an emptied or truncated array passes the order assertion by
   * matching a truncated expectation, and "the approval check is last" holds
   * vacuously over one entry.
   */
  test('GATES is non-empty and covers every reason the chain names', () => {
    expect(GATES.length).toBeGreaterThan(0)
    expect(GATES).toHaveLength(DECLARED_ORDER.length)
    expect(new Set(GATES.map((g) => g.reason)).size).toBe(GATES.length)
  })
})
