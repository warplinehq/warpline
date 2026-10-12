/**
 * The Ask store, pinned at the module.
 *
 * A decision handed in as data becomes an Ask: recorded on the audit store
 * first, then stored owner-only and synced, then carried to `notify` as one
 * entry of one message, whose try is recorded against the entry's own seq.
 * The store reads closed: a file that cannot be read is never read as "no
 * Asks".
 *
 * Every case gets its own temp dir and passes the state file path the way a
 * caller does (AGENTS.md Rule 2). The clock is fixed and handed in.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import {
  ASK_MAX_AGE_MS,
  ASKS_READER_VERSION,
  advanceAsks,
  askMessage,
  asksPath,
  askSummary,
  newAskId,
  newNonce,
  readAsks,
  recordTry,
  writeAsks,
  type Ask,
  type AskDecision,
  type AskStore,
} from '../asks.js'
// The exports this file pins before they exist, read through the namespace so
// a missing one fails its own case and not the whole file.
import * as askLib from '../asks.js'
import * as audit from '../audit-log.js'
import { notifyEnv, runNotify } from '../notify.js'
import { notifyStub } from '../../../test-utils/notify-stub.js'
import { MAX_GRANT_WINDOW_MS } from '../../runtime/approval-gate.js'

const T0 = Date.parse('2026-10-11T08:00:00.000Z')
const HOUR = 60 * 60 * 1000
const HEX_A = 'a'.repeat(64)
const HEX_B = 'b'.repeat(64)
const iso = (ms: number): string => new Date(ms).toISOString()

let dir: string
let statePath: string
const spies: Array<ReturnType<typeof spyOn>> = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'warpline-asks-'))
  statePath = join(dir, 'state', 'engine-state.json')
})

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore()
  rmSync(dir, { recursive: true, force: true })
})

const empty = (): AskStore => ({ min_reader_version: 1, asks: [] })

const missingGrant = (scope = 'mailer', digest = HEX_A): AskDecision => ({
  kind: 'missing_grant',
  scope,
  plugin: scope,
  digest,
  clock: null,
})

const REMINDERS = [HOUR, 4 * HOUR] as const

type PassExtra = { evaluatedPlugins?: ReadonlySet<string>; standingListed?: boolean; remindersMs?: readonly number[] }

/**
 * One pass, the way the engine calls it: every decision's scope was evaluated,
 * the standing store was readable, and reminders are the default schedule.
 */
function pass(store: AskStore, decisions: readonly AskDecision[], now: number, extra: PassExtra = {}) {
  return advanceAsks(statePath, store, {
    decisions,
    now,
    evaluatedPlugins: extra.evaluatedPlugins ?? new Set(decisions.map((d) => d.scope)),
    standingListed: extra.standingListed ?? true,
    remindersMs: extra.remindersMs ?? REMINDERS,
  })
}

/** Every audit record of `kind` under the temp home, in store order. */
function auditRecords(kind: string): Array<{ type: string; data: unknown }> {
  const auditDir = join(dir, 'audit')
  if (!existsSync(auditDir)) return []
  return readdirSync(auditDir)
    .filter((n) => n.endsWith('.jsonl'))
    .sort()
    .flatMap((n) =>
      readFileSync(join(auditDir, n), 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { type: string; data: unknown }),
    )
    .filter((r) => r.type === `warpline.audit.${kind}`)
}

describe('a decision becomes a recorded Ask whose message reaches notify', () => {
  test('a missing-Grant decision is recorded, stored owner-only, and its one entry reaches a notify stub', async () => {
    const before = await readAsks(statePath)
    expect(before).toEqual({ readable: true, store: { min_reader_version: 1, asks: [] } })
    if (!before.readable) throw new Error('unreadable')

    const out = await pass(before.store, [missingGrant()], T0)
    expect(out.unrecorded).toBe(0)
    expect(out.changed).toBe(true)
    expect(out.entries).toHaveLength(1)

    await writeAsks(statePath, out.store)
    const path = asksPath(statePath)
    expect(path).toBe(join(dir, 'state', 'asks.json'))
    expect(statSync(path).mode & 0o777).toBe(0o600)

    const file = JSON.parse(readFileSync(path, 'utf-8')) as { min_reader_version: number; asks: Array<Record<string, unknown>> }
    expect(file.min_reader_version).toBe(1)
    expect(file.asks).toHaveLength(1)
    const ask = file.asks[0]!
    expect(ask.id).toMatch(/^[0-9a-f]{12}$/)
    expect(ask.nonce).toMatch(/^[0-9a-f]{32}$/)
    expect(ask).toEqual({
      id: ask.id,
      nonce: ask.nonce,
      kind: 'missing_grant',
      scope: 'mailer',
      plugin: 'mailer',
      digest: HEX_A,
      summary: askSummary('missing_grant', 'mailer'),
      raised_at: iso(T0),
      expires_at: iso(T0 + 23 * HOUR),
      state: 'open',
      closed_at: null,
      answer: null,
      events: [{ seq: 1, event: 'raised', at: iso(T0) }],
      tries: [],
    })

    const raised = auditRecords('ask.raised')
    expect(raised).toHaveLength(1)
    expect(raised[0]!.data).toEqual({
      id: ask.id,
      kind: 'missing_grant',
      scope: 'mailer',
      plugin: 'mailer',
      digest: HEX_A,
      raised_at: iso(T0),
      expires_at: iso(T0 + 23 * HOUR),
    })

    const okStub = await notifyStub(dir, 'ok')
    const outcome = await runNotify(okStub.argv, askMessage(out.entries, false), 5000, notifyEnv())
    expect(outcome).toEqual({ outcome: 'delivered', exit_code: 0 })
    const messages = okStub.messages() as Array<{ entries: Array<Record<string, unknown>> }>
    expect(messages).toEqual([
      {
        entries: [
          {
            id: ask.id,
            seq: 1,
            event: 'raised',
            kind: 'missing_grant',
            scope: 'mailer',
            plugin: 'mailer',
            digest: HEX_A,
            nonce: ask.nonce,
            summary: ask.summary,
            raised_at: iso(T0),
            expires_at: iso(T0 + 23 * HOUR),
          },
        ],
      },
    ])
    expect(Object.keys(messages[0]!.entries[0]!)).toEqual([
      'id',
      'seq',
      'event',
      'kind',
      'scope',
      'plugin',
      'digest',
      'nonce',
      'summary',
      'raised_at',
      'expires_at',
    ])

    const at = iso(T0 + 1000)
    const tried = recordTry(out.store, out.entries, { at, outcome: 'delivered', exit_code: 0 })
    expect(tried.asks[0]!.tries).toEqual([{ seq: 1, at, outcome: 'delivered', exit_code: 0 }])
  })

  test('a refused ask.raised stores nothing and sends nothing', async () => {
    const real = audit.appendAudit
    spies.push(
      spyOn(audit, 'appendAudit').mockImplementation((async (p: string, kind: string, data: unknown, opts?: unknown) => {
        if (kind === 'ask.raised') throw new Error('refused for the test')
        return (real as (...args: unknown[]) => Promise<unknown>)(p, kind, data, opts)
      }) as typeof audit.appendAudit),
    )
    const store = empty()

    const out = await pass(store, [missingGrant()], T0)

    expect(out.unrecorded).toBe(1)
    expect(out.entries).toEqual([])
    expect(out.changed).toBe(false)
    expect(out.store).toEqual(empty())
    expect(store).toEqual(empty())
    expect(auditRecords('ask.raised')).toEqual([])
  })

  test('an unchanged decision raises nothing new, and an undelivered entry stays due with its seq', async () => {
    const first = await pass(empty(), [missingGrant()], T0)
    const id = first.store.asks[0]!.id

    const second = await pass(first.store, [missingGrant()], T0 + 60_000)
    expect(second.unrecorded).toBe(0)
    expect(second.changed).toBe(false)
    expect(second.store.asks.map((a) => a.id)).toEqual([id])
    expect(second.entries.map((e) => [e.id, e.seq, e.event])).toEqual([[id, 1, 'raised']])
    expect(auditRecords('ask.raised')).toHaveLength(1)

    const failed = recordTry(second.store, second.entries, { at: iso(T0 + 61_000), outcome: 'failed', exit_code: 3 })
    const third = await pass(failed, [missingGrant()], T0 + 120_000)
    expect(third.entries.map((e) => [e.id, e.seq])).toEqual([[id, 1]])

    const delivered = recordTry(third.store, third.entries, { at: iso(T0 + 121_000), outcome: 'delivered', exit_code: 0 })
    const fourth = await pass(delivered, [missingGrant()], T0 + 180_000)
    expect(fourth.entries).toEqual([])
    expect(fourth.store.asks.map((a) => a.id)).toEqual([id])
  })

  test('an Ask expires at the earlier of its subject\'s clock and 23 hours after it was raised', async () => {
    const out = await pass(
      empty(),
      [
        { ...missingGrant('soon'), clock: T0 + 2 * HOUR },
        { ...missingGrant('late'), clock: T0 + 30 * HOUR },
      ],
      T0,
    )
    const byScope = Object.fromEntries(out.store.asks.map((a) => [a.scope, a.expires_at]))
    expect(byScope).toEqual({ soon: iso(T0 + 2 * HOUR), late: iso(T0 + 23 * HOUR) })
  })

  test('a decision whose own clock has run out raises nothing, at its clock and after it', async () => {
    const out = await pass(
      empty(),
      [
        { ...missingGrant('past'), clock: T0 - 1 },
        { ...missingGrant('now'), clock: T0 },
        { ...missingGrant('later'), clock: T0 + 1 },
      ],
      T0,
    )
    expect(out.store.asks.map((a) => [a.scope, a.expires_at])).toEqual([['later', iso(T0 + 1)]])
    expect(auditRecords('ask.raised').map((r) => (r.data as { scope: string }).scope)).toEqual(['later'])
    expect(out.entries.map((e) => e.scope)).toEqual(['later'])
  })

  test('the summary is a fixed sentence for each kind, built from the plugin name only', () => {
    expect(askSummary('missing_grant', 'mailer')).toBe(
      'mailer declares side effects and holds no Grant, so it did not run. Approve or deny it.',
    )
    expect(askSummary('parked_result', 'mailer')).toBe('mailer ran and its result is parked for review. Approve or deny it.')
    expect(askSummary('content', 'mailer')).toBe('mailer is waiting for its content to be approved. Approve or deny it.')
    expect(askSummary('renewal', null)).toBe('A standing grant is due for renewal. Renew it or deny it.')
    expect(askSummary('renewal', 'mailer')).toBe(askSummary('renewal', null))
    for (const kind of ['missing_grant', 'parked_result', 'content'] as const) {
      expect(askSummary(kind, 'alpha').split('alpha').join('beta')).toBe(askSummary(kind, 'beta'))
    }
  })

  test('the message carries content only when asked for', async () => {
    const out = await pass(empty(), [{ ...missingGrant('with'), content: 'the bytes' }, missingGrant('without', HEX_B)], T0)
    const withContent = JSON.parse(askMessage(out.entries, true)) as { entries: Array<Record<string, unknown>> }
    expect(Object.fromEntries(withContent.entries.map((e) => [e.scope, e.content]))).toEqual({
      with: 'the bytes',
      without: null,
    })
    const plain = JSON.parse(askMessage(out.entries, false)) as { entries: Array<Record<string, unknown>> }
    expect(plain.entries.every((e) => !('content' in e))).toBe(true)
  })
})

describe('the store reads closed', () => {
  const valid = {
    id: 'a1b2c3d4e5f6',
    nonce: '0123456789abcdef0123456789abcdef',
    kind: 'missing_grant',
    scope: 'mailer',
    plugin: 'mailer',
    digest: HEX_A,
    summary: 'mailer declares side effects and holds no Grant, so it did not run. Approve or deny it.',
    raised_at: iso(T0),
    expires_at: iso(T0 + 23 * HOUR),
    state: 'open',
    closed_at: null,
    answer: null,
    events: [{ seq: 1, event: 'raised', at: iso(T0) }],
    tries: [],
  }

  const place = (text: string): void => {
    mkdirSync(join(dir, 'state'), { recursive: true })
    writeFileSync(asksPath(statePath), text)
  }

  test('a missing file is readable and empty', async () => {
    expect(await readAsks(statePath)).toEqual({ readable: true, store: { min_reader_version: ASKS_READER_VERSION, asks: [] } })
  })

  test('a valid file reads, and an unknown key at either level is ignored', async () => {
    place(JSON.stringify({ min_reader_version: 1, later: true, asks: [{ ...valid, added_later: 1 }] }))
    const read = await readAsks(statePath)
    if (!read.readable) throw new Error(`unreadable: ${read.cause}`)
    expect(read.store.asks.map((a) => a.id)).toEqual([valid.id])
  })

  test('text that is not JSON is corrupt', async () => {
    place('{')
    expect(await readAsks(statePath)).toEqual({ readable: false, cause: 'corrupt' })
  })

  test('a reader version above this build is newer reader, read before any other field', async () => {
    place('{"min_reader_version":2,"asks":[]}')
    expect(await readAsks(statePath)).toEqual({ readable: false, cause: 'newer reader' })
    place('{"min_reader_version":2,"asks":"junk"}')
    expect(await readAsks(statePath)).toEqual({ readable: false, cause: 'newer reader' })
  })

  test('a reader version of 0, a string, or none is corrupt', async () => {
    for (const text of ['{"min_reader_version":0,"asks":[]}', '{"min_reader_version":"1","asks":[]}', '{"asks":[]}']) {
      place(text)
      expect(await readAsks(statePath)).toEqual({ readable: false, cause: 'corrupt' })
    }
  })

  test('a file that is not an object, or whose asks is not an array, is corrupt', async () => {
    for (const text of ['[]', 'null', '{"min_reader_version":1,"asks":{}}', '{"min_reader_version":1}']) {
      place(text)
      expect(await readAsks(statePath)).toEqual({ readable: false, cause: 'corrupt' })
    }
  })

  test('one Ask that fails the schema, or two sharing an id, is corrupt', async () => {
    place(JSON.stringify({ min_reader_version: 1, asks: [valid, { ...valid, id: 'b1b2c3d4e5f6', nonce: 'f'.repeat(31) }] }))
    expect(await readAsks(statePath)).toEqual({ readable: false, cause: 'corrupt' })
    place(JSON.stringify({ min_reader_version: 1, asks: [valid, valid] }))
    expect(await readAsks(statePath)).toEqual({ readable: false, cause: 'corrupt' })
  })

  test('a directory at the path is io', async () => {
    mkdirSync(asksPath(statePath), { recursive: true })
    expect(await readAsks(statePath)).toEqual({ readable: false, cause: 'io' })
  })
})

describe('ids and nonces', () => {
  test('ids drawn through a pass are unique and 12 hex, and each nonce is 32 hex and never its id', async () => {
    const decisions = Array.from({ length: 200 }, (_, i) => missingGrant(`p${i}`))
    const out = await pass(empty(), decisions, T0)
    expect(out.unrecorded).toBe(0)
    const ids = out.store.asks.map((a) => a.id)
    expect(ids).toHaveLength(200)
    expect(new Set(ids).size).toBe(200)
    for (const ask of out.store.asks) {
      expect(ask.id).toMatch(/^[0-9a-f]{12}$/)
      expect(ask.nonce).toMatch(/^[0-9a-f]{32}$/)
      expect(ask.nonce.startsWith(ask.id)).toBe(false)
    }
    expect(newAskId()).toMatch(/^[0-9a-f]{12}$/)
    expect(newNonce()).toMatch(/^[0-9a-f]{32}$/)
  })

  test('the 23-hour cap equals the gate\'s grant window', () => {
    expect(ASK_MAX_AGE_MS).toBe(23 * HOUR)
    expect(ASK_MAX_AGE_MS).toBe(MAX_GRANT_WINDOW_MS)
  })
})

describe('tries', () => {
  test('recordTry appends to each Ask an entry names with that entry\'s seq, and skips an Ask no longer in the store', async () => {
    const out = await pass(empty(), [missingGrant('a'), missingGrant('b', HEX_B)], T0)
    const t = { at: iso(T0 + 1000), outcome: 'timeout' as const, exit_code: null }

    const tried = recordTry(out.store, out.entries, t)
    expect(tried.asks.map((a) => a.tries)).toEqual([[{ seq: 1, ...t }], [{ seq: 1, ...t }]])
    expect(out.store.asks.map((a) => a.tries)).toEqual([[], []])

    const pruned: AskStore = { ...tried, asks: tried.asks.filter((a) => a.scope === 'a') }
    const again = recordTry(pruned, out.entries, t)
    expect(again.asks.map((a) => [a.scope, a.tries.length])).toEqual([['a', 2]])
  })

  // The held-out edge of SPEC R3: two advances racing to send one undelivered
  // Ask may both send. Each records its try under the entry's one seq, and the
  // Ask's event seqs stay unique, so a receiver drops the duplicate by (id, seq).
  test('two deliveries of one Ask both record their tries under one seq, and its event seqs stay unique', async () => {
    const out = await pass(empty(), [missingGrant()], T0)
    const first = { at: iso(T0 + 1000), outcome: 'delivered' as const, exit_code: 0 }
    const second = { at: iso(T0 + 2000), outcome: 'delivered' as const, exit_code: 0 }

    const both = recordTry(recordTry(out.store, out.entries, first), out.entries, second)
    const ask = both.asks[0]!
    expect(ask.tries).toEqual([
      { seq: 1, ...first },
      { seq: 1, ...second },
    ])
    const seqs = ask.events.map((e) => e.seq)
    expect(new Set(seqs).size).toBe(seqs.length)

    const next = await pass(both, [missingGrant()], T0 + 3000)
    expect(next.entries).toEqual([])
    expect(next.store.asks[0]!.events.map((e) => e.seq)).toEqual([1])
  })
})

describe('severity, order and the renewal digest', () => {
  const grant = {
    id: 'a1b2c3d4e5f6',
    holder: 'ci',
    issuer: 'ops',
    scopes: ['zeta', 'alpha'],
    issued_at: iso(T0),
    period_start: iso(T0),
    period_ms: 12 * HOUR,
    hard_max_ms: 30 * 24 * HOUR,
  }

  test('renewalDigest is sha256 over the stored grant\'s fields in the store\'s key order, and a renew changes it', () => {
    const expected = createHash('sha256')
      .update(
        JSON.stringify({
          id: grant.id,
          holder: grant.holder,
          issuer: grant.issuer,
          scopes: ['alpha', 'zeta'],
          issued_at: grant.issued_at,
          period_start: grant.period_start,
          period_ms: grant.period_ms,
          hard_max_ms: grant.hard_max_ms,
        }),
      )
      .digest('hex')
    expect(askLib.renewalDigest(grant)).toBe(expected)
    expect(askLib.renewalDigest({ ...grant, scopes: ['alpha', 'zeta'] })).toBe(expected)
    expect(askLib.renewalDigest({ ...grant, period_start: iso(T0 + HOUR) })).not.toBe(expected)
  })

  test('askSeverity gives parked_result and renewal warning, missing_grant and content info', () => {
    expect(askLib.askSeverity('parked_result')).toBe('warning')
    expect(askLib.askSeverity('renewal')).toBe('warning')
    expect(askLib.askSeverity('missing_grant')).toBe('info')
    expect(askLib.askSeverity('content')).toBe('info')
  })

  test('entries order warning before info, then oldest raised_at, then id', async () => {
    const content = (scope: string): AskDecision => ({ kind: 'content', scope, plugin: scope, digest: HEX_B, clock: null })
    const parked = (scope: string): AskDecision => ({ kind: 'parked_result', scope, plugin: scope, digest: HEX_A, clock: null })
    // Two info Asks at T0, one a minute later, and the warning one last of all.
    const first = await pass(empty(), [content('c'), missingGrant('n')], T0)
    const second = await pass(first.store, [content('c'), missingGrant('n'), missingGrant('m')], T0 + 60_000)
    const third = await pass(second.store, [content('c'), missingGrant('n'), missingGrant('m'), parked('p')], T0 + 120_000)

    const idOf = (scope: string): string => third.store.asks.find((a) => a.scope === scope)!.id
    const sameInstant = ['c', 'n'].sort((x, y) => (idOf(x) < idOf(y) ? -1 : idOf(x) > idOf(y) ? 1 : 0))
    expect(third.entries.map((e) => e.scope)).toEqual(['p', ...sameInstant, 'm'])
  })
})

describe('the lifecycle', () => {
  const MIN = 60 * 1000
  const GRANT = 'a1b2c3d4e5f6'
  const shape = (entries: ReadonlyArray<{ id: string; seq: number; event: string }>) =>
    entries.map((e) => [e.id, e.seq, e.event])
  const eventsOf = (store: AskStore, i = 0): string[] => store.asks[i]!.events.map((e) => e.event)

  /** The audit store refuses every `ask.raised` from here on, and takes every other kind. */
  function refuseRaise(): void {
    const real = audit.appendAudit
    spies.push(
      spyOn(audit, 'appendAudit').mockImplementation((async (p: string, kind: string, data: unknown, opts?: unknown) => {
        if (kind === 'ask.raised') throw new Error('refused for the test')
        return (real as (...args: unknown[]) => Promise<unknown>)(p, kind, data, opts)
      }) as typeof audit.appendAudit),
    )
  }

  /** A stored Ask on `mailer`, raised an hour before T0, with `over` laid on it. */
  const stored = (over: Partial<Ask>): Ask => ({
    id: 'c0ffee000001',
    nonce: '0123456789abcdef0123456789abcdef',
    kind: 'missing_grant',
    scope: 'mailer',
    plugin: 'mailer',
    digest: HEX_A,
    summary: askSummary('missing_grant', 'mailer'),
    raised_at: iso(T0 - HOUR),
    expires_at: iso(T0 + 22 * HOUR),
    state: 'open',
    closed_at: null,
    answer: null,
    events: [{ seq: 1, event: 'raised', at: iso(T0 - HOUR) }],
    tries: [],
    ...over,
  })
  const storeOf = (...asks: Ask[]): AskStore => ({ min_reader_version: 1, asks })

  test('a changed digest closes the open Ask superseded and raises a new one with a new nonce', async () => {
    const first = await pass(empty(), [missingGrant()], T0)
    const old = first.store.asks[0]!

    const second = await pass(first.store, [missingGrant('mailer', HEX_B)], T0 + 10 * MIN)

    const fresh = second.store.asks.find((a) => a.id !== old.id)
    expect(fresh).toBeDefined()
    expect(fresh!.digest).toBe(HEX_B)
    expect(fresh!.nonce).not.toBe(old.nonce)
    expect(second.changed).toBe(true)
    expect(shape(second.entries)).toEqual([
      [old.id, 2, 'superseded'],
      [fresh!.id, 1, 'raised'],
    ])
    expect(second.store.asks.filter((a) => a.state === 'open').map((a) => a.id)).toEqual([fresh!.id])
    const closed = second.store.asks.find((a) => a.id === old.id)!
    expect(closed).toMatchObject({ state: 'superseded', closed_at: iso(T0 + 10 * MIN), answer: null })
    expect(closed.events).toEqual([
      { seq: 1, event: 'raised', at: iso(T0) },
      { seq: 2, event: 'superseded', at: iso(T0 + 10 * MIN) },
    ])
    expect(auditRecords('ask.raised')).toHaveLength(2)
  })

  test('a changed kind with an equal digest still supersedes', async () => {
    const first = await pass(empty(), [missingGrant()], T0)

    const second = await pass(first.store, [{ ...missingGrant(), kind: 'content' }], T0 + 10 * MIN)

    expect(second.store.asks.map((a) => [a.kind, a.digest, a.state])).toEqual([
      ['missing_grant', HEX_A, 'superseded'],
      ['content', HEX_A, 'open'],
    ])
  })

  test('a refused raise leaves the open Ask open, not superseded', async () => {
    const first = await pass(empty(), [missingGrant()], T0)
    refuseRaise()

    const second = await pass(first.store, [missingGrant('mailer', HEX_B)], T0 + 10 * MIN)

    expect(second.unrecorded).toBe(1)
    expect(second.store.asks).toHaveLength(1)
    expect(second.store.asks[0]).toMatchObject({ id: first.store.asks[0]!.id, state: 'open', closed_at: null, digest: HEX_A })
    expect(eventsOf(second.store)).toEqual(['raised'])
  })

  test('reminders go out at the first pass at or after each point, one per passed set', async () => {
    let store = (await pass(empty(), [missingGrant()], T0)).store
    for (const at of [59 * MIN, HOUR, 90 * MIN, 5 * HOUR]) {
      store = (await pass(store, [missingGrant()], T0 + at)).store
    }

    expect(store.asks).toHaveLength(1)
    expect(store.asks[0]!.events).toEqual([
      { seq: 1, event: 'raised', at: iso(T0) },
      { seq: 2, event: 'reminder', at: iso(T0 + HOUR) },
      { seq: 3, event: 'reminder', at: iso(T0 + 5 * HOUR) },
    ])
  })

  test('an expired Ask sends one expired event, and the scope waits a pass before it is raised again', async () => {
    const first = await pass(empty(), [missingGrant()], T0)
    const old = first.store.asks[0]!

    const expired = await pass(first.store, [missingGrant()], T0 + 23 * HOUR)
    expect(shape(expired.entries)).toEqual([[old.id, 2, 'expired']])
    expect(expired.store.asks).toHaveLength(1)
    expect(expired.store.asks[0]).toMatchObject({ state: 'expired', closed_at: iso(T0 + 23 * HOUR), answer: null })
    expect(eventsOf(expired.store)).toEqual(['raised', 'expired'])

    const next = await pass(expired.store, [missingGrant()], T0 + 23 * HOUR + MIN)
    const fresh = next.store.asks.filter((a) => a.state === 'open')
    expect(fresh).toHaveLength(1)
    expect(fresh[0]!.id).not.toBe(old.id)
    expect(fresh[0]!.nonce).not.toBe(old.nonce)
    expect(shape(next.entries)).toEqual([
      [old.id, 2, 'expired'],
      [fresh[0]!.id, 1, 'raised'],
    ])
  })

  test('expiry reached before a reminder point sends only expired', async () => {
    const soon = { ...missingGrant(), clock: T0 + 30 * MIN }
    const first = await pass(empty(), [soon], T0, { remindersMs: [HOUR] })

    const later = await pass(first.store, [soon], T0 + 2 * HOUR, { remindersMs: [HOUR] })

    expect(later.entries.map((e) => e.event)).toEqual(['expired'])
    expect(eventsOf(later.store)).toEqual(['raised', 'expired'])
  })

  test('a decision that vanished lapses silently', async () => {
    const first = await pass(empty(), [missingGrant()], T0)
    const evaluated = { evaluatedPlugins: new Set(['mailer']) }

    const hour = await pass(first.store, [], T0 + HOUR, evaluated)
    expect(hour.store.asks[0]!.state).toBe('open')
    expect(eventsOf(hour.store)).toEqual(['raised'])

    const day = await pass(hour.store, [], T0 + 23 * HOUR, evaluated)
    expect(day.store.asks).toHaveLength(1)
    expect(day.store.asks[0]).toMatchObject({ state: 'expired', closed_at: iso(T0 + 23 * HOUR) })
    expect(eventsOf(day.store)).toEqual(['raised'])
    expect(day.entries).toEqual([])
  })

  test('a decision not evaluated this pass stays as it is and keeps its reminders', async () => {
    const first = await pass(empty(), [missingGrant()], T0)

    const hour = await pass(first.store, [], T0 + HOUR, { evaluatedPlugins: new Set() })

    expect(hour.store.asks).toHaveLength(1)
    expect(hour.store.asks[0]!.state).toBe('open')
    expect(eventsOf(hour.store)).toEqual(['raised', 'reminder'])
    expect(shape(hour.entries)).toEqual([
      [first.store.asks[0]!.id, 1, 'raised'],
      [first.store.asks[0]!.id, 2, 'reminder'],
    ])
  })

  test('a renewal Ask whose grant left a readable standing store lapses silently', async () => {
    const renewal: AskDecision = { kind: 'renewal', scope: GRANT, plugin: null, digest: HEX_A, clock: null }
    const first = await pass(empty(), [renewal], T0)

    // The standing store alone decides: the plugin set is the opposite way round each time.
    const listed = await pass(first.store, [], T0 + HOUR, { evaluatedPlugins: new Set(), standingListed: true })
    expect(eventsOf(listed.store)).toEqual(['raised'])

    const unlisted = await pass(first.store, [], T0 + HOUR, { evaluatedPlugins: new Set([GRANT]), standingListed: false })
    expect(eventsOf(unlisted.store)).toEqual(['raised', 'reminder'])
  })

  test('only a renewal answered no is not asked again; a plugin decision seen again after a deny is, like an approve whose effect did not land', async () => {
    const answered = (over: Partial<Ask>): AskStore => storeOf(stored({ state: 'answered', closed_at: iso(T0), ...over }))
    const renewalAsk = { kind: 'renewal', scope: GRANT, plugin: null, summary: askSummary('renewal', null) } as const
    const renewal: AskDecision = { kind: 'renewal', scope: GRANT, plugin: null, digest: HEX_A, clock: null }

    const standing = await pass(answered({ ...renewalAsk, answer: 'deny' }), [renewal], T0 + MIN)
    expect(standing.store.asks.map((a) => a.state)).toEqual(['answered'])
    expect(standing.entries).toEqual([])
    expect(auditRecords('ask.raised')).toHaveLength(0)

    // A plugin's no is its denial record; a decision that still arrives was not denied.
    const denied = await pass(answered({ answer: 'deny' }), [missingGrant()], T0 + MIN)
    expect(denied.store.asks.map((a) => a.state)).toEqual(['answered', 'open'])

    const approved = await pass(answered({ answer: 'approve' }), [missingGrant()], T0 + MIN)
    expect(approved.store.asks.map((a) => a.state)).toEqual(['answered', 'open'])

    const moved = await pass(answered({ ...renewalAsk, answer: 'deny', digest: HEX_B }), [renewal], T0 + MIN)
    expect(moved.store.asks.map((a) => a.state)).toEqual(['answered', 'open'])
  })

  test('closed Asks are pruned 23 hours after they closed', async () => {
    const closed = storeOf(
      stored({
        state: 'expired',
        closed_at: iso(T0),
        events: [
          { seq: 1, event: 'raised', at: iso(T0 - HOUR) },
          { seq: 2, event: 'expired', at: iso(T0) },
        ],
      }),
    )

    const before = await pass(closed, [], T0 + 23 * HOUR - MIN)
    expect(before.store.asks).toHaveLength(1)

    const after = await pass(before.store, [], T0 + 23 * HOUR)
    expect(after.store.asks).toEqual([])
    expect(after.changed).toBe(true)
  })

  test('a closed Ask\'s only due entry is its closing event, and an answered Ask has none', async () => {
    const at = (ms: number) => iso(ms)
    const raised = { seq: 1, event: 'raised' as const, at: at(T0 - HOUR) }
    const delivered = (seq: number) => ({ seq, at: at(T0), outcome: 'delivered' as const, exit_code: 0 })
    const store = storeOf(
      stored({ id: 'c0ffee000001', scope: 's1', state: 'superseded', closed_at: at(T0), events: [raised, { seq: 2, event: 'superseded', at: at(T0) }] }),
      stored({
        id: 'c0ffee000002',
        scope: 's2',
        state: 'expired',
        closed_at: at(T0),
        events: [raised, { seq: 2, event: 'reminder', at: at(T0 - MIN) }, { seq: 3, event: 'expired', at: at(T0) }],
        tries: [delivered(1)],
      }),
      stored({ id: 'c0ffee000003', scope: 's3', state: 'expired', closed_at: at(T0), events: [raised, { seq: 2, event: 'expired', at: at(T0) }], tries: [delivered(2)] }),
      // Lapsed silently: no closing event, so nothing is due.
      stored({ id: 'c0ffee000004', scope: 's4', state: 'expired', closed_at: at(T0), events: [raised] }),
      stored({ id: 'c0ffee000005', scope: 's5', state: 'answered', answer: 'approve', closed_at: at(T0), events: [raised] }),
      stored({ id: 'c0ffee000006', scope: 's6', events: [raised, { seq: 2, event: 'reminder', at: at(T0) }] }),
    )

    const out = await pass(store, [], T0 + MIN, { evaluatedPlugins: new Set() })

    expect(shape(out.entries)).toEqual([
      ['c0ffee000001', 2, 'superseded'],
      ['c0ffee000002', 3, 'expired'],
      ['c0ffee000006', 1, 'raised'],
      ['c0ffee000006', 2, 'reminder'],
    ])
  })
})

describe('an Answer is recorded before its Ask closes', () => {
  /** One open missing-Grant Ask for `mailer`, raised at T0, stored and read back. */
  async function openAsk(): Promise<Ask> {
    const out = await pass(empty(), [missingGrant()], T0)
    await writeAsks(statePath, out.store)
    const back = await readAsks(statePath)
    if (!back.readable) throw new Error('unreadable')
    return back.store.asks[0]!
  }

  const answer = { answer: 'approve', principal: 'ops', via: 'ci', evidence: 'OPS-123', answeredAt: T0 + 90_000 } as const

  test('recordAnswer appends ask.answered with its twelve fields, then marks the Ask answered', async () => {
    expect(typeof askLib.recordAnswer).toBe('function')
    const ask = await openAsk()

    expect(await askLib.recordAnswer(statePath, ask, answer)).toEqual({ recorded: true })

    const name = userInfo().username
    const expected = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/.test(name) ? name : 'unknown'
    const records = auditRecords('ask.answered')
    expect(records).toHaveLength(1)
    expect(records[0]!.data).toEqual({
      id: ask.id,
      kind: 'missing_grant',
      scope: 'mailer',
      answer: 'approve',
      digest: HEX_A,
      principal: 'ops',
      via: 'ci',
      os_user: expected,
      evidence: 'OPS-123',
      assurance: 'asserted',
      raised_at: ask.raised_at,
      decide_ms: 90_000,
    })

    const after = await readAsks(statePath)
    if (!after.readable) throw new Error('unreadable')
    expect(after.store.asks).toHaveLength(1)
    expect(after.store.asks[0]).toMatchObject({ id: ask.id, state: 'answered', closed_at: iso(T0 + 90_000), answer: 'approve' })
  })

  test('a refused ask.answered leaves the Ask open and asks.json byte-identical', async () => {
    expect(typeof askLib.recordAnswer).toBe('function')
    const ask = await openAsk()
    const real = audit.appendAudit
    spies.push(
      spyOn(audit, 'appendAudit').mockImplementation((async (p: string, kind: string, data: unknown, opts?: unknown) => {
        if (kind === 'ask.answered') throw new Error('refused for the test')
        return (real as (...args: unknown[]) => Promise<unknown>)(p, kind, data, opts)
      }) as typeof audit.appendAudit),
    )
    const bytes = readFileSync(asksPath(statePath))

    expect(await askLib.recordAnswer(statePath, ask, answer)).toEqual({ refused: 'audit' })

    expect(readFileSync(asksPath(statePath)).equals(bytes)).toBe(true)
    expect(auditRecords('ask.answered')).toEqual([])
  })

  test('an asks.json that cannot be read after the append returns store and is left as found', async () => {
    expect(typeof askLib.recordAnswer).toBe('function')
    const ask = await openAsk()
    writeFileSync(asksPath(statePath), '{')

    expect(await askLib.recordAnswer(statePath, ask, answer)).toEqual({ refused: 'store' })

    expect(readFileSync(asksPath(statePath), 'utf-8')).toBe('{')
    // The accepted class: a record naming an Answer whose effect was not written.
    expect(auditRecords('ask.answered')).toHaveLength(1)
  })
})

describe('the notify read and its record', () => {
  test('readNotify judges without recording, and observePreferences records the bytes it judged, never a later edit', async () => {
    const prefsPath = join(dir, 'preferences.json')
    const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')
    const write = (value: unknown): Buffer => {
      const bytes = Buffer.from(JSON.stringify(value))
      writeFileSync(prefsPath, bytes)
      return bytes
    }

    // Set and usable: judged in use, the bytes kept, nothing recorded.
    const b = write({ notify: { argv: ['/bin/true'] } })
    const got = await askLib.readNotify(prefsPath)
    expect(got.inUse).toBe(true)
    expect(got.loaded?.bytes?.equals(b)).toBe(true)
    expect(auditRecords('preferences.observed')).toEqual([])

    // An edit after the judgment: the record names the judged bytes, not the file now.
    const c = write({ notify: null })
    expect(await askLib.observePreferences(got.loaded, statePath)).toBeNull()
    const observed = auditRecords('preferences.observed')
    expect(observed).toHaveLength(1)
    expect((observed[0]!.data as { new: string }).new).toBe(sha(b))
    expect((observed[0]!.data as { new: string }).new).not.toBe(sha(c))

    // Unset and unusable are not in use.
    expect((await askLib.readNotify(prefsPath)).inUse).toBe(false)
    write({ notify: { argv: [] } })
    expect((await askLib.readNotify(prefsPath)).inUse).toBe(false)

    // A file that does not parse as preferences counts as set, and its bytes are kept to record.
    const invalid = write({ nope: 1 })
    const bad = await askLib.readNotify(prefsPath)
    expect(bad.inUse).toBe(true)
    expect(bad.loaded?.bytes?.equals(invalid)).toBe(true)

    // A file that cannot be read counts as set, with nothing read and so nothing to record.
    rmSync(prefsPath)
    mkdirSync(prefsPath)
    expect(await askLib.readNotify(prefsPath)).toEqual({ inUse: true, loaded: null })
    const seen = auditRecords('preferences.observed').length
    expect(await askLib.observePreferences(null, statePath)).toBeNull()
    expect(auditRecords('preferences.observed')).toHaveLength(seen)

    // A record the audit store refuses is a refusal with cause audit.
    rmSync(prefsPath, { recursive: true })
    write({ notify: { argv: ['/bin/true'] }, review_gate: false })
    const fresh = await askLib.readNotify(prefsPath)
    spies.push(
      spyOn(audit, 'observeAuthorityFile').mockImplementationOnce(async () => {
        throw new audit.AuditAppendError('preferences.observed', 'write failed')
      }),
    )
    expect(await askLib.observePreferences(fresh.loaded, statePath)).toEqual({
      refused: 'the audit store could not record a change to preferences.json: write failed',
      cause: 'audit',
    })
  })
})
