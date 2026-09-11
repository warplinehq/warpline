/**
 * The benchmark's arithmetic, exercised entirely from literals and one recorded
 * fixture — no process spawns, no temp homes, no provider key.
 *
 * Why this file lives under `src/__tests__/` and not under `bench/`: CI shards
 * the suite by a `find` over `src/` plus one explicit `examples/` line, so a
 * test directory anywhere else runs locally and runs NOWHERE on the branch.
 *
 * What makes these assertions evidence rather than decoration:
 *
 *   - the expected quantiles are NUMERIC LITERALS, computed from the type-7
 *     definition independently of the implementation and cross-checked against
 *     NumPy's default. A test that recomputed the figure the same way the code
 *     does would agree with any interpolation rule, including a changed one,
 *     and the whole point of pinning the rule is that a reader reproducing the
 *     published table in R, NumPy or pandas gets the same number.
 *   - a roster sentinel on the fixture. Its length is asserted to be exactly
 *     ten before anything is asserted over it, so a truncated fixture fails
 *     loudly instead of yielding a plausible wrong median.
 *   - the fixture is deliberately UNSORTED and mixes single- and double-digit
 *     values, so a sort missing its numeric comparator produces a different
 *     median rather than the right one by luck.
 *   - the shortfall case is asserted by ABSENCE (`in`), never by comparing a
 *     median field to zero: the claim is that no median was computed, and a
 *     zero would be a figure a table renderer would happily print.
 */
import { describe, expect, test } from 'bun:test'
import {
  iqr,
  median,
  SHORTFALL_N,
  summariseArm,
  sumTokenClasses,
  type7Quantile,
  type SummarisableRun,
  type TokenClassCounts,
} from '../../bench/stats.js'

/**
 * Ten wall-clock-shaped values with a deliberate tie at sorted positions 4 and
 * 5, which is where type-7 lands the median for N=10 (h = 0.5 × 9 = 4.5). The
 * tie is what makes the even-N case unambiguous across implementations.
 *
 * Sorted: 3, 8, 12, 15, 20, 20, 27, 31, 44, 96.
 */
const TEN = [20, 3, 96, 12, 44, 20, 8, 31, 15, 27] as const

/** The roster sentinel: nine values also produce a median, just the wrong one. */
const TEN_N = 10

describe('type-7 quantiles', () => {
  test('the fixture is the length every expectation below was computed for', () => {
    expect(TEN.length).toBe(TEN_N)
  })

  test('an even-length input interpolates between the two middle order statistics', () => {
    // h = 0.5 × (4 − 1) = 1.5 → x[1] + 0.5 × (x[2] − x[1]) = 2 + 0.5 = 2.5
    expect(type7Quantile([1, 2, 3, 4], 0.5)).toBe(2.5)
  })

  test('an odd-length input returns the middle order statistic exactly', () => {
    // h = 0.5 × (5 − 1) = 2 → x[2], no interpolation
    expect(type7Quantile([1, 2, 3, 4, 5], 0.5)).toBe(3)
    expect(median([1, 2, 3, 4, 5])).toBe(3)
  })

  test('a tie at the median position resolves to the tied value, as R, NumPy and pandas do', () => {
    // type-7 over the sorted fixture: h = 0.5 × 9 = 4.5 → x[4] + 0.5 × (x[5] − x[4])
    //   = 20 + 0.5 × (20 − 20) = 20.
    // Cross-checked against numpy.quantile(TEN, 0.5) — the library default — which
    // returns 20.0. A lexicographic sort would place x[4] = 27 and x[5] = 3 and
    // return 15, so this literal also pins the numeric comparator.
    expect(median(TEN)).toBe(20)
  })

  test('the two quartiles over the fixture are exact, and the IQR is their difference', () => {
    // h = 0.25 × 9 = 2.25 → x[2] + 0.25 × (x[3] − x[2]) = 12 + 0.75 = 12.75
    // h = 0.75 × 9 = 6.75 → x[6] + 0.75 × (x[7] − x[6]) = 27 + 3    = 30
    // numpy.quantile(TEN, [0.25, 0.75]) returns [12.75, 30.0].
    expect(type7Quantile(TEN, 0.25)).toBe(12.75)
    expect(type7Quantile(TEN, 0.75)).toBe(30)
    expect(iqr(TEN)).toBe(30 - 12.75)
    expect(iqr(TEN)).toBe(17.25)
  })

  test('a single-element input returns that element at every p', () => {
    for (const p of [0, 0.25, 0.5, 0.75, 1]) expect(type7Quantile([42], p)).toBe(42)
  })

  test('an empty input and an out-of-range p are red, never a number', () => {
    // A statistic over nothing is not NaN, it is a bug in the caller: NaN would
    // propagate into a published table as a blank cell nobody could explain.
    expect(() => type7Quantile([], 0.5)).toThrow(/empty/)
    expect(() => median([])).toThrow(/empty/)
    expect(() => iqr([])).toThrow(/empty/)
    expect(() => type7Quantile([1, 2, 3], 1.5)).toThrow(/1\.5/)
    expect(() => type7Quantile([1, 2, 3], -0.1)).toThrow(/-0\.1/)
    expect(() => type7Quantile([1, 2, 3], Number.NaN)).toThrow(/NaN/)
  })

  test('the caller keeps its array in the order it handed over', () => {
    const given = [...TEN]
    type7Quantile(given, 0.5)
    expect(given).toEqual([...TEN])
  })
})

// ─── the per-arm summary ─────────────────────────────────────────────────────

/** A four-class literal, so a test can vary one class without restating four. */
function tokens(overrides: Partial<TokenClassCounts> = {}): TokenClassCounts {
  return { input: 100, output: 10, cache_creation: 0, cache_read: 5, ...overrides }
}

/** One run, warm and passing unless a test says otherwise. */
function run(overrides: Partial<SummarisableRun> = {}): SummarisableRun {
  return { cold: false, disposition: 'passed', tokens: tokens(), wall_clock_ms: 1000, ...overrides }
}

/** `n` warm passing runs whose wall clock ascends, so a median is identifiable. */
function warmRuns(n: number): SummarisableRun[] {
  return Array.from({ length: n }, (_, i) => run({ wall_clock_ms: 1000 + i * 100 }))
}

describe('the four token classes stay four', () => {
  test('three runs sum per class, and the result carries exactly the four class keys', () => {
    const summed = sumTokenClasses([
      run({ tokens: tokens({ input: 1, output: 2, cache_creation: 3, cache_read: 4 }) }),
      run({ tokens: tokens({ input: 10, output: 20, cache_creation: 30, cache_read: 40 }) }),
      run({ tokens: tokens({ input: 100, output: 200, cache_creation: 300, cache_read: 400 }) }),
    ])
    expect(summed).toEqual({ input: 111, output: 222, cache_creation: 333, cache_read: 444 })
    // By NAME and not by count: four keys is also what a rename produces.
    expect(Object.keys(summed).sort()).toEqual(['cache_creation', 'cache_read', 'input', 'output'])
    expect(Object.keys(summed).filter((k) => k.toLowerCase().includes('total'))).toEqual([])
  })

  test('a null class stays null through the sum, and a genuine zero contributes zero', () => {
    const summed = sumTokenClasses([
      run({ tokens: tokens({ input: 7, cache_read: null }) }),
      run({ tokens: tokens({ input: 0, cache_read: 3 }) }),
    ])
    // A class the CLI never reported and a class it reported as zero are
    // different facts; coercing the first into the second understates a total.
    expect(summed.cache_read).toBeNull()
    expect(summed.input).toBe(7)
  })
})

describe('the per-arm summary', () => {
  test('the cold run is its own row and the medians come from the warm set alone', () => {
    const cold = run({ cold: true, wall_clock_ms: 99_000, tokens: tokens({ input: 99_999 }) })
    const summary = summariseArm([cold, ...warmRuns(11)])
    expect('median' in summary).toBe(true)
    if (!('median' in summary)) throw new Error('unreachable')
    // Eleven warm values 1000..2000 by 100: h = 0.5 × 10 = 5 → x[5] = 1500.
    expect(summary.median.wall_clock_ms).toBe(1500)
    expect(summary.median.tokens.input).toBe(100)
    expect(summary.warm_passing).toBe(11)
    expect(summary.cold_row).not.toBeNull()
    expect(summary.cold_row?.wall_clock_ms).toBe(99_000)
    expect(summary.cold_row?.tokens.input).toBe(99_999)
  })

  test('nine warm passing runs get a shortfall row and no median field at all', () => {
    const summary = summariseArm(warmRuns(9))
    expect('median' in summary).toBe(false)
    expect('iqr' in summary).toBe(false)
    expect('shortfall' in summary).toBe(true)
    if (!('shortfall' in summary)) throw new Error('unreachable')
    expect(summary.shortfall).toEqual({ count: 9, threshold: SHORTFALL_N })
    expect(SHORTFALL_N).toBe(10)
  })

  test('an arm where nothing passed reports a total failure rate and a shortfall of zero', () => {
    const summary = summariseArm([
      run({ disposition: 'failed-grader' }),
      run({ disposition: 'failed-schema', tokens: tokens({ input: null }) }),
      run({ disposition: 'truncated' }),
      run({ disposition: 'failed-grader' }),
    ])
    expect('median' in summary).toBe(false)
    if (!('shortfall' in summary)) throw new Error('unreachable')
    expect(summary.shortfall.count).toBe(0)
    expect(summary.warm_passing).toBe(0)
    const total = summary.truncation_rate + summary.grader_failure_rate + summary.failed_schema_rate
    expect(total).toBe(1)
  })

  test('truncation and grader failure are two rates, and a truncated run moves only the first', () => {
    const base = [...warmRuns(3)]
    const before = summariseArm(base)
    const after = summariseArm([...base.slice(1), run({ disposition: 'truncated' })])
    expect(before.truncation_rate).toBe(0)
    expect(after.truncation_rate).toBe(1 / 3)
    expect(after.grader_failure_rate).toBe(0)
    expect(Object.keys(after)).toContain('truncation_rate')
    expect(Object.keys(after)).toContain('grader_failure_rate')
  })

  test('the same records summarised twice give deep-equal results', () => {
    // The published figures must be recomputable by a third party from the
    // committed raw JSON, which they are only if this function reads nothing
    // but its argument and keeps no state between calls.
    const records = [run({ cold: true }), ...warmRuns(12)]
    expect(summariseArm(records)).toEqual(summariseArm(records))
  })
})
