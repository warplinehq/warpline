import { join } from 'node:path'
import type { PluginManifest } from 'warpline/schemas/plugin-manifest'
import { OUTPUT_BODY_CAP_BYTES, makeSkillError, type SkillError } from 'warpline/schemas/skill-result'
import { warplineHome } from 'warpline/lib/paths'
import type { CapabilityHandlerFn } from 'warpline/unstable-capabilities'
import { readJsonOrNull } from 'warpline/unstable-fs'
import { skillFailure, skillOk } from 'warpline/unstable-result'

/**
 * Input, `<home>/state/records.json` by default:
 * { "records": [{ "id": "r-1", ...fields }] }
 *
 * The request contract is this example's own, not a vendor's. One request per
 * record, in file order:
 *
 * PUT <api_base>/records/<id, URL-encoded>
 * authorization: Bearer <GRAPH_SYNC_TOKEN>
 * <the record, as JSON>
 *
 * Any 2xx is an upsert. The Output body:
 * { "attempted": 3, "succeeded": 2, "failed": 1,
 *   "errors": [{ "id": "r-2", "reason": "HTTP 500" }], "errors_omitted": 0 }
 *
 * Nothing is written locally. The records path and the endpoint are
 * configured values, so neither reaches the result. A record id comes from
 * the adopter's own data file and is named where it failed.
 */

/** Failures listed by id in the body and the errors; the rest are counted. */
const MAX_LISTED_ERRORS = 50

/**
 * A path under the home and nowhere else: no leading separator, no drive
 * letter, no `..` segment. The same rule the handoff contract applies to a
 * `[needs-llm]` payload path.
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

function httpBase(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const { protocol } = new URL(value)
    return protocol === 'http:' || protocol === 'https:' ? value.replace(/\/+$/, '') : null
  } catch {
    return null
  }
}

type SyncRecord = { id: string } & Record<string, unknown>

export const handler: CapabilityHandlerFn = async (manifest, args, signal, _capabilities) => {
  const FAILED = { phases_failed: [manifest.name], impact: 'HIGH' as const, retryable: false }
  const fail = (code: 'parse_error' | 'auth_failure', message: string) =>
    skillFailure(code, `${manifest.name}: ${message}`, FAILED)

  // Shape first, before any read. No arm quotes a configured value: each
  // names the input key and the rule it broke, because this lands in the run log.
  const recordsPath = configured(manifest, args, 'records_path')
  if (typeof recordsPath !== 'string' || !isUnderHome(recordsPath)) {
    return fail('parse_error', "input 'records_path' must be a relative path under the warpline home with no '..' segment")
  }
  const base = httpBase(configured(manifest, args, 'api_base'))
  if (base === null) return fail('parse_error', "input 'api_base' must be an http(s) URL")

  let raw: { records?: unknown } | null
  try {
    raw = await readJsonOrNull<{ records?: unknown }>(join(warplineHome(), recordsPath))
  } catch {
    return fail('parse_error', "the file named by input 'records_path' is unreadable or not JSON")
  }
  if (raw === null) {
    // NOT a bare `skipped`: a prefix-less `skipped` is persisted as `failed`,
    // and "no data yet" must not paint a red run.
    return skillOk(`${manifest.name}: no records file at the configured path — nothing to sync`, {
      phases_completed: [manifest.name],
    })
  }
  const list = typeof raw === 'object' ? raw.records : undefined
  if (!Array.isArray(list)) return fail('parse_error', "the file named by input 'records_path' holds no \"records\" list")

  // Every record is checked, and every id is unique, before the first call:
  // a file that would PUT one id twice is refused whole, never half-sent.
  // Null prototype, read with `Object.hasOwn`, so an id named `__proto__`
  // or `constructor` is an id and nothing else.
  const records: SyncRecord[] = []
  const seen: Record<string, true> = Object.create(null)
  for (const [i, r] of list.entries()) {
    if (r === null || typeof r !== 'object' || Array.isArray(r) || typeof r.id !== 'string' || r.id === '') {
      return fail('parse_error', `record ${i + 1} in the records file has no string id`)
    }
    // encodeURIComponent leaves `.` alone and the URL parser resolves dot
    // segments, so `..` would PUT this record, token and all, to `<base>/`.
    if (r.id === '.' || r.id === '..') {
      return fail('parse_error', `record ${i + 1} in the records file has an id that is a path segment`)
    }
    if (Object.hasOwn(seen, r.id)) {
      return fail('parse_error', `record id '${r.id}' appears twice in the records file — nothing was sent`)
    }
    seen[r.id] = true
    records.push(r as SyncRecord)
  }

  // The secret's name comes from the manifest, so a copy that renames it needs
  // no edit here. The runtime refuses an unset one before the handler runs;
  // this arm is for a host that calls the handler directly.
  const secret = manifest.secrets[0] ?? 'the token named on secrets'
  const token = process.env[secret]
  if (!token) return fail('auth_failure', `${secret} is not set`)

  // One record at a time, in file order. A failed record is a value, never a
  // throw, so it cannot take the others down. A rejected token is the one
  // exception: every record after it would be rejected too, so the loop stops
  // and the failure names the secret.
  const failures: { id: string; reason: string }[] = []
  for (const record of records) {
    let res: Response
    try {
      res = await fetch(`${base}/records/${encodeURIComponent(record.id)}`, {
        method: 'PUT',
        signal,
        // A redirect would carry the authorization header to wherever it points.
        redirect: 'error',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'user-agent': 'warpline-example',
        },
        body: JSON.stringify(record),
      })
    } catch (err) {
      // An abort is the runtime's own timeout or cancellation, and it
      // classifies the run by the signal. Any other fetch error's message
      // embeds the request URL, the configured value, so it is dropped.
      if (signal.aborted) throw err
      failures.push({ id: record.id, reason: 'request failed' })
      continue
    }
    if (res.status === 401 || res.status === 403) return fail('auth_failure', `${secret} was rejected (HTTP ${res.status})`)
    if (!res.ok) failures.push({ id: record.id, reason: `HTTP ${res.status}` })
  }

  const attempted = records.length
  const failed = failures.length
  const succeeded = attempted - failed
  // Every record failing IS a failure: a sync that wrote nothing returned as
  // a success is the silent false-negative. PUT by id is safe to retry.
  if (attempted > 0 && succeeded === 0) {
    const first = failures[0]!
    return skillFailure('dependency_unavailable', `${manifest.name}: every record failed (${attempted} attempted; first: ${first.id}: ${first.reason})`, {
      phases_failed: [manifest.name],
      impact: 'HIGH',
    })
  }

  // One inline Output under the 16 KiB body cap. Listing is capped first; if
  // very long ids still overflow it, the list goes and the counts stay exact.
  let listed = failures.slice(0, MAX_LISTED_ERRORS)
  let body = JSON.stringify({ attempted, succeeded, failed, errors: listed, errors_omitted: failed - listed.length })
  if (Buffer.byteLength(body, 'utf8') > OUTPUT_BODY_CAP_BYTES) {
    listed = []
    body = JSON.stringify({ attempted, succeeded, failed, errors: listed, errors_omitted: failed })
  }
  const errors: SkillError[] = listed.map((f) =>
    makeSkillError('dependency_unavailable', `record ${f.id}: ${f.reason}`, { impact: 'MEDIUM', retryable: false }))

  // Plain `success`, not `partial`: the counts and the errors say what did
  // not land, and the run did what it is for.
  return skillOk(
    `${manifest.name}: synced ${succeeded} of ${attempted} records`
      + (failed > 0 ? `; ${failed} failed, first ${failures[0]!.id}: ${failures[0]!.reason}` : ''),
    {
      phases_completed: [manifest.name],
      errors: errors.length > 0 ? errors : undefined,
      artifacts_produced: [{ type: 'sync', format: 'json', body }],
    },
  )
}
