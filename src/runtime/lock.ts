import { z } from 'zod'
import { writeFile, unlink, readFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'

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

/**
 * Every function below takes its lock path as a REQUIRED first parameter.
 *
 * There used to be a module-load-time constant here holding `lockPath()`,
 * which is the one thing `src/lib/paths.ts:17-21` tells you not to write:
 * a path frozen at import time survives a later re-root. `bench/run.ts` swaps
 * `WARPLINE_HOME` per iteration and `bench/arms.ts` calls `runAdvance()` with
 * no options, so a frozen default would put the bench's lock in the wrong home
 * and let two advances both acquire — the exact failure the lock exists to
 * prevent. The derivation belongs at the call site, in the engine.
 *
 * Do NOT bring the default back as `lockPath: string = lockPath()`: inside
 * these signatures the parameter shadows the accessor of the same name, so
 * that initialiser is a TDZ error at call time.
 */

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
  lockPath: string,
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

export async function releaseLock(lockPath: string): Promise<void> {
  try {
    await unlink(lockPath)
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}

/**
 * Read the lock back, or null — for an absent file, for a truncated one, and
 * for JSON that is not a lock. Callers get one answer for "I could not read a
 * lock here", and none of them may unlink on it.
 */
export async function readLock(lockPath: string): Promise<WarplineLock | null> {
  try {
    const raw = JSON.parse(await readFile(lockPath, 'utf-8'))
    const result = WarplineLockSchema.safeParse(raw)
    return result.success ? result.data : null
  } catch {
    return null
  }
}
