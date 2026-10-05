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
import { createReadStream, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { RefusalReasonSchema } from '../schemas/run-log.js'

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

const DATA = {
  'segment.opened': z.strictObject({
    home: Urn,
    version: SemVer,
    fragment: z.strictObject({ bytes: z.number().int().positive(), sha256: Hex }).nullable(),
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
  'fire.resolved': z.strictObject({ plugin: PluginName, effect_id: Hex, intent_seq: Seq.nullable() }),
  'principal.added': z.strictObject({
    id: PrincipalId,
    type: z.enum(['human', 'machine']),
    key_sha256: Hex.nullable(),
    sha256: Hex,
    entries: Entries,
  }),
  'principal.disabled': z.strictObject({ id: PrincipalId, sha256: Hex, entries: Entries }),
  'principal_registry.observed': z.strictObject({
    old: Hex.nullable(),
    new: Hex.nullable(),
    changed_ids: z.array(PrincipalId),
    editor: z.literal('unknown'),
    entries: Entries,
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
  | 'the active segment holds no readable last line'
  | 'write failed'

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
 * The last complete line of a segment, read from its last `TAIL_BYTES`,
 * whether the segment ends in a partial line, and its size. `line` is null
 * when the window holds no complete line.
 */
async function lastLine(path: string): Promise<{ line: Buffer | null; torn: boolean; size: number }> {
  const { size } = await stat(path)
  const start = Math.max(0, size - TAIL_BYTES)
  const buf = await readAt(path, start, size - start)
  const torn = buf.length > 0 && buf[buf.length - 1] !== 0x0a
  const end = buf.lastIndexOf(0x0a)
  if (end === -1) return { line: null, torn, size }
  const from = buf.lastIndexOf(0x0a, end - 1) + 1
  if (from === 0 && start > 0) return { line: null, torn, size }
  return { line: buf.subarray(from, end), torn, size }
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
 */
const CARRIED = {
  'warpline.audit.fire.intent': z.object({ plugin: PluginName, run_id: RunId, effect_id: Hex.nullable() }),
  'warpline.audit.fire.outcome': z.object({ intent_seq: Seq.nullable() }),
  'warpline.audit.fire.refused': z.object({ intent_seq: Seq.nullable() }),
  'warpline.audit.fire.resolved': z.object({ intent_seq: Seq.nullable() }),
  'warpline.audit.preference.set': z.object({ new: Hex.nullable() }),
  'warpline.audit.preferences.observed': z.object({ new: Hex.nullable() }),
  'warpline.audit.principal.added': z.object({ sha256: Hex, entries: Entries }),
  'warpline.audit.principal.disabled': z.object({ sha256: Hex, entries: Entries }),
  'warpline.audit.principal_registry.observed': z.object({ new: Hex.nullable(), entries: Entries }),
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

/** Why a walk stopped: a seq, a kind the walk carries and fixed words, never a line's data. */
type WalkRefusal =
  | `seq ${number} is not a record`
  | `seq ${number} opens the active segment and is not a segment.opened the walk can carry`
  | `seq ${number} holds ${ShortKind<CarriedType>} data the walk cannot carry`

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
      case 'warpline.audit.principal.added':
      case 'warpline.audit.principal.disabled':
        principals = { sha256: data.sha256, entries: data.entries }
        break
      case 'warpline.audit.principal_registry.observed':
        principals = data.new === null ? null : { sha256: data.new, entries: data.entries }
        break
    }
  }
  return { authority: { preferences, principals }, open_intents: [...open.values()] }
}

/**
 * The state a segment's complete lines walk to. The walk reads only what it
 * carries: each line's type, the opening line's carried fields, and for a type
 * in `CARRIED` the fields its rule names. Every other type and every other key
 * is passed over, so a record a later build writes does not stop it. It stops
 * at a line that is not a record, a first line that is not a `segment.opened`
 * it can carry, or a carried field no writer would write, so no such value
 * reaches a reader's output. `text` ends at a newline, or is empty, and its
 * first line is seq `firstSeq`.
 */
function stateOf(text: string, firstSeq: number): Walked {
  const lines = text.split('\n').slice(0, -1)
  let opened: Carried | undefined
  const carried: CarriedLine[] = []
  for (const [i, line] of lines.entries()) {
    const seq = firstSeq + i
    const r = parseRecord(line)
    if (r === undefined) return { refused: `seq ${seq} is not a record` }
    if (i === 0) {
      const data = r.type === 'warpline.audit.segment.opened' ? OPENED_CARRIES.safeParse(r.data) : undefined
      if (data === undefined || !data.success) {
        return { refused: `seq ${seq} opens the active segment and is not a segment.opened the walk can carry` }
      }
      opened = data.data
      continue
    }
    if (!Object.hasOwn(CARRIED, r.type)) continue
    const type = r.type as CarriedType
    const data = CARRIED[type].safeParse(r.data)
    if (!data.success) {
      return { refused: `seq ${seq} holds ${type.slice('warpline.audit.'.length) as ShortKind<CarriedType>} data the walk cannot carry` }
    }
    carried.push({ type, seq: r.warplineseq, data: data.data })
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

/** The lock's age in ms, or null when it is gone. */
async function lockAge(lockPath: string): Promise<number | null> {
  let text: string
  try {
    text = await readFile(lockPath, 'utf-8')
  } catch {
    return null
  }
  try {
    const at = (JSON.parse(text) as { at?: unknown }).at
    if (typeof at === 'number') return Date.now() - at
  } catch {}
  try {
    return Date.now() - (await stat(lockPath)).mtimeMs
  } catch {
    return null
  }
}

async function acquire(lockPath: string, kind: string, timeoutMs: number): Promise<string> {
  const token = randomUUID()
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const fh = await open(lockPath, 'wx')
      try {
        await fh.writeFile(JSON.stringify({ token, at: Date.now() }))
      } finally {
        await fh.close()
      }
      return token
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new AuditAppendError(kind, 'audit lock not acquired', err)
      }
    }
    const age = await lockAge(lockPath)
    if (age === null) continue
    if (age > LOCK_STALE_MS) {
      // ponytail: a holder paused past 30 s loses its lock, and a later write
      // of its own could interleave with the next holder's. The critical
      // section is kept to a tail read and one write so no live holder gets
      // near that. A fencing token checked at write time is the upgrade path.
      await unlink(lockPath).catch(() => {})
      continue
    }
    if (Date.now() >= deadline) throw new AuditAppendError(kind, 'audit lock not acquired in time')
    await sleep(LOCK_POLL_MS)
  }
}

/** Remove the lock only while it still holds this writer's token. */
async function release(lockPath: string, token: string): Promise<void> {
  try {
    const held = JSON.parse(await readFile(lockPath, 'utf-8')) as { token?: unknown }
    if (held.token === token) await unlink(lockPath)
  } catch {
    // Gone or unreadable: not this writer's to remove.
  }
}

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
 */
async function appendLocked(
  dir: string,
  kind: EmitKind | 'checkpoint.recorded',
  // From the head the record goes after: its seq, its hash and the home id.
  // Only a Checkpoint's data depends on them.
  dataAfter: (seq: number, head: string, source: string) => unknown,
  time: number,
  limits: Limits,
): Promise<{ seq: number; head: string }> {
  const segments = await listSegments(dir)
  // Genesis is a segment that opens on nothing: seq 1, a zero prev, empty state.
  let seq = 0
  let source = `urn:uuid:${randomUUID()}`
  let prev = ZERO_HASH
  let state = EMPTY_STATE
  let fragment: { bytes: number; sha256: string } | null = null
  let reason: 'size' | 'age' | null = null
  let opens = segments.length === 0
  const active = segments[segments.length - 1]
  const activePath = active === undefined ? '' : join(dir, active)
  let activeSize = 0
  let path = activePath

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
    const lastRecord = last === null ? undefined : parseRecord(last.toString('utf-8'))
    if (last === null || lastRecord === undefined) {
      throw new AuditAppendError(kind, 'the active segment holds no readable last line')
    }
    seq = lastRecord.warplineseq
    source = lastRecord.source
    prev = sha256(last)

    if (!tail.torn && lastRecord.type !== 'warpline.audit.segment.sealed') {
      if (tail.size >= limits.maxSegmentBytes) reason = 'size'
      else {
        const head = (await readAt(activePath, 0, Math.min(tail.size, TAIL_BYTES))).toString('utf-8')
        const openedAt = Date.parse(String(parseRecord(head.slice(0, head.indexOf('\n')))?.time))
        if (time - openedAt >= limits.maxSegmentAgeMs) reason = 'age'
      }
    }
    opens = tail.torn || reason !== null || lastRecord.type === 'warpline.audit.segment.sealed'

    if (opens) {
      whole ??= await readFile(activePath)
      const walked = stateOf(whole.toString('utf-8'), firstSeqOf(active))
      if ('refused' in walked) throw new AuditAppendError(kind, walked.refused)
      state = walked.state
    }
  }

  const sealed = reason === null ? null : encode(++seq, source, prev, 'segment.sealed', { reason, bytes: activeSize }, time)
  if (sealed !== null) prev = headOf(sealed)
  const fresh: Buffer[] = []
  if (opens) {
    // ponytail: internal lines are not held to MAX_LINE_BYTES. An opened line
    // carrying hundreds of open intents could outgrow the 64 KiB tail read, and
    // a crash right after it would leave a last line the tail read cannot find.
    // Reading further back when the window holds no line is the upgrade path.
    const opened = encode(
      ++seq,
      source,
      prev,
      'segment.opened',
      DATA['segment.opened'].parse({ home: source, version: packageVersion(), fragment, ...state }),
      time,
    )
    path = join(dir, segmentName(seq))
    prev = headOf(opened)
    fresh.push(opened)
    if (sealed !== null) {
      const openedSeq = seq
      const checkpoint = encode(++seq, source, prev, 'checkpoint.recorded', { origin: source, size: openedSeq, root: prev }, time)
      prev = headOf(checkpoint)
      fresh.push(checkpoint)
    }
  }
  const record = encode(seq + 1, source, prev, kind, dataAfter(seq, prev, source), time)
  seq += 1
  if (record.length > MAX_LINE_BYTES) throw new AuditAppendError(kind, 'line over 16384 bytes')

  if (sealed !== null) await writeLine(activePath, sealed)
  for (const [i, line] of fresh.entries()) {
    await writeLine(path, line)
    if (i === 0) await syncDir(dir)
  }
  await writeLine(path, record)
  return { seq, head: headOf(record) }
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

/** `fn` in the in-process queue, holding the audit lock. Any throw is an AuditAppendError. */
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
    const token = await acquire(lockPath, kind, opts.lockTimeoutMs ?? LOCK_TIMEOUT_MS)
    try {
      return await fn(dir, (opts.now ?? Date.now)(), {
        maxSegmentBytes: opts.maxSegmentBytes ?? SEGMENT_MAX_BYTES,
        maxSegmentAgeMs: opts.maxSegmentAgeMs ?? SEGMENT_MAX_AGE_MS,
      })
    } catch (err) {
      if (err instanceof AuditAppendError) throw err
      throw new AuditAppendError(kind, 'write failed', err)
    } finally {
      await release(lockPath, token)
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
  /** Summed size of every segment file. */
  bytes: number
  /** How many segment files there are. */
  segments: number
  /** The Checkpoint's seq. Equal to `seq` here, and named so a reader of the store finds it. */
  checkpoint_seq: number
  /** Every fire intent no outcome, refusal or resolution has closed. Surfaced, never held. */
  indeterminate: OpenIntent[]
}

/**
 * Append a Checkpoint covering everything before it, `{ origin, size, root }`:
 * the home id, the seq of the line before it and that line's hash. Called by an
 * advance that returns, once, before its dead-man file. Goes through the same
 * queue, lock and rotation check as `appendAudit`, so a rotation due now writes
 * its own Checkpoint first. Rejects with `AuditAppendError`.
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
    const segments = await listSegments(dir)
    let bytes = 0
    for (const name of segments) bytes += (await stat(join(dir, name))).size
    return { seq, bytes, segments: segments.length, checkpoint_seq: seq, indeterminate: await openIntentsIn(dir) }
  })
}

/**
 * The head: the last complete line's seq and the hash of its bytes, or seq 0
 * and the zero hash before the first record. A pure reader: no lock, no mkdir.
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
  const seq = line === null ? undefined : (JSON.parse(line.toString('utf-8')) as { warplineseq?: unknown }).warplineseq
  if (line === null || typeof seq !== 'number') {
    throw new Error('audit store: the active segment holds no readable last line')
  }
  return { seq, head: sha256(line) }
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
 * digest was added, removed or changed, and the new id-to-digest map. Neither
 * names an editor, which nothing here can know.
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
      data = { old: principals?.sha256 ?? null, new: now, changed_ids, editor: 'unknown', entries: after }
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

/** The home id: the `source` of the store's first line, or undefined with no store. */
async function genesisSource(dir: string): Promise<string | undefined> {
  const first = (await segmentsIn(dir))[0]
  if (first === undefined) return undefined
  const lines = scan(join(dir, first))
  try {
    const { value, done } = await lines.next()
    return done ? undefined : parseRecord(value.toString('utf-8'))?.source
  } finally {
    // Closes the file when the generator stopped at its first line.
    await lines.return(Buffer.alloc(0))
  }
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
 * Tampered is any broken link, seq or file name, a partial line anywhere but
 * the very end that no later `segment.opened` acknowledges, an anchor beyond
 * the head, or an anchored line whose hash is not the anchor's. Torn is a
 * partial line at the very end, an acknowledged fragment, or a last segment
 * whose last line is `segment.sealed`. Unreadable is a chain that checks clean
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

  for (const [i, name] of names.entries()) {
    if (name !== segmentName(seq + 1)) return tampered(`segment ${name} is not named by its first seq ${seq + 1}`)
    const lines = scan(join(dir, name))
    let n = 0
    let step = await lines.next()
    // An early return leaves the generator at a yield; this closes its file.
    try {
      for (; !step.done; step = await lines.next()) {
        const body = step.value.subarray(0, step.value.length - 1)
        const rec = parseRecord(body.toString('utf-8')) as (StoredRecord & { warplineprev?: unknown }) | undefined
        if (rec === undefined) return tampered(`seq ${seq + 1} is not a record`)
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
