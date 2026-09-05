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
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { invokePlugin, deriveRunStatus } from '../invoke-plugin.js'
import { skillHandoff } from '../result-builders.js'
import { SkillResultSchema } from '../../schemas/skill-result.js'
import type { PluginManifest } from '../../schemas/plugin-manifest.js'

const MANIFEST: PluginManifest = {
  name: 'handoff-plugin',
  version: '1.0.0',
  description: 'Fixture plugin for the structured handoff field',
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
  max_retries: 1,
  retry_delay_ms: 2000,
}

const BUILDER_PATH = fileURLToPath(new URL('../result-builders.ts', import.meta.url))

let tmpDir: string
let eventsPath: string

/** Write a fixture plugin whose handler returns `resultLiteral` verbatim. */
async function writeHandoffPlugin(name: string, resultLiteral: string): Promise<void> {
  const pluginDir = join(tmpDir, name)
  await mkdir(pluginDir, { recursive: true })
  await writeFile(
    join(pluginDir, 'manifest.ts'),
    `export const manifest = ${JSON.stringify({ ...MANIFEST, name })}`,
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
    const inv = await invokePlugin('field-only', {}, { pluginsDir: tmpDir, eventsPath })

    expect(deriveRunStatus(inv)).toBe('delegated')
    expect(inv.attempts[0]?.status).toBe('delegated')
  })

  test('the string prefix alone is still a handoff', async () => {
    const inv = await invokePlugin('prefix-only', {}, { pluginsDir: tmpDir, eventsPath })

    expect(deriveRunStatus(inv)).toBe('delegated')
    expect(inv.attempts[0]?.status).toBe('delegated')
  })

  test('both arms together are classified once, not twice', async () => {
    const inv = await invokePlugin('both-arms', {}, { pluginsDir: tmpDir, eventsPath })

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
    const inv = await invokePlugin('neither', {}, { pluginsDir: tmpDir, eventsPath })

    expect(deriveRunStatus(inv)).toBe('failed')
    expect(inv.attempts[0]?.status).toBe('failed')
  })
})

describe('the field survives the parse boundary', () => {
  test('a handler that sets it hands it to the caller intact', async () => {
    const { result } = await invokePlugin('field-only', {}, { pluginsDir: tmpDir, eventsPath })

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

    const inv = await invokePlugin('builder-handoff', {}, { pluginsDir: tmpDir, eventsPath })

    expect(deriveRunStatus(inv)).toBe('delegated')
    expect(inv.result.needs_llm?.context_path).toBe('state/entries.json')
    expect(inv.result.summary.startsWith('[needs-llm] ')).toBe(true)
  })
})
