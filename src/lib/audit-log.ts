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
import { mkdir, open, readdir, readFile, stat } from 'node:fs/promises'
import { createReadStream, readFileSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs'
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
/** A standing grant id: 12 lowercase hex, the rule the gate's `newStandingId` makes. */
const GrantId = z.string().regex(/^[0-9a-f]{12}$/)
/**
 * One live grant that covered a fire. A session entry is one window and names
 * whoever last named its scope, or null; a standing entry always names the
 * human who issued it.
 */
const Covering = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('session'), scope: Scope, issuer: PrincipalId.nullable() }),
  z.strictObject({ kind: z.literal('standing'), id: GrantId, holder: PrincipalId, issuer: PrincipalId }),
])
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
  // A standing issue always has a named issuer, so its principal is never null.
  'grant.issued': z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('session'),
      scopes: z.array(Scope).min(1),
      ttl_ms: z.number().int().positive().nullable(),
      replace: z.boolean(),
      long: z.boolean(),
      principal: PrincipalId.nullable(),
    }),
    z.strictObject({
      kind: z.literal('standing'),
      id: GrantId,
      holder: PrincipalId,
      principal: PrincipalId,
      scopes: z.array(PluginName).min(1),
      period_ms: z.number().int().positive(),
      hard_max_ms: z.number().int().positive(),
    }),
  ]),
  'grant.renewed': z.strictObject({
    id: GrantId,
    holder: PrincipalId,
    principal: PrincipalId,
    renewal_deadline: Iso,
  }),
  // `principal` is always a checked id; a claim the registry could not
  // confirm is kept apart in `principal_unchecked`.
  'grant.revoked': z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('session'),
      scopes: z.array(Scope),
      principal: PrincipalId.nullable(),
      principal_unchecked: PrincipalId.nullable(),
    }),
    z.strictObject({
      kind: z.literal('standing'),
      ids: z.array(GrantId).min(1),
      holder: PrincipalId,
      scopes: z.array(PluginName).min(1),
      principal: PrincipalId.nullable(),
      principal_unchecked: PrincipalId.nullable(),
    }),
  ]),
  'content_approval.issued': z.strictObject({
    plugin: PluginName,
    producer: PluginName,
    fingerprint: Hex,
    run_id: RunId.nullable(),
    opens_at: Iso,
    closes_at: Iso,
    replaced_fingerprint: Hex.nullable(),
    principal: PrincipalId.nullable(),
  }),
  'content_approval.withdrawn': z.strictObject({
    plugin: PluginName,
    fingerprint: Hex.nullable(),
    principal: PrincipalId.nullable(),
  }),
  'denial.recorded': z.strictObject({
    plugin: PluginName,
    fingerprint: Hex,
    discarded_gate_run_id: RunId.nullable(),
    principal: PrincipalId.nullable(),
  }),
  'denial.lifted': z.strictObject({ plugin: PluginName, fingerprint: Hex.nullable(), principal: PrincipalId.nullable() }),
  'fire.intent': z.strictObject({
    plugin: PluginName,
    run_id: RunId,
    class: z.enum(['session', 'content']),
    effect_id: Hex.nullable(),
    fingerprint: Hex.nullable(),
    grants: z.array(Covering),
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
    principal: PrincipalId.nullable(),
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
  | WalkRefusal
  | 'unknown kind'
  | 'internal kind'
  | 'data rejected by its schema'
  | 'line over 16384 bytes'
  | 'audit lock not acquired'
  | `audit lock not acquired: making its symbolic link failed with ${'EPERM' | 'ENOTSUP' | 'ENOSYS'}; the filesystem under the home might not hold one (docs/runtime-spec.md § 14)`
  | 'audit lock not acquired in time'
  | 'audit lock not acquired in time: its holder is gone, and .lock.break exists; remove audit/.lock.break by hand only once no warpline process is running'
  | 'audit lock not acquired in time: its holder names no process; remove audit/.lock by hand only once no warpline process is running'
  | 'audit lock not acquired in time: its holder is gone, and the lock could not be removed; remove audit/.lock by hand'
  | `audit lock not acquired in time: pid ${number} on this machine holds it; remove audit/.lock by hand only once that process is gone`
  | `audit lock not acquired in time: pid ${number} holds it, not on this machine or on one that cannot be told; remove audit/.lock by hand only once that process is gone`
  | 'the active segment holds no readable last line'
  | `segment ${string} holds no complete line; move it aside by hand (docs/runtime-spec.md § 14)`
  | `segment ${string} holds no complete line, and this append does not open it`
  | 'write failed'
  | 'the store has no segment to pass over'
  | `seq ${number} is not a line the walk stops on in the active segment`
  | `seq ${number} opens the active segment and cannot be passed over`

/**
 * An append that did not happen. The message is built from the kind and a
 * fixed phrase only, never from the data, a schema issue or a path, because it
 * reaches stderr and from there the operator's mail. The one phrase that names
 * something names a segment file, whose name is only digits. A lock refusal
 * names a holder's pid, which is only digits too.
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

/** Each complete line of `bytes`, newline excluded. What follows the last newline is not a line. */
function linesOf(bytes: Buffer): Buffer[] {
  const lines: Buffer[] = []
  for (let at = 0, nl = bytes.indexOf(0x0a); nl !== -1; at = nl + 1, nl = bytes.indexOf(0x0a, at)) {
    lines.push(bytes.subarray(at, nl))
  }
  return lines
}

/**
 * A `passed_over` value as position to sha256, or null when it is not a list
 * of entries whose seqs rise. The one parse of that value.
 */
function passedOverEntries(named: unknown): ReadonlyMap<number, string> | null {
  const parsed = PassedOver.safeParse(named)
  if (!parsed.success) return null
  const entries = new Map<number, string>()
  let below = 0
  for (const { seq, sha256: hash } of parsed.data) {
    if (seq <= below) return null
    entries.set(seq, hash)
    below = seq
  }
  return entries
}

/**
 * Whether `entries` passes over the line at position `seq` whose bytes,
 * newline excluded, are `body`: only when an entry names that position and the
 * bytes hash to it under the byte rule. Verify, the reader and the walk's skip
 * all ask here, so no two of them can name a passed-over line differently.
 */
function isPassedOver(entries: ReadonlyMap<number, string>, seq: number, body: Buffer): boolean {
  const hash = entries.get(seq)
  return hash !== undefined && sha256(body) === hash
}

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

export type StoredRecord = { warplineseq: number; source: string; type: string; time?: unknown; data?: any }

/** A stored line's envelope, or undefined when it is not one of ours. */
export function parseRecord(line: string): StoredRecord | undefined {
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
 * passed over, so its refusal names no pass-over. A segment with no complete
 * line has no opening line, and its refusal names the file, whose name is only
 * digits, and no step. Only a writer holding the lock names a step for it.
 */
type WalkRefusal =
  | `seq ${number} is not a record${typeof PASS_IT_OVER}`
  | `seq ${number} opens the active segment and is not a segment.opened the walk can carry`
  | `seq ${number} holds ${ShortKind<CarriedType>} data the walk cannot carry${typeof PASS_IT_OVER}`
  | `segment ${string} holds no complete line`

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
 * reaches a reader's output. Only the complete lines of `bytes` are read, and
 * the first is at position `firstSeq`. A non-first line that `skip` names, by
 * position and the sha256 of its bytes, is passed over unread. With no complete
 * line there is nothing to start from, and the refusal names the segment and
 * no step. Only a writer holding the lock names one.
 */
function stateOf(bytes: Buffer, firstSeq: number, skip: ReadonlyMap<number, string> = new Map()): Walked {
  let opened: Carried | undefined
  const carried: CarriedLine[] = []
  for (const [i, body] of linesOf(bytes).entries()) {
    const seq = firstSeq + i
    const line = body.toString('utf-8')
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
    if (isPassedOver(skip, seq, body)) continue
    const step = walkLine(line, seq)
    if ('refused' in step) return step
    if (step.carried !== null) carried.push(step.carried)
  }
  if (opened === undefined) {
    return { refused: `segment ${segmentName(firstSeq)} holds no complete line` }
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
 * that joined by `:` to the pid namespace (`/proc/self/ns/pid`), then by `:`
 * to the boot id (`/proc/sys/kernel/random/boot_id`). Null when any part
 * cannot be had, or the boot id is empty. Memoized, because a process never
 * changes machine, pid namespace or boot.
 *
 * The namespace keeps containers that share `/etc/machine-id` apart. The boot
 * id keeps cloned machines apart, since they share a machine id and the root
 * namespace inode. It also keeps a pid from before a reboot from being tested
 * after it. A mismatch reads as another machine, so the lock is kept.
 * On Linux, a lock left by a crash just before a reboot therefore needs
 * removal by hand. Elsewhere the host outlives a reboot, so a pid from before
 * it is tested after it: a free one is broken, and a reused one reads alive,
 * as the note below says.
 *
 * ponytail: a dead holder whose pid is reused reads alive, and fails closed.
 * A process start time in the identity is the upgrade path: Linux
 * `/proc/PID/stat` field 22, and on macOS a `ps` spawn.
 */
function ourHost(): string | null {
  if (ourHostMemo === undefined) {
    let value = deriveHost()
    if (value !== null && process.platform === 'linux') {
      try {
        const ns = readlinkSync('/proc/self/ns/pid')
        const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf-8').trim()
        value = boot === '' ? null : `${value}:${ns}:${boot}`
      } catch {
        value = null
      }
    }
    ourHostMemo = { value }
  }
  return ourHostMemo.value
}

/**
 * Make `path` a symbolic link whose text names its holder:
 * `{ token, pid, host, at }`. True when made, false when something is already
 * at the path, and any other error is thrown.
 *
 * One call makes the entry and its text together, so a lock or break file is
 * never empty or half-written (atomic even over NFS, per Mercurial). It is
 * synchronous, so `held` is set in the same stretch. The text stays far below
 * any link-length limit.
 */
function take(path: string, token: string): boolean {
  try {
    symlinkSync(JSON.stringify({ token, pid: process.pid, host: ourHost(), at: Date.now() }), path)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw err
  }
}

/** A lock or break file as this writer can judge it. */
type Holder = { token: string | null; pid: number | null; here: boolean; gone: boolean }

/**
 * Who holds the lock or break file at `path`, as far as this writer can tell.
 * Null only when nothing is there.
 *
 * Anything that is not a link whose text parses to an object (a directory, a
 * plain file, any other text) names no holder: no token, no pid, not here, not
 * gone. Otherwise `token` is its string token and `pid` its positive process
 * id, each null when it names none. `here` is true when it names a host equal
 * to this writer's known one. `gone` is true only when it names a token, a pid
 * and this machine, and no such process runs.
 *
 * It reads no time, and a holder it cannot name is never gone.
 */
function holderOf(path: string): Holder | null {
  let named: { token?: unknown; pid?: unknown; host?: unknown }
  try {
    const parsed: unknown = JSON.parse(readlinkSync(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return { token: null, pid: null, here: false, gone: false }
    named = parsed
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    return { token: null, pid: null, here: false, gone: false }
  }
  const token = typeof named.token === 'string' ? named.token : null
  const pid = typeof named.pid === 'number' && Number.isSafeInteger(named.pid) && named.pid > 0 ? named.pid : null
  const host = ourHost()
  const here = host !== null && typeof named.host === 'string' && named.host === host
  return { token, pid, here, gone: token !== null && pid !== null && here && !isProcessAlive(pid) }
}

/**
 * Remove a lock whose holder is gone, one writer at a time, and only the lock
 * that was judged.
 *
 * It makes `.lock.break` the way a lock is made. When something is already
 * there it stops: no branch removes or clears a break file this writer did not
 * make. Under its own break file it reads the lock again and judges it again,
 * and removes it only while it still names `token` and its holder is still
 * gone. Then it removes its own break file. Its outcomes:
 *
 * - 'removed': the judged lock is gone, removed here or already.
 * - 'changed': the lock is no longer the one judged (gone, another token, or a
 *   holder that no longer reads as gone), and the caller judges it again at once.
 * - 'kept': the removal itself failed for the judged token: making the break
 *   file threw, or removing the lock threw.
 * - 'break file held': something is already at `.lock.break`.
 *
 * The second judgment is mandatory (Mercurial; GnuPG T5884 is the bug without
 * it). The break runs with no await, and a gone holder cannot release, so the
 * lock cannot change between the second judgment and the removal (review
 * WR-04). The bare break-file removal is safe because no other writer removes
 * or replaces a break file, and nothing awaits between making and removing it
 * (review IN-01 and WR-02), short of a removal by hand inside that window,
 * which § 14 Writing names.
 */
function breakStale(dir: string, lockPath: string, token: string): 'removed' | 'kept' | 'changed' | 'break file held' {
  const breakPath = join(dir, '.lock.break')
  try {
    if (!take(breakPath, randomUUID())) return 'break file held'
  } catch {
    return 'kept'
  }
  try {
    const now = holderOf(lockPath)
    if (now === null || now.token !== token || !now.gone) return 'changed'
    unlinkSync(lockPath)
    return 'removed'
  } catch (err) {
    // A lock already gone is as good as removed.
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'removed' : 'kept'
  } finally {
    try {
      unlinkSync(breakPath)
    } catch {}
  }
}

/**
 * Why a wait for the lock ended without it, built from the lock as it stands
 * when the wait ends: `now` is the lock read then, `breakHere` whether
 * something is at `.lock.break` then, and `notRemoved` the token whose removal
 * this pass saw fail. The one removal by hand with no condition is for a gone
 * holder whose removal of that same token failed in this pass. The holder's pid
 * reaches the message only after it parsed as a positive safe integer, so only
 * digits do.
 */
function lockRefusal(now: Holder | null, breakHere: boolean, notRemoved: string | null): Reason {
  if (now === null) return 'audit lock not acquired in time'
  if (now.gone && breakHere) {
    return 'audit lock not acquired in time: its holder is gone, and .lock.break exists; remove audit/.lock.break by hand only once no warpline process is running'
  }
  if (now.gone && notRemoved !== null && now.token === notRemoved) {
    return 'audit lock not acquired in time: its holder is gone, and the lock could not be removed; remove audit/.lock by hand'
  }
  if (now.pid === null) {
    return 'audit lock not acquired in time: its holder names no process; remove audit/.lock by hand only once no warpline process is running'
  }
  if (now.here) {
    return `audit lock not acquired in time: pid ${now.pid} on this machine holds it; remove audit/.lock by hand only once that process is gone`
  }
  return `audit lock not acquired in time: pid ${now.pid} holds it, not on this machine or on one that cannot be told; remove audit/.lock by hand only once that process is gone`
}

/**
 * Take the audit lock, waiting up to `timeoutMs`. The lock names its holder,
 * and is recorded in `held` in the same synchronous stretch that took it, so
 * the exit hook below can see it. A lock whose holder is provably gone on this
 * machine is broken through the break file. No lock is broken for its age.
 *
 * ponytail: a hung live holder blocks every append until it is killed, as the
 * run lock's does. A holder misjudged gone, through an identity two machines
 * share that the boot id does not tell apart, can fork the chain. A fence the
 * store checks at write time is the upgrade path.
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
      // What a mount without symbolic links answers, among other causes, so
      // the refusal names the code and the likely cause and asserts neither.
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EPERM' || code === 'ENOTSUP' || code === 'ENOSYS') {
        throw new AuditAppendError(
          kind,
          `audit lock not acquired: making its symbolic link failed with ${code}; the filesystem under the home might not hold one (docs/runtime-spec.md § 14)`,
          err,
        )
      }
      throw new AuditAppendError(kind, 'audit lock not acquired', err)
    }
    // The token whose removal this pass saw fail, if any.
    let notRemoved: string | null = null
    const seen = holderOf(lockPath)
    if (seen?.gone && seen.token !== null) {
      const broken = breakStale(dir, lockPath, seen.token)
      if (broken === 'removed' || broken === 'changed') continue
      if (broken === 'kept') notRemoved = seen.token
    }
    // The lock and the break file are read again here, so the reason never describes an earlier look.
    if (Date.now() >= deadline) {
      throw new AuditAppendError(kind, lockRefusal(holderOf(lockPath), holderOf(join(dir, '.lock.break')) !== null, notRemoved))
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
    const named = JSON.parse(readlinkSync(path, 'utf8')) as { token?: unknown } | null
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
 * as it stands. Each named seq must be the position of a line of the active
 * segment, not its first, that the walk stops on. The walk passes over exactly
 * those lines, the opened line names each by position and the hash of its
 * bytes, and no record is written (`dataAfter` is null). A pass-over opens at
 * the position after the active segment's last record, whatever seq that
 * record claims. When the active segment ends in lines that are not records,
 * that is the last record before them, and no seal is written.
 * Without `passing`, such a last line refuses every append.
 *
 * A newest segment that is empty never got its opening line. It is taken out
 * of the list before anything is derived, and everything is derived as the
 * writer that created it would have, which decided no seal. The write goes
 * into it, through the same `writeLine`, only when it opens a segment of that
 * name. Otherwise nothing is written, and the
 * refusal is the walk's own over the segment before when the walk stops there,
 * or else names the file and no step. A newest segment holding only a partial
 * line refuses every append and pass-over, naming the file and the move aside.
 * That refusal is given only here, under the lock, and nothing here moves the
 * file. The refusal for a last line that is not a record is the walk's own over
 * the active segment, so the next step it names is the one every reader of the
 * walk names.
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
  // A newest segment left empty never got its opening line, so it is not yet opened.
  const tip = segments.at(-1)
  const unopened = tip !== undefined && (await stat(join(dir, tip))).size === 0 ? segments.pop() : undefined
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
      // With no complete line there is no fragment to acknowledge: the refusal below names the file.
      if (end !== -1) {
        const tornBytes = bytes.subarray(end + 1)
        fragment = { bytes: tornBytes.length, sha256: sha256(tornBytes) }
        whole = bytes.subarray(0, end + 1)
        last = whole.subarray(whole.lastIndexOf(0x0a, end - 1) + 1, end)
      }
    }
    let lastRecord = last === null ? undefined : parseRecord(last.toString('utf-8'))
    // The complete lines, as bytes, for a pass-over: each named one is hashed as written.
    let lines: Buffer[] = []
    // The index in `lines` of the line `last` names, for a pass-over.
    let lastAt = -1
    // Whether a pass-over stepped back over trailing lines that are not records.
    let stepped = false
    if (passing !== undefined && last !== null) {
      whole ??= await readFile(activePath)
      lines = linesOf(whole)
      lastAt = lines.length - 1
      // A pass-over opens after the last record before them, so each still
      // ends its segment and the next segment.opened can name it.
      if (lastRecord === undefined) {
        let k = lines.length - 1
        for (; k >= 0 && lastRecord === undefined; k -= 1) lastRecord = parseRecord((lines[k] as Buffer).toString('utf-8'))
        if (lastRecord === undefined) {
          throw new AuditAppendError(kind, `seq ${firstSeqOf(active)} opens the active segment and is not a segment.opened the walk can carry`)
        }
        lastAt = k + 1
        last = lines[lastAt] as Buffer
        stepped = true
      }
    }
    // Every writer refuses this shape, so the step stays true however late it is read.
    if (last === null) {
      throw new AuditAppendError(kind, `segment ${active} holds no complete line; move it aside by hand (docs/runtime-spec.md § 14)`)
    }
    // A last line that is not a record: the walk's own refusal names the next step.
    if (lastRecord === undefined) {
      const walked = await activeState(dir)
      throw new AuditAppendError(kind, 'refused' in walked ? walked.refused : 'the active segment holds no readable last line')
    }
    // A pass-over counts position, so a seq the last record claims is never
    // carried forward. An ordinary append takes the tail's claim.
    seq = passing === undefined ? lastRecord.warplineseq : firstSeqOf(active) + lastAt
    source = lastRecord.source
    prev = sha256(last)

    // Nothing is sealed past a line that is not a record, which would then no longer end its segment.
    // The writer that left the empty file did not seal, or the segment before would end in segment.sealed.
    if (unopened === undefined && !tail.torn && !stepped && lastRecord.type !== 'warpline.audit.segment.sealed') {
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
      const walked = stateOf(whole, firstSeqOf(active), new Map((passed ?? []).map((e) => [e.seq, e.sha256])))
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
  // The empty file is written into only when this write opens a segment of its name.
  if (unopened !== undefined && path !== join(dir, unopened)) {
    const walked = await activeState(dir)
    throw new AuditAppendError(
      kind,
      'refused' in walked ? walked.refused : `segment ${unopened} holds no complete line, and this append does not open it`,
    )
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
 * A newest segment that holds no complete line is read as not yet written, so
 * the head is the last line before it, and seq 0 when there is none. Rejects
 * with an Error named `AuditHeadUnreadableError` only when the last complete
 * line is not a record. Its own `reason` is the walk's refusal over the active
 * segment, which names the next step, the same words an append gives.
 */
export async function readHead(statePath: string): Promise<{ seq: number; head: string }> {
  const dir = auditDirFor(statePath)
  const segments = await writtenSegments(dir)
  if (segments.length === 0) return { seq: 0, head: ZERO_HASH }
  const { line } = await lastLine(join(dir, segments[segments.length - 1] as string))
  const rec = line === null ? undefined : parseRecord(line.toString('utf-8'))
  if (line === null || rec === undefined) {
    const walked = await activeState(dir)
    const reason = 'refused' in walked ? walked.refused : 'the active segment holds no readable last line'
    const err = Object.assign(new Error(`audit store: there is no head to print: ${reason}`), { reason })
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
 * The segment names a reader reads: every one, less a newest one that holds no
 * complete line. A writer makes that shape on every segment it opens, between
 * creating the file and writing its first line, so a reader reads the store as
 * ending before it.
 */
async function writtenSegments(dir: string): Promise<string[]> {
  const names = await segmentsIn(dir)
  const newest = names.at(-1)
  if (newest !== undefined && (await lastLine(join(dir, newest))).line === null) names.pop()
  return names
}

/**
 * The state the active segment's complete lines walk to, the empty state with
 * no store, or the walk's refusal. The active segment is the newest one a
 * reader reads.
 */
async function activeState(dir: string): Promise<Walked> {
  const active = (await writtenSegments(dir)).at(-1)
  if (active === undefined) return { state: EMPTY_STATE }
  const bytes = await readFile(join(dir, active))
  return stateOf(bytes.subarray(0, bytes.lastIndexOf(0x0a) + 1), firstSeqOf(active))
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
 * One complete line as the store holds it. `seq` is its position: the seq its
 * segment is named for plus the lines before it in that file. `line` is its
 * bytes, newline included. `record` is what `parseRecord` reads from it.
 * `passedOver` is true only when the next segment's opening line names that
 * position in `passed_over` and the line's bytes still hash as named.
 */
export type StoredLine = { seq: number; line: Buffer; record: StoredRecord | undefined; passedOver: boolean }

/**
 * Every complete line whose position is after `afterSeq`, segment by segment
 * in name order, a chunk at a time. This is the one positional reader. A seq
 * here is a line's position, never the `warplineseq` the line claims, which
 * verify checks. Whether a line is passed over is decided by `isPassedOver`,
 * the rule verify and the walk use. A pure reader: no lock, no mkdir. A
 * partial line is never yielded; the next segment's `segment.opened`
 * acknowledges it. No store yields nothing.
 */
export async function* readCompleteLines(statePath: string, afterSeq: number): AsyncGenerator<StoredLine> {
  const dir = auditDirFor(statePath)
  const names = await segmentsIn(dir)
  // The last file that starts at or before the first line wanted.
  let from = 0
  for (const [i, name] of names.entries()) if (firstSeqOf(name) <= afterSeq + 1) from = i
  for (const [i, name] of names.entries()) {
    if (i < from) continue
    const next = names[i + 1]
    const opening = next === undefined ? undefined : await firstLine(join(dir, next))
    const named: unknown = opening === undefined ? undefined : parseRecord(opening.toString('utf-8'))?.data?.passed_over
    const entries = (named === undefined ? null : passedOverEntries(named)) ?? new Map<number, string>()
    let seq = firstSeqOf(name) - 1
    for await (const line of scan(join(dir, name))) {
      seq += 1
      if (seq <= afterSeq) continue
      const body = line.subarray(0, line.length - 1)
      yield { seq, line, record: parseRecord(body.toString('utf-8')), passedOver: isPassedOver(entries, seq, body) }
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
 * Whether a `passed_over` names, in rising seq order, only positions of lines
 * of the segment `prevName`, each hashing as recorded under the byte rule.
 * Resolves the positions it matched when every entry holds. Otherwise resolves
 * the failing entry's seq: the first, in scan order, whose line hashes to
 * something else, or the smallest left unmatched once the segment ends. The
 * seq is null when the list as a whole fails: it is not a list of entries, its
 * seqs do not rise, or there is no segment before. Reads that segment only
 * when called, so a store with no pass-over pays nothing.
 */
async function passedOverHolds(
  dir: string,
  prevName: string | undefined,
  named: unknown,
): Promise<ReadonlySet<number> | { seq: number | null }> {
  const entries = passedOverEntries(named)
  if (entries === null || prevName === undefined) return { seq: null }
  const matched = new Set<number>()
  let seq = firstSeqOf(prevName) - 1
  for await (const line of scan(join(dir, prevName))) {
    seq += 1
    if (!entries.has(seq)) continue
    if (!isPassedOver(entries, seq, line.subarray(0, line.length - 1))) return { seq }
    matched.add(seq)
  }
  // The entries rise, so the first left is the smallest.
  const left = [...entries.keys()].find((s) => !matched.has(s))
  return left === undefined ? matched : { seq: left }
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
 * `passed_over` by position (such a line moves no seq or link, and is never
 * the line an anchor is compared with; a next segment holding no record names
 * nothing), a record whose `warplineseq` is not its position, a
 * partial line anywhere but the very end that no
 * later `segment.opened` acknowledges, a `passed_over` entry that does not
 * match the segment before it, an anchor beyond the head, or an anchored line
 * whose hash is not the anchor's. Torn is a partial line at the very end, an
 * acknowledged fragment, a newest segment that holds no complete line, or a
 * last segment whose last line is `segment.sealed`. Unreadable is a chain that
 * checks clean or torn whose active segment holds a line the walk cannot
 * carry, so the open intents cannot be listed. The open intents are read as if
 * a newest segment that holds no complete line were absent. A
 * re-linked rewrite passes every link, so the
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
          const holds = named === undefined ? new Set<number>() : await passedOverHolds(dir, names[i - 1], named)
          if ('seq' in holds) {
            return tampered(
              holds.seq === null
                ? `seq ${seq + 1}'s passed_over does not match the segment before it`
                : `seq ${seq + 1}'s passed_over entry for seq ${holds.seq} does not match the segment before it`,
            )
          }
          // A line is named by its position and its bytes: each carried line
          // must be one passedOverHolds matched.
          const unnamed = carried.find((c) => !holds.has(c))
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
  // A trailing line that is not a record, whose next segment never got a record, was named by nothing.
  if (carried.length > 0) return tampered(`seq ${carried[0]} is not a record`)
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
