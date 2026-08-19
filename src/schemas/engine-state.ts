/**
 * Engine state — the single JSON document the engine persists between runs.
 *
 * Slimmed at extraction from the source system's fat state schema: domain
 * fields (mode telemetry, outreach bookkeeping, legacy migrations, calendar
 * mirrors) were cut. Hosts that need to hang extra data off the state or off
 * individual tasks use the explicit `extensions` records — schemas here stay
 * strict, so a typo'd core field still fails validation loudly.
 */
import { z } from 'zod'
import { copyFile, readFile, rename, writeFile } from 'node:fs/promises'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { SkillResultSchema } from './skill-result'

// ── Task-board records ────────────────────────────────────────────────────

export const DeferralSchema = z.object({
  task_id: z.string(),
  reason: z.string(),
  deferred_at: z.string(),
  expires_at: z.string(),
})
export type Deferral = z.infer<typeof DeferralSchema>

export const TaskAgingSchema = z.object({
  task_id: z.string(),
  first_flagged: z.string(),
  description: z.string(),
  severity: z.enum(['critical', 'warning', 'info']),
  run_count: z.number().default(1),
  /**
   * Consecutive runs in which this task's source check ran clean without
   * re-flagging it. Gates resolution of recheck-resolved task types behind a
   * confirmation window instead of resolving on one clean run. Reset to 0 on
   * re-flag.
   */
  clean_streak: z.number().default(0),
  last_detail: z.string().default(''),
  /** The action-signal type that produced this task. */
  source_check: z.string().default(''),
  /**
   * The check that produced this task. Distinct from `source_check` (the
   * signal *type*): resolution matches this against the run's checks-ran set,
   * since two checks can share a type. Legacy tasks without it fall back to
   * `source_check` during resolution.
   */
  origin_check: z.string().optional(),
  action_type: z.enum(['guided', 'self_directed']).default('self_directed'),
  /** Tasks with null due_date are NEVER classified as overdue. */
  due_date: z.string().nullable().default(null),
  /** Soft-archive timestamp (suspended tier). Archived tasks are hidden, recoverable. */
  archived_at: z.string().optional(),
  /** Host extension bag — calendar mirrors, reply-tracking, sync opt-outs, … */
  extensions: z.record(z.string(), z.unknown()).default({}),
})
export type TaskAging = z.infer<typeof TaskAgingSchema>

/** Tasks move here on completion — preserves the audit trail. */
export const CompletedTaskSchema = z.object({
  task_id: z.string(),
  description: z.string(),
  severity: z.enum(['critical', 'warning', 'info']),
  source_check: z.string().default(''),
  completed_at: z.string(),
  extensions: z.record(z.string(), z.unknown()).default({}),
})
export type CompletedTask = z.infer<typeof CompletedTaskSchema>

export const TaskStateEnum = z.enum(['pending', 'active', 'completed', 'deferred'])
export type TaskState = z.infer<typeof TaskStateEnum>

export const TaskDisplaySchema = TaskAgingSchema.extend({
  state: TaskStateEnum,
  deferred_until: z.string().nullable().default(null),
  age_badge: z.string(),
  created_at: z.string(), // mapped from first_flagged
})
export type TaskDisplay = z.infer<typeof TaskDisplaySchema>

// ── Engine bookkeeping ────────────────────────────────────────────────────

/** Per-plugin run tracking entry, keyed by plugin name. Drives TTL staleness checks. */
export const PluginRunSchema = z.object({
  last_run_at: z.string(),
  status: z.enum(['success', 'partial', 'failed', 'skipped']),
  duration_ms: z.number().int().optional(),
})
export type PluginRun = z.infer<typeof PluginRunSchema>

/** A supervised plugin's result parked pending human approval of its side effects. */
export const PendingGateSchema = z.object({
  plugin: z.string(),
  run_id: z.string(),
  created_at: z.string(),
  payload_summary: z.string(),
  plugin_result: SkillResultSchema,
})
export type PendingGate = z.infer<typeof PendingGateSchema>

export const EngineStateSchema = z.object({
  schema_version: z.literal(1),
  last_run_id: z.string().nullable().default(null),
  last_run_at: z.string().nullable().default(null),
  /**
   * Last time the engine was invoked (interactive or headless). Drives the
   * degradation tier; null on fresh install → tier 'normal'.
   */
  last_interaction_at: z.string().nullable().default(null),
  plugin_runs: z.record(z.string(), PluginRunSchema).default({}),
  deferrals: z.array(DeferralSchema).default([]),
  task_aging: z.array(TaskAgingSchema).default([]),
  completed_tasks: z.array(CompletedTaskSchema).default([]),
  pending_gates: z.array(PendingGateSchema).default([]),
  /** Host extension bag for anything the engine itself does not read. */
  extensions: z.record(z.string(), z.unknown()).default({}),
})
export type EngineState = z.infer<typeof EngineStateSchema>

export function defaultEngineState(): EngineState {
  return EngineStateSchema.parse({ schema_version: 1 })
}

// ── Persistence ───────────────────────────────────────────────────────────

/**
 * Read engine state, falling back to defaults on missing or corrupt files.
 * Corrupt files are backed up to `{path}.corrupt` before defaults are
 * returned — prevents crash loops without silently destroying evidence.
 */
export async function readEngineState(statePath: string): Promise<EngineState> {
  try {
    const raw = JSON.parse(await readFile(statePath, 'utf-8'))
    const result = EngineStateSchema.safeParse(raw)
    if (result.success) return result.data
    await copyFile(statePath, `${statePath}.corrupt`)
    console.warn(`engine state failed validation, backed up to ${statePath}.corrupt. Using defaults.`)
    return defaultEngineState()
  } catch (err: unknown) {
    const isNotFound = err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT'
    if (!isNotFound) {
      try {
        await copyFile(statePath, `${statePath}.corrupt`)
        console.warn(`engine state unreadable, backed up to ${statePath}.corrupt. Using defaults.`)
      } catch {
        // best-effort backup
      }
    }
    return defaultEngineState()
  }
}

/** Atomic write: temp file + rename, so a crash never leaves a half-written state. */
export async function writeEngineState(state: EngineState, statePath: string): Promise<void> {
  await mkdir(path.dirname(statePath), { recursive: true })
  const tmp = `${statePath}.tmp`
  await writeFile(tmp, JSON.stringify(state, null, 2) + '\n', 'utf-8')
  await rename(tmp, statePath)
}
