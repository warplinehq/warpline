import { z } from 'zod'
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SkillResultSchema } from './skill-result.js'

// runsDir() lives in scripts/shared/paths.ts. This file used to redeclare it as a
// bare '.warpline/runs' literal — a second definition of the same directory that
// only resolved correctly when the process started at the repo root.
import { runsDir } from '../lib/paths.js'
const RETENTION_DAYS = 30

export const SkillInvocationSchema = z.object({
  skill: z.string(),
  result: SkillResultSchema.optional(),
})

export const ModeRunSchema = z.object({
  mode: z.string(),
  status: z.enum(['pass', 'partial', 'fail', 'skipped']),
  skills_invoked: z.array(SkillInvocationSchema).default([]),
})

export const PluginLogEntrySchema = z.object({
  plugin: z.string(),
  status: z.enum(['completed', 'failed', 'skipped', 'gated']),
  started_at: z.string(),
  elapsed_ms: z.number().int(),
  result_summary: z.string(),
  reversible: z.boolean().optional(),
  undo_instruction: z.string().optional(),
  retried: z.boolean().default(false),
})
export type PluginLogEntry = z.infer<typeof PluginLogEntrySchema>

export const RunLogSchema = z.object({
  run_id: z.string(),
  started_at: z.string(),
  completed_at: z.string().nullable(),
  status: z.enum(['complete', 'partial', 'failed', 'interrupted']),
  modes_run: z.array(ModeRunSchema),
  resumed_from: z.string().nullable().default(null),
  summary: z.string(),
  // Task board fields
  tasks_surfaced: z.array(z.object({
    task_id: z.string(),
    severity: z.string(),
    status: z.string(),  // 'new' | 'aged' | 'deferred' | 'resolved'
  })).default([]),
  tasks_resolved: z.array(z.string()).default([]),
  deferrals_active: z.number().default(0),
  verification_results: z.array(z.object({
    task_id: z.string(),
    status: z.string(),
    method: z.string(),
  })).default([]),
  /** Per-plugin execution log entries, written by the engine loop. */
  plugin_entries: z.array(PluginLogEntrySchema).default([]),

  /**
   * Aggregate metrics from this run, for self-reporting.
   * Optional — omitted if metrics computation fails or is unavailable.
   */
  metrics_summary: z.object({
    pipeline: z.object({
      total: z.number(),
      active: z.number(),
      demo_booked: z.number(),
      trial: z.number(),
      converted: z.number(),
      conversion_rate: z.number(),
    }).optional(),
    response_rates: z.array(z.object({
      channel: z.string(),
      touches: z.number(),
      responses: z.number(),
      rate: z.number(),
    })).optional(),
    time_saved: z.object({
      autonomous_tasks_completed: z.number(),
      estimated_minutes_saved: z.number(),
      avg_manual_minutes_per_task: z.number(),
    }).optional(),
    computed_at: z.string(),
  }).optional(),
})

export type RunLog = z.infer<typeof RunLogSchema>
export type ModeRun = z.infer<typeof ModeRunSchema>
export type SkillInvocation = z.infer<typeof SkillInvocationSchema>

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
