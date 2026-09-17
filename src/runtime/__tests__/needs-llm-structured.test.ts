/**
 * The structured `[needs-llm]` handoff: a field on the result rather than a
 * substring of the summary.
 *
 * **Every load-bearing case goes through `invokePlugin`, not through
 * `SkillResultSchema.parse` alone.** The runtime validates a handler's result
 * at one boundary, and Zod strips a key the schema does not declare before
 * anything downstream sees it. A test that only ever parses the object it just
 * built cannot tell a field that survived that boundary from a field that was
 * silently dropped on the way through — the two look identical from the
 * builder's side. So the fixtures below are real plugin directories whose
 * handlers return the shape under test, and the assertions read what the
 * caller receives.
 *
 * Fixture plugins live under `tmpdir()` and are removed in an `afterEach`;
 * `eventsPath` is redirected so no fixture event reaches live state.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { invokePlugin, deriveRunStatus } from '../invoke-plugin.js'
import { skillHandoff } from '../result-builders.js'
import { SkillResultSchema } from '../../schemas/skill-result.js'
import type { PluginManifest } from '../../schemas/plugin-manifest.js'
import * as engineEvents from '../../board/engine-events.js'

const MANIFEST: PluginManifest = {
  name: 'handoff-plugin',
  version: '1.0.0',
  description: 'Fixture plugin for the structured handoff field',
  inputs: {},
  outputs: {},
  capabilities: [],
  secrets: [],
  schedule: 'on_run',
  autonomy_level: 'autonomous',
  approval_class: 'session',
  // Declared, so the classifier cases below are the declared rows.
  llm_handoff: true,
  side_effects: [],
  ttl_hours: 24,
  dependencies: [],
  timeout_ms: 5000,
  max_parallelism: 1,
  min_tier: 'normal',
  max_retries: 1,
  retry_delay_ms: 2000,
}

const BUILDER_PATH = fileURLToPath(new URL('../result-builders.ts', import.meta.url))

let tmpDir: string
let eventsPath: string

/**
 * Write a fixture plugin whose handler returns `resultLiteral` verbatim.
 * `manifestOverride` is merged over the declared `MANIFEST`, which is how the
 * undeclared cases below take the declaration away.
 */
async function writeHandoffPlugin(
  name: string,
  resultLiteral: string,
  manifestOverride?: Partial<PluginManifest>,
): Promise<void> {
  const pluginDir = join(tmpDir, name)
  await mkdir(pluginDir, { recursive: true })
  await writeFile(
    join(pluginDir, 'manifest.ts'),
    `export const manifest = ${JSON.stringify({ ...MANIFEST, name, ...manifestOverride })}`,
  )
  await writeFile(
    join(pluginDir, 'handler.ts'),
    `export async function handler() {\n  return ${resultLiteral}\n}\n`,
  )
}

/** The five fields every fixture result carries, so each literal shows only what differs. */
const REST = `phases_completed: [], phases_failed: [], errors: [], data_freshness: {}, artifacts_produced: []`

beforeEach(async () => {
  tmpDir = join(
    tmpdir(),
    `warpline-needs-llm-structured-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  )
  eventsPath = join(tmpDir, 'events.jsonl')
  await mkdir(tmpDir, { recursive: true })

  // The structured field alone — no `[needs-llm]` prefix anywhere in the summary.
  await writeHandoffPlugin(
    'field-only',
    `{ status: 'skipped', summary: 'triage 3 entries', needs_llm: { task: 'Triage 3 entries', context_path: 'state/entries.json' }, ${REST} }`,
  )

  // The shipped string protocol, untouched by this change.
  await writeHandoffPlugin(
    'prefix-only',
    `{ status: 'skipped', summary: '[needs-llm] Triage 3 entries. Context: state/entries.json', ${REST} }`,
  )

  // Both arms, which is what the builder emits.
  await writeHandoffPlugin(
    'both-arms',
    `{ status: 'skipped', summary: '[needs-llm] Triage 3 entries. Context: state/entries.json', needs_llm: { task: 'Triage 3 entries', context_path: 'state/entries.json' }, ${REST} }`,
  )

  // A plain `skipped` carrying neither arm.
  await writeHandoffPlugin('neither', `{ status: 'skipped', summary: 'nothing to do', ${REST} }`)

  // A context path outside the warpline home. The value is a stand-in for any
  // absolute path a handler could name; the assertion is that it does not come
  // back out in the refusal.
  await writeHandoffPlugin(
    'escaping-absolute',
    `{ status: 'skipped', summary: 'triage', needs_llm: { task: 'Triage', context_path: '/etc/passwd' }, ${REST} }`,
  )

  // The same escape by traversal rather than by anchor.
  await writeHandoffPlugin(
    'escaping-traversal',
    `{ status: 'skipped', summary: 'triage', needs_llm: { task: 'Triage', context_path: '../../etc/passwd' }, ${REST} }`,
  )
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('one classifier, reading field-or-prefix', () => {
  test('the structured field alone is a handoff', async () => {
    const inv = await invokePlugin('field-only', {}, { pluginsDir: tmpDir, eventsPath }, { granted: false, reason: 'manual-run' })

    expect(deriveRunStatus(inv)).toBe('delegated')
    expect(inv.attempts[0]?.status).toBe('delegated')
  })

  test('the string prefix alone is still a handoff', async () => {
    const inv = await invokePlugin('prefix-only', {}, { pluginsDir: tmpDir, eventsPath }, { granted: false, reason: 'manual-run' })

    expect(deriveRunStatus(inv)).toBe('delegated')
    expect(inv.attempts[0]?.status).toBe('delegated')
  })

  test('both arms together are classified once, not twice', async () => {
    const inv = await invokePlugin('both-arms', {}, { pluginsDir: tmpDir, eventsPath }, { granted: false, reason: 'manual-run' })

    // One attempt, one classification, one status. A second classifier reading
    // the other arm would show up as a second attempt or a disagreeing pair.
    expect(deriveRunStatus(inv)).toBe('delegated')
    expect(inv.attempt_count).toBe(1)
    expect(inv.attempts).toHaveLength(1)
    expect(inv.attempts[0]?.status).toBe('delegated')
    expect(inv.retried).toBe(false)
    expect(inv.final_error).toBeNull()
  })

  test('neither arm is not a handoff', async () => {
    const inv = await invokePlugin('neither', {}, { pluginsDir: tmpDir, eventsPath }, { granted: false, reason: 'manual-run' })

    expect(deriveRunStatus(inv)).toBe('failed')
    expect(inv.attempts[0]?.status).toBe('failed')
  })
})

describe('the field survives the parse boundary', () => {
  test('a handler that sets it hands it to the caller intact', async () => {
    const { result } = await invokePlugin('field-only', {}, { pluginsDir: tmpDir, eventsPath }, { granted: false, reason: 'manual-run' })

    expect(result.needs_llm).toEqual({
      task: 'Triage 3 entries',
      context_path: 'state/entries.json',
    })
  })

  test('omitting it leaves no key at all on the serialised result', () => {
    // `.optional()` and not `.nullable()`: an absent optional is omitted by Zod
    // and dropped by JSON.stringify, so a plugin that delegated nothing carries
    // no key rather than a null a reader has to interpret.
    const parsed = SkillResultSchema.parse({
      status: 'success',
      phases_completed: [],
      phases_failed: [],
      data_freshness: {},
      summary: 'did the thing',
    })

    expect('needs_llm' in parsed).toBe(false)
    expect(JSON.stringify(parsed)).not.toContain('needs_llm')
  })
})

describe('the context path is bounded to the warpline home', () => {
  test('an absolute path is refused at the boundary, and never echoed back', async () => {
    const { result } = await invokePlugin(
      'escaping-absolute',
      {},
      { pluginsDir: tmpDir, eventsPath },
    { granted: false, reason: 'manual-run' },
    )

    expect(result.status).toBe('failed')
    expect(result.errors[0]?.code).toBe('parse_error')

    // The refusal names the key and the shape expected of it. Naming the value
    // would put a path from outside the home into the run log, which is the
    // disclosure the in-home rule exists to prevent.
    expect(result.errors[0]?.message).toContain('context_path')
    expect(result.errors[0]?.message).not.toContain('/etc/passwd')
    expect(result.summary).not.toContain('/etc/passwd')
  })

  test('a parent-directory segment is refused for the same reason', async () => {
    const { result } = await invokePlugin(
      'escaping-traversal',
      {},
      { pluginsDir: tmpDir, eventsPath },
    { granted: false, reason: 'manual-run' },
    )

    expect(result.status).toBe('failed')
    expect(result.errors[0]?.code).toBe('parse_error')
    expect(result.errors[0]?.message).toContain('context_path')
    expect(result.errors[0]?.message).not.toContain('etc/passwd')
  })

  test('a path under the home is accepted', () => {
    const parsed = SkillResultSchema.safeParse({
      status: 'skipped',
      phases_completed: [],
      phases_failed: [],
      data_freshness: {},
      summary: 'triage',
      needs_llm: { task: 'Triage', context_path: 'state/entries.json' },
    })

    expect(parsed.success).toBe(true)
  })
})

describe('the builder emits both arms', () => {
  test('skillHandoff sets the field and prefixes the summary in one call', () => {
    const built = skillHandoff('Triage 3 entries', 'state/entries.json')

    expect(built.status).toBe('skipped')
    expect(built.needs_llm).toEqual({
      task: 'Triage 3 entries',
      context_path: 'state/entries.json',
    })

    // The prefix arm, in the form the shipped scanner reads: it splits on
    // `Context: ` and opens what follows, so the summary carries the path
    // resolved against the home rather than the relative form the field holds.
    expect(built.summary.startsWith('[needs-llm] ')).toBe(true)
    const [head, tail] = built.summary.split('Context: ')
    expect(head).toBe('[needs-llm] Triage 3 entries. ')
    expect(tail?.endsWith('state/entries.json')).toBe(true)
    expect(tail?.startsWith('/')).toBe(true)
  })

  test('what the builder emits survives invokePlugin on both arms at once', async () => {
    const pluginDir = join(tmpDir, 'builder-handoff')
    await mkdir(pluginDir, { recursive: true })
    await writeFile(
      join(pluginDir, 'manifest.ts'),
      `export const manifest = ${JSON.stringify({ ...MANIFEST, name: 'builder-handoff' })}`,
    )
    await writeFile(
      join(pluginDir, 'handler.ts'),
      [
        // Absolute path: a fixture under tmpdir() has no node_modules above it,
        // so the `warpline/unstable-result` specifier does not resolve from
        // there. That specifier is proven against a packed tarball instead.
        `import { skillHandoff } from ${JSON.stringify(BUILDER_PATH)}`,
        'export async function handler() {',
        "  return skillHandoff('Triage 3 entries', 'state/entries.json')",
        '}',
      ].join('\n'),
    )

    const inv = await invokePlugin('builder-handoff', {}, { pluginsDir: tmpDir, eventsPath }, { granted: false, reason: 'manual-run' })

    expect(deriveRunStatus(inv)).toBe('delegated')
    expect(inv.result.needs_llm?.context_path).toBe('state/entries.json')
    expect(inv.result.summary.startsWith('[needs-llm] ')).toBe(true)
  })
})

/** The two handoff arms, as the classifier cases above write them. */
const FIELD_ONLY = `{ status: 'skipped', summary: 'triage 3 entries', needs_llm: { task: 'Triage 3 entries', context_path: 'state/entries.json' }, ${REST} }`
const PREFIX_ONLY = `{ status: 'skipped', summary: '[needs-llm] Triage 3 entries. Context: state/entries.json', ${REST} }`
const BOTH_ARMS = `{ status: 'skipped', summary: '[needs-llm] Triage 3 entries. Context: state/entries.json', needs_llm: { task: 'Triage 3 entries', context_path: 'state/entries.json' }, ${REST} }`

const refusalMessage = (name: string) =>
  `Plugin '${name}' returned a [needs-llm] handoff but its manifest does not declare llm_handoff: true`

describe('an undeclared handoff is refused', () => {
  let emitAttemptFailedSpy: ReturnType<typeof spyOn<typeof engineEvents, 'emitAttemptFailed'>>

  beforeEach(async () => {
    emitAttemptFailedSpy = spyOn(engineEvents, 'emitAttemptFailed')
    emitAttemptFailedSpy.mockImplementation(async () => {})
    const undeclared = { llm_handoff: false, max_retries: 3 }
    await writeHandoffPlugin('undeclared-field-only', FIELD_ONLY, undeclared)
    await writeHandoffPlugin('undeclared-prefix-only', PREFIX_ONLY, undeclared)
    // The manifest is used as exported, so a string is not the boolean.
    await writeHandoffPlugin('undeclared-string-true', FIELD_ONLY, {
      llm_handoff: 'true' as unknown as boolean,
      max_retries: 3,
    })
  })

  afterEach(() => {
    emitAttemptFailedSpy.mockRestore()
  })

  for (const name of ['undeclared-field-only', 'undeclared-prefix-only', 'undeclared-string-true']) {
    test(`${name} fails once, is not retried, and publishes nothing`, async () => {
      const runsDir = join(tmpDir, 'runs')
      const runId = crypto.randomUUID()
      const inv = await invokePlugin(
        name,
        {},
        { pluginsDir: tmpDir, eventsPath, runsDir, persistArtifact: true, runId },
        { granted: false, reason: 'manual-run' },
      )

      expect(inv.result.status).toBe('failed')
      expect(inv.attempts).toHaveLength(1)
      expect(inv.attempts[0]?.status).toBe('failed')
      expect(inv.attempts[0]?.error).toContain('llm_handoff')
      expect(inv.attempt_count).toBe(1)
      expect(inv.retried).toBe(false)
      expect(inv.result.errors[0]).toMatchObject({ code: 'parse_error', retryable: false })
      expect(inv.result.errors[0]?.message).toBe(refusalMessage(name))
      // A fresh result: nothing the handler wrote survives into it.
      expect(inv.result.summary).toBe(`${name}: undeclared handoff`)
      expect(inv.result.needs_llm).toBeUndefined()
      expect(inv.result.artifacts_produced).toEqual([])
      expect(inv.final_error).toContain('llm_handoff')
      expect(deriveRunStatus(inv)).toBe('failed')

      const artifact = JSON.parse(await readFile(join(runsDir, `${runId}.json`), 'utf-8')) as {
        status: string
      }
      expect(artifact.status).toBe('failed')

      expect(emitAttemptFailedSpy).not.toHaveBeenCalled()
    })
  }
})

describe('the refusal reads only what isHandoff reads', () => {
  const g = globalThis as { __warplineTestAbort?: AbortController }
  const undeclared = { llm_handoff: false }

  /** Aborts the test's controller three microtasks after the handler returns its handoff. */
  const abortingHandoff = (reason: string) =>
    `(queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => globalThis.__warplineTestAbort.abort(${JSON.stringify(reason)})))), ${BOTH_ARMS})`

  beforeEach(async () => {
    await writeHandoffPlugin(
      'undeclared-success',
      `{ status: 'success', summary: 'triaged 3 entries', needs_llm: { task: 'Triage 3 entries', context_path: 'state/entries.json' }, ${REST} }`,
      undeclared,
    )
    await writeHandoffPlugin(
      'undeclared-plain-skip',
      `{ status: 'skipped', summary: 'nothing to do', ${REST} }`,
      undeclared,
    )
    await writeHandoffPlugin('undeclared-null', 'null', undeclared)
    await writeHandoffPlugin('undeclared-then-cancelled', abortingHandoff('cancelled'), undeclared)
    await writeHandoffPlugin('undeclared-then-timeout', abortingHandoff('timeout'), undeclared)
  })

  afterEach(() => {
    delete g.__warplineTestAbort
  })

  test('a success carrying the field is a success, and is not refused', async () => {
    const inv = await invokePlugin('undeclared-success', {}, { pluginsDir: tmpDir, eventsPath }, { granted: false, reason: 'manual-run' })

    expect(inv.result.status).toBe('success')
    expect(inv.result.errors).toEqual([])
    expect(inv.result.summary).toBe('triaged 3 entries')
    expect(deriveRunStatus(inv)).toBe('success')
  })

  test('a skip with neither arm fails as it always did, unrewritten', async () => {
    const inv = await invokePlugin('undeclared-plain-skip', {}, { pluginsDir: tmpDir, eventsPath }, { granted: false, reason: 'manual-run' })

    expect(inv.result.status).toBe('skipped')
    expect(inv.result.summary).toBe('nothing to do')
    expect(inv.attempts[0]?.status).toBe('failed')
    expect(deriveRunStatus(inv)).toBe('failed')
    for (const e of inv.result.errors) expect(e.message).not.toContain('llm_handoff')
  })

  test('a null result fails as invalid output, not as a refusal', async () => {
    const inv = await invokePlugin('undeclared-null', {}, { pluginsDir: tmpDir, eventsPath }, { granted: false, reason: 'manual-run' })

    expect(inv.result.status).toBe('failed')
    expect(inv.result.errors[0]?.code).toBe('parse_error')
    expect(inv.result.errors[0]?.message).toContain('invalid SkillResult')
    expect(inv.result.errors[0]?.message).not.toContain('llm_handoff')
    expect(deriveRunStatus({ cancelled: false, timed_out: false, result: null })).toBe('failed')
  })

  test('a cancel after the handoff returned takes the status, and the body carries the refusal', async () => {
    const ctl = new AbortController()
    g.__warplineTestAbort = ctl
    const inv = await invokePlugin(
      'undeclared-then-cancelled',
      {},
      { pluginsDir: tmpDir, eventsPath, signal: ctl.signal },
      { granted: false, reason: 'manual-run' },
    )

    // The precondition first: if the abort lands somewhere else, say so.
    expect(inv.cancelled).toBe(true)
    expect(inv.attempts[0]?.status).toBe('cancelled')
    expect(deriveRunStatus(inv)).toBe('cancelled')
    expect(inv.result.summary).toBe('undeclared-then-cancelled: undeclared handoff')
  })

  test('a timeout after the handoff returned takes the status, and the body carries the refusal', async () => {
    const ctl = new AbortController()
    g.__warplineTestAbort = ctl
    const inv = await invokePlugin(
      'undeclared-then-timeout',
      {},
      { pluginsDir: tmpDir, eventsPath, signal: ctl.signal },
      { granted: false, reason: 'manual-run' },
    )

    expect(inv.timed_out).toBe(true)
    expect(inv.attempts[0]?.status).toBe('timeout')
    expect(deriveRunStatus(inv)).toBe('timeout')
    expect(inv.result.summary).toBe('undeclared-then-timeout: undeclared handoff')
  })
})

describe('a declared plugin behaves as it always did', () => {
  beforeEach(async () => {
    await writeHandoffPlugin(
      'declared-success',
      `{ status: 'success', summary: 'triaged 3 entries', needs_llm: { task: 'Triage 3 entries', context_path: 'state/entries.json' }, ${REST} }`,
    )
    await writeHandoffPlugin(
      'declared-failed',
      `{ status: 'failed', summary: 'declined', phases_completed: [], phases_failed: [], errors: [{ code: 'dependency_unavailable', message: 'declined', impact: 'HIGH', retryable: false }], data_freshness: {}, artifacts_produced: [] }`,
    )
  })

  test('a success carrying the field is a success', async () => {
    const inv = await invokePlugin('declared-success', {}, { pluginsDir: tmpDir, eventsPath }, { granted: false, reason: 'manual-run' })

    expect(inv.result.status).toBe('success')
    expect(deriveRunStatus(inv)).toBe('success')
  })

  test('a failed result keeps its own error', async () => {
    const inv = await invokePlugin('declared-failed', {}, { pluginsDir: tmpDir, eventsPath }, { granted: false, reason: 'manual-run' })

    expect(inv.result.status).toBe('failed')
    expect(deriveRunStatus(inv)).toBe('failed')
    expect(inv.result.errors[0]?.code).toBe('dependency_unavailable')
    expect(inv.result.errors[0]?.message).not.toContain('llm_handoff')
  })
})
