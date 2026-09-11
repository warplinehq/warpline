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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

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

  const resultAdds = git(repoRoot, ['log', '--diff-filter=A', '--format=%H', '--', RESULTS])
    .split('\n')
    .filter(Boolean)

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
    const full = join(root, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, body)
    git(root, ['add', '--', path])
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
      `fixture commit ${i}`,
    ])
    shas.push(git(root, ['rev-parse', 'HEAD']))
  }
  return { root, shas }
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
