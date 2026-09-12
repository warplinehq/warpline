/**
 * The benchmark method is checkable before the result, and this file is what
 * makes that claim checkable rather than stated.
 *
 * Two properties, both about `bench/PRE-REGISTRATION.md`:
 *
 *   1. **Ordering, by topology.** The commit that first added the method is a
 *      git ANCESTOR of every commit that added a file under `bench/results/`.
 *      Ancestry and not a timestamp comparison: a rebase or an amend rewrites
 *      every date in a repository and moves no edge in the graph, so a date
 *      check is a check of what somebody typed and an ancestry check is a check
 *      of what happened.
 *   2. **Freeze, by blob identity.** The method's blob hash as of the first
 *      results commit equals its blob hash at the tip. That is the property
 *      that delivers editable-until-a-result-exists rather than
 *      first-draft-is-final: the file may be rewritten freely while
 *      `bench/results/` is empty, and not one byte after.
 *
 * Neither check can report clean over history it cannot see, so a shallow
 * repository throws. Continuous integration already checks this repository out
 * with `fetch-depth: 0` for the existing private-reference guard, so this needs
 * no workflow change.
 *
 * Every fixture is a real git repository under `os.tmpdir()`, removed in a
 * `finally`. The scan is parameterised by root for that reason: a closure over
 * this repository's path can only ever be asserted passing, and a guard that
 * has only been watched passing is what this project has already paid for four
 * times.
 */
import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..')

/** The two tracked paths the ordering property is about. */
const PRE_REG = 'bench/PRE-REGISTRATION.md'
const RESULTS = 'bench/results'

/**
 * Fixture commits must not inherit the operator's global git configuration.
 * A global `commit.gpgsign`, a `core.hooksPath` pointing at a hook that runs a
 * suite, or a commit template all break a fixture commit on one machine and
 * pass on another — and the failure surfaces as though the scan were wrong.
 */
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', env: GIT_ENV }).trim()
}

/**
 * A finding names a short SHA or a path and NOTHING else — no commit message,
 * no file body. Continuous-integration logs are public, and that is the output
 * rule the private-reference guard already sets one level down.
 */
export type AncestryFinding =
  | { kind: 'results-before-method'; commit: string }
  | { kind: 'method-changed-after-results'; path: string }

/** Exit status 1 is the answer "no"; anything else is a broken invocation. */
function isAncestor(root: string, ancestor: string, descendant: string): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
      cwd: root,
      env: GIT_ENV,
      stdio: 'ignore',
    })
    return true
  } catch (err) {
    if ((err as { status?: number }).status !== 1) throw err
    return false
  }
}

/**
 * The method's blob hash at `rev`, or null when the path is not in that tree.
 *
 * git's stderr is dropped rather than inherited: "not in that tree" is ordinary
 * control flow here, and a `fatal:` line in a suite's output trains its reader
 * to skim past `fatal:` lines.
 */
function blobAt(root: string, rev: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', `${rev}:${PRE_REG}`], {
      cwd: root,
      encoding: 'utf8',
      env: GIT_ENV,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

/**
 * Every way the ordering or the freeze is violated in `repoRoot`, by short SHA
 * and path.
 *
 * The blob comparison takes the method AS OF the commit before the first
 * results commit, falling back to the first results commit itself when that
 * commit has no parent. Both readings of "unchanged since results existed"
 * agree wherever a parent exists, and the fallback is what keeps a fixture
 * whose results commit is the root commit from throwing instead of reporting
 * the ordering violation it is there to report. A null base means the method
 * was not in the tree when the first result landed, which the ancestry pass
 * has already reported — so there is nothing to compare and nothing to add.
 */
function preRegAncestry(repoRoot: string): AncestryFinding[] {
  const shallow = git(repoRoot, ['rev-parse', '--is-shallow-repository'])
  if (shallow !== 'false') {
    throw new Error(
      'shallow clone: an ordering check over history it cannot see reports clean while meaning it did not look. Run `git fetch --unshallow`, or check out with fetch-depth: 0.',
    )
  }

  const methodAdds = git(repoRoot, ['log', '--diff-filter=A', '--format=%H', '--', PRE_REG])
    .split('\n')
    .filter(Boolean)
  if (methodAdds.length === 0) {
    throw new Error(
      `no commit adds ${PRE_REG}: an ordering check with nothing to order is blind, not clean`,
    )
  }
  // git logs newest first, so the oldest add is the last line.
  const method = methodAdds[methodAdds.length - 1]!

  // `--full-history -m` and not the plain form the method path uses above.
  // git computes no diff for a merge commit unless it is asked to, so
  // `--diff-filter=A` alone cannot match one, and a results file that enters
  // the tree IN a merge is missing from the roster entirely. Both halves below
  // then report clean while meaning they did not look: the ancestry loop
  // iterates nothing and the freeze comparison is gated on this same roster.
  // `-m` prints a merge once per parent, so the dedupe is load-bearing, and a
  // Set preserves insertion order so the oldest add is still the last entry.
  const resultAdds = [
    ...new Set(
      git(repoRoot, ['log', '--full-history', '-m', '--diff-filter=A', '--format=%H', '--', RESULTS])
        .split('\n')
        .filter(Boolean),
    ),
  ]

  // Blind is not clean, and this is the roster where that mattered: a tracked
  // result with no add commit in reach leaves the freeze nothing to measure
  // against, which is indistinguishable from a clean tree. The method path
  // already refuses this; this one used to be allowed to be silently empty.
  const trackedResults = git(repoRoot, ['ls-files', '-z', '--', RESULTS]).split('\0').filter(Boolean)
  if (trackedResults.length > 0 && resultAdds.length === 0) {
    throw new Error(
      `${trackedResults.length} tracked file(s) under ${RESULTS} and no commit that adds one: the freeze has nothing to compare against, which is blind rather than clean`,
    )
  }

  const findings: AncestryFinding[] = []
  for (const sha of resultAdds) {
    if (!isAncestor(repoRoot, method, sha)) {
      findings.push({ kind: 'results-before-method', commit: sha.slice(0, 7) })
    }
  }

  if (resultAdds.length > 0) {
    const first = resultAdds[resultAdds.length - 1]!
    const base = blobAt(repoRoot, `${first}^`) ?? blobAt(repoRoot, first)
    if (base !== null && base !== blobAt(repoRoot, 'HEAD')) {
      findings.push({ kind: 'method-changed-after-results', path: PRE_REG })
    }
  }

  return findings
}

/**
 * A repository under `mkdtemp` and nowhere else — tests never write inside this
 * repository. Returns the root and the commit SHAs in the order they were made,
 * so an assertion can name the offending commit instead of counting findings.
 */
function fixture(commits: { path: string; body: string }[]): { root: string; shas: string[] } {
  const root = mkdtempSync(join(tmpdir(), 'warpline-prereg-'))
  git(root, ['init', '-q'])
  const shas: string[] = []
  for (const [i, { path, body }] of commits.entries()) {
    stage(root, path, body)
    commit(root, `fixture commit ${i}`)
    shas.push(git(root, ['rev-parse', 'HEAD']))
  }
  return { root, shas }
}

/** Write a file inside a fixture and stage it. */
function stage(root: string, path: string, body: string): void {
  const full = join(root, path)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, body)
  git(root, ['add', '--', path])
}

/** Commit whatever is staged, with the identity `GIT_ENV` leaves unset. */
function commit(root: string, message: string): void {
  git(root, [
    '-c',
    'user.name=fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '-m',
    message,
  ])
}

/**
 * The one shape a linear fixture cannot produce: the results entering the tree
 * IN a merge commit rather than in a commit with one parent.
 *
 * `git log` computes no diff for a merge unless it is asked to, so
 * `--diff-filter=A` cannot match one, and a results file that first appears in
 * the merge itself is absent from an enumeration that does not ask. Every other
 * fixture here is a straight line, which is why the gap survived review once.
 *
 *   * method edited after results   <- PRE-REGISTRATION.md rewritten
 *   *   the merge adds the results  <- bench/results/run-0001.json enters here
 *   |\
 *   | * side
 *   * | main
 *   |/
 *   * the method
 */
function mergeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'warpline-prereg-merge-'))
  git(root, ['init', '-q'])

  stage(root, METHOD.path, METHOD.body)
  commit(root, 'the method, before any run')
  // Read rather than assumed: GIT_CONFIG_GLOBAL is /dev/null here, so the
  // initial branch is whatever this git's compiled-in default is.
  const main = git(root, ['branch', '--show-current'])

  git(root, ['checkout', '-q', '-b', 'side'])
  stage(root, 'side.md', 'a change on the side branch\n')
  commit(root, 'side')

  git(root, ['checkout', '-q', main])
  stage(root, 'main.md', 'a change on the main branch\n')
  commit(root, 'main')

  // --no-commit is what lets the results land in the merge commit itself. Its
  // output is dropped for the reason `blobAt` drops git's stderr: "stopped
  // before committing as requested" is this fixture working, and a suite that
  // prints git chatter trains its reader to skim git chatter.
  execFileSync('git', ['merge', '--no-ff', '--no-commit', 'side'], { cwd: root, env: GIT_ENV, stdio: 'ignore' })
  stage(root, RESULT.path, RESULT.body)
  commit(root, 'the merge that also adds the results')

  stage(root, METHOD_EDITED.path, METHOD_EDITED.body)
  commit(root, 'the method, rewritten once a result existed')

  return root
}

const METHOD = { path: PRE_REG, body: 'the method, as written before any run\n' }
const METHOD_EDITED = { path: PRE_REG, body: 'the method, quietly rewritten\n' }
const RESULT = { path: `${RESULTS}/run-0001.json`, body: '{"iteration":1}\n' }

describe('the pre-registration is committed before the first result and frozen after', () => {
  /**
   * The violation this whole file exists for: a method committed after the
   * numbers it claims to predate. Same branch, reversed order, so the ordering
   * is wrong in the graph and not merely in the dates.
   */
  test('a results commit the method does not precede is reported by short sha', () => {
    const { root, shas } = fixture([RESULT, METHOD])
    try {
      expect(preRegAncestry(root)).toEqual([
        { kind: 'results-before-method', commit: shas[0]!.slice(0, 7) },
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  /**
   * The second violation, which ancestry alone cannot see: correct order, and
   * then the method edited once a result existed. Subsetting the scenario set
   * after seeing the numbers is the oldest benchmarking crime, and it leaves
   * exactly this trace.
   */
  test('a method edited after the first result is reported as a blob change by path', () => {
    const { root } = fixture([METHOD, RESULT, METHOD_EDITED])
    try {
      expect(preRegAncestry(root)).toEqual([{ kind: 'method-changed-after-results', path: PRE_REG }])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  /**
   * The same violation as above, arriving through a merge. Watched red before
   * the enumeration was fixed: the plain `--diff-filter=A` form printed
   * nothing, `git ls-files` listed one tracked result, and the scan returned an
   * empty offender list over a method rewritten after that result landed.
   *
   * The graph shape is asserted and not assumed. Without a merge commit
   * carrying the results this test would pass for the ordinary linear reason
   * and prove nothing about the enumeration.
   */
  test('a method edited after results that entered the tree in a merge commit is still reported', () => {
    const root = mergeFixture()
    try {
      expect(git(root, ['rev-list', '--merges', '--count', 'HEAD'])).toBe('1')
      expect(git(root, ['log', '--diff-filter=A', '--format=%h', '--', RESULTS])).toBe('')
      expect(git(root, ['ls-files', '--', RESULTS])).toBe(RESULT.path)

      expect(preRegAncestry(root)).toEqual([{ kind: 'method-changed-after-results', path: PRE_REG }])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  /**
   * The one roster in this file that used to be allowed to be silently empty.
   * A tracked result with no add commit in reach leaves the freeze with nothing
   * to measure against, and that reads exactly like a clean tree.
   */
  test('a tracked result with no commit that adds it throws rather than reporting clean', () => {
    const { root } = fixture([METHOD])
    try {
      stage(root, RESULT.path, RESULT.body)
      expect(git(root, ['log', '--diff-filter=A', '--format=%h', '--', RESULTS])).toBe('')
      expect(git(root, ['ls-files', '--', RESULTS])).toBe(RESULT.path)

      expect(() => preRegAncestry(root)).toThrow(/blind rather than clean/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a method committed first and unchanged since reports no offender', () => {
    const { root } = fixture([METHOD, RESULT])
    try {
      expect(preRegAncestry(root)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  /**
   * An enumeration that found nothing is red, not green. With no method in the
   * repository at all there is nothing to be an ancestor of anything, and a
   * scan that returned an empty offender list there would be reporting "clean"
   * while meaning "did not look".
   */
  test('a repository with no pre-registration throws naming the absent path', () => {
    const { root } = fixture([RESULT])
    try {
      expect(() => preRegAncestry(root)).toThrow(new RegExp(PRE_REG))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  /**
   * `git log` in a depth-1 checkout reports one commit and exits 0, so an
   * ordering check over history it cannot see is green by construction. Cloned
   * through a `file://` URL deliberately: git ignores `--depth` for a plain
   * local path and hands back a full clone, which would make this test pass for
   * the wrong reason — so the fixture's shallowness is asserted before the
   * refusal is.
   */
  test('a shallow repository throws rather than reporting clean over unseen history', () => {
    const { root } = fixture([METHOD, RESULT])
    const clone = mkdtempSync(join(tmpdir(), 'warpline-prereg-shallow-'))
    try {
      git(clone, ['clone', '-q', '--depth', '1', `file://${root}`, 'copy'])
      const shallow = join(clone, 'copy')
      expect(git(shallow, ['rev-parse', '--is-shallow-repository'])).toBe('true')
      expect(() => preRegAncestry(shallow)).toThrow(/shallow/)
    } finally {
      rmSync(clone, { recursive: true, force: true })
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('this repository reports no offender', () => {
    expect(preRegAncestry(REPO_ROOT)).toEqual([])
  })
})

/**
 * Three scans over the published benchmark tree, with three DIFFERENT scopes
 * that are deliberately never merged.
 *
 * The scope split is the whole design. A broad match on the word cost over
 * `bench/README.md` fails the very sentence the total-cost-of-ownership
 * requirement mandates — the README's first paragraph says what the harness
 * measures, and it has to say it. So the published prose gets a NARROW currency
 * pattern, the raw result JSON gets a BROAD one, and merging them would either
 * publish a spend figure or forbid the mandated paragraph.
 *
 * Narrow in PATTERN and not in ROSTER. The currency scan reads every markdown
 * file under `bench/` and not only the README: a second write-up, a prompt or a
 * fixture is published just as widely, and a guard that cannot fail for a file
 * is no guard for that file. `bench/PRE-REGISTRATION.md` is the one named
 * exemption, because § 11 sets the spend cap and the document is frozen.
 *
 * The competitor patterns live here rather than under `bench/`, and this file
 * is outside every roster below by construction: `scanCompetitors` reads
 * `bench/` only. A list of names we decline to publish must not itself be
 * published, and a test file carrying the patterns it searches for is legal
 * exactly when the searched tree does not contain it.
 */

/** The one literal `scanCurrency` allows: a spend CAP is not a spend FIGURE. */
const BUDGET_FLAG_ALLOWLIST = '--max-budget-usd'

/**
 * Symbols, three-letter codes and cost-per-unit phrasing.
 *
 * Case-INSENSITIVE on purpose, which is what makes the allowlist above
 * load-bearing rather than decorative: the cap flag ends in a lowercase
 * currency code at a word boundary, so an uppercase-only pattern would allow it
 * by accident and the allowlist would be dead code nobody could prove.
 *
 * The cost-per-unit alternatives are anchored on a UNIT noun after `per`, so
 * `marginal per-run cost` — the phrase the published README is required to
 * carry — cannot match, while `cost per thousand tokens` cannot hide.
 *
 * The requirement names three classes and the first version of this pattern
 * caught one. A monthly cost, a cost per seat and a projected annual saving all
 * read clean against a unit list of tokens and calls, so the time units, the
 * per-head units and the `monthly cost`/`annual saving` adjective form are all
 * here now, as are the two currency nouns beside `dollars`. `run` stays out of
 * the `per[-\s]` branch for the same reason it always was: the mandated phrase
 * is `per-run cost`.
 */
const CURRENCY_RE =
  /[$€£¥₹]|\b(?:usd|eur|gbp|jpy|chf|cad|aud|cny|inr)\b|\b(?:cost|price|spend|charge|saving)s?\s+per\s+(?:token|call|request|run|thousand|million|1[km]|day|week|month|year|seat|user)\b|\bper[-\s](?:token|1[km]|thousand|million|day|week|month|year|seat|user)\b|\b(?:monthly|annual|yearly|per-annum)\s+(?:cost|spend|saving|price|charge)s?\b|\bcents?\b|\bdollars?\b|\bpounds?\b|\beuros?\b/gi

/** Broad by design, over raw result JSON only. */
const RESULT_COST_RE = /cost/i

/**
 * Whole-word and CASE-SENSITIVE. Several of these are ordinary English words —
 * a case-insensitive scan would redden on prose about temporal ordering, which
 * is a guard red on arrival, which is a guard its reader learns to ignore.
 *
 * Additive, and not a claim to be exhaustive. Its purpose is to catch a
 * comparison creeping into published prose, not to enumerate a market.
 */
const COMPETITOR_PATTERNS: string[] = [
  'Trigger\\.dev',
  'Temporal',
  'Airflow',
  'Prefect',
  'Dagster',
  'Inngest',
  'Windmill',
  'n8n',
  'Zapier',
  'Make\\.com',
  'LangChain',
  'LangGraph',
  'CrewAI',
  'AutoGPT',
]

/**
 * An empty alternation matches nothing and reports perfectly green, so an
 * emptied list throws here rather than degrading into a guard that cannot fail.
 */
function competitorMatcher(patterns: string[]): RegExp {
  if (patterns.length === 0) {
    throw new Error('the competitor list is empty; an empty list is a guard that cannot fail')
  }
  return new RegExp(patterns.map((p) => `\\b${p}\\b`).join('|'), 'g')
}

const COMPETITOR_RE = competitorMatcher(COMPETITOR_PATTERNS)

const BINARY = /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|pdf|zip|lock)$/i

/** Every readable file under `dir`, relative to `root`. */
function walk(root: string, dir: string): string[] {
  if (!existsSync(dir)) return []
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...walk(root, full))
    else if (entry.isFile() && !BINARY.test(entry.name)) found.push(relative(root, full))
  }
  return found.sort()
}

/** The competitor scan's roster. Empty is blind, not clean, so it throws. */
function benchFiles(root: string): string[] {
  const files = walk(root, join(root, 'bench'))
  if (files.length === 0) throw new Error(`blind: no file enumerated under ${join(root, 'bench')}`)
  return files
}

/**
 * The cost scan's roster, and the ONE roster in this file that is allowed to be
 * empty. The results directory is created by the harness at run time, so this
 * scan has to be green from the first commit — see the test that says so.
 */
function resultFiles(root: string): string[] {
  return walk(root, join(root, 'bench', 'results')).filter((f) => f.endsWith('.json'))
}

/**
 * Offenders as `<path>:<line>: <matched token>` — the token that matched and
 * never the line it sat in. Continuous-integration logs are public and a
 * matched currency symbol names the problem precisely; the surrounding prose
 * adds nothing a reader opening the file would not get.
 */
function scanCurrency(root: string): string[] {
  // Every published markdown file under bench/, less the one named exemption.
  // Markdown only, and that matters: over the TypeScript sources the dollar
  // alternative matches every `${...}` in a template literal and the scan
  // reports dozens of offenders that are not figures.
  const scanned = benchFiles(root).filter((f) => f.endsWith('.md') && f !== PRE_REG)
  if (scanned.length === 0) throw new Error(`blind: no markdown file to scan under ${join(root, 'bench')}`)

  return scanned.flatMap((rel) =>
    readFileSync(join(root, rel), 'utf8')
      .split('\n')
      .flatMap((line, i) => {
        // The allowlist is a literal removal, not a line exemption: whatever is
        // left of the line after the cap flag is gone is still scanned.
        const stripped = line.split(BUDGET_FLAG_ALLOWLIST).join(' ')
        return [...stripped.matchAll(CURRENCY_RE)].map((m) => `${rel}:${i + 1}: ${m[0]}`)
      }),
  )
}

/** Offenders as `<path>: <key path>`, one per matching key or string value. */
function scanResultCost(root: string): string[] {
  const found: string[] = []
  for (const rel of resultFiles(root)) {
    const parsed: unknown = JSON.parse(readFileSync(join(root, rel), 'utf8'))
    const visit = (node: unknown, path: string): void => {
      if (typeof node === 'string') {
        if (RESULT_COST_RE.test(node)) found.push(`${rel}: ${path} (value)`)
        return
      }
      if (Array.isArray(node)) {
        node.forEach((child, i) => visit(child, path === '' ? String(i) : `${path}.${i}`))
        return
      }
      if (node !== null && typeof node === 'object') {
        for (const [key, child] of Object.entries(node)) {
          const next = path === '' ? key : `${path}.${key}`
          if (RESULT_COST_RE.test(key)) found.push(`${rel}: ${next}`)
          visit(child, next)
        }
      }
    }
    visit(parsed, '')
  }
  return found.sort()
}

/** Offenders as `<path>:<line>: <name>`. */
function scanCompetitors(root: string): string[] {
  return benchFiles(root).flatMap((rel) =>
    readFileSync(join(root, rel), 'utf8')
      .split('\n')
      .flatMap((line, i) => [...line.matchAll(COMPETITOR_RE)].map((m) => `${rel}:${i + 1}: ${m[0]}`)),
  )
}

/**
 * The EXISTING private-reference guard's opaque-identifier class, re-derived
 * from that guard's own source rather than copied.
 *
 * Copied, it would drift and this test would go on asserting about a pattern
 * the guard no longer uses. Re-derived, a change there is either reflected here
 * or turns this red on the declaration it can no longer find.
 */
const GUARD_SOURCE = 'src/__tests__/no-private-planning-refs.test.ts'

function planningRefPattern(): RegExp {
  const source = readFileSync(join(REPO_ROOT, GUARD_SOURCE), 'utf8')
  const declared = source.match(/^const PLANNING_REF = \/(.+)\/$/m)
  if (!declared) {
    throw new Error(`blind: ${GUARD_SOURCE} no longer declares the pattern class this test re-derives`)
  }
  return new RegExp(declared[1]!)
}

function planningRefOffenders(root: string): string[] {
  const pattern = planningRefPattern()
  return benchFiles(root).flatMap((rel) =>
    readFileSync(join(root, rel), 'utf8')
      .split('\n')
      .flatMap((line, i) => (pattern.test(line) ? [`${rel}:${i + 1}`] : [])),
  )
}

/** A planted opaque identifier, assembled so this file does not carry one. */
const PLANTED_REF = `${'Phase'} ${7}`

describe('nothing published under bench/ carries a figure, a rival or a private identifier', () => {
  test('a currency symbol in the published README is reported by file and line', () => {
    const root = mkdtempSync(join(tmpdir(), 'warpline-currency-'))
    try {
      mkdirSync(join(root, 'bench'), { recursive: true })
      const readme = join(root, 'bench', 'README.md')
      writeFileSync(readme, 'The harness measures marginal per-run cost.\nEach pass came to $4.10.\n')
      expect(scanCurrency(root)).toEqual(['bench/README.md:2: $'])

      writeFileSync(readme, 'The harness measures marginal per-run cost.\n')
      expect(scanCurrency(root)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  /**
   * The roster and the pattern, in one fixture, because the scan used to read
   * `bench/README.md` and nothing else while the requirement names three
   * classes of figure and the pattern caught one.
   *
   * A second write-up under `bench/` is published as widely as the README, so
   * its monthly cost is reported by its own path. The frozen method is the ONE
   * named exemption and carries a figure here to prove the exemption is real
   * rather than a side effect of the roster having been one file long.
   */
  test('a figure in a second published markdown file is reported, and the frozen method is exempt by name', () => {
    const root = mkdtempSync(join(tmpdir(), 'warpline-currency-roster-'))
    try {
      mkdirSync(join(root, 'bench'), { recursive: true })
      writeFileSync(join(root, 'bench', 'README.md'), 'The harness measures marginal per-run cost.\n')
      writeFileSync(join(root, PRE_REG), 'The cap is 5 USD a session, and this file is frozen.\n')
      writeFileSync(
        join(root, 'bench', 'notes.md'),
        'A monthly cost of 240.\nA projected annual saving, and 40 per seat.\nIt came to 12 pounds.\n',
      )

      expect(scanCurrency(root)).toEqual([
        'bench/notes.md:1: monthly cost',
        'bench/notes.md:2: annual saving',
        'bench/notes.md:2: per seat',
        'bench/notes.md:3: pounds',
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  /**
   * A roster of nothing reports clean, and this scan's roster is now derived
   * rather than hardcoded, so it can become empty without the tree being empty.
   */
  test('a bench tree with no markdown at all is blind rather than clean', () => {
    const root = mkdtempSync(join(tmpdir(), 'warpline-currency-blind-'))
    try {
      mkdirSync(join(root, 'bench'), { recursive: true })
      writeFileSync(join(root, 'bench', 'run.ts'), 'const spend = `${12} USD`\n')
      expect(() => scanCurrency(root)).toThrow(/blind/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  /**
   * All of them, never the first one. A scan reported by count, or a fixture
   * carrying one field, is how this project's recorded leak class recurs: the
   * guard names the field somebody thought of and stays silent about the two
   * beside it.
   */
  test('every spend field in a result record is reported, and a spend phrase inside a value too', () => {
    const root = mkdtempSync(join(tmpdir(), 'warpline-result-cost-'))
    try {
      mkdirSync(join(root, 'bench', 'results'), { recursive: true })
      writeFileSync(
        join(root, 'bench', 'results', 'run-0001.json'),
        JSON.stringify({
          arm: 'warpline',
          total_cost_usd: 1.23,
          models: [{ id: 'a-model', cost: 0.41 }],
          cost_basis: 'list',
          notes: 'quoted at cost per thousand tokens',
        }),
      )
      expect(scanResultCost(root)).toEqual([
        'bench/results/run-0001.json: cost_basis',
        'bench/results/run-0001.json: models.0.cost',
        'bench/results/run-0001.json: notes (value)',
        'bench/results/run-0001.json: total_cost_usd',
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  /**
   * The allowlist is a LITERAL and not a line exemption: the flag name is
   * stripped wherever it appears and everything left over is still scanned, so
   * a figure sharing a line with the flag is reported rather than excused.
   */
  test('the spend-cap flag is allowed and every other match in the same file is not', () => {
    const root = mkdtempSync(join(tmpdir(), 'warpline-allowlist-'))
    try {
      mkdirSync(join(root, 'bench'), { recursive: true })
      writeFileSync(
        join(root, 'bench', 'README.md'),
        `Each session stops at ${BUDGET_FLAG_ALLOWLIST} 5.\nThe cap ${BUDGET_FLAG_ALLOWLIST} 5 sat beside a 12 USD total.\n`,
      )
      expect(scanCurrency(root)).toEqual(['bench/README.md:2: USD'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  /**
   * The one vacuous pass in this file, deliberate and named.
   *
   * Every other guard here throws on an empty roster, because a scan that
   * passed for want of files is indistinguishable from a scan that passed
   * because the files are clean. This one must be green from the first commit —
   * the results directory is written by the harness at run time — so the
   * emptiness is asserted rather than assumed.
   *
   * Over a FIXTURE and never over this repository: asserting the real results
   * roster is empty is true today and false forever after the measured set
   * lands, and it would take the suite red with it.
   */
  test('an existing but empty results directory reports clean, and the empty roster is asserted', () => {
    const root = mkdtempSync(join(tmpdir(), 'warpline-empty-results-'))
    try {
      mkdirSync(join(root, 'bench', 'results'), { recursive: true })
      expect(resultFiles(root)).toEqual([])
      expect(scanResultCost(root)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a rival product named under bench/ is reported by path and line, and its absence is clean', () => {
    const root = mkdtempSync(join(tmpdir(), 'warpline-competitor-'))
    try {
      mkdirSync(join(root, 'bench'), { recursive: true })
      writeFileSync(join(root, 'bench', 'README.md'), 'The method, in brief.\n')
      const rival = join(root, 'bench', 'comparison.md')
      writeFileSync(rival, 'Three arms.\nRoughly four times faster than Airflow.\n')
      expect(scanCompetitors(root)).toEqual(['bench/comparison.md:2: Airflow'])

      rmSync(rival)
      expect(benchFiles(root).length).toBeGreaterThan(0)
      expect(scanCompetitors(root)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('an emptied competitor list throws instead of matching nothing', () => {
    expect(COMPETITOR_PATTERNS.length).toBeGreaterThanOrEqual(10)
    expect(() => competitorMatcher([])).toThrow(/guard that cannot fail/)
  })

  /**
   * The one test here that exercises an EXISTING guard rather than a new one.
   *
   * The pattern class and the roster are two separate claims. This pins the
   * pattern, over a planted file; the roster half is pinned by asserting that
   * `bench/` is tracked at all, because that guard enumerates `git ls-files`
   * with no pathspec and a tracked file is exactly what puts it in reach. Both
   * were also watched together out of band: a planted file staged under
   * `bench/` turned the real guard red naming that path, and was removed.
   */
  test('an opaque planning identifier under bench/ is caught, and bench/ is in the roster that catches it', () => {
    const root = mkdtempSync(join(tmpdir(), 'warpline-planning-ref-'))
    try {
      mkdirSync(join(root, 'bench'), { recursive: true })
      writeFileSync(join(root, 'bench', 'notes.md'), `A planted line naming ${PLANTED_REF}.\n`)
      expect(planningRefOffenders(root)).toEqual(['bench/notes.md:1'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }

    const tracked = execFileSync('git', ['ls-files', '-z', '--', 'bench'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: GIT_ENV,
    })
      .split('\0')
      .filter(Boolean)
    expect(tracked.length).toBeGreaterThan(0)
    expect(planningRefOffenders(REPO_ROOT)).toEqual([])
  })

  /**
   * Offender lists only. Never the rosters: `bench/results/` is empty today and
   * will not be, and a test asserting otherwise is a scheduled failure.
   */
  test('the real bench tree has no offender under any of the three scans', () => {
    expect(scanCurrency(REPO_ROOT)).toEqual([])
    expect(scanResultCost(REPO_ROOT)).toEqual([])
    expect(scanCompetitors(REPO_ROOT)).toEqual([])
  })
})
