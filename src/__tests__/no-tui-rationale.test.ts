/**
 * Keeps a retired rationale retired.
 *
 * Several comments in `src/` used to justify the board event shape — flat,
 * scalar, 200-character summary — as a constraint imposed by a terminal UI
 * framework. That framework is not a dependency, the TUI it names was never
 * built, and the board spec has been rewritten around the web Board. The
 * comments outlived the thing they described and were, by the time they were
 * removed, the standing argument against adding run linkage to a board event.
 *
 * The constraints themselves are real and are still enforced and still
 * explained — `src/schemas/__tests__/board.test.ts` asserts both. Only the
 * attribution went.
 *
 * A dead justification is worse than no comment: it reads as a reason, so the
 * next person weighs a change against a framework nobody here uses. This test
 * is what stops it being pasted back in.
 *
 * Why a test rather than a lint script: `bun test` is the command CI runs and
 * the one CONTRIBUTING names, so the check cannot be skipped by forgetting a
 * second command — the same reasoning as `no-private-planning-refs.test.ts`,
 * from which this borrows both load-bearing conventions.
 */
import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..')

/** This file necessarily contains the pattern it searches for. */
const SELF = 'src/__tests__/no-tui-rationale.test.ts'

/**
 * The retired framework name, case-sensitive and whole-word. Case-sensitive
 * because the lowercase spelling is an ordinary English word that appears in
 * "linking", "thinking" and every other innocent hit; whole-word for the same
 * reason one level up.
 */
const RETIRED_RATIONALE = /\bInk\b/

/**
 * Coverage comes from `git ls-files`, never a hand-maintained glob list. A
 * list reports "clean" when it means "did not look", and the two are
 * indistinguishable from the outside — the one property a guard must not have.
 * Asking git removes the choice, and a file added to `src/` tomorrow is
 * covered without anyone remembering to add it here.
 */
function scanSrc(): string[] {
  const tracked = execFileSync('git', ['ls-files', '-z', 'src'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean)
    .filter((f) => f !== SELF)

  return tracked.flatMap((file) => {
    // `git ls-files` reports the INDEX, not the working tree: a file removed
    // with plain `rm`, or a path mid-rebase, gives an entry with nothing to
    // read. Skipping it is the same outcome as not looking, but the
    // alternative is taking the whole guard down during exactly the file
    // moves that most need checking.
    let text: string
    try {
      text = readFileSync(join(REPO_ROOT, file), 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      return []
    }
    return text
      .split('\n')
      .flatMap((line, i) =>
        RETIRED_RATIONALE.test(line) ? [`${file}:${i + 1}: ${line.trim()}`] : [],
      )
  })
}

describe('the retired TUI-framework rationale stays retired', () => {
  test('no file in src/ carries it — offenders report path:line', () => {
    expect(scanSrc()).toEqual([])
  })

  /**
   * The scan is only as good as its pattern, and a pattern that matched
   * nothing would pass this file vacuously forever. Two shapes that must hit,
   * two that must not.
   */
  test('the pattern matches the rationale and not the ordinary word', () => {
    const misses = [' * Ink constraint: fields MUST be flat', "React keys in Ink's reconciler"].filter(
      (l) => !RETIRED_RATIONALE.test(l),
    )
    const overMatches = ['linking two records', 'the thinking behind it'].filter((l) =>
      RETIRED_RATIONALE.test(l),
    )
    expect([...misses, ...overMatches]).toEqual([])
  })

  /**
   * SELF is exempt from the scan because it spells out the pattern it hunts
   * for. The exemption is only safe while the file it names exists — a rename
   * would turn the exemption into a hole and the scan into a check of one
   * fewer file, silently.
   */
  test('the self-exemption names a file that exists', () => {
    const tracked = execFileSync('git', ['ls-files', '-z', 'src'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).split('\0')
    expect(tracked).toContain(SELF)
  })
})
