/**
 * `warpline run` tests — in-process (D-27), no subprocess.
 *
 * `runPlugin(argv, signal)` returns a payload and an exit code instead of
 * printing and exiting, so the whole contract is assertable by calling it.
 * Plan 02-08 budgets the repository to exactly ONE subprocess-launching test
 * file (`run-sigint.test.ts`, for the SIGINT->130 path); do not spend it here.
 *
 * The fixture home is a temp dir whose `plugins/` is a symlink to
 * `test-utils/fixture-plugins`. Module resolution follows the symlink to its
 * real path, so each fixture's `../../../src/...` imports still resolve.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _setHome } from '../../lib/paths.js'
import { testFixturesDir } from '../../../test-utils/fixtures.js'
import { runPlugin } from '../run-plugin.js'

/** The stdout contract the board parses. Order is part of it (T-02-23). */
const PAYLOAD_KEYS = 'ok,error,duration_ms,attempt_count,cancelled,timed_out'

/**
 * The same names as raw identifiers. None of them may appear in human output —
 * that is the observable difference between the two renderings.
 */
const RAW_KEY_NAMES = PAYLOAD_KEYS.split(',')

let home: string

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'warpline-run-plugin-'))
  symlinkSync(
    testFixturesDir(import.meta.url, '../../../test-utils/fixture-plugins'),
    join(home, 'plugins'),
  )
  _setHome(home)
})

afterAll(() => {
  _setHome(null)
  rmSync(home, { recursive: true, force: true })
})

describe('runPlugin — payload and exit code', () => {
  test('returns the six documented keys, in order, with todays value types', async () => {
    const { payload, code } = await runPlugin(['success-plugin', 'run'])

    expect(Object.keys(payload).join()).toBe(PAYLOAD_KEYS)
    expect(code).toBe(0)
    expect(payload.ok).toBe(true)
    expect(payload.error).toBeUndefined()
    expect(typeof payload.duration_ms).toBe('number')
    expect(typeof payload.attempt_count).toBe('number')
    expect(payload.cancelled).toBe(false)
    expect(payload.timed_out).toBe(false)
  })

  test('a logical failure keeps exit 0 and reports it through ok/error', async () => {
    const good = await runPlugin(['success-plugin', 'run'])
    expect(good.code).toBe(0)
    expect(good.payload.ok).toBe(true)

    // invokePlugin converts handler throws AND handler failures into failed
    // SkillResults, so exit 0 means "the invocation ran" — `ok` carries the
    // logical outcome. The file header has documented this since Phase 121 and
    // the board relies on it; see SUMMARY deviation 1.
    const bad = await runPlugin(['nonretryable-fail-plugin', 'run'])
    expect(bad.code).toBe(0)
    expect(bad.payload.ok).toBe(false)
    expect(bad.payload.error).toBe('auth denied')

    // A plugin that cannot even be loaded takes the same route.
    const missing = await runPlugin(['no-such-plugin', 'run'])
    expect(missing.code).toBe(0)
    expect(missing.payload.ok).toBe(false)
    expect(missing.payload.error).toBeTruthy()
  })

  test('--retries is bounded to the inclusive range 0 through 10', async () => {
    expect((await runPlugin(['success-plugin', 'run', '--retries=0'])).code).toBe(0)
    expect((await runPlugin(['success-plugin', 'run', '--retries=10'])).code).toBe(0)

    for (const flag of ['--retries=11', '--retries=-1', '--retries=abc']) {
      const rejected = await runPlugin(['success-plugin', 'run', flag])
      expect(rejected.code).toBe(1)
      expect(rejected.usageError).toContain('[0, 10]')
      // No invocation happened, so no invocation-derived field is present.
      expect(rejected.payload.duration_ms).toBeUndefined()
    }
  })

  test('an unknown flag is rejected by strict parsing before any invocation', async () => {
    const rejected = await runPlugin(['success-plugin', 'run', '--bogus'])

    expect(rejected.code).toBe(1)
    expect(rejected.usageError).toContain('bogus')
    expect(rejected.payload.duration_ms).toBeUndefined()
  })

  test('missing positional arguments produce the usage message', async () => {
    for (const argv of [[], ['success-plugin']]) {
      const rejected = await runPlugin(argv)
      expect(rejected.code).toBe(1)
      expect(rejected.usageError).toContain('Usage:')
      expect(rejected.payload.duration_ms).toBeUndefined()
    }
  })
})

describe('runPlugin — stdout rendering', () => {
  test('--json serializes the payload exactly as it always has', async () => {
    const good = await runPlugin(['success-plugin', 'run', '--json'])
    const goodJson = JSON.parse(good.stdout)
    // `error` is undefined on success, so JSON.stringify omits it — five keys
    // on the wire, six in memory. Serializing it as null instead would change
    // the bytes the board reads.
    expect(Object.keys(goodJson).join()).toBe(
      'ok,duration_ms,attempt_count,cancelled,timed_out',
    )
    expect(goodJson.ok).toBe(true)

    const bad = await runPlugin(['nonretryable-fail-plugin', 'run', '--json'])
    expect(Object.keys(JSON.parse(bad.stdout)).join()).toBe(PAYLOAD_KEYS)
    // In-memory order is the full six-key contract on both paths.
    expect(Object.keys(good.payload).join()).toBe(PAYLOAD_KEYS)
    expect(Object.keys(bad.payload).join()).toBe(PAYLOAD_KEYS)
  })

  test('the default rendering is prose carrying status, duration and attempts', async () => {
    const { stdout } = await runPlugin(['success-plugin', 'run'])

    expect(stdout).toContain('succeeded')
    expect(stdout).toMatch(/\d+ ms/)
    expect(stdout).toContain('1 attempt')
    for (const name of RAW_KEY_NAMES) {
      expect(stdout).not.toContain(name)
    }
    expect(() => JSON.parse(stdout)).toThrow()
  })

  test('a failed invocation names the failure in prose', async () => {
    const { stdout, code, payload } = await runPlugin([
      'nonretryable-fail-plugin',
      'run',
    ])

    expect(stdout).toContain('failed')
    expect(stdout).toContain('auth denied')
    // Exit 0: the invocation ran and reported a logical failure. See the
    // exit-code test above and SUMMARY deviation 1.
    expect(code).toBe(0)
    expect(payload.ok).toBe(false)
    for (const name of RAW_KEY_NAMES) {
      expect(stdout).not.toContain(name)
    }
  })

  test('timed-out and interrupted invocations render distinguishably', async () => {
    const timedOut = await runPlugin(['abort-unaware-plugin', 'run'])
    expect(timedOut.payload.timed_out).toBe(true)
    expect(timedOut.stdout).toContain('timed out')

    const interrupted = await runPlugin(
      ['abort-aware-plugin', 'run'],
      AbortSignal.abort(),
    )
    expect(interrupted.payload.cancelled).toBe(true)
    expect(interrupted.stdout).toContain('interrupted')

    expect(interrupted.stdout).not.toBe(timedOut.stdout)
    for (const name of RAW_KEY_NAMES) {
      expect(timedOut.stdout).not.toContain(name)
      expect(interrupted.stdout).not.toContain(name)
    }
  })

  test('the prose duration corresponds to the payloads millisecond value', async () => {
    const { stdout, payload } = await runPlugin(['success-plugin', 'run'])

    // Sub-second invocations print the raw millisecond value; the machine path
    // is never rounded, so the two must agree digit for digit here.
    expect(payload.duration_ms).toBeLessThan(1000)
    expect(stdout).toContain(`${payload.duration_ms} ms`)
  })
})
