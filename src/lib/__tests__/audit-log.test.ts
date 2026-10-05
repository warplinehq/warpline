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
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
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

describe('segments', () => {
  type Line = { raw: string; obj: Record<string, any> }
  type Opts = { now?: () => number; maxSegmentBytes?: number; maxSegmentAgeMs?: number }
  const append = audit.appendAudit as unknown as (
    s: string,
    k: string,
    d: unknown,
    o?: Opts,
  ) => Promise<{ seq: number; head: string }>

  const T = Date.parse('2026-01-01T00:00:00.000Z')
  const OPENED = 'warpline.audit.segment.opened'
  const SEALED = 'warpline.audit.segment.sealed'
  const CHECKPOINT = 'warpline.audit.checkpoint.recorded'
  const LIFTED = 'warpline.audit.denial.lifted'
  const name = (seq: number) => `${String(seq).padStart(16, '0')}.jsonl`

  /** The segment files, in name order. */
  const segments = (): string[] => readdirSync(auditDir).filter((n) => /^\d{16}\.jsonl$/.test(n)).sort()

  /** A segment's complete lines, raw and parsed. A partial last line is left out. */
  function lines(file: string): Line[] {
    const raw = readFileSync(join(auditDir, file), 'utf-8').split('\n').slice(0, -1)
    return raw.map((r) => ({ raw: r, obj: JSON.parse(r) }))
  }

  /** Every segment file's bytes, so a later check can hold each as a prefix. */
  function snap(): Map<string, Buffer> {
    return new Map(segments().map((n) => [n, readFileSync(join(auditDir, n))]))
  }

  /** Each file that existed before still starts with its old bytes. */
  function expectPrefix(before: Map<string, Buffer>): void {
    for (const [n, old] of before) {
      expect(readFileSync(join(auditDir, n)).subarray(0, old.length).equals(old)).toBe(true)
    }
  }

  /** An append that also proves no existing byte moved. */
  async function kept(kind: string, data: unknown, opts?: Opts) {
    const before = existsSync(auditDir) ? snap() : new Map<string, Buffer>()
    const result = await append(statePath, kind, data, opts)
    expectPrefix(before)
    return result
  }

  const liftKept = (opts?: Opts) => kept('denial.lifted', { plugin: 'p', fingerprint: HEX_A }, opts)

  /** Whole store: no partial line, contiguous seq, unbroken chain, name order is seq order. */
  function expectWholeChain(): Line[] {
    const names = segments()
    const all: Line[] = []
    for (const n of names) {
      expect(readFileSync(join(auditDir, n), 'utf-8').endsWith('\n')).toBe(true)
      const ls = lines(n)
      expect(n).toBe(name(ls[0]!.obj.warplineseq))
      all.push(...ls)
    }
    expect(all.map((l) => l.obj.warplineseq)).toEqual(all.map((_, i) => i + 1))
    for (let i = 1; i < all.length; i++) expect(all[i]!.obj.warplineprev).toBe(sha256(all[i - 1]!.raw))
    return all
  }

  test('size: a segment at the threshold is sealed, and the record lands after opened and a checkpoint', async () => {
    await liftKept()
    await liftKept()
    const n = statSync(join(auditDir, name(1))).size

    const result = await liftKept({ maxSegmentBytes: n })

    const names = segments()
    expect(names).toHaveLength(2)
    const a = lines(names[0]!)
    const b = lines(names[1]!)
    const sealed = a[a.length - 1]!
    expect(sealed.obj.type).toBe(SEALED)
    expect(sealed.obj.data).toEqual({ reason: 'size', bytes: n })
    expect(names[1]).toBe(name(sealed.obj.warplineseq + 1))
    expect(b.map((l) => l.obj.type)).toEqual([OPENED, CHECKPOINT, LIFTED])

    const opened = b[0]!
    expect(opened.obj.warplineprev).toBe(sha256(sealed.raw))
    expect(opened.obj.data).toEqual({
      home: a[0]!.obj.source,
      version: PACKAGE_VERSION,
      fragment: null,
      authority: { preferences: null, principals: null },
      open_intents: [],
    })
    expect(b[1]!.obj.data).toEqual({ origin: a[0]!.obj.source, size: opened.obj.warplineseq, root: sha256(opened.raw) })
    expect([...names].sort()).toEqual(names)

    const all = expectWholeChain()
    expect(result).toEqual({ seq: all.length, head: sha256(all[all.length - 1]!.raw) })
    expect(await audit.readHead(statePath)).toEqual(result)
  })

  test('size: a segment one byte under the threshold takes the append', async () => {
    await liftKept()
    await liftKept()
    const n = statSync(join(auditDir, name(1))).size

    await liftKept({ maxSegmentBytes: n + 1 })

    expect(segments()).toEqual([name(1)])
    expect(lines(name(1)).map((l) => l.obj.type)).toEqual([OPENED, LIFTED, LIFTED, LIFTED])
  })

  test('age: a segment as old as the threshold from its opened time is sealed', async () => {
    await liftKept({ now: () => T })

    await liftKept({ now: () => T + 1000, maxSegmentAgeMs: 1000 })

    const names = segments()
    expect(names).toHaveLength(2)
    const a = lines(names[0]!)
    expect(a[a.length - 1]!.obj.type).toBe(SEALED)
    expect(a[a.length - 1]!.obj.data.reason).toBe('age')
    expect(lines(names[1]!).map((l) => l.obj.type)).toEqual([OPENED, CHECKPOINT, LIFTED])
    expectWholeChain()
  })

  test('age: a segment one ms younger than the threshold takes the append', async () => {
    await liftKept({ now: () => T })

    await liftKept({ now: () => T + 999, maxSegmentAgeMs: 1000 })

    expect(segments()).toEqual([name(1)])
  })

  test('torn: a partial last line is acknowledged in a new segment, and every old byte stays', async () => {
    await liftKept()
    await liftKept()
    const first = join(auditDir, name(1))
    const fragment = '{"specversion":"1.0","id":"9'
    appendFileSync(first, fragment)
    const old = readFileSync(first)
    const lastComplete = lines(name(1)).at(-1)!

    const result = await liftKept()

    expect(readFileSync(first).equals(old)).toBe(true)
    expect(readFileSync(first, 'utf-8').endsWith(fragment)).toBe(true)
    expect(lines(name(1)).map((l) => l.obj.type)).not.toContain(SEALED)

    const names = segments()
    expect(names).toEqual([name(1), name(lastComplete.obj.warplineseq + 1)])
    const b = lines(names[1]!)
    expect(b.map((l) => l.obj.type)).toEqual([OPENED, LIFTED])
    expect(b[0]!.obj.warplineprev).toBe(sha256(lastComplete.raw))
    expect(b[0]!.obj.data.fragment).toEqual({ bytes: Buffer.byteLength(fragment), sha256: sha256(fragment) })
    expect(b[1]!.obj.warplineprev).toBe(sha256(b[0]!.raw))
    expect(result).toEqual({ seq: b[1]!.obj.warplineseq, head: sha256(b[1]!.raw) })
  })

  test('a segment holding only a partial line refuses the append, names the file, and writes nothing', async () => {
    await liftKept()
    const orphan = name(3)
    writeFileSync(join(auditDir, orphan), '{"specversion":"1.0"')
    const before = await snapshotHome(tmp)

    let caught: unknown
    try {
      await append(statePath, 'denial.lifted', { plugin: 'p', fingerprint: HEX_A })
    } catch (err) {
      caught = err
    }

    expect((caught as Error | undefined)?.name).toBe('AuditAppendError')
    expect((caught as Error).message).toContain(orphan)
    expect(await snapshotHome(tmp)).toEqual(before)
  })

  test('heal: a sealed segment with no successor gets opened and the record, and no checkpoint', async () => {
    await liftKept()
    await liftKept()
    await liftKept()
    const first = join(auditDir, name(1))
    const prior = lines(name(1))
    const last = prior.at(-1)!
    const sealedRaw = JSON.stringify({
      specversion: '1.0',
      id: String(last.obj.warplineseq + 1),
      source: last.obj.source,
      type: SEALED,
      time: new Date().toISOString(),
      datacontenttype: 'application/json',
      warplineseq: last.obj.warplineseq + 1,
      warplineprev: sha256(last.raw),
      data: { reason: 'size', bytes: statSync(first).size },
    })
    appendFileSync(first, `${sealedRaw}\n`)

    await liftKept()

    const names = segments()
    expect(names).toEqual([name(1), name(last.obj.warplineseq + 2)])
    const b = lines(names[1]!)
    expect(b.map((l) => l.obj.type)).toEqual([OPENED, LIFTED])
    expect(b[0]!.obj.warplineprev).toBe(sha256(sealedRaw))
    expect(b[0]!.obj.data.fragment).toBeNull()
    expectWholeChain()
  })

  /** The open_intents of the newest segment.opened. */
  const lastOpened = () => lines(segments().at(-1)!)[0]!.obj
  const rotate = () => liftKept({ maxSegmentBytes: 1 })

  test('carry: authority and open intents ride every segment.opened, and a closed intent drops out', async () => {
    await kept('preference.set', { key: 'review_gate', old: null, new: 'b'.repeat(64) })
    await kept('principal.added', {
      id: 'ops',
      type: 'human',
      key_sha256: null,
      sha256: 'c'.repeat(64),
      entries: { ops: 'd'.repeat(64) },
    })
    const a = await kept('fire.intent', { plugin: 'a', run_id: 'r1', class: 'session', effect_id: null, fingerprint: null })
    const b = await kept('fire.intent', {
      plugin: 'b',
      run_id: 'r1',
      class: 'content',
      effect_id: 'e'.repeat(64),
      fingerprint: HEX_A,
    })
    const authority = {
      preferences: 'b'.repeat(64),
      principals: { sha256: 'c'.repeat(64), entries: { ops: 'd'.repeat(64) } },
    }
    const A = { seq: a.seq, plugin: 'a', run_id: 'r1', effect_id: null }
    const B = { seq: b.seq, plugin: 'b', run_id: 'r1', effect_id: 'e'.repeat(64) }

    await rotate()
    expect(segments()).toHaveLength(2)
    expect(lastOpened().data.authority).toEqual(authority)
    expect(lastOpened().data.open_intents).toEqual([A, B])

    await kept('fire.outcome', { plugin: 'a', run_id: 'r1', intent_seq: a.seq, status: 'success' })
    await rotate()
    expect(segments()).toHaveLength(3)
    expect(lastOpened().data.authority).toEqual(authority)
    expect(lastOpened().data.open_intents).toEqual([B])

    await kept('fire.refused', { plugin: 'b', run_id: 'r1', reason: 'mark_uncertain', intent_seq: b.seq })
    await rotate()
    expect(segments()).toHaveLength(4)
    expect(lastOpened().data.authority).toEqual(authority)
    expect(lastOpened().data.open_intents).toEqual([])
    expectWholeChain()
  })

  test('carry: fire.resolved closes its intent, and a fire.refused with no intent_seq closes nothing', async () => {
    const a = await kept('fire.intent', { plugin: 'a', run_id: 'r1', class: 'session', effect_id: null, fingerprint: null })
    const b = await kept('fire.intent', { plugin: 'b', run_id: 'r2', class: 'session', effect_id: null, fingerprint: null })
    await kept('fire.resolved', { plugin: 'a', effect_id: 'f'.repeat(64), intent_seq: a.seq })
    await kept('fire.refused', { plugin: 'b', run_id: 'r2', reason: 'outside_window', intent_seq: null })

    await rotate()

    expect(lastOpened().data.open_intents).toEqual([{ seq: b.seq, plugin: 'b', run_id: 'r2', effect_id: null }])
    expect(lastOpened().data.authority).toEqual({ preferences: null, principals: null })
  })
})

describe('authority files', () => {
  const REGISTRY = 'warpline.audit.principal_registry.observed'
  const bytesA = Buffer.from('{"principals":[{"id":"ops"}]}')
  const bytesB = Buffer.from('{"principals":[{"id":"ops"},{"id":"ci"}]}')
  const digestA = createHash('sha256').update(bytesA).digest('hex')
  const digestB = createHash('sha256').update(bytesB).digest('hex')
  const observedLines = () =>
    readdirSync(auditDir)
      .filter((n) => /^\d{16}\.jsonl$/.test(n))
      .sort()
      .flatMap((n) => readFileSync(join(auditDir, n), 'utf-8').split('\n').filter((l) => l !== ''))
      .map((l) => JSON.parse(l) as { type: string; warplineseq: number; data: Record<string, unknown> })
      .filter((r) => r.type === REGISTRY)

  test('the registry is recorded by entry: ids added or changed are named, and a repeat of the same bytes records nothing, across a rotation too', async () => {
    expect(typeof audit.observeAuthorityFile).toBe('function')
    const first = await audit.observeAuthorityFile(statePath, 'principal_registry.observed', bytesA, { ops: 'a'.repeat(64) })

    expect(first).not.toBeNull()
    expect(observedLines()).toHaveLength(1)
    expect(observedLines()[0]!.warplineseq).toBe(first!.seq)
    expect(observedLines()[0]!.data).toEqual({
      old: null,
      new: digestA,
      changed_ids: ['ops'],
      editor: 'unknown',
      entries: { ops: 'a'.repeat(64) },
    })

    const second = await audit.observeAuthorityFile(statePath, 'principal_registry.observed', bytesB, {
      ops: 'b'.repeat(64),
      ci: 'c'.repeat(64),
    })

    expect(second).not.toBeNull()
    expect(observedLines()).toHaveLength(2)
    expect(observedLines()[1]!.data).toEqual({
      old: digestA,
      new: digestB,
      changed_ids: ['ci', 'ops'],
      editor: 'unknown',
      entries: { ops: 'b'.repeat(64), ci: 'c'.repeat(64) },
    })

    const entriesB = { ops: 'b'.repeat(64), ci: 'c'.repeat(64) }
    expect(await audit.observeAuthorityFile(statePath, 'principal_registry.observed', bytesB, entriesB)).toBeNull()
    expect(observedLines()).toHaveLength(2)

    await audit.appendAudit(statePath, 'denial.lifted', { plugin: 'p', fingerprint: HEX_A }, { maxSegmentBytes: 1 })
    expect(readdirSync(auditDir).filter((n) => /^\d{16}\.jsonl$/.test(n))).toHaveLength(2)

    expect(await audit.observeAuthorityFile(statePath, 'principal_registry.observed', bytesB, entriesB)).toBeNull()
    expect(observedLines()).toHaveLength(2)
  })

  test('an id that leaves the registry is named as changed', async () => {
    expect(typeof audit.observeAuthorityFile).toBe('function')
    await audit.observeAuthorityFile(statePath, 'principal_registry.observed', bytesB, {
      ops: 'b'.repeat(64),
      ci: 'c'.repeat(64),
    })

    await audit.observeAuthorityFile(statePath, 'principal_registry.observed', bytesA, { ci: 'c'.repeat(64) })

    expect(observedLines()[1]!.data.changed_ids).toEqual(['ops'])
  })
})
