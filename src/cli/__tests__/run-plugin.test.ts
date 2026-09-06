/**
 * `warpline run` tests — in-process, no subprocess.
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
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _setHome } from '../../lib/paths.js'
import { PluginConfigSchema } from '../../schemas/plugin-config.js'
import { testFixturesDir } from '../../../test-utils/fixtures.js'
import { runPlugin } from '../run-plugin.js'

/** The stdout contract the board parses. Order is part of it. */
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
    // logical outcome. The file header has documented this from the start and
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

/**
 * `--input key=value`: the one channel by which operator text reaches a
 * handler for a single run. The fixture home above symlinks `plugins/` to the
 * tracked fixtures, so this block has a home of its own with a real `plugins/`
 * and `config/`, and writes plugins whose handler succeeds ONLY on a predicate
 * over the args it received — the invoke-plugin-config pattern — so no fixture
 * ever echoes a value and every assertion is on `payload.ok`.
 */
describe('runPlugin — --input key=value', () => {
  let inputHome: string

  interface FixtureInput {
    type: string
    required?: boolean
    default?: unknown
  }

  function writePlugin(
    name: string,
    inputs: Record<string, FixtureInput>,
    predicate: string,
  ): void {
    const dir = join(inputHome, 'plugins', name)
    mkdirSync(dir, { recursive: true })
    const manifest = {
      name,
      version: '1.0.0',
      description: 'input channel fixture',
      inputs,
      outputs: {},
      capabilities: [],
      schedule: 'on_run',
      autonomy_level: 'autonomous',
      side_effects: [],
      ttl_hours: 24,
      dependencies: [],
      timeout_ms: 5000,
      max_parallelism: 1,
      min_tier: 'normal',
      max_retries: 0,
      retry_delay_ms: 1,
    }
    writeFileSync(join(dir, 'manifest.ts'), `export const manifest = ${JSON.stringify(manifest)}`)
    writeFileSync(
      join(dir, 'handler.ts'),
      `export async function handler(manifest, args) {
        const ok = (${predicate})(args)
        return {
          status: ok ? 'success' : 'failed',
          phases_completed: ok ? ['${name}'] : [],
          phases_failed: ok ? [] : ['${name}'],
          errors: ok ? [] : [{ code: 'data_missing', message: 'handler did not receive the expected args', impact: 'MEDIUM', retryable: false }],
          data_freshness: {},
          summary: '${name}: ' + (ok ? 'received what it declared' : 'wrong args'),
          artifacts_produced: [],
          schema_version: 1,
        }
      }`,
    )
  }

  beforeAll(() => {
    inputHome = mkdtempSync(join(tmpdir(), 'warpline-run-input-'))
    mkdirSync(join(inputHome, 'plugins'))
    mkdirSync(join(inputHome, 'config'))
    _setHome(inputHome)

    writePlugin(
      'input-merge',
      { a: { type: 'string', required: false }, b: { type: 'string', required: false } },
      `(a) => a.a === '1' && a.b === '2' && a.action === 'run'`,
    )
    writeFileSync(
      join(inputHome, 'config', 'input-merge.json'),
      JSON.stringify({ a: 'from-config', b: 'from-config' }),
    )
    writePlugin('input-split', { note: { type: 'string' } }, `(a) => a.note === 'a=b'`)
    writePlugin(
      'input-typed',
      { note: { type: 'string', required: false }, n: { type: 'number', required: false } },
      `(a) => typeof a.note === 'string' && a.note === '5' && a.n === undefined`,
    )
  })

  afterAll(() => {
    _setHome(home)
    rmSync(inputHome, { recursive: true, force: true })
  })

  test('merges every pair into the handler args at the invocation_args tier, beating the config file', async () => {
    const merged = await runPlugin(['input-merge', 'run', '--input', 'a=1', '--input', 'b=2'])
    expect(merged.code).toBe(0)
    expect(merged.payload.ok).toBe(true)

    // Control: without the flag the config file's values reach the handler
    // and the same predicate fails, so the pass above is the merge and not a
    // handler that ignores its args.
    const control = await runPlugin(['input-merge', 'run'])
    expect(control.code).toBe(0)
    expect(control.payload.ok).toBe(false)
  })

  test('the action positional is not overridable by --input', async () => {
    const { payload } = await runPlugin([
      'input-merge', 'run', '--input', 'a=1', '--input', 'b=2', '--input', 'action=other',
    ])
    expect(payload.ok).toBe(true)
  })

  test('splits on the FIRST separator, so a value keeps every later one', async () => {
    const { payload, code } = await runPlugin(['input-split', 'run', '--input', 'note=a=b'])
    expect(code).toBe(0)
    expect(payload.ok).toBe(true)
  })

  test('a pair with no separator, or no key, is a usage error naming the flag and the shape, never what was received', async () => {
    for (const pair of ['novalue', '=orphan']) {
      const rejected = await runPlugin(['input-merge', 'run', '--input', pair])
      expect(rejected.code).toBe(1)
      expect(rejected.usageError).toContain('--input')
      expect(rejected.usageError).toContain('key=value')
      expect(rejected.usageError).not.toContain('novalue')
      expect(rejected.usageError).not.toContain('orphan')
      expect(rejected.stdout).toBe('')
      expect(rejected.payload.duration_ms).toBeUndefined()
    }
  })

  test('a key the config schema refuses is refused here too — the same Object.prototype rule, not a second list', async () => {
    for (const key of ['constructor', '__proto__', 'toString']) {
      // The existing refusal, asserted on the same key: a null-prototype
      // record so `__proto__` is an own key the schema can see.
      const record: Record<string, unknown> = Object.create(null)
      record[key] = 'x'
      expect(PluginConfigSchema.safeParse(record).success).toBe(false)

      const rejected = await runPlugin(['input-merge', 'run', '--input', `${key}=x`])
      expect(rejected.code).toBe(1)
      expect(rejected.usageError).toContain('--input')
      expect(rejected.usageError).toContain('Object.prototype')
      expect(rejected.usageError).not.toContain(key)
      expect(rejected.stdout).toBe('')
      expect(rejected.payload.duration_ms).toBeUndefined()
    }
    // And a key the schema accepts goes through.
    expect(PluginConfigSchema.safeParse({ a: 'x' }).success).toBe(true)
    expect((await runPlugin(['input-merge', 'run', '--input', 'a=1', '--input', 'b=2'])).code).toBe(0)
  })

  test('values are strings and are never coerced: a string input keeps a numeric-looking value, a number input rejects it loudly', async () => {
    const asString = await runPlugin(['input-typed', 'run', '--input', 'note=5'])
    expect(asString.code).toBe(0)
    expect(asString.payload.ok).toBe(true)

    const asNumber = await runPlugin(['input-typed', 'run', '--input', 'n=90'])
    // The invocation ran (exit 0); the resolver's own problem string reports
    // the ceiling. The string '90' is not converted to a number for it.
    expect(asNumber.code).toBe(0)
    expect(asNumber.payload.ok).toBe(false)
    expect(asNumber.payload.error).toContain("input 'n' must be a number")
  })

  test('writes nothing to stdout across an --input invocation, and the returned stdout is whole JSON', async () => {
    const writes: unknown[] = []
    const original = process.stdout.write
    process.stdout.write = ((chunk: unknown) => {
      writes.push(chunk)
      return true
    }) as typeof process.stdout.write
    let good: Awaited<ReturnType<typeof runPlugin>>
    let rejected: Awaited<ReturnType<typeof runPlugin>>
    try {
      good = await runPlugin(['input-merge', 'run', '--input', 'a=1', '--input', 'b=2', '--json'])
      rejected = await runPlugin(['input-merge', 'run', '--input', 'novalue', '--json'])
    } finally {
      process.stdout.write = original
    }
    expect(writes).toEqual([])
    // Whole, not merely parseable: byte-identical to the serialized payload.
    expect(good.stdout).toBe(JSON.stringify(good.payload))
    expect(JSON.parse(good.stdout).ok).toBe(true)
    expect(rejected.stdout).toBe('')
    expect(rejected.usageError).toBeDefined()
  })

  test('--retries and --json are unchanged beside --input, and an unknown flag is still a usage error', async () => {
    const retries = await runPlugin(['input-merge', 'run', '--input', 'a=1', '--retries=abc'])
    expect(retries.code).toBe(1)
    expect(retries.usageError).toContain('[0, 10]')

    const bogus = await runPlugin(['input-merge', 'run', '--input', 'a=1', '--bogus'])
    expect(bogus.code).toBe(1)
    expect(bogus.usageError).toContain('bogus')

    const json = await runPlugin(['input-merge', 'run', '--input', 'a=1', '--input', 'b=2', '--json'])
    expect(Object.keys(JSON.parse(json.stdout)).join()).toBe(
      'ok,duration_ms,attempt_count,cancelled,timed_out',
    )
  })

  test('the usage line advertises --input as repeatable and states the strings-only ceiling', async () => {
    const { usageError } = await runPlugin([])
    expect(usageError).toContain('--input key=value')
    expect(usageError).toMatch(/repeat/i)
    expect(usageError).toMatch(/string/i)
  })
})
