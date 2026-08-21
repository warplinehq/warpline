import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PluginManifest } from 'warpline/schemas/plugin-manifest'
import type { SkillResult } from 'warpline/schemas/skill-result'
import { warplineHome } from 'warpline/lib/paths'

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

export async function handler(
  _manifest: PluginManifest,
  args: Record<string, unknown>,
): Promise<SkillResult> {
  const path = typeof args.entries_path === 'string'
    ? args.entries_path
    : join(warplineHome(), 'state', 'feed-entries.json')

  let entries: FeedEntry[]
  try {
    entries = newEntries(JSON.parse(await readFile(path, 'utf-8')))
  } catch {
    // NOT a bare `skipped`. deriveRunStatus maps a prefix-less `skipped` to
    // `failed`, and `warpline run` persists the artifact — "no data yet" would
    // otherwise paint a red run, the false-alarm class `delegated` exists to
    // kill. (anomaly-watch's catch branch does return `skipped`; that plugin is
    // not driven through a persisting run in the same way.)
    return {
      status: 'success',
      phases_completed: ['feed-triage'],
      phases_failed: [],
      errors: [],
      data_freshness: {},
      summary: `no feed state at ${path} — nothing to triage`,
      artifacts_produced: [],
      schema_version: 1,
    }
  }

  if (entries.length === 0) {
    return {
      status: 'success',
      phases_completed: ['feed-triage'],
      phases_failed: [],
      errors: [],
      data_freshness: { feed_entries: new Date().toISOString() },
      summary: `no new entries at ${path} — nothing to triage`,
      artifacts_produced: [],
      schema_version: 1,
    }
  }

  // The `[needs-llm]` prefix is the entire wire into deriveRunStatus, and the
  // path after `Context:` is the entire payload channel — RunArtifact persists
  // `summary` and drops `artifacts_produced`.
  return {
    status: 'skipped',
    phases_completed: ['feed-triage'],
    phases_failed: [],
    errors: [],
    data_freshness: { feed_entries: new Date().toISOString() },
    summary: `[needs-llm] Triage ${entries.length} new feed entries. Context: ${path}`,
    artifacts_produced: [],
    schema_version: 1,
  }
}
