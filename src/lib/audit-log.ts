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
import { readFileSync } from 'node:fs'
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
  | 'unknown kind'
  | 'internal kind'
  | 'data rejected by its schema'
  | 'line over 16384 bytes'
  | 'audit lock not acquired'
  | 'audit lock not acquired in time'
  | 'the active segment ends in a partial line'
  | 'the active segment holds no readable last line'
  | 'write failed'

/**
 * An append that did not happen. The message is built from the kind and a
 * fixed phrase only, never from the data, a schema issue or a path, because it
 * reaches stderr and from there the operator's mail.
 */
export class AuditAppendError extends Error {
  constructor(kind: string, reason: Reason, cause?: unknown) {
    super(`audit store: could not append ${kind}: ${reason}`, cause === undefined ? undefined : { cause })
    this.name = 'AuditAppendError'
  }
}

// -- Paths and lines ---------------------------------------------------------

/** `<home>/audit`, from the state file's grandparent. Never exported. */
function auditDirFor(statePath: string): string {
  return join(dirname(dirname(statePath)), AUDIT_DIR_NAME)
}

const segmentName = (firstSeq: number): string => `${String(firstSeq).padStart(16, '0')}.jsonl`

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

/**
 * The last complete line of a segment, read from its last `TAIL_BYTES`, and
 * whether the segment ends in a partial line. `line` is null when the window
 * holds no complete line.
 */
async function lastLine(path: string): Promise<{ line: Buffer | null; torn: boolean }> {
  const { size } = await stat(path)
  const start = Math.max(0, size - TAIL_BYTES)
  const buf = Buffer.alloc(size - start)
  const fh = await open(path, 'r')
  try {
    await fh.read(buf, 0, buf.length, start)
  } finally {
    await fh.close()
  }
  const torn = buf.length > 0 && buf[buf.length - 1] !== 0x0a
  const end = buf.lastIndexOf(0x0a)
  if (end === -1) return { line: null, torn }
  const from = buf.lastIndexOf(0x0a, end - 1) + 1
  if (from === 0 && start > 0) return { line: null, torn }
  return { line: buf.subarray(from, end), torn }
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

async function appendLocked(dir: string, kind: EmitKind, data: unknown, time: number): Promise<{ seq: number; head: string }> {
  const segments = await listSegments(dir)
  let path: string
  let seq: number
  let source: string
  let prev: string
  let genesis: Buffer | null = null

  if (segments.length === 0) {
    // Genesis: the first segment opens with seq 1 and a zero prev.
    path = join(dir, segmentName(1))
    source = `urn:uuid:${randomUUID()}`
    genesis = encode(
      1,
      source,
      ZERO_HASH,
      'segment.opened',
      DATA['segment.opened'].parse({
        home: source,
        version: packageVersion(),
        fragment: null,
        authority: { preferences: null, principals: null },
        open_intents: [],
      }),
      time,
    )
    seq = 1
    prev = headOf(genesis)
  } else {
    path = join(dir, segments[segments.length - 1] as string)
    const { line, torn } = await lastLine(path)
    if (torn) throw new AuditAppendError(kind, 'the active segment ends in a partial line')
    let last: { warplineseq?: unknown; source?: unknown } | undefined
    try {
      last = line === null ? undefined : JSON.parse(line.toString('utf-8'))
    } catch {}
    if (line === null || !Seq.safeParse(last?.warplineseq).success || typeof last?.source !== 'string') {
      throw new AuditAppendError(kind, 'the active segment holds no readable last line')
    }
    seq = last.warplineseq as number
    source = last.source
    prev = sha256(line)
  }

  const record = encode(seq + 1, source, prev, kind, data, time)
  if (record.length > MAX_LINE_BYTES) throw new AuditAppendError(kind, 'line over 16384 bytes')

  if (genesis !== null) {
    await writeLine(path, genesis)
    await syncDir(dir)
  }
  await writeLine(path, record)
  return { seq: seq + 1, head: headOf(record) }
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
  opts: { lockTimeoutMs?: number; now?: () => number } = {},
): Promise<{ seq: number; head: string }> {
  if (!(AUDIT_KINDS as readonly string[]).includes(kind)) {
    return Promise.reject(new AuditAppendError('(unlisted)', 'unknown kind'))
  }
  if ((INTERNAL_KINDS as readonly string[]).includes(kind)) {
    return Promise.reject(new AuditAppendError(kind, 'internal kind'))
  }
  const parsed = DATA[kind].safeParse(data)
  if (!parsed.success) return Promise.reject(new AuditAppendError(kind, 'data rejected by its schema'))

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
      return await appendLocked(dir, kind, parsed.data, (opts.now ?? Date.now)())
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
