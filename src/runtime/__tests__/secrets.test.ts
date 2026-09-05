/**
 * END-TO-END: a declared credential that does not resolve fails the run before
 * the handler is called.
 *
 * Every case here goes through the real `invokePlugin` against a real fixture
 * plugin on disk. The point is the word BEFORE: a presence check that runs
 * inside a handler is a check every plugin author has to remember, and one that
 * fails after the handler has already started doing work. The assertion that
 * carries that is the marker file — the fixture handler writes one as its first
 * statement, and the failing cases assert it is absent.
 *
 * Values never appear in an assertion by accident. Where a case needs a
 * credential that IS set, its value is a sentinel and the test asserts the
 * sentinel reaches neither the error message nor the summary. A run log is a
 * file people paste into issues.
 *
 * Environment variables are set and removed in a `finally`. Bun runs a file's
 * tests in one process and CI shards by directory, so a leaked key would be
 * visible to every sibling file in the same shard.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { invokePlugin } from '../invoke-plugin.js'
import { _setHome } from '../../lib/paths.js'

let root: string
let pluginsRoot: string
let eventsPath: string

/** Path the fixture handler touches as its first statement. */
function markerPath(name: string): string {
  return join(pluginsRoot, name, 'handler-ran')
}

/**
 * Write a fixture plugin that records having run, then succeeds.
 *
 * `secrets` is passed through as given: `undefined` writes a manifest with no
 * `secrets` key at all, which is the case a manifest written before this field
 * existed presents.
 */
async function writePlugin(name: string, secrets?: string[]): Promise<void> {
  const dir = join(pluginsRoot, name)
  await mkdir(dir, { recursive: true })
  const manifest: Record<string, unknown> = {
    name,
    version: '1.0.0',
    description: 'credential channel fixture',
    inputs: {},
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
    // Three retries, so a result that DID re-enter the retry loop would show a
    // different attempt count rather than looking identical to one that never
    // could.
    max_retries: 3,
    retry_delay_ms: 1,
  }
  if (secrets !== undefined) manifest['secrets'] = secrets
  await writeFile(join(dir, 'manifest.ts'), `export const manifest = ${JSON.stringify(manifest)}`)
  await writeFile(
    join(dir, 'handler.ts'),
    `import { writeFileSync } from 'node:fs'
    export async function handler() {
      writeFileSync(${JSON.stringify(markerPath(name))}, 'ran')
      return {
        status: 'success',
        phases_completed: ['${name}'],
        phases_failed: [],
        errors: [],
        data_freshness: {},
        summary: '${name}: ran',
        artifacts_produced: [],
        schema_version: 1,
      }
    }`,
  )
}

function run(name: string) {
  return invokePlugin(name, {}, { pluginsDir: pluginsRoot, eventsPath }, { granted: false, reason: 'manual-run' })
}

/** Run `fn` with `key` set to `value`, and remove the key afterwards. */
async function withEnv(key: string, value: string, fn: () => Promise<void>): Promise<void> {
  const had = Object.prototype.hasOwnProperty.call(process.env, key)
  const previous = process.env[key]
  process.env[key] = value
  try {
    await fn()
  } finally {
    if (had) process.env[key] = previous
    else delete process.env[key]
  }
}

beforeEach(async () => {
  root = join(tmpdir(), `warpline-secrets-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  pluginsRoot = join(root, 'plugins')
  eventsPath = join(root, 'events.jsonl')
  await mkdir(pluginsRoot, { recursive: true })
  _setHome(root)
})

afterEach(async () => {
  _setHome(null)
  await rm(root, { recursive: true, force: true })
})

describe('invokePlugin credential resolution', () => {
  test('a declared credential that is set resolves and the handler runs', async () => {
    await writePlugin('sec-present', ['WARPLINE_TEST_SECRET_PRESENT'])

    await withEnv('WARPLINE_TEST_SECRET_PRESENT', 'SENTINEL-DO-NOT-LEAK', async () => {
      const res = await run('sec-present')
      expect(res.result.status).toBe('success')
      expect(existsSync(markerPath('sec-present'))).toBe(true)
    })
  })

  test('a declared credential that is unset fails with one auth_failure naming it', async () => {
    await writePlugin('sec-missing', ['WARPLINE_TEST_SECRET_MISSING'])
    delete process.env['WARPLINE_TEST_SECRET_MISSING']

    const res = await run('sec-missing')
    expect(res.result.status).toBe('failed')
    expect(res.result.errors).toHaveLength(1)
    expect(res.result.errors[0]?.code).toBe('auth_failure')
    expect(res.result.errors[0]?.message).toContain('WARPLINE_TEST_SECRET_MISSING')
    expect(res.result.errors[0]?.message).toContain('secrets')
  })

  test('the failure names the key and never carries a value read from the environment', async () => {
    await writePlugin('sec-no-leak', ['WARPLINE_TEST_SECRET_SET', 'WARPLINE_TEST_SECRET_ABSENT'])
    delete process.env['WARPLINE_TEST_SECRET_ABSENT']

    await withEnv('WARPLINE_TEST_SECRET_SET', 'SENTINEL-DO-NOT-LEAK', async () => {
      const res = await run('sec-no-leak')
      expect(res.result.status).toBe('failed')
      const message = res.result.errors[0]?.message ?? ''
      expect(message).not.toContain('SENTINEL-DO-NOT-LEAK')
      expect(res.result.summary).not.toContain('SENTINEL-DO-NOT-LEAK')
      expect(res.final_error ?? '').not.toContain('SENTINEL-DO-NOT-LEAK')
    })
  })

  test('the handler is never invoked when a declared credential is unset', async () => {
    await writePlugin('sec-before', ['WARPLINE_TEST_SECRET_BEFORE'])
    delete process.env['WARPLINE_TEST_SECRET_BEFORE']

    const res = await run('sec-before')
    expect(res.result.status).toBe('failed')
    expect(existsSync(markerPath('sec-before'))).toBe(false)
  })

  test('a credential failure produces exactly one attempt and is never retried', async () => {
    await writePlugin('sec-once', ['WARPLINE_TEST_SECRET_ONCE'])
    delete process.env['WARPLINE_TEST_SECRET_ONCE']

    const res = await run('sec-once')
    expect(res.attempts).toHaveLength(1)
    expect(res.attempt_count).toBe(1)
    expect(res.retried).toBe(false)
  })

  test('a manifest declaring secrets: [] runs the check and the handler runs', async () => {
    await writePlugin('sec-empty-list', [])

    const res = await run('sec-empty-list')
    expect(res.result.status).toBe('success')
    expect(existsSync(markerPath('sec-empty-list'))).toBe(true)
  })

  test('a manifest declaring no secrets key at all behaves identically', async () => {
    await writePlugin('sec-undeclared')

    const res = await run('sec-undeclared')
    expect(res.result.status).toBe('success')
    expect(existsSync(markerPath('sec-undeclared'))).toBe(true)
  })

  test("a credential set to the empty string counts as absent and fails by name", async () => {
    await writePlugin('sec-empty-string', ['WARPLINE_TEST_SECRET_EMPTY'])

    await withEnv('WARPLINE_TEST_SECRET_EMPTY', '', async () => {
      const res = await run('sec-empty-string')
      expect(res.result.status).toBe('failed')
      expect(res.result.errors[0]?.code).toBe('auth_failure')
      expect(res.result.errors[0]?.message).toContain('WARPLINE_TEST_SECRET_EMPTY')
      expect(existsSync(markerPath('sec-empty-string'))).toBe(false)
    })
  })

  test('two declared names, one set and one unset, fails naming only the unset one', async () => {
    await writePlugin('sec-two', ['WARPLINE_TEST_SECRET_ONE', 'WARPLINE_TEST_SECRET_TWO'])
    delete process.env['WARPLINE_TEST_SECRET_TWO']

    await withEnv('WARPLINE_TEST_SECRET_ONE', 'SENTINEL-DO-NOT-LEAK', async () => {
      const res = await run('sec-two')
      expect(res.result.status).toBe('failed')
      const message = res.result.errors[0]?.message ?? ''
      expect(message).toContain('WARPLINE_TEST_SECRET_TWO')
      expect(message).not.toContain('WARPLINE_TEST_SECRET_ONE')
    })
  })
})
