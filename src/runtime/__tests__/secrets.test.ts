/**
 * END-TO-END: a declared credential that does not resolve fails the run before
 * the handler is called.
 *
 * Every case here goes through the real `invokePlugin` against a real fixture
 * plugin on disk, with one exception: the substring-shadowing block at the foot
 * of the file calls `scrubSecrets` directly, because the defect it pins is a
 * property of the replacement ORDER and asserting it needs an exact-equality
 * check on the scrubbed string rather than a search of a file. The point is the
 * word BEFORE: a presence check that runs inside a handler is a check every
 * plugin author has to remember, and one that fails after the handler has
 * already started doing work. The assertion that carries that is the marker
 * file — the fixture handler writes one as its first statement, and the failing
 * cases assert it is absent.
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
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { invokePlugin } from '../invoke-plugin.js'
import { REDACTED, scrubSecrets } from '../secrets.js'
import { readEngineState, writeEngineState } from '../engine-state-store.js'
import { defaultEngineState } from '../../schemas/engine-state.js'
import { OUTPUT_BODY_CAP_BYTES, SkillResultSchema } from '../../schemas/skill-result.js'
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

// -----------------------------------------------------------------------
// A resolved credential value reaches no file `invokePlugin` writes
// -----------------------------------------------------------------------
//
// Two disk paths belong to a bare `invokePlugin`: the run artifact it writes
// when `persistArtifact` is set, and the `events.jsonl` line `emitAttemptFailed`
// appends between retries. A third sink is not a file at all — the structured
// `[needs-llm]` carrier on the `SkillResult` the call RETURNS, which the run
// artifact never copies because it is assembled field by field.
//
// Every case proves the canary REACHED the sink before asserting it is not in
// the persisted text. Absence on its own is green when the value never resolved
// at all, and a credential that never resolved is exactly the shape a broken
// fixture has.

/** A value no other string in this suite contains. */
const CANARY = 'WL-CANARY-6f3a9d21c05b'

/** Where the leaky fixture records the value it was actually handed. */
function sawPath(name: string): string {
  return join(pluginsRoot, name, 'handler-saw')
}

/**
 * A fixture that puts the resolved credential everywhere a handler can put a
 * string: the summary, an error message, and an Output's inline body.
 *
 * The error is `rate_limit` with `retryable: true` deliberately. The retry
 * predicate in `invoke-plugin.ts` requires exactly that, and `emitAttemptFailed`
 * — the only writer of `events.jsonl` on this path — fires only between
 * attempts. A `dependency_unavailable` here would leave the event log empty and
 * the case would be red for the wrong reason in both directions.
 *
 * It RETURNS the failure rather than throwing one. A throw routes through the
 * same parse boundary via `executeHandler`'s catch, but the fabricated result it
 * produces carries no `artifacts_produced`, so the inline body would vanish.
 */
async function writeLeakyPlugin(name: string, secretKey: string): Promise<void> {
  const dir = join(pluginsRoot, name)
  await mkdir(dir, { recursive: true })
  const manifest = {
    name,
    version: '1.0.0',
    description: 'redaction fixture',
    inputs: {},
    outputs: {},
    capabilities: [],
    secrets: [secretKey],
    schedule: 'on_run',
    autonomy_level: 'autonomous',
    side_effects: [],
    ttl_hours: 24,
    dependencies: [],
    timeout_ms: 5000,
    max_parallelism: 1,
    min_tier: 'normal',
    max_retries: 2,
    retry_delay_ms: 1,
  }
  await writeFile(join(dir, 'manifest.ts'), `export const manifest = ${JSON.stringify(manifest)}`)
  await writeFile(
    join(dir, 'handler.ts'),
    `import { writeFileSync } from 'node:fs'
    export async function handler() {
      const value = process.env[${JSON.stringify(secretKey)}] ?? ''
      writeFileSync(${JSON.stringify(sawPath(name))}, value)
      return {
        status: 'failed',
        phases_completed: [],
        phases_failed: ['${name}'],
        errors: [{ code: 'rate_limit', message: 'upstream refused token ' + value, impact: 'MEDIUM', retryable: true }],
        data_freshness: {},
        summary: '${name} called with ' + value,
        artifacts_produced: [{ type: 'report', format: 'markdown', body: 'token was ' + value }],
        schema_version: 1,
      }
    }`,
  )
}

/**
 * A fixture whose ONLY carrier of the credential is the structured
 * `[needs-llm]` field's inner `task` string.
 *
 * Its own handler, separate from the leaky one above: a result carrying that
 * field classifies as a handoff, which changes the status every other case
 * records. And the canary is deliberately absent from the summary — a scrubber
 * written against an enumerated field list leaves this one standing, which is
 * the whole point of the case.
 *
 * The result object is built by hand rather than through the builder, whose
 * needs-llm arm copies the task text into the summary and would move the canary
 * onto a field that is already covered.
 */
async function writeHandoffPlugin(name: string, secretKey: string): Promise<void> {
  const dir = join(pluginsRoot, name)
  await mkdir(dir, { recursive: true })
  const manifest = {
    name,
    version: '1.0.0',
    description: 'structured handoff redaction fixture',
    inputs: {},
    outputs: {},
    capabilities: [],
    secrets: [secretKey],
    schedule: 'on_run',
    autonomy_level: 'autonomous',
    side_effects: [],
    ttl_hours: 24,
    dependencies: [],
    timeout_ms: 5000,
    max_parallelism: 1,
    min_tier: 'normal',
    max_retries: 1,
    retry_delay_ms: 1,
  }
  await writeFile(join(dir, 'manifest.ts'), `export const manifest = ${JSON.stringify(manifest)}`)
  await writeFile(
    join(dir, 'handler.ts'),
    `export async function handler() {
      const value = process.env[${JSON.stringify(secretKey)}] ?? ''
      return {
        status: 'skipped',
        phases_completed: [],
        phases_failed: [],
        errors: [],
        data_freshness: {},
        summary: '${name}: handing off',
        artifacts_produced: [],
        schema_version: 1,
        needs_llm: { task: 'Triage the account behind ' + value, context_path: 'state/entries.json' },
      }
    }`,
  )
}

describe('a resolved credential reaches no sink invokePlugin writes', () => {
  test('the run artifact carries no resolved credential value', async () => {
    const key = 'WARPLINE_TEST_CANARY_ARTIFACT'
    await writeLeakyPlugin('leak-artifact', key)
    const runsRoot = join(root, 'runs')
    const runId = 'redaction-artifact-run'

    await withEnv(key, CANARY, async () => {
      await invokePlugin(
        'leak-artifact',
        {},
        { pluginsDir: pluginsRoot, eventsPath, persistArtifact: true, runsDir: runsRoot, runId },
        { granted: false, reason: 'manual-run' },
      )

      // Presence: the handler resolved the credential and held it.
      expect(await readFile(sawPath('leak-artifact'), 'utf-8')).toBe(CANARY)
      const raw = await readFile(join(runsRoot, `${runId}.json`), 'utf-8')
      expect(raw.length).toBeGreaterThan(0)
      const artifact = JSON.parse(raw)
      expect(artifact.summary.length).toBeGreaterThan(0)
      expect(artifact.final_error.length).toBeGreaterThan(0)

      // Absence.
      expect(raw).not.toContain(CANARY)
    })
  })

  test('events.jsonl carries no resolved credential value', async () => {
    const key = 'WARPLINE_TEST_CANARY_EVENTS'
    await writeLeakyPlugin('leak-events', key)

    await withEnv(key, CANARY, async () => {
      await invokePlugin(
        'leak-events',
        {},
        { pluginsDir: pluginsRoot, eventsPath },
        { granted: false, reason: 'manual-run' },
      )

      // Presence: the handler held it, and the retry notice was actually written.
      expect(await readFile(sawPath('leak-events'), 'utf-8')).toBe(CANARY)
      const raw = await readFile(eventsPath, 'utf-8')
      expect(raw).toContain('attempt 1 failed')

      // Absence.
      expect(raw).not.toContain(CANARY)
    })
  })

  test('the structured [needs-llm] task on the returned result carries no resolved credential value', async () => {
    const key = 'WARPLINE_TEST_CANARY_HANDOFF'
    await writeHandoffPlugin('leak-handoff', key)

    await withEnv(key, CANARY, async () => {
      const res = await invokePlugin(
        'leak-handoff',
        {},
        { pluginsDir: pluginsRoot, eventsPath },
        { granted: false, reason: 'manual-run' },
      )

      // Presence: the field survived the parse boundary and carries text. An
      // absent field, or the `failed` fallback a rejected parse produces, would
      // pass the absence check below over a result that never carried anything.
      expect(res.result.status).toBe('skipped')
      expect(res.result.needs_llm).toBeDefined()
      expect(typeof res.result.needs_llm?.task).toBe('string')
      expect((res.result.needs_llm?.task ?? '').length).toBeGreaterThan(0)

      // Absence.
      expect(res.result.needs_llm?.task).not.toContain(CANARY)
      expect(res.result.summary).not.toContain(CANARY)
    })
  })
})

// -----------------------------------------------------------------------
// Two resolved credentials, where one value is a substring of the other
// -----------------------------------------------------------------------
//
// `manifest.secrets: ['DB_PASSWORD', 'DB_URL']` is an ordinary declaration, and
// the password is a substring of the URL. Replacing in declaration order lets
// the placeholder the short value inserts break the long value's own match, so
// the long value's remainder — host, user and database — survives the scrub.
// Every case above resolves at most one credential, which is why the whole file
// was green over it.
//
// The assertions are exact equality and not `not.toContain(short)`. Absence of
// the short value is true of the leaky output as well, so it is green over the
// defect; only the whole scrubbed string says the long value was consumed.
//
// Both declaration orders, because whether the leak happens at all depends on
// which name an author wrote first, and that is not a property anyone should
// have to get right.

describe('scrubSecrets with two resolved values where one contains the other', () => {
  const KEY = 'sk-live-abc123XYZ'
  const PREFIX = 'sk-'
  const URL = 'postgres://u:s3cr3t@db/x'
  const PASSWORD = 's3cr3t'

  test('a prefix declared first does not shadow the whole key', () => {
    expect(scrubSecrets({ summary: `auth ${KEY} failed` }, [PREFIX, KEY])).toEqual({
      summary: `auth ${REDACTED} failed`,
    })
  })

  test('a prefix declared second does not shadow the whole key', () => {
    expect(scrubSecrets({ summary: `auth ${KEY} failed` }, [KEY, PREFIX])).toEqual({
      summary: `auth ${REDACTED} failed`,
    })
  })

  test('a password declared first does not leave the connection string on disk', () => {
    expect(scrubSecrets({ summary: `connected to ${URL}` }, [PASSWORD, URL])).toEqual({
      summary: `connected to ${REDACTED}`,
    })
  })

  test('a password declared second does not leave the connection string on disk', () => {
    expect(scrubSecrets({ summary: `connected to ${URL}` }, [URL, PASSWORD])).toEqual({
      summary: `connected to ${REDACTED}`,
    })
  })

  test('the shorter value is still replaced where it stands on its own', () => {
    // The counterpart risk to the fix: consuming the longer value first must
    // not mean the shorter one stops being scrubbed elsewhere in the string.
    expect(scrubSecrets({ summary: `${PREFIX} then ${KEY}` }, [PREFIX, KEY])).toEqual({
      summary: `${REDACTED} then ${REDACTED}`,
    })
  })

  test('the caller’s array is not reordered', () => {
    // The sort is on a copy. `Object.values(secrets.values)` is a fresh array
    // today, so mutating it would be invisible — which is exactly why it is
    // worth pinning before some caller passes something it keeps.
    const declared = [PREFIX, KEY]
    scrubSecrets({ summary: KEY }, declared)
    expect(declared).toEqual([PREFIX, KEY])
  })
})

// -----------------------------------------------------------------------
// The scrub GROWS a body, and the cap has to be measured on what is written
// -----------------------------------------------------------------------
//
// `[redacted]` is ten bytes, so every credential shorter than that makes the
// result larger than the handler returned it. An Output's inline `body` is
// byte-capped, and that cap is a refinement inside `SkillResultSchema`. So the
// only question that matters is which side of the scrub the parse sits on: a
// cap measured on pre-scrub bytes is a cap on bytes nobody writes.
//
// The sink is `engine-state.json`, which embeds this same `OutputRecordSchema`
// twice and re-parses the whole document on every read. An over-cap body
// persisted there makes every later fail-closed read throw and every tolerant
// read silently return an empty state.

describe('a credential shorter than the placeholder cannot push a body past the cap', () => {
  /** Three bytes, and seven shorter than `[redacted]`. */
  const SHORT = 'Zq7'

  /**
   * A fixture whose Output body is EXACTLY at the cap and ends in the resolved
   * credential. The pad is interpolated rather than computed in the handler,
   * because a fixture written to a temp directory cannot resolve `warpline`.
   */
  async function writeAtCapPlugin(name: string, secretKey: string): Promise<void> {
    const dir = join(pluginsRoot, name)
    await mkdir(dir, { recursive: true })
    const manifest = {
      name,
      version: '1.0.0',
      description: 'at-cap redaction fixture',
      inputs: {},
      outputs: {},
      capabilities: [],
      secrets: [secretKey],
      schedule: 'on_run',
      autonomy_level: 'autonomous',
      side_effects: [],
      ttl_hours: 24,
      dependencies: [],
      timeout_ms: 5000,
      max_parallelism: 1,
      min_tier: 'normal',
      max_retries: 1,
      retry_delay_ms: 1,
    }
    await writeFile(join(dir, 'manifest.ts'), `export const manifest = ${JSON.stringify(manifest)}`)
    await writeFile(
      join(dir, 'handler.ts'),
      `import { writeFileSync } from 'node:fs'
      export async function handler() {
        const value = process.env[${JSON.stringify(secretKey)}] ?? ''
        writeFileSync(${JSON.stringify(sawPath(name))}, value)
        return {
          status: 'success',
          phases_completed: ['${name}'],
          phases_failed: [],
          errors: [],
          data_freshness: {},
          summary: '${name}: produced a brief',
          artifacts_produced: [
            { type: 'report', format: 'markdown', body: 'x'.repeat(${OUTPUT_BODY_CAP_BYTES}).slice(value.length) + value },
          ],
          schema_version: 1,
        }
      }`,
    )
  }

  test('the result invokePlugin returns still satisfies the schema it was parsed by', async () => {
    const key = 'WARPLINE_TEST_CAP_GROWTH'
    await writeAtCapPlugin('cap-growth', key)

    await withEnv(key, SHORT, async () => {
      const res = await invokePlugin(
        'cap-growth',
        {},
        { pluginsDir: pluginsRoot, eventsPath },
        { granted: false, reason: 'manual-run' },
      )

      // Presence: the handler resolved the credential, and the credential is
      // short enough that replacing it costs bytes rather than saving them.
      expect(await readFile(sawPath('cap-growth'), 'utf-8')).toBe(SHORT)
      expect(Buffer.byteLength(SHORT, 'utf8')).toBeLessThan(Buffer.byteLength(REDACTED, 'utf8'))

      // The invariant. Whatever this function returns is a document the schema
      // accepts — because everything downstream re-parses it, and
      // `PendingGateSchema.plugin_result` is this very schema.
      const reparsed = SkillResultSchema.safeParse(res.result)
      expect(reparsed.success).toBe(true)

      // Absence, over the whole returned object rather than a named field.
      expect(JSON.stringify(res.result)).not.toContain(SHORT)
    })
  })

  test('an over-cap redacted body is refused at the parse boundary, not written', async () => {
    // The chosen behaviour, pinned so a later switch to truncation is a
    // deliberate edit of this case rather than a silent change. The body grew
    // past a cap the handler was inside of, and an over-cap body is refused
    // here exactly as any other over-cap body is.
    const key = 'WARPLINE_TEST_CAP_REFUSAL'
    await writeAtCapPlugin('cap-refusal', key)

    await withEnv(key, SHORT, async () => {
      const res = await invokePlugin(
        'cap-refusal',
        {},
        { pluginsDir: pluginsRoot, eventsPath },
        { granted: false, reason: 'manual-run' },
      )

      expect(res.result.status).toBe('failed')
      // `parse_error` and not `auth_failure`: the latter would mean the
      // environment variable never took and the case proved nothing.
      expect(res.result.errors[0]?.code).toBe('parse_error')
      expect(res.result.artifacts_produced).toHaveLength(0)
    })
  })

  test('the returned result round-trips through engine-state.json', async () => {
    const key = 'WARPLINE_TEST_CAP_STATE'
    await writeAtCapPlugin('cap-state', key)

    await withEnv(key, SHORT, async () => {
      const res = await invokePlugin(
        'cap-state',
        {},
        { pluginsDir: pluginsRoot, eventsPath },
        { granted: false, reason: 'manual-run' },
      )

      const statePath = join(root, 'engine-state.json')
      const state = defaultEngineState()
      const now = new Date().toISOString()
      state.pending_gates.push({
        plugin: 'cap-state',
        run_id: 'cap-state-run',
        created_at: now,
        payload_summary: 'a brief awaiting approval',
        plugin_result: res.result,
        // Real clocks, or `discardStubGates` drops the gate on read and the
        // assertion below would be green over an empty array.
        run_started_at: now,
        run_completed_at: now,
        applied_at: null,
      })
      await writeEngineState(state, statePath)

      // Presence: the gate is on disk with the result inside it.
      expect(await readFile(statePath, 'utf-8')).toContain('cap-state-run')

      // The consequence. A fail-closed read throws `EngineStateInvalidError`
      // over an over-cap body, and from that write onward every advance,
      // approve and deny refuses until an operator hand-edits the document.
      const readBack = await readEngineState(statePath, { announceDiscards: false })
      expect(readBack.pending_gates).toHaveLength(1)
      expect(readBack.pending_gates[0]?.plugin_result.status).toBe(res.result.status)
    })
  })
})
