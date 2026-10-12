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
import { tmpdir } from 'node:os'
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
  type AskDecision,
  type AskStore,
} from '../asks.js'
// The exports this file pins before they exist, read through the namespace so
// a missing one fails its own case and not the whole file.
import * as asksMod from '../asks.js'
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

    const pass = await advanceAsks(statePath, before.store, { decisions: [missingGrant()], now: T0 })
    expect(pass.unrecorded).toBe(0)
    expect(pass.changed).toBe(true)
    expect(pass.entries).toHaveLength(1)

    await writeAsks(statePath, pass.store)
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
    const outcome = await runNotify(okStub.argv, askMessage(pass.entries, false), 5000, notifyEnv())
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
    const tried = recordTry(pass.store, pass.entries, { at, outcome: 'delivered', exit_code: 0 })
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

    const pass = await advanceAsks(statePath, store, { decisions: [missingGrant()], now: T0 })

    expect(pass.unrecorded).toBe(1)
    expect(pass.entries).toEqual([])
    expect(pass.changed).toBe(false)
    expect(pass.store).toEqual(empty())
    expect(store).toEqual(empty())
    expect(auditRecords('ask.raised')).toEqual([])
  })

  test('an unchanged decision raises nothing new, and an undelivered entry stays due with its seq', async () => {
    const first = await advanceAsks(statePath, empty(), { decisions: [missingGrant()], now: T0 })
    const id = first.store.asks[0]!.id

    const second = await advanceAsks(statePath, first.store, { decisions: [missingGrant()], now: T0 + 60_000 })
    expect(second.unrecorded).toBe(0)
    expect(second.changed).toBe(false)
    expect(second.store.asks.map((a) => a.id)).toEqual([id])
    expect(second.entries.map((e) => [e.id, e.seq, e.event])).toEqual([[id, 1, 'raised']])
    expect(auditRecords('ask.raised')).toHaveLength(1)

    const failed = recordTry(second.store, second.entries, { at: iso(T0 + 61_000), outcome: 'failed', exit_code: 3 })
    const third = await advanceAsks(statePath, failed, { decisions: [missingGrant()], now: T0 + 120_000 })
    expect(third.entries.map((e) => [e.id, e.seq])).toEqual([[id, 1]])

    const delivered = recordTry(third.store, third.entries, { at: iso(T0 + 121_000), outcome: 'delivered', exit_code: 0 })
    const fourth = await advanceAsks(statePath, delivered, { decisions: [missingGrant()], now: T0 + 180_000 })
    expect(fourth.entries).toEqual([])
    expect(fourth.store.asks.map((a) => a.id)).toEqual([id])
  })

  test('an Ask expires at the earlier of its subject\'s clock and 23 hours after it was raised', async () => {
    const pass = await advanceAsks(statePath, empty(), {
      decisions: [
        { ...missingGrant('soon'), clock: T0 + 2 * HOUR },
        { ...missingGrant('late'), clock: T0 + 30 * HOUR },
      ],
      now: T0,
    })
    const byScope = Object.fromEntries(pass.store.asks.map((a) => [a.scope, a.expires_at]))
    expect(byScope).toEqual({ soon: iso(T0 + 2 * HOUR), late: iso(T0 + 23 * HOUR) })
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
    const pass = await advanceAsks(statePath, empty(), {
      decisions: [{ ...missingGrant('with'), content: 'the bytes' }, missingGrant('without', HEX_B)],
      now: T0,
    })
    const withContent = JSON.parse(askMessage(pass.entries, true)) as { entries: Array<Record<string, unknown>> }
    expect(Object.fromEntries(withContent.entries.map((e) => [e.scope, e.content]))).toEqual({
      with: 'the bytes',
      without: null,
    })
    const plain = JSON.parse(askMessage(pass.entries, false)) as { entries: Array<Record<string, unknown>> }
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
    const pass = await advanceAsks(statePath, empty(), { decisions, now: T0 })
    expect(pass.unrecorded).toBe(0)
    const ids = pass.store.asks.map((a) => a.id)
    expect(ids).toHaveLength(200)
    expect(new Set(ids).size).toBe(200)
    for (const ask of pass.store.asks) {
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
    const pass = await advanceAsks(statePath, empty(), { decisions: [missingGrant('a'), missingGrant('b', HEX_B)], now: T0 })
    const t = { at: iso(T0 + 1000), outcome: 'timeout' as const, exit_code: null }

    const tried = recordTry(pass.store, pass.entries, t)
    expect(tried.asks.map((a) => a.tries)).toEqual([[{ seq: 1, ...t }], [{ seq: 1, ...t }]])
    expect(pass.store.asks.map((a) => a.tries)).toEqual([[], []])

    const pruned: AskStore = { ...tried, asks: tried.asks.filter((a) => a.scope === 'a') }
    const again = recordTry(pruned, pass.entries, t)
    expect(again.asks.map((a) => [a.scope, a.tries.length])).toEqual([['a', 2]])
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
    expect(asksMod.renewalDigest(grant)).toBe(expected)
    expect(asksMod.renewalDigest({ ...grant, scopes: ['alpha', 'zeta'] })).toBe(expected)
    expect(asksMod.renewalDigest({ ...grant, period_start: iso(T0 + HOUR) })).not.toBe(expected)
  })

  test('askSeverity gives parked_result and renewal warning, missing_grant and content info', () => {
    expect(asksMod.askSeverity('parked_result')).toBe('warning')
    expect(asksMod.askSeverity('renewal')).toBe('warning')
    expect(asksMod.askSeverity('missing_grant')).toBe('info')
    expect(asksMod.askSeverity('content')).toBe('info')
  })

  test('entries order warning before info, then oldest raised_at, then id', async () => {
    const content = (scope: string): AskDecision => ({ kind: 'content', scope, plugin: scope, digest: HEX_B, clock: null })
    const parked = (scope: string): AskDecision => ({ kind: 'parked_result', scope, plugin: scope, digest: HEX_A, clock: null })
    // Two info Asks at T0, one a minute later, and the warning one last of all.
    const first = await advanceAsks(statePath, empty(), { decisions: [content('c'), missingGrant('n')], now: T0 })
    const second = await advanceAsks(statePath, first.store, {
      decisions: [content('c'), missingGrant('n'), missingGrant('m')],
      now: T0 + 60_000,
    })
    const third = await advanceAsks(statePath, second.store, {
      decisions: [content('c'), missingGrant('n'), missingGrant('m'), parked('p')],
      now: T0 + 120_000,
    })

    const idOf = (scope: string): string => third.store.asks.find((a) => a.scope === scope)!.id
    const sameInstant = ['c', 'n'].sort((x, y) => (idOf(x) < idOf(y) ? -1 : idOf(x) > idOf(y) ? 1 : 0))
    expect(third.entries.map((e) => e.scope)).toEqual(['p', ...sameInstant, 'm'])
  })
})
