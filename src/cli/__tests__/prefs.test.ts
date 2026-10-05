/**
 * `warpline prefs set` — the audited writer of preferences.json.
 *
 * The record goes on the store before the file is written, and it carries the
 * key path and the sha256 of the old and new whole-file bytes, never the value.
 * The new digest has to be the digest of the exact bytes written: the next
 * production read compares the file with the store, and any other digest would
 * show up there as a hand edit nobody made.
 *
 * Digests are computed here with `node:crypto` over the bytes read back from
 * disk, never with a helper from the code under test, so the check cannot
 * agree with the writer by construction.
 *
 * Every case gets its own home through `_setHome`, and everything this file
 * writes goes under temp dirs (AGENTS.md Rule 2).
 */
import { describe, test, expect, beforeEach, afterEach, afterAll, spyOn } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as audit from '../../lib/audit-log.js'
import * as fsAtomic from '../../lib/fs-atomic.js'
import { _setHome } from '../../lib/paths.js'
import { _getPaths, _setPaths, pathsForStateFile } from '../../board/state-manager.js'
import { createTestHome, type TestHome } from '../../runtime/__tests__/helpers/create-test-home.js'
import { snapshotHome } from '../../runtime/__tests__/helpers/snapshot-home.js'
import { main } from '../warpline.js'
import { run } from '../prefs.js'

const REAL_PATHS = _getPaths()
const SET = 'warpline.audit.preference.set'
const OBSERVED = 'warpline.audit.preferences.observed'
/** A value that is not JSON. It must never reach stdout or stderr. */
const VALUE_SENTINEL = 'PREFS-VALUE-SENTINEL'
/** The spy's error message. It must never reach the operator. */
const APPEND_SENTINEL = 'WARPLINE_AUDIT_APPEND_SPY_SENTINEL'

let home: TestHome
let installed: ReturnType<typeof spyOn>[] = []

const storeDir = (): string => join(home.root, 'audit')
const prefsFile = (): string => join(home.root, 'preferences.json')
const sha = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex')

beforeEach(async () => {
  home = await createTestHome()
  _setHome(home.root)
  _setPaths(
    pathsForStateFile(join(home.stateDir, 'engine-state.json'), { eventsPath: join(home.runsDir, 'events.jsonl') }),
  )
  writeNoop()
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

/** One plugin with no side effects, so an advance has something to run and exits 0. */
function writeNoop(): void {
  const dir = join(home.pluginsDir, 'noop')
  mkdirSync(dir, { recursive: true })
  const manifest = {
    name: 'noop',
    version: '1.0.0',
    description: 'prefs fixture plugin',
    inputs: {},
    outputs: {},
    capabilities: [],
    secrets: [],
    schedule: 'on_run',
    autonomy_level: 'autonomous',
    approval_class: 'session',
    side_effects: [],
    ttl_hours: 24,
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
    `export async function handler() {
  return {
    status: 'success',
    phases_completed: ['noop'],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: 'noop completed',
    artifacts_produced: [],
    schema_version: 1,
  }
}
`,
  )
}

/** Run `call` with stdout/stderr captured, always restoring the originals. */
async function capture(call: () => Promise<number>): Promise<{ code: number; stdout: string; stderr: string }> {
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
    return { code: await call(), stdout, stderr }
  } finally {
    process.stdout.write = realOut
    process.stderr.write = realErr
  }
}

const prefs = (...args: string[]) => capture(() => run(args))
const advance = () => capture(() => main(['advance']))

type Line = { type: string; warplineseq: number; data: Record<string, unknown> }

/** Every stored line under `<home>/audit/`, segments in name order. */
function lines(): Line[] {
  if (!existsSync(storeDir())) return []
  return readdirSync(storeDir())
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .flatMap((f) =>
      readFileSync(join(storeDir(), f), 'utf-8')
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as Line),
    )
}

const ofType = (type: string, from: Line[] = lines()): Line[] => from.filter((l) => l.type === type)

/**
 * Make the append of `kind` throw once, before anything is written. Every
 * other call goes to the real append.
 */
function failAppend(kind: string): () => number {
  // Read BEFORE `spyOn`: afterwards the namespace property is the mock.
  const real = audit.appendAudit
  let trips = 0
  installed.push(
    spyOn(audit, 'appendAudit').mockImplementation((async (statePath: string, k: string, data: unknown, opts?: unknown) => {
      if (k === kind && trips === 0) {
        trips += 1
        throw new Error(APPEND_SENTINEL)
      }
      return (real as (...args: unknown[]) => Promise<unknown>)(statePath, k, data, opts)
    }) as typeof audit.appendAudit),
  )
  return () => trips
}

describe('warpline prefs set', () => {
  test('a set is on the record with the key and both digests before the file is written, and the next advance sees no hand edit', async () => {
    const realWrite = fsAtomic.atomicWriteJson
    let recordedFirst: boolean | undefined
    installed.push(
      spyOn(fsAtomic, 'atomicWriteJson').mockImplementation(async (path, value) => {
        recordedFirst ??= ofType(SET).length === 1
        return realWrite(path, value)
      }),
    )

    const { code, stdout, stderr } = await prefs('set', 'review_gate', 'false')

    expect(code).toBe(0)
    expect(stderr).toBe('')
    expect(stdout.split('\n').filter(Boolean)).toHaveLength(1)
    expect(stdout).toContain('review_gate')
    expect(recordedFirst).toBe(true)

    const bytes = readFileSync(prefsFile())
    expect((JSON.parse(bytes.toString('utf-8')) as { review_gate: boolean }).review_gate).toBe(false)
    const sets = ofType(SET)
    expect(sets).toHaveLength(1)
    expect(sets[0]!.data).toEqual({ key: 'review_gate', old: null, new: sha(bytes) })

    expect((await advance()).code).toBe(0)
    expect(ofType(OBSERVED)).toHaveLength(0)
  })

  test('a nested key is set by its dotted path, and the record names that path', async () => {
    const { code } = await prefs('set', 'retention.days', '7')

    expect(code).toBe(0)
    const bytes = readFileSync(prefsFile())
    expect((JSON.parse(bytes.toString('utf-8')) as { retention: { days: number } }).retention.days).toBe(7)
    const sets = ofType(SET)
    expect(sets).toHaveLength(1)
    expect(sets[0]!.data).toEqual({ key: 'retention.days', old: null, new: sha(bytes) })
  })

  test('a pending hand edit is recorded first, then the set, then the file is written', async () => {
    expect((await prefs('set', 'review_gate', 'false')).code).toBe(0)
    const edited = JSON.parse(readFileSync(prefsFile(), 'utf-8')) as Record<string, unknown>
    edited.max_sends_per_day = 3
    writeFileSync(prefsFile(), JSON.stringify(edited))
    const handBytes = readFileSync(prefsFile())
    const before = lines().length

    expect((await prefs('set', 'review_gate', 'true')).code).toBe(0)

    const fresh = lines().slice(before)
    expect(fresh.map((l) => l.type)).toEqual([OBSERVED, SET])
    expect(fresh[0]!.warplineseq).toBeLessThan(fresh[1]!.warplineseq)
    const after = readFileSync(prefsFile())
    expect(fresh[1]!.data).toEqual({ key: 'review_gate', old: sha(handBytes), new: sha(after) })
    expect(JSON.parse(after.toString('utf-8'))).toMatchObject({ review_gate: true, max_sends_per_day: 3 })
  })

  test('a value already in effect writes nothing, records nothing, says so, and exits 0', async () => {
    expect((await prefs('set', 'review_gate', 'false')).code).toBe(0)
    const before = await snapshotHome(home.root)
    const count = lines().length

    const { code, stdout, stderr } = await prefs('set', 'review_gate', 'false')

    expect(code).toBe(0)
    expect(stderr).toBe('')
    expect(stdout).toContain('Nothing was written')
    expect(lines()).toHaveLength(count)
    expect(await snapshotHome(home.root)).toEqual(before)
  })

  test('a set whose record cannot be written exits 1 and leaves no file where there was none', async () => {
    const trips = failAppend('preference.set')

    const { code, stdout, stderr } = await prefs('set', 'review_gate', 'false')

    expect(trips()).toBe(1)
    expect(code).toBe(1)
    expect(existsSync(prefsFile())).toBe(false)
    expect(ofType(SET)).toHaveLength(0)
    expect(stderr).toContain('The audit store could not record this change. Nothing was written.')
    expect(stdout + stderr).not.toContain(APPEND_SENTINEL)
  })

  test('a set whose record cannot be written exits 1 and leaves the file byte-identical', async () => {
    expect((await prefs('set', 'review_gate', 'false')).code).toBe(0)
    const bytes = readFileSync(prefsFile())
    const trips = failAppend('preference.set')

    const { code, stdout, stderr } = await prefs('set', 'review_gate', 'true')

    expect(trips()).toBe(1)
    expect(code).toBe(1)
    expect(readFileSync(prefsFile()).equals(bytes)).toBe(true)
    expect(ofType(SET)).toHaveLength(1)
    expect(stdout + stderr).not.toContain(APPEND_SENTINEL)
  })

  test('an unknown key, a value that is not JSON and a value the schema refuses each exit 1, write nothing, record nothing and never echo the value', async () => {
    const refusals: string[][] = [
      ['set', 'no_such_key', '1'],
      ['set', 'review_gate', VALUE_SENTINEL],
      ['set', 'max_sends_per_day', '-5'],
    ]
    // Once on a bare home, once on a home whose store already holds a set.
    for (const seeded of [false, true]) {
      if (seeded) expect((await prefs('set', 'review_gate', 'false')).code).toBe(0)
      for (const argv of refusals) {
        const before = await snapshotHome(home.root)

        const { code, stdout, stderr } = await prefs(...argv)

        expect(code).toBe(1)
        expect(stderr).not.toBe('')
        expect(stdout + stderr).not.toContain(VALUE_SENTINEL)
        expect(stdout + stderr).not.toContain('-5')
        expect(await snapshotHome(home.root)).toEqual(before)
      }
    }
  })

  test('a missing sub-verb, key or value exits 1 with the usage on stderr', async () => {
    for (const argv of [[], ['set'], ['set', 'review_gate'], ['set', 'review_gate', 'true', 'extra'], ['get', 'review_gate']]) {
      const before = await snapshotHome(home.root)

      const { code, stdout, stderr } = await prefs(...argv)

      expect(code).toBe(1)
      expect(stdout).toBe('')
      expect(stderr).toContain('warpline prefs set <dotted.key> <json-value>')
      expect(await snapshotHome(home.root)).toEqual(before)
    }
  })
})
