import { describe, it, expect, mock, beforeEach, afterEach, setSystemTime } from 'bun:test'
import { writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  WarplineLockSchema,
  isLockStale,
  acquireLock,
  releaseLock,
  generateRunId,
  updateLockMode,
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

  it('throws when lock file already exists (EEXIST)', async () => {
    // Create the lock file first
    await writeFile(lockPath, '{}', { flag: 'wx' })
    let threw = false
    try {
      await acquireLock(lockPath)
    } catch (e) {
      threw = true
      expect((e as Error).message).toContain('EEXIST')
    }
    expect(threw).toBe(true)
  })
})

describe('releaseLock', () => {
  it('removes the lock file', async () => {
    const lockPath = tmpLock()
    await writeFile(lockPath, '{}')
    await releaseLock(lockPath)
    // File should no longer exist
    let threw = false
    try {
      await (await import('node:fs/promises')).readFile(lockPath)
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })
})

describe('generateRunId', () => {
  it('returns string matching pattern YYYY-MM-DDTHHMMSS-[hex]', () => {
    const id = generateRunId()
    // Format: 20260403T120000-[8 hex chars]
    expect(id).toMatch(/^\d{8}T\d{6}-[0-9a-f]{8}$/)
  })
})

describe('updateLockMode', () => {
  const baseLock: WarplineLock = {
    acquired_at: '2026-04-04T10:00:00Z',
    run_id: '20260404T100000-abcd1234',
    mode: 'health',
    pid: 12345,
  }

  let lockPath: string

  beforeEach(async () => {
    lockPath = tmpLock()
    await writeFile(lockPath, JSON.stringify(baseLock))
  })

  afterEach(async () => {
    try { await unlink(lockPath) } catch { /* already removed */ }
  })

  it('updates mode field and preserves other fields', async () => {
    const result = await updateLockMode(lockPath, 'intel')
    expect(result.mode).toBe('intel')
    expect(result.acquired_at).toBe(baseLock.acquired_at)
    expect(result.run_id).toBe(baseLock.run_id)
    expect(result.pid).toBe(baseLock.pid)
  })

  it('writes valid lock back to disk', async () => {
    await updateLockMode(lockPath, 'ops')

    const writtenData = JSON.parse(await (await import('node:fs/promises')).readFile(lockPath, 'utf-8'))
    const parsed = WarplineLockSchema.safeParse(writtenData)
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.mode).toBe('ops')
  })

  it('throws when lock file does not exist', async () => {
    let threw = false
    try {
      await updateLockMode('/tmp/nonexistent-lock-xyz.lock', 'intel')
    } catch (e) {
      threw = true
      expect((e as Error).message).toContain('ENOENT')
    }
    expect(threw).toBe(true)
  })

  it('result is valid per WarplineLockSchema', async () => {
    const result = await updateLockMode(lockPath, 'intelligence')
    const parsed = WarplineLockSchema.safeParse(result)
    expect(parsed.success).toBe(true)
  })
})
