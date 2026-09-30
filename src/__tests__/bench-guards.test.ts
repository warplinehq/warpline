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
 *   - the agreement cases RECOMPUTE the public ratios from the committed
 *     records rather than restating them. A restated ratio would keep passing
 *     after the records or the summary arithmetic changed underneath it.
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

/**
 * The harness must never reach the published tarball, and that is a WHITELIST
 * property — which means it can only be proven by mutation.
 *
 * Measurement twice showed the plain check is vacuous over this directory:
 * `scripts/assert-pack-whitelist.sh` passes with the harness present and a file
 * inside it, because `package.json`'s `files` array is an npm whitelist and a
 * directory that is not in it never enters the packed set at all. Both halves
 * of the script are therefore silent about it. A test that ran the script and
 * asserted exit 0 would be asserting the shape of npm, not the shape of this
 * repository.
 *
 * So the property actually enforced here is the mutation: with the directory
 * name ADDED to the `files` array, the script must FAIL, and it must fail in
 * its allowlist half naming the offending path. The control — the same tree
 * without the mutation — is what proves the failure comes from the mutation and
 * not from the temp tree's shape.
 *
 * The mutation runs against a `mkdtemp` tree carrying a copy of the real
 * script, never against the tracked manifest. The script resolves its own
 * repository root from its own location, so a copy inside the temp tree makes
 * the temp tree the repository it measures. Mutating the tracked
 * `package.json` and restoring it in a `finally` was the alternative and it is
 * worse: a `finally` does not run through a signal, and a half-restored
 * manifest in a tracked tree is a worse failure than a missing test.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const GUARDS_REPO_ROOT = join(import.meta.dir, '..', '..')
const PACK_SCRIPT = 'scripts/assert-pack-whitelist.sh'
const HARNESS_DIR = 'bench'

/** Exit status and stdout and stderr together, however the run ended. */
function runScript(cwd: string, script: string): { status: number; output: string } {
  try {
    const output = execFileSync('bash', [script], { cwd, encoding: 'utf8', stdio: 'pipe' })
    return { status: 0, output }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { status: e.status ?? -1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

/**
 * Run the real script over a throwaway repository whose `files` array carries
 * `extra` in addition to the tracked ones.
 *
 * The `scripts` block is dropped from the temp manifest so `npm pack` does not
 * invoke `prepack`: this tree needs no dependency tree and no compiler, only a
 * listing. One real file sits inside every whitelisted root the array names, so
 * the listing has genuine entries in both halves rather than proving something
 * about an empty pack.
 */
function packWhitelistMutation(extra: string[]): { status: number; output: string } {
  const real = JSON.parse(readFileSync(join(GUARDS_REPO_ROOT, 'package.json'), 'utf8')) as {
    files: string[]
    scripts?: unknown
  }
  const root = mkdtempSync(join(tmpdir(), 'warpline-pack-'))
  try {
    mkdirSync(join(root, dirname(PACK_SCRIPT)), { recursive: true })
    copyFileSync(join(GUARDS_REPO_ROOT, PACK_SCRIPT), join(root, PACK_SCRIPT))

    const files = [...real.files, ...extra]
    const { scripts: _dropped, ...rest } = real
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ ...rest, name: 'warpline-pack-fixture', version: '0.0.0', files }, null, 2),
    )

    // Directory or file is read from the real tree rather than guessed from the
    // name: `LICENSE` and `NOTICE` carry no extension and are files, and a
    // guess that made them directories produced a temp tree the script
    // rejected for a reason that had nothing to do with the mutation.
    for (const entry of [...real.files, HARNESS_DIR]) {
      if (entry.startsWith('!')) continue
      const path = statSync(join(GUARDS_REPO_ROOT, entry)).isDirectory()
        ? join(entry, 'placeholder.txt')
        : entry
      mkdirSync(join(root, dirname(path)), { recursive: true })
      writeFileSync(join(root, path), 'fixture\n')
    }

    return runScript(root, PACK_SCRIPT)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const PACK_TIMEOUT_MS = 120_000

describe('the harness cannot reach the published tarball', () => {
  test(
    'the real script passes with the harness present and tracked',
    () => {
      const { status, output } = runScript(GUARDS_REPO_ROOT, PACK_SCRIPT)
      expect(status).toBe(0)
      expect(output).toContain('pack whitelist holds')
    },
    PACK_TIMEOUT_MS,
  )

  /**
   * Asserted on the failure TEXT and not merely on a non-zero exit. A malformed
   * temp tree also exits non-zero, and a bare exit-code check calls that a pass
   * — the same point `scripts/verify-tarball.sh` makes about a rejection that is
   * really a type error.
   */
  test(
    'adding the harness to the files array makes the script fail, naming the path',
    () => {
      const { status, output } = packWhitelistMutation([HARNESS_DIR])
      expect(status).not.toBe(0)
      expect(output).toContain('outside the whitelisted roots')
      expect(output).toMatch(new RegExp(`^\\s*${HARNESS_DIR}/`, 'm'))
    },
    PACK_TIMEOUT_MS,
  )

  test(
    'the same tree without the mutation passes, so the failure above is the mutation',
    () => {
      const { status, output } = packWhitelistMutation([])
      expect(status).toBe(0)
      expect(output).toContain('pack whitelist holds')
    },
    PACK_TIMEOUT_MS,
  )

  /**
   * An assertion rather than a comment, because a comment does not fail.
   * Adding the harness name to the denylist would guard a path npm never
   * produces, and would make the stated requirement — that the script rejects
   * it — literally false while reading as though it had been satisfied.
   */
  test('the denylist was not widened instead of the mutation being proven', () => {
    const source = readFileSync(join(GUARDS_REPO_ROOT, PACK_SCRIPT), 'utf8')
    const denylist = source.split('\n').filter((l) => l.startsWith('DENIED_RE='))
    expect(denylist).toHaveLength(1)
    expect(denylist[0]).not.toContain(HARNESS_DIR)
  })
})

// ─── agreement ───────────────────────────────────────────────────────────────

/**
 * The rule that decides whether a private-scale figure may be published, run
 * against the public records it is compared with.
 *
 * The public side is read from disk through the same `summariseSet` the
 * published table comes from. Nothing here spawns a process or writes a file.
 */
import {
  agreementVerdict,
  agrees,
  GATING_RATIOS,
  gatingRatios,
  powerOfTenBucket,
  twoSigFigs,
  type SummaryLike,
} from '../../bench/agreement.js'
import { summariseSet } from '../../bench/run.js'

describe('agreement — the public ratios, recomputed', () => {
  test('the committed records give the four published public ratios at two significant figures', async () => {
    const pub = await summariseSet(join(GUARDS_REPO_ROOT, 'bench/results'))
    const result = gatingRatios(pub)
    if (!('ratios' in result)) throw new Error('the public set carries a shortfall')
    expect(twoSigFigs(result.ratios['wall_clock:agent-with-state'])).toBe('0.76')
    expect(twoSigFigs(result.ratios['wall_clock:agent-from-scratch'])).toBe('0.80')
    expect(twoSigFigs(result.ratios['output:agent-with-state'])).toBe('0.63')
    expect(twoSigFigs(result.ratios['output:agent-from-scratch'])).toBe('0.70')
  })

  test('the public set compared with itself publishes, every ratio agreeing', async () => {
    const pub = await summariseSet(join(GUARDS_REPO_ROOT, 'bench/results'))
    const report = agreementVerdict(pub, pub)
    expect(report.verdict).toBe('publish')
    expect(report.ratios.map((r) => r.id)).toEqual(GATING_RATIOS.map((g) => g.id))
    expect(report.ratios.every((r) => r.verdict === 'agree')).toBe(true)
    expect(report.diverged).toEqual([])
    expect(report.shortfalls).toEqual([])
  })
})

/** One arm with a median, as much of it as the rule reads. */
function arm(wall_clock_ms: number, output: number): SummaryLike['warpline'] {
  return { median: { wall_clock_ms, tokens: { output } } }
}

/**
 * A literal set whose four ratios are 0.76, 0.80, 0.63 and 0.70, the public
 * figures at two significant figures, from medians a reader can divide by hand.
 */
const LITERAL_PUBLIC: SummaryLike = {
  warpline: arm(760, 630),
  'agent-with-state': arm(1000, 1000),
  'agent-from-scratch': arm(950, 900),
}

describe('agreement — the rule at its boundaries', () => {
  test('a ratio of exactly 1 is on neither side, so it diverges from either position', () => {
    expect(agrees(1, 0.76)).toBe('diverge')
    expect(agrees(0.76, 1)).toBe('diverge')
  })

  test('exactly one order of magnitude apart diverges, including the float edge that lands a hair under it', () => {
    // 0.05 / 0.5 is 0.1 and its log10 is exactly -1.
    expect(agrees(0.05, 0.5)).toBe('diverge')
    // 0.08 / 0.8 is 0.09999999999999999, and its log10 still rounds to -1.
    expect(agrees(0.08, 0.8)).toBe('diverge')
  })

  test('the opposite side diverges, beyond one order diverges, and inside both agrees', () => {
    expect(agrees(1.2, 0.76)).toBe('diverge')
    expect(agrees(0.07, 0.76)).toBe('diverge')
    expect(agrees(0.2, 0.76)).toBe('agree')
    expect(agrees(0.9999999, 0.76)).toBe('agree')
    expect(agrees(1.5, 1.2)).toBe('agree')
    expect(agrees(5, 0.5)).toBe('diverge')
  })

  test('a ratio that is zero, negative, not a number or infinite is refused', () => {
    expect(() => agrees(0, 0.76)).toThrow(/agreement:/)
    expect(() => agrees(-1, 0.76)).toThrow(/agreement:/)
    expect(() => agrees(NaN, 0.76)).toThrow(/agreement:/)
    expect(() => agrees(0.76, Infinity)).toThrow(/agreement:/)
  })

  test('a private arm below the threshold withholds, naming the arm and its count, with no ratio computed', () => {
    const priv: SummaryLike = { ...LITERAL_PUBLIC, 'agent-with-state': { shortfall: { count: 7, threshold: 10 } } }
    const report = agreementVerdict(priv, LITERAL_PUBLIC)
    expect(report.verdict).toBe('withhold')
    expect(report.shortfalls).toEqual([{ arm: 'agent-with-state', count: 7, threshold: 10 }])
    expect(report.ratios).toEqual([])
  })

  test('one measure pushed past 1 diverges, and names exactly the ratios it moved', () => {
    // 0.76 × 1.5 = 1.14 and 0.80 × 1.5 = 1.2: both wall-clock ratios cross 1.
    const priv: SummaryLike = { ...LITERAL_PUBLIC, warpline: arm(760 * 1.5, 630) }
    const report = agreementVerdict(priv, LITERAL_PUBLIC)
    expect(report.verdict).toBe('diverge')
    expect(report.diverged).toEqual(['wall_clock:agent-with-state', 'wall_clock:agent-from-scratch'])
  })

  test('every ratio halved stays on the same side and inside one order, so it publishes', () => {
    const priv: SummaryLike = { ...LITERAL_PUBLIC, warpline: arm(760 / 2, 630 / 2) }
    const report = agreementVerdict(priv, LITERAL_PUBLIC)
    expect(report.verdict).toBe('publish')
    expect(report.diverged).toEqual([])
  })

  test('a public set with a shortfall is a caller error, not a withhold', () => {
    const pub: SummaryLike = { ...LITERAL_PUBLIC, warpline: { shortfall: { count: 9, threshold: 10 } } }
    expect(() => agreementVerdict(LITERAL_PUBLIC, pub)).toThrow(/public set/)
  })
})
