/**
 * State manager — single entry point for all engine/board state reads and writes.
 *
 * Every consumer (CLI, engine, plugins, a dashboard) imports from this one
 * module. Stratified internals:
 *   - MutableStateStore: locked read-modify-write for tasks + acknowledgements
 *   - AppendOnlyStore: atomic append for events (no locking needed)
 *
 * Advisory lockfile with 10s stale auto-expiry.
 *
 * (Extraction note: the source system also managed hypotheses and
 * active-experiments here — domain concerns, cut from core. Hosts keep such
 * data in their own modules or in the EngineState `extensions` bag.)
 */
import { readFile, writeFile, rename, open, unlink, appendFile } from 'node:fs/promises'
import { appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { z } from 'zod'
import {
  readEngineState,
  writeEngineState,
  TaskAgingSchema,
  DeferralSchema,
  TaskStateEnum,
  type EngineState,
  type TaskAging,
  type Deferral,
  type TaskDisplay,
  type TaskState,
} from '../schemas/engine-state.js'
import { BoardEventSchema, AcknowledgementsSchema } from '../schemas/board.js'
import type { BoardEvent, Acknowledgements } from '../schemas/board.js'
import { stateDir, warplineHome } from '../lib/paths.js'

// ── Path configuration (injectable for tests) ────────────────────

export interface StatePaths {
  v2StatePath: string
  eventsPath: string
  acksPath: string
  lockPath: string
}

/**
 * Every path the state manager touches, derived from the location of the v2 state
 * file. The sibling filenames live here and nowhere else — a caller redirecting
 * state at a fixture directory (`verify-tasks --state`) gets the whole set moved
 * with it, so adding a seventh path here cannot leave one caller still pointing at
 * the real state directory.
 */
export function pathsForStateFile(
  v2StatePath: string,
  overrides: Partial<StatePaths> = {},
): StatePaths {
  return {
    v2StatePath,
    eventsPath: join(v2StatePath, '..', 'events.jsonl'),
    acksPath: join(v2StatePath, '..', 'acknowledgements.json'),
    lockPath: join(v2StatePath, '..', '.state.lock'),
    ...overrides,
  }
}

// eventsPath is passed explicitly rather than derived: events.jsonl is
// resolved independently in paths.ts and the two must not silently diverge.
import { eventsJsonlPath } from '../lib/paths.js'

function defaultPaths(): StatePaths {
  return pathsForStateFile(join(stateDir(), 'engine-state.json'), {
    eventsPath: eventsJsonlPath(),
  })
}

let paths: StatePaths | null = null

function activePaths(): StatePaths {
  return paths ?? defaultPaths()
}

/** Test-only: override all paths for isolated testing. Pass null to restore defaults. */
export function _setPaths(override: StatePaths | null): void {
  paths = override
}

/**
 * Test-only: snapshot the current paths so a test file that calls `_setPaths`
 * can restore the global in `afterAll` and not leak a deleted temp lock path
 * into sibling files in the same bun process (the source system's mock-leak footgun).
 */
export function _getPaths(): StatePaths {
  return { ...activePaths() }
}

// ── Advisory lock (D-03) ─────────────────────────────────────────

const LOCK_TIMEOUT_MS = 10_000

async function acquireLock(): Promise<() => Promise<void>> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  while (true) {
    try {
      // O_EXCL: atomic create — fails if file exists
      const fd = await open(activePaths().lockPath, 'wx')
      await fd.writeFile(String(Date.now()))
      await fd.close()
      return async () => { try { await unlink(activePaths().lockPath) } catch {} }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      // Check staleness
      try {
        const written = parseInt(await readFile(activePaths().lockPath, 'utf-8'), 10)
        if (!isNaN(written) && Date.now() - written > LOCK_TIMEOUT_MS) {
          await unlink(activePaths().lockPath) // stale — break it
          continue
        }
      } catch {}
      if (Date.now() > deadline) throw new Error('Could not acquire state lock after 10s')
      await sleep(50)
    }
  }
}

export async function withStateLock<T>(fn: () => Promise<T>): Promise<T> {
  const release = await acquireLock()
  try { return await fn() }
  finally { await release() }
}

// ── Age badge formatting (absorbed from task-actions.ts per D-27) ─

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000
const WEEK_MS = 7 * DAY_MS

function formatAge(createdAt: string): string {
  const ageMs = Date.now() - new Date(createdAt).getTime()
  if (ageMs < HOUR_MS) return 'new'
  if (ageMs < DAY_MS) return `${Math.floor(ageMs / HOUR_MS)}h`
  if (ageMs < WEEK_MS) return `${Math.floor(ageMs / DAY_MS)}d`
  return `${Math.floor(ageMs / WEEK_MS)}w`
}

// ── Sort helper (absorbed from task-actions.ts per D-27) ─────────

const SEVERITY_ORDER: Record<string, number> = { critical: 0, warning: 1, info: 2 }

function sortByPriority(a: TaskDisplay, b: TaskDisplay): number {
  const sd = (SEVERITY_ORDER[a.severity] ?? 2) - (SEVERITY_ORDER[b.severity] ?? 2)
  if (sd !== 0) return sd
  return a.created_at.localeCompare(b.created_at)
}

// ── toTaskDisplay (D-23) ─────────────────────────────────────────

export function toTaskDisplay(task: TaskAging, deferrals: Deferral[], completedIds: Set<string>): TaskDisplay {
  const deferral = deferrals.find(
    d => d.task_id === task.task_id && new Date(d.expires_at).getTime() > Date.now()
  )
  let state: TaskState = 'pending'
  let deferred_until: string | null = null
  if (completedIds.has(task.task_id)) {
    state = 'completed'
  } else if (deferral) {
    state = 'deferred'
    deferred_until = deferral.expires_at
  }
  return {
    ...task,
    state,
    deferred_until,
    age_badge: formatAge(task.first_flagged),
    created_at: task.first_flagged, // map first_flagged -> created_at for dashboard compat
  }
}

// ── Mutable state: Tasks (D-04, D-26) ───────────────────────────

export async function readTasks(): Promise<TaskDisplay[]> {
  const state = await readEngineState(activePaths().v2StatePath)
  const completedIds = new Set(state.completed_tasks.map(t => t.task_id))
  return state.task_aging
    .map(t => toTaskDisplay(t, state.deferrals, completedIds))
    .sort(sortByPriority)
}

export async function createTask(
  task: Omit<TaskAging, 'run_count' | 'clean_streak' | 'last_detail' | 'source_check' | 'action_type' | 'extensions'> & Partial<Pick<TaskAging, 'run_count' | 'clean_streak' | 'last_detail' | 'source_check' | 'action_type' | 'extensions'>>
): Promise<void> {
  await withStateLock(async () => {
    const state = await readEngineState(activePaths().v2StatePath)
    const full: TaskAging = { run_count: 1, clean_streak: 0, last_detail: '', source_check: '', action_type: 'self_directed', extensions: {}, ...task }
    state.task_aging.push(full)
    await writeEngineState(state, activePaths().v2StatePath)
  })
}

export async function completeTask(taskId: string): Promise<void> {
  await withStateLock(async () => {
    const state = await readEngineState(activePaths().v2StatePath)
    const idx = state.task_aging.findIndex(t => t.task_id === taskId)
    if (idx === -1) return
    const [task] = state.task_aging.splice(idx, 1)
    state.completed_tasks.push({
      task_id: task.task_id,
      description: task.description,
      severity: task.severity,
      source_check: task.source_check,
      completed_at: new Date().toISOString(),
      extensions: task.extensions,
    })
    await writeEngineState(state, activePaths().v2StatePath)
  })
}

export async function deferTask(taskId: string, until: string): Promise<void> {
  await withStateLock(async () => {
    const state = await readEngineState(activePaths().v2StatePath)
    state.deferrals.push({
      task_id: taskId,
      reason: 'user-deferred',
      deferred_at: new Date().toISOString(),
      expires_at: until,
    })
    await writeEngineState(state, activePaths().v2StatePath)
  })
}

export async function checkTaskLock(pluginName: string): Promise<boolean> {
  const state = await readEngineState(activePaths().v2StatePath)
  const completedIds = new Set(state.completed_tasks.map(t => t.task_id))
  return state.task_aging.some(task => {
    if (task.source_check !== pluginName) return false
    if (completedIds.has(task.task_id)) return false
    const deferred = state.deferrals.find(
      d => d.task_id === task.task_id && new Date(d.expires_at).getTime() > Date.now()
    )
    return !deferred // active = not completed and not deferred
  })
}

// ── Mutable state: Acknowledgements ──────────────────────────────

export async function readAcks(): Promise<Acknowledgements> {
  try {
    const raw = JSON.parse(await readFile(activePaths().acksPath, 'utf-8'))
    const result = AcknowledgementsSchema.safeParse(raw)
    return result.success ? result.data : {}
  } catch { return {} }
}

export async function writeAcks(acks: Acknowledgements): Promise<void> {
  await withStateLock(async () => {
    const tmp = `${activePaths().acksPath}.tmp`
    await writeFile(tmp, JSON.stringify(acks, null, 2))
    await rename(tmp, activePaths().acksPath)
  })
}

// ── Append-only state: Events (D-08) ────────────────────────────

export async function readEvents(): Promise<BoardEvent[]> {
  let content: string
  try {
    content = await readFile(activePaths().eventsPath, 'utf-8')
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }

  const lines = content.split('\n').filter(l => l.trim().length > 0)
  const events: BoardEvent[] = []

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line)
      const result = BoardEventSchema.safeParse(parsed)
      if (result.success) events.push(result.data)
    } catch {
      // Silently drop non-JSON lines
    }
  }

  return events.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
}

export async function appendEvent(event: BoardEvent): Promise<void> {
  appendFileSync(activePaths().eventsPath, JSON.stringify(event) + '\n')
}

// ── Generic state access (D-04) ──────────────────────────────────

export async function readState(): Promise<EngineState> {
  return readEngineState(activePaths().v2StatePath)
}

export async function mutateState(fn: (state: EngineState) => void): Promise<void> {
  await withStateLock(async () => {
    const state = await readEngineState(activePaths().v2StatePath)
    fn(state)
    await writeEngineState(state, activePaths().v2StatePath)
  })
}
