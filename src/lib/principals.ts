/**
 * principals — the one registry module. It holds the schema of
 * `<home>/principals.json`, the entry digests the audit store records, the
 * two reads, and the one check of who may act.
 *
 * An id comes from an operator's argument and from nowhere else. Nothing here
 * reads the environment or the account running the command, so an absent flag
 * resolves no principal at all, never a guessed one.
 *
 * Every read that will act on the registry compares the file with the store
 * first (`loadRegistry`), so a hand edit is recorded, with the ids it changed,
 * before anything uses what was read. `readRegistry` is for readers that write
 * nothing, and it never touches the store.
 *
 * Refusal phrases name key paths and schema facts, never a value from the
 * file. A principal's key is never in a phrase or in the view the gate takes.
 *
 * It imports nothing from the runtime or the board.
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { AuditAppendError, observeAuthorityFile } from './audit-log.js'
import { engineStatePath, principalsPath } from './paths.js'

export const PRINCIPAL_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/

export const EntrySchema = z.strictObject({
  id: z.string().regex(PRINCIPAL_ID),
  type: z.enum(['human', 'machine']),
  status: z.enum(['active', 'disabled']),
  key: z
    .string()
    .regex(/^[^\x00-\x1f\x7f]*$/)
    .min(1)
    .max(8192)
    .optional(),
})

export const RegistrySchema = z
  .strictObject({ principals: z.array(EntrySchema) })
  .superRefine((registry, ctx) => {
    const seen = new Set<string>()
    registry.principals.forEach((entry, i) => {
      if (seen.has(entry.id)) ctx.addIssue({ code: 'custom', path: ['principals', i, 'id'], message: 'a duplicate id' })
      seen.add(entry.id)
    })
  })

export type Entry = z.infer<typeof EntrySchema>
export type Registry = z.infer<typeof RegistrySchema>

/** Each id's type and status, and nothing else. Structurally the gate's `RegistrySnapshot`. */
export type RegistryView = ReadonlyMap<string, { type: 'human' | 'machine'; status: 'active' | 'disabled' }>

/** Who `--principal` or `--holder` may name, per verb. */
export type PrincipalRule = 'active' | 'active-human' | 'active-machine' | 'registered'

export type PrincipalRefusalCause = 'empty' | 'unknown' | 'disabled' | 'not human' | 'not machine' | 'registry' | 'audit'

type Loaded = { bytes: Buffer | null; registry: Registry }

const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex')

/** One entry's digest: `{ id, type, status }` plus `key` when set, in that order. */
export function entryDigest(entry: Entry): string {
  const shape: Record<string, string> = { id: entry.id, type: entry.type, status: entry.status }
  if (entry.key !== undefined) shape.key = entry.key
  return sha256(JSON.stringify(shape))
}

/** Each id mapped to its entry digest. */
export function registryEntries(registry: Registry): Record<string, string> {
  const out: Record<string, string> = {}
  for (const entry of registry.principals) out[entry.id] = entryDigest(entry)
  return out
}

/** Each id mapped to its type and status. A key never enters the view. */
export function registryView(registry: Registry): RegistryView {
  return new Map(registry.principals.map((p) => [p.id, { type: p.type, status: p.status }]))
}

/**
 * The registry a standing grant's holder is judged by, or null when there is
 * none to judge by: an unusable file, or a missing one. A missing file says
 * nothing about any holder, and putting it back clears the lapse, so it reads
 * `registry unreadable`, never a holder gone for good.
 */
export function standingRegistry(loaded: Loaded | { refused: string }): RegistryView | null {
  return 'refused' in loaded || loaded.bytes === null ? null : registryView(loaded.registry)
}

/** The file's bytes, null when it is missing, or a refusal when it cannot be read. */
async function readFileOrNull(): Promise<Buffer | null | { refused: string }> {
  try {
    return await readFile(principalsPath())
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    return { refused: 'principals.json could not be read' }
  }
}

/** The registry the bytes hold. Null bytes are an empty registry. */
function parse(bytes: Buffer | null): Loaded | { refused: string } {
  if (bytes === null) return { bytes, registry: { principals: [] } }
  let json: unknown
  try {
    json = JSON.parse(bytes.toString('utf-8'))
  } catch {
    return { refused: 'principals.json is not JSON' }
  }
  const parsed = RegistrySchema.safeParse(json)
  if (!parsed.success) {
    const where = new Set(
      parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || '(top level)'} (${issue.code === 'custom' ? issue.message : issue.code})`,
      ),
    )
    return { refused: `principals.json is not a usable registry: ${[...where].join(', ')}` }
  }
  return { bytes, registry: parsed.data }
}

/** The registry as the file holds it, for a reader that writes nothing. Never observes. */
export async function readRegistry(): Promise<Loaded | { refused: string }> {
  const bytes = await readFileOrNull()
  if (bytes !== null && 'refused' in bytes) return bytes
  return parse(bytes)
}

/**
 * The registry as the file holds it, after the store has seen the file. A
 * changed file is recorded as `principal_registry.observed` before this
 * resolves. Rejects with the store's `AuditAppendError` when that record
 * cannot be written, and the caller must then not use the registry.
 */
export async function loadRegistry(statePath: string = engineStatePath()): Promise<Loaded | { refused: string }> {
  const loaded = await readRegistry()
  if ('refused' in loaded) return loaded
  const { bytes, registry } = loaded
  await observeAuthorityFile(statePath, 'principal_registry.observed', bytes, registryEntries(registry))
  return loaded
}

/**
 * Whether `flag` names a principal `rule` admits. An absent flag resolves no
 * principal and reads nothing. Ids match byte for byte. An admitted id comes
 * with the registry the check recorded, so a caller that judges anything else
 * by the registry uses that read, never a second one a hand edit could land
 * between.
 */
export async function requirePrincipal(
  flag: string | undefined,
  rule: PrincipalRule,
  statePath: string = engineStatePath(),
): Promise<{ id: null } | { id: string; loaded: Loaded } | { refused: string; cause: PrincipalRefusalCause }> {
  if (flag === undefined) return { id: null }
  if (flag === '') return { refused: 'an empty id names no principal', cause: 'empty' }

  let loaded: Loaded | { refused: string }
  try {
    loaded = await loadRegistry(statePath)
  } catch (err) {
    const phrase = 'the audit store could not record a change to principals.json'
    return { refused: err instanceof AuditAppendError ? `${phrase}: ${err.reason}` : phrase, cause: 'audit' }
  }
  if ('refused' in loaded) return { refused: loaded.refused, cause: 'registry' }

  const entry = loaded.registry.principals.find((p) => p.id === flag)
  if (entry === undefined) return { refused: 'no principal has that id', cause: 'unknown' }
  if (rule === 'active-human' && entry.type !== 'human') {
    return { refused: 'that principal is not a human', cause: 'not human' }
  }
  if (rule === 'active-machine' && entry.type !== 'machine') {
    return { refused: 'that principal is not a machine', cause: 'not machine' }
  }
  if (rule !== 'registered' && entry.status === 'disabled') {
    return { refused: 'that principal is disabled', cause: 'disabled' }
  }
  return { id: entry.id, loaded }
}
