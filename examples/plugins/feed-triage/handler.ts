import { join } from 'node:path'
import { warplineHome } from 'warpline/lib/paths'
import type { CapabilityHandlerFn } from 'warpline/unstable-capabilities'
import { atomicWriteJson, readJsonOrNull } from 'warpline/unstable-fs'
import { skillFailure, skillHandoff, skillOk } from 'warpline/unstable-result'

/**
 * Expected feed state file shape — the same element type `feed-monitor`
 * produces under its `new_entries` output:
 * {
 *   "new_entries": [
 *     { "title": "An article", "link": "https://example.com/a", "published": "2026-08-20T09:00:00Z" }
 *   ]
 * }
 */
interface FeedEntry {
  title: string
  link: string
  published: string | null
}

export function newEntries(raw: unknown): FeedEntry[] {
  if (raw === null || typeof raw !== 'object') return []
  const entries = (raw as { new_entries?: unknown }).new_entries
  return Array.isArray(entries) ? (entries as FeedEntry[]) : []
}

export const handler: CapabilityHandlerFn = async (manifest, args, _signal, _capabilities) => {
  const entriesPath = typeof args.entries_path === 'string'
    ? args.entries_path
    : join(warplineHome(), 'state', 'feed-entries.json')

  // `entries_path` is an operator-configured value and this result lands in
  // the run log, so no arm below names it. ENOENT is "nothing to triage yet";
  // anything else is a failure that says which input key, never which path.
  let raw: unknown
  try {
    raw = await readJsonOrNull<unknown>(entriesPath)
  } catch {
    return skillFailure(
      'parse_error',
      `${manifest.name}: entries_path is unreadable or not JSON`,
      { phases_failed: [manifest.name], impact: 'HIGH', retryable: false },
    )
  }
  if (raw === null) {
    // NOT a bare `skipped`. deriveRunStatus maps a prefix-less `skipped` to
    // `failed`, and `warpline run` persists the artifact — "no data yet" would
    // otherwise paint a red run, the false-alarm class `delegated` exists to
    // kill. A success with nothing to say is the honest shape.
    return skillOk(`${manifest.name}: no feed state at the configured path — nothing to triage`, {
      phases_completed: [manifest.name],
    })
  }

  const entries = newEntries(raw)
  const observedAt = new Date().toISOString()
  if (entries.length === 0) {
    return skillOk(`${manifest.name}: no new entries at the configured path — nothing to triage`, {
      phases_completed: [manifest.name],
      data_freshness: { feed_entries: observedAt },
    })
  }

  // The payload the companion skill reads, in the shape it documents. Written
  // under the home rather than named where it was read from: the handoff
  // summary carries the path after `Context:` into the run log, and the
  // contract only lets the scanner open paths inside the home — so the file
  // the handoff names is one this plugin writes there, and the configured
  // `entries_path` never reaches the log at all.
  const contextPath = `state/${manifest.name}.handoff.json`
  await atomicWriteJson(join(warplineHome(), contextPath), { new_entries: entries })

  // `skillHandoff` resolves the path against the home itself, so the argument
  // stays RELATIVE — an absolute one would be refused at the parse boundary.
  // The task carries no full stop: the scanner splits on `Context: `.
  return skillHandoff(`Triage ${entries.length} new feed entries`, contextPath, {
    phases_completed: [manifest.name],
    data_freshness: { feed_entries: observedAt },
  })
}
