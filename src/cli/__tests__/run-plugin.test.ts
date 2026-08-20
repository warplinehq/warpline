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
