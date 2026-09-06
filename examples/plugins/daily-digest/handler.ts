import { resolve } from 'node:path'
import { warplineHome } from 'warpline/lib/paths'
import type { CapabilityHandlerFn } from 'warpline/unstable-capabilities'
import { readJsonOrNull } from 'warpline/unstable-fs'
import { skillFailure, skillOk } from 'warpline/unstable-result'

/**
 * The two upstream shapes, one per declared dependency.
 *
 * anomaly-watch, dropped at `anomalies_path` in the shape anomaly-issue reads:
 * { "anomalies": [ { "name": "error_count", "latest": 42, "threshold": 10, "direction": "above" } ] }
 *
 * github-poll, dropped at `issues_path` in the shape its Output body carries:
 * { "observed_at": "...", "open_count": 7, "newest_number": 12 }
 *
 * Only the fields the digest names are read; the rest passes through untouched.
 */
interface Anomalies {
  anomalies?: unknown
}

interface IssuesSnapshot {
  open_count?: unknown
  newest_number?: unknown
}

/** One line per source, in the words an operator reads. */
function describeAnomalies(raw: Anomalies): string {
  const names = (Array.isArray(raw.anomalies) ? raw.anomalies : [])
    .map((a: { name?: unknown }) => a?.name)
    .filter((n): n is string => typeof n === 'string')
  return names.length === 0 ? 'nothing breached' : `${names.length} breached (${names.join(', ')})`
}

function describeIssues(raw: IssuesSnapshot): string {
  const count = typeof raw.open_count === 'number' ? raw.open_count : 0
  const newest = typeof raw.newest_number === 'number' ? `, newest #${raw.newest_number}` : ''
  return `${count} open issues${newest}`
}

/**
 * Read one upstream file, or `null` when the producer has left nothing yet.
 * The path is operator-configured and this result lands in the run log, so a
 * read that fails for any reason other than ENOENT names the input KEY.
 */
async function readUpstream<T>(key: string, path: string): Promise<{ ok: true; value: T | null } | { ok: false; key: string }> {
  try {
    return { ok: true, value: await readJsonOrNull<T>(path) }
  } catch {
    return { ok: false, key }
  }
}

export const handler: CapabilityHandlerFn = async (manifest, args, _signal, _capabilities) => {
  // A convention, not a seam. `anomalies_path` and `issues_path` are files a
  // chaining host drops under the home; the declared dependencies,
  // `anomaly-watch` and `github-poll`, do not write them. Both dependencies
  // now return a real Output on their success arm, so producers exist — but
  // the reader for them, `readDependencyOutput`, takes an `EngineState`, and a
  // handler is called `(manifest, args, signal, capabilities)`: no engine
  // state reaches it, and `CapabilityContext` has no member that carries one.
  // A plugin cannot call the reader, so these reads succeed whether or not the
  // producers ran. They stay until the runtime hands a plugin a way to read
  // what its dependencies produced; then these two reads, both inputs and the
  // manifest's convention paragraph go together. The file shapes are the
  // Output shapes, so what replaces the read is the read alone.
  const home = warplineHome()
  const anomaliesPath = resolve(home, typeof args.anomalies_path === 'string' ? args.anomalies_path : 'state/anomalies.json')
  const issuesPath = resolve(home, typeof args.issues_path === 'string' ? args.issues_path : 'state/github-issues.json')

  const anomalies = await readUpstream<Anomalies>('anomalies_path', anomaliesPath)
  if (!anomalies.ok) {
    return skillFailure('parse_error', `${manifest.name}: the file named by input '${anomalies.key}' is unreadable or not JSON`, {
      phases_failed: [manifest.name],
      impact: 'HIGH',
      retryable: false,
    })
  }
  const issues = await readUpstream<IssuesSnapshot>('issues_path', issuesPath)
  if (!issues.ok) {
    return skillFailure('parse_error', `${manifest.name}: the file named by input '${issues.key}' is unreadable or not JSON`, {
      phases_failed: [manifest.name],
      impact: 'HIGH',
      retryable: false,
    })
  }

  if (anomalies.value === null && issues.value === null) {
    // NOT a bare `skipped`: a prefix-less `skipped` is persisted as `failed`,
    // and "no data yet" must not paint a red run. And NO Output: an empty
    // digest returned as one would become the engine's last_output for this
    // plugin, and a downstream reader would take a day that was never
    // digested for one that was.
    return skillOk(`${manifest.name}: no upstream data at either configured path — nothing to digest`, {
      phases_completed: [manifest.name],
    })
  }

  // A missing upstream is not a failure of the digest: the digest says which
  // source had nothing, so it never reads as complete when it is not.
  const lines = [
    `anomaly-watch: ${anomalies.value === null ? 'nothing yet' : describeAnomalies(anomalies.value)}`,
    `github-poll: ${issues.value === null ? 'nothing yet' : describeIssues(issues.value)}`,
  ]
  const observedAt = new Date().toISOString()
  const digest = {
    observed_at: observedAt,
    sources: { 'anomaly-watch': anomalies.value, 'github-poll': issues.value },
    digest: lines.join('; '),
  }

  return skillOk(`${manifest.name}: ${lines.join('; ')}`, {
    phases_completed: [manifest.name],
    data_freshness: { digest: observedAt },
    // One Output, inline, and LAST: the engine takes `.at(-1)` as the record
    // a dependent may read. The body cap is 16 KiB of UTF-8; the digest
    // carries two small upstream records and a sentence, so it stays far
    // under. A digest over larger upstreams wants `path` plus an
    // atomicWriteJson under the home instead, never both.
    artifacts_produced: [{ type: 'digest', format: 'json', body: JSON.stringify(digest) }],
  })
}
