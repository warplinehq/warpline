/**
 * Exactly two non-test source files name the mint, and both are named here.
 *
 * The runtime keeps two separate invariants about capabilities, and they read
 * like a contradiction until you notice they are about different files. The
 * DECLARATION is what mints a member — the manifest says what a plugin
 * performs, and the mint hands over only what was declared. The ENGINE is what
 * reads the Grant, once, before invocation. One of each, in different files.
 * That is why "the capability layer never re-reads the grant" and "authority
 * flows only from a checked grant" can both be true at once, and it is why
 * neither one is a rule about the same piece of code.
 *
 * This file mechanises the second half of that: the mint is reachable from
 * `invokePlugin` and from nowhere else, so there is no path from the approve
 * verb — the thing that WRITES the grant — to a capability. Written down in
 * `docs/runtime-spec.md` as prose, and prose has no compiler; a documented
 * invariant nothing checks is a sentence, and this is the cheap way to make it
 * a guard.
 *
 * **Set equality, not membership.** A file ADDED to the set must redden, which
 * is the case the invariant is about. A file REMOVED must redden too, which is
 * the case a membership test would sail past: if `invoke-plugin.ts` stopped
 * calling the mint, every handler would receive an object nobody minted, and a
 * `toContain` assertion over the remaining file would still be green.
 *
 * **The scan is on the bare identifier, so a mere mention counts.** That is
 * deliberate and it is the same bluntness `no-grant-recheck.test.ts` keeps: a
 * scan for `mintContext(` misses `const m = mintContext` and misses a
 * re-export, and both of those are the reach this exists to refuse. The cost is
 * that a doc comment naming the identifier trips it — which is why
 * `src/unstable-capabilities.ts` describes the mint in words rather than by
 * name. That cost is the right way round: a guard that a comment can trip is
 * noisy, and a guard a comment can slip past is useless.
 *
 * `/usr/bin/find` decides the file set and `/usr/bin/grep` selects the lines,
 * by absolute path in both cases. The bare names resolve to a different tool on
 * a developer machine here — one that honours ignore files when it walks a
 * directory itself, and that has already returned a false zero over this
 * repository once. Separating enumeration from search makes an ignore file
 * irrelevant by construction rather than by trusting a flag.
 *
 * Why a test rather than a lint script: `bun test` is the command CI runs and
 * the one the contributor guide names, so the check cannot be skipped by
 * forgetting a second command.
 */
import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..')

const FIND = '/usr/bin/find'
const GREP = '/usr/bin/grep'

/** The name the mint is called by. One identifier, scanned bluntly. */
const MINT = 'mintContext'

/**
 * The two files allowed to name it: the module that defines it, and the one
 * function every caller of the runtime routes through.
 */
const ALLOWED = [
  'src/runtime/capabilities.ts',
  'src/runtime/invoke-plugin.ts',
].sort()

/**
 * Every non-test TypeScript file under `src/`.
 *
 * `find` rather than `git ls-files`: an untracked new module that reaches the
 * mint is exactly the file this exists to catch, and `git ls-files` reports the
 * index. A zero result THROWS rather than returning an empty array — an
 * enumeration that found nothing is "did not look", and returning `[]` from it
 * would report silently, perfectly green.
 */
function sourceFiles(): string[] {
  const out = execFileSync(
    FIND,
    [join(REPO_ROOT, 'src'), '-name', '*.ts', '-not', '-path', '*__tests__*'],
    { encoding: 'utf8' },
  )
  const files = out.split('\n').filter(Boolean)
  if (files.length === 0) {
    throw new Error('blind: no non-test source file enumerated under src')
  }
  return files
}

/**
 * The files in `files` that name the mint, repo-relative and sorted.
 *
 * Takes the file list rather than computing it, so the identical code runs
 * against the real tree and against a temp-dir fixture carrying a deliberate
 * third caller. That symmetry is what makes "this check goes red" provable
 * rather than assumed.
 */
function namesTheMint(files: string[], root: string): string[] {
  try {
    const out = execFileSync(GREP, ['-l', '-e', MINT, ...files], { encoding: 'utf8' })
    return out
      .split('\n')
      .filter(Boolean)
      .map((f) => (f.startsWith(root) ? f.slice(root.length + 1) : f))
      .sort()
  } catch (err) {
    // grep exits 1 for "no match". Here that is not a passing case — the mint
    // must be named by two files — but it is still not an error to rethrow, so
    // it becomes an empty set and the equality assertion reports what is
    // missing by name. Any other status is a real failure.
    const status = (err as { status?: number }).status
    if (status === 1) return []
    throw err
  }
}

describe('there is no path from the approve verb to a capability', () => {
  test('exactly two non-test source files name the mint', () => {
    expect(namesTheMint(sourceFiles(), REPO_ROOT)).toEqual(ALLOWED)
  })

  test('the enumeration reaches both of the files it is about', () => {
    const enumerated = sourceFiles().map((f) => f.slice(REPO_ROOT.length + 1))
    for (const allowed of ALLOWED) {
      expect(enumerated).toContain(allowed)
    }
  })

  /**
   * The green above is over a set of exactly two. This is what stops it being
   * trusted on that basis: the same helper, handed a tree with a third caller
   * in it, must report the third caller by name.
   */
  test('the same helper reports a third file that names the mint', () => {
    const dir = mkdtempSync(join(tmpdir(), 'warpline-mint-call-sites-'))
    try {
      const defining = join(dir, 'capabilities.ts')
      writeFileSync(defining, `export function ${MINT}() { return {} }\n`)
      const caller = join(dir, 'invoke-plugin.ts')
      writeFileSync(caller, `import { ${MINT} } from './capabilities.js'\n`)
      const intruder = join(dir, 'approve.ts')
      writeFileSync(intruder, `import { ${MINT} } from './capabilities.js'\n`)
      const clean = join(dir, 'unrelated.ts')
      writeFileSync(clean, 'export const nothing = 1\n')

      expect(namesTheMint([defining, caller, intruder, clean], dir)).toEqual([
        'approve.ts',
        'capabilities.ts',
        'invoke-plugin.ts',
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  /**
   * The other direction, which a membership assertion would sail past: a file
   * that stops naming the mint must redden too. A runtime where `invokePlugin`
   * no longer calls it hands every handler an object nobody minted.
   */
  test('the same helper reports a set that has LOST a caller', () => {
    const dir = mkdtempSync(join(tmpdir(), 'warpline-mint-call-sites-lost-'))
    try {
      const defining = join(dir, 'capabilities.ts')
      writeFileSync(defining, `export function ${MINT}() { return {} }\n`)
      const caller = join(dir, 'invoke-plugin.ts')
      writeFileSync(caller, 'export const nothingCallsTheMintAnyMore = 1\n')

      expect(namesTheMint([defining, caller], dir)).toEqual(['capabilities.ts'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the search binaries are absolute paths', () => {
    expect([FIND, GREP]).toEqual(['/usr/bin/find', '/usr/bin/grep'])
  })
})
