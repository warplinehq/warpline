/**
 * A hand edit of preferences.json lands on the audit record before any value
 * from it is used.
 *
 * Nothing writes preferences.json but the operator's editor, so the record
 * comes from comparing what was read with what the store last saw. The digest
 * is the sha256 of the exact bytes on disk, computed here with `node:crypto`
 * and never with a helper from the module under test: a check that borrowed
 * the writer's hashing would agree with it by construction.
 *
 * Every case gets its own home through `_setHome`, and everything this file
 * writes goes under temp dirs (AGENTS.md Rule 2).
 */
import { describe, test, expect, beforeEach, afterEach, afterAll, spyOn } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as audit from '../../lib/audit-log.js'
import { mergeGrant } from '../approval-gate.js'
import { _setHome } from '../../lib/paths.js'
import { _getPaths, _setPaths, pathsForStateFile } from '../../board/state-manager.js'
import { createTestHome, type TestHome } from './helpers/create-test-home.js'
import { snapshotHome } from './helpers/snapshot-home.js'
import { main } from '../../cli/warpline.js'
import { runPlugin } from '../../cli/run-plugin.js'

const REAL_PATHS = _getPaths()
const SENTINEL = 'WARPLINE_AUDIT_APPEND_SPY_SENTINEL'
const OBSERVED = 'warpline.audit.preferences.observed'

let home: TestHome
let installed: ReturnType<typeof spyOn>[] = []

const storeDir = (): string => join(home.root, 'audit')
const prefsFile = (): string => join(home.root, 'preferences.json')
const marksFile = (): string => join(home.root, 'marks', 'mailer')
const sha = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex')

beforeEach(async () => {
  home = await createTestHome()
  _setHome(home.root)
  _setPaths(
    pathsForStateFile(join(home.stateDir, 'engine-state.json'), { eventsPath: join(home.runsDir, 'events.jsonl') }),
  )
  writeMailer()
  await mergeGrant(['mailer'], {}, join(home.root, '.session-approval'))
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

/** Write preferences.json as these exact bytes, and return them as read back. */
function writePrefsText(text: string): Buffer {
  writeFileSync(prefsFile(), text)
  return readFileSync(prefsFile())
}

/**
 * A granted session-class plugin whose handler appends one byte to a marks
 * file each time it runs, so "not invoked by this advance" is a count that did
 * not move rather than an assumption. Never fresh, so every advance fires it.
 */
function writeMailer(): void {
  const dir = join(home.pluginsDir, 'mailer')
  mkdirSync(dir, { recursive: true })
  const manifest = {
    name: 'mailer',
    version: '1.0.0',
    description: 'mailer preferences fixture',
    inputs: {},
    outputs: {},
    capabilities: [],
    secrets: [],
    schedule: 'on_run',
    autonomy_level: 'autonomous',
    approval_class: 'session',
    side_effects: ['sends_email'],
    ttl_hours: 1e-9,
    dependencies: [],
    timeout_ms: 5000,
    max_parallelism: 1,
    min_tier: 'normal',
    max_retries: 0,
    retry_delay_ms: 10,
  }
  writeFileSync(join(dir, 'manifest.ts'), `export const manifest = ${JSON.stringify(manifest)}`)
  writeFileSync(
    join(dir, 'handler.ts'),
    `import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const MARKS = ${JSON.stringify(marksFile())}

export async function handler() {
  mkdirSync(dirname(MARKS), { recursive: true })
  appendFileSync(MARKS, 'x')
  return {
    status: 'success',
    phases_completed: ['mailer'],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: 'mailer completed',
    artifacts_produced: [],
    schema_version: 1,
  }
}
`,
  )
}

/** How many times the mailer handler has run in this home. */
const invocations = (): number => (existsSync(marksFile()) ? readFileSync(marksFile(), 'utf-8').length : 0)

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

const advance = () => capture(['advance', '--json'])

type Raw = { text: string; record: { type: string; warplineseq: number; data: Record<string, unknown> } }

/** Every stored line under `<home>/audit/`, segments in name order. */
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

const observed = (lines: Raw[] = rawLines()): Raw[] => lines.filter((l) => l.record.type === OBSERVED)

/** A quiet-hours window holding right now, read off the local clock as `isQuietHours` does. */
function windowAroundNow(): { start: string; end: string } {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const at = (offsetMs: number): string => {
    const d = new Date(Date.now() + offsetMs)
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
  return { start: at(-60 * 60 * 1000), end: at(60 * 60 * 1000) }
}

/** Every file under `dir`, recursively. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)],
  )
}

/**
 * `observeAuthorityFile` throws once, as the store would on a failed append:
 * the fixed AuditAppendError message, with the sentinel only in its cause.
 * Returns the trip counter.
 */
function failObserveOnce(): () => number {
  const real = audit.observeAuthorityFile
  let trips = 0
  installed.push(
    spyOn(audit, 'observeAuthorityFile').mockImplementation((async (...args: unknown[]) => {
      if (trips === 0) {
        trips += 1
        throw new audit.AuditAppendError('preferences.observed', 'write failed', new Error(SENTINEL))
      }
      return (real as (...a: unknown[]) => Promise<unknown>)(...args)
    }) as typeof audit.observeAuthorityFile),
  )
  return () => trips
}

describe('preferences.json is on the record before the advance uses it', () => {
  test('baseline: the first read of a file the store has never seen records it with no old digest, once', async () => {
    const bytes = writePrefsText('{"review_gate":false}')

    expect((await advance()).code).toBe(0)

    const first = observed()
    expect(first).toHaveLength(1)
    expect(first[0]!.record.data).toEqual({ old: null, new: sha(bytes), changed: 'unknown', editor: 'unknown' })

    expect((await advance()).code).toBe(0)

    expect(observed()).toHaveLength(1)
  })

  test('hand edit: turning the review gate off is recorded with both digests ahead of the fire and the Checkpoint of that advance', async () => {
    const baseline = writePrefsText('{"review_gate":true}')
    expect((await advance()).code).toBe(0)
    const before = rawLines().length
    const ranBefore = invocations()

    const edited = writePrefsText('{"review_gate":false,"max_sends_per_day":3}')
    const { code } = await advance()

    expect(code).toBe(0)
    expect(invocations()).toBe(ranBefore + 1)
    const fresh = rawLines().slice(before)
    const obs = observed(fresh)
    expect(obs).toHaveLength(1)
    expect(obs[0]!.record.data).toEqual({ old: sha(baseline), new: sha(edited), changed: 'unknown', editor: 'unknown' })
    const intent = fresh.find((l) => l.record.type === 'warpline.audit.fire.intent' && l.record.data.plugin === 'mailer')
    const checkpoint = fresh.find((l) => l.record.type === 'warpline.audit.checkpoint.recorded')
    expect(intent).toBeDefined()
    expect(checkpoint).toBeDefined()
    expect(obs[0]!.record.warplineseq).toBeLessThan(intent!.record.warplineseq)
    expect(obs[0]!.record.warplineseq).toBeLessThan(checkpoint!.record.warplineseq)
  })

  test('hand edit: turning quiet hours on is recorded by the advance it silences, ahead of its Checkpoint', async () => {
    const baseline = writePrefsText('{"review_gate":false}')
    expect((await advance()).code).toBe(0)
    const before = rawLines().length
    const ranBefore = invocations()

    const edited = writePrefsText(JSON.stringify({ review_gate: false, quiet_hours: windowAroundNow() }))
    const { code } = await advance()

    expect(code).toBe(0)
    expect(invocations()).toBe(ranBefore)
    const fresh = rawLines().slice(before)
    const obs = observed(fresh)
    expect(obs).toHaveLength(1)
    expect(obs[0]!.record.data).toEqual({ old: sha(baseline), new: sha(edited), changed: 'unknown', editor: 'unknown' })
    const checkpoint = fresh.find((l) => l.record.type === 'warpline.audit.checkpoint.recorded')
    expect(checkpoint).toBeDefined()
    expect(obs[0]!.record.warplineseq).toBeLessThan(checkpoint!.record.warplineseq)
  })

  test('the same values spaced differently are different bytes, and are recorded', async () => {
    const baseline = writePrefsText('{"review_gate":false}')
    expect((await advance()).code).toBe(0)

    const spaced = writePrefsText('{ "review_gate": false }\n')
    expect((await advance()).code).toBe(0)

    const obs = observed()
    expect(obs).toHaveLength(2)
    expect(obs[1]!.record.data).toEqual({ old: sha(baseline), new: sha(spaced), changed: 'unknown', editor: 'unknown' })
  })

  test('deleting a file the store has seen is recorded with no new digest', async () => {
    const baseline = writePrefsText('{"review_gate":false}')
    expect((await advance()).code).toBe(0)

    rmSync(prefsFile())
    expect((await advance()).code).toBe(0)

    const obs = observed()
    expect(obs).toHaveLength(2)
    expect(obs[1]!.record.data).toEqual({ old: sha(baseline), new: null, changed: 'unknown', editor: 'unknown' })
  })

  test('a missing file the store has never seen records nothing, and creates no store on its own', async () => {
    expect(existsSync(prefsFile())).toBe(false)

    expect((await advance()).code).toBe(0)

    expect(observed()).toHaveLength(0)

    const bare = mkdtempSync(join(tmpdir(), 'warpline-audit-prefs-'))
    try {
      expect(await audit.observeAuthorityFile(join(bare, 'state', 'engine-state.json'), 'preferences.observed', null)).toBeNull()
      expect(existsSync(join(bare, 'audit'))).toBe(false)
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })

  test('an invalid file refuses with 75 before the lock, leaves the home byte-identical and is never digested', async () => {
    writePrefsText('{"review_gate":false,"not_a_preference":true}')
    const before = await snapshotHome(home.root)

    const { code, stdout } = await advance()

    expect(code).toBe(75)
    expect(stdout).toBe('')
    expect(await snapshotHome(home.root)).toEqual(before)
    expect(existsSync(storeDir())).toBe(false)
  })

  test('a record the store cannot take refuses the advance with 75: nothing fires, nothing is recorded after it, the run lock is released', async () => {
    expect(typeof audit.observeAuthorityFile).toBe('function')
    writePrefsText('{"review_gate":false}')
    expect((await advance()).code).toBe(0)
    const before = rawLines().length
    const ranBefore = invocations()
    writePrefsText('{"review_gate":false,"max_sends_per_day":3}')
    const trips = failObserveOnce()

    const { code, stdout, stderr } = await advance()

    expect(trips()).toBe(1)
    expect(code).toBe(75)
    expect(stdout).toBe('')
    expect(invocations()).toBe(ranBefore)
    const fresh = rawLines().slice(before)
    expect(fresh.filter((l) => l.record.type.startsWith('warpline.audit.fire.'))).toHaveLength(0)
    expect(fresh.filter((l) => l.record.type === 'warpline.audit.checkpoint.recorded')).toHaveLength(0)
    expect(existsSync(join(home.stateDir, '.lock'))).toBe(false)
    expect(stderr).toContain('audit store')
    expect(stderr).not.toContain(SENTINEL)
  })

  test.skipIf(process.getuid?.() === 0)(
    'a read-only store refuses the advance with 75 and nothing fires (skipped as root, which writes through the mode)',
    async () => {
      writePrefsText('{"review_gate":false}')
      expect((await advance()).code).toBe(0)
      const ranBefore = invocations()
      writePrefsText('{"review_gate":false,"max_sends_per_day":3}')
      const mode = statSync(storeDir()).mode & 0o777
      chmodSync(storeDir(), 0o500)
      try {
        const { code } = await advance()

        expect(code).toBe(75)
        expect(invocations()).toBe(ranBefore)
      } finally {
        chmodSync(storeDir(), mode)
      }
    },
  )

  test('no observed record names an editor, a value or a key: its data is the two digests and two fixed words', async () => {
    writePrefsText('{"review_gate":false}')
    expect((await advance()).code).toBe(0)
    writePrefsText('{"review_gate":false,"max_sends_per_day":3}')
    expect((await advance()).code).toBe(0)
    rmSync(prefsFile())
    expect((await advance()).code).toBe(0)

    const obs = observed()
    expect(obs).toHaveLength(3)
    for (const line of obs) {
      expect(Object.keys(line.record.data).sort()).toEqual(['changed', 'editor', 'new', 'old'])
      expect(line.record.data.changed).toBe('unknown')
      expect(line.record.data.editor).toBe('unknown')
    }
  })
})

describe('warpline run checks preferences.json before the plugin runs', () => {
  test('a hand edit is recorded by run before the handler is invoked', async () => {
    const baseline = writePrefsText('{"review_gate":false}')
    expect((await advance()).code).toBe(0)
    const ranBefore = invocations()
    const edited = writePrefsText('{"review_gate":false,"max_sends_per_day":3}')

    const { payload, code } = await runPlugin(['mailer', 'go'])

    expect(code).toBe(0)
    expect(payload.ok).toBe(true)
    expect(invocations()).toBe(ranBefore + 1)
    const obs = observed()
    expect(obs).toHaveLength(2)
    expect(obs[1]!.record.data).toEqual({ old: sha(baseline), new: sha(edited), changed: 'unknown', editor: 'unknown' })
  })

  test('a record the store cannot take refuses run: ok false, exit 1, the handler never runs, and the cause is in no file', async () => {
    expect(typeof audit.observeAuthorityFile).toBe('function')
    writePrefsText('{"review_gate":false}')
    expect((await advance()).code).toBe(0)
    const ranBefore = invocations()
    writePrefsText('{"review_gate":false,"max_sends_per_day":3}')
    const trips = failObserveOnce()

    const { payload, code, stdout } = await runPlugin(['mailer', 'go'])

    expect(trips()).toBe(1)
    expect(code).toBe(1)
    expect(payload.ok).toBe(false)
    expect(payload.error).toContain('audit store')
    expect(invocations()).toBe(ranBefore)
    expect(stdout).not.toContain(SENTINEL)
    for (const file of filesUnder(home.root)) expect(readFileSync(file, 'utf-8')).not.toContain(SENTINEL)
  })
})
