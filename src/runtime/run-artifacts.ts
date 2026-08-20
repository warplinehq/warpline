/**
 * Phase 121 D-26/D-27 — Run artifact persistence for manual + cron plugin runs.
 *
 * Writes `.warpline/runs/<run_id>.json` with the per-attempt extension and a
 * sibling `<run_id>.log` containing captured stdout/stderr with attempt
 * delimiters. Retention trim (`trimPluginHistory`) keeps the 20 newest
 * artifacts per plugin; both JSON + log siblings are deleted atomically so
 * no orphaned .log files accumulate (Pitfall 5 from 121-RESEARCH.md).
 *
 * Default runs directory is resolved relative to this source file so tests
 * can pass `opts.runsDir` pointed at a mkdtemp-backed location.
 */
import { readdir, writeFile, unlink, readFile, appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { runsDir } from '../lib/paths.js'

export interface RunArtifact {
  run_id: string
  plugin: string
  started_at: string
  completed_at: string | null
  status: 'success' | 'failed' | 'cancelled' | 'timeout' | 'running' | 'delegated'
  summary: string
  /** D-38: true when the run was dashboard-triggered. */
  user_initiated: boolean
  /** Per-attempt detail from invokePlugin's retry loop. */
  attempts: Array<{
    attempt: number
    started_at: string
    elapsed_ms: number
    status: string
    error: string | null
  }>
  /** Last error message after retries exhausted; null on success. */
  final_error: string | null
  cancelled: boolean
  timed_out: boolean
  /** Backward-compat: existing engine-run shape. */
  plugin_entries?: unknown[]
  retried?: boolean
}

/**
 * Resolves the default runs directory. Tests pass `opts.runsDir` to redirect
 * writes to an isolated mkdtemp path.
 */
export function getRunsDir(override?: string): string {
  if (override) return override
  return runsDir()
}

export async function writeRunArtifact(
  artifact: RunArtifact,
  opts: { runsDir?: string } = {},
): Promise<void> {
  const dir = getRunsDir(opts.runsDir)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${artifact.run_id}.json`), JSON.stringify(artifact, null, 2))
}

export async function appendRunLog(
  runId: string,
  text: string,
  opts: { runsDir?: string } = {},
): Promise<void> {
  const dir = getRunsDir(opts.runsDir)
  await mkdir(dir, { recursive: true })
  await appendFile(
    join(dir, `${runId}.log`),
    text.endsWith('\n') ? text : text + '\n',
  )
}

/** Convenience: write the attempt delimiter used by `<run_id>.log` tails. */
export async function writeRunLog(
  runId: string,
  attempt: number,
  body: string,
  opts: { runsDir?: string } = {},
): Promise<void> {
  await appendRunLog(runId, `=== Attempt ${attempt} ===\n${body}`, opts)
}

/**
 * Keep the `keep` most recent artifacts for `pluginName`. Deletes both the
 * `.json` and sibling `.log` file together. Returns the number of artifacts
 * evicted so callers can log/assert.
 */
export async function trimPluginHistory(
  pluginName: string,
  keep = 20,
  opts: { runsDir?: string } = {},
): Promise<number> {
  const dir = getRunsDir(opts.runsDir)
  let files: string[]
  try {
    files = await readdir(dir)
  } catch {
    return 0
  }
  const jsonFiles = files.filter((f) => f.endsWith('.json'))
  const matching: Array<{ runId: string; startedAt: string }> = []
  for (const file of jsonFiles) {
    try {
      const raw = await readFile(join(dir, file), 'utf8')
      const parsed = JSON.parse(raw) as Partial<RunArtifact>
      if (parsed.plugin === pluginName && typeof parsed.started_at === 'string') {
        matching.push({
          runId: typeof parsed.run_id === 'string' ? parsed.run_id : file.replace(/\.json$/, ''),
          startedAt: parsed.started_at,
        })
      }
    } catch {
      // Malformed artifact — leave it alone; an operator can inspect manually.
    }
  }
  // Newest first — slice(keep) peels off anything past the retention cap.
  matching.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  const toDelete = matching.slice(keep)
  for (const { runId } of toDelete) {
    await unlink(join(dir, `${runId}.json`)).catch(() => {})
    await unlink(join(dir, `${runId}.log`)).catch(() => {})
  }
  return toDelete.length
}

/**
 * Phase 121 Plan 04 Task 4.2 - Read up to `limit` newest artifacts for a plugin.
 *
 * Reads every .json in the runs directory, parses each, filters by plugin, sorts
 * by started_at DESC, and slices to `limit`. Silently skips malformed artifacts
 * so history rendering stays robust against a single corrupt file.
 */
export async function readRecentRunsForPlugin(
  pluginName: string,
  limit = 20,
  opts: { runsDir?: string } = {},
): Promise<RunArtifact[]> {
  const dir = getRunsDir(opts.runsDir)
  let files: string[]
  try {
    files = await readdir(dir)
  } catch {
    return []
  }
  const jsonFiles = files.filter((f) => f.endsWith('.json'))
  const parsed: RunArtifact[] = []
  for (const file of jsonFiles) {
    try {
      const raw = await readFile(join(dir, file), 'utf8')
      const obj = JSON.parse(raw) as Partial<RunArtifact>
      if (obj.plugin === pluginName && typeof obj.started_at === 'string') {
        parsed.push(obj as RunArtifact)
      }
    } catch {
      // Malformed artifact - leave it out of history.
    }
  }
  parsed.sort((a, b) => b.started_at.localeCompare(a.started_at))
  return parsed.slice(0, limit)
}

/**
 * Phase 121 Plan 04 Task 4.2 - Read the most recent artifact for a plugin, or
 * null if there is none.
 */
export async function readLastRunForPlugin(
  pluginName: string,
  opts: { runsDir?: string } = {},
): Promise<RunArtifact | null> {
  const [first] = await readRecentRunsForPlugin(pluginName, 1, opts)
  return first ?? null
}

