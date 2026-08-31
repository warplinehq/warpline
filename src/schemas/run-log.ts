import { z } from 'zod'
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

// runsDir() lives in scripts/shared/paths.ts. This file used to redeclare it as a
// bare '.warpline/runs' literal — a second definition of the same directory that
// only resolved correctly when the process started at the repo root.
import { runsDir } from '../lib/paths.js'
const RETENTION_DAYS = 30

export const PluginLogEntrySchema = z.object({
  plugin: z.string(),
  /**
   * `denied` sits beside `gated` as the other outcome of supervision: a human
   * was asked and said no, and the log says so. Recording it as `skipped`
   * instead would put it in the same bucket as "no session Grant" and "still
   * fresh", so the log could no longer tell an unanswered question from an
   * answered one — the conflation a denied outcome exists to remove.
   */
  status: z.enum(['completed', 'failed', 'skipped', 'gated', 'denied']),
  started_at: z.string(),
  elapsed_ms: z.number().int(),
  result_summary: z.string(),
  reversible: z.boolean().optional(),
  undo_instruction: z.string().optional(),
  retried: z.boolean().default(false),
})
export type PluginLogEntry = z.infer<typeof PluginLogEntrySchema>

/**
 * The document an advance writes to `<home>/runs/<run_id>.json`.
 *
 * Deliberately narrow, and narrower than it used to be. Six fields shipped here
 * that nothing in this runtime ever wrote and no document ever described —
 * aggregates and task-board counters carried over from the closed system this
 * core was extracted from. They were public API through `warpline/schemas/*`
 * from 0.1.0 and were removed before an announcement made removal expensive.
 * `src/__tests__/no-orphan-schema-fields.test.ts` is what keeps that condition
 * enforced rather than re-checked by reading.
 *
 * A host that wants run telemetry derives it from `plugin_entries` — the only
 * accumulated field here, and the one the engine actually fills.
 */
export const RunLogSchema = z.object({
  run_id: z.string(),
  started_at: z.string(),
  completed_at: z.string().nullable(),
  status: z.enum(['complete', 'partial', 'failed', 'interrupted']),
  resumed_from: z.string().nullable().default(null),
  summary: z.string(),
  /** Per-plugin execution log entries, written by the engine loop. */
  plugin_entries: z.array(PluginLogEntrySchema).default([]),
})

export type RunLog = z.infer<typeof RunLogSchema>

export function runLogFilename(runId: string): string {
  return `${runId}.json`
}

export async function ensureRunDir(baseDir: string = runsDir()): Promise<string> {
  await mkdir(baseDir, { recursive: true })
  return baseDir
}

export async function writeRunLog(log: RunLog, baseDir: string = runsDir()): Promise<string> {
  const dir = await ensureRunDir(baseDir)
  const filename = runLogFilename(log.run_id)
  const filepath = join(dir, filename)
  await writeFile(filepath, JSON.stringify(log, null, 2))
  return filepath
}

/**
 * ponytail: deletes `*.json` older than the retention window and leaves the
 * `.log` sibling behind, so a pruned run can strand its own transcript — the
 * exact orphan class `trimPluginHistory` unlinks the pair to avoid
 * (`run-artifacts.ts:121-122`). Upgrade path: unlink the pair here too. Fine
 * while the two live in different directories and the strays are small; stop
 * being fine the moment anything prunes a directory holding both.
 */
export async function pruneRunLogs(baseDir: string = runsDir()): Promise<number> {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000
  let pruned = 0
  try {
    const files = await readdir(baseDir)
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      const filepath = join(baseDir, file)
      const stats = await stat(filepath)
      if (stats.mtimeMs < cutoff) {
        await unlink(filepath)
        pruned++
      }
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  return pruned
}

/**
 * Whether the run log a `run_id` names is still on disk.
 *
 * `pruneRunLogs` deletes on mtime, so any stored `run_id` — a `last_output`
 * pointer, a versioned Output's history — can outlive the run it names. That is
 * a defined state rather than an error: the caller renders "run no longer
 * retained" instead of failing.
 */
export function isRunLogRetained(runId: string, baseDir: string = runsDir()): boolean {
  return existsSync(join(baseDir, runLogFilename(runId)))
}

/**
 * What a stored `run_id` resolves to. Three states, and the third is not the
 * second: an event emitted outside any run was never part of one, while a
 * pruned run's record aged out of a directory that used to hold it. Collapsing
 * them loses the only signal that anything was ever there.
 *
 * `kind: 'none'` is the resolution of a null or absent id, so callers hand the
 * field over as-is rather than branching on null before they get here — which
 * is how two readers end up rendering the same fact two ways.
 */
export type RunRef =
  | { kind: 'none' }
  | { kind: 'retained'; run_id: string }
  | { kind: 'not_retained'; run_id: string }

/**
 * Resolve a stored run id against the runs directory. Never throws: a missing
 * directory, a missing file and a null id are all defined answers.
 *
 * One helper for every reader on purpose. A `BoardEvent.run_id` and a
 * `plugin_runs[...].last_output.run_id` dangle for the same reason and must
 * render the same way; a second copy of this branch is how they stop doing so.
 */
export function resolveRunRef(runId: string | null | undefined, baseDir: string = runsDir()): RunRef {
  if (runId === null || runId === undefined || runId === '') return { kind: 'none' }
  return isRunLogRetained(runId, baseDir)
    ? { kind: 'retained', run_id: runId }
    : { kind: 'not_retained', run_id: runId }
}

/** Single-line rendering of a `RunRef`, for any surface that shows a run id. */
export function describeRunRef(ref: RunRef): string {
  switch (ref.kind) {
    case 'none': return 'no run'
    case 'retained': return `run ${ref.run_id}`
    case 'not_retained': return `run no longer retained (${ref.run_id})`
  }
}
