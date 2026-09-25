import { join } from 'node:path'
import type { PluginManifest } from 'warpline/schemas/plugin-manifest'
import { makeSkillError } from 'warpline/schemas/skill-result'
import { warplineHome } from 'warpline/lib/paths'
import type { CapabilityHandlerFn } from 'warpline/unstable-capabilities'
import { atomicWriteJson, readJsonOrNull } from 'warpline/unstable-fs'
import { skillFailure, skillOk } from 'warpline/unstable-result'

/**
 * The ledger, `<home>/state/ledger.json` by default:
 * { "values": { "<instrument>": { "value": 101.5, "as_of": "2026-01-01T00:00:00.000Z" } } }
 *
 * The request contract is this example's own, not a vendor's. One request per
 * instrument, in declared order:
 *
 * GET <api_base>/quotes/<instrument, URL-encoded>
 * authorization: Bearer <LEDGER_QUOTES_TOKEN>
 *
 * answered with { "value": <number> }. The Output body:
 * { "attempted": 3, "succeeded": 2, "failed": 1,
 *   "errors": [{ "position": 2, "reason": "HTTP 500" }], "errors_omitted": 0 }
 *
 * The instruments, the endpoint and the ledger path are all configured
 * values, and the result lands in the run log, so none of them reaches it.
 * A failing instrument is named by its 1-based position in the list.
 */

/**
 * Failures listed by position in the body and the errors; the rest are
 * counted. A position is a number and every reason is one of three short
 * fixed strings, so fifty of them sit far under the 16 KiB body cap.
 */
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

type Entry = { value: number; as_of: string }

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const isEntry = (v: unknown): v is Entry =>
  isRecord(v) && typeof v.value === 'number' && Number.isFinite(v.value) && typeof v.as_of === 'string'

export const handler: CapabilityHandlerFn = async (manifest, args, signal, _capabilities) => {
  const FAILED = { phases_failed: [manifest.name], impact: 'HIGH' as const, retryable: false }
  const fail = (code: 'parse_error' | 'auth_failure', message: string) =>
    skillFailure(code, `${manifest.name}: ${message}`, FAILED)

  // Shape first, before any read or request. No arm quotes a configured
  // value: each names the input key and the rule it broke.
  const instruments = configured(manifest, args, 'instruments')
  // `.` and `..` too: encodeURIComponent leaves them alone and the URL parser
  // resolves them, so the read would leave `/quotes/` with the token attached.
  if (!Array.isArray(instruments) || !instruments.every((i) => typeof i === 'string' && i !== '' && i !== '.' && i !== '..')) {
    return fail('parse_error', "input 'instruments' must be a list of non-empty strings, none of them '.' or '..'")
  }
  if (instruments.length === 0) {
    // NOT a bare `skipped`: a prefix-less `skipped` is persisted as `failed`,
    // and a plugin with nothing configured to read is not a red run.
    return skillOk(`${manifest.name}: input 'instruments' is empty — nothing to read; run: warpline configure ${manifest.name}`, {
      phases_completed: [manifest.name],
    })
  }
  const ledgerPath = configured(manifest, args, 'ledger_path')
  if (typeof ledgerPath !== 'string' || !isUnderHome(ledgerPath)) {
    return fail('parse_error', "input 'ledger_path' must be a relative path under the warpline home with no '..' segment")
  }
  const base = httpBase(configured(manifest, args, 'api_base'))
  if (base === null) return fail('parse_error', "input 'api_base' must be an http(s) URL")

  // The secret's name comes from the manifest, so a copy that gives it another
  // name needs no edit here. The runtime refuses an unset one before the
  // handler runs; this arm is for a host that calls the handler directly.
  const secret = manifest.secrets[0] ?? 'the token named on secrets'
  const token = process.env[secret]
  if (!token) return fail('auth_failure', `${secret} is not set`)

  // The ledger is read BEFORE the first request. null is "no ledger yet".
  // Anything else that is not a ledger (EACCES, EISDIR, a truncated file, the
  // wrong shape) must NOT read as empty: the write below would replace every
  // value the adopter had with only the ones this run managed to read.
  // Null prototype, so an instrument named `__proto__` is a key like any other.
  const ledgerAbs = join(warplineHome(), ledgerPath)
  const unreadable = () => fail('parse_error', "the file named by input 'ledger_path' is unreadable — refusing to overwrite it")
  const values: Record<string, Entry> = Object.create(null)
  let raw: unknown
  try {
    raw = await readJsonOrNull<unknown>(ledgerAbs)
  } catch {
    return unreadable()
  }
  if (raw !== null) {
    if (!isRecord(raw) || !isRecord(raw.values) || !Object.values(raw.values).every(isEntry)) return unreadable()
    Object.assign(values, raw.values)
  }

  // One instrument at a time, in declared order. A failed read is a value,
  // never a throw, so it cannot take the others down, and the instrument keeps
  // what the ledger already held for it. A rejected token is the one
  // exception: every read after it would be rejected too, so the loop stops,
  // nothing is written, and the failure names the secret.
  const failures: { position: number; reason: string }[] = []
  for (const [i, instrument] of (instruments as string[]).entries()) {
    const position = i + 1
    let res: Response
    try {
      res = await fetch(`${base}/quotes/${encodeURIComponent(instrument)}`, {
        signal,
        // A redirect would carry the authorization header to wherever it points.
        redirect: 'error',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          'user-agent': 'warpline-example',
        },
      })
    } catch (err) {
      // An abort is the runtime's own timeout or cancellation, and it
      // classifies the run by the signal. Any other fetch error's message
      // embeds the request URL, the configured value, so it is dropped.
      if (signal.aborted) throw err
      failures.push({ position, reason: 'request failed' })
      continue
    }
    if (res.status === 401 || res.status === 403) return fail('auth_failure', `${secret} was rejected (HTTP ${res.status})`)
    if (!res.ok) {
      failures.push({ position, reason: `HTTP ${res.status}` })
      continue
    }
    let quote: unknown
    try {
      quote = await res.json()
    } catch {
      quote = undefined
    }
    if (!isRecord(quote) || typeof quote.value !== 'number' || !Number.isFinite(quote.value)) {
      failures.push({ position, reason: 'response carried no numeric value' })
      continue
    }
    values[instrument] = { value: quote.value, as_of: new Date().toISOString() }
  }

  const attempted = instruments.length
  const failed = failures.length
  const succeeded = attempted - failed
  // Every instrument failing IS a failure, and nothing is written: the ledger
  // the adopter had is still the ledger they have.
  if (succeeded === 0) {
    const first = failures[0]!
    return skillFailure('dependency_unavailable', `${manifest.name}: every instrument failed (${attempted} attempted; first at position ${first.position}: ${first.reason})`, {
      phases_failed: [manifest.name],
      impact: 'HIGH',
    })
  }

  // The only write in this file. The atomic writer creates the parent and
  // swaps a finished temp file in for the target, so a crash mid-write
  // leaves the old ledger, never half of a new one.
  await atomicWriteJson(ledgerAbs, { values })

  const listed = failures.slice(0, MAX_LISTED_ERRORS)
  const body = JSON.stringify({ attempted, succeeded, failed, errors: listed, errors_omitted: failed - listed.length })
  const errors = listed.map((f) =>
    makeSkillError('dependency_unavailable', `instrument at position ${f.position}: ${f.reason}`, { impact: 'MEDIUM', retryable: false }))

  // Plain `success`, not `partial`: the counts and the errors say what did
  // not land, and the run did what it is for.
  return skillOk(
    `${manifest.name}: read ${succeeded} of ${attempted} instruments`
      + (failed > 0 ? `; ${failed} failed, first at position ${failures[0]!.position}: ${failures[0]!.reason}` : ''),
    {
      phases_completed: [manifest.name],
      errors: errors.length > 0 ? errors : undefined,
      artifacts_produced: [{ type: 'ledger-run', format: 'json', body }],
    },
  )
}
