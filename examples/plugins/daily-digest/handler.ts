import type { CapabilityHandlerFn, DependenciesHandle } from 'warpline/unstable-capabilities'
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

/** What one source's record SAYS, in the words an operator reads. `lineFor` below turns it into the line. */
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
 * one field this digest reads from it rather than trusted. Anything else lands
 * where a producer that never produced lands: `null`, meaning there is no line
 * to write FROM THE RECORD. Which sentence gets written instead is `lineFor`'s
 * business, and it depends on the source's run status — the two are the same
 * state only from this function's side of the fence.
 */
function asAnomalies(raw: unknown): Anomalies | null {
  return typeof raw === 'object' && raw !== null && Array.isArray((raw as Anomalies).anomalies) ? (raw as Anomalies) : null
}

function asIssues(raw: unknown): IssuesSnapshot | null {
  return typeof raw === 'object' && raw !== null && typeof (raw as IssuesSnapshot).open_count === 'number'
    ? (raw as IssuesSnapshot)
    : null
}

/** How a dependency's last run ended, or `null` when it has never run. */
type RunStatus = ReturnType<DependenciesHandle['lastRun']>

/**
 * The one line for one source, from both facts about it.
 *
 * ONE helper, used by every path that writes a line — the early return and the
 * digest alike. A second wording table beside this one is how the claim being
 * removed here got written in the first place: two places describing the same
 * state, and only one of them corrected.
 *
 * `description` is `null` when this digest has no line to write from the
 * record: never produced, a body that would not parse, or a body that parsed
 * and failed the shape guard. The last two are conflated with the first, and
 * honestly so at this tier — from the digest's side there is no line either
 * way. What is NOT conflated is the pair, which is the whole point:
 *
 *   - a record, and a healthy last run → today's description, unchanged
 *   - a record, and a FAILED last run  → the description, marked as older
 *     than the run that followed it. The record still stands: a run that
 *     produces nothing carries the previous one forward, so this is real work
 *     that was really produced — it is just not current.
 *   - no line, and no run at all       → it has not started
 *   - no line, and a run               → it ran and produced nothing usable
 *
 * What THIS function adds to the string is the dependency's declared name, the
 * closed status enum and this file's own literals — no error text and no path.
 * The `description` it is handed is a different matter: `describeAnomalies`
 * builds it from upstream body values (the producer's anomaly names), so
 * foreign text does reach the line, and the claim is scoped accordingly rather
 * than stated of the whole string. That is why the published digest carries
 * `lines` as an array as well as joined: a reader must never have to re-split
 * foreign text on a separator it does not control.
 */
function lineFor(name: string, description: string | null, run: RunStatus): string {
  if (description === null) {
    // Says "no data from it yet" rather than "has not run yet": a `null` run
    // does not only mean the producer never ran. A host may supply no
    // dependency state at all — `warpline run` is such a host — and then every
    // declared name reads `null` whatever the state document holds. The
    // specific claim would be false on a shipped path; this one is true on
    // both.
    return `${name}: ${run === null ? 'no data from it yet' : 'has run and produced nothing this digest can use'}`
  }
  // No `; ` inside the marker: the lines are joined on that separator, and a
  // reader splitting the digest back into lines would cut this one in half.
  return run === 'failed' ? `${name}: ${description} (from an earlier run — its latest run failed)` : `${name}: ${description}`
}

export const handler: CapabilityHandlerFn = async (manifest, _args, _signal, capabilities) => {
  // The seam, not a convention. The runtime hands a handler what each of its
  // DECLARED dependencies last produced AND how that plugin's last run ended;
  // both names below are declared in `manifest.dependencies`, and a name that
  // is not throws from either member rather than reading `null` — a typo and a
  // producer that has not run are two unrelated fixes, and the wrong one is
  // the one that looks like waiting.
  //
  // Both facts, because neither answers alone: `lastOutput` is `null` only
  // when the producer has never produced an Output, which is a fact about the
  // PLUGIN and not about its last run, and `lastRun` is `null` only when it has
  // never run.
  const anomalies = asAnomalies(await readOutput(capabilities.dependencies.lastOutput(capabilities.caller, 'anomaly-watch')))
  const issues = asIssues(await readOutput(capabilities.dependencies.lastOutput(capabilities.caller, 'github-poll')))
  const anomaliesRun = capabilities.dependencies.lastRun(capabilities.caller, 'anomaly-watch')
  const issuesRun = capabilities.dependencies.lastRun(capabilities.caller, 'github-poll')

  // A missing upstream is not a failure of the digest: the digest says which
  // source had nothing and what state it is in, so it never reads as complete
  // when it is not.
  const lines = [
    lineFor('anomaly-watch', anomalies === null ? null : describeAnomalies(anomalies), anomaliesRun),
    lineFor('github-poll', issues === null ? null : describeIssues(issues), issuesRun),
  ]

  if (anomalies === null && issues === null) {
    // NOT a bare `skipped`: a prefix-less `skipped` is persisted as `failed`,
    // and "no data yet" must not paint a red run. And NO Output: an empty
    // digest returned as one would OVERWRITE a real digest this plugin
    // produced earlier, and the empty one would be what every downstream
    // reader gets from then on.
    //
    // What this does NOT buy, since 13.1-04: it does not stop a downstream
    // reader taking a stale digest for today's. Withholding the Output leaves
    // the PREVIOUS digest in place as `last_output`, and this arm returns
    // `skillOk`, so a consumer reads a record beside `'success'` either way.
    // The currency signal is inside the record — `produced_at` and `run_id`,
    // stamped by the runtime — and a consumer that cares reads those.
    //
    // It used to answer for both sources at once. Two sources can be in two
    // different states, so it reports each by name — from the same helper the
    // digest path uses, which is what stops the two describing one state in
    // two different sets of words.
    return skillOk(`${manifest.name}: ${lines.join('; ')} — nothing to digest`, {
      phases_completed: [manifest.name],
    })
  }

  const observedAt = new Date().toISOString()
  const digest = {
    observed_at: observedAt,
    // `sources` is the raw upstream records and stays that way: a consumer
    // that wants the facts reads those. The staleness marker belongs to the
    // LINE, which is the sentence an operator reads — and it rides the
    // published body, not only the summary, because the body is what a
    // downstream reader parses and where the claim it replaces did its damage.
    sources: { 'anomaly-watch': anomalies, 'github-poll': issues },
    // Both forms, deliberately. `digest` is the sentence an operator reads;
    // `lines` is what a downstream reader consumes. A line carries upstream
    // text — an anomaly named `a; b` puts the join separator inside a line —
    // so a reader recovering the lines by splitting `digest` on `'; '` would
    // cut one in half, and no sanitising of foreign text fixes that as
    // reliably as not asking anyone to re-split it.
    lines,
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
