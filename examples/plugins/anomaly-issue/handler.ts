import { join } from 'node:path'
import { makeSkillError, type SkillError } from 'warpline/schemas/skill-result'
import { warplineHome } from 'warpline/lib/paths'
import type { CapabilityHandlerFn } from 'warpline/unstable-capabilities'
import { atomicWriteJson, readJsonOrNull } from 'warpline/unstable-fs'
import { skillFailure, skillOk } from 'warpline/unstable-result'

/**
 * Expected shape of the Output `anomaly-watch` last produced — the element
 * type it declares as its `anomalies` output:
 * {
 *   "anomalies": [
 *     { "name": "error_count", "latest": 42, "threshold": 10, "direction": "above" }
 *   ]
 * }
 *
 * Filed-state ledger, `<home>/state/anomaly-issue.filed.json`:
 * { "filed": { "error_count": "https://github.com/o/r/issues/1" } }
 */
export interface Anomaly {
  name: string
  latest: number
  threshold: number
  direction: 'above' | 'below'
}

type FetchImpl = typeof fetch

/**
 * Anomalies not yet in the ledger.
 *
 * `hasOwn`, not `in`: `in` is true for every `Object.prototype` key, so an
 * anomaly named `constructor` or `toString` would be silently dropped forever.
 */
export function pending(anomalies: Anomaly[], filed: Record<string, string>): Anomaly[] {
  return anomalies.filter(a => !Object.hasOwn(filed, a.name))
}

/** Fixed template; the anomaly's fields are interpolated as data, never evaluated. */
export function issueFor(a: Anomaly): { title: string; body: string } {
  return {
    title: `[anomaly] ${a.name}: ${a.latest} ${a.direction} threshold ${a.threshold}`,
    body: [
      '| field | value |',
      '| --- | --- |',
      `| name | ${a.name} |`,
      `| latest | ${a.latest} |`,
      `| threshold | ${a.threshold} |`,
      `| direction | ${a.direction} |`,
    ].join('\n'),
  }
}

/**
 * POST one issue per anomaly, stopping at the first failure.
 *
 * Every error here is `retryable: false`: the runtime's retry loop re-invokes
 * the whole handler, and the filed-state ledger is the only thing between a
 * retry and a duplicate issue.
 *
 * `stoppedAt` names the anomaly the loop stopped on, set by the arm that
 * stopped. It is not `created.length` counted back into the list: the
 * no-`html_url` arm records the issue as created AND stops, so that count
 * points one past it, at the next anomaly or at nothing.
 */
export async function fileIssues(
  repo: string,
  anomalies: Anomaly[],
  token: string,
  fetchImpl: FetchImpl,
  signal: AbortSignal,
): Promise<{ created: { name: string; url: string }[]; error: SkillError | null; stoppedAt: string | null }> {
  const created: { name: string; url: string }[] = []
  for (const a of anomalies) {
    // Nothing here may throw: a throw skips the caller's ledger write, and
    // every issue already created would be filed a second time on the retry.
    let res: Response
    try {
      res = await fetchImpl(`https://api.github.com/repos/${repo}/issues`, {
        method: 'POST',
        signal,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'user-agent': 'warpline-example',
          'content-type': 'application/json',
        },
        body: JSON.stringify(issueFor(a)),
      })
    } catch (err) {
      // The thrown error's message is dropped, not forwarded: a failed fetch
      // reports the request URL, and that URL embeds the configured repo. The
      // anomaly name and the abort flag are what you act on anyway.
      const aborted = signal.aborted
      return {
        created,
        error: makeSkillError(
          aborted ? 'timeout' : 'dependency_unavailable',
          `${aborted ? 'aborted' : 'request failed'} filing ${a.name}`,
          { impact: 'HIGH', retryable: false },
        ),
        stoppedAt: a.name,
      }
    }
    if (!res.ok) {
      const code = res.status === 401 || res.status === 403 ? 'auth_failure' : 'dependency_unavailable'
      return {
        created,
        error: makeSkillError(code, `GitHub API ${res.status} filing ${a.name}`, { impact: 'HIGH', retryable: false }),
        stoppedAt: a.name,
      }
    }
    let html_url: unknown
    try {
      ;({ html_url } = (await res.json()) as { html_url?: unknown })
    } catch {
      html_url = undefined
    }
    if (typeof html_url !== 'string') {
      // The issue EXISTS on GitHub by now — record it, or the retry duplicates it.
      created.push({ name: a.name, url: '(issue created; the API returned no url)' })
      return {
        created,
        error: makeSkillError('parse_error', `GitHub API returned no html_url for ${a.name}`, { impact: 'HIGH', retryable: false }),
        stoppedAt: a.name,
      }
    }
    created.push({ name: a.name, url: html_url })
  }
  return { created, error: null, stoppedAt: null }
}

/** Every failure here is the plugin's own phase, high impact, and not retried. */
const FAILED = { phases_failed: ['anomaly-issue'], impact: 'HIGH' as const, retryable: false }

// The form docs/plugin-authoring.md shows and `warpline scaffold` emits: the
// annotation supplies all four parameter types and the return type.
export const handler: CapabilityHandlerFn = async (_manifest, args, signal, capabilities) => {
  const repo = args.repo
  if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return skillFailure('parse_error', "input 'repo' must be a string in owner/name form, e.g. oven-sh/bun", FAILED)
  }

  // The token goes into the authorization header and nowhere else — never a
  // summary, an error message or a log line.
  const token = process.env.GITHUB_TOKEN
  if (!token) {
    return skillFailure('auth_failure', 'GITHUB_TOKEN is not set', FAILED)
  }

  // The seam, not a convention. The runtime hands a handler what each of its
  // DECLARED dependencies last produced AND how that plugin's last run ended;
  // `anomaly-watch` is declared in `manifest.dependencies`, and a name that is
  // not throws from either member rather than reading `null` — a typo and a
  // dependency that has not run are two unrelated fixes, and the wrong one is
  // the one that looks like waiting.
  //
  // Both facts, because neither answers alone. `lastOutput` is `null` for one
  // thing only — this plugin has never produced an Output — and that is a fact
  // about the PLUGIN, not about its last run: a run producing none carries the
  // previous record forward. `lastRun` is `null` only when the plugin has never
  // run. Read together they name four states, and this handler reports each.
  const record = capabilities.dependencies.lastOutput(capabilities.caller, 'anomaly-watch')
  const run = capabilities.dependencies.lastRun(capabilities.caller, 'anomaly-watch')
  if (record === null) {
    // NOT a bare `skipped`: deriveRunStatus persists a prefix-less `skipped`
    // as `failed`, and "the producer has not run yet" must not paint a red run.
    // NOT `skillFailure('dependency_unavailable', …)` either — that reddens the
    // ordinary first-advance case and pre-empts a runtime-level gate that is
    // the runtime's to add, not this plugin's. That gate exists now:
    // `dependency_failed` stops a plugin whose declared dependency's last run
    // failed, before the handler is invoked at all. This arm does not change
    // and must not — a host that runs a single plugin directly supplies no
    // dependency state, so every declared name still reads `null` there and
    // this is still the arm that answers for it.
    // And NO Output: an empty one
    // would become this plugin's `last_output`, and a downstream reader would
    // take it for real work.
    //
    // What changed is the sentence, not the arm. It used to claim the producer
    // "has produced nothing yet" whatever state it was in, which is a different
    // thing to chase depending on which of these two it is: one waits for a
    // schedule, the other wants somebody to look at a producer that runs and
    // returns nothing. Only the declared name and the closed status enum are
    // interpolated — never a value read from a record.
    // Says "no data from anomaly-watch yet" rather than "has not run yet": a
    // `null` run does not only mean the producer never ran. A host may supply
    // no dependency state at all — `warpline run` is such a host — and then
    // every declared name reads `null` whatever the state document holds. The
    // specific claim would be false on a shipped path; this one is true on
    // both.
    const state = run === null
      ? 'no data from anomaly-watch yet'
      : `anomaly-watch has run (last run: ${run}) and has never produced an Output`
    return skillOk(`anomaly-issue: ${state} — nothing to file`, {
      phases_completed: ['anomaly-issue'],
    })
  }
  // An Output carries exactly one of `body` or `path`, and the schema refuses
  // anything else. `readJsonOrNull` covers the `path` form and is null for a
  // file that is not there.
  //
  // Caught, because both halves can throw on content this plugin did not
  // author: `JSON.parse` on a body that is not JSON, and `readJsonOrNull` on a
  // path it cannot read. A thrown error out of a handler is a failed run with
  // no structure, which the runtime tells you not to return.
  let raw: { anomalies?: unknown } | null
  try {
    raw = record.body !== undefined
      ? (JSON.parse(record.body) as { anomalies?: unknown } | null)
      : await readJsonOrNull<{ anomalies?: unknown }>(record.path!)
  } catch {
    raw = null
  }
  // The parsed shape is not trusted either: the body is a string another plugin
  // authored, and anything but an array of anomalies is nothing to file.
  const anomalies: Anomaly[] = Array.isArray(raw?.anomalies) ? raw.anomalies : []

  // A record IS here and it predates a failed run — so say so, rather than
  // reporting it as though it were current.
  //
  // Reported, and deliberately NOT acted on: filing is not gated on the run
  // status. The record is real work the producer really produced, and the
  // ledger below dedupes by anomaly name, so a record carried across a failed
  // run re-files nothing that was already filed. A guard here would throw away
  // the one thing preserving the record bought. What a reader sees change is
  // the wording — where the handler used to see nothing at all, it now files
  // whatever is genuinely new and names the record's age.
  const stale = run === 'failed' ? ' — this record is from an earlier run of anomaly-watch, whose latest run failed' : ''

  const ledgerPath = join(warplineHome(), 'state', 'anomaly-issue.filed.json')
  // Null prototype throughout: `filed['__proto__'] = url` on a plain object
  // sets the prototype instead of an own property, and is never serialised —
  // that anomaly would then be re-filed on every run.
  let filed: Record<string, string> = Object.create(null)
  try {
    const raw = await readJsonOrNull<{ filed?: unknown }>(ledgerPath)
    if (raw && typeof raw.filed === 'object' && raw.filed !== null) {
      filed = Object.assign(Object.create(null), raw.filed)
    }
  } catch {
    // null is "no ledger yet". Everything else — EACCES, EISDIR, a truncated
    // file — must NOT read as an empty ledger: that re-files every anomaly AND
    // overwrites the history that would have stopped it. The refusal names
    // neither the path nor the parser's words; both would land in the run log.
    return skillFailure('parse_error', 'anomaly-issue: ledger unreadable — refusing to file (would duplicate)', FAILED)
  }

  // No per-run cap on issue count: the input file is operator-side, the run
  // is approval-gated before execution and supervised-reviewed after. Caps
  // belong to the runtime's guardrails, not to a plugin.
  const todo = pending(anomalies, filed)
  if (todo.length === 0) {
    return skillOk(`no new anomalies (${Object.keys(filed).length} already filed)${stale}`, {
      phases_completed: ['anomaly-issue'],
      data_freshness: { anomalies: new Date().toISOString() },
    })
  }

  const { created, error, stoppedAt } = await fileIssues(repo, todo, token, fetch, signal)

  // Ledger FIRST, before any result is built — on every path that filed
  // something. A retry that finds the ledger sees these as already filed.
  // The atomic writer creates the parent and renames a temp file over the
  // target, so a crash mid-write leaves the old ledger, never half of one.
  if (created.length > 0) {
    for (const { name, url } of created) filed[name] = url
    await atomicWriteJson(ledgerPath, { filed })
  }

  const summary = `filed ${created.length} issues: ${created.map(c => c.name).join(', ')}`
    + (error ? `; stopped at ${stoppedAt}: ${error.message}` : '')
    + stale
  if (created.length === 0 && error !== null) {
    return skillFailure(error.code, summary, { ...FAILED, errors: [error], data_freshness: { anomalies: new Date().toISOString() } })
  }
  const filedSome = skillOk(summary, {
    phases_completed: ['anomaly-issue'],
    data_freshness: { anomalies: new Date().toISOString() },
    errors: error ? [error] : undefined,
    reversible: false,
    // Documented carve-out from the never-echo rule, one field wide: an issue
    // URL contains the configured repo, and an undo instruction that does not
    // name what to close cannot be acted on. See docs/plugin-authoring.md.
    // Every other field of this result stays free of the configured value.
    undo_instruction: `Close by hand — GitHub issues cannot be deleted by the API: ${created.map(c => c.url).join(', ')}`,
  })
  // No builder emits `partial`, and a batch that filed some issues and then
  // stopped is exactly that: the ledger holds what was filed, the error says
  // where it stopped. The status is set over the built result rather than by
  // a fourth hand-written literal.
  return error === null ? filedSome : { ...filedSome, status: 'partial' }
}
