import type { CapabilityHandlerFn } from 'warpline/unstable-capabilities'
import type { OutputRecord } from 'warpline/schemas/skill-result'
import { readJsonOrNull } from 'warpline/unstable-fs'
import { skillOk } from 'warpline/unstable-result'

/**
 * The two upstream shapes, one per declared dependency — each read from the
 * Output record that producer last returned, handed over by the runtime.
 *
 * anomaly-watch's Output body, the `anomalies` output it declares:
 * { "observed_at": "...", "anomalies": [ { "name": "error_count", "latest": 42, "threshold": 10, "direction": "above" } ] }
 *
 * github-poll's Output body, the snapshot it declares:
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
 * The parsed content of one dependency's last Output, or `null`.
 *
 * An Output carries exactly one of `body` or `path`, and the schema refuses
 * anything else; `readJsonOrNull` covers the `path` form and is null for a file
 * that is not there. Both halves can throw on content this plugin did not
 * author — `JSON.parse` on a body that is not JSON, `readJsonOrNull` on a path
 * it cannot read — and a throw out of a handler is a failed run with no
 * structure, which the runtime tells you not to return. So it is caught and
 * settles to `null`, which the per-source shape guards below then read as
 * "that source has nothing usable yet".
 */
async function readOutput(record: OutputRecord | null): Promise<unknown> {
  if (record === null) return null
  try {
    return record.body !== undefined ? (JSON.parse(record.body) as unknown) : await readJsonOrNull<unknown>(record.path!)
  } catch {
    return null
  }
}

/**
 * The bodies are strings other plugins authored, so each is checked against the
 * one field this digest reads from it rather than trusted. Anything else is the
 * same state as "has produced nothing yet": there is no line to write.
 */
function asAnomalies(raw: unknown): Anomalies | null {
  return typeof raw === 'object' && raw !== null && Array.isArray((raw as Anomalies).anomalies) ? (raw as Anomalies) : null
}

function asIssues(raw: unknown): IssuesSnapshot | null {
  return typeof raw === 'object' && raw !== null && typeof (raw as IssuesSnapshot).open_count === 'number'
    ? (raw as IssuesSnapshot)
    : null
}

export const handler: CapabilityHandlerFn = async (manifest, _args, _signal, capabilities) => {
  // The seam, not a convention. The runtime hands a handler what each of its
  // DECLARED dependencies last produced; both names below are declared in
  // `manifest.dependencies`, and a name that is not throws here rather than
  // reading `null` — a typo and a producer that has not run are two unrelated
  // fixes, and the wrong one is the one that looks like waiting.
  const anomalies = asAnomalies(await readOutput(capabilities.dependencies.lastOutput(capabilities.caller, 'anomaly-watch')))
  const issues = asIssues(await readOutput(capabilities.dependencies.lastOutput(capabilities.caller, 'github-poll')))

  if (anomalies === null && issues === null) {
    // NOT a bare `skipped`: a prefix-less `skipped` is persisted as `failed`,
    // and "no data yet" must not paint a red run. And NO Output: an empty
    // digest returned as one would become the engine's last_output for this
    // plugin, and a downstream reader would take a day that was never
    // digested for one that was.
    return skillOk(`${manifest.name}: neither dependency has produced anything yet — nothing to digest`, {
      phases_completed: [manifest.name],
    })
  }

  // A missing upstream is not a failure of the digest: the digest says which
  // source had nothing, so it never reads as complete when it is not.
  const lines = [
    `anomaly-watch: ${anomalies === null ? 'nothing yet' : describeAnomalies(anomalies)}`,
    `github-poll: ${issues === null ? 'nothing yet' : describeIssues(issues)}`,
  ]
  const observedAt = new Date().toISOString()
  const digest = {
    observed_at: observedAt,
    sources: { 'anomaly-watch': anomalies, 'github-poll': issues },
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
