/**
 * Every example test that creates a temp directory also removes one.
 *
 * CLAUDE.md rule 2 says tests never write outside temp dirs, and every
 * example test honours it: each `withHome` re-roots `WARPLINE_HOME` to a
 * `mkdtemp` home. What the rule does not say is that the home comes back
 * down again, and for one phase none of them did — ten helpers restored the
 * env var in a `finally` and left the directory behind, several dozen
 * `<example>-XXXXXX` directories per full run, growing with every run.
 *
 * Structural, the way `import-direction.test.ts` is: a census of creation
 * sites against removal sites per file. A runtime check would have to
 * snapshot the system temp dir around a test file it does not control, and
 * every other process writing there would flake it. A site count is a
 * heuristic — one helper's `rm` can serve many callers — so the rule is "at
 * least as many removals as creations", which a tracking `afterEach` (one
 * `mkdtemp`, one `rm`) satisfies as well as a per-helper `finally` does.
 *
 * Same shape as `example-defaults.test.ts`: one helper taking a root and
 * returning offender strings, run against the real tree (must be empty) and
 * against a planted fixture (must name it), so the guard is provably
 * non-vacuous.
 */
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const EXAMPLES = join(REPO_ROOT, 'examples', 'plugins')

/** Call sites. An import names the function without the paren, so it does not count. */
const CREATES = /\bmkdtemp(?:Sync)?\(/g
const REMOVES = /\brm(?:Sync)?\(/g

const count = (source: string, pattern: RegExp): number => (source.match(pattern) ?? []).length

/**
 * `<plugin>/handler.test.ts: N created, M removed` for every example test
 * file under `root` that creates more temp directories than it removes.
 * A directory with no test file is skipped, not an offender.
 */
export function offenders(root: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    let source: string
    try {
      source = readFileSync(join(root, entry.name, 'handler.test.ts'), 'utf8')
    } catch {
      continue
    }
    const created = count(source, CREATES)
    const removed = count(source, REMOVES)
    if (created > removed) out.push(`${entry.name}/handler.test.ts: ${created} created, ${removed} removed`)
  }
  return out.sort()
}

describe('example tests remove the temp directories they create', () => {
  test('the real examples tree has no offender', () => {
    // Guarded against a wrong path: fewer directories than the tree is
    // known to hold is a mistaken root, not a shorter roster.
    expect(readdirSync(EXAMPLES).length).toBeGreaterThanOrEqual(12)
    expect(offenders(EXAMPLES)).toEqual([])
  })

  test('the guard names a planted test that creates and never removes, and passes one that does', () => {
    const root = mkdtempSync(join(tmpdir(), 'warpline-hygiene-'))
    try {
      mkdirSync(join(root, 'leaky'))
      writeFileSync(
        join(root, 'leaky', 'handler.test.ts'),
        "import { mkdtemp, rm } from 'node:fs/promises'\nconst home = await mkdtemp(join(tmpdir(), 'x-'))\n",
      )
      mkdirSync(join(root, 'tidy'))
      writeFileSync(
        join(root, 'tidy', 'handler.test.ts'),
        "const home = await mkdtemp(join(tmpdir(), 'x-'))\nawait rm(home, { recursive: true, force: true })\n",
      )
      mkdirSync(join(root, 'tracked'))
      writeFileSync(
        join(root, 'tracked', 'handler.test.ts'),
        "afterEach(() => rmSync(roots.pop()!, { recursive: true }))\nconst a = mkdtempSync('x-')\n",
      )
      mkdirSync(join(root, 'no-test'))
      expect(offenders(root)).toEqual(['leaky/handler.test.ts: 1 created, 0 removed'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
