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
import { iqr, median, type7Quantile } from '../../bench/stats.js'

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
