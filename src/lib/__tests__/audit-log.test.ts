/**
 * The audit store's own rules, pinned at the module.
 *
 * Every case gets its own temp home and passes the state file path the way a
 * caller does. The file need not exist: the store is the state file's
 * grandparent plus `audit`, so `<tmp>/state/engine-state.json` puts it at
 * `<tmp>/audit`.
 *
 * Expected hashes are computed here with `node:crypto`, never with a helper
 * from the module under test. A check that borrowed the writer's hashing would
 * agree with it by construction.
 *
 * Everything this file writes goes under temp dirs (AGENTS.md Rule 2).
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as audit from '../audit-log.js'
import { snapshotHome } from '../../runtime/__tests__/helpers/snapshot-home.js'
import { testFixturesDir } from '../../../test-utils/fixtures.js'

const ZEROS = '0'.repeat(64)
const HEX_A = 'a'.repeat(64)
const PACKAGE_VERSION = (
  JSON.parse(readFileSync(testFixturesDir(import.meta.url, '../../../package.json'), 'utf-8')) as {
    version: string
  }
).version

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

let tmp: string
let statePath: string
let auditDir: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'warpline-audit-log-'))
  statePath = join(tmp, 'state', 'engine-state.json')
  auditDir = join(tmp, 'audit')
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

/** The active segment's lines, split on newline, the empty tail dropped. */
function segmentLines(): string[] {
  const text = readFileSync(join(auditDir, '0000000000000001.jsonl'), 'utf-8')
  expect(text.endsWith('\n')).toBe(true)
  return text.slice(0, -1).split('\n')
}

const lift = () => audit.appendAudit(statePath, 'denial.lifted', { plugin: 'p', fingerprint: HEX_A })

describe('audit store: genesis and the chain', () => {
  test('readHead on a home with no store is seq 0 and 64 zeros, and creates nothing', async () => {
    expect(await audit.readHead(statePath)).toEqual({ seq: 0, head: '0'.repeat(64) })
    expect(existsSync(auditDir)).toBe(false)
  })

  test('the first append writes genesis then the record, chained over the written bytes', async () => {
    const result = await lift()

    expect(readdirSync(auditDir)).toEqual(['0000000000000001.jsonl'])
    const lines = segmentLines()
    expect(lines).toHaveLength(2)

    const genesis = JSON.parse(lines[0]!)
    expect(Object.keys(genesis)).toEqual([
      'specversion',
      'id',
      'source',
      'type',
      'time',
      'datacontenttype',
      'warplineseq',
      'warplineprev',
      'data',
    ])
    expect(genesis.specversion).toBe('1.0')
    expect(genesis.id).toBe('1')
    expect(genesis.type).toBe('warpline.audit.segment.opened')
    expect(genesis.datacontenttype).toBe('application/json')
    expect(genesis.warplineseq).toBe(1)
    expect(genesis.warplineprev).toBe(ZEROS)
    expect(genesis.source).toMatch(/^urn:uuid:[0-9a-f-]{36}$/)
    expect(genesis.data.home).toBe(genesis.source)
    expect(genesis.data.version).toBe(PACKAGE_VERSION)
    expect(genesis.data.fragment).toBeNull()
    expect(genesis.data.authority).toEqual({ preferences: null, principals: null })
    expect(genesis.data.open_intents).toEqual([])

    const record = JSON.parse(lines[1]!)
    expect(Object.keys(record)).toEqual(Object.keys(genesis))
    expect(record.id).toBe('2')
    expect(record.warplineseq).toBe(2)
    expect(record.type).toBe('warpline.audit.denial.lifted')
    expect(record.source).toBe(genesis.source)
    expect(record.warplineprev).toBe(sha256(lines[0]!))
    expect(Number.isNaN(Date.parse(record.time))).toBe(false)
    expect(record.data).toEqual({ plugin: 'p', fingerprint: HEX_A })

    expect(result).toEqual({ seq: 2, head: sha256(lines[1]!) })
    expect(await audit.readHead(statePath)).toEqual(result)
  })
})

describe('audit store: what it refuses writes nothing and echoes nothing', () => {
  /** Refuse, and prove the refusal wrote nothing and named the right error. */
  async function refuses(append: () => Promise<unknown>): Promise<Error> {
    await lift()
    const before = await snapshotHome(tmp)
    let caught: unknown
    try {
      await append()
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).name).toBe('AuditAppendError')
    expect(await snapshotHome(tmp)).toEqual(before)
    return caught as Error
  }

  const anyAppend = audit.appendAudit as (s: string, k: string, d: unknown) => Promise<unknown>

  test('a kind outside the closed set', async () => {
    await refuses(() => anyAppend(statePath, 'bogus.kind', {}))
  })

  for (const kind of ['segment.opened', 'segment.sealed', 'checkpoint.recorded']) {
    test(`the internal kind ${kind}`, async () => {
      await refuses(() => anyAppend(statePath, kind, {}))
    })
  }

  for (const kind of ['grant.renewed', 'ask.raised', 'ask.answered', 'handoff.tried']) {
    test(`the pending kind ${kind}, whose schema admits nothing yet`, async () => {
      await refuses(() => anyAppend(statePath, kind, {}))
    })
  }

  test('data with a key its kind does not declare', async () => {
    await refuses(() => anyAppend(statePath, 'denial.lifted', { plugin: 'p', fingerprint: HEX_A, extra: 1 }))
  })

  test('a digest that is not hex, without echoing it', async () => {
    const err = await refuses(() =>
      anyAppend(statePath, 'denial.lifted', { plugin: 'p', fingerprint: 'NOT-HEX-SENTINEL-1234' }),
    )
    expect(err.message).not.toContain('NOT-HEX-SENTINEL-1234')
  })

  test('a line over 16384 bytes', async () => {
    const scopes = Array.from({ length: 200 }, (_, i) => `${String(i).padStart(3, '0')}${'s'.repeat(97)}`)
    await refuses(() =>
      anyAppend(statePath, 'grant.issued', { scopes, ttl_ms: null, replace: false, long: false }),
    )
  })
})

describe('audit store: the lock', () => {
  test('a lock held by a live holder makes the append reject once its timeout passes, and the lock stays', async () => {
    await lift()
    const lockPath = join(auditDir, '.lock')
    writeFileSync(lockPath, JSON.stringify({ token: 'held-by-other', at: Date.now() }))
    const segment = readFileSync(join(auditDir, '0000000000000001.jsonl'))

    const started = Date.now()
    let caught: unknown
    try {
      await audit.appendAudit(statePath, 'denial.lifted', { plugin: 'p', fingerprint: null }, { lockTimeoutMs: 200 })
    } catch (err) {
      caught = err
    }
    expect(Date.now() - started).toBeLessThan(2000)
    expect((caught as Error | undefined)?.name).toBe('AuditAppendError')
    expect(readFileSync(join(auditDir, '0000000000000001.jsonl'))).toEqual(segment)
    expect(readFileSync(lockPath, 'utf-8')).toContain('held-by-other')
  })

  test('a lock older than 30 s is broken and the append proceeds', async () => {
    await lift()
    const lockPath = join(auditDir, '.lock')
    writeFileSync(lockPath, JSON.stringify({ token: 'held-by-other', at: Date.now() - 31_000 }))

    const result = await lift()

    expect(result.seq).toBe(3)
    expect(existsSync(lockPath)).toBe(false)
  })

  test('20 appends issued at once from one process come out contiguous and whole', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => lift()))

    expect(new Set(results.map((r) => r.seq)).size).toBe(20)
    const lines = segmentLines()
    expect(lines).toHaveLength(21)
    expect(lines.map((l) => (JSON.parse(l) as { warplineseq: number }).warplineseq)).toEqual(
      Array.from({ length: 21 }, (_, i) => i + 1),
    )
  })
})

describe('audit store: every append is synced before it resolves', () => {
  let spy: ReturnType<typeof spyOn> | undefined

  beforeEach(async () => {
    // The FileHandle class is not exported, so take its prototype off a handle.
    const probe = join(tmp, 'probe')
    mkdirSync(tmp, { recursive: true })
    const handle = await open(probe, 'w')
    const proto = Object.getPrototypeOf(handle) as { datasync: () => Promise<void> }
    await handle.close()
    spy = spyOn(proto, 'datasync')
  })

  afterEach(() => {
    spy?.mockRestore()
    spy = undefined
  })

  test('genesis and the record are each followed by datasync, and so is every later append', async () => {
    await lift()
    const afterFirst = spy!.mock.calls.length
    expect(afterFirst).toBeGreaterThanOrEqual(2)

    await lift()
    expect(spy!.mock.calls.length).toBeGreaterThanOrEqual(afterFirst + 1)
  })
})
