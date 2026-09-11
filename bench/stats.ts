/**
 * The arithmetic that turns a directory of raw run records into the published
 * table. Pure functions, no I/O, no state, no dependency on the record module.
 *
 * Everything here takes its input STRUCTURALLY — a plain object with the four
 * token-class keys, not an imported `BenchRunRecord`. That is deliberate: these
 * functions are the only part of the harness a reader has to be able to re-run
 * against the committed raw JSON, and a reader who can call them from literals
 * can check the published figures without loading a schema, a scrubber, or a
 * plugin root. It also keeps the module a leaf, so nothing it depends on can
 * change a number it returns.
 */

/**
 * The linear-interpolation quantile, definition SEVEN of the nine catalogued by
 * Hyndman and Fan — the default in R's `quantile`, NumPy's `quantile`, and
 * pandas' `Series.quantile`.
 *
 * The number is in the exported NAME rather than the word median alone, and it
 * is in the pre-registration for the same reason. "The median of an even-length
 * sample" is not one number: the nine definitions disagree about where to land
 * between the two middle order statistics, and a reader who reproduces the
 * published table in a different tool gets the same figure only if the
 * interpolation rule is pinned rather than assumed. A silent change from type-7
 * to any other rule would shift published numbers without shifting a line of
 * prose, which is exactly the class of drift a benchmark cannot survive.
 *
 * The rule, stated so a reader can check the implementation against it:
 * sort ascending, let `h = p × (n − 1)`, and interpolate linearly between the
 * order statistics at `floor(h)` and `ceil(h)` by the fractional part of `h`.
 *
 * Throws on an empty input and on a `p` outside the closed interval 0 to 1,
 * each error naming what it received. A statistic over nothing is a caller bug,
 * and `NaN` returned here would reach a published table as a cell nobody can
 * account for.
 */
export function type7Quantile(values: readonly number[], p: number): number {
  if (values.length === 0) throw new Error('type7Quantile: refusing a quantile over an empty sample')
  if (!(p >= 0 && p <= 1)) throw new Error(`type7Quantile: p must be within 0 to 1, received ${p}`)
  // A copy, and a numeric comparator. The default sort is lexicographic, which
  // orders 12 before 3 and returns a plausible wrong median.
  const sorted = [...values].sort((a, b) => a - b)
  const h = p * (sorted.length - 1)
  const lo = Math.floor(h)
  const hi = Math.ceil(h)
  const low = sorted[lo]
  if (lo === hi) return low
  return low + (h - lo) * (sorted[hi] - low)
}

/** The type-7 median. Named for the rule it delegates to, not for the word. */
export function median(values: readonly number[]): number {
  return type7Quantile(values, 0.5)
}

/** The type-7 interquartile range: the 0.75 quantile minus the 0.25 quantile. */
export function iqr(values: readonly number[]): number {
  return type7Quantile(values, 0.75) - type7Quantile(values, 0.25)
}

// ─── RED-phase stubs for the per-arm summary ─────────────────────────────────
// Signatures and a deliberately wrong constant, so the summary tests fail on
// their own assertions rather than on an unresolved export. Replaced by GREEN.

export interface TokenClassCounts {
  input: number | null
  output: number | null
  cache_creation: number | null
  cache_read: number | null
}

export interface SummarisableRun {
  cold: boolean
  disposition: 'passed' | 'failed-grader' | 'failed-schema' | 'truncated'
  tokens: TokenClassCounts
  wall_clock_ms: number
}

export const SHORTFALL_N = 10

export function sumTokenClasses(_runs: readonly { tokens: TokenClassCounts }[]): TokenClassCounts {
  return { input: 0, output: 0, cache_creation: 0, cache_read: 0 }
}

export interface ArmSummary {
  warm_passing: number
  truncation_rate: number
  grader_failure_rate: number
  failed_schema_rate: number
  cold_row: null
  shortfall: { count: number; threshold: number }
}

export function summariseArm(_runs: readonly SummarisableRun[]): ArmSummary {
  return {
    warm_passing: -1,
    truncation_rate: -1,
    grader_failure_rate: -1,
    failed_schema_rate: -1,
    cold_row: null,
    shortfall: { count: -1, threshold: -1 },
  }
}
