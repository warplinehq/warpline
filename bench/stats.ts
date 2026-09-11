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

// ─── the per-arm summary ─────────────────────────────────────────────────────

/**
 * The four token classes, each nullable, taken structurally.
 *
 * A class the provider CLI never reported and a class it reported as zero are
 * different facts. `null` is the first; `0` is the second; nothing here turns
 * one into the other, because coercing a missing class to zero silently
 * understates every figure derived from it.
 */
export interface TokenClassCounts {
  input: number | null
  output: number | null
  cache_creation: number | null
  cache_read: number | null
}

/** The same four classes once they are known to be present. */
export interface TokenClassFigures {
  input: number
  output: number
  cache_creation: number
  cache_read: number
}

/** The four class names, in fixed order, as the one place they are written. */
const TOKEN_CLASSES = ['input', 'output', 'cache_creation', 'cache_read'] as const

/** What a summary needs from a run. A structural subset of the record shape. */
export interface SummarisableRun {
  cold: boolean
  disposition: 'passed' | 'failed-grader' | 'failed-schema' | 'truncated'
  tokens: TokenClassCounts
  wall_clock_ms: number
}

/**
 * The minimum warm passing runs an arm needs before a median is published.
 *
 * Declared once and compared against, never restated as a literal: a threshold
 * that appears twice is a threshold that can be changed in one place.
 */
export const SHORTFALL_N = 10

/**
 * Per-class totals. Four keys out, four keys in, and no fifth.
 *
 * There is deliberately no total field. A sum across classes is a different
 * quantity from any of them — input and cache-read tokens are neither priced
 * nor produced alike — and the moment one is returned here, the first caller
 * that wants a single number copies it into the published table. A caller that
 * genuinely needs a cross-class figure has to write the addition itself, where
 * a reader can see which classes went into it.
 *
 * A class is `null` in the result when ANY contributing run carried `null` for
 * it: a total over a sample with a hole is not a total.
 */
export function sumTokenClasses(runs: readonly { tokens: TokenClassCounts }[]): TokenClassCounts {
  const out: TokenClassCounts = { input: 0, output: 0, cache_creation: 0, cache_read: 0 }
  for (const { tokens } of runs) {
    for (const cls of TOKEN_CLASSES) {
      const running = out[cls]
      const value = tokens[cls]
      out[cls] = running === null || value === null ? null : running + value
    }
  }
  return out
}

/** The cache-cold first run, reported beside the warm figures and never inside them. */
export interface ColdRow {
  label: string
  disposition: SummarisableRun['disposition']
  tokens: TokenClassCounts
  wall_clock_ms: number
}

/** The figures every arm reports, whether or not it reached the threshold. */
export interface ArmSummaryBase {
  /** Runs excluding the cache-cold one — the denominator of all three rates. */
  warm_runs: number
  warm_passing: number
  truncation_rate: number
  grader_failure_rate: number
  failed_schema_rate: number
  cold_row: ColdRow | null
}

/** Central tendency and spread, per token class and for the wall clock. */
export interface ArmCentre {
  tokens: TokenClassFigures
  wall_clock_ms: number
}

/**
 * An arm at or above the threshold, and an arm below it.
 *
 * The shortfall is a MISSING FIELD rather than a sentinel value, and the two
 * arms of this union cannot both be inhabited. The harness refuses to emit a
 * summary row below the threshold and reports the shortfall instead; a shape
 * that could express a median and a shortfall at once is a shape in which a
 * reader can be handed both, and a zero or a null in a median field is a figure
 * a table renderer will print without comment. A consumer has to narrow with
 * `'median' in summary` before it can read one, so the refusal is enforced by
 * the type rather than by a convention nobody re-reads.
 */
export type ArmSummary = ArmSummaryBase &
  ({ median: ArmCentre; iqr: ArmCentre } | { shortfall: { count: number; threshold: number } })

/** Pull one class out of a run set, refusing a hole the caller cannot see. */
function classValues(runs: readonly SummarisableRun[], cls: keyof TokenClassCounts): number[] {
  return runs.map((r) => {
    const value = r.tokens[cls]
    if (value === null) {
      // A run that passed carries every class by contract: a missing class is
      // dispositioned `failed-schema` and never reaches this set. Silently
      // dropping it would shrink the sample the median is taken over without
      // shrinking the count reported beside it.
      throw new Error(`summariseArm: a passing run carries no ${cls} token count`)
    }
    return value
  })
}

/** Apply one statistic across the four classes and the wall clock. */
function centre(runs: readonly SummarisableRun[], stat: (v: readonly number[]) => number): ArmCentre {
  return {
    tokens: {
      input: stat(classValues(runs, 'input')),
      output: stat(classValues(runs, 'output')),
      cache_creation: stat(classValues(runs, 'cache_creation')),
      cache_read: stat(classValues(runs, 'cache_read')),
    },
    wall_clock_ms: stat(runs.map((r) => r.wall_clock_ms)),
  }
}

/**
 * One arm's published row, computed from nothing but the runs handed in.
 *
 * Purity is the property that makes the published table checkable: a third
 * party holding the committed raw JSON has to be able to reach the same figures
 * with the same function, which they can only do if this reads no clock, no
 * environment and no file, and keeps nothing between calls.
 */
export function summariseArm(runs: readonly SummarisableRun[]): ArmSummary {
  const cold = runs.filter((r) => r.cold)
  if (cold.length > 1) {
    throw new Error(`summariseArm: expected at most one cache-cold run, received ${cold.length}`)
  }
  const warm = runs.filter((r) => !r.cold)
  if (warm.length === 0) {
    throw new Error('summariseArm: refusing a rate over an empty warm set')
  }
  const rate = (d: SummarisableRun['disposition']): number =>
    warm.filter((r) => r.disposition === d).length / warm.length

  const first = cold[0]
  const base: ArmSummaryBase = {
    warm_runs: warm.length,
    warm_passing: warm.filter((r) => r.disposition === 'passed').length,
    // Three separate rates, so no consumer has to derive one by subtracting the
    // others from one — a derivation that is wrong the moment a fifth
    // disposition exists.
    truncation_rate: rate('truncated'),
    grader_failure_rate: rate('failed-grader'),
    failed_schema_rate: rate('failed-schema'),
    cold_row: first
      ? {
          label: 'cache-cold first run',
          disposition: first.disposition,
          tokens: first.tokens,
          wall_clock_ms: first.wall_clock_ms,
        }
      : null,
  }

  const passing = warm.filter((r) => r.disposition === 'passed')
  if (passing.length < SHORTFALL_N) {
    return { ...base, shortfall: { count: passing.length, threshold: SHORTFALL_N } }
  }
  return { ...base, median: centre(passing, median), iqr: centre(passing, iqr) }
}
