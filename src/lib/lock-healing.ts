/**
 * Lock healing utilities for headless Warpline runs.
 *
 * Provides acquire/release/detect-stale operations on a PID lock file.
 * Stale detection uses two conditions (either triggers removal):
 *   - Age: lock mtime > 2 × maxTimeoutMs
 *   - PID-dead: PID in lock file cannot receive signal 0 (process.kill)
 *
 * Exists so a stale lock cannot block every future run: a crashed process
 * leaves its lock behind, and without healing that is a permanent outage.
 */
import { readFile, writeFile, unlink, stat } from 'node:fs/promises'

export type StaleResult =
  | { stale: false }
  | { stale: true; reason: 'age' | 'pid-dead' }

/**
 * Write current process PID to lockPath to signal this run is active.
 */
export async function acquireLock(lockPath: string): Promise<void> {
  await writeFile(lockPath, String(process.pid), 'utf-8')
}

/**
 * Remove the lock file. No-op if already absent (ENOENT suppressed).
 */
export async function releaseLock(lockPath: string): Promise<void> {
  await unlink(lockPath).catch(() => {})
}

/**
 * Detect whether an existing lock is stale.
 *
 * Returns `{ stale: false }` if:
 *   - Lock file does not exist (nothing to heal)
 *   - Lock is fresh by age AND recorded PID is alive
 *   - Lock has unparseable PID AND is fresh by age (conservative: not stale)
 *
 * Returns `{ stale: true, reason: 'age' }` if mtime > 2 × maxTimeoutMs.
 * Returns `{ stale: true, reason: 'pid-dead' }` if PID is not alive (and age is fresh).
 */
export async function detectStaleLock(
  lockPath: string,
  maxTimeoutMs: number,
): Promise<StaleResult> {
  const info = await stat(lockPath).catch(() => null)
  if (!info) return { stale: false } // no lock file → nothing to heal

  const ageMs = Date.now() - info.mtimeMs
  if (ageMs > maxTimeoutMs * 2) return { stale: true, reason: 'age' }

  // Age is fresh — check PID liveness
  const raw = await readFile(lockPath, 'utf-8').catch(() => '')
  const pid = parseInt(raw.trim(), 10)
  if (Number.isFinite(pid) && pid > 0) {
    try {
      process.kill(pid, 0) // signal 0 = liveness probe, throws if PID dead
      return { stale: false } // PID alive AND age fresh
    } catch {
      return { stale: true, reason: 'pid-dead' }
    }
  }

  // Unparseable PID AND age is fresh → conservative: not stale
  return { stale: false }
}
