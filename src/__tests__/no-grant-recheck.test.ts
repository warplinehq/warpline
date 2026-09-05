/**
 * The capability layer must never read the approval Grant a second time.
 *
 * The engine reads it once, before invocation, and passes the answer forward as
 * a witness. A second read inside the capability layer would be a second place
 * to get the gate wrong — and the second one sits inside code a plugin author
 * is holding, which is what makes it worse than the first rather than merely
 * redundant.
 *
 * The pitfall this closes is the confused deputy: the runtime holds authority
 * the plugin does not, and hands out a member on the strength of a check the
 * plugin's own caller never made. It is the only failure in this project's
 * pitfall corpus that FALSIFIES the central claim rather than degrading it.
 * Everything else makes the runtime worse at keeping its promise; this one
 * makes the promise untrue.
 *
 * A static assertion rather than a behavioural one, in the shape
 * `no-tui-rationale.test.ts` already ships: there is no input that makes a
 * needless extra read observable from the outside — it returns the same answer
 * the witness carries, right up until the day it does not.
 *
 * `/usr/bin/find` decides the file set and `/usr/bin/grep` selects the lines,
 * by absolute path in both cases. The bare names resolve to a different tool on
 * a developer machine here (ugrep, which honours ignore files when it walks a
 * directory itself) and that tool has already returned a false zero over this
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

/** The module that reads the grant file, and the function that performs the read. */
const FORBIDDEN = ['approval-gate', 'checkApproval']

/**
 * The non-test source files the capability layer owns.
 *
 * Enumerated by pattern, not named one at a time: a second capability module
 * added tomorrow is covered without anyone remembering to extend a list. A zero
 * result THROWS rather than returning an empty array — an enumeration that
 * found nothing is "did not look", and returning `[]` from it would report
 * silently, perfectly green.
 */
function capabilityLayer(): string[] {
  const out = execFileSync(
    FIND,
    [join(REPO_ROOT, 'src', 'runtime'), '-name', 'capabilit*.ts', '-not', '-path', '*__tests__*'],
    { encoding: 'utf8' },
  )
  const files = out.split('\n').filter(Boolean)
  if (files.length === 0) {
    throw new Error('blind: no capability-layer source file enumerated under src/runtime')
  }
  return files
}

/**
 * `<file>:<line>: <text>` for every line in `files` naming the grant reader.
 *
 * Takes the file list rather than computing it, so the identical code runs
 * against the real layer (must return `[]`) and against a temp-dir fixture that
 * has been deliberately broken (must return the file it was broken with). That
 * symmetry is what makes "this check goes red" provable rather than assumed.
 */
function grantReaders(files: string[]): string[] {
  const args = ['-nH', ...FORBIDDEN.flatMap((pattern) => ['-e', pattern]), ...files]
  try {
    return execFileSync(GREP, args, { encoding: 'utf8' }).split('\n').filter(Boolean)
  } catch (err) {
    // grep exits 1 for "no match", which is the passing case here. Any other
    // status is a real failure and must not be swallowed into a green result.
    const status = (err as { status?: number }).status
    if (status === 1) return []
    throw err
  }
}

describe('the capability layer never re-reads the approval grant', () => {
  test('no capability-layer source file names the grant reader', () => {
    const offenders = grantReaders(capabilityLayer()).map((line) =>
      line.startsWith(REPO_ROOT) ? line.slice(REPO_ROOT.length + 1) : line,
    )
    expect(offenders).toEqual([])
  })

  /**
   * The registry is empty of production members today, so the scan above passes
   * over one small file. This is what stops it being trusted on that basis: the
   * same helper, handed a file that does reach the grant reader, must report it.
   */
  test('the same helper reports a file that does reach it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'warpline-grant-recheck-'))
    try {
      const offending = join(dir, 'capabilities.ts')
      writeFileSync(offending, "import { checkApproval } from './approval-gate.js'\n")
      const clean = join(dir, 'capability-clean.ts')
      writeFileSync(clean, 'export const nothing = 1\n')

      const found = grantReaders([offending, clean]).map((line) => line.slice(dir.length + 1))
      expect(found).toEqual([
        "capabilities.ts:1:import { checkApproval } from './approval-gate.js'",
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  /**
   * The enumeration is only as good as its pattern. If a rename ever took
   * `capabilities.ts` out of the glob, the scan above would keep passing over
   * whatever was left — so pin the file the requirement is actually about.
   */
  test('the enumeration reaches the capability module itself', () => {
    expect(capabilityLayer()).toContain(join(REPO_ROOT, 'src', 'runtime', 'capabilities.ts'))
  })

  test('the search binaries are absolute paths', () => {
    expect([FIND, GREP]).toEqual(['/usr/bin/find', '/usr/bin/grep'])
  })
})
