/**
 * asks — the Ask store at `<state dir>/asks.json`, and the pass that raises Asks.
 *
 * An Ask is one decision a run waits on a human for. The engine hands each
 * decision in as data: its kind, its scope, its plugin, its digest and the
 * clock of the thing asked about. This module turns a new one into a stored
 * Ask, works out which events are still due to reach `notify`, builds the one
 * message that carries them, and records each try.
 *
 * **It takes no lock.** Every caller holds the state lock around its
 * read-modify-write of the store, the engine during an advance and the Answer
 * verbs alike, and runs `notify` outside it.
 *
 * **It imports nothing from the runtime or the board, and never the `notify`
 * runner.** Every public function takes the state file path, and the store is
 * that file's sibling, so no home is resolved here. No line here names a
 * writer of a grant, an approval or the state document, and a census over this
 * module holds that.
 *
 * **An Ask is on the audit record before it is stored.** Its `ask.raised`
 * record is appended first. When the store refuses that append, the Ask is not
 * stored, nothing is sent for it, and the pass counts it as unrecorded.
 *
 * **The file holds live nonces.** It is written owner-only, atomically, and
 * synced, so a lost write cannot hand back a nonce already consumed.
 */
import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { appendAudit, ASK_ANSWERS, ASK_KINDS, CarriedPluginName } from './audit-log.js'
import { atomicWriteJson, syncInstalled } from './fs-atomic.js'

export const ASKS_READER_VERSION = 1

/** This module's own copy of the 23-hour cap on a grant window. A test holds it equal to the gate's. */
export const ASK_MAX_AGE_MS = 23 * 60 * 60 * 1000

const Iso = z.iso.datetime()
const Seq = z.number().int().positive()

const AskEventSchema = z.object({ seq: Seq, event: z.enum(['raised', 'reminder', 'expired', 'superseded']), at: Iso })
const AskTrySchema = z.object({
  seq: Seq,
  at: Iso,
  outcome: z.enum(['delivered', 'failed', 'timeout']),
  exit_code: z.number().int().nullable(),
})

/** One stored Ask. Not strict: a key a later build adds is ignored, and a narrowing one bumps the reader version. */
const AskSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{12}$/),
  nonce: z.string().regex(/^[0-9a-f]{32}$/),
  kind: z.enum(ASK_KINDS),
  // A plugin name, or a standing grant's 12-hex id, which the same rule admits.
  scope: CarriedPluginName,
  plugin: CarriedPluginName.nullable(),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  summary: z.string(),
  raised_at: Iso,
  expires_at: Iso,
  state: z.enum(['open', 'answered', 'superseded', 'expired']),
  closed_at: Iso.nullable(),
  answer: z.enum(ASK_ANSWERS).nullable(),
  events: z.array(AskEventSchema),
  tries: z.array(AskTrySchema),
})

export type AskKind = (typeof ASK_KINDS)[number]
export type AskAnswer = (typeof ASK_ANSWERS)[number]
export type Ask = z.infer<typeof AskSchema>
export type AskState = Ask['state']
export type AskEvent = z.infer<typeof AskEventSchema>
export type AskTry = z.infer<typeof AskTrySchema>
export interface AskStore {
  min_reader_version: number
  asks: Ask[]
}
export type AsksUnreadableCause = 'corrupt' | 'newer reader' | 'io'

/** A decision the engine sees waiting on a human, handed in as data. */
export interface AskDecision {
  kind: AskKind
  scope: string
  plugin: string | null
  digest: string
  /** The epoch ms at which the subject itself stops being answerable, or null when it has none. */
  clock: number | null
  /** The content asked about, sent only when the operator's `notify` setting asks for it. */
  content?: string | null
}

/** One event of one Ask that is due to reach `notify`. */
export interface AskEntry {
  id: string
  seq: number
  event: AskEvent['event']
  kind: AskKind
  scope: string
  plugin: string | null
  digest: string
  nonce: string
  summary: string
  raised_at: string
  expires_at: string
  content?: string | null
}

/** The store file: the state file's sibling. */
export function asksPath(statePath: string): string {
  return join(dirname(statePath), 'asks.json')
}

/**
 * The whole file or nothing. The reader version is read before any other
 * field, so a newer file says `newer reader`, never `corrupt`.
 */
function parseStore(raw: unknown): { store: AskStore } | { cause: 'corrupt' | 'newer reader' } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { cause: 'corrupt' }
  const file = raw as Record<string, unknown>

  const version = file.min_reader_version
  if (typeof version === 'number' && Number.isInteger(version) && version > ASKS_READER_VERSION) {
    return { cause: 'newer reader' }
  }
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return { cause: 'corrupt' }

  if (!Array.isArray(file.asks)) return { cause: 'corrupt' }
  const asks: Ask[] = []
  const seen = new Set<string>()
  for (const value of file.asks) {
    const parsed = AskSchema.safeParse(value)
    if (!parsed.success || seen.has(parsed.data.id)) return { cause: 'corrupt' }
    seen.add(parsed.data.id)
    asks.push(parsed.data)
  }
  return { store: { min_reader_version: version, asks } }
}

/**
 * The Ask store, parsed. Never throws. A missing file is an empty, readable
 * store. Anything else that cannot be read reports its cause, and is never
 * read as "no Asks".
 */
export async function readAsks(
  statePath: string,
): Promise<{ readable: true; store: AskStore } | { readable: false; cause: AsksUnreadableCause }> {
  let text: string
  try {
    text = await readFile(asksPath(statePath), 'utf-8')
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
      return { readable: true, store: { min_reader_version: ASKS_READER_VERSION, asks: [] } }
    }
    return { readable: false, cause: 'io' }
  }
  try {
    const parsed = parseStore(JSON.parse(text))
    return 'cause' in parsed ? { readable: false, cause: parsed.cause } : { readable: true, store: parsed.store }
  } catch {
    return { readable: false, cause: 'corrupt' }
  }
}

/** Write the store owner-only and atomically, then sync it. Rejects when the write fails. */
export async function writeAsks(statePath: string, store: AskStore): Promise<void> {
  const path = asksPath(statePath)
  await atomicWriteJson(path, { min_reader_version: ASKS_READER_VERSION, asks: store.asks }, { mode: 0o600 })
  await syncInstalled(path)
}

/** A fresh Ask id: 12 lowercase hex. */
export function newAskId(): string {
  return randomBytes(6).toString('hex')
}

/** A fresh nonce: 32 lowercase hex, drawn apart from the id. */
export function newNonce(): string {
  return randomBytes(16).toString('hex')
}

/** The fixed sentence for a kind. The plugin name is its only variable part, and a renewal has none. */
export function askSummary(kind: AskKind, plugin: string | null): string {
  switch (kind) {
    case 'missing_grant':
      return `${plugin} declares side effects and holds no Grant, so it did not run. Approve or deny it.`
    case 'parked_result':
      return `${plugin} ran and its result is parked for review. Approve or deny it.`
    case 'content':
      return `${plugin} is waiting for its content to be approved. Approve or deny it.`
    case 'renewal':
      return 'A standing grant is due for renewal. Renew it or deny it.'
  }
}

/**
 * How urgently a kind wants an Answer. Derived from the kind each time it is
 * read, and never stored: a parked result and a standing grant due for
 * renewal each lose something when their clock runs out, so they come first.
 */
export function askSeverity(kind: AskKind): 'warning' | 'info' {
  switch (kind) {
    case 'parked_result':
    case 'renewal':
      return 'warning'
    case 'missing_grant':
    case 'content':
      return 'info'
  }
}

/**
 * The digest a renewal Ask binds: sha256 over the grant's stored fields, in
 * the key order the standing grants file is written in, with the scopes
 * sorted as they are written. `period_start` is one of them, so a renew moves
 * it. Plain fields in, so this module never reads the gate.
 */
export function renewalDigest(g: {
  id: string
  holder: string
  issuer: string
  scopes: readonly string[]
  issued_at: string
  period_start: string
  period_ms: number
  hard_max_ms: number
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        id: g.id,
        holder: g.holder,
        issuer: g.issuer,
        scopes: [...g.scopes].sort(),
        issued_at: g.issued_at,
        period_start: g.period_start,
        period_ms: g.period_ms,
        hard_max_ms: g.hard_max_ms,
      }),
    )
    .digest('hex')
}

const decisionKey = (kind: string, scope: string, digest: string): string => `${kind}\0${scope}\0${digest}`

const severityRank = (kind: AskKind): number => (askSeverity(kind) === 'warning' ? 0 : 1)

/** The event that closed an Ask, or null for one that lapsed silently or is still open. */
function closingEvent(a: Ask): AskEvent | null {
  const last = a.events.at(-1)
  return last !== undefined && (last.event === 'expired' || last.event === 'superseded') && a.state === last.event
    ? last
    : null
}

/**
 * One pass over the decisions seen now, on a copy of the store, in five steps:
 *
 * 1. **Prune.** A closed Ask leaves the file 23 hours after it closed. The
 *    audit store keeps its record.
 * 2. **Expire.** An open Ask at or past `expires_at` closes `expired`. It
 *    sends an `expired` event unless its decision vanished: no decision for
 *    its scope although the scope was looked at (its plugin evaluated this
 *    advance, or for a renewal a readable standing store). A vanished
 *    decision lapses silently.
 * 3. **Each decision.** An open Ask with the same kind and digest is
 *    unchanged. One that differs is superseded, but only once the new Ask's
 *    `ask.raised` is on the record. With no open Ask, a scope expired in this
 *    pass waits for the next one, and a scope whose most recently closed Ask
 *    was answered with a deny of the same kind and digest is not asked again.
 * 4. **Reminders.** An open Ask whose decision is seen, or whose scope was not
 *    looked at, gets one `reminder` when more reminder points have passed
 *    since `raised_at` than had at its last reminder. Never once per pass.
 * 5. **Due.** An open Ask's every event with no delivered try; a closed Ask's
 *    closing event, until delivered; nothing for an answered Ask.
 *
 * Returns the new store (the one passed in is left as it was), every entry
 * still due, how many Asks the audit store refused, and whether anything
 * changed.
 */
export async function advanceAsks(
  statePath: string,
  store: AskStore,
  input: {
    decisions: readonly AskDecision[]
    now: number
    /** The plugins this advance evaluated. An Ask on one of them with no decision has vanished. */
    evaluatedPlugins: ReadonlySet<string>
    /** Whether the standing grants file was readable. A renewal Ask with no decision then has vanished. */
    standingListed: boolean
    /** Reminder points, in ms after `raised_at`, ascending. */
    remindersMs: readonly number[]
  },
): Promise<{ store: AskStore; entries: AskEntry[]; unrecorded: number; changed: boolean }> {
  const { now } = input
  const at = new Date(now).toISOString()
  const decided = new Map(input.decisions.map((d) => [d.scope, d]))
  const lookedAt = (a: Ask): boolean => (a.kind === 'renewal' ? input.standingListed : input.evaluatedPlugins.has(a.scope))
  const content = new Map<string, string | null>()
  let unrecorded = 0
  let changed = false

  // 1. Prune.
  const asks = store.asks.filter(
    (a) => a.state === 'open' || a.closed_at === null || Date.parse(a.closed_at) > now - ASK_MAX_AGE_MS,
  )
  if (asks.length !== store.asks.length) changed = true

  const close = (i: number, state: 'expired' | 'superseded', event: boolean): void => {
    const a = asks[i]!
    asks[i] = {
      ...a,
      state,
      closed_at: at,
      events: event ? [...a.events, { seq: a.events.length + 1, event: state, at }] : a.events,
    }
    changed = true
  }

  // 2. Expire.
  const expiredNow = new Set<string>()
  for (let i = 0; i < asks.length; i++) {
    const a = asks[i]!
    if (a.state !== 'open' || now < Date.parse(a.expires_at)) continue
    close(i, 'expired', decided.has(a.scope) || !lookedAt(a))
    expiredNow.add(a.scope)
  }

  // 3. Each decision.
  const raisedNow = new Set<string>()
  for (const d of input.decisions) {
    if (d.content !== undefined) content.set(decisionKey(d.kind, d.scope, d.digest), d.content)
    const openAt = asks.findIndex((a) => a.state === 'open' && a.scope === d.scope)
    if (openAt >= 0) {
      const a = asks[openAt]!
      if (a.kind === d.kind && a.digest === d.digest) continue
    } else {
      if (expiredNow.has(d.scope)) continue
      const last = asks
        .filter((a) => a.scope === d.scope && a.closed_at !== null)
        .reduce<Ask | null>((x, a) => (x === null || Date.parse(a.closed_at!) >= Date.parse(x.closed_at!) ? a : x), null)
      if (last?.state === 'answered' && last.answer === 'deny' && last.kind === d.kind && last.digest === d.digest) continue
    }

    const ids = new Set(asks.map((a) => a.id))
    let id = newAskId()
    while (ids.has(id)) id = newAskId()
    const expires_at = new Date(Math.min(d.clock ?? Infinity, now + ASK_MAX_AGE_MS)).toISOString()
    try {
      await appendAudit(statePath, 'ask.raised', {
        id,
        kind: d.kind,
        scope: d.scope,
        plugin: d.plugin,
        digest: d.digest,
        raised_at: at,
        expires_at,
      })
    } catch {
      // Unrecorded: nothing is stored or sent, and an Ask it would replace stays open.
      unrecorded += 1
      continue
    }
    if (openAt >= 0) close(openAt, 'superseded', true)
    asks.push({
      id,
      nonce: newNonce(),
      kind: d.kind,
      scope: d.scope,
      plugin: d.plugin,
      digest: d.digest,
      summary: askSummary(d.kind, d.plugin),
      raised_at: at,
      expires_at,
      state: 'open',
      closed_at: null,
      answer: null,
      events: [{ seq: 1, event: 'raised', at }],
      tries: [],
    })
    raisedNow.add(id)
    changed = true
  }

  // 4. Reminders, counted from `raised_at` and the last reminder, never per pass.
  for (let i = 0; i < asks.length; i++) {
    const a = asks[i]!
    if (a.state !== 'open' || raisedNow.has(a.id) || (!decided.has(a.scope) && lookedAt(a))) continue
    const raised = Date.parse(a.raised_at)
    const passed = (t: number): number => input.remindersMs.filter((r) => t >= raised + r).length
    const lastReminder = a.events.filter((e) => e.event === 'reminder').at(-1)
    if (passed(now) <= passed(lastReminder === undefined ? raised : Date.parse(lastReminder.at))) continue
    asks[i] = { ...a, events: [...a.events, { seq: a.events.length + 1, event: 'reminder', at }] }
    changed = true
  }

  // 5. Due.
  const entries: AskEntry[] = []
  for (const a of asks) {
    const delivered = new Set(a.tries.filter((t) => t.outcome === 'delivered').map((t) => t.seq))
    const closing = closingEvent(a)
    const due = a.state === 'open' ? a.events : closing === null ? [] : [closing]
    const key = decisionKey(a.kind, a.scope, a.digest)
    for (const e of due) {
      if (delivered.has(e.seq)) continue
      entries.push({
        id: a.id,
        seq: e.seq,
        event: e.event,
        kind: a.kind,
        scope: a.scope,
        plugin: a.plugin,
        digest: a.digest,
        nonce: a.nonce,
        summary: a.summary,
        raised_at: a.raised_at,
        expires_at: a.expires_at,
        ...(content.has(key) ? { content: content.get(key) } : {}),
      })
    }
  }

  // Warning before info, then the oldest Ask, then the id, so one message reads the same way the list does.
  entries.sort(
    (x, y) =>
      severityRank(x.kind) - severityRank(y.kind) ||
      Date.parse(x.raised_at) - Date.parse(y.raised_at) ||
      (x.id < y.id ? -1 : x.id > y.id ? 1 : 0),
  )

  return { store: { min_reader_version: ASKS_READER_VERSION, asks }, entries, unrecorded, changed }
}

/** The store with one try appended to each Ask an entry names, by that entry's seq. An Ask no longer stored is skipped. */
export function recordTry(
  store: AskStore,
  entries: readonly AskEntry[],
  t: { at: string; outcome: AskTry['outcome']; exit_code: number | null },
): AskStore {
  return {
    ...store,
    asks: store.asks.map((a) => {
      const mine = entries.filter((e) => e.id === a.id)
      return mine.length === 0 ? a : { ...a, tries: [...a.tries, ...mine.map((e) => ({ seq: e.seq, ...t }))] }
    }),
  }
}

/** The one message for `notify`: `{ entries: [...] }`, with `content` on each entry only when asked for. */
export function askMessage(entries: readonly AskEntry[], includeContent: boolean): string {
  return JSON.stringify({
    entries: entries.map((e) => ({
      id: e.id,
      seq: e.seq,
      event: e.event,
      kind: e.kind,
      scope: e.scope,
      plugin: e.plugin,
      digest: e.digest,
      nonce: e.nonce,
      summary: e.summary,
      raised_at: e.raised_at,
      expires_at: e.expires_at,
      ...(includeContent ? { content: e.content ?? null } : {}),
    })),
  })
}
