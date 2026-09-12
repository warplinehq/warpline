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

/**
 * The run lock is held by someone else, and this process is not going to wait.
 *
 * `name` is assigned explicitly because the codebase duck-types on `err.name`
 * rather than `instanceof` (`warpline.ts:119`), which is what lets the CLI map
 * a contention to an exit code without importing this class.
 */
export class AdvanceLockedError extends Error {
  readonly lockPath: string
  readonly pid: number | null
  constructor(lockPath: string, pid: number | null, detail?: string) {
    super(
      detail ??
        (pid === null
          ? `Run lock at ${lockPath} is held by an orchestrator session.`
          : `Run lock at ${lockPath} is held by PID ${pid}.`)
    )
    this.name = 'AdvanceLockedError'
    this.lockPath = lockPath
    this.pid = pid
  }
}

/**
 * The refusal to raise when the lock is held and must not be broken.
 *
 * A `null` holder is an unreadable one: `readLock` answers `null` for a
 * truncated file and for JSON that is not a lock, and neither may be unlinked.
 * Unlinking a file whose contents you could not verify is how two writers get
 * one home; an operator who can write a malformed lock can deny service, which
 * is the strictly better failure.
 */
function lockedError(lockPath: string, held: WarplineLock | null): AdvanceLockedError {
  if (held === null) {
    return new AdvanceLockedError(
      lockPath,
      null,
      `Run lock at ${lockPath} is held by a file that could not be read back as a lock; refusing rather than breaking it.`
    )
  }
  return new AdvanceLockedError(lockPath, held.pid)
}

/**
 * Take the run lock, healing one stale holder.
 *
 * Refuses rather than waits. Under a 15-minute scheduler tick the tick IS the
 * retry, and a waiting acquire under a scheduler is a queue of advances nobody
 * asked for. So: one exclusive create, and on contention exactly one heal and
 * one retry — no loop, no timeout, no flag that breaks a held lock.
 */
export async function acquireLock(
  lockPath: string,
  mode: string = 'health',
  opts: { pid?: number | null } = {}
): Promise<WarplineLock> {
  // { flag: 'wx' } = O_CREAT|O_EXCL — exclusive create, EEXIST if the path is
  // taken, and it refuses a symlink rather than following one. Do not replace
  // it with an existence check and a write; that is the TOCTOU race this flag
  // exists to remove.
  const write = async (): Promise<WarplineLock> => {
    const lock: WarplineLock = {
      acquired_at: new Date().toISOString(),
      run_id: generateRunId(),
      mode,
      pid: opts.pid === undefined ? process.pid : opts.pid,
    }
    await writeFile(lockPath, JSON.stringify(lock, null, 2), { flag: 'wx' })
    return lock
  }

  try {
    return await write()
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }

  const held = await readLock(lockPath)
  if (held === null || !isLockStale(held)) throw lockedError(lockPath, held)

  // Stale. Break it and retry once. The window between the unlink and the
  // retry is the same race `state-manager.ts:112-116` already accepts in
  // production: another process can win the retry, and then this one refuses
  // by name rather than trying again.
  try {
    await unlink(lockPath)
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }

  try {
    return await write()
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    throw lockedError(lockPath, await readLock(lockPath))
  }
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
