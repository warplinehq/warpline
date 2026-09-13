import { describe, it, expect, mock, beforeEach, afterEach, setSystemTime } from 'bun:test'
import { writeFile, unlink, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  WarplineLockSchema,
  isLockStale,
  isProcessAlive,
  acquireLock,
  releaseLock,
  readLock,
  generateRunId,
} from '../lock.js'
import type { WarplineLock } from '../lock.js'

const NOW = new Date('2026-04-03T12:00:00Z')

beforeEach(() => {
  setSystemTime(NOW)
})

afterEach(() => {
  setSystemTime()
})

function tmpLock(): string {
  return join(tmpdir(), `warpline-lock-test-${Date.now()}-${Math.random().toString(36).slice(2)}.lock`)
}

describe('WarplineLockSchema', () => {
  it('parses a valid lock', () => {
    const input = {
      acquired_at: '2026-04-03T12:00:00Z',
      run_id: '20260403T120000-abcd1234',
      mode: 'health',
      pid: 12345,
    }
    const result = WarplineLockSchema.safeParse(input)
    expect(result.success).toBe(true)
  })

  it('rejects missing pid field', () => {
    const input = {
      acquired_at: '2026-04-03T12:00:00Z',
      run_id: '20260403T120000-abcd1234',
      mode: 'health',
      // pid missing
    }
    const result = WarplineLockSchema.safeParse(input)
    expect(result.success).toBe(false)
  })
})

describe('isLockStale', () => {
  it('returns true when acquired_at is >2 hours ago', () => {
    const lock: WarplineLock = {
      acquired_at: '2026-04-03T09:00:00Z', // 3 hours ago
      run_id: 'run-1',
      mode: 'health',
      pid: process.pid, // current process (alive)
    }
    expect(isLockStale(lock)).toBe(true)
  })

  it('returns true when PID does not exist', () => {
    const originalKill = process.kill
    const mockKill = mock().mockImplementation((_pid: number, _signal?: number) => {
      throw new Error('ESRCH')
    })
    process.kill = mockKill as unknown as typeof process.kill

    const lock: WarplineLock = {
      acquired_at: '2026-04-03T11:50:00Z', // 10 mins ago (not time-stale)
      run_id: 'run-1',
      mode: 'health',
      pid: 999999,
    }
    expect(isLockStale(lock)).toBe(true)

    process.kill = originalKill
  })

  it('returns false when acquired_at is recent AND PID exists', () => {
    const lock: WarplineLock = {
      acquired_at: '2026-04-03T11:50:00Z', // 10 mins ago
      run_id: 'run-1',
      mode: 'health',
      pid: process.pid, // current process (alive)
    }
    expect(isLockStale(lock)).toBe(false)
  })

  it('returns false when the PID is alive but owned by another user', () => {
    // `kill(pid, 0)` raises EPERM, not ESRCH, for a process this user may not
    // signal. The process is running; we are simply not allowed to touch it.
    // Reading that as dead is what lets the heal path break a live holder's lock.
    const originalKill = process.kill
    const eperm = Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
    process.kill = mock().mockImplementation(() => {
      throw eperm
    }) as unknown as typeof process.kill

    try {
      expect(isProcessAlive(1)).toBe(true)
      const lock: WarplineLock = {
        acquired_at: '2026-04-03T11:50:00Z', // 10 mins ago (not time-stale)
        run_id: 'run-1',
        mode: 'health',
        pid: 1, // init/launchd: alive, root-owned, not ours to signal
      }
      expect(isLockStale(lock)).toBe(false)
    } finally {
      process.kill = originalKill
    }
  })
})

describe('orchestrator-held locks (pid: null)', () => {
  it('WarplineLockSchema parses pid: null', () => {
    const input = {
      acquired_at: '2026-04-03T12:00:00Z',
      run_id: '20260403T120000-abcd1234',
      mode: 'health',
      pid: null,
    }
    const result = WarplineLockSchema.safeParse(input)
    expect(result.success).toBe(true)
  })

  it('isLockStale skips liveness check for pid null — recent lock is fresh', () => {
    const lock: WarplineLock = {
      acquired_at: '2026-04-03T11:50:00Z', // 10 mins ago
      run_id: 'run-1',
      mode: 'intel',
      pid: null,
    }
    expect(isLockStale(lock)).toBe(false)
  })

  it('isLockStale still expires pid-null locks past the 2h TTL', () => {
    const lock: WarplineLock = {
      acquired_at: '2026-04-03T09:00:00Z', // 3 hours ago
      run_id: 'run-1',
      mode: 'intel',
      pid: null,
    }
    expect(isLockStale(lock)).toBe(true)
  })

  it('acquireLock({ pid: null }) writes a null pid to disk', async () => {
    const lockPath = tmpLock()
    try {
      const lock = await acquireLock(lockPath, 'health', { pid: null })
      expect(lock.pid).toBeNull()
      const content = JSON.parse(await (await import('node:fs/promises')).readFile(lockPath, 'utf-8'))
      expect(content.pid).toBeNull()
      expect(WarplineLockSchema.safeParse(content).success).toBe(true)
    } finally {
      try { await unlink(lockPath) } catch { /* already removed */ }
    }
  })
})

describe('acquireLock', () => {
  let lockPath: string

  beforeEach(() => {
    lockPath = tmpLock()
  })

  afterEach(async () => {
    try { await unlink(lockPath) } catch { /* already removed */ }
  })

  it('creates file with { flag: "wx" } pattern', async () => {
    const lock = await acquireLock(lockPath, 'health')
    expect(lock.mode).toBe('health')
    expect(lock.pid).toBe(process.pid)
    // Verify file was created
    const content = JSON.parse(await (await import('node:fs/promises')).readFile(lockPath, 'utf-8'))
    expect(WarplineLockSchema.safeParse(content).success).toBe(true)
  })

})

/**
 * Contention and healing.
 *
 * The error is checked by `name`, never by `instanceof` and never by importing
 * the class — that is how `warpline.ts:119` recognises a typed error, and it is
 * what lets a CLI module map this one to an exit code without an import.
 */
describe('acquireLock — contention and healing', () => {
  let lockPath: string

  beforeEach(() => {
    lockPath = tmpLock()
  })

  afterEach(async () => {
    try { await unlink(lockPath) } catch { /* already removed */ }
  })

  /** A lock fixture on disk, defaulting to a fresh one held by this process. */
  async function holder(over: Partial<WarplineLock> = {}): Promise<WarplineLock> {
    const lock: WarplineLock = {
      acquired_at: '2026-04-03T11:50:00Z', // 10 mins before NOW
      run_id: 'held-run-id',
      mode: 'advance',
      pid: process.pid,
      ...over,
    }
    await writeFile(lockPath, JSON.stringify(lock, null, 2), { flag: 'wx' })
    return lock
  }

  async function refusal(): Promise<Error> {
    try {
      await acquireLock(lockPath, 'advance')
    } catch (e) {
      return e as Error
    }
    throw new Error('acquireLock resolved where it should have refused')
  }

  it('refuses a lock held by a live process, naming the holding PID', async () => {
    await holder()
    const err = await refusal()
    expect(err.name).toBe('AdvanceLockedError')
    expect(err.message).toContain(String(process.pid))
  })

  it('leaves a live holder file byte-identical', async () => {
    await holder()
    const before = await readFile(lockPath, 'utf-8')
    await refusal()
    expect(await readFile(lockPath, 'utf-8')).toBe(before)
  })

  it('heals a lock past the 2h TTL and acquires on the retry', async () => {
    const held = await holder({ acquired_at: '2026-04-03T09:00:00Z' }) // 3h before NOW
    const acquired = await acquireLock(lockPath, 'advance')
    expect(acquired.run_id).not.toBe(held.run_id)
    const onDisk = await readLock(lockPath)
    expect(onDisk?.run_id).toBe(acquired.run_id)
  })

  it('heals a fresh lock whose PID is not alive', async () => {
    await holder({ pid: 999999 })
    const originalKill = process.kill
    process.kill = mock().mockImplementation(() => {
      throw new Error('ESRCH')
    }) as unknown as typeof process.kill
    try {
      const acquired = await acquireLock(lockPath, 'advance', { pid: null })
      expect(acquired.run_id).not.toBe('held-run-id')
    } finally {
      process.kill = originalKill
    }
  })

  it('refuses a fresh pid-null holder without printing a PID', async () => {
    await holder({ pid: null })
    const err = await refusal()
    expect(err.name).toBe('AdvanceLockedError')
    expect(err.message).not.toContain('null')
    expect(err.message).toContain('orchestrator')
  })

  it('refuses a truncated lock file and does not unlink it', async () => {
    await writeFile(lockPath, '{"acquired_at":', { flag: 'wx' })
    const err = await refusal()
    expect(err.name).toBe('AdvanceLockedError')
    expect(err.message).toContain(lockPath)
    expect(await readFile(lockPath, 'utf-8')).toBe('{"acquired_at":')
  })

  it('refuses valid JSON that is not a lock, and does not unlink it', async () => {
    await writeFile(lockPath, '{}', { flag: 'wx' })
    const err = await refusal()
    expect(err.name).toBe('AdvanceLockedError')
    expect(err.message).toContain(lockPath)
    expect(await readFile(lockPath, 'utf-8')).toBe('{}')
  })

  /**
   * "Exactly one retry" is asserted structurally, not behaviourally.
   *
   * Forcing a second EEXIST needs another process to recreate the file in the
   * window between the unlink and the retry, and bun's test runner is one
   * process — the only in-process lever is mocking `node:fs/promises`, which
   * leaks to every other file in the run. A loop is what the assertion is
   * actually guarding against, and a loop is visible in the source, so read the
   * source. The scheduler's 15-minute tick is the retry; a waiting acquire
   * under a scheduler is a queue of advances nobody asked for.
   */
  it('retries exactly once — acquireLock contains no loop', async () => {
    const src = await readFile(join(import.meta.dir, '..', 'lock.ts'), 'utf-8')
    const body = src.slice(src.indexOf('export async function acquireLock'))
    const next = body.indexOf('\nexport ', 1)
    const acquire = next === -1 ? body : body.slice(0, next)
    expect(acquire).toContain('acquireLock')
    expect(acquire).not.toMatch(/\b(while|for)\s*\(/)
  })
})

describe('releaseLock', () => {
  it('removes the lock it took', async () => {
    const lockPath = tmpLock()
    const lock = await acquireLock(lockPath, 'advance')
    await releaseLock(lockPath, lock.run_id)
    expect(await readLock(lockPath)).toBeNull()
    let threw = false
    try {
      await readFile(lockPath)
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })

  /**
   * The shape this exists for, and it is not exotic. An advance whose own lock
   * ages past the two-hour TTL — a laptop that slept mid-advance — has that
   * lock healed and reacquired by the next tick. When the first advance
   * finally finishes, an unconditional unlink in its release deletes the
   * SECOND advance's live lock, and the tick after that acquires cleanly while
   * two advances are still running. One documented steal becomes an unbounded
   * number of them.
   */
  it('leaves a live lock another run acquired in the meantime', async () => {
    const lockPath = tmpLock()
    const mine = await acquireLock(lockPath, 'advance')

    // The heal-and-reacquire, compressed: the next tick's lock is at the same
    // path under a different run id.
    await unlink(lockPath)
    const theirs = await acquireLock(lockPath, 'advance')
    expect(theirs.run_id).not.toBe(mine.run_id)

    await releaseLock(lockPath, mine.run_id)

    const survivor = await readLock(lockPath)
    expect(survivor?.run_id).toBe(theirs.run_id)
    await unlink(lockPath)
  })

  /**
   * Same rule as the acquire path: a file that could not be read back as a
   * lock is refused rather than broken, by every caller, including the one
   * that believes it owns the path.
   */
  it('leaves a file it cannot read back as a lock', async () => {
    const lockPath = tmpLock()
    await writeFile(lockPath, '{}')
    await releaseLock(lockPath, '20260403T120000-deadbeef')
    expect(await readFile(lockPath, 'utf-8')).toBe('{}')
    await unlink(lockPath)
  })

  it('is a no-op on an absent lock', async () => {
    const lockPath = tmpLock()
    await releaseLock(lockPath, '20260403T120000-deadbeef')
    expect(await readLock(lockPath)).toBeNull()
  })
})

describe('generateRunId', () => {
  it('returns string matching pattern YYYY-MM-DDTHHMMSS-[hex]', () => {
    const id = generateRunId()
    // Format: 20260403T120000-[8 hex chars]
    expect(id).toMatch(/^\d{8}T\d{6}-[0-9a-f]{8}$/)
  })
})
