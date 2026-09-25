import { join } from 'node:path'
import type { PluginManifest } from 'warpline/schemas/plugin-manifest'
import { makeSkillError, type SkillError } from 'warpline/schemas/skill-result'
import { warplineHome } from 'warpline/lib/paths'
import type { CapabilityHandlerFn } from 'warpline/unstable-capabilities'
import { atomicWriteJson, readJsonOrNull } from 'warpline/unstable-fs'
import { skillFailure, skillOk } from 'warpline/unstable-result'

/**
 * The mail API contract. It is this example's own, not a vendor's: point
 * `api_base` at an adapter that speaks it.
 *
 * POST <api_base>/send
 * authorization: Bearer <CADENCE_MAIL_TOKEN>
 * { "to": "c-1@example.com", "subject": "...", "body": "..." }
 *
 * Any 2xx is sent. 401 and 403 are a rejected token.
 *
 * The outbox comes from `cadence-plan`, through the dependency member, and it
 * is the only thing this plugin sends:
 * { "outbox": [{ "id": "c-1:1", "to": "...", "subject": "...", "body": "...", ... }] }
 *
 * Own state, `<home>/state/cadence-send.sent.json`, every pair that went out,
 * sorted by email id then recipient:
 * { "sent": [["c-1:1", "c-1@example.com"]] }
 */
interface Outgoing { id: string; to: string; subject: string; body: string }

const isText = (v: unknown): v is string => typeof v === 'string' && v !== ''

function isOutbox(v: unknown): v is Outgoing[] {
  return Array.isArray(v) && v.every((e) => {
    const o = e as Partial<Record<keyof Outgoing, unknown>> | null
    return o !== null && typeof o === 'object' && isText(o.id) && isText(o.to)
      && typeof o.subject === 'string' && typeof o.body === 'string'
  })
}

function isLedger(v: unknown): v is { sent: [string, string][] } {
  const sent = v !== null && typeof v === 'object' ? (v as { sent?: unknown }).sent : undefined
  return Array.isArray(sent) && sent.every((p) =>
    Array.isArray(p) && p.length === 2 && typeof p[0] === 'string' && typeof p[1] === 'string')
}

/** `<` and `>`, not `localeCompare`: the order must not depend on the host locale. */
const byPair = (a: [string, string], b: [string, string]): number =>
  a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0

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

export const handler: CapabilityHandlerFn = async (manifest, args, signal, capabilities) => {
  const FAILED = { phases_failed: [manifest.name], impact: 'HIGH' as const, retryable: false }
  const nothing = (why: string) => skillOk(`${manifest.name}: ${why}`, { phases_completed: [manifest.name] })

  // The approved bytes are the whole of what may be sent. No contacts file
  // and no template is read here, so nothing unapproved can reach a recipient.
  const record = capabilities.dependencies.lastOutput(capabilities.caller, 'cadence-plan')
  if (record === null) return nothing('no data from cadence-plan yet — nothing to send')
  // Erased when the approval that bound it closed, or never inline at all.
  if (record.body === undefined) return nothing('the approved outbox is no longer held — nothing to send')
  let outbox: unknown
  try {
    outbox = (JSON.parse(record.body) as { outbox?: unknown } | null)?.outbox
  } catch {
    outbox = undefined
  }
  if (!isOutbox(outbox)) {
    return skillFailure('parse_error', `${manifest.name}: cadence-plan's Output is not an outbox — nothing was sent`, FAILED)
  }
  if (outbox.length === 0) return nothing('the outbox is empty — nothing to send')

  // No arm below quotes a configured value, a token or an address. Each names
  // the input key, the secret's name or the email id.
  const base = httpBase(configured(manifest, args, 'api_base'))
  if (base === null) return skillFailure('parse_error', `${manifest.name}: input 'api_base' must be an http(s) URL`, FAILED)

  // The secret's name comes from the manifest, so a copy that renames it needs
  // no edit here. The runtime refuses an unset one before the handler runs;
  // this arm is for a host that calls the handler directly.
  const secret = manifest.secrets[0]
  const token = secret === undefined ? undefined : process.env[secret]
  if (!token) return skillFailure('auth_failure', `${manifest.name}: ${secret ?? 'the token named on secrets'} is not set`, FAILED)

  // Own state, derived from the manifest name. Anything but absent or this
  // plugin's shape is a refusal: read as empty, it would send everything again.
  const ledgerPath = join(warplineHome(), 'state', `${manifest.name}.sent.json`)
  let pairs: [string, string][]
  try {
    const raw = await readJsonOrNull<unknown>(ledgerPath)
    if (raw === null) pairs = []
    else if (isLedger(raw)) pairs = raw.sent
    else throw new Error('not a send ledger')
  } catch {
    return skillFailure('parse_error', `${manifest.name}: the send ledger is unreadable — refusing to send (it would duplicate)`, FAILED)
  }
  const recorded = new Set(pairs.map((p) => JSON.stringify(p)))

  let sent = 0
  let already = 0
  let error: SkillError | null = null
  let stoppedAt: string | null = null
  for (const email of outbox) {
    const key = JSON.stringify([email.id, email.to])
    if (recorded.has(key)) {
      already += 1
      continue
    }
    let res: Response
    try {
      res = await fetch(`${base}/send`, {
        method: 'POST',
        signal,
        // A redirect would carry the authorization header to wherever it points.
        redirect: 'error',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'user-agent': 'warpline-example',
        },
        body: JSON.stringify({ to: email.to, subject: email.subject, body: email.body }),
      })
    } catch (err) {
      // An abort before anything went out is the runtime's own timeout or
      // cancellation, and it classifies the run by the signal. After a send,
      // throwing would lose the partial result, so it is reported instead.
      // The thrown message is dropped: a fetch error embeds the request URL.
      if (signal.aborted && sent === 0) throw err
      error = signal.aborted
        ? makeSkillError('timeout', `aborted sending ${email.id}`, { impact: 'HIGH', retryable: false })
        : makeSkillError('dependency_unavailable', `request failed sending ${email.id}`, { impact: 'HIGH', retryable: false })
      stoppedAt = email.id
      break
    }
    if (res.status === 401 || res.status === 403) {
      error = makeSkillError('auth_failure', `${secret} was rejected (HTTP ${res.status}) sending ${email.id}`, { impact: 'HIGH', retryable: false })
      stoppedAt = email.id
      break
    }
    if (!res.ok) {
      error = makeSkillError('dependency_unavailable', `HTTP ${res.status} sending ${email.id}`, { impact: 'HIGH', retryable: false })
      stoppedAt = email.id
      break
    }
    // Marked before the next send. A crash between the send above and this
    // write can duplicate this one email, and no more than that.
    sent += 1
    recorded.add(key)
    pairs.push([email.id, email.to])
    try {
      await atomicWriteJson(ledgerPath, { sent: [...pairs].sort(byPair) })
    } catch {
      error = makeSkillError('dependency_unavailable', `sent ${email.id} but could not record it in the send ledger — stopping`, { impact: 'HIGH', retryable: false })
      stoppedAt = email.id
      break
    }
  }

  const summary = `${manifest.name}: sent ${sent} of ${outbox.length} (${already} already sent)`
    + (error ? `; stopped at ${stoppedAt}: ${error.message}` : '')
  if (sent === 0 && error !== null) {
    return skillFailure(error.code, summary, { ...FAILED, errors: [error] })
  }
  const result = skillOk(summary, {
    phases_completed: [manifest.name],
    errors: error ? [error] : undefined,
    reversible: false,
    undo_instruction: sent > 0
      ? `Sent email cannot be recalled; state/${manifest.name}.sent.json lists each email id and recipient that went out`
      : undefined,
  })
  // No builder emits `partial`, and some sent then a stop is exactly that.
  return error === null ? result : { ...result, status: 'partial' }
}
