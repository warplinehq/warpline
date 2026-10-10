/**
 * Whether a principal id is known: the one answer every verb that asks uses.
 *
 * An id is known when any of three sources names it:
 *
 *   1. `principals.json`, active or disabled;
 *   2. the audit store, on any line it holds: a principal record's id, the ids
 *      a hand edit changed, or the registry a `segment.opened` carries, so an id
 *      only an older segment named, or only a hand edit put in the file, counts;
 *   3. the standing grants file, as a grant's holder or its issuer.
 *
 * The third is why this is one answer. A standing grant held by an id reads
 * live again once that id is registered, so an id a grant names is in use even
 * when no record or registry says so, as in a home restored without `audit/`.
 *
 * It fails closed. A source that names the id settles it, whatever the others
 * hold. Otherwise any source that cannot be read makes the answer `cannot
 * tell`, and the caller decides by what it is about to do: `principal add`
 * widens authority and refuses, `revoke --holder` only narrows it.
 *
 * A pure reader: it records nothing, and the caller records a hand edit to
 * `principals.json` before asking. It lives with the verbs because it reads the
 * standing grants file through the gate, and the registry module imports
 * nothing from the runtime.
 */
import { readCompleteLines } from '../lib/audit-log.js'
import { engineStatePath } from '../lib/paths.js'
import { PRINCIPAL_ID, readRegistry } from '../lib/principals.js'
import { readStandingStore } from '../runtime/approval-gate.js'

/** A source the answer reads, named as an operator reads it. */
export type IdSource = 'principals.json' | 'the audit store' | 'the standing grants file'

export type Known =
  | { answer: 'known'; by: IdSource }
  | { answer: 'unknown' }
  | { answer: 'cannot tell'; unreadable: IdSource[] }

const PRINCIPAL_RECORDS = new Set([
  'warpline.audit.principal.added',
  'warpline.audit.principal.disabled',
  'warpline.audit.principal_registry.observed',
])

const keysOf = (v: unknown): string[] => (typeof v === 'object' && v !== null && !Array.isArray(v) ? Object.keys(v) : [])

/** Every id `principals.json` names, none when it is missing, or null when it cannot be read. */
async function registryIds(): Promise<Set<string> | null> {
  const loaded = await readRegistry()
  return 'refused' in loaded ? null : new Set(loaded.registry.principals.map((p) => p.id))
}

/**
 * Every principal id the audit store has named, from its first line on: on a
 * principal record, or in the registry a `segment.opened` carries. No store
 * names none. Rejects when the store cannot be read.
 */
async function auditIds(statePath: string): Promise<Set<string>> {
  const ids = new Set<string>()
  for await (const { record } of readCompleteLines(statePath, 0)) {
    if (record === undefined) continue
    let d = record.data
    if (record.type === 'warpline.audit.segment.opened') d = d?.authority?.principals
    else if (!PRINCIPAL_RECORDS.has(record.type)) continue
    if (typeof d !== 'object' || d === null) continue
    const named = [d.id, ...(Array.isArray(d.changed_ids) ? d.changed_ids : []), ...keysOf(d.entries), ...keysOf(d.changed_entries)]
    for (const id of named) if (typeof id === 'string') ids.add(id)
  }
  return ids
}

/** Every holder and issuer the standing grants file names, none when it is missing, or null when it cannot be read. */
async function standingIds(): Promise<Set<string> | null> {
  const read = await readStandingStore()
  return read.readable ? new Set(read.store.grants.flatMap((g) => [g.holder, g.issuer])) : null
}

const SOURCES: ReadonlyArray<readonly [IdSource, (statePath: string) => Promise<Set<string> | null>]> = [
  ['principals.json', registryIds],
  ['the audit store', auditIds],
  ['the standing grants file', standingIds],
]

/**
 * Whether any source names `id`. A string that is no principal id is unknown:
 * no source can hold one.
 */
export async function knownPrincipal(id: string, statePath: string = engineStatePath()): Promise<Known> {
  if (!PRINCIPAL_ID.test(id)) return { answer: 'unknown' }
  const unreadable: IdSource[] = []
  for (const [source, ids] of SOURCES) {
    let named: Set<string> | null
    try {
      named = await ids(statePath)
    } catch {
      named = null
    }
    if (named === null) unreadable.push(source)
    else if (named.has(id)) return { answer: 'known', by: source }
  }
  return unreadable.length > 0 ? { answer: 'cannot tell', unreadable } : { answer: 'unknown' }
}

/** `a`, `a and b`, `a, b and c`. */
export function listSources(sources: IdSource[]): string {
  return sources.length < 2 ? (sources[0] ?? '') : `${sources.slice(0, -1).join(', ')} and ${sources.at(-1)}`
}
