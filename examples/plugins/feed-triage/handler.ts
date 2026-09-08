import { join } from 'node:path'
import { warplineHome } from 'warpline/lib/paths'
import type { CapabilityHandlerFn } from 'warpline/unstable-capabilities'
import { atomicWriteJson, readJsonOrNull } from 'warpline/unstable-fs'
import { skillHandoff, skillOk } from 'warpline/unstable-result'

/**
 * Expected shape of the Output `feed-monitor` last produced — the file it
 * writes and names with a `path` Output:
 * {
 *   "fetched_at": "2026-08-20T09:00:00.000Z",
 *   "new_entries": [
 *     { "title": "An article", "link": "https://example.com/a", "published": "2026-08-20T09:00:00Z" }
 *   ]
 * }
 *
 * Only `new_entries` is read, and the degrader below is what reads it: the
 * payload is a string another plugin authored over content it fetched from a
 * remote feed, so anything but an array of entries is nothing to triage.
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

export const handler: CapabilityHandlerFn = async (manifest, _args, _signal, capabilities) => {
  // The seam, not a convention. The runtime hands a handler what each of its
  // DECLARED dependencies last produced AND how that plugin's last run ended;
  // `feed-monitor` is declared in `manifest.dependencies`, and a name that is
  // not throws from either member rather than reading `null` — a typo and a
  // dependency that has not run are two unrelated fixes, and the wrong one is
  // the one that looks like waiting.
  //
  // Both facts, because neither answers alone. `lastOutput` is `null` for one
  // thing only — that plugin has never produced an Output — and that is a fact
  // about the PLUGIN, not about its last run: a run producing none carries the
  // previous record forward. `lastRun` is `null` only when the plugin has never
  // run.
  //
  // This used to be a path this handler computed itself, from an input an
  // operator configured, over a file nothing produced. What the runtime now
  // owes a plugin author, it pays.
  const record = capabilities.dependencies.lastOutput(capabilities.caller, 'feed-monitor')
  const run = capabilities.dependencies.lastRun(capabilities.caller, 'feed-monitor')
  if (record === null) {
    // NOT a bare `skipped`. deriveRunStatus maps a prefix-less `skipped` to
    // `failed`, and `warpline run` persists the artifact — "no data yet" would
    // otherwise paint a red run, the false-alarm class `delegated` exists to
    // kill. A success with nothing to say is the honest shape. NOT a
    // `dependency_unavailable` failure either: the runtime carries that gate
    // now, so a producer whose last run FAILED never reaches this handler at
    // all, and reddening the ordinary first-advance case here would be this
    // plugin declaring a dependency failure that is not its to declare.
    //
    // Says "no data from feed-monitor yet" rather than "has not run yet": a
    // `null` run does not only mean the producer never ran. A host may supply
    // no dependency state at all — `warpline run` is such a host — and then
    // every declared name reads `null` whatever the state document holds. Only
    // the declared name and the closed status enum are interpolated, never a
    // value read from a record.
    const state = run === null
      ? 'no data from feed-monitor yet'
      : `feed-monitor has run (last run: ${run}) and has never produced an Output`
    return skillOk(`${manifest.name}: ${state} — nothing to triage`, {
      phases_completed: [manifest.name],
    })
  }

  // An Output carries exactly one of `body` or `path`, and the schema refuses
  // anything else. `feed-monitor` emits the `path` form, because an entry list
  // grows with the feed and the body cap is 16 KiB; `readJsonOrNull` covers it
  // and is null for a file that is not there.
  //
  // Caught, because both halves can throw on content this plugin did not
  // author: `JSON.parse` on a body that is not JSON, and `readJsonOrNull` on a
  // path it cannot read. A thrown error out of a handler is a failed run with
  // no structure, which the runtime tells you not to return.
  let raw: unknown
  try {
    raw = record.body !== undefined
      ? (JSON.parse(record.body) as unknown)
      : await readJsonOrNull<unknown>(record.path!)
  } catch {
    raw = null
  }

  const entries = newEntries(raw)
  const observedAt = new Date().toISOString()
  if (entries.length === 0) {
    return skillOk(`${manifest.name}: no new entries from feed-monitor — nothing to triage`, {
      phases_completed: [manifest.name],
      data_freshness: { feed_entries: observedAt },
    })
  }

  // The payload the companion skill reads, in the shape it documents. Written
  // under the home rather than named where it was read from: the handoff
  // summary carries the path after `Context:` into the run log, and the
  // contract only lets the scanner open paths inside the home — so the file
  // the handoff names is one this plugin writes there, and the path on the
  // producer's record never reaches the log at all.
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
