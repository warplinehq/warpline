/**
 * The spend window and its reservations, pinned at the module.
 *
 * A reservation is one `handoff.reserved` line in the audit store, appended
 * under `.consume.lock` before any model call, after the caps are checked
 * against the window read back from the store. The window's spend is derived
 * on every read and never stored: each reservation stamped inside the window
 * counts at the cost its `handoff.tried` reports, and at its full amount while
 * no try names it or the try's cost is null. Money is integer micro-USD.
 *
 * A reservation line that cannot be read makes the window read throw, so the
 * reserve refuses instead of reading it as zero. A refused append rejects the
 * reserve, so the caller makes no call, and the lock is released either way.
 *
 * Every case gets its own temp home (AGENTS.md Rule 2), and every spy is
 * restored after it.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { appendFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as audit from '../../lib/audit-log.js'
// The module this file pins before it exists, read through the namespace so
// each export is named where it is used.
import * as spend from '../spend.js'

const HOUR = 3600
// In the past, so a line the store stamps with the real clock is always later.
const T0 = Date.now() - 48 * HOUR * 1000
const URN = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

let home: string
let statePath: string
let lockPath: string
let spies: ReturnType<typeof spyOn>[] = []

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'warpline-spend-'))
  statePath = join(home, 'state', 'engine-state.json')
  lockPath = join(home, 'handoffs', '.consume.lock')
  mkdirSync(join(home, 'handoffs'), { recursive: true })
})

afterEach(() => {
  for (const s of spies) s.mockRestore()
  spies = []
  rmSync(home, { recursive: true, force: true })
})

const urn = () => `urn:uuid:${randomUUID()}`

// A lock is a link whose text names no file, so `existsSync` reads it as absent even while held.
const present = (p: string) => lstatSync(p, { throwIfNoEntry: false }) !== undefined

/** One reservation appended through the store, stamped at `at`. Resolves its id. */
async function reserved(amount: number, at = T0): Promise<string> {
  const id = urn()
  await audit.appendAudit(
    statePath,
    'handoff.reserved',
    { reservation_id: id, handoff: 'run-1.prod', amount_micro_usd: amount },
    { now: () => at },
  )
  return id
}

/** The try that settles reservation `id`, reporting `cost`. */
async function tried(id: string, cost: number | null, at = T0 + 1000): Promise<void> {
  await audit.appendAudit(
    statePath,
    'handoff.tried',
    {
      reservation_id: id,
      handoff: 'run-1.prod',
      outcome: 'answered',
      requested: 'm',
      served: 'm',
      cost_micro_usd: cost,
      cost_basis: cost === null ? 'unknown' : 'reported',
      bytes: null,
      sha256: null,
    },
    { now: () => at },
  )
}

/** Every handoff record in the store, in order. */
async function handoffRecords(): Promise<audit.StoredRecord[]> {
  const out: audit.StoredRecord[] = []
  for await (const l of audit.readCompleteLines(statePath, 0)) {
    if (l.record?.type.startsWith('warpline.audit.handoff.')) out.push(l.record)
  }
  return out
}

function opts(over: Partial<Parameters<typeof spend.reserve>[0]> = {}): Parameters<typeof spend.reserve>[0] {
  return {
    statePath,
    lockPath,
    handoff: 'run-1.prod',
    capPerCallMicro: 50_000,
    capWindowMicro: 100_000,
    windowSeconds: HOUR,
    ...over,
  }
}

describe('a reservation', () => {
  test('under both caps is one handoff.reserved line, and the next window read counts it', async () => {
    const r = await spend.reserve(opts())
    expect(r).toMatchObject({ reserved: true, amountMicro: 50_000 })
    if (!r.reserved) throw new Error('not reserved')
    expect(r.reservationId).toMatch(URN)

    const records = await handoffRecords()
    expect(records).toHaveLength(1)
    const last = records.at(-1)!
    expect(last.type).toBe('warpline.audit.handoff.reserved')
    expect(last.data).toEqual({ reservation_id: r.reservationId, handoff: 'run-1.prod', amount_micro_usd: 50_000 })

    expect(await spend.windowSpend(statePath, Date.now(), HOUR)).toBe(50_000)
    expect(present(lockPath)).toBe(false)
  })

  test('with no cap at all is still appended, at zero', async () => {
    const r = await spend.reserve(opts({ capPerCallMicro: null, capWindowMicro: null }))
    expect(r).toMatchObject({ reserved: true, amountMicro: 0 })
    const records = await handoffRecords()
    expect(records).toHaveLength(1)
    expect(records[0]!.data.amount_micro_usd).toBe(0)
  })

  test('the lock is named .consume.lock', () => {
    expect(spend.CONSUME_LOCK_NAME).toBe('.consume.lock')
  })
})

describe('how a reservation counts in the window', () => {
  test('an open reservation counts at its full amount', async () => {
    await reserved(50_000)
    expect(await spend.windowSpend(statePath, T0 + 2000, HOUR)).toBe(50_000)
  })

  test('a try with cost_micro_usd: null leaves the reservation at its full amount', async () => {
    await tried(await reserved(50_000), null)
    expect(await spend.windowSpend(statePath, T0 + 2000, HOUR)).toBe(50_000)
  })

  test('a try that reports zero settles the reservation at zero', async () => {
    await tried(await reserved(50_000), 0)
    expect(await spend.windowSpend(statePath, T0 + 2000, HOUR)).toBe(0)
  })

  test('a try that reports more than was reserved counts at the reported cost', async () => {
    await tried(await reserved(50_000), 70_000)
    expect(await spend.windowSpend(statePath, T0 + 2000, HOUR)).toBe(70_000)
  })

  test('a reservation falls out of the window once now passes window_seconds after it', async () => {
    await reserved(50_000)
    expect(await spend.windowSpend(statePath, T0 + HOUR * 1000, HOUR)).toBe(50_000)
    expect(await spend.windowSpend(statePath, T0 + HOUR * 1000 + 1, HOUR)).toBe(0)
  })

  test('a reservation stamped after now still counts, so a clock stepped back never hides spend', async () => {
    await reserved(50_000, T0 + 5000)
    expect(await spend.windowSpend(statePath, T0, HOUR)).toBe(50_000)
  })

  test('10,000 settled tries of 100 micro-USD sum to exactly 1_000_000', () => {
    const records: audit.StoredRecord[] = []
    const time = new Date(T0).toISOString()
    for (let i = 0; i < 10_000; i++) {
      const id = urn()
      records.push({
        warplineseq: 2 * i + 1,
        source: 's',
        type: 'warpline.audit.handoff.reserved',
        time,
        data: { reservation_id: id, handoff: 'run-1.prod', amount_micro_usd: 50_000 },
      })
      records.push({
        warplineseq: 2 * i + 2,
        source: 's',
        type: 'warpline.audit.handoff.tried',
        time,
        data: { reservation_id: id, cost_micro_usd: 100 },
      })
    }
    expect(spend.sumWindow(records, T0 + 1000, HOUR)).toBe(1_000_000)
  })
})

describe('the window cap', () => {
  test('a reservation exactly equal to what is left is allowed', async () => {
    await tried(await reserved(50_000), 60_000)
    const r = await spend.reserve(opts({ capPerCallMicro: 40_000, now: () => T0 + 2000 }))
    expect(r).toMatchObject({ reserved: true, amountMicro: 40_000 })
  })

  test('one cent over what is left is refused by the setting name and no value, and nothing is appended', async () => {
    await tried(await reserved(50_000), 60_000)
    const before = (await handoffRecords()).length
    const r = await spend.reserve(opts({ capPerCallMicro: 50_000, now: () => T0 + 2000 }))
    expect(r.reserved).toBe(false)
    if (r.reserved) throw new Error('reserved')
    expect(r.reason).toContain('consume.max_usd_per_window')
    expect(r.reason).not.toMatch(/\d/)
    expect((await handoffRecords()).length).toBe(before)
    expect(present(lockPath)).toBe(false)
  })

  test('the window moves with the injected now', async () => {
    await reserved(100_000)
    expect((await spend.reserve(opts({ capPerCallMicro: 1, now: () => T0 + HOUR * 1000 }))).reserved).toBe(false)
    expect((await spend.reserve(opts({ capPerCallMicro: 1, now: () => T0 + HOUR * 1000 + 1 }))).reserved).toBe(true)
  })

  test('two reserves at once with room for one: exactly one is reserved', async () => {
    const results = await Promise.all([
      spend.reserve(opts({ capPerCallMicro: 60_000 })),
      spend.reserve(opts({ capPerCallMicro: 60_000 })),
    ])
    expect(results.filter((r) => r.reserved)).toHaveLength(1)
    expect(await handoffRecords()).toHaveLength(1)
    expect(present(lockPath)).toBe(false)
  })
})

describe('write-ahead', () => {
  test('a refused handoff.reserved append rejects the reserve, and the lock is gone afterwards', async () => {
    // Read BEFORE `spyOn`: afterwards the namespace property is the mock.
    const real = audit.appendAudit
    spies.push(
      spyOn(audit, 'appendAudit').mockImplementation((async (p: string, k: string, d: unknown, o?: unknown) => {
        if (k === 'handoff.reserved') throw new Error('append refused')
        return (real as (...a: unknown[]) => Promise<unknown>)(p, k, d, o)
      }) as typeof audit.appendAudit),
    )
    const err = await spend.reserve(opts()).then(
      () => null,
      (e: unknown) => e,
    )
    expect((err as Error | null)?.message).toBe('append refused')
    expect(present(lockPath)).toBe(false)
    expect(await handoffRecords()).toHaveLength(0)
  })
})

describe('could not look is never zero', () => {
  test('a reservation line with a non-integer amount makes the reserve refuse', async () => {
    await reserved(50_000, Date.now())
    const dir = join(home, 'audit')
    const name = readdirSync(dir).find((n) => n.endsWith('.jsonl'))!
    const text = readFileSync(join(dir, name), 'utf-8')
    expect(text).toContain('"amount_micro_usd":50000')
    writeFileSync(join(dir, name), text.replace('"amount_micro_usd":50000', '"amount_micro_usd":1.5'))

    expect(await spend.reserve(opts())).toEqual({ reserved: false, reason: 'the spend window could not be read' })
    expect(present(lockPath)).toBe(false)
    const records = await handoffRecords()
    expect(records).toHaveLength(1)
    expect(() => spend.sumWindow(records, Date.now(), HOUR)).toThrow('the spend window could not be read')
  })

  /** One reservation of 50 000 stamped now, then a line that is not a record. Resolves that line's seq. */
  async function storeWithUnreadableLine(): Promise<number> {
    await reserved(50_000, Date.now())
    const dir = join(home, 'audit')
    const name = readdirSync(dir)
      .filter((n) => n.endsWith('.jsonl'))
      .sort()
      .at(-1)!
    appendFileSync(join(dir, name), 'not a record\n')
    for await (const l of audit.readCompleteLines(statePath, 0)) if (l.record === undefined) return l.seq
    throw new Error('the line that is not a record was not found')
  }

  test('a line that is not a record makes the reserve refuse', async () => {
    await storeWithUnreadableLine()
    expect(await spend.reserve(opts())).toEqual({ reserved: false, reason: 'the spend window could not be read' })
    await expect(spend.windowSpend(statePath, Date.now(), HOUR)).rejects.toThrow('the spend window could not be read')
    expect(present(lockPath)).toBe(false)
  })

  test('a line that is not a record makes unsettledReservations throw', async () => {
    await storeWithUnreadableLine()
    await expect(spend.unsettledReservations(statePath, 'run-1.prod', new Set())).rejects.toThrow(
      'the spend window could not be read',
    )
  })

  test('a line passed over by audit pass-over is left out, and the reserve goes on', async () => {
    const bad = await storeWithUnreadableLine()
    await audit.passOver(statePath, [bad])
    expect(await spend.windowSpend(statePath, Date.now(), HOUR)).toBe(50_000)
    const unsettled = await spend.unsettledReservations(statePath, 'run-1.prod', new Set())
    expect(unsettled).toHaveLength(1)
    expect(unsettled[0]).toMatchObject({ amountMicro: 50_000, tried: null })
    expect(await spend.reserve(opts())).toMatchObject({ reserved: true, amountMicro: 50_000 })
  })

  test('a reservation whose time does not parse, or whose data is missing, throws', () => {
    const data = { reservation_id: urn(), handoff: 'run-1.prod', amount_micro_usd: 1 }
    const type = 'warpline.audit.handoff.reserved'
    expect(() => spend.sumWindow([{ warplineseq: 1, source: 's', type, time: 'not a time', data }], T0, HOUR)).toThrow(
      'the spend window could not be read',
    )
    expect(() => spend.sumWindow([{ warplineseq: 1, source: 's', type, data }], T0, HOUR)).toThrow(
      'the spend window could not be read',
    )
    expect(() =>
      spend.sumWindow([{ warplineseq: 1, source: 's', type, time: new Date(T0).toISOString() }], T0, HOUR),
    ).toThrow('the spend window could not be read')
  })
})
