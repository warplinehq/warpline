import { z } from 'zod'
import { writeFile, unlink, readFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'

import { lockPath } from '../lib/paths.js'
export const WarplineLockSchema = z.object({
  acquired_at: z.string(),
  run_id: z.string(),
  mode: z.string(),
  /**
   * PID of the lock-holding process, or null for orchestrator-held locks.
   * An LLM-orchestrator session acquires the lock through a short-lived
   * bun process whose PID is dead moments later — a numeric PID there makes
   * every liveness check classify the live run's lock as stale (and clean
   * it mid-run). Null opts out of the liveness check; the 2h TTL still
   * expires abandoned locks.
   */
  pid: z.number().nullable(),
})

export type WarplineLock = z.infer<typeof WarplineLockSchema>

const TWO_HOURS_MS = 2 * 60 * 60 * 1000
const DEFAULT_LOCK_PATH = lockPath()

export function generateRunId(): string {
  const now = new Date()
  const ts = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '')
  const nonce = randomBytes(4).toString('hex')
  return `${ts}-${nonce}`
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function isLockStale(lock: WarplineLock): boolean {
  const age = Date.now() - new Date(lock.acquired_at).getTime()
  if (age > TWO_HOURS_MS) return true
  if (lock.pid !== null && !isProcessAlive(lock.pid)) return true
  return false
}

export async function acquireLock(
  lockPath: string = DEFAULT_LOCK_PATH,
  mode: string = 'health',
  opts: { pid?: number | null } = {}
): Promise<WarplineLock> {
  const lock: WarplineLock = {
    acquired_at: new Date().toISOString(),
    run_id: generateRunId(),
    mode,
    pid: opts.pid === undefined ? process.pid : opts.pid,
  }
  // { flag: 'wx' } = exclusive create, throws EEXIST if file exists
  await writeFile(lockPath, JSON.stringify(lock, null, 2), { flag: 'wx' })
  return lock
}

export async function releaseLock(lockPath: string = DEFAULT_LOCK_PATH): Promise<void> {
  try {
    await unlink(lockPath)
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}

export async function updateLockMode(
  lockPath: string = DEFAULT_LOCK_PATH,
  mode: string
): Promise<WarplineLock> {
  const raw = JSON.parse(await readFile(lockPath, 'utf-8'))
  const lock = WarplineLockSchema.parse(raw)
  const updated: WarplineLock = { ...lock, mode }
  await writeFile(lockPath, JSON.stringify(updated, null, 2))
  return updated
}

export async function readLock(lockPath: string = DEFAULT_LOCK_PATH): Promise<WarplineLock | null> {
  try {
    const raw = JSON.parse(await readFile(lockPath, 'utf-8'))
    const result = WarplineLockSchema.safeParse(raw)
    return result.success ? result.data : null
  } catch {
    return null
  }
}
