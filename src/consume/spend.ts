/**
 * spend — the spend window and the reservations it counts.
 *
 * The window's spend is derived from the audit store on every read, and never
 * stored. A reservation is appended before a call, and settled by the
 * `handoff.tried` that names it. An open or costless reservation counts in
 * full, so a killed call keeps its whole reservation. `.consume.lock` covers
 * only read, check and append, so model calls run in parallel.
 *
 * Money is integer micro-USD throughout.
 */
import { randomUUID } from 'node:crypto'
import { appendAudit, readCompleteLines, type StoredRecord } from '../lib/audit-log.js'
import { acquireLock, releaseHeld } from '../lib/pid-lock.js'

export const CONSUME_LOCK_NAME = '.consume.lock'

const RESERVED = 'warpline.audit.handoff.reserved'
const TRIED = 'warpline.audit.handoff.tried'
const UNREADABLE = 'the spend window could not be read'

const isMicro = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0

/**
 * The spend of every reservation stamped at or after `nowMs − windowSeconds`:
 * its try's cost when that is a number, its full amount otherwise. A
 * reservation stamped after `nowMs` counts too, so a clock stepped back never
 * hides spend. A reservation or try line that cannot be read throws, because
 * could not look is never zero.
 */
export function sumWindow(records: Iterable<StoredRecord>, nowMs: number, windowSeconds: number): number {
  const start = nowMs - windowSeconds * 1000
  const amounts = new Map<string, number>()
  const costs = new Map<string, number | null>()
  for (const r of records) {
    const id: unknown = r.data?.reservation_id
    if (typeof id !== 'string') throw new Error(UNREADABLE)
    if (r.type === RESERVED) {
      const amount: unknown = r.data.amount_micro_usd
      const at = typeof r.time === 'string' ? Date.parse(r.time) : Number.NaN
      if (!isMicro(amount) || Number.isNaN(at)) throw new Error(UNREADABLE)
      if (at >= start) amounts.set(id, amount)
    } else if (r.type === TRIED) {
      const cost: unknown = r.data.cost_micro_usd
      if (cost !== null && !isMicro(cost)) throw new Error(UNREADABLE)
      costs.set(id, cost)
    }
  }
  let total = 0
  for (const [id, amount] of amounts) total += costs.get(id) ?? amount
  return total
}

/** The window's spend, read from the audit store behind `statePath`. */
export async function windowSpend(statePath: string, nowMs: number, windowSeconds: number): Promise<number> {
  const records: StoredRecord[] = []
  // ponytail: scans the whole store per read; reading only segments that overlap the window is the upgrade path.
  for await (const l of readCompleteLines(statePath, 0)) {
    if (l.record?.type === RESERVED || l.record?.type === TRIED) records.push(l.record)
  }
  return sumWindow(records, nowMs, windowSeconds)
}

export type ReserveOutcome = { reserved: true; reservationId: string; amountMicro: number } | { reserved: false; reason: string }

/**
 * Under `.consume.lock`: read the window, check the caps, append the
 * reservation. The amount is the per-call cap, or 0 with none, and a
 * reservation is appended even at 0 so every try has its write-ahead anchor.
 * A refused append rejects, and the caller must make no call.
 */
export async function reserve(o: {
  statePath: string
  lockPath: string
  handoff: string
  capPerCallMicro: number | null
  capWindowMicro: number | null
  windowSeconds: number
  now?: () => number
}): Promise<ReserveOutcome> {
  const token = await acquireLock(o.lockPath, `${o.lockPath}.break`)
  try {
    const amount = o.capPerCallMicro ?? 0
    if (o.capWindowMicro !== null) {
      let spent: number
      try {
        spent = await windowSpend(o.statePath, (o.now ?? Date.now)(), o.windowSeconds)
      } catch {
        return { reserved: false, reason: UNREADABLE }
      }
      if (spent + amount > o.capWindowMicro) {
        return { reserved: false, reason: 'consume.max_usd_per_window is spent for this window' }
      }
    }
    const reservationId = `urn:uuid:${randomUUID()}`
    await appendAudit(o.statePath, 'handoff.reserved', { reservation_id: reservationId, handoff: o.handoff, amount_micro_usd: amount })
    return { reserved: true, reservationId, amountMicro: amount }
  } finally {
    releaseHeld(o.lockPath, token)
  }
}
