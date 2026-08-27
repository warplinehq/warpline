import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { PluginManifest } from 'warpline/schemas/plugin-manifest'
import { makeSkillError, type SkillError, type SkillResult } from 'warpline/schemas/skill-result'
import { warplineHome } from 'warpline/lib/paths'

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

/** Anomalies not yet in the ledger. */
export function pending(anomalies: Anomaly[], filed: Record<string, string>): Anomaly[] {
  return anomalies.filter(a => !(a.name in filed))
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
      const aborted = signal.aborted
      return {
        created,
        error: makeSkillError(
          aborted ? 'timeout' : 'dependency_unavailable',
          `${aborted ? 'aborted' : 'request failed'} filing ${a.name} on ${repo}: ${err instanceof Error ? err.message : String(err)}`,
          { impact: 'HIGH', retryable: false },
        ),
      }
    }
    if (!res.ok) {
      const code = res.status === 401 || res.status === 403 ? 'auth_failure' : 'dependency_unavailable'
      return {
        created,
        error: makeSkillError(code, `GitHub API ${res.status} filing ${a.name} on ${repo}`, { impact: 'HIGH', retryable: false }),
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
      created.push({ name: a.name, url: `https://github.com/${repo}/issues (url not returned)` })
      return {
        created,
        error: makeSkillError('parse_error', `GitHub API returned no html_url for ${a.name}`, { impact: 'HIGH', retryable: false }),
      }
    }
    created.push({ name: a.name, url: html_url })
  }
  return { created, error: null }
}

function fail(error: SkillError, summary: string): SkillResult {
  return {
    status: 'failed',
    phases_completed: [],
    phases_failed: ['anomaly-issue'],
    errors: [error],
    data_freshness: {},
    summary,
    artifacts_produced: [],
    schema_version: 1,
  }
}

export async function handler(
  _manifest: PluginManifest,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<SkillResult> {
  const repo = args.repo
  if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return fail(
      makeSkillError('parse_error', `repo must be owner/name, got: ${String(repo)}`, { impact: 'HIGH', retryable: false }),
      'anomaly-issue: invalid repo input',
    )
  }

  // The token goes into the authorization header and nowhere else — never a
  // summary, an error message or a log line.
  const token = process.env.GITHUB_TOKEN
  if (!token) {
    return fail(
      makeSkillError('auth_failure', 'GITHUB_TOKEN is not set', { impact: 'HIGH', retryable: false }),
      'anomaly-issue: GITHUB_TOKEN is not set',
    )
  }

  const anomaliesPath = typeof args.anomalies_path === 'string'
    ? args.anomalies_path
    : join(warplineHome(), 'state', 'anomalies.json')
  let anomalies: Anomaly[]
  try {
    const raw = JSON.parse(await readFile(anomaliesPath, 'utf-8'))
    anomalies = Array.isArray(raw.anomalies) ? raw.anomalies : []
  } catch {
    // NOT a bare `skipped`: deriveRunStatus persists a prefix-less `skipped`
    // as `failed`, and "no data yet" must not paint a red run.
    return {
      status: 'success',
      phases_completed: ['anomaly-issue'],
      phases_failed: [],
      errors: [],
      data_freshness: {},
      summary: `no anomalies file at ${anomaliesPath} — nothing to file`,
      artifacts_produced: [],
      schema_version: 1,
    }
  }

  const ledgerPath = join(warplineHome(), 'state', 'anomaly-issue.filed.json')
  let filed: Record<string, string> = {}
  try {
    const raw = JSON.parse(await readFile(ledgerPath, 'utf-8'))
    if (raw && typeof raw.filed === 'object' && raw.filed !== null) filed = raw.filed
  } catch (err) {
    // ENOENT is "no ledger yet". Everything else — EACCES, EISDIR, a
    // truncated file — must NOT read as an empty ledger: that re-files every
    // anomaly AND overwrites the history that would have stopped it.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return fail(
        makeSkillError('parse_error', `cannot read ledger ${ledgerPath}: ${err instanceof Error ? err.message : String(err)}`, { impact: 'HIGH', retryable: false }),
        'anomaly-issue: ledger unreadable — refusing to file (would duplicate)',
      )
    }
  }

  // No per-run cap on issue count: the input file is operator-side, the run
  // is approval-gated before execution and supervised-reviewed after. Caps
  // belong to the runtime's guardrails, not to a plugin.
  const todo = pending(anomalies, filed)
  if (todo.length === 0) {
    return {
      status: 'success',
      phases_completed: ['anomaly-issue'],
      phases_failed: [],
      errors: [],
      data_freshness: { anomalies: new Date().toISOString() },
      summary: `no new anomalies (${Object.keys(filed).length} already filed)`,
      artifacts_produced: [],
      schema_version: 1,
    }
  }

  const { created, error } = await fileIssues(repo, todo, token, fetch, signal)

  // Ledger FIRST, before any result is built — on every path that filed
  // something. A retry that finds the ledger sees these as already filed.
  if (created.length > 0) {
    for (const { name, url } of created) filed[name] = url
    await mkdir(dirname(ledgerPath), { recursive: true })
    await writeFile(`${ledgerPath}.tmp`, JSON.stringify({ filed }, null, 2))
    await rename(`${ledgerPath}.tmp`, ledgerPath)
  }

  const status = error === null ? 'success' : created.length > 0 ? 'partial' : 'failed'
  const summary = `filed ${created.length} issues on ${repo}: ${created.map(c => c.name).join(', ')}`
    + (error ? `; stopped at ${todo[created.length]?.name}: ${error.message}` : '')
  return {
    status,
    phases_completed: created.length > 0 ? ['anomaly-issue'] : [],
    phases_failed: status === 'failed' ? ['anomaly-issue'] : [],
    errors: error ? [error] : [],
    data_freshness: { anomalies: new Date().toISOString() },
    summary,
    artifacts_produced: [],
    schema_version: 1,
    ...(created.length > 0 && {
      reversible: false,
      undo_instruction: `Close by hand — GitHub issues cannot be deleted by the API: ${created.map(c => c.url).join(', ')}`,
    }),
  }
}
