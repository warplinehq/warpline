import { join } from 'node:path'
import type { PluginManifest } from 'warpline/schemas/plugin-manifest'
import { warplineHome } from 'warpline/lib/paths'
import type { CapabilityHandlerFn } from 'warpline/unstable-capabilities'
import { atomicWriteJson, readJsonOrNull } from 'warpline/unstable-fs'
import { skillFailure, skillHandoff, skillOk } from 'warpline/unstable-result'

/**
 * Resolves which channels are due, writes a payload under the home naming the
 * draft and each due channel's call to action, and hands the per-channel
 * rewrite off. Nothing here knows a channel name, a call to action or a
 * cadence: all three arrive from the declared inputs.
 *
 * Payload, `<home>/state/announce-fanout.handoff.json`:
 * {
 *   "draft_path": "state/announce-fanout.draft.json",
 *   "channels": { "<name>": { "call_to_action": "..." } },
 *   "unconfigured": ["<name>"],
 *   "held": ["<name>"]
 * }
 *
 * Ledger, `<home>/state/announce-fanout.last.json`, one stamp per channel:
 * { "handed_off": { "<name>": "2026-01-01T00:00:00.000Z" } }
 */

/** Every failure here is the plugin's own phase, high impact, and not retried. */
const FAILED = { phases_failed: ['announce-fanout'], impact: 'HIGH' as const, retryable: false }

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

/** A record's own string-valued entries, copied onto a null prototype. */
function ownStrings(raw: unknown): Record<string, string> {
  const out: Record<string, string> = Object.create(null)
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [key, value] of Object.entries(raw)) if (typeof value === 'string') out[key] = value
  return out
}

const names = (list: string[]) => list.join(', ')

export const handler: CapabilityHandlerFn = async (manifest, args, _signal, _capabilities) => {
  const home = warplineHome()

  // Shape first, before any read: the refusal names the key and the rule,
  // never the value, because this summary lands in the run log.
  const draftPath = configured(manifest, args, 'draft_path')
  if (typeof draftPath !== 'string' || !isUnderHome(draftPath)) {
    return skillFailure('parse_error', `${manifest.name}: input 'draft_path' must be a relative path under the warpline home with no '..' segment`, FAILED)
  }

  // NOT a bare `skipped`: a prefix-less `skipped` is persisted as `failed`,
  // and an unconfigured plugin is not a broken one. Not a success either —
  // fanning out to nobody is not a fan-out.
  const listed = configured(manifest, args, 'channels')
  const channels = (Array.isArray(listed) ? listed : []).filter((c): c is string => typeof c === 'string')
  if (channels.length === 0) {
    return skillOk(`${manifest.name}: input 'channels' is empty — nothing to fan out; run: warpline configure ${manifest.name}`, {
      phases_completed: [manifest.name],
    })
  }
  // The mapping's keys are operator config, so every keyed structure below
  // is null-prototype and every lookup is an own-property check: a channel
  // named `constructor` must be unconfigured, not Object's.
  const calls = ownStrings(configured(manifest, args, 'calls_to_action'))
  const cadence = configured(manifest, args, 'cadence_hours')
  const windowMs = (typeof cadence === 'number' ? cadence : 0) * 3_600_000

  let draft: unknown
  try {
    draft = await readJsonOrNull<unknown>(join(home, draftPath))
  } catch {
    return skillFailure('parse_error', `${manifest.name}: the file named by input 'draft_path' is unreadable or not JSON`, FAILED)
  }
  if (draft === null) {
    return skillOk(`${manifest.name}: no draft at the configured path — nothing to fan out`, {
      phases_completed: [manifest.name],
    })
  }

  // The ledger is this plugin's own file; one it cannot read is rebuilt from
  // nothing rather than failing every run, at the cost of one early hand-off.
  const ledgerPath = join(home, 'state', `${manifest.name}.last.json`)
  let ledger: { handed_off?: unknown } | null = null
  try {
    ledger = await readJsonOrNull<{ handed_off?: unknown }>(ledgerPath)
  } catch {
    ledger = null
  }
  const last = ownStrings(ledger?.handed_off)

  // Per-channel isolation: a channel with no call to action, or one handed
  // off inside the cadence window, is reported and skipped; the rest proceed.
  const now = Date.now()
  const due: string[] = []
  const unconfigured: string[] = []
  const held: string[] = []
  const posts: Record<string, { call_to_action: string }> = Object.create(null)
  for (const channel of channels) {
    if (!Object.hasOwn(calls, channel)) {
      unconfigured.push(channel)
      continue
    }
    const stamp = Object.hasOwn(last, channel) ? Date.parse(last[channel]!) : Number.NaN
    if (now - stamp < windowMs) {
      held.push(channel)
      continue
    }
    due.push(channel)
    posts[channel] = { call_to_action: calls[channel]! }
  }

  if (due.length === 0) {
    if (unconfigured.length === channels.length) {
      return skillOk(`${manifest.name}: no channel in 'channels' has an entry in 'calls_to_action' — nothing to fan out; run: warpline configure ${manifest.name}`, {
        phases_completed: [manifest.name],
      })
    }
    const parts = [`${held.length} within cadence (${names(held)})`]
    if (unconfigured.length > 0) parts.push(`${unconfigured.length} unconfigured (${names(unconfigured)})`)
    return skillOk(`${manifest.name}: nothing to fan out — ${parts.join(', ')}`, { phases_completed: [manifest.name] })
  }

  // The payload names the draft by its in-home path and carries each due
  // channel's call to action; the values stay in the config file and here,
  // under the home, and never in the summary.
  const contextPath = `state/${manifest.name}.handoff.json`
  await atomicWriteJson(join(home, contextPath), { draft_path: draftPath, channels: posts, unconfigured, held })

  const handedAt = new Date(now).toISOString()
  for (const channel of due) last[channel] = handedAt
  await atomicWriteJson(ledgerPath, { handed_off: last })

  // The task names the channels and the counts. No full stop at the end: the
  // scanner splits on `Context: `, and `skillHandoff` resolves the relative
  // payload path against the home itself.
  let task = `Adapt the draft for ${due.length} ${due.length === 1 ? 'channel' : 'channels'} (${names(due)})`
  if (unconfigured.length > 0) task += `; ${unconfigured.length} unconfigured (${names(unconfigured)})`
  if (held.length > 0) task += `; ${held.length} held within cadence (${names(held)})`
  return skillHandoff(task, contextPath, {
    phases_completed: [manifest.name],
    data_freshness: { handoff: handedAt },
  })
}
