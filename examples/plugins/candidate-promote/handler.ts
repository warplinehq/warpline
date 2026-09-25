import { join } from 'node:path'
import type { PluginManifest } from 'warpline/schemas/plugin-manifest'
import { warplineHome } from 'warpline/lib/paths'
import type { CapabilityHandlerFn } from 'warpline/unstable-capabilities'
import { atomicWriteJson, readJsonOrNull } from 'warpline/unstable-fs'
import { skillFailure, skillOk } from 'warpline/unstable-result'

/**
 * The Output `candidate-propose` last produced, the bytes an operator approved:
 * { "candidates": [{ "id": "cand-10", "title": "Example candidate 10", "score": 10 }] }
 *
 * The file this plugin appends to, at input `promoted_path`:
 * { "promoted": [{ "id": "cand-10", "title": "Example candidate 10", "score": 10 }] }
 */
export interface Candidate {
  id: string
  title: string
  score: number
}

/** The same field rules `candidate-propose` applies to its pool. */
function isCandidate(v: unknown): v is Candidate {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const c = v as Record<string, unknown>
  return typeof c.id === 'string' && c.id !== ''
    && typeof c.title === 'string'
    && typeof c.score === 'number' && Number.isFinite(c.score)
}

/** What an existing promoted file must hold before it is rewritten: entries with a string id. */
function isPromotedFile(v: unknown): v is { promoted: { id: string }[] } {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const list = (v as { promoted?: unknown }).promoted
  return Array.isArray(list) && list.every((e) =>
    typeof e === 'object' && e !== null && !Array.isArray(e) && typeof (e as { id?: unknown }).id === 'string')
}

/**
 * A path under the home and nowhere else: no leading separator, no drive
 * letter, no `..` segment.
 */
export function isUnderHome(rel: string): boolean {
  if (rel === '' || /^[\\/]/.test(rel) || /^[A-Za-z]:/.test(rel)) return false
  return !rel.split(/[\\/]/).includes('..')
}

/**
 * A configured value, or the manifest's own default when the caller left it
 * out. The runtime merges defaults before a handler is called; a host that
 * calls the handler directly may not, and the default lives in ONE place.
 */
function configured(manifest: PluginManifest, args: Record<string, unknown>, key: string): unknown {
  return args[key] !== undefined ? args[key] : manifest.inputs[key]?.default
}

export const handler: CapabilityHandlerFn = async (manifest, args, _signal, capabilities) => {
  const FAILED = { phases_failed: [manifest.name], impact: 'HIGH' as const, retryable: false }
  const nothing = (why: string) => skillOk(`${manifest.name}: ${why}`, { phases_completed: [manifest.name] })

  // The approved bytes are the whole of what may be appended. No pool is read
  // here, so nothing the operator was not shown can be promoted.
  const record = capabilities.dependencies.lastOutput(capabilities.caller, 'candidate-propose')
  if (record === null) return nothing('no data from candidate-propose yet — nothing to promote')
  // Erased when the approval that bound it closed, or never inline at all.
  if (record.body === undefined) return nothing('the approved proposal is no longer held — nothing to promote')
  let candidates: unknown
  try {
    candidates = (JSON.parse(record.body) as { candidates?: unknown } | null)?.candidates
  } catch {
    candidates = undefined
  }
  if (!Array.isArray(candidates) || !candidates.every(isCandidate)) {
    return skillFailure('parse_error', `${manifest.name}: candidate-propose's Output is not a proposal — nothing was written`, FAILED)
  }
  if (candidates.length === 0) return nothing('the proposal is empty — nothing to promote')

  // Refused by the rule it broke, named by its key. The value never reaches
  // the result, because the summary lands in the run log.
  const rel = configured(manifest, args, 'promoted_path')
  if (typeof rel !== 'string' || !isUnderHome(rel)) {
    return skillFailure('parse_error', `${manifest.name}: input 'promoted_path' must be a relative path under the warpline home with no '..' segment`, FAILED)
  }
  const promotedAbs = join(warplineHome(), rel)

  // Absent is an empty list. Anything else that is not this shape is a
  // refusal: read as empty, the rewrite below would throw away what is there.
  let existing: { id: string }[]
  try {
    const raw = await readJsonOrNull<unknown>(promotedAbs)
    if (raw === null) existing = []
    else if (isPromotedFile(raw)) existing = raw.promoted
    else throw new Error('not a promoted file')
  } catch {
    return skillFailure('parse_error', `${manifest.name}: the file named by input 'promoted_path' is unreadable — refusing to rewrite it`, FAILED)
  }

  // Null prototype and `hasOwn`: a candidate with id `__proto__` or
  // `constructor` is an own key here like any other, never an inherited one.
  const seen: Record<string, true> = Object.create(null)
  for (const e of existing) seen[e.id] = true
  const fresh: Candidate[] = []
  for (const c of candidates) {
    if (Object.hasOwn(seen, c.id)) continue
    seen[c.id] = true
    fresh.push({ id: c.id, title: c.title, score: c.score })
  }
  const already = candidates.length - fresh.length
  if (fresh.length === 0) return nothing(`nothing new to promote (${already} already promoted)`)

  // One atomic write: the old file or the new one, never half of either.
  await atomicWriteJson(promotedAbs, { promoted: [...existing, ...fresh] })
  return skillOk(`${manifest.name}: promoted ${fresh.length} candidates (${already} already promoted)`, {
    phases_completed: [manifest.name],
  })
}
