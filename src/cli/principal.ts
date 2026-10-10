/**
 * `warpline principal add | disable | list` — the registry of who may act, in
 * `<home>/principals.json`.
 *
 * Three rules hold every change:
 *
 *   1. Every change is on the record first. `principal.added` or
 *      `principal.disabled` is appended with the sha256 of the exact bytes
 *      about to be written and the changed entry's digest, then the file is written
 *      through fs-atomic at 0600. A failed append writes nothing. A key is
 *      recorded as its digest only.
 *   2. Ids are never deleted or reused. Disable is the only way out of the
 *      registry, and adding an id that exists, active or disabled, or that
 *      the audit store has ever named, is refused.
 *      Later records name principals by id, so an id that came back would make
 *      them name someone else.
 *   3. No principal is ever inferred from the account running the command. An
 *      id comes from the operator's argument and from nowhere else.
 *
 * Every read compares the file with the store before using it, so a hand edit
 * is recorded, with the ids it changed, before the verb acts on what it read.
 * Refusals about the file name key paths and schema facts, never a value from
 * it.
 *
 * Never terminates the process — it returns a code to the dispatcher.
 */
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { parseArgs } from 'node:util'
import { pathsForStateFile, withStateLockAt } from '../board/state-manager.js'
import { appendAudit, AuditAppendError } from '../lib/audit-log.js'
import { atomicWriteJson } from '../lib/fs-atomic.js'
import { engineStatePath, principalsPath } from '../lib/paths.js'
import { entryDigest, EntrySchema, idsEverRecorded, loadRegistry, PRINCIPAL_ID, type Entry, type Registry } from '../lib/principals.js'

export const USAGE = `Usage: warpline principal add <id> --type human|machine [--key <key>]
       warpline principal disable <id>
       warpline principal list

Registers who may act, by id, in principals.json. An id is 1 to 64 characters
of a-z, 0-9, '.', '_' and '-', starting with a letter or digit. It is never
removed or reused: disable is the only way out. Every add and disable is
recorded on the audit store before the file is written.
`

const AUDIT_FAILED = 'The audit store could not record this change. Nothing was written.\n'

/**
 * A hand edit is recorded as one `principal_registry.observed`, which names
 * every changed id, so an edit changing too many at once cannot fit one record.
 */
const EDIT_TOO_LARGE =
  'principals.json changed in more entries since the store last saw it than one audit record can name. ' +
  'Record it in parts: put part of the change back, run warpline principal list, then make the rest. ' +
  'Nothing was written.\n'

/** The refusal for an append that did not happen, naming the store's reason when it gave one. */
function auditFailed(err: unknown): string {
  return err instanceof AuditAppendError
    ? `The audit store could not record this change: ${err.reason}. Nothing was written.\n`
    : AUDIT_FAILED
}

const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex')

/**
 * The registry as the file holds it, after the store has seen the file. A
 * missing file is an empty registry. Returns a refusal message instead when
 * the file is unusable or the store could not record a change to it.
 */
async function load(): Promise<{ bytes: Buffer | null; registry: Registry } | string> {
  try {
    const loaded = await loadRegistry()
    return 'refused' in loaded ? `${loaded.refused}. Nothing was written.\n` : loaded
  } catch (err) {
    // The typed reason, so a reworded one fails typecheck here.
    if (err instanceof AuditAppendError && err.reason === 'line over 16384 bytes') return EDIT_TOO_LARGE
    return auditFailed(err)
  }
}

/** Write `next` at 0600 after its record. Returns the exit code. */
async function write(next: Registry, done: string): Promise<number> {
  try {
    await atomicWriteJson(principalsPath(), next, { mode: 0o600 })
  } catch {
    process.stderr.write(
      'principal: principals.json could not be written. The audit record names a change that did not ' +
        'happen, and the next read records the file as it is.\n',
    )
    return 1
  }
  process.stdout.write(done)
  return 0
}

async function add(rest: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    options: { type: { type: 'string' }, key: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  })
  const [id, ...extra] = positionals
  if (id === undefined || extra.length > 0 || values.type === undefined) {
    process.stderr.write(USAGE)
    return 1
  }
  if (!PRINCIPAL_ID.test(id)) {
    process.stderr.write(`principal add: that id is not allowed.\n\n${USAGE}`)
    return 1
  }
  if (values.type !== 'human' && values.type !== 'machine') {
    process.stderr.write(`principal add: --type is human or machine.\n\n${USAGE}`)
    return 1
  }
  const entry: Entry = { id, type: values.type, status: 'active' }
  if (values.key !== undefined) entry.key = values.key
  if (!EntrySchema.safeParse(entry).success) {
    process.stderr.write('principal add: a key is 1 to 8192 characters with no control character.\n')
    return 1
  }

  const loaded = await load()
  if (typeof loaded === 'string') {
    process.stderr.write(loaded)
    return 1
  }
  if (loaded.registry.principals.some((p) => p.id === id)) {
    process.stderr.write(`principal add: ${id} is already in the registry, and ids are never reused. Nothing was written.\n`)
    return 1
  }
  // An id gone from the file is still used: a standing grant it held would read live again.
  let used: Set<string>
  try {
    used = await idsEverRecorded()
  } catch {
    process.stderr.write('principal add: the audit store could not be read, so no id can be checked unused. Nothing was written.\n')
    return 1
  }
  if (used.has(id)) {
    process.stderr.write(`principal add: ${id} was registered before, and ids are never reused. Nothing was written.\n`)
    return 1
  }

  const next: Registry = { principals: [...loaded.registry.principals, entry] }
  // Exactly what atomicWriteJson writes.
  const bytes = JSON.stringify(next, null, 2)
  try {
    await appendAudit(engineStatePath(), 'principal.added', {
      id,
      type: entry.type,
      key_sha256: entry.key === undefined ? null : sha256(entry.key),
      sha256: sha256(bytes),
      entry_sha256: entryDigest(entry),
    })
  } catch (err) {
    process.stderr.write(auditFailed(err))
    return 1
  }
  return write(next, `Added ${id} (${entry.type}). The change is on the audit record.\n`)
}

async function disable(rest: string[]): Promise<number> {
  const { positionals } = parseArgs({ args: rest, options: {}, allowPositionals: true, strict: true })
  const [id, ...extra] = positionals
  if (id === undefined || extra.length > 0) {
    process.stderr.write(USAGE)
    return 1
  }

  const loaded = await load()
  if (typeof loaded === 'string') {
    process.stderr.write(loaded)
    return 1
  }
  const current = loaded.registry.principals.find((p) => p.id === id)
  if (current === undefined) {
    process.stderr.write('principal disable: no principal has that id. Nothing was written.\n')
    return 1
  }
  if (current.status === 'disabled') {
    process.stderr.write(`principal disable: ${id} is already disabled. Nothing was written.\n`)
    return 1
  }

  const disabled: Entry = { ...current, status: 'disabled' }
  const next: Registry = { principals: loaded.registry.principals.map((p) => (p.id === id ? disabled : p)) }
  const bytes = JSON.stringify(next, null, 2)
  try {
    await appendAudit(engineStatePath(), 'principal.disabled', { id, sha256: sha256(bytes), entry_sha256: entryDigest(disabled) })
  } catch (err) {
    process.stderr.write(auditFailed(err))
    return 1
  }
  return write(next, `Disabled ${id}. The change is on the audit record.\n`)
}

async function list(rest: string[]): Promise<number> {
  parseArgs({ args: rest, options: {}, allowPositionals: false, strict: true })
  const loaded = await load()
  if (typeof loaded === 'string') {
    process.stderr.write(loaded)
    return 1
  }
  let out = ''
  for (const p of loaded.registry.principals) {
    out += `${p.id}\t${p.type}\t${p.status}\t${p.key === undefined ? 'no key' : 'key'}\n`
  }
  if (out !== '') process.stdout.write(out)
  return 0
}

/**
 * Run a change under the state lock. The duplicate check, the record and the
 * write are one step, so two adds of one id cannot both pass the check, and
 * two adds of different ids cannot each write a registry missing the other.
 */
async function locked(fn: () => Promise<number>): Promise<number> {
  const { lockPath } = pathsForStateFile(engineStatePath())
  await mkdir(dirname(lockPath), { recursive: true })
  return await withStateLockAt(lockPath, fn)
}

export async function run(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv
  try {
    if (sub === 'add') return await locked(() => add(rest))
    if (sub === 'disable') return await locked(() => disable(rest))
    if (sub === 'list') return await list(rest)
  } catch (err) {
    // parseArgs refuses an unknown flag or a misplaced value.
    if (!(err instanceof TypeError) || !('code' in err) || !String(err.code).startsWith('ERR_PARSE_ARGS')) throw err
    process.stderr.write(`principal ${sub}: ${err.message}\n\n${USAGE}`)
    return 1
  }
  process.stderr.write(USAGE)
  return 1
}
