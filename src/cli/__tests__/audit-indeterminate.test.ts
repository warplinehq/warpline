/**
 * A fire whose process died between its intent and its outcome is listed as
 * indeterminate by the next `advance --json`, and the plugin fires again.
 *
 * There is no in-process seam for this. The handler kills its own process with
 * SIGKILL right after the intent landed, so nothing in the runtime gets to run
 * an outcome append, a catch or a `finally`. That is the crash the write-ahead
 * exists for, and only the real bin can die of it.
 *
 * Surfaced, never held: the second advance exits 0 and the plugin completes.
 * Holding an indeterminate plugin is later work, and a hold added here would
 * turn this case red.
 *
 * The child gets an explicit `env:` (a bun child's default env is a startup
 * snapshot), and every file this case writes or removes is under its own temp
 * home (AGENTS.md Rule 2).
 */
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { testFixturesDir } from '../../../test-utils/fixtures.js'

/** The built bin, the path a real consumer runs. */
const BIN = testFixturesDir(import.meta.url, '../../../dist/bin/warpline.js')

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'warpline-audit-indeterminate-'))
  mkdirSync(join(home, 'state'), { recursive: true })
  // Home-level: `advance` passes no state override, so the engine reads the
  // home default. Without it the shipped `review_gate: true` gates the fire.
  writeFileSync(join(home, 'preferences.json'), JSON.stringify({ review_gate: false }))
  const plugin = join(home, 'plugins', 'killer')
  mkdirSync(plugin, { recursive: true })
  writeFileSync(
    join(plugin, 'manifest.ts'),
    `export const manifest = ${JSON.stringify({
      name: 'killer',
      version: '1.0.0',
      description: 'dies after its intent on the first fire',
      inputs: {},
      outputs: {},
      capabilities: [],
      secrets: [],
      schedule: 'on_run',
      autonomy_level: 'autonomous',
      approval_class: 'session',
      side_effects: ['sends_email'],
      ttl_hours: 0.001,
      dependencies: [],
      timeout_ms: 30_000,
      max_parallelism: 1,
      min_tier: 'suspended',
      max_retries: 0,
      retry_delay_ms: 10,
    })}\n`,
  )
  writeFileSync(
    join(plugin, 'handler.ts'),
    `import { existsSync, writeFileSync } from 'node:fs'
const KILLED = ${JSON.stringify(join(home, 'killed'))}
const INVOKED = ${JSON.stringify(join(home, 'invoked'))}
export async function handler() {
  if (!existsSync(KILLED)) {
    writeFileSync(KILLED, 'yes')
    process.kill(process.pid, 'SIGKILL')
  }
  writeFileSync(INVOKED, 'yes')
  return {
    status: 'success',
    phases_completed: ['killer'],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: 'killer completed',
    artifacts_produced: [],
    schema_version: 1,
  }
}
`,
  )
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

function bin(args: string[]): ReturnType<typeof spawnSync> {
  const env: NodeJS.ProcessEnv = { ...process.env, WARPLINE_HOME: home }
  delete env.NODE_ENV
  return spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf-8', timeout: 60_000 })
}

type Line = { type: string; warplineseq: number; data: Record<string, unknown> }

function auditLines(): Line[] {
  const dir = join(home, 'audit')
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .flatMap((f) =>
      readFileSync(join(dir, f), 'utf-8')
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as Line),
    )
}

test('a fire killed between its intent and its outcome is listed indeterminate by the next advance, which fires it again and exits 0', () => {
  expect(bin(['approve', 'killer']).status).toBe(0)

  const killed = bin(['advance'])

  expect(killed.signal).toBe('SIGKILL')
  expect(existsSync(join(home, 'killed'))).toBe(true)
  expect(existsSync(join(home, 'invoked'))).toBe(false)
  const intents = auditLines().filter((l) => l.type === 'warpline.audit.fire.intent' && l.data.plugin === 'killer')
  expect(intents).toHaveLength(1)
  const intent = intents[0]!
  // The kill left the run lock behind. This is the test's own temp home.
  rmSync(join(home, 'state', '.lock'), { force: true })

  const next = bin(['advance', '--json'])

  expect(next.status).toBe(0)
  const doc = JSON.parse(String(next.stdout)) as {
    audit?: { indeterminate: Array<{ seq: number; plugin: string; run_id: string; effect_id: string | null }> }
    plugins: Array<{ name: string; state: string }>
  }
  expect(doc.audit?.indeterminate).toHaveLength(1)
  expect(doc.audit?.indeterminate[0]).toEqual({
    seq: intent.warplineseq,
    plugin: 'killer',
    run_id: intent.data.run_id as string,
    effect_id: null,
  })
  expect(existsSync(join(home, 'invoked'))).toBe(true)
  expect(doc.plugins).toEqual([{ name: 'killer', state: 'completed' }])
})

test('a fire killed between its intent and its outcome is answered by seq, and the next advance lists nothing indeterminate', () => {
  expect(bin(['approve', 'killer']).status).toBe(0)
  expect(bin(['advance']).signal).toBe('SIGKILL')
  const intents = auditLines().filter((l) => l.type === 'warpline.audit.fire.intent' && l.data.plugin === 'killer')
  expect(intents).toHaveLength(1)
  // The kill left the run lock behind. This is the test's own temp home.
  rmSync(join(home, 'state', '.lock'), { force: true })

  const answered = bin(['resolve', '--intent', String(intents[0]!.warplineseq), '--not-shipped'])

  expect(answered.status).toBe(0)
  const resolved = auditLines().filter((l) => l.type === 'warpline.audit.fire.resolved')
  expect(resolved.map((l) => l.data)).toEqual([
    { plugin: 'killer', effect_id: null, intent_seq: intents[0]!.warplineseq, answer: 'not_shipped', principal: null },
  ])
  const next = bin(['advance', '--json'])
  expect(next.status).toBe(0)
  const doc = JSON.parse(String(next.stdout)) as { audit?: { indeterminate: unknown[] } }
  expect(doc.audit?.indeterminate).toEqual([])
  const head = bin(['audit', 'head'])
  expect(head.status).toBe(0)
  const anchor = join(home, 'anchor')
  writeFileSync(anchor, String(head.stdout))
  const verified = bin(['audit', 'verify', '--checkpoint', anchor])
  expect(String(verified.stdout)).toContain('verdict: clean')
  expect(String(verified.stdout)).not.toContain('open intent:')
})
