/**
 * Every advance that returns anchors the audit chain with a Checkpoint, and
 * `advance --json` reports the store as that Checkpoint's append left it.
 *
 * The `audit` object is checked against the disk, never against the engine:
 * `diskSummary` reads `<home>/audit` with `node:fs` and `node:crypto` only, so
 * a writer that miscounts its own segments cannot agree with itself here.
 *
 * The refusal cases snapshot the whole home, because "no Checkpoint" on an
 * advance refused before the run lock means no byte at all, the store
 * directory included.
 *
 * Every case gets its own home, and everything this file writes goes under
 * temp dirs (AGENTS.md Rule 2).
 */
import { describe, test, expect, beforeEach, afterEach, afterAll, spyOn } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as audit from '../../lib/audit-log.js'
import { mergeGrant } from '../approval-gate.js'
import { _setHome } from '../../lib/paths.js'
import { _getPaths, _setPaths, pathsForStateFile } from '../../board/state-manager.js'
import { createTestHome, type TestHome } from './helpers/create-test-home.js'
import { snapshotHome } from './helpers/snapshot-home.js'
import { main } from '../../cli/warpline.js'

const REAL_PATHS = _getPaths()

let home: TestHome
let installed: ReturnType<typeof spyOn>[] = []

const storeDir = (): string => join(home.root, 'audit')

beforeEach(async () => {
  home = await createTestHome()
  _setHome(home.root)
  // `main(['advance'])` reads the home-level preferences, one level shallower
  // than the helper's fixture.
  writePreferences({ review_gate: false })
  _setPaths(
    pathsForStateFile(join(home.stateDir, 'engine-state.json'), { eventsPath: join(home.runsDir, 'events.jsonl') }),
  )
})

afterEach(async () => {
  for (const spy of installed) spy.mockRestore()
  installed = []
  _setHome(null)
  await home.cleanup()
})

afterAll(() => {
  _setPaths(REAL_PATHS)
})

function writePreferences(prefs: Record<string, unknown>): void {
  writeFileSync(join(home.root, 'preferences.json'), JSON.stringify(prefs))
}

/** Every field spelled out, so the fixture never leans on a schema default. */
function writePlugin(name: string, overrides: Record<string, unknown> = {}, body = 'succeed'): void {
  const dir = join(home.pluginsDir, name)
  mkdirSync(dir, { recursive: true })
  const manifest = {
    name,
    version: '1.0.0',
    description: `${name} checkpoint fixture`,
    inputs: {},
    outputs: {},
    capabilities: [],
    secrets: [],
    schedule: 'on_run',
    autonomy_level: 'autonomous',
    approval_class: 'session',
    side_effects: [],
    ttl_hours: 0.001,
    dependencies: [],
    timeout_ms: 5000,
    max_parallelism: 1,
    min_tier: 'normal',
    max_retries: 0,
    retry_delay_ms: 10,
    ...overrides,
  }
  writeFileSync(join(dir, 'manifest.ts'), `export const manifest = ${JSON.stringify(manifest)}`)
  writeFileSync(
    join(dir, 'handler.ts'),
    body === 'throw'
      ? `export async function handler() { throw new Error('${name} broke') }\n`
      : `export async function handler() {
  return {
    status: 'success',
    phases_completed: ['${name}'],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: '${name} completed',
    artifacts_produced: [],
    schema_version: 1,
  }
}
`,
  )
}

/** Run main(argv) with stdout/stderr captured, always restoring the originals. */
async function capture(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const realOut = process.stdout.write
  const realErr = process.stderr.write
  let stdout = ''
  let stderr = ''
  process.stdout.write = ((chunk: string) => {
    stdout += chunk
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string) => {
    stderr += chunk
    return true
  }) as typeof process.stderr.write
  try {
    return { code: await main(argv), stdout, stderr }
  } finally {
    process.stdout.write = realOut
    process.stderr.write = realErr
  }
}

type Doc = { run_id: string; exit_code: number; status: string; audit?: unknown }

/** One `advance --json`, its document parsed. */
async function advanceJson(): Promise<{ code: number; doc: Doc; stderr: string }> {
  const { code, stdout, stderr } = await capture(['advance', '--json'])
  return { code, doc: JSON.parse(stdout) as Doc, stderr }
}

type Raw = { text: string; record: { type: string; warplineseq: number; source: string; data: Record<string, unknown> } }

/** Every stored line under `<home>/audit/`, segments in name order, with its exact text. */
function rawLines(): Raw[] {
  if (!existsSync(storeDir())) return []
  return readdirSync(storeDir())
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .flatMap((f) =>
      readFileSync(join(storeDir(), f), 'utf-8')
        .split('\n')
        .filter((l) => l.length > 0)
        .map((text) => ({ text, record: JSON.parse(text) as Raw['record'] })),
    )
}

const checkpoints = (): Raw[] => rawLines().filter((l) => l.record.type === 'warpline.audit.checkpoint.recorded')

/**
 * The store's numbers, read off the disk: the last line's seq, the summed size
 * and count of the segment files, and the last Checkpoint's seq.
 */
function diskSummary(): { seq: number; bytes: number; segments: number; checkpoint_seq: number } {
  const files = readdirSync(storeDir()).filter((f) => f.endsWith('.jsonl'))
  const lines = rawLines()
  const cps = checkpoints()
  return {
    seq: lines[lines.length - 1]!.record.warplineseq,
    bytes: files.reduce((sum, f) => sum + statSync(join(storeDir(), f)).size, 0),
    segments: files.length,
    checkpoint_seq: cps[cps.length - 1]!.record.warplineseq,
  }
}

/** A quiet-hours window holding right now, read off the local clock as `isQuietHours` does. */
function windowAroundNow(): { start: string; end: string } {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const at = (offsetMs: number): string => {
    const d = new Date(Date.now() + offsetMs)
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
  return { start: at(-60 * 60 * 1000), end: at(60 * 60 * 1000) }
}

describe('each advance that returns writes one Checkpoint', () => {
  test('three advances write three Checkpoints, each covering every line before it', async () => {
    writePlugin('alpha')

    for (let i = 0; i < 3; i++) expect((await advanceJson()).code).toBe(0)

    expect(checkpoints()).toHaveLength(3)
    const lines = rawLines()
    const origin = lines[0]!.record.data.home
    expect(typeof origin).toBe('string')
    const at = lines.flatMap((l, i) => (l.record.type === 'warpline.audit.checkpoint.recorded' ? [i] : []))
    expect(at).toHaveLength(3)
    for (const i of at) {
      const before = lines[i - 1]!
      expect(lines[i]!.record.data).toEqual({
        origin,
        size: before.record.warplineseq,
        root: createHash('sha256').update(before.text).digest('hex'),
      })
    }
  })

  test('the quiet-hours arm writes one Checkpoint, and its document carries audit', async () => {
    writePreferences({ review_gate: false, quiet_hours: windowAroundNow() })
    writePlugin('alpha')

    const { code, doc } = await advanceJson()

    expect(code).toBe(0)
    expect(doc.status).toBe('complete')
    expect(checkpoints()).toHaveLength(1)
    expect(doc.audit).toEqual({ ...diskSummary(), indeterminate: [] })
  })
})

describe('the audit object is the store the Checkpoint left', () => {
  test('a normal advance reports the Checkpoint seq, the segment bytes and count, and nothing indeterminate', async () => {
    writePlugin('alpha')

    const { code, doc } = await advanceJson()

    expect(code).toBe(0)
    expect(checkpoints()).toHaveLength(1)
    expect(doc.audit).toEqual({ ...diskSummary(), indeterminate: [] })
    const summary = doc.audit as { seq: number; checkpoint_seq: number }
    expect(summary.seq).toBe(summary.checkpoint_seq)
  })

  test('a gated advance carries audit and a Checkpoint too', async () => {
    writePreferences({ review_gate: true })
    writePlugin('alpha', { autonomy_level: 'supervised' })

    const { code, doc } = await advanceJson()

    expect(code).toBe(0)
    expect(doc.status).toBe('partial')
    expect(checkpoints()).toHaveLength(1)
    expect(doc.audit).toEqual({ ...diskSummary(), indeterminate: [] })
  })

  test('an advance whose plugin fails carries audit and a Checkpoint too', async () => {
    writePlugin('alpha', {}, 'throw')

    const { code, doc } = await advanceJson()

    expect(code).toBe(1)
    expect(checkpoints()).toHaveLength(1)
    expect(doc.audit).toEqual({ ...diskSummary(), indeterminate: [] })
  })
})

describe('an advance that does not return writes no Checkpoint', () => {
  test('an invalid preferences.json refuses before the run lock: no byte under the home, no store', async () => {
    writePlugin('alpha')
    writePreferences({ review_gate: false, not_a_preference: true })
    const before = await snapshotHome(home.root)

    const { code, stdout } = await capture(['advance', '--json'])

    expect(code).toBe(75)
    expect(stdout).toBe('')
    expect(await snapshotHome(home.root)).toEqual(before)
    expect(existsSync(storeDir())).toBe(false)
  })

  test('an unreadable plugin root refuses before the run lock: no byte under the home, no store', async () => {
    rmSync(home.pluginsDir, { recursive: true, force: true })
    const before = await snapshotHome(home.root)

    const { code, stdout } = await capture(['advance', '--json'])

    expect(code).toBe(75)
    expect(stdout).toBe('')
    expect(await snapshotHome(home.root)).toEqual(before)
    expect(existsSync(storeDir())).toBe(false)
  })

  test('an unusable state document throws after the lock and adds no checkpoint line', async () => {
    writePlugin('alpha')
    expect((await advanceJson()).code).toBe(0)
    const seeded = checkpoints().length
    writeFileSync(join(home.stateDir, 'engine-state.json'), '{ not json')

    const { code, stdout } = await capture(['advance', '--json'])

    expect(code).toBe(75)
    expect(stdout).toBe('')
    expect(checkpoints()).toHaveLength(seeded)
  })
})

describe('a fire with no outcome is listed as indeterminate', () => {
  test('R11: after an advance whose outcome append failed, the next advance lists that intent as indeterminate and exits 0', async () => {
    writePlugin('mailer', { side_effects: ['sends_email'] })
    await mergeGrant(['mailer'], {}, join(home.root, '.session-approval'))
    const real = audit.appendAudit
    let trips = 0
    installed.push(
      spyOn(audit, 'appendAudit').mockImplementation((async (path: string, k: string, data: unknown, opts?: unknown) => {
        if (k === 'fire.outcome' && trips === 0) {
          trips += 1
          throw new Error('forced outcome failure')
        }
        return (real as (...args: unknown[]) => Promise<unknown>)(path, k, data, opts)
      }) as typeof audit.appendAudit),
    )

    const first = await advanceJson()

    expect(trips).toBe(1)
    expect(first.code).toBe(70)
    const intent = rawLines().find((l) => l.record.type === 'warpline.audit.fire.intent')!
    expect(intent.record.data.plugin).toBe('mailer')

    const second = await advanceJson()

    expect(second.code).toBe(0)
    expect((second.doc.audit as { indeterminate?: unknown } | undefined)?.indeterminate).toEqual([
      { seq: intent.record.warplineseq, plugin: 'mailer', run_id: first.doc.run_id, effect_id: null },
    ])
  })
})

describe('a Checkpoint the store cannot take', () => {
  test('D-32: the document carries audit null, the advance exits 70, stderr names the Checkpoint, and the dead-man file is written', async () => {
    expect(typeof audit.recordCheckpoint).toBe('function')
    writePlugin('alpha')
    let trips = 0
    installed.push(
      spyOn(audit, 'recordCheckpoint').mockImplementation((async () => {
        trips += 1
        throw new Error('forced checkpoint failure')
      }) as typeof audit.recordCheckpoint),
    )

    const { code, doc, stderr } = await advanceJson()

    expect(trips).toBe(1)
    expect(code).toBe(70)
    expect(doc.exit_code).toBe(70)
    expect('audit' in doc).toBe(true)
    expect(doc.audit).toBeNull()
    expect(stderr).toContain('Checkpoint')
    const deadMan = JSON.parse(readFileSync(join(home.stateDir, 'last-successful-advance'), 'utf-8')) as {
      run_id: string
    }
    expect(deadMan.run_id).toBe(doc.run_id)
  })
})
