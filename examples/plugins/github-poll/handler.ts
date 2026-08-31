import type { PluginManifest } from 'warpline/schemas/plugin-manifest'
import { makeSkillError, type SkillResult } from 'warpline/schemas/skill-result'

interface Issue {
  title: string
  labels: { name: string }[]
  pull_request?: unknown
}

export function summariseByLabel(issues: Issue[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const issue of issues) {
    if (issue.pull_request) continue // the issues API includes PRs; skip them
    const labels = issue.labels.length ? issue.labels.map(l => l.name) : ['(unlabelled)']
    for (const name of labels) counts[name] = (counts[name] ?? 0) + 1
  }
  return counts
}

export async function handler(
  _manifest: PluginManifest,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<SkillResult> {
  const repo = args.repo
  // Names the key and the shape expected of it, never the value it was handed:
  // this message lands in a run log, and the value can arrive from the
  // operator's config file.
  if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return {
      status: 'failed',
      phases_completed: [],
      phases_failed: ['github-poll'],
      errors: [makeSkillError('parse_error', "input 'repo' must be a string in owner/name form, e.g. oven-sh/bun", { impact: 'HIGH', retryable: false })],
      data_freshness: {},
      summary: 'github-poll: invalid repo input',
      artifacts_produced: [],
      schema_version: 1,
    }
  }

  // Forward the runtime's AbortSignal so the per-attempt timeout can cancel
  // the request instead of orphaning it.
  const res = await fetch(
    `https://api.github.com/repos/${repo}/issues?state=open&per_page=100`,
    { signal, headers: { accept: 'application/vnd.github+json', 'user-agent': 'warpline-example' } },
  )
  if (!res.ok) {
    const retryable = res.status === 429 || res.status >= 500
    return {
      status: 'failed',
      phases_completed: [],
      phases_failed: ['github-poll'],
      errors: [makeSkillError('dependency_unavailable', `GitHub API ${res.status} for ${repo}`, { impact: 'MEDIUM', retryable })],
      data_freshness: {},
      summary: `github-poll: GitHub API returned ${res.status}`,
      artifacts_produced: [],
      schema_version: 1,
    }
  }

  const issues = (await res.json()) as Issue[]
  const counts = summariseByLabel(issues)
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([name, n]) => `${name}:${n}`).join(' ')

  return {
    status: 'success',
    phases_completed: ['github-poll'],
    phases_failed: [],
    errors: [],
    data_freshness: { github_issues: new Date().toISOString() },
    summary: `${repo}: ${total} open issues${top ? ` (${top})` : ''}`,
    artifacts_produced: [],
    schema_version: 1,
  }
}
