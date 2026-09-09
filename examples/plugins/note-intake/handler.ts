import { join } from 'node:path'
import { warplineHome } from 'warpline/lib/paths'
import type { CapabilityHandlerFn } from 'warpline/unstable-capabilities'
import { atomicWriteText } from 'warpline/unstable-fs'
import { skillFailure, skillOk } from 'warpline/unstable-result'

/**
 * Takes the note the operator supplied for this run and writes it to one new
 * file under the home. The note arrives in `args` as a string, the shape
 * `warpline run note-intake default --input note=<text>` delivers; see the
 * manifest docstring for the channel and its ceiling.
 *
 * The note is never echoed. Not in the summary, not in an error. The summary
 * names where the note went and how long it was; the text itself exists in
 * exactly one place afterwards, the file it was routed to.
 */

/** Every failure here is the plugin's own phase, high impact, and not retried. */
const FAILED = { phases_failed: ['note-intake'], impact: 'HIGH' as const, retryable: false }

/**
 * A destination under the home and nowhere else: no leading separator, no
 * drive letter, no `..` segment. The same rule the handoff contract applies
 * to a `[needs-llm]` payload path, and the check an author copies from here.
 */
export function isUnderHome(rel: string): boolean {
  if (rel === '' || /^[\\/]/.test(rel) || /^[A-Za-z]:/.test(rel)) return false
  return !rel.split(/[\\/]/).includes('..')
}

// `_signal` is accepted, unused — one local write has nothing to cancel.
export const handler: CapabilityHandlerFn = async (manifest, args, _signal, _capabilities) => {
  const note = args.note
  if (typeof note !== 'string' || note.length === 0) {
    // NOT a bare `skipped`: a prefix-less `skipped` is persisted as `failed`,
    // and a plugin waiting for a human to say something is not a red run.
    return skillOk(
      `${manifest.name}: input 'note' has no value — run: warpline run ${manifest.name} default --input note=<text>`,
      { phases_completed: [manifest.name] },
    )
  }

  // The directory is derived from the manifest name unless the operator
  // configured one, and a configured one is refused unless it stays under
  // the home. The refusal names the key and the rule, never the value.
  const inbox = typeof args.inbox === 'string' ? args.inbox : join('notes', manifest.name)
  if (!isUnderHome(inbox)) {
    return skillFailure('parse_error', `${manifest.name}: input 'inbox' must be a relative path under the warpline home with no '..' segment`, FAILED)
  }

  // One new file per note, named by the moment it was routed. ponytail: two
  // notes in the same millisecond collide; a manual verb a human types
  // never gets there, and a counter would be state this plugin keeps.
  const file = `${new Date().toISOString().replace(/[:.]/g, '-')}.txt`
  const rel = join(inbox, file)
  // Creates the parent, writes a temp file, renames it over the target: the
  // note lands whole or not at all.
  await atomicWriteText(join(warplineHome(), rel), note)

  return skillOk(`${manifest.name}: routed ${Buffer.byteLength(note, 'utf8')} bytes to ${rel}`, {
    phases_completed: [manifest.name],
    data_freshness: { routed: new Date().toISOString() },
  })
}
