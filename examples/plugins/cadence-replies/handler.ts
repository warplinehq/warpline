import { join } from 'node:path'
import type { PluginManifest } from 'warpline/schemas/plugin-manifest'
import { OUTPUT_BODY_CAP_BYTES } from 'warpline/schemas/skill-result'
import { warplineHome } from 'warpline/lib/paths'
import type { CapabilityHandlerFn } from 'warpline/unstable-capabilities'
import { readJsonOrNull } from 'warpline/unstable-fs'
import { skillFailure, skillOk } from 'warpline/unstable-result'

/**
 * The replies file this stub reads, at input `replies_path`:
 * { "replies": [{ "contact_id": "c-1" }] }
 *
 * The Output body, which `cadence-plan` reads and a replacement must keep:
 * { "replied": ["c-1"] }
 *
 * Sorted and unique, so the same replies give the same bytes.
 */

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

  // The configured path is refused by the rule it broke, named by its key.
  // The value never reaches the result, because the summary lands in the run log.
  const rel = configured(manifest, args, 'replies_path')
  if (typeof rel !== 'string' || !isUnderHome(rel)) {
    return fail("input 'replies_path' must be a relative path under the warpline home with no '..' segment")
  }

  let raw: { replies?: unknown } | null
  try {
    raw = await readJsonOrNull<{ replies?: unknown }>(join(warplineHome(), rel))
  } catch {
    return fail("the file named by input 'replies_path' is unreadable or not JSON")
  }
  // Absent is not "nobody replied". No Output, so the plan has nothing to plan against.
  if (raw === null) {
    return skillOk(`${manifest.name}: no replies file at the configured path — create one (an empty list means no replies)`, {
      phases_completed: [manifest.name],
    })
  }
  const replies = typeof raw === 'object' ? raw.replies : undefined
  if (!Array.isArray(replies)) {
    return fail("the file named by input 'replies_path' must hold { \"replies\": [...] }")
  }
  const ids: string[] = []
  for (const [i, entry] of replies.entries()) {
    const id = entry !== null && typeof entry === 'object' ? (entry as { contact_id?: unknown }).contact_id : undefined
    if (typeof id !== 'string' || id === '') {
      return fail(`entry ${i + 1} of the file named by input 'replies_path' has no contact_id`)
    }
    ids.push(id)
  }

  // The default sort compares code units, so the order never depends on the host locale.
  const replied = [...new Set(ids)].sort()
  const body = JSON.stringify({ replied })
  if (Buffer.byteLength(body, 'utf8') > OUTPUT_BODY_CAP_BYTES) {
    return fail(`the replies list exceeds the ${OUTPUT_BODY_CAP_BYTES}-byte Output cap`)
  }
  return skillOk(`${manifest.name}: ${replied.length} contacts replied`, {
    phases_completed: [manifest.name],
    artifacts_produced: [{ type: 'replies', format: 'json', body }],
  })
}
