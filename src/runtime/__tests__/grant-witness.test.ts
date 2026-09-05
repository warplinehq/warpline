/**
 * The engine's two witness arms, where they can be told apart.
 *
 * This file exists because of a recorded gap rather than a hunch. The arms
 * were a ternary inlined at the invocation call site, and with no gated member
 * in the capability registry, swapping them was green across the entire suite:
 * an ungated member is minted on either arm, so the choice had no observable
 * consequence anywhere a test could reach. A guard that runs green while the
 * thing it exists to catch sits outside its reach is this repository's
 * recorded failure, four times over. So the arms were extracted into a named
 * function and the function is asserted directly.
 *
 * **What this covers, and what it does not.** It covers the COMPUTATION —
 * which arm each input produces — and it covers that `engine.ts` uses the
 * function rather than an inline literal that could drift from it. It does not
 * cover the behavioural consequence of the arm choice end to end, because
 * there is none to observe yet: every registered member is ungated, so no
 * handler receives anything different on one arm than on the other. That case
 * arrives with the first member keyed on a real side effect, and it is that
 * plan's to write, not this one's to fake.
 *
 * `/usr/bin/grep` by absolute path, not the bare name: the bare name resolves
 * to a different tool on a developer machine here — one that honours ignore
 * files and has returned a false zero over this repository once already.
 */
import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { witnessAfterGrantRead } from '../engine.js'

const GREP = '/usr/bin/grep'
const ENGINE = join(import.meta.dir, '..', 'engine.js').replace(/\.js$/, '.ts')

/** `grep -c`, with "no match" reported as 0 rather than as a thrown exit 1. */
function countIn(pattern: string, file: string): number {
  try {
    return Number(execFileSync(GREP, ['-cE', pattern, file], { encoding: 'utf8' }).trim())
  } catch {
    return 0
  }
}

describe('the witness a plugin gets after the grant read', () => {
  /**
   * A plugin declaring side effects reached the invocation only because the
   * dueness check read the Grant and it returned true. The granted arm records
   * the scope that read asked about.
   */
  test('a plugin declaring side effects is granted, for the scope that was asked about', () => {
    expect(witnessAfterGrantRead('mailer', ['sends_email'])).toEqual({
      granted: true,
      scope: 'mailer',
    })
  })

  /**
   * A plugin declaring nothing never consulted the Grant at all, so the honest
   * answer is not-granted with the reason saying which of the two not-granted
   * cases this is — never `manual-run`, which belongs to the CLI.
   */
  test('a plugin declaring no side effects is not granted, and says why', () => {
    expect(witnessAfterGrantRead('reader', [])).toEqual({
      granted: false,
      reason: 'no-declared-side-effects',
    })
  })

  /**
   * The two arms are the whole function, and swapping them reddens both tests
   * above by name. Asserting the pair are different is not the same assertion:
   * it is the one that stays true under a swap, which is why both arms are
   * written out in full above rather than compared to each other.
   */
  test('the scope is the plugin name asked about, not a wildcard or a constant', () => {
    const first = witnessAfterGrantRead('alpha', ['writes_db'])
    const second = witnessAfterGrantRead('beta', ['writes_db'])
    expect(first).toEqual({ granted: true, scope: 'alpha' })
    expect(second).toEqual({ granted: true, scope: 'beta' })
  })

  /**
   * The unit tests above cover the function. This is what makes them cover the
   * ENGINE: they are worthless if `engine.ts` builds a witness literal of its
   * own beside the function, which is precisely the shape the arms had before
   * they were extracted.
   */
  test('engine.ts builds no witness literal of its own', () => {
    expect(countIn('witnessAfterGrantRead', ENGINE)).toBeGreaterThanOrEqual(2)
    expect(countIn('granted: true', ENGINE)).toBe(1)
    expect(countIn("reason: 'no-declared-side-effects'", ENGINE)).toBe(1)
  })
})
