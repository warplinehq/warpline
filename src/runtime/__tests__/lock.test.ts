import { describe, it, expect, mock, beforeEach, afterEach, setSystemTime } from 'bun:test'
import { writeFile, unlink, readFile, mkdtemp, rm, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { snapshotHome } from './helpers/snapshot-home.js'
import {
  WarplineLockSchema,
  isLockStale,
  isProcessAlive,
  acquireLock,
  releaseLock,
  readLock,
  generateRunId,
  deriveHost,
} from '../lock.js'
import type { WarplineLock, MachineIdReader, MachineIdSource } from '../lock.js'

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

/**
 * A machine-id reader that answers from a fixture, recording what it was asked.
 *
 * Every host case below goes through one of these rather than probing the host
 * the suite happens to run on. Links one and two are absent on macOS and link
 * three is absent on Linux CI, so a probing test exercises a different arm in
 * each environment and leaves the other untested in both — including the `null`
 * arm, which is the one that must never compare equal to itself.
 */
function injectedReader(answers: Partial<Record<MachineIdSource, string | null>>): MachineIdReader & {
  asked: MachineIdSource[]
} {
  const asked: MachineIdSource[] = []
  const read = ((source: MachineIdSource) => {
    asked.push(source)
    return answers[source] ?? null
  }) as MachineIdReader & { asked: MachineIdSource[] }
  read.asked = asked
  return read
}

/** 32 hex, with letters, so the upper- and lower-case forms differ. */
const MACHINE_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const MACHINE_B = '0f9e8d7c6b5a49382716f5e4d3c2b1a0'

/** This machine, for host cases. */
const readerA = (): MachineIdReader => injectedReader({ 'etc-machine-id': MACHINE_A })
/** Some other machine. */
const readerB = (): MachineIdReader => injectedReader({ 'etc-machine-id': MACHINE_B })
/** A machine that cannot identify itself. */
const readerNone = (): MachineIdReader => injectedReader({})

describe('deriveHost', () => {
  it('returns a hex string that is neither the machine id nor a substring of it', () => {
    const host = deriveHost(injectedReader({ 'etc-machine-id': MACHINE_A }))
    expect(typeof host).toBe('string')
    expect(host).toMatch(/^[0-9a-f]{64}$/)
    expect(host).not.toBe(MACHINE_A)
    expect(MACHINE_A).not.toContain(host as string)
    expect(host as string).not.toContain(MACHINE_A)
  })

  it('is pure — the same injected id derives the identical host twice', () => {
    const first = deriveHost(injectedReader({ 'etc-machine-id': MACHINE_A }))
    const second = deriveHost(injectedReader({ 'etc-machine-id': MACHINE_A }))
    expect(first).toBe(second)
    expect(first).not.toBeNull()
  })

  it('derives different hosts from different machine ids', () => {
    const a = deriveHost(injectedReader({ 'etc-machine-id': MACHINE_A }))
    const b = deriveHost(injectedReader({ 'etc-machine-id': MACHINE_B }))
    expect(a).not.toBe(b)
  })

  it('returns null when every link of the chain fails', () => {
    expect(deriveHost(injectedReader({}))).toBeNull()
  })

  it('consults the links in order, stopping at the first that answers', () => {
    const read = injectedReader({ 'etc-machine-id': MACHINE_A, 'dbus-machine-id': MACHINE_B })
    deriveHost(read)
    expect(read.asked).toEqual(['etc-machine-id'])

    const fallen = injectedReader({ 'ioreg-platform-uuid': 'EB54B014-8EC8-5BE7-8FD4-B1219A5FE5BA' })
    expect(deriveHost(fallen)).not.toBeNull()
    expect(fallen.asked).toEqual(['etc-machine-id', 'dbus-machine-id', 'ioreg-platform-uuid'])
  })

  it('falls through an unparseable value rather than deriving from it', () => {
    for (const junk of ['', '   ', 'not-hex-at-all-not-hex-at-all-xx', 'a1b2c3']) {
      const read = injectedReader({ 'etc-machine-id': junk, 'dbus-machine-id': MACHINE_B })
      expect(deriveHost(read)).toBe(deriveHost(injectedReader({ 'etc-machine-id': MACHINE_B })))
      expect(read.asked).toEqual(['etc-machine-id', 'dbus-machine-id'])
    }
  })

  it('never consults the machine name', async () => {
    const src = await readFile(join(import.meta.dir, '..', 'lock.ts'), 'utf-8')
    expect(src).not.toMatch(/hostname\s*\(|os\.hostname/)
  })
})

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
      host: deriveHost(readerA()), // same machine, so the pid branch is reached
    }
    expect(isLockStale(lock, readerA())).toBe(true)

    process.kill = originalKill
  })

  it('returns false when acquired_at is recent AND PID exists', () => {
    const lock: WarplineLock = {
      acquired_at: '2026-04-03T11:50:00Z', // 10 mins ago
      run_id: 'run-1',
      mode: 'health',
      pid: process.pid, // current process (alive)
      host: deriveHost(readerA()),
    }
    expect(isLockStale(lock, readerA())).toBe(false)
  })

  it('never breaks a foreign host lock by pid, and expires it only by the TTL', () => {
    const originalKill = process.kill
    process.kill = mock().mockImplementation(() => {
      throw new Error('ESRCH')
    }) as unknown as typeof process.kill
    try {
      const foreign = { run_id: 'run-1', mode: 'advance', pid: 999999, host: deriveHost(readerB()) }
      // Dead on THIS kernel, but the pid was never issued by it.
      expect(isLockStale({ ...foreign, acquired_at: '2026-04-03T11:50:00Z' }, readerA())).toBe(false)
      expect(isLockStale({ ...foreign, acquired_at: '2026-04-03T09:00:00Z' }, readerA())).toBe(true)
    } finally {
      process.kill = originalKill
    }
  })

  it('skips the pid branch when neither side can identify itself', () => {
    const originalKill = process.kill
    process.kill = mock().mockImplementation(() => {
      throw new Error('ESRCH')
    }) as unknown as typeof process.kill
    try {
      // Two nulls are not a match. Git's `gc.pid` writes a literal placeholder
      // here instead, and two unidentified machines then look like one.
      const lock: WarplineLock = {
        acquired_at: '2026-04-03T11:50:00Z',
        run_id: 'run-1',
        mode: 'advance',
        pid: 999999,
        host: null,
      }
      expect(deriveHost(readerNone())).toBeNull()
      expect(isLockStale(lock, readerNone())).toBe(false)
      expect(isLockStale({ ...lock, acquired_at: '2026-04-03T09:00:00Z' }, readerNone())).toBe(true)
    } finally {
      process.kill = originalKill
    }
  })

  it('treats a pre-upgrade record carrying no host key as the null case', () => {
    const raw = {
      acquired_at: '2026-04-03T11:50:00Z',
      run_id: 'run-1',
      mode: 'advance',
      pid: 999999,
      // no `host` key at all — written by the build before this field existed
    }
    const parsed = WarplineLockSchema.safeParse(raw)
    expect(parsed.success).toBe(true)
    const originalKill = process.kill
    process.kill = mock().mockImplementation(() => {
      throw new Error('ESRCH')
    }) as unknown as typeof process.kill
    try {
      expect(isLockStale(parsed.data as WarplineLock, readerA())).toBe(false)
    } finally {
      process.kill = originalKill
    }
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
        host: deriveHost(readerA()), // matching host, so the pid branch is reached
      }
      expect(isLockStale(lock, readerA())).toBe(false)
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

  it('heals a fresh lock whose PID is not alive on the same host', async () => {
    await holder({ pid: 999999, host: deriveHost(readerA()) })
    const originalKill = process.kill
    process.kill = mock().mockImplementation(() => {
      throw new Error('ESRCH')
    }) as unknown as typeof process.kill
    try {
      const acquired = await acquireLock(lockPath, 'advance', { pid: null, readMachineId: readerA() })
      expect(acquired.run_id).not.toBe('held-run-id')
    } finally {
      process.kill = originalKill
    }
  })

  it('refuses a fresh lock whose dead PID belongs to another host', async () => {
    await holder({ pid: 999999, host: deriveHost(readerB()) })
    const originalKill = process.kill
    process.kill = mock().mockImplementation(() => {
      throw new Error('ESRCH')
    }) as unknown as typeof process.kill
    try {
      let refused = false
      try {
        await acquireLock(lockPath, 'advance', { pid: null, readMachineId: readerA() })
      } catch (e) {
        refused = (e as Error).name === 'AdvanceLockedError'
      }
      expect(refused).toBe(true)
      expect((await readLock(lockPath))?.run_id).toBe('held-run-id')
    } finally {
      process.kill = originalKill
    }
  })

  it('stamps the acquiring machine host onto the lock it writes', async () => {
    const lock = await acquireLock(lockPath, 'advance', { readMachineId: readerA() })
    expect(lock.host).toBe(deriveHost(readerA()))
    const onDisk = await readLock(lockPath)
    expect(onDisk?.host).toBe(lock.host)
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

/**
 * The heartbeat lease.
 *
 * The holder refreshes `heartbeat_at` while it runs, and the two-hour window is
 * measured from it, so a holder that is alive is never healed and one that
 * stopped refreshing still is. The staleness cases run on the fixed clock the
 * rest of this file uses. The heartbeat cases inject the refresh, so a refresh
 * can be held in flight on purpose rather than hoped for.
 *
 * The refresh and the heartbeat are imported inside each case, so a build
 * without them fails those cases by name and the rest of this file still runs.
 */
describe('the heartbeat lease', () => {
  /** Acquired three hours before NOW. */
  const old: WarplineLock = {
    acquired_at: '2026-04-03T09:00:00Z',
    run_id: 'run-1',
    mode: 'advance',
    pid: process.pid,
  }

  it('does not heal a lock whose heartbeat is fresh, however old its acquired_at', () => {
    expect(isLockStale({ ...old, heartbeat_at: '2026-04-03T11:59:00Z' })).toBe(false)
  })

  it('heals a lock whose heartbeat is older than two hours', () => {
    expect(isLockStale({ ...old, acquired_at: '2026-04-03T08:00:00Z', heartbeat_at: '2026-04-03T09:00:00Z' })).toBe(true)
  })

  it('measures a lock an older build wrote, with no heartbeat, from acquired_at', () => {
    expect(isLockStale(old)).toBe(true)
    expect(isLockStale({ ...old, acquired_at: '2026-04-03T11:50:00Z' })).toBe(false)
  })

  /**
   * The heartbeat is rewritten every minute and is the only clock the window
   * reads, so a value that is not a date must not pin the lock: NaN compares
   * false against the window forever.
   */
  it('measures from acquired_at when the heartbeat is not a date', () => {
    expect(isLockStale({ ...old, heartbeat_at: '' })).toBe(true)
    expect(isLockStale({ ...old, heartbeat_at: 'not a date' })).toBe(true)
    expect(isLockStale({ ...old, acquired_at: '2026-04-03T11:50:00Z', heartbeat_at: '' })).toBe(false)
  })

  it('measures from acquired_at when the heartbeat is further ahead than the window', () => {
    expect(isLockStale({ ...old, heartbeat_at: '2099-01-01T00:00:00Z' })).toBe(true)
    // A holder whose clock runs a few minutes ahead keeps its lease.
    expect(isLockStale({ ...old, heartbeat_at: '2026-04-03T12:05:00Z' })).toBe(false)
  })

  it('writes a heartbeat equal to acquired_at when it acquires', async () => {
    const lockPath = tmpLock()
    const lock = await acquireLock(lockPath, 'advance')
    expect(lock.heartbeat_at).toBe(lock.acquired_at)
    expect((await readLock(lockPath))?.heartbeat_at).toBe(lock.acquired_at)
    await unlink(lockPath)
  })

  it('refreshes the heartbeat of its own lock and nothing else', async () => {
    const { refreshLock } = await import('../lock.js')
    const lockPath = tmpLock()
    const lock = await acquireLock(lockPath, 'advance')
    setSystemTime(new Date('2026-04-03T13:00:00Z'))
    expect(await refreshLock(lockPath, lock.run_id)).toBe(true)
    expect(await readLock(lockPath)).toEqual({ ...lock, heartbeat_at: '2026-04-03T13:00:00.000Z' })
    await unlink(lockPath)
  })

  it('never writes a lock another run holds', async () => {
    const { refreshLock } = await import('../lock.js')
    const lockPath = tmpLock()
    await acquireLock(lockPath, 'advance')
    const before = await readFile(lockPath, 'utf-8')
    setSystemTime(new Date('2026-04-03T13:00:00Z'))
    expect(await refreshLock(lockPath, 'another-run')).toBe(false)
    expect(await readFile(lockPath, 'utf-8')).toBe(before)
    await unlink(lockPath)
  })

  it('never writes a lock that is gone', async () => {
    const { refreshLock } = await import('../lock.js')
    const lockPath = tmpLock()
    expect(await refreshLock(lockPath, 'run-1')).toBe(false)
    expect(await readLock(lockPath)).toBeNull()
  })

  /**
   * The release runs only after this resolves. A refresh that read the lock as
   * this run's and renamed after the release would put the lock back, held by
   * a run that has ended.
   */
  it('stops only once a refresh already in flight has settled', async () => {
    const { startHeartbeat } = await import('../lock.js')
    let started!: () => void
    const running = new Promise<void>((r) => (started = r))
    let finish!: () => void
    const held = new Promise<void>((r) => (finish = r))
    const stop = startHeartbeat('unused', 'run-1', {
      intervalMs: 5,
      refresh: async () => {
        started()
        await held
        return true
      },
    })
    await running
    let stopped = false
    const stopping = stop().then(() => {
      stopped = true
    })
    await new Promise((r) => setTimeout(r, 30))
    expect(stopped).toBe(false)
    finish()
    await stopping
    expect(stopped).toBe(true)
  })

  /**
   * The case above holds the only refresh there is. A tick that queued a
   * second one behind a slow first would leave `stop` waiting on the wrong
   * one, and the slow one would rename after the release.
   */
  it('skips a tick while a refresh is in flight, so none settles after stop', async () => {
    const { startHeartbeat } = await import('../lock.js')
    let calls = 0
    let active = 0
    let most = 0
    let late = 0
    let released = false
    let started!: () => void
    const running = new Promise<void>((r) => (started = r))
    let finish!: () => void
    const held = new Promise<void>((r) => (finish = r))
    const stop = startHeartbeat('unused', 'run-1', {
      intervalMs: 5,
      refresh: async () => {
        calls += 1
        active += 1
        most = Math.max(most, active)
        if (calls === 1) {
          started()
          await held
        }
        active -= 1
        if (released) late += 1
        return true
      },
    })
    await running
    // Six intervals with the first refresh still held.
    await new Promise((r) => setTimeout(r, 30))
    setTimeout(finish, 20)
    await stop()
    released = true
    await new Promise((r) => setTimeout(r, 40))
    expect(most).toBe(1)
    expect(late).toBe(0)
  })

  /**
   * An advance that throws past its `finally` never calls stop. The interval
   * must not be what keeps that process alive.
   */
  it('never holds a process open on its own', async () => {
    const lockTs = join(import.meta.dir, '..', 'lock.ts')
    const child = Bun.spawn(
      [
        process.execPath,
        '-e',
        `const { startHeartbeat } = await import(${JSON.stringify(lockTs)}); startHeartbeat('unused', 'run-1', { intervalMs: 5, refresh: async () => true })`,
      ],
      { stdout: 'ignore', stderr: 'pipe' },
    )
    const exited = await Promise.race([
      child.exited,
      new Promise<'alive'>((r) => setTimeout(() => r('alive'), 4000)),
    ])
    if (exited === 'alive') child.kill()
    expect(exited).toBe(0)
  })

  it('keeps going after a refresh that throws', async () => {
    const { startHeartbeat } = await import('../lock.js')
    let calls = 0
    let twice!: () => void
    const second = new Promise<void>((r) => (twice = r))
    const stop = startHeartbeat('unused', 'run-1', {
      intervalMs: 5,
      refresh: async () => {
        calls += 1
        if (calls === 2) twice()
        if (calls === 1) throw new Error('EIO')
        return true
      },
    })
    await second
    await stop()
    expect(calls).toBeGreaterThanOrEqual(2)
  })

  /**
   * Through the real refresh, not an injected one: the injected throw above
   * never reached `refreshLock`, which answered a failed read as "not ours" and
   * so stopped the heartbeat for good on one EACCES.
   */
  it('keeps refreshing after a read of its own lock fails', async () => {
    const { startHeartbeat, refreshLock } = await import('../lock.js')
    const lockPath = tmpLock()
    const lock = await acquireLock(lockPath, 'advance')
    setSystemTime(new Date('2026-04-03T13:00:00Z'))
    await chmod(lockPath, 0o000)
    // The fixture can fail: root reads through mode 000, and then this proves nothing.
    await expect(readFile(lockPath, 'utf-8')).rejects.toMatchObject({ code: 'EACCES' })
    let first!: () => void
    const tried = new Promise<void>((r) => (first = r))
    const stop = startHeartbeat(lockPath, lock.run_id, {
      intervalMs: 5,
      refresh: (p, id) => refreshLock(p, id).finally(() => first()),
    })
    await tried
    await chmod(lockPath, 0o644)
    for (let i = 0; i < 100 && (await readLock(lockPath))?.heartbeat_at === lock.acquired_at; i++) {
      await new Promise((r) => setTimeout(r, 5))
    }
    await stop()
    expect((await readLock(lockPath))?.heartbeat_at).toBe('2026-04-03T13:00:00.000Z')
    await unlink(lockPath)
  })

  it('never writes, and never gives up on, a lock it could not parse', async () => {
    const { refreshLock } = await import('../lock.js')
    const lockPath = tmpLock()
    await writeFile(lockPath, '{"run_id": "run-1", trunc')
    await expect(refreshLock(lockPath, 'run-1')).rejects.toThrow()
    expect(await readFile(lockPath, 'utf-8')).toBe('{"run_id": "run-1", trunc')
    await unlink(lockPath)
  })

  it('stops for good the first time the lock is not its own', async () => {
    const { startHeartbeat } = await import('../lock.js')
    let calls = 0
    let first!: () => void
    const called = new Promise<void>((r) => (first = r))
    const stop = startHeartbeat('unused', 'run-1', {
      intervalMs: 5,
      refresh: async () => {
        calls += 1
        first()
        return false
      },
    })
    await called
    // Twenty intervals. A heartbeat that kept going would have called again.
    await new Promise((r) => setTimeout(r, 100))
    await stop()
    expect(calls).toBe(1)
  })
})

/**
 * The raw machine identifier reaches no byte of the home.
 *
 * Built presence-first on purpose. A leak detector that only asserts absence is
 * green when the value never resolved at all, and that blindness is what let
 * the 0.2.0 leak ship: assert the sentinel reached its intended sink, THEN
 * assert it reached nothing else.
 */
describe('the raw machine id never reaches the lock file', () => {
  /** 32 hex with letters, so its upper- and lower-case forms differ. */
  const SENTINEL = 'deadbeefcafef00dfeedface12345678'
  const grouped = (hex: string): string =>
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`

  /**
   * Every form the sentinel could plausibly be written in. The "16 raw bytes
   * hex-encoded" IS the 32-hex string, so it is not a separate form.
   */
  const FORMS = [
    SENTINEL,
    SENTINEL.toUpperCase(),
    grouped(SENTINEL),
    grouped(SENTINEL).toUpperCase(),
  ]

  async function homeWithLock(): Promise<{ home: string; lockPath: string; host: string }> {
    const home = await mkdtemp(join(tmpdir(), 'warpline-lock-leak-'))
    const lockPath = join(home, 'state', '.lock')
    const read = injectedReader({ 'etc-machine-id': SENTINEL })
    const lock = await acquireLock(lockPath, 'advance', { readMachineId: read })
    expect(typeof lock.host).toBe('string')
    expect((lock.host as string).length).toBeGreaterThan(0)
    return { home, lockPath, host: lock.host as string }
  }

  it('writes the derived host to the lock, and none of the sentinel', async () => {
    const { home, lockPath, host } = await homeWithLock()
    try {
      // Presence, first: the sentinel path is real and the value reached the sink.
      const text = await readFile(lockPath, 'utf-8')
      expect(JSON.parse(text).host).toBe(host)
      expect(host).toBe(deriveHost(injectedReader({ 'etc-machine-id': SENTINEL })) as string)

      // Absence, second — over the RAW file text, so a value that leaked into
      // an unmodelled key is caught too.
      for (const form of FORMS) expect(text).not.toContain(form)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('leaves the sentinel in no file anywhere in the home', async () => {
    const { home } = await homeWithLock()
    try {
      // The shared whole-home walk, with no exclusion list: the moment a path
      // is named as expected-to-change, the check stops proving the
      // prohibition and starts documenting an exception.
      const entries = await snapshotHome(home)
      expect(entries.length).toBeGreaterThan(0)
      let scanned = 0
      for (const entry of entries) {
        const [rel, second] = entry.split('|')
        if (second === 'link') continue
        const text = await readFile(join(home, rel as string), 'utf-8')
        for (const form of FORMS) expect(text).not.toContain(form)
        scanned += 1
      }
      expect(scanned).toBeGreaterThan(0)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('generateRunId', () => {
  it('returns string matching pattern YYYY-MM-DDTHHMMSS-[hex]', () => {
    const id = generateRunId()
    // Format: 20260403T120000-[8 hex chars]
    expect(id).toMatch(/^\d{8}T\d{6}-[0-9a-f]{8}$/)
  })
})
