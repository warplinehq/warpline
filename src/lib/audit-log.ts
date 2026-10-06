/**
 * audit-log — the audit store under `<home>/audit/`, and its only writer.
 *
 * Every change to who may act, and every side effect that fires, is appended
 * here before it takes effect. Nothing else in this repository writes under
 * the audit directory, and nothing here ever deletes or rewrites a stored
 * line: the store is append-only, and the operator archives it by export.
 *
 * **The hash input is the written bytes.** Each line is one CloudEvents 1.0
 * structured-mode JSON object, and `warplineprev` is the sha256 of the
 * previous line exactly as it sits on disk, newline excluded. Nothing is
 * re-serialized to check a chain, so a reader needs no canonicalizer and
 * compares byte for byte.
 *
 * **It takes no lock but its own, and always after the state lock.** A caller
 * that holds the state lock may append. This module never takes the state
 * lock, so the two can never be taken in the other order.
 *
 * **It imports nothing from the runtime or the board.** Both import from
 * `src/lib`, and the approval gate lives in the runtime. A store reachable from
 * the gate, or able to reach it, would make the import guard on this file a
 * graph walk instead of a line scan. For the same reason the home is never
 * resolved here: every public function takes the state file path, and the
 * audit directory is that file's grandparent plus `audit`.
 *
 * **How callers name a kind.** Every caller passes the kind as a quoted
 * literal straight to the call, never through a helper that takes it as a
 * variable. It writes the call's name, its first argument and that quoted kind
 * on one line, and the data argument may continue below. It imports the
 * store's functions by name, unaliased, on one plain import line. A scan reads
 * each kind from the line that names the call and reports every other line
 * naming them, so a kind passed any other way is invisible to it.
 */
import { mkdir, open, readdir, readFile, stat, unlink } from 'node:fs/promises'
import { closeSync, createReadStream, openSync, readFileSync, readlinkSync, unlinkSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { RefusalReasonSchema } from '../schemas/run-log.js'
import { deriveHost, isProcessAlive } from './host-identity.js'

/** The longest stored line, newline included. The tail read holds four. */
export const MAX_LINE_BYTES = 16_384

const AUDIT_DIR_NAME = 'audit'
const ZERO_HASH = '0'.repeat(64)
const LOCK_TIMEOUT_MS = 10_000
const LOCK_POLL_MS = 50
const LOCK_STALE_MS = 30_000
const TAIL_BYTES = 65_536
const SEGMENT_NAME = /^\d{16}\.jsonl$/

/** A segment at or past this size is sealed before the next append. */
export const SEGMENT_MAX_BYTES = 64 * 1024 * 1024
/** A segment this old, from its `segment.opened` time, is sealed before the next append. */
export const SEGMENT_MAX_AGE_MS = 30 * 86_400_000

/** The closed set. A kind not listed here cannot be written. */
export const AUDIT_KINDS = [
  'grant.issued',
  'grant.renewed',
  'grant.revoked',
  'content_approval.issued',
  'content_approval.withdrawn',
  'denial.recorded',
  'denial.lifted',
  'fire.intent',
  'fire.outcome',
  'fire.refused',
  'fire.resolved',
  'principal.added',
  'principal.disabled',
  'principal_registry.observed',
  'preference.set',
  'preferences.observed',
  'ask.raised',
  'ask.answered',
  'handoff.tried',
  'segment.opened',
  'segment.sealed',
  'checkpoint.recorded',
] as const

/** Written by this module only, never by a caller. */
export const INTERNAL_KINDS = ['segment.opened', 'segment.sealed', 'checkpoint.recorded'] as const

export type AuditKind = (typeof AUDIT_KINDS)[number]
export type EmitKind = Exclude<AuditKind, (typeof INTERNAL_KINDS)[number]>

// -- Data: identifiers, closed enums, hex digests and ISO times only --------

const Hex = z.string().regex(/^[0-9a-f]{64}$/)
const Urn = z.string().regex(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
const PluginName = z.string().min(1).max(255).regex(/^[^\x00-\x1f\x7f/\\]+$/)
const RunId = z.string().regex(/^[0-9A-Za-z][0-9A-Za-z._:-]{0,127}$/)
const PrincipalId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)
const PrefKey = z.string().regex(/^[a-z_]+(\.[a-z_]+)?$/)
const Iso = z.iso.datetime()
const Seq = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const SemVer = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/)
const Scope = z.union([z.literal('*'), PluginName])
const Entries = z.record(PrincipalId, Hex)
/** Each changed id to its new entry digest, or null when it left the registry. */
const ChangedEntries = z.record(PrincipalId, Hex.nullable())
/** The lines a pass-over named, each by seq and the sha256 of its bytes. */
const PassedOver = z.array(z.strictObject({ seq: Seq, sha256: Hex })).min(1)

const DATA = {
  'segment.opened': z.strictObject({
    home: Urn,
    version: SemVer,
    fragment: z.strictObject({ bytes: z.number().int().positive(), sha256: Hex }).nullable(),
    passed_over: PassedOver.optional(),
    authority: z.strictObject({
      preferences: Hex.nullable(),
      principals: z.strictObject({ sha256: Hex, entries: Entries }).nullable(),
    }),
    open_intents: z.array(
      z.strictObject({ seq: Seq, plugin: PluginName, run_id: RunId, effect_id: Hex.nullable() }),
    ),
  }),
  'segment.sealed': z.strictObject({
    reason: z.enum(['size', 'age']),
    bytes: z.number().int().nonnegative(),
  }),
  'checkpoint.recorded': z.strictObject({ origin: Urn, size: Seq, root: Hex }),
  'grant.issued': z.strictObject({
    scopes: z.array(Scope).min(1),
    ttl_ms: z.number().int().positive().nullable(),
    replace: z.boolean(),
    long: z.boolean(),
  }),
  'grant.renewed': z.never(),
  'grant.revoked': z.strictObject({ scopes: z.array(Scope) }),
  'content_approval.issued': z.strictObject({
    plugin: PluginName,
    producer: PluginName,
    fingerprint: Hex,
    run_id: RunId.nullable(),
    opens_at: Iso,
    closes_at: Iso,
    replaced_fingerprint: Hex.nullable(),
  }),
  'content_approval.withdrawn': z.strictObject({ plugin: PluginName, fingerprint: Hex.nullable() }),
  'denial.recorded': z.strictObject({
    plugin: PluginName,
    fingerprint: Hex,
    discarded_gate_run_id: RunId.nullable(),
  }),
  'denial.lifted': z.strictObject({ plugin: PluginName, fingerprint: Hex.nullable() }),
  'fire.intent': z.strictObject({
    plugin: PluginName,
    run_id: RunId,
    class: z.enum(['session', 'content']),
    effect_id: Hex.nullable(),
    fingerprint: Hex.nullable(),
  }),
  'fire.outcome': z.strictObject({
    plugin: PluginName,
    run_id: RunId,
    intent_seq: Seq,
    status: z.enum(['success', 'partial', 'skipped', 'failed', 'threw']),
  }),
  'fire.refused': z.strictObject({
    plugin: PluginName,
    run_id: RunId,
    reason: RefusalReasonSchema,
    intent_seq: Seq.nullable(),
  }),
  'fire.resolved': z.strictObject({
    plugin: PluginName,
    effect_id: Hex.nullable(),
    intent_seq: Seq.nullable(),
    answer: z.enum(['shipped', 'not_shipped']),
  }),
  'principal.added': z.strictObject({
    id: PrincipalId,
    type: z.enum(['human', 'machine']),
    key_sha256: Hex.nullable(),
    sha256: Hex,
    entry_sha256: Hex,
  }),
  'principal.disabled': z.strictObject({ id: PrincipalId, sha256: Hex, entry_sha256: Hex }),
  'principal_registry.observed': z.strictObject({
    old: Hex.nullable(),
    new: Hex.nullable(),
    changed_ids: z.array(PrincipalId),
    editor: z.literal('unknown'),
    changed_entries: ChangedEntries,
  }),
  'preference.set': z.strictObject({ key: PrefKey, old: Hex.nullable(), new: Hex }),
  'preferences.observed': z.strictObject({
    old: Hex.nullable(),
    new: Hex.nullable(),
    changed: z.literal('unknown'),
    editor: z.literal('unknown'),
  }),
  // Pending: nothing may be written under these until the work that defines
  // them lands and replaces the schema.
  'ask.raised': z.never(),
  'ask.answered': z.never(),
  'handoff.tried': z.never(),
} as const satisfies Record<AuditKind, z.ZodType>

export type AuditData<K extends AuditKind> = z.infer<(typeof DATA)[K]>

// -- Errors ------------------------------------------------------------------

type Reason =
  | `segment ${string} holds only a partial line`
  | WalkRefusal
  | 'unknown kind'
  | 'internal kind'
  | 'data rejected by its schema'
  | 'line over 16384 bytes'
  | 'audit lock not acquired'
  | 'audit lock not acquired in time'
  | 'a stale audit lock cannot be broken while .lock.break exists'
  | 'the active segment holds no readable last line'
  | 'write failed'
  | 'the store has no segment to pass over'
  | `seq ${number} is not a line the walk stops on in the active segment`
  | `seq ${number} opens the active segment and cannot be passed over`

/**
 * An append that did not happen. The message is built from the kind and a
 * fixed phrase only, never from the data, a schema issue or a path, because it
 * reaches stderr and from there the operator's mail. The one phrase that names
 * something names a segment file, whose name is only digits.
 */
export class AuditAppendError extends Error {
  /** The fixed phrase the message ends in, for a caller that names it. */
  readonly reason: Reason

  constructor(kind: string, reason: Reason, cause?: unknown) {
    super(`audit store: could not append ${kind}: ${reason}`, cause === undefined ? undefined : { cause })
    this.name = 'AuditAppendError'
    this.reason = reason
  }
}

// -- Paths and lines ---------------------------------------------------------

/** `<home>/audit`, from the state file's grandparent. Never exported. */
function auditDirFor(statePath: string): string {
  return join(dirname(dirname(statePath)), AUDIT_DIR_NAME)
}

const segmentName = (firstSeq: number): string => `${String(firstSeq).padStart(16, '0')}.jsonl`

const firstSeqOf = (name: string): number => Number(name.slice(0, 16))

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

/** One stored line, newline included, with the envelope keys in their fixed order. */
function encode(seq: number, source: string, prev: string, kind: AuditKind, data: unknown, time: number): Buffer {
  return Buffer.from(
    `${JSON.stringify({
      specversion: '1.0',
      id: String(seq),
      source,
      type: `warpline.audit.${kind}`,
      time: new Date(time).toISOString(),
      datacontenttype: 'application/json',
      // ponytail: warplineseq is a CloudEvents Integer and so is good to
      // 2,147,483,647 records. Past that the attribute needs a string form.
      warplineseq: seq,
      warplineprev: prev,
      data,
    })}\n`,
  )
}

/** The head a line makes: the hash of its bytes, newline excluded. */
const headOf = (line: Buffer): string => sha256(line.subarray(0, line.length - 1))

async function listSegments(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((name) => SEGMENT_NAME.test(name)).sort()
}

/** Up to `length` bytes of a file from `start`. */
async function readAt(path: string, start: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length)
  const fh = await open(path, 'r')
  try {
    const { bytesRead } = await fh.read(buf, 0, length, start)
    return buf.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }
}

/**
 * The last complete line of a segment, whether the segment ends in a partial
 * line, and its size. Read from the last `TAIL_BYTES`, and from twice as far
 * back each time that window holds no whole line, so an internal line of any
 * length is found. `line` is null when the segment holds no complete line.
 */
async function lastLine(path: string): Promise<{ line: Buffer | null; torn: boolean; size: number }> {
  const { size } = await stat(path)
  for (let window = TAIL_BYTES; ; window *= 2) {
    const start = Math.max(0, size - window)
    const buf = await readAt(path, start, size - start)
    const torn = buf.length > 0 && buf[buf.length - 1] !== 0x0a
    const end = buf.lastIndexOf(0x0a)
    const from = end === -1 ? -1 : buf.lastIndexOf(0x0a, end - 1) + 1
    // No newline, or the line's start lies before the window: read further back.
    if (end === -1 || (from === 0 && start > 0)) {
      if (start === 0) return { line: null, torn, size }
      continue
    }
    return { line: buf.subarray(from, end), torn, size }
  }
}

type StoredRecord = { warplineseq: number; source: string; type: string; time?: unknown; data?: any }

/** A stored line's envelope, or undefined when it is not one of ours. */
function parseRecord(line: string): StoredRecord | undefined {
  try {
    const r = JSON.parse(line)
    if (Seq.safeParse(r?.warplineseq).success && typeof r.source === 'string' && typeof r.type === 'string') return r
  } catch {}
  return undefined
}

type Carried = Pick<AuditData<'segment.opened'>, 'authority' | 'open_intents'>

const EMPTY_STATE: Carried = { authority: { preferences: null, principals: null }, open_intents: [] }

/**
 * The fields the walk carries into output, per stored type, each under the
 * writer's own field rule. Non-strict, so a key no rule names is stripped and
 * never reaches the walk. A type not listed here is passed over unread.
 *
 * A principal record is read in either shape a writer has written: the whole
 * id-to-digest map in `entries`, or the one entry that changed. `z.xor` takes a
 * line that matches exactly one shape. A line holding both matches both, and no
 * writer writes one, so it fails here and the walk stops at it rather than
 * folding whichever shape is listed first.
 */
const CARRIED = {
  'warpline.audit.fire.intent': z.object({ plugin: PluginName, run_id: RunId, effect_id: Hex.nullable() }),
  'warpline.audit.fire.outcome': z.object({ intent_seq: Seq.nullable() }),
  'warpline.audit.fire.refused': z.object({ intent_seq: Seq.nullable() }),
  'warpline.audit.fire.resolved': z.object({ intent_seq: Seq.nullable() }),
  'warpline.audit.preference.set': z.object({ new: Hex.nullable() }),
  'warpline.audit.preferences.observed': z.object({ new: Hex.nullable() }),
  'warpline.audit.principal.added': z.xor([
    z.object({ sha256: Hex, entries: Entries }),
    z.object({ id: PrincipalId, sha256: Hex, entry_sha256: Hex }),
  ]),
  'warpline.audit.principal.disabled': z.xor([
    z.object({ sha256: Hex, entries: Entries }),
    z.object({ id: PrincipalId, sha256: Hex, entry_sha256: Hex }),
  ]),
  'warpline.audit.principal_registry.observed': z.xor([
    z.object({ new: Hex.nullable(), entries: Entries }),
    z.object({ new: Hex.nullable(), changed_entries: ChangedEntries }),
  ]),
} as const

/**
 * What the opening `segment.opened` carries, under the same field rules its
 * writer schema uses. Every value here reaches output, so no rule is looser.
 */
const OPENED_CARRIES = z.object({
  authority: z.object({
    preferences: Hex.nullable(),
    principals: z.object({ sha256: Hex, entries: Entries }).nullable(),
  }),
  open_intents: z.array(z.object({ seq: Seq, plugin: PluginName, run_id: RunId, effect_id: Hex.nullable() })),
})

type CarriedType = keyof typeof CARRIED
type ShortKind<T> = T extends `warpline.audit.${infer K}` ? K : never

/** The way past a line the walk stops on, named where the walk stops. Fixed words. */
const PASS_IT_OVER = '; pass it over with warpline audit pass-over (docs/runtime-spec.md § 14)'

/**
 * Why a walk stopped: a seq, a kind the walk carries and fixed words, never a
 * line's data. A line pass-over can name says so. The opening line cannot be
 * passed over, so its refusal names no pass-over.
 */
type WalkRefusal =
  | `seq ${number} is not a record${typeof PASS_IT_OVER}`
  | `seq ${number} opens the active segment and is not a segment.opened the walk can carry`
  | `seq ${number} holds ${ShortKind<CarriedType>} data the walk cannot carry${typeof PASS_IT_OVER}`

type Walked = { state: Carried } | { refused: WalkRefusal }

/** A carried line: its type, its seq, and only the fields its rule names. */
type CarriedLine = { type: CarriedType; seq: number; data: any }

/**
 * What the next `segment.opened` carries: the state the active segment opened
 * with, walked forward over its carried lines, so no reader has to cross a file.
 */
function segmentState(lines: CarriedLine[], carried: Carried): Carried {
  let { preferences, principals } = carried.authority
  const open = new Map(carried.open_intents.map((i) => [i.seq, i]))
  for (const { type, seq, data } of lines) {
    switch (type) {
      case 'warpline.audit.fire.intent':
        open.set(seq, { seq, plugin: data.plugin, run_id: data.run_id, effect_id: data.effect_id })
        break
      // A null intent_seq closes nothing.
      case 'warpline.audit.fire.outcome':
      case 'warpline.audit.fire.refused':
      case 'warpline.audit.fire.resolved':
        open.delete(data.intent_seq)
        break
      case 'warpline.audit.preference.set':
      case 'warpline.audit.preferences.observed':
        preferences = data.new
        break
      // A line with the whole map replaces it. A line naming one change sets
      // that change over the map carried so far, in a new object.
      case 'warpline.audit.principal.added':
      case 'warpline.audit.principal.disabled':
        principals = {
          sha256: data.sha256,
          entries: 'entries' in data ? data.entries : { ...principals?.entries, [data.id]: data.entry_sha256 },
        }
        break
      case 'warpline.audit.principal_registry.observed': {
        if (data.new === null) {
          principals = null
          break
        }
        let entries: Record<string, string> = data.entries
        if (!('entries' in data)) {
          entries = { ...principals?.entries }
          for (const [id, digest] of Object.entries(data.changed_entries as Record<string, string | null>)) {
            if (digest === null) delete entries[id]
            else entries[id] = digest
          }
        }
        principals = { sha256: data.new, entries }
        break
      }
    }
  }
  return { authority: { preferences, principals }, open_intents: [...open.values()] }
}

/**
 * What the walk does with a line that is not its segment's first, at
 * positional `seq`: stops at it, carries it, or passes over it unread (null).
 * The walk and the pass-over's check both ask here, so the two cannot drift.
 */
function walkLine(line: string, seq: number): { refused: WalkRefusal } | { carried: CarriedLine | null } {
  const r = parseRecord(line)
  if (r === undefined) return { refused: `seq ${seq} is not a record${PASS_IT_OVER}` }
  if (!Object.hasOwn(CARRIED, r.type)) return { carried: null }
  const type = r.type as CarriedType
  const data = CARRIED[type].safeParse(r.data)
  if (!data.success) {
    return {
      refused: `seq ${seq} holds ${type.slice('warpline.audit.'.length) as ShortKind<CarriedType>} data the walk cannot carry${PASS_IT_OVER}`,
    }
  }
  return { carried: { type, seq: r.warplineseq, data: data.data } }
}

/**
 * The state a segment's complete lines walk to. The walk reads only what it
 * carries: each line's type, the opening line's carried fields, and for a type
 * in `CARRIED` the fields its rule names. Every other type and every other key
 * is passed over, so a record a later build writes does not stop it. It stops
 * at a line that is not a record, a first line that is not a `segment.opened`
 * it can carry, or a carried field no writer would write, so no such value
 * reaches a reader's output. `text` ends at a newline, or is empty, and its
 * first line is seq `firstSeq`. A non-first line whose seq is in `skip` is
 * passed over unread.
 */
function stateOf(text: string, firstSeq: number, skip: ReadonlySet<number> = new Set()): Walked {
  const lines = text.split('\n').slice(0, -1)
  let opened: Carried | undefined
  const carried: CarriedLine[] = []
  for (const [i, line] of lines.entries()) {
    const seq = firstSeq + i
    // Whether or not it is a record, the opening line holds the state the
    // walk starts from, and no pass-over can name it.
    if (i === 0) {
      const r = parseRecord(line)
      const data = r?.type === 'warpline.audit.segment.opened' ? OPENED_CARRIES.safeParse(r.data) : undefined
      if (data === undefined || !data.success) {
        return { refused: `seq ${seq} opens the active segment and is not a segment.opened the walk can carry` }
      }
      opened = data.data
      continue
    }
    // A line a pass-over named is not read. The opening line never is.
    if (skip.has(seq)) continue
    const step = walkLine(line, seq)
    if ('refused' in step) return step
    if (step.carried !== null) carried.push(step.carried)
  }
  if (opened === undefined) {
    return { refused: `seq ${firstSeq} opens the active segment and is not a segment.opened the walk can carry` }
  }
  return { state: segmentState(carried, opened) }
}

// -- The writer --------------------------------------------------------------

/**
 * Appends in this process run one at a time, ahead of the file lock. A level
 * runs its plugins under `Promise.all`, and two appends racing for the file
 * lock from one process would only poll each other.
 */
let queue: Promise<unknown> = Promise.resolve()

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let ourHostMemo: { value: string | null } | undefined

/**
 * This machine as a lock names it: § 12's machine identifier, and on Linux
 * that joined by `:` to the pid namespace (`/proc/self/ns/pid`). Null when
 * either part cannot be had. The namespace keeps two containers that share
 * `/etc/machine-id` from reading each other's live holder as dead. Memoized,
 * because a process never changes machine or pid namespace.
 *
 * ponytail: two machines that share a machine id on the same namespace inode,
 * a cloned image, still look like one. Boot time in the identity is the
 * upgrade path.
 */
function ourHost(): string | null {
  if (ourHostMemo === undefined) {
    let value = deriveHost()
    if (value !== null && process.platform === 'linux') {
      try {
        value = `${value}:${readlinkSync('/proc/self/ns/pid')}`
      } catch {
        value = null
      }
    }
    ourHostMemo = { value }
  }
  return ourHostMemo.value
}

/**
 * Create `path` exclusively, naming its holder: `{ token, at, pid, host }`.
 * True when taken, false when the file already exists, and any other error is
 * thrown. Synchronous, so no `process.exit` can land between creating the file
 * and naming the holder in it.
 */
function take(path: string, token: string): boolean {
  const text = JSON.stringify({ token, at: Date.now(), pid: process.pid, host: ourHost() })
  let fd: number
  try {
    fd = openSync(path, 'wx')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw err
  }
  try {
    writeSync(fd, text)
  } finally {
    closeSync(fd)
  }
  return true
}

/**
 * Who holds the lock or break file at `path`, as far as this writer can tell.
 * Null only when the file is gone, or cannot even be stat'ed.
 *
 * `token` is the holder's token, or null when the file cannot be read or names
 * none. `stale` is true when the holder is gone on this machine: it names a
 * pid and a host, the host is known and equal to this writer's, and no such
 * process runs. It is also true when the file is older than 30 s, by the time
 * it holds, or by its file time when it holds none. A missing host never
 * equals another, so a pid from another machine or pid namespace is never
 * judged here.
 */
async function holderOf(path: string): Promise<{ token: string | null; stale: boolean } | null> {
  let named: { token?: unknown; at?: unknown; pid?: unknown; host?: unknown } = {}
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf-8'))
    if (typeof parsed === 'object' && parsed !== null) named = parsed
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
  }
  const token = typeof named.token === 'string' ? named.token : null
  const { pid, host } = named
  if (typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 && typeof host === 'string' && host === ourHost() && !isProcessAlive(pid)) {
    return { token, stale: true }
  }
  let at: number
  if (typeof named.at === 'number') {
    at = named.at
  } else {
    try {
      at = (await stat(path)).mtimeMs
    } catch {
      return null
    }
  }
  return { token, stale: Date.now() - at > LOCK_STALE_MS }
}

/**
 * Remove a stale lock, one writer at a time, and only the lock that was judged.
 *
 * The break file is created exclusively first, naming its holder as a lock
 * does. Under it the lock is read again and removed only while it holds
 * `token`, the token it was judged by. A lock that could not be read has no
 * token, and is removed only while it still has none and is still stale. For
 * one token a judgment only grows staler: the audit lock has no heartbeat, and
 * a dead pid stays dead. So the token compare is the whole re-check for a lock
 * that can be read, and a lock some other breaker replaced is left alone.
 *
 * A break file already there is judged the same way. One whose holder is gone
 * on this machine, or one older than 30 s that names no machine, is cleared
 * through the token-checked release, and the caller tries again at once. One
 * that names no holder is kept.
 */
async function breakStale(
  dir: string,
  lockPath: string,
  token: string | null,
): Promise<'removed' | 'cleared' | 'kept' | 'break file held'> {
  const breakPath = join(dir, '.lock.break')
  try {
    if (!take(breakPath, randomUUID())) {
      const breaker = await holderOf(breakPath)
      if (breaker?.stale && breaker.token !== null && release(breakPath, breaker.token)) return 'cleared'
      return 'break file held'
    }
  } catch {
    return 'kept'
  }
  try {
    const now = await holderOf(lockPath)
    if (now === null) return 'kept'
    const judged = token === null ? now.token === null && now.stale : now.token === token
    if (!judged) return 'kept'
    await unlink(lockPath)
    return 'removed'
  } catch (err) {
    // A lock already gone is as good as removed. Anything else, a directory
    // say, cannot be broken here.
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'removed' : 'kept'
  } finally {
    await unlink(breakPath).catch(() => {})
  }
}

/**
 * Take the audit lock, waiting up to `timeoutMs`. The lock names its holder,
 * and is recorded in `held` in the same synchronous stretch that took it, so
 * the exit hook below can see it. A lock whose holder is gone on this machine,
 * or that is older than 30 s, is broken through the break file.
 */
async function acquire(dir: string, lockPath: string, kind: string, timeoutMs: number): Promise<string> {
  const token = randomUUID()
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      if (take(lockPath, token)) {
        held = { lockPath, token }
        return token
      }
    } catch (err) {
      throw new AuditAppendError(kind, 'audit lock not acquired', err)
    }
    // Only this pass's answer counts toward the reason the wait ends with.
    let breakHeld = false
    const seen = await holderOf(lockPath)
    if (seen?.stale) {
      // ponytail: a holder alive but paused past 30 s (suspended, swapped
      // out, or slow inside a rotation's whole-segment walk and datasyncs)
      // loses its lock, and its late write can interleave with the next
      // holder's. A fencing token checked at write time is the upgrade path.
      const broken = await breakStale(dir, lockPath, seen.token)
      if (broken === 'removed' || broken === 'cleared') continue
      breakHeld = broken === 'break file held'
    }
    if (Date.now() >= deadline) {
      throw new AuditAppendError(
        kind,
        breakHeld ? 'a stale audit lock cannot be broken while .lock.break exists' : 'audit lock not acquired in time',
      )
    }
    await sleep(LOCK_POLL_MS)
  }
}

/**
 * Remove `path` only while it still holds `token`, and say whether this call
 * removed it. Gone, unreadable or another token: not this caller's to remove.
 * Synchronous, so the exit hook can call it.
 */
function release(path: string, token: string): boolean {
  try {
    const named = JSON.parse(readFileSync(path, 'utf-8')) as { token?: unknown } | null
    if (named?.token !== token) return false
    unlinkSync(path)
    return true
  } catch {
    return false
  }
}

/** The lock this process holds, if any. Set by `acquire`, cleared by `underLock`. */
let held: { lockPath: string; token: string } | null = null

// The held lock, removed when the process ends through `process.exit` inside
// its hold, and only while it still holds this process's token.
//
// An exit listener changes no signal disposition, so registering it on import
// is safe, unlike the signal handler `advance` installs. It runs on
// `process.exit`, which an interrupt handler, an uncaught throw and an
// unhandled rejection all reach. It does not run on SIGKILL, or on a signal
// with no handler. Measured on bun 1.4.2 and node 24.
//
// ponytail: a write still in flight when the process exits can land after the
// next holder took the lock, a window of microseconds. A fencing token checked
// at write time is the upgrade path.
process.on('exit', () => {
  if (held !== null) release(held.lockPath, held.token)
})

/** One write of the whole line, checked, then synced. */
async function writeLine(path: string, line: Buffer): Promise<void> {
  const fh = await open(path, 'a')
  try {
    const { bytesWritten } = await fh.write(line)
    if (bytesWritten !== line.length) throw new Error('short write')
    // ponytail: Bun's datasync() on macOS skips F_FULLFSYNC, so a record
    // survives a process or OS crash but not power loss with the drive cache
    // dirty. Node and Linux flush. The upgrade path is fcntl(F_FULLFSYNC)
    // through bun:ffi.
    await fh.datasync()
  } finally {
    await fh.close()
  }
}

async function syncDir(dir: string): Promise<void> {
  const dh = await open(dir, 'r')
  try {
    await dh.sync()
  } finally {
    await dh.close()
  }
}

function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')) as {
    version: string
  }
  return pkg.version
}

type Limits = { maxSegmentBytes: number; maxSegmentAgeMs: number }

/**
 * Decide, from the active segment, whether the append goes to it or to a new
 * segment, then write. Every line is built before the first byte is written,
 * so a refusal writes nothing. In order:
 *
 * 1. A partial last line is never written past or removed. A new segment
 *    opens after the last complete line and records the fragment's length and
 *    digest. Nothing is sealed, since the fragment cannot be sealed past.
 * 2. A segment whose last line is `segment.sealed` lost its successor in a
 *    crash. The successor opens, with no Checkpoint.
 * 3. A segment at the size or age threshold is sealed, and the new segment
 *    opens with a Checkpoint over everything before the record.
 * 4. Otherwise the record goes to the active segment.
 *
 * With `passing` a new segment opens whatever the active one holds, after it
 * as it stands. Each named seq must be a line of the active segment, not its
 * first, that the walk stops on. The walk passes over exactly those lines, the
 * opened line names each by seq and the hash of its bytes, and no record is
 * written (`dataAfter` is null). When the active segment ends in lines that are
 * not records, the new segment opens after the last record before them, and no
 * seal is written. Without `passing`, such a last line refuses every append.
 */
async function appendLocked(
  dir: string,
  kind: EmitKind | 'checkpoint.recorded' | 'segment.opened',
  // From the head the record goes after: its seq, its hash and the home id.
  // Only a Checkpoint's data depends on them. Null writes no record.
  dataAfter: ((seq: number, head: string, source: string) => unknown) | null,
  time: number,
  limits: Limits,
  passing?: readonly number[],
): Promise<{ seq: number; head: string }> {
  const segments = await listSegments(dir)
  // Genesis is a segment that opens on nothing: seq 1, a zero prev, empty state.
  let seq = 0
  let source = `urn:uuid:${randomUUID()}`
  let prev = ZERO_HASH
  let state = EMPTY_STATE
  let fragment: { bytes: number; sha256: string } | null = null
  let passed: { seq: number; sha256: string }[] | undefined
  let reason: 'size' | 'age' | null = null
  let opens = segments.length === 0
  const active = segments[segments.length - 1]
  const activePath = active === undefined ? '' : join(dir, active)
  let activeSize = 0
  let path = activePath

  if (passing !== undefined && active === undefined) throw new AuditAppendError(kind, 'the store has no segment to pass over')
  if (active !== undefined) {
    const tail = await lastLine(activePath)
    activeSize = tail.size
    let whole: Buffer | null = null
    let last = tail.line
    if (tail.torn) {
      const bytes = await readFile(activePath)
      const end = bytes.lastIndexOf(0x0a)
      // A successor would need this file's own name.
      if (end === -1) throw new AuditAppendError(kind, `segment ${active} holds only a partial line`)
      const tornBytes = bytes.subarray(end + 1)
      fragment = { bytes: tornBytes.length, sha256: sha256(tornBytes) }
      whole = bytes.subarray(0, end + 1)
      last = whole.subarray(whole.lastIndexOf(0x0a, end - 1) + 1, end)
    }
    let lastRecord = last === null ? undefined : parseRecord(last.toString('utf-8'))
    // The complete lines, as bytes, for a pass-over: each named one is hashed as written.
    const lines: Buffer[] = []
    // Whether a pass-over stepped back over trailing lines that are not records.
    let stepped = false
    if (passing !== undefined && last !== null) {
      whole ??= await readFile(activePath)
      for (let at = 0, nl = whole.indexOf(0x0a); nl !== -1; at = nl + 1, nl = whole.indexOf(0x0a, at)) {
        lines.push(whole.subarray(at, nl))
      }
      // A pass-over opens after the last record before them, so each still
      // ends its segment and the next segment.opened can name it.
      if (lastRecord === undefined) {
        let k = lines.length - 1
        for (; k >= 0 && lastRecord === undefined; k -= 1) lastRecord = parseRecord((lines[k] as Buffer).toString('utf-8'))
        if (lastRecord === undefined) {
          throw new AuditAppendError(kind, `seq ${firstSeqOf(active)} opens the active segment and is not a segment.opened the walk can carry`)
        }
        last = lines[k + 1] as Buffer
        stepped = true
      }
    }
    if (last === null || lastRecord === undefined) {
      throw new AuditAppendError(kind, 'the active segment holds no readable last line')
    }
    seq = lastRecord.warplineseq
    source = lastRecord.source
    prev = sha256(last)

    // Nothing is sealed past a line that is not a record, which would then no longer end its segment.
    if (!tail.torn && !stepped && lastRecord.type !== 'warpline.audit.segment.sealed') {
      if (tail.size >= limits.maxSegmentBytes) reason = 'size'
      else {
        const first = await firstLine(activePath)
        const openedAt = Date.parse(String(first === undefined ? undefined : parseRecord(first.toString('utf-8'))?.time))
        if (time - openedAt >= limits.maxSegmentAgeMs) reason = 'age'
      }
    }
    opens = passing !== undefined || tail.torn || reason !== null || lastRecord.type === 'warpline.audit.segment.sealed'

    if (opens) {
      whole ??= await readFile(activePath)
      if (passing !== undefined) {
        passed = [...new Set(passing)].sort((a, b) => a - b).map((n) => {
          const line = lines[n - firstSeqOf(active)]
          if (n === firstSeqOf(active)) throw new AuditAppendError(kind, `seq ${n} opens the active segment and cannot be passed over`)
          if (n < firstSeqOf(active) || line === undefined || !('refused' in walkLine(line.toString('utf-8'), n))) {
            throw new AuditAppendError(kind, `seq ${n} is not a line the walk stops on in the active segment`)
          }
          return { seq: n, sha256: sha256(line) }
        })
      }
      const walked = stateOf(whole.toString('utf-8'), firstSeqOf(active), new Set(passing))
      if ('refused' in walked) throw new AuditAppendError(kind, walked.refused)
      state = walked.state
    }
  }

  const sealed = reason === null ? null : encode(++seq, source, prev, 'segment.sealed', { reason, bytes: activeSize }, time)
  if (sealed !== null) prev = headOf(sealed)
  const fresh: Buffer[] = []
  if (opens) {
    // Internal lines are not held to MAX_LINE_BYTES. The tail read and the
    // first-line read both follow a line of any length.
    const line = encode(
      ++seq,
      source,
      prev,
      'segment.opened',
      DATA['segment.opened'].parse({
        home: source,
        version: packageVersion(),
        fragment,
        ...(passed === undefined ? {} : { passed_over: passed }),
        ...state,
      }),
      time,
    )
    path = join(dir, segmentName(seq))
    prev = headOf(line)
    fresh.push(line)
    if (sealed !== null) {
      const openedSeq = seq
      const checkpoint = encode(++seq, source, prev, 'checkpoint.recorded', { origin: source, size: openedSeq, root: prev }, time)
      prev = headOf(checkpoint)
      fresh.push(checkpoint)
    }
  }
  const record = dataAfter === null ? null : encode(seq + 1, source, prev, kind, dataAfter(seq, prev, source), time)
  if (record !== null) {
    seq += 1
    if (record.length > MAX_LINE_BYTES) throw new AuditAppendError(kind, 'line over 16384 bytes')
  }

  if (sealed !== null) await writeLine(activePath, sealed)
  for (const [i, line] of fresh.entries()) {
    await writeLine(path, line)
    if (i === 0) await syncDir(dir)
  }
  if (record !== null) await writeLine(path, record)
  return { seq, head: record === null ? prev : headOf(record) }
}

/**
 * Append one record, durably, before its effect. Resolves the new head;
 * rejects with `AuditAppendError` when nothing was appended, and the caller's
 * effect must then not happen.
 */
export function appendAudit<K extends EmitKind>(
  statePath: string,
  kind: K,
  data: AuditData<K>,
  opts: AppendOpts = {},
): Promise<{ seq: number; head: string }> {
  if (!(AUDIT_KINDS as readonly string[]).includes(kind)) {
    return Promise.reject(new AuditAppendError('(unlisted)', 'unknown kind'))
  }
  if ((INTERNAL_KINDS as readonly string[]).includes(kind)) {
    return Promise.reject(new AuditAppendError(kind, 'internal kind'))
  }
  const parsed = DATA[kind].safeParse(data)
  if (!parsed.success) return Promise.reject(new AuditAppendError(kind, 'data rejected by its schema'))

  return underLock(statePath, kind, opts, (dir, time, limits) => appendLocked(dir, kind, () => parsed.data, time, limits))
}

type AppendOpts = { lockTimeoutMs?: number; now?: () => number; maxSegmentBytes?: number; maxSegmentAgeMs?: number }

/**
 * `fn` in the in-process queue, holding the audit lock. Any throw is an
 * AuditAppendError. The hold ends with the token-checked release, then clears
 * `held`, so the exit hook has nothing left to remove.
 */
function underLock<T>(
  statePath: string,
  kind: string,
  opts: AppendOpts,
  fn: (dir: string, time: number, limits: Limits) => Promise<T>,
): Promise<T> {
  const dir = auditDirFor(statePath)
  const lockPath = join(dir, '.lock')
  const run = queue.then(async () => {
    try {
      await mkdir(dir, { recursive: true })
    } catch (err) {
      throw new AuditAppendError(kind, 'write failed', err)
    }
    const token = await acquire(dir, lockPath, kind, opts.lockTimeoutMs ?? LOCK_TIMEOUT_MS)
    try {
      return await fn(dir, (opts.now ?? Date.now)(), {
        maxSegmentBytes: opts.maxSegmentBytes ?? SEGMENT_MAX_BYTES,
        maxSegmentAgeMs: opts.maxSegmentAgeMs ?? SEGMENT_MAX_AGE_MS,
      })
    } catch (err) {
      if (err instanceof AuditAppendError) throw err
      throw new AuditAppendError(kind, 'write failed', err)
    } finally {
      release(lockPath, token)
      held = null
    }
  })
  // One failed append must not poison the ones queued behind it.
  queue = run.catch(() => {})
  return run
}

/**
 * The store as one Checkpoint left it, for `advance --json`. Every number is
 * the writer's own, taken in the lock hold that wrote the Checkpoint.
 */
export interface AuditSummary {
  /** The Checkpoint's seq, which is the head when it was taken. */
  seq: number
  /**
   * Summed size of every segment file. Null when the Checkpoint landed but the
   * store could not be read back after it.
   */
  bytes: number | null
  /**
   * How many segment files there are. Null when the Checkpoint landed but the
   * store could not be read back after it.
   */
  segments: number | null
  /** The Checkpoint's seq. Equal to `seq` here, and named so a reader of the store finds it. */
  checkpoint_seq: number
  /**
   * Every fire intent no outcome, refusal or resolution has closed. Surfaced,
   * never held. Null, never an empty list, when the Checkpoint landed but the
   * store could not be read back after it: could not look is not found none.
   */
  indeterminate: OpenIntent[] | null
}

/**
 * Append a Checkpoint covering everything before it, `{ origin, size, root }`:
 * the home id, the seq of the line before it and that line's hash. Called by an
 * advance that returns, once, before its dead-man file. Goes through the same
 * queue, lock and rotation check as `appendAudit`, so a rotation due now writes
 * its own Checkpoint first. Rejects with `AuditAppendError` only when the
 * Checkpoint was not appended. Once it is on disk the seq is reported whatever
 * the read-back does, and a read-back that fails leaves the other three null.
 */
export function recordCheckpoint(statePath: string, opts: AppendOpts = {}): Promise<AuditSummary> {
  return underLock(statePath, 'checkpoint.recorded', opts, async (dir, time, limits) => {
    const { seq } = await appendLocked(
      dir,
      'checkpoint.recorded',
      (size, root, origin) => DATA['checkpoint.recorded'].parse({ origin, size, root }),
      time,
      limits,
    )
    try {
      const segments = await listSegments(dir)
      let bytes = 0
      for (const name of segments) bytes += (await stat(join(dir, name))).size
      return { seq, bytes, segments: segments.length, checkpoint_seq: seq, indeterminate: await openIntentsIn(dir) }
    } catch {
      // The line is on disk. `warpline audit verify` names why the store
      // cannot be read back, and the caller exits 70 on the null.
      return { seq, bytes: null, segments: null, checkpoint_seq: seq, indeterminate: null }
    }
  })
}

/**
 * Open a new segment after the active one as it stands, passing over each named
 * line the walk stops on. No stored line is edited or removed: the new
 * `segment.opened` names each one in `passed_over`, by seq and the sha256 of
 * its bytes, and carries forward the state a walk that skips exactly those
 * lines reaches. Writes no record. A due rotation seals first, as for any
 * append. Rejects with `AuditAppendError` when nothing was written: no store
 * (which this never creates), a seq that is not a line of the active segment
 * the walk stops on, or another line the walk still stops on.
 */
export function passOver(
  statePath: string,
  seqs: readonly number[],
  opts: AppendOpts = {},
): Promise<{ seq: number; head: string; opened: number; passed: number[] }> {
  const passed = [...new Set(seqs)].sort((a, b) => a - b)
  // Checked before the lock, whose mkdir would create the store.
  return segmentsIn(auditDirFor(statePath)).then((names) => {
    if (names.length === 0) throw new AuditAppendError('segment.opened', 'the store has no segment to pass over')
    return underLock(statePath, 'segment.opened', opts, async (dir, time, limits) => {
      const { seq, head } = await appendLocked(dir, 'segment.opened', null, time, limits, passed)
      // The segment just opened is the last one, named by its first seq.
      return { seq, head, opened: firstSeqOf((await listSegments(dir)).at(-1) as string), passed }
    })
  })
}

/**
 * The head: the last complete line's seq and the hash of its bytes, or seq 0
 * and the zero hash before the first record. A pure reader: no lock, no mkdir.
 * Rejects with an Error named `AuditHeadUnreadableError` when the active
 * segment holds no complete line, or its last one is not a record.
 */
export async function readHead(statePath: string): Promise<{ seq: number; head: string }> {
  const dir = auditDirFor(statePath)
  let segments: string[]
  try {
    segments = await listSegments(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { seq: 0, head: ZERO_HASH }
    throw err
  }
  if (segments.length === 0) return { seq: 0, head: ZERO_HASH }
  const { line } = await lastLine(join(dir, segments[segments.length - 1] as string))
  const rec = line === null ? undefined : parseRecord(line.toString('utf-8'))
  if (line === null || rec === undefined) {
    const err = new Error('audit store: the active segment holds no readable last line')
    err.name = 'AuditHeadUnreadableError'
    throw err
  }
  return { seq: rec.warplineseq, head: sha256(line) }
}

/** A fire intent no record has closed yet. */
export interface OpenIntent {
  seq: number
  plugin: string
  run_id: string
  effect_id: string | null
}

/**
 * An authority file as the store last saw it, compared with the bytes a caller
 * just parsed. Equal resolves null. Different appends one observed record and
 * resolves its seq: `preferences.observed` names the two whole-file digests and
 * nothing else, and `principal_registry.observed` adds every id whose entry
 * digest was added, removed or changed, and each such id's new entry digest,
 * null for one that left the file. Neither names an editor, which nothing here
 * can know.
 *
 * `bytes` is exactly what was parsed, or null for a missing file. A whitespace
 * edit that parses to the same values is still a change, because the digest is
 * over the bytes.
 *
 * The last digest is the active segment's carried authority walked over its
 * own lines, read in the same lock hold as the append, so two readers cannot
 * both see the old digest and both record the change.
 *
 * Absence of observation must never read as absence of change. A missing file
 * the store has never seen is the one case that writes nothing, and it creates
 * no store either. Rejects with `AuditAppendError`, and the caller must then not
 * use what it read.
 */
export async function observeAuthorityFile(
  statePath: string,
  kind: 'preferences.observed' | 'principal_registry.observed',
  bytes: Buffer | null,
  entries?: Record<string, string>,
  opts: AppendOpts = {},
): Promise<{ seq: number } | null> {
  if (bytes === null && (await segmentsIn(auditDirFor(statePath))).length === 0) return null
  return underLock(statePath, kind, opts, async (dir, time, limits) => {
    const walked = await activeState(dir)
    if ('refused' in walked) throw new AuditAppendError(kind, walked.refused)
    const { preferences, principals } = walked.state.authority
    const now = bytes === null ? null : sha256(bytes)
    let data: unknown
    if (kind === 'preferences.observed') {
      if (preferences === now) return null
      data = { old: preferences, new: now, changed: 'unknown', editor: 'unknown' }
    } else {
      if ((principals?.sha256 ?? null) === now) return null
      const before = principals?.entries ?? {}
      const after = entries ?? {}
      const changed_ids = [...new Set([...Object.keys(before), ...Object.keys(after)])]
        .filter((id) => before[id] !== after[id])
        .sort()
      const changed_entries = Object.fromEntries(
        changed_ids.map((id) => [id, Object.hasOwn(after, id) ? after[id] : null]),
      )
      data = { old: principals?.sha256 ?? null, new: now, changed_ids, editor: 'unknown', changed_entries }
    }
    const parsed = DATA[kind].safeParse(data)
    if (!parsed.success) throw new AuditAppendError(kind, 'data rejected by its schema')
    const { seq } = await appendLocked(dir, kind, () => parsed.data, time, limits)
    return { seq }
  })
}

/** The segment file names, or none when there is no store. */
async function segmentsIn(dir: string): Promise<string[]> {
  try {
    return await listSegments(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

/**
 * The state the active segment's complete lines walk to, the empty state with
 * no store, or the walk's refusal.
 */
async function activeState(dir: string): Promise<Walked> {
  const active = (await segmentsIn(dir)).at(-1)
  if (active === undefined) return { state: EMPTY_STATE }
  const text = await readFile(join(dir, active), 'utf-8')
  return stateOf(text.slice(0, text.lastIndexOf('\n') + 1), firstSeqOf(active))
}

const bySeq = (intents: OpenIntent[]): OpenIntent[] => [...intents].sort((a, b) => a.seq - b.seq)

/**
 * The fire intents nothing has closed: those the active segment opened with
 * plus its own, less every one a `fire.outcome`, a `fire.refused` or a
 * `fire.resolved` names. In seq order. A pure reader: no lock, no mkdir, and a
 * partial last line is not read.
 *
 * Bookkeeping only. It names the seq a closing record carries, and the
 * indeterminate list. Nothing decides whether a fire proceeds on it.
 */
export function openIntents(statePath: string): Promise<OpenIntent[]> {
  return openIntentsIn(auditDirFor(statePath))
}

async function openIntentsIn(dir: string): Promise<OpenIntent[]> {
  const walked = await activeState(dir)
  if ('refused' in walked) throw new Error(`audit store: the open intents could not be read: ${walked.refused}`)
  return bySeq(walked.state.open_intents)
}

// -- Readers: export and verify ----------------------------------------------

/**
 * Each complete line of a segment, newline included, read in chunks. Returns
 * what follows the last newline: a partial line, or nothing.
 */
async function* scan(path: string): AsyncGenerator<Buffer, Buffer> {
  let rest: Buffer = Buffer.alloc(0)
  for await (const chunk of createReadStream(path)) {
    const buf = rest.length === 0 ? (chunk as Buffer) : Buffer.concat([rest, chunk as Buffer])
    let start = 0
    for (let nl = buf.indexOf(0x0a); nl !== -1; nl = buf.indexOf(0x0a, start)) {
      yield buf.subarray(start, nl + 1)
      start = nl + 1
    }
    rest = buf.subarray(start)
  }
  return rest
}

/**
 * Every complete line after `afterSeq`, newline included, in seq order across
 * segments, a chunk at a time. A pure reader: no lock, no mkdir. A partial
 * line is never yielded; the next segment's `segment.opened` acknowledges it.
 * No store yields nothing.
 */
export async function* readCompleteLines(statePath: string, afterSeq: number): AsyncGenerator<Buffer> {
  const dir = auditDirFor(statePath)
  const names = await segmentsIn(dir)
  // The last file that starts at or before the first line wanted.
  let from = 0
  for (const [i, name] of names.entries()) if (firstSeqOf(name) <= afterSeq + 1) from = i
  for (const name of names.slice(from)) {
    let seq = firstSeqOf(name) - 1
    for await (const line of scan(join(dir, name))) {
      seq += 1
      if (seq > afterSeq) yield line
    }
  }
}

/** A head kept off the box: a seq, its line's hash, and the home it names when it says. */
export interface Anchor {
  seq: number
  hex: string
  origin?: string
}

const DECIMAL = /^(0|[1-9][0-9]*)$/

/**
 * `<seq> <hex>` on one line, or a C2SP-shaped note body: an origin, a size and
 * the standard base64 of the 32-byte root. Read up to the first empty line, so
 * a signed note's signature lines are ignored. Throws on anything else, with a
 * message that quotes nothing from the text.
 */
export function parseAnchor(text: string): Anchor {
  const lines = text.split('\n')
  const end = lines.indexOf('')
  const body = end === -1 ? lines : lines.slice(0, end)
  const refuse = (): never => {
    throw new Error('the anchor is neither "<seq> <hex>" nor an origin, a size and a base64 root on three lines')
  }
  if (body.length === 1) {
    const m = /^(0|[1-9][0-9]*) ([0-9a-f]{64})$/.exec(body[0] as string)
    if (m === null || !Number.isSafeInteger(Number(m[1]))) return refuse()
    return { seq: Number(m[1]), hex: m[2] as string }
  }
  if (body.length !== 3) return refuse()
  const [origin, size, root] = body as [string, string, string]
  const bytes = Buffer.byteLength(origin)
  if (bytes < 1 || bytes > 255 || /\s/.test(origin)) return refuse()
  if (!DECIMAL.test(size) || !Number.isSafeInteger(Number(size))) return refuse()
  if (!/^[A-Za-z0-9+/]{43}=$/.test(root)) return refuse()
  return { seq: Number(size), hex: Buffer.from(root, 'base64').toString('hex'), origin }
}

/** A segment's first complete line, newline excluded, whatever its length, or undefined when it holds none. */
async function firstLine(path: string): Promise<Buffer | undefined> {
  const lines = scan(path)
  try {
    const { value, done } = await lines.next()
    return done ? undefined : value.subarray(0, value.length - 1)
  } finally {
    // Closes the file when the generator stopped at its first line.
    await lines.return(Buffer.alloc(0))
  }
}

/** The home id: the `source` of the store's first line, or undefined with no store. */
async function genesisSource(dir: string): Promise<string | undefined> {
  const first = (await segmentsIn(dir))[0]
  if (first === undefined) return undefined
  const line = await firstLine(join(dir, first))
  return line === undefined ? undefined : parseRecord(line.toString('utf-8'))?.source
}

/**
 * The head as an unsigned C2SP-shaped note body: the home id, the head seq and
 * the standard base64 of the head hash, one per line. Not a valid C2SP
 * checkpoint: there is no signature line, and the root is a chain head, not a
 * Merkle root. Throws on an empty store, which has no home id to name.
 */
export async function c2spNote(statePath: string): Promise<string> {
  const { seq, head } = await readHead(statePath)
  const source = seq === 0 ? undefined : await genesisSource(auditDirFor(statePath))
  if (source === undefined) throw new Error('the store has no records yet, so there is no origin to name.')
  return `${source}\n${seq}\n${Buffer.from(head, 'hex').toString('base64')}\n`
}

/**
 * Whether a `passed_over` names, in rising seq order, only lines of the segment
 * `prevName`, each hashing as recorded under the byte rule. Resolves `true`
 * when every entry holds. Otherwise resolves the failing entry's seq: the
 * first, in scan order, whose line hashes to something else, or the smallest
 * left unmatched once the segment ends. The seq is null when the list as a
 * whole fails: it is not a list of entries, its seqs do not rise, or there is
 * no segment before. Reads that segment only when called, so a store with no
 * pass-over pays nothing.
 */
async function passedOverHolds(
  dir: string,
  prevName: string | undefined,
  named: unknown,
): Promise<true | { seq: number | null }> {
  const parsed = PassedOver.safeParse(named)
  if (!parsed.success || prevName === undefined) return { seq: null }
  if (parsed.data.some((e, k) => k > 0 && e.seq <= (parsed.data[k - 1] as { seq: number }).seq)) return { seq: null }
  const want = new Map(parsed.data.map((e) => [e.seq, e.sha256]))
  let seq = firstSeqOf(prevName) - 1
  for await (const line of scan(join(dir, prevName))) {
    seq += 1
    const hash = want.get(seq)
    if (hash === undefined) continue
    if (sha256(line.subarray(0, line.length - 1)) !== hash) return { seq }
    want.delete(seq)
  }
  // The entries rise, so the first left is the smallest.
  const [left] = want.keys()
  return left === undefined ? true : { seq: left }
}

export type Verdict = 'clean' | 'torn' | 'tampered' | 'unreadable' | 'wrong_log'

export interface Verification {
  verdict: Verdict
  /** The store's head, or null when no complete line can be read as one. */
  head: { seq: number; hex: string } | null
  /** Why the verdict is not clean: a seq or a file and a rule, never data. */
  reason: string | null
  /** Records since the anchor; seconds and its time only once its line's hash matched. */
  stale: { records: number; seconds: number | null; anchored_at: string | null } | null
  /** The open fire intents, or null when the walk could not read them. Never an empty list for that. */
  open_intents: OpenIntent[] | null
  /** Why the open intents could not be read: a seq, a kind and a rule, never data. */
  intents_unreadable: string | null
}

/**
 * Check every segment against itself and the store against an anchor kept off
 * the box. A pure reader: no lock, no mkdir, nothing written.
 *
 * Tampered is any broken link, seq or file name, a line that is not a record
 * other than at the end of a segment the next `segment.opened` names in
 * `passed_over` (such a line moves no seq or link, and is never the line an
 * anchor is compared with), a partial line anywhere but the very end that no
 * later `segment.opened` acknowledges, a `passed_over` entry that does not
 * match the segment before it, an anchor beyond the head, or an anchored line
 * whose hash is not the anchor's. Torn is a partial line at the very end, an
 * acknowledged fragment, or a last segment whose last line is
 * `segment.sealed`. Unreadable is a chain that checks clean
 * or torn whose active segment holds a line the walk cannot carry, so the open
 * intents cannot be listed. A re-linked rewrite passes every link, so the
 * anchor is what catches it. Wrong log, then tampered, then unreadable, then
 * torn.
 */
export async function verifyStore(statePath: string, anchor: Anchor, now: number): Promise<Verification> {
  const dir = auditDirFor(statePath)
  const names = await segmentsIn(dir)
  let head: Verification['head'] = null
  try {
    const h = await readHead(statePath)
    head = { seq: h.seq, hex: h.head }
  } catch {}
  // Never swallowed: a walk that stopped is reported, and never read as none open.
  const walked = await activeState(dir)
  const open_intents = 'refused' in walked ? null : bySeq(walked.state.open_intents)
  const intents_unreadable = 'refused' in walked ? walked.refused : null
  const result = (verdict: Verdict, reason: string | null, stale: Verification['stale'] = null): Verification => ({
    verdict,
    head,
    reason,
    stale,
    open_intents,
    intents_unreadable,
  })

  const source = await genesisSource(dir)
  if (anchor.origin !== undefined && source !== undefined && anchor.origin !== source) {
    return result('wrong_log', 'the anchor names another home')
  }

  let seq = 0
  let prev = ZERO_HASH
  let pending: { bytes: number; sha256: string } | null = null
  let lastType: string | undefined
  let torn: string | null = null
  let matched = false
  let anchoredAt: string | null = null
  const tampered = (reason: string): Verification => {
    const records = head !== null && anchor.seq <= head.seq ? head.seq - anchor.seq : null
    return result('tampered', reason, records === null ? null : { records, seconds: null, anchored_at: null })
  }

  // Lines that are not records at the end of the segment before, by positional
  // seq. The next segment.opened must name each in passed_over.
  let carried: number[] = []
  for (const [i, name] of names.entries()) {
    if (name !== segmentName(seq + 1)) return tampered(`segment ${name} is not named by its first seq ${seq + 1}`)
    const lines = scan(join(dir, name))
    let n = 0
    // Lines that are not records, held until the segment ends or a record follows.
    const held: number[] = []
    let step = await lines.next()
    // An early return leaves the generator at a yield; this closes its file.
    try {
      for (; !step.done; step = await lines.next()) {
        const body = step.value.subarray(0, step.value.length - 1)
        const rec = parseRecord(body.toString('utf-8')) as (StoredRecord & { warplineprev?: unknown }) | undefined
        // A held line moves nothing: seq, prev and the anchor match advance
        // only on records, so a held line is never compared with the anchor.
        if (rec === undefined) {
          if (n === 0) return tampered(`seq ${seq + 1} is not a record`)
          held.push(seq + 1 + held.length)
          continue
        }
        if (held.length > 0) return tampered(`seq ${held[0]} is not a record`)
        if (rec.warplineseq !== seq + 1) return tampered(`seq ${seq + 1} is numbered ${rec.warplineseq}`)
        if (rec.warplineprev !== prev) return tampered(`seq ${seq + 1} does not link to the line before it`)
        if (n === 0) {
          const fragment = (rec.data?.fragment ?? null) as { bytes?: unknown; sha256?: unknown } | null
          const acknowledges =
            pending === null
              ? fragment === null
              : rec.type === 'warpline.audit.segment.opened' &&
                fragment?.bytes === pending.bytes &&
                fragment.sha256 === pending.sha256
          if (!acknowledges) return tampered(`seq ${seq + 1} does not acknowledge the partial line before it`)
          if (pending !== null) torn = `seq ${seq + 1} acknowledges a partial line the store kept`
          pending = null
          const named: unknown = rec.data?.passed_over
          const holds = named === undefined ? true : await passedOverHolds(dir, names[i - 1], named)
          if (holds !== true) {
            return tampered(
              holds.seq === null
                ? `seq ${seq + 1}'s passed_over does not match the segment before it`
                : `seq ${seq + 1}'s passed_over entry for seq ${holds.seq} does not match the segment before it`,
            )
          }
          // passedOverHolds checked each entry's hash; each carried line must be one.
          const unnamed = carried.find((c) => !(named as { seq: number }[] | undefined)?.some((e) => e.seq === c))
          if (unnamed !== undefined) return tampered(`seq ${unnamed} is not a record`)
          carried = []
        }
        n += 1
        seq += 1
        prev = sha256(body)
        lastType = rec.type
        if (seq === anchor.seq) {
          matched = prev === anchor.hex
          anchoredAt = typeof rec.time === 'string' ? rec.time : null
        }
      }
    } finally {
      await lines.return(Buffer.alloc(0))
    }
    const rest = step.value
    const last = i === names.length - 1
    if (held.length > 0) {
      if (last) return tampered(`seq ${held[0]} is not a record`)
      carried = held
    }
    if (n === 0 && !last) return tampered(`segment ${name} holds no complete line`)
    if (rest.length > 0) {
      if (last) torn = `the store ends in a partial line after seq ${seq}`
      else pending = { bytes: rest.length, sha256: sha256(rest) }
    } else if (n === 0) {
      torn = `segment ${name} is empty`
    }
  }
  if (lastType === 'warpline.audit.segment.sealed') torn = `seq ${seq} seals the last segment, and nothing follows it`

  if (anchor.seq === 0) {
    if (anchor.hex !== ZERO_HASH) return tampered('an anchor at seq 0 must carry the zero hash')
  } else if (anchor.seq > seq) {
    return tampered(`the anchored seq ${anchor.seq} is beyond the head ${seq}`)
  } else if (!matched) {
    return tampered(`seq ${anchor.seq} does not hash to the anchor`)
  }
  const at = anchoredAt === null ? NaN : Date.parse(anchoredAt)
  const stale = {
    records: seq - anchor.seq,
    seconds: Number.isNaN(at) ? null : Math.max(0, Math.floor((now - at) / 1000)),
    anchored_at: Number.isNaN(at) ? null : anchoredAt,
  }
  if (intents_unreadable !== null) return result('unreadable', intents_unreadable, stale)
  return result(torn === null ? 'clean' : 'torn', torn, stale)
}
