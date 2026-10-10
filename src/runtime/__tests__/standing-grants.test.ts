/**
 * Standing grants at the gate: the store, its caps, lapse on read, the reader
 * version, the covering list and the session window's issuer.
 *
 * The gate is imported as a namespace and every call goes through it. A named
 * import of an export that does not exist yet crashes the whole file on bun
 * with no case run, which would read as one failure instead of each case
 * failing for its own reason.
 *
 * Every store call is handed `standingPath`, which sits under `explicit/`
 * rather than at the default path under the test home. A store function that
 * ignored its path argument would read an empty default, and the covering and
 * lapse cases would fail for it.
 *
 * The gate refuses with codes. The sentences an operator reads belong to the
 * verbs, so no case here pins a phrase: the cases check `code` (and `reason`
 * and `final` on a lapse), and one case owns the shape of a refusal.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { _setHome } from '../../lib/paths.js'
import * as gate from '../approval-gate.js'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')

const T0 = Date.UTC(2026, 0, 5, 12, 0, 0)
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const iso = (ms: number) => new Date(ms).toISOString()

const A = 'aaaaaaaaaaaa'
const B = 'bbbbbbbbbbbb'
const C = 'cccccccccccc'

const REASONS = [
  'hard max',
  'not renewed',
  'future dated',
  'registry unreadable',
  'holder not registered',
  'holder not machine',
  'holder disabled',
]

type Entry = { type: 'human' | 'machine'; status: 'active' | 'disabled' }
const registry = (entries: Record<string, Entry>): gate.RegistrySnapshot => new Map(Object.entries(entries))
const ACTIVE = registry({
  ci: { type: 'machine', status: 'active' },
  ops: { type: 'human', status: 'active' },
})

const EMPTY: gate.StandingStore = { min_reader_version: 1, grants: [] }

type Terms = Parameters<typeof gate.issueStanding>[1]
const TERMS: Terms = { id: A, holder: 'ci', issuer: 'ops', scopes: ['p'], hardMaxMs: 3 * DAY, periodMs: DAY }

function storeOf(r: { store: gate.StandingStore } | { refused: unknown }): gate.StandingStore {
  if (!('store' in r)) throw new Error(`expected a store, got a refusal: ${JSON.stringify(r.refused)}`)
  return r.store
}

function refusedOf<R>(r: { store: gate.StandingStore } | { refused: R }): R {
  if (!('refused' in r)) throw new Error('expected a refusal, got a store')
  return r.refused
}

/** Issue one or more grants onto an empty store, each with `TERMS` overridden. */
function storeWith(...grants: Array<Partial<Terms>>): gate.StandingStore {
  let store = EMPTY
  for (const g of grants) store = storeOf(gate.issueStanding(store, { ...TERMS, ...g }, T0))
  return store
}

let tmp: string
let approvalPath: string
let standingPath: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'warpline-standing-'))
  _setHome(tmp)
  approvalPath = join(tmp, '.session-approval')
  standingPath = join(tmp, 'explicit', 'standing-grants.json')
})

afterEach(() => {
  _setHome(null)
  rmSync(tmp, { recursive: true, force: true })
})

/** Write a store file by hand, bypassing the writer. */
function writeRaw(value: unknown): void {
  mkdirSync(dirname(standingPath), { recursive: true })
  writeFileSync(standingPath, typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

const RAW_GRANT = {
  id: A,
  holder: 'ci',
  issuer: 'ops',
  scopes: ['q'],
  issued_at: iso(T0),
  period_start: iso(T0),
  period_ms: DAY,
  hard_max_ms: 3 * DAY,
}

/** The one status in a listing, after writing `store` at `standingPath`. */
async function statusAt(
  store: gate.StandingStore,
  now: number,
  opts: { registry?: gate.RegistrySnapshot | null } = { registry: ACTIVE },
): Promise<gate.StandingStatus> {
  await gate.writeStandingStore(store, standingPath)
  const listing = await gate.listStandingGrants({ now, standingPath, ...opts })
  if (!listing.readable) throw new Error(`unreadable store: ${listing.cause}`)
  expect(listing.grants).toHaveLength(1)
  return listing.grants[0] as gate.StandingStatus
}

describe('caps', () => {
  test('a grant at exactly the 7-day period and 90-day hard max is issued', () => {
    const store = storeOf(
      gate.issueStanding(EMPTY, { id: A, holder: 'ci', issuer: 'ops', scopes: ['p'], periodMs: 7 * DAY, hardMaxMs: 90 * DAY }, T0),
    )
    expect(store.grants).toHaveLength(1)
    const g = store.grants[0] as gate.StandingGrant
    expect(g.issued_at).toBe(iso(T0))
    expect(g.period_start).toBe(iso(T0))
    expect(g.period_ms).toBe(7 * DAY)
    expect(g.hard_max_ms).toBe(90 * DAY)
    expect([g.id, g.holder, g.issuer, g.scopes]).toEqual([A, 'ci', 'ops', ['p']])
  })

  test('the caps are the stated constants and an omitted period is 24 hours', () => {
    expect(gate.DEFAULT_STANDING_PERIOD_MS).toBe(24 * HOUR)
    expect(gate.MAX_STANDING_PERIOD_MS).toBe(7 * DAY)
    expect(gate.MAX_STANDING_HARD_MAX_MS).toBe(90 * DAY)
    const store = storeOf(gate.issueStanding(EMPTY, { id: A, holder: 'ci', issuer: 'ops', scopes: ['p'], hardMaxMs: 2 * DAY }, T0))
    expect(store.grants[0]?.period_ms).toBe(24 * HOUR)
  })

  test('a 255-character scope and one with a space are plugin names, issued and read back', async () => {
    const names = ['x'.repeat(255), 'digest sender']
    await gate.writeStandingStore(storeWith({ scopes: names }), standingPath)
    const read = await gate.readStandingStore(standingPath)
    expect(read.readable && read.store.grants[0]?.scopes).toEqual([...names].sort())
  })

  test('scopes are stored deduplicated and sorted', () => {
    const store = storeOf(gate.issueStanding(EMPTY, { ...TERMS, scopes: ['q', 'p', 'p'] }, T0))
    expect(store.grants[0]?.scopes).toEqual(['p', 'q'])
  })

  const refusals: Array<[string, Partial<Terms>, gate.IssueRefusal['code']]> = [
    ['a period 1 ms over the 7-day cap', { periodMs: 7 * DAY + 1, hardMaxMs: 90 * DAY }, 'period-over-cap'],
    ['a hard max 1 ms over the 90-day cap', { periodMs: DAY, hardMaxMs: 90 * DAY + 1 }, 'hard-max-over-cap'],
    ['a hard max below the period', { periodMs: 2 * DAY, hardMaxMs: DAY }, 'hard-max-below-period'],
    ['a zero period', { periodMs: 0 }, 'bad-period'],
    ['the all-scopes scope', { scopes: ['*'] }, 'all-scopes'],
    ['no scope', { scopes: [] }, 'no-scope'],
    ['an upper-case id', { id: 'ABCDEF123456' }, 'bad-id'],
    ['an 11-character id', { id: 'abcdef12345' }, 'bad-id'],
    ['a malformed holder', { holder: 'Bad Id' }, 'bad-principal-id'],
    ['a holder equal to the issuer', { holder: 'ops', issuer: 'ops' }, 'holder-is-issuer'],
    ['a scope holding a control byte', { scopes: ['p\x1b[2J'] }, 'bad-scope'],
    ['a scope holding a slash', { scopes: ['a/b'] }, 'bad-scope'],
    ['a scope holding a backslash', { scopes: ['a\\b'] }, 'bad-scope'],
    ['a 256-character scope', { scopes: ['x'.repeat(256)] }, 'bad-scope'],
  ]
  for (const [what, terms, code] of refusals) {
    test(`${what} refuses ${code}`, () => {
      const r = gate.issueStanding(EMPTY, { ...TERMS, ...terms }, T0)
      expect('store' in r).toBe(false)
      expect(refusedOf(r).code).toBe(code)
    })
  }

  test('an id already in the standing grants file refuses duplicate-id', () => {
    const r = gate.issueStanding(storeWith({ id: A }), { ...TERMS, id: A, scopes: ['other'] }, T0)
    expect('store' in r).toBe(false)
    expect(refusedOf(r).code).toBe('duplicate-id')
  })
})

describe('lapse', () => {
  // Issued at T0 with a 1-day period and a 3-day hard max.
  const issued = () => storeWith({ id: A, periodMs: DAY, hardMaxMs: 3 * DAY })
  const renewed = () => {
    const once = storeOf(gate.renewStanding(issued(), A, 'ops', T0 + DAY, ACTIVE))
    return storeOf(gate.renewStanding(once, A, 'ops', T0 + 2 * DAY, ACTIVE))
  }

  test('live at the renewal deadline, with the derived instants and the stored terms', async () => {
    const s = await statusAt(issued(), T0 + DAY)
    expect([s.state, s.reason, s.final]).toEqual(['live', null, false])
    expect(s.renewal_deadline).toBe(T0 + DAY)
    expect(s.hard_max_at).toBe(T0 + 3 * DAY)
    expect(s.next_expiry).toBe(T0 + DAY)
    expect([s.id, s.holder, s.issuer, s.scopes, s.issued_at, s.period_start, s.period_ms, s.hard_max_ms]).toEqual([
      A, 'ci', 'ops', ['p'], iso(T0), iso(T0), DAY, 3 * DAY,
    ])
  })

  test('1 ms past the renewal deadline reads not renewed, final', async () => {
    const s = await statusAt(issued(), T0 + DAY + 1)
    expect([s.state, s.reason, s.final]).toEqual(['lapsed', 'not renewed', true])
  })

  test('renewed up to the hard max: live at it, and 1 ms past reads hard max, final', async () => {
    const at = await statusAt(renewed(), T0 + 3 * DAY)
    expect(at.renewal_deadline).toBe(T0 + 3 * DAY)
    expect(at.hard_max_at).toBe(T0 + 3 * DAY)
    expect([at.state, at.reason, at.final]).toEqual(['live', null, false])
    const past = await statusAt(renewed(), T0 + 3 * DAY + 1)
    expect([past.state, past.reason, past.final]).toEqual(['lapsed', 'hard max', true])
  })

  test('a disabled holder reads holder disabled, not final, and live again once active', async () => {
    const disabled = registry({ ci: { type: 'machine', status: 'disabled' } })
    const s = await statusAt(issued(), T0, { registry: disabled })
    expect([s.state, s.reason, s.final]).toEqual(['lapsed', 'holder disabled', false])
    const again = await statusAt(issued(), T0, { registry: ACTIVE })
    expect([again.state, again.reason, again.final]).toEqual(['live', null, false])
  })

  test('a holder retyped human reads holder not machine, not final', async () => {
    const s = await statusAt(issued(), T0, { registry: registry({ ci: { type: 'human', status: 'active' } }) })
    expect([s.state, s.reason, s.final]).toEqual(['lapsed', 'holder not machine', false])
  })

  test('a holder absent from the registry reads holder not registered, final', async () => {
    const s = await statusAt(issued(), T0, { registry: registry({ ops: { type: 'human', status: 'active' } }) })
    expect([s.state, s.reason, s.final]).toEqual(['lapsed', 'holder not registered', true])
  })

  test('a null or omitted registry reads registry unreadable, not final', async () => {
    const nulled = await statusAt(issued(), T0, { registry: null })
    expect([nulled.state, nulled.reason, nulled.final]).toEqual(['lapsed', 'registry unreadable', false])
    const omitted = await statusAt(issued(), T0, {})
    expect([omitted.state, omitted.reason, omitted.final]).toEqual(['lapsed', 'registry unreadable', false])
  })

  // WR-01: a period that has not started yet would carry the clock's lead as
  // extra life past both caps, so it covers nothing until the clock reaches it.
  test('a period_start after now reads future dated, not final, and live once the clock reaches it', async () => {
    const early = await statusAt(issued(), T0 - 1)
    expect([early.state, early.reason, early.final]).toEqual(['lapsed', 'future dated', false])
    const at = await statusAt(issued(), T0)
    expect([at.state, at.reason, at.final]).toEqual(['live', null, false])
  })

  test('a grant dated 2099 covers nothing today', async () => {
    const future = iso(Date.UTC(2099, 0, 1))
    writeRaw({ min_reader_version: 1, grants: [{ ...RAW_GRANT, scopes: ['p'], issued_at: future, period_start: future }] })
    expect(await gate.grantsCovering('p', { now: T0, approvalPath, standingPath, registry: ACTIVE })).toEqual([])
    const listing = await gate.listStandingGrants({ now: T0, registry: ACTIVE, standingPath })
    expect(listing.readable && listing.grants.map((g) => [g.state, g.reason])).toEqual([['lapsed', 'future dated']])
  })

  test('the first applicable reason wins', async () => {
    const disabled = registry({ ci: { type: 'machine', status: 'disabled' } })
    const hardMax = await statusAt(renewed(), T0 + 3 * DAY + 1, { registry: disabled })
    expect([hardMax.reason, hardMax.final]).toEqual(['hard max', true])
    const notRenewed = await statusAt(issued(), T0 + DAY + 1, { registry: null })
    expect([notRenewed.reason, notRenewed.final]).toEqual(['not renewed', true])
    const notMachine = await statusAt(issued(), T0, { registry: registry({ ci: { type: 'human', status: 'disabled' } }) })
    expect([notMachine.reason, notMachine.final]).toEqual(['holder not machine', false])
  })
})

describe('the listing sorts by next expiry, then id', () => {
  test('ids in reverse of expiry order list by expiry, and equal expiries by id', async () => {
    const store = storeWith(
      { id: B, periodMs: DAY, hardMaxMs: 90 * DAY },
      { id: C, periodMs: DAY, hardMaxMs: 90 * DAY },
      { id: A, periodMs: 2 * DAY, hardMaxMs: 90 * DAY },
    )
    await gate.writeStandingStore(store, standingPath)
    const listing = await gate.listStandingGrants({ now: T0, registry: ACTIVE, standingPath })
    if (!listing.readable) throw new Error('unreadable store')
    expect(listing.grants.map((g) => g.id)).toEqual([B, C, A])
  })
})

describe('renew', () => {
  const pick = (g: gate.StandingGrant) =>
    JSON.stringify({ issued_at: g.issued_at, hard_max_ms: g.hard_max_ms, period_ms: g.period_ms, holder: g.holder, issuer: g.issuer, scopes: g.scopes, id: g.id })
  const two = () => storeWith({ id: A, periodMs: DAY, hardMaxMs: 3 * DAY }, { id: B, scopes: ['q'] })

  test('at exactly the deadline only period_start moves, and the other grant is untouched', () => {
    const before = two()
    const after = storeOf(gate.renewStanding(before, A, 'ops', T0 + DAY, ACTIVE))
    const was = before.grants.find((g) => g.id === A) as gate.StandingGrant
    const now = after.grants.find((g) => g.id === A) as gate.StandingGrant
    expect(now.period_start).toBe(iso(T0 + DAY))
    expect(pick(now)).toBe(pick(was))
    expect(JSON.stringify(after.grants.find((g) => g.id === B))).toBe(JSON.stringify(before.grants.find((g) => g.id === B)))
  })

  test('1 ms past the deadline refuses lapsed, not renewed, final', () => {
    expect(gate.renewStanding(two(), A, 'ops', T0 + DAY + 1, ACTIVE)).toMatchObject({
      refused: { code: 'lapsed', reason: 'not renewed', final: true },
    })
  })

  test('past the hard max refuses lapsed, hard max, final', () => {
    const tight = storeWith({ id: A, periodMs: DAY, hardMaxMs: DAY })
    expect(gate.renewStanding(tight, A, 'ops', T0 + DAY + 1, ACTIVE)).toMatchObject({
      refused: { code: 'lapsed', reason: 'hard max', final: true },
    })
  })

  test('a disabled holder refuses lapsed, holder disabled, not final', () => {
    const disabled = registry({ ci: { type: 'machine', status: 'disabled' }, ops: { type: 'human', status: 'active' } })
    expect(gate.renewStanding(two(), A, 'ops', T0, disabled)).toMatchObject({
      refused: { code: 'lapsed', reason: 'holder disabled', final: false },
    })
  })

  test('a holder gone from the registry refuses lapsed, holder not registered, final', () => {
    const gone = registry({ ops: { type: 'human', status: 'active' } })
    expect(gate.renewStanding(two(), A, 'ops', T0, gone)).toMatchObject({
      refused: { code: 'lapsed', reason: 'holder not registered', final: true },
    })
  })

  test('before period_start refuses lapsed, future dated, not final', () => {
    expect(gate.renewStanding(two(), A, 'ops', T0 - 1, ACTIVE)).toMatchObject({
      refused: { code: 'lapsed', reason: 'future dated', final: false },
    })
  })

  test('the holder renewing its own grant refuses holder-renews', () => {
    expect(refusedOf(gate.renewStanding(two(), A, 'ci', T0, ACTIVE)).code).toBe('holder-renews')
  })

  test('an unknown id refuses unknown-id', () => {
    expect(refusedOf(gate.renewStanding(two(), C, 'ops', T0, ACTIVE)).code).toBe('unknown-id')
  })
})

describe('revoke', () => {
  const three = () => storeWith({ id: A }, { id: B, scopes: ['q'] }, { id: C, scopes: ['r'] })

  test('revoking one id leaves the others byte-identical', () => {
    const before = three()
    const after = storeOf(gate.revokeStanding(before, [A]))
    expect(after.grants.map((g) => g.id)).toEqual([B, C])
    expect(JSON.stringify(after.grants)).toBe(JSON.stringify(before.grants.filter((g) => g.id !== A)))
  })

  test('an id not in the store refuses unknown-id', () => {
    expect(refusedOf(gate.revokeStanding(three(), ['dddddddddddd'])).code).toBe('unknown-id')
  })

  test('no ids refuses no-ids', () => {
    expect(refusedOf(gate.revokeStanding(three(), [])).code).toBe('no-ids')
  })
})

describe('the gate refuses with codes, never sentences', () => {
  const CODES = [
    'no-scope',
    'all-scopes',
    'bad-scope',
    'bad-period',
    'period-over-cap',
    'hard-max-over-cap',
    'hard-max-below-period',
    'bad-id',
    'duplicate-id',
    'bad-principal-id',
    'holder-is-issuer',
    'unknown-id',
    'holder-renews',
    'lapsed',
    'no-ids',
  ]

  test('every refusal is a bare code from the closed list, and every code is reached', () => {
    const held = storeWith({ id: A, periodMs: DAY, hardMaxMs: 3 * DAY })
    const issue = (t: Partial<Terms>) => gate.issueStanding(held, { ...TERMS, id: B, ...t }, T0)
    const results: Array<{ store: gate.StandingStore } | { refused: unknown }> = [
      issue({ scopes: [] }),
      issue({ scopes: ['*'] }),
      issue({ scopes: ['a/b'] }),
      issue({ periodMs: 0 }),
      issue({ periodMs: 7 * DAY + 1, hardMaxMs: 90 * DAY }),
      issue({ hardMaxMs: 90 * DAY + 1 }),
      issue({ periodMs: 2 * DAY, hardMaxMs: DAY }),
      issue({ id: 'NOTHEX' }),
      issue({ id: A }),
      issue({ issuer: 'Bad Id' }),
      issue({ holder: 'ops' }),
      gate.renewStanding(held, C, 'ops', T0, ACTIVE),
      gate.renewStanding(held, A, 'ci', T0, ACTIVE),
      gate.renewStanding(held, A, 'ops', T0 + DAY + 1, ACTIVE),
      gate.renewStanding(held, A, 'ops', T0, registry({ ci: { type: 'machine', status: 'disabled' } })),
      gate.revokeStanding(held, [C]),
      gate.revokeStanding(held, []),
    ]
    const refused = results.map((r) => refusedOf(r) as Record<string, unknown>)
    for (const value of refused) {
      const code = value.code as string
      expect(CODES).toContain(code)
      expect(code).toMatch(/^[a-z]+(-[a-z]+)*$/)
      if (code === 'lapsed') {
        expect(Object.keys(value).sort()).toEqual(['code', 'final', 'reason'])
        expect(REASONS).toContain(value.reason as string)
        expect(typeof value.final).toBe('boolean')
      } else {
        expect(Object.keys(value).sort()).toEqual(['code'])
      }
    }
    expect([...new Set(refused.map((v) => v.code as string))].sort()).toEqual([...CODES].sort())
  })
})

describe('reader version', () => {
  test('the session and standing reader versions are both 1', () => {
    expect(gate.GRANT_READER_VERSION).toBe(1)
    expect(gate.STANDING_READER_VERSION).toBe(1)
  })

  test('a store asking for a newer reader reads newer reader, even with a grant this build cannot parse', async () => {
    writeRaw({ min_reader_version: gate.STANDING_READER_VERSION + 1, grants: [RAW_GRANT] })
    expect(await gate.readStandingStore(standingPath)).toEqual({ readable: false, cause: 'newer reader' })
    expect(await gate.listStandingGrants({ now: T0, registry: ACTIVE, standingPath })).toEqual({
      readable: false,
      cause: 'newer reader',
    })
    writeRaw({ min_reader_version: gate.STANDING_READER_VERSION + 1, grants: [{ ...RAW_GRANT, holder: 'Bad Id' }] })
    expect(await gate.readStandingStore(standingPath)).toEqual({ readable: false, cause: 'newer reader' })
  })

  test('a string, absent, zero or fractional version reads corrupt', async () => {
    for (const version of ['1', undefined, 0, 1.5]) {
      writeRaw({ min_reader_version: version, grants: [RAW_GRANT] })
      expect(await gate.readStandingStore(standingPath)).toEqual({ readable: false, cause: 'corrupt' })
      expect(await gate.listStandingGrants({ now: T0, registry: ACTIVE, standingPath })).toEqual({
        readable: false,
        cause: 'corrupt',
      })
    }
  })

  test('an unreadable version covers nothing while the session window still does', async () => {
    await gate.mergeGrant('p', { now: T0 }, approvalPath)
    for (const version of [gate.STANDING_READER_VERSION + 1, '1', undefined, 0]) {
      writeRaw({ min_reader_version: version, grants: [RAW_GRANT] })
      expect(await gate.grantsCovering('q', { now: T0, approvalPath, standingPath, registry: ACTIVE })).toEqual([])
      expect(await gate.checkApproval('p', approvalPath, { now: T0 })).toBe(true)
    }
    writeRaw({ min_reader_version: gate.STANDING_READER_VERSION, grants: [RAW_GRANT] })
    expect(await gate.grantsCovering('q', { now: T0, approvalPath, standingPath, registry: ACTIVE })).toEqual([
      { kind: 'standing', id: A, holder: 'ci', issuer: 'ops' },
    ])
  })
})

describe('fail closed', () => {
  const ok = { ...RAW_GRANT, scopes: ['p'] }
  const bad: Array<[string, unknown]> = [
    ['bytes that are not JSON', '{ "min_reader_version": 1, "grants": ['],
    ['a malformed holder', { min_reader_version: 1, grants: [{ ...ok, holder: 'Bad Id' }] }],
    ['a malformed id', { min_reader_version: 1, grants: [{ ...ok, id: 'not-hex-id!!' }] }],
    ['a period over the cap', { min_reader_version: 1, grants: [{ ...ok, period_ms: 7 * DAY + 1, hard_max_ms: 90 * DAY }] }],
    ['a hard max below the period', { min_reader_version: 1, grants: [{ ...ok, period_ms: 2 * DAY, hard_max_ms: DAY }] }],
    ['two grants with one id', { min_reader_version: 1, grants: [ok, { ...ok, scopes: ['q'] }] }],
    ['the all-scopes scope', { min_reader_version: 1, grants: [{ ...ok, scopes: ['*'] }] }],
    ['a scope holding a control byte', { min_reader_version: 1, grants: [{ ...ok, scopes: ['p', 'q\x1b[2J'] }] }],
    ['a scope holding a newline', { min_reader_version: 1, grants: [{ ...ok, scopes: ['p', 'q\nforged'] }] }],
    ['a scope holding a slash', { min_reader_version: 1, grants: [{ ...ok, scopes: ['p', '../q'] }] }],
    ['a scope holding a backslash', { min_reader_version: 1, grants: [{ ...ok, scopes: ['p', 'a\\b'] }] }],
    ['a 256-character scope', { min_reader_version: 1, grants: [{ ...ok, scopes: ['p', 'x'.repeat(256)] }] }],
    ['a period_start before issued_at', { min_reader_version: 1, grants: [{ ...ok, period_start: iso(T0 - 1) }] }],
    ['a period_start past the hard maximum', { min_reader_version: 1, grants: [{ ...ok, period_start: iso(T0 + 3 * DAY + 1) }] }],
  ]

  for (const [what, value] of bad) {
    test(`${what} reads corrupt and covers nothing`, async () => {
      await gate.mergeGrant('p', { now: T0 }, approvalPath)
      writeRaw(value)
      expect(await gate.readStandingStore(standingPath)).toEqual({ readable: false, cause: 'corrupt' })
      expect(await gate.listStandingGrants({ now: T0, registry: ACTIVE, standingPath })).toEqual({
        readable: false,
        cause: 'corrupt',
      })
      expect(await gate.grantsCovering('p', { now: T0, approvalPath, standingPath, registry: ACTIVE })).toEqual([
        { kind: 'session', scope: 'p', issuer: null },
      ])
    })
  }

  test('a directory at the store path reads io', async () => {
    await gate.mergeGrant('p', { now: T0 }, approvalPath)
    mkdirSync(standingPath, { recursive: true })
    expect(await gate.readStandingStore(standingPath)).toEqual({ readable: false, cause: 'io' })
    expect(await gate.listStandingGrants({ now: T0, registry: ACTIVE, standingPath })).toEqual({ readable: false, cause: 'io' })
    expect(await gate.grantsCovering('p', { now: T0, approvalPath, standingPath, registry: ACTIVE })).toEqual([
      { kind: 'session', scope: 'p', issuer: null },
    ])
  })

  test.skipIf(process.getuid?.() === 0)('a store at mode 000 reads io (skipped as root: chmod cannot deny root)', async () => {
    await gate.mergeGrant('p', { now: T0 }, approvalPath)
    writeRaw({ min_reader_version: 1, grants: [{ ...ok }] })
    chmodSync(standingPath, 0o000)
    try {
      expect(await gate.readStandingStore(standingPath)).toEqual({ readable: false, cause: 'io' })
      expect(await gate.grantsCovering('p', { now: T0, approvalPath, standingPath, registry: ACTIVE })).toEqual([
        { kind: 'session', scope: 'p', issuer: null },
      ])
    } finally {
      chmodSync(standingPath, 0o600)
    }
  })

  test('a missing store reads empty and readable, and the session grant still covers', async () => {
    await gate.mergeGrant('p', { now: T0 }, approvalPath)
    expect(await gate.readStandingStore(standingPath)).toEqual({
      readable: true,
      store: { min_reader_version: 1, grants: [] },
    })
    expect(await gate.listStandingGrants({ now: T0, registry: ACTIVE, standingPath })).toEqual({ readable: true, grants: [] })
    expect(await gate.grantsCovering('p', { now: T0, approvalPath, standingPath, registry: ACTIVE })).toEqual([
      { kind: 'session', scope: 'p', issuer: null },
    ])
    expect(await gate.checkApproval('p', approvalPath, { now: T0 })).toBe(true)
  })
})

describe('covering', () => {
  test('every live grant covering a scope, session first, each with its issuer', async () => {
    await gate.mergeGrant('*', { now: T0 }, approvalPath)
    await gate.mergeGrant('p', { now: T0, principal: 'alice' }, approvalPath)
    const store = storeWith({ id: B, hardMaxMs: 90 * DAY }, { id: A, hardMaxMs: 90 * DAY })
    await gate.writeStandingStore(store, standingPath)

    expect(await gate.grantsCovering('p', { now: T0, approvalPath, standingPath, registry: ACTIVE })).toEqual([
      { kind: 'session', scope: '*', issuer: null },
      { kind: 'session', scope: 'p', issuer: 'alice' },
      { kind: 'standing', id: A, holder: 'ci', issuer: 'ops' },
      { kind: 'standing', id: B, holder: 'ci', issuer: 'ops' },
    ])

    await gate.writeStandingStore(storeOf(gate.revokeStanding(store, [A])), standingPath)
    expect(await gate.grantsCovering('p', { now: T0, approvalPath, standingPath, registry: ACTIVE })).toHaveLength(3)
  })

  test('only lapsed standing grants and no session file cover nothing', async () => {
    await gate.writeStandingStore(storeWith({ id: A }, { id: B }), standingPath)
    const late = T0 + DAY + 1
    expect(existsSync(approvalPath)).toBe(false)
    expect(await gate.grantsCovering('p', { now: late, approvalPath, standingPath, registry: ACTIVE })).toEqual([])
    expect(await gate.checkApproval('p', approvalPath, { now: late })).toBe(false)
  })
})

describe('session issuer', () => {
  const windows = () =>
    (JSON.parse(readFileSync(approvalPath, 'utf8')) as { scope_windows: Record<string, Record<string, unknown>> })
      .scope_windows

  test('the last grant naming a scope sets its issuer, and a window it did not name keeps its own', async () => {
    await gate.mergeGrant('p', { now: T0, principal: 'alice' }, approvalPath)
    expect(windows().p?.issuer).toBe('alice')
    await gate.mergeGrant('q', { now: T0, principal: 'bob' }, approvalPath)
    expect(windows().p?.issuer).toBe('alice')
    expect(windows().q?.issuer).toBe('bob')
    await gate.mergeGrant('p', { now: T0 }, approvalPath)
    expect('issuer' in (windows().p as object)).toBe(false)
    expect(windows().q?.issuer).toBe('bob')
  })

  test('a malformed issuer is never written and reads null', async () => {
    await gate.mergeGrant('r', { now: T0, principal: 'Not Valid' }, approvalPath)
    expect('issuer' in (windows().r as object)).toBe(false)

    const file = JSON.parse(readFileSync(approvalPath, 'utf8'))
    file.scope_windows.r.issuer = 'Not Valid'
    writeFileSync(approvalPath, JSON.stringify(file))
    expect(await gate.grantsCovering('r', { now: T0, approvalPath })).toEqual([{ kind: 'session', scope: 'r', issuer: null }])
  })
})

describe('writer', () => {
  test('mode 0600, the reader version written, grants and scopes sorted', async () => {
    const [a, b] = storeWith({ id: A, scopes: ['z', 'y'] }, { id: B }).grants as [gate.StandingGrant, gate.StandingGrant]
    await gate.writeStandingStore({ min_reader_version: 0, grants: [b, { ...a, scopes: ['z', 'y'] }] }, standingPath)
    expect(statSync(standingPath).mode & 0o777).toBe(0o600)
    const written = JSON.parse(readFileSync(standingPath, 'utf8'))
    expect(written.min_reader_version).toBe(gate.STANDING_READER_VERSION)
    expect(written.grants.map((g: { id: string }) => g.id)).toEqual([A, B])
    expect(written.grants[0].scopes).toEqual(['y', 'z'])
  })

  test('an empty store leaves the file present with no grants', async () => {
    await gate.writeStandingStore(storeWith({ id: A }), standingPath)
    await gate.writeStandingStore({ min_reader_version: 1, grants: [] }, standingPath)
    expect(existsSync(standingPath)).toBe(true)
    expect(JSON.parse(readFileSync(standingPath, 'utf8')).grants).toEqual([])
  })

  test('the default path is standing-grants.json under the home', async () => {
    await gate.writeStandingStore(storeWith({ id: A }))
    expect(existsSync(join(tmp, 'standing-grants.json'))).toBe(true)
  })
})

describe('ids', () => {
  test('a new id is 12 lowercase hex characters, and 100 of them are distinct', () => {
    const ids = Array.from({ length: 100 }, () => gate.newStandingId())
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{12}$/)
    expect(new Set(ids).size).toBe(100)
  })
})

describe('v0.5.1', () => {
  test('the v0.5.1 gate honours a session window this build wrote and grants nothing from a standing grant', async () => {
    // A missing tag throws here and fails the case. It never skips.
    const source = execFileSync('git', ['show', 'v0.5.1:src/runtime/approval-gate.ts'], { cwd: REPO_ROOT, encoding: 'utf8' })
    const oldGate = join(tmp, 'old', 'runtime', 'approval-gate.ts')
    mkdirSync(dirname(oldGate), { recursive: true })
    writeFileSync(oldGate, source)
    mkdirSync(join(tmp, 'old', 'lib'), { recursive: true })
    writeFileSync(
      join(tmp, 'old', 'lib', 'paths.js'),
      `export function sessionApprovalPath() { return ${JSON.stringify(approvalPath)} }\n`,
    )
    const old = (await import(pathToFileURL(oldGate).href)) as {
      checkApproval: (scope: string, path: string, opts: { now: number }) => Promise<boolean>
    }

    await gate.mergeGrant('p', { principal: 'alice', now: T0 }, approvalPath)
    const store = storeWith({ id: A, scopes: ['q'] })
    await gate.writeStandingStore(store, standingPath)
    await gate.writeStandingStore(store)
    // This build reads the standing grant live, so the old one ignoring it is the point.
    expect(await gate.grantsCovering('q', { now: T0, approvalPath, registry: ACTIVE })).toHaveLength(1)

    expect(await old.checkApproval('p', approvalPath, { now: T0 })).toBe(true)
    expect(await old.checkApproval('q', approvalPath, { now: T0 })).toBe(false)
  })
})
