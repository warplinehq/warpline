import { join } from 'node:path'
import { warplineHome } from 'warpline/lib/paths'
import type { CapabilityHandlerFn } from 'warpline/unstable-capabilities'
import { atomicWriteJson, readJsonOrNull } from 'warpline/unstable-fs'
import { skillFailure, skillOk } from 'warpline/unstable-result'

interface Issue {
  number?: number
  title: string
  labels: { name: string }[]
  pull_request?: unknown
}

/**
 * What one poll leaves behind for the next: when it looked, how many issues
 * were open, and the newest issue number it saw. One record, overwritten every
 * run; nothing older is kept. A plugin that needs to look further back than
 * its own last run is a different shape, and the runtime-spec's "derive,
 * don't store" note says why this one does not.
 */
interface Snapshot {
  observed_at: string
  open_count: number
  newest_number: number | null
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

/** The highest issue number in the payload, PRs excluded; null when there are none. */
function newestNumber(issues: Issue[]): number | null {
  let newest: number | null = null
  for (const issue of issues) {
    if (issue.pull_request || typeof issue.number !== 'number') continue
    if (newest === null || issue.number > newest) newest = issue.number
  }
  return newest
}

function describe(counts: Record<string, number>): string {
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([name, n]) => `${name}:${n}`).join(' ')
  return `${total} open issues${top ? ` (${top})` : ''}`
}

/** What moved between two snapshots, in the words an operator reads. */
function delta(prior: Snapshot, now: Snapshot): string {
  const parts: string[] = []
  if (now.open_count !== prior.open_count) parts.push(`open ${prior.open_count} -> ${now.open_count}`)
  if (now.newest_number !== null && now.newest_number !== prior.newest_number) {
    parts.push(`newest issue is now #${now.newest_number}`)
  }
  return parts.length === 0 ? 'no change' : parts.join(', ')
}

export const handler: CapabilityHandlerFn = async (manifest, args, signal, _capabilities) => {
  const repo = args.repo
  // Names the key and the shape expected of it, never the value it was handed:
  // this message lands in a run log, and the value can arrive from the
  // operator's config file.
  if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return skillFailure(
      'parse_error',
      "input 'repo' must be a string in owner/name form, e.g. oven-sh/bun",
      { phases_failed: [manifest.name], impact: 'HIGH', retryable: false },
    )
  }

  // The snapshot this plugin wrote last time, if it has run in this home
  // before. The path is derived from the manifest name, never from `args`.
  // Not caught: a null is a first run, and any other failure is a real one —
  // swallowing it would report a first observation over a file that exists
  // and cannot be read.
  const snapshotPath = join(warplineHome(), 'state', `${manifest.name}.last.json`)
  const prior = await readJsonOrNull<Snapshot>(snapshotPath)

  // Forward the runtime's AbortSignal so the per-attempt timeout can cancel
  // the request instead of orphaning it.
  let res: Response
  try {
    res = await fetch(
      `https://api.github.com/repos/${repo}/issues?state=open&per_page=100`,
      { signal, headers: { accept: 'application/vnd.github+json', 'user-agent': 'warpline-example' } },
    )
  } catch (err) {
    // An abort is the runtime's own timeout or cancellation, and it classifies
    // the run by the signal, so the rejection goes back to it untouched. Any
    // other fetch error's message embeds the request URL, and with it the
    // configured repo, so the message is dropped rather than forwarded.
    if (signal.aborted) throw err
    return skillFailure(
      'dependency_unavailable',
      `${manifest.name}: request to GitHub for the configured repo failed`,
      { phases_failed: [manifest.name], impact: 'MEDIUM' },
    )
  }
  if (!res.ok) {
    const retryable = res.status === 429 || res.status >= 500
    return skillFailure(
      'dependency_unavailable',
      `GitHub API ${res.status} for the configured repo`,
      { phases_failed: [manifest.name], impact: 'MEDIUM', retryable },
    )
  }

  const issues = (await res.json()) as Issue[]
  const counts = summariseByLabel(issues)
  const observedAt = new Date().toISOString()
  const now: Snapshot = {
    observed_at: observedAt,
    open_count: Object.values(counts).reduce((a, b) => a + b, 0),
    newest_number: newestNumber(issues),
  }
  await atomicWriteJson<Snapshot>(snapshotPath, now)

  const summary = prior === null
    ? `${manifest.name}: first observation: ${describe(counts)}`
    : `${manifest.name}: since ${prior.observed_at}: ${delta(prior, now)}; now ${describe(counts)}`

  return skillOk(summary, {
    phases_completed: [manifest.name],
    data_freshness: { github_issues: observedAt },
    // One Output, inline: the snapshot — when, how many, and the newest
    // number — which is what a digest declaring this plugin as a dependency
    // wants, and not the issue payload. Three scalars sit far under the
    // 16 KiB UTF-8 body cap; the configured repo is not in it.
    artifacts_produced: [{ type: 'issues-snapshot', format: 'json', body: JSON.stringify(now) }],
  })
}
