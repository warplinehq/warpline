import { join } from 'node:path'
import type { HandlerFn } from 'warpline'
import type { PluginManifest } from 'warpline/schemas/plugin-manifest'
import { makeSkillError, type SkillError, type SkillResultInput } from 'warpline/schemas/skill-result'
import { warplineHome } from 'warpline/lib/paths'
import { atomicWriteJson, readJsonOrNull } from 'warpline/unstable-fs'
import { skillFailure, skillOk } from 'warpline/unstable-result'

/**
 * Expected anomalies file shape — the element type `anomaly-watch` declares
 * as its `anomalies` output:
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
 */
export async function fileIssues(
  repo: string,
  anomalies: Anomaly[],
  token: string,
  fetchImpl: FetchImpl,
  signal: AbortSignal,
): Promise<{ created: { name: string; url: string }[]; error: SkillError | null }> {
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
      }
    }
    if (!res.ok) {
      const code = res.status === 401 || res.status === 403 ? 'auth_failure' : 'dependency_unavailable'
      return {
        created,
        error: makeSkillError(code, `GitHub API ${res.status} filing ${a.name}`, { impact: 'HIGH', retryable: false }),
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
      }
    }
    created.push({ name: a.name, url: html_url })
  }
  return { created, error: null }
}

/** Every failure here is the plugin's own phase, high impact, and not retried. */
const FAILED = { phases_failed: ['anomaly-issue'], impact: 'HIGH' as const, retryable: false }

export async function handler(
  _manifest: PluginManifest,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<SkillResultInput> {
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

  // A convention, not a seam. `<home>/state/anomalies.json` is a path agreed
  // with a chaining host; the declared dependency, `anomaly-watch`, does not
  // write it. That dependency now returns a real Output on its success arm, so
  // a producer exists — but the reader for it, `readDependencyOutput`, takes an
  // `EngineState`, and a handler is called `(manifest, args, signal,
  // capabilities)`: no engine state reaches it, and `CapabilityContext` has no
  // member that carries one. A plugin cannot call the reader, so this read
  // succeeds whether or not the producer ran. It stays until the runtime hands
  // a plugin a way to read what its dependency produced; then this fallback,
  // the `anomalies_path` input and the manifest's convention paragraph go
  // together.
  const anomaliesPath = typeof args.anomalies_path === 'string'
    ? args.anomalies_path
    : join(warplineHome(), 'state', 'anomalies.json')
  // `readJsonOrNull` is null for ENOENT and rethrows everything else. A file
  // that exists but is corrupt is not "no data yet" — reporting it green under
  // a summary that says "no file" hides it indefinitely — and the rethrown
  // message embeds the operator-configured path, so the catch names the key.
  let rawAnomalies: { anomalies?: unknown } | null
  try {
    rawAnomalies = await readJsonOrNull<{ anomalies?: unknown }>(anomaliesPath)
  } catch {
    return skillFailure('parse_error', "the file named by input 'anomalies_path' is unreadable", FAILED)
  }
  if (rawAnomalies === null) {
    // NOT a bare `skipped`: deriveRunStatus persists a prefix-less `skipped`
    // as `failed`, and "no data yet" must not paint a red run.
    return skillOk('anomaly-issue: no anomalies file at the configured path — nothing to file', {
      phases_completed: ['anomaly-issue'],
    })
  }
  const anomalies: Anomaly[] = Array.isArray(rawAnomalies.anomalies) ? rawAnomalies.anomalies : []

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
    return skillOk(`no new anomalies (${Object.keys(filed).length} already filed)`, {
      phases_completed: ['anomaly-issue'],
      data_freshness: { anomalies: new Date().toISOString() },
    })
  }

  const { created, error } = await fileIssues(repo, todo, token, fetch, signal)

  // Ledger FIRST, before any result is built — on every path that filed
  // something. A retry that finds the ledger sees these as already filed.
  // The atomic writer creates the parent and renames a temp file over the
  // target, so a crash mid-write leaves the old ledger, never half of one.
  if (created.length > 0) {
    for (const { name, url } of created) filed[name] = url
    await atomicWriteJson(ledgerPath, { filed })
  }

  const summary = `filed ${created.length} issues: ${created.map(c => c.name).join(', ')}`
    + (error ? `; stopped at ${todo[created.length]?.name}: ${error.message}` : '')
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

// The only check anywhere that can see the root barrel's type export. `HandlerFn`
// is a type, so it leaves no trace in `dist/index.js` and the tarball probe is
// structurally blind to it; `bun run typecheck` resolves `warpline` from here by
// package self-reference through the exports map into `dist/`. Left as a bare
// `satisfies` rather than annotating the declaration, so the declaration form
// `docs/plugin-authoring.md` shows stays exactly as written.
handler satisfies HandlerFn
