import { join } from 'node:path'
import type { PluginManifest } from 'warpline/schemas/plugin-manifest'
import { OUTPUT_BODY_CAP_BYTES } from 'warpline/schemas/skill-result'
import { warplineHome } from 'warpline/lib/paths'
import type { CapabilityHandlerFn } from 'warpline/unstable-capabilities'
import { readJsonOrNull } from 'warpline/unstable-fs'
import { skillFailure, skillOk } from 'warpline/unstable-result'

/**
 * The pool this plugin reads, at input `pool_path`:
 * { "candidates": [{ "id": "cand-01", "title": "Example candidate 1", "score": 1 }] }
 *
 * The Output body, which `candidate-promote` reads and an operator approves:
 * { "candidates": [{ "id": "cand-01", "title": "Example candidate 1", "score": 1 }] }
 *
 * No run stamp and a total order, so the same pool always gives the same
 * bytes. An approval binds to those bytes, and a timestamp in them would void
 * it on every run.
 */
export interface Candidate {
  id: string
  title: string
  score: number
}

/** The flooding cap. A constant on purpose: see the manifest docstring. */
export const MAX_PROPOSED = 3

/** A candidate as the pool must hold it: a non-empty string id, a string title, a finite score. */
export function isCandidate(v: unknown): v is Candidate {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const c = v as Record<string, unknown>
  return typeof c.id === 'string' && c.id !== ''
    && typeof c.title === 'string'
    && typeof c.score === 'number' && Number.isFinite(c.score)
}

/**
 * At most `MAX_PROPOSED` candidates, highest score first, ties by id ascending.
 *
 * Ids compare with `<` and `>`, not `localeCompare`, whose order depends on the
 * host's locale. Each entry is rebuilt with only its three fields in a fixed
 * key order, so an extra field in the pool never reaches the approved bytes.
 */
export function propose(pool: Candidate[]): Candidate[] {
  return [...pool]
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, MAX_PROPOSED)
    .map(({ id, title, score }) => ({ id, title, score }))
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

export const handler: CapabilityHandlerFn = async (manifest, args, _signal, _capabilities) => {
  const FAILED = { phases_failed: [manifest.name], impact: 'HIGH' as const, retryable: false }
  const fail = (message: string) => skillFailure('parse_error', `${manifest.name}: ${message}`, FAILED)
  const artifact = (body: string) => [{ type: 'proposal', format: 'json' as const, body }]

  // The configured path is refused by the rule it broke, named by its key.
  // The value never reaches the result, because the summary lands in the run log.
  const rel = configured(manifest, args, 'pool_path')
  if (typeof rel !== 'string' || !isUnderHome(rel)) {
    return fail("input 'pool_path' must be a relative path under the warpline home with no '..' segment")
  }

  let raw: unknown
  try {
    raw = await readJsonOrNull<unknown>(join(warplineHome(), rel))
  } catch {
    return fail("the file named by input 'pool_path' is unreadable or not JSON")
  }
  // An empty proposal, not no Output. With no Output the runtime carries last
  // week's proposal forward, and candidate-promote refuses to ship it until
  // this plugin produces again. The empty proposal says "no candidates" in
  // bytes an operator can read and approve, and it replaces the old one at once.
  if (raw === null) {
    return skillOk(`${manifest.name}: no pool at the configured path — proposing nothing, which replaces the last proposal`, {
      phases_completed: [manifest.name],
      artifacts_produced: artifact(JSON.stringify({ candidates: [] })),
    })
  }

  const pool = typeof raw === 'object' && !Array.isArray(raw) ? (raw as { candidates?: unknown }).candidates : undefined
  if (!Array.isArray(pool)) {
    return fail("the file named by input 'pool_path' holds no \"candidates\" list")
  }
  // Positions are 1-based and name the entry, never its content.
  const bad = pool.findIndex((c) => !isCandidate(c))
  if (bad !== -1) {
    return fail(`candidate ${bad + 1} in the pool needs a non-empty string id, a string title and a finite number score`)
  }

  const chosen = propose(pool as Candidate[])
  const body = JSON.stringify({ candidates: chosen })
  // Three candidates only pass the cap with titles of a few KiB each at most.
  if (Buffer.byteLength(body, 'utf8') > OUTPUT_BODY_CAP_BYTES) {
    return fail(`the proposal exceeds the ${OUTPUT_BODY_CAP_BYTES}-byte Output cap; shorten the titles in the pool`)
  }
  return skillOk(`${manifest.name}: proposed ${chosen.length} of ${pool.length} candidates`, {
    phases_completed: [manifest.name],
    artifacts_produced: artifact(body),
  })
}
