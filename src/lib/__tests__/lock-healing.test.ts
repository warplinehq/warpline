/**
 * Wave 0 — Lock healing tests (stale lock age + PID liveness)
 *
 * Covers decisions:
 *   D-06: acquireLock writes current PID; detectStaleLock checks age (2× maxTimeoutMs) + PID alive
 *   D-07: stale reasons: 'age' (mtime too old) | 'pid-dead' (PID not alive)
 *
 * STATUS: RED — `.warpline/shared/lock-healing.ts` does not yet exist.
 * Wave 2 Plan 02 Task 1 will create it and turn these green.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, rm, writeFile, utimes } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { acquireLock, detectStaleLock, releaseLock } from '../lock-healing.js'

// ---------------------------------------------------------------------------
// Test fixture
// ---------------------------------------------------------------------------

let tmpDir: string
let lockPath: string

beforeEach(async () => {
  tmpDir = join(tmpdir(), `warpline-lock-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  await mkdir(tmpDir, { recursive: true })
  lockPath = join(tmpDir, 'warpline.lock')
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('lock-healing — acquireLock + detectStaleLock (D-06/D-07)', () => {
  test('Test 1: Fresh lock + live PID → stale: false', async () => {
    // acquireLock writes current process.pid to lockPath
    await acquireLock(lockPath)

    // Freshly acquired lock — age is milliseconds old, well within 2× maxTimeoutMs (1000ms → 2000ms threshold)
    // PID is the current process so kill -0 must succeed
    const result = await detectStaleLock(lockPath, 1000)

    expect(result.stale).toBe(false)
  })

  test('Test 2: Old lock → stale: true, reason: "age"', async () => {
    // Write a valid PID as lock content
    await writeFile(lockPath, String(process.pid), 'utf8')

    // Set mtime to 10 seconds ago — 10000ms >> 2 × 1000ms = 2000ms threshold
    const tenSecondsAgo = new Date(Date.now() - 10_000)
    await utimes(lockPath, tenSecondsAgo, tenSecondsAgo)

    const result = await detectStaleLock(lockPath, 1000)

    expect(result.stale).toBe(true)
    // reason must identify age as the cause (D-07)
    expect((result as { stale: true; reason: string }).reason).toBe('age')
  })

  test('Test 3: Dead PID → stale: true, reason: "pid-dead"', async () => {
    // PID 999999 is highly unlikely to be a live process
    const DEAD_PID = 999999
    await writeFile(lockPath, String(DEAD_PID), 'utf8')

    // Set maxTimeoutMs to huge value so age-check passes; only PID liveness fails
    // File was just written → mtime is now → age = ~0ms << 2 × 1_000_000ms
    const result = await detectStaleLock(lockPath, 1_000_000)

    expect(result.stale).toBe(true)
    // reason must identify dead PID as the cause (D-07)
    expect((result as { stale: true; reason: string }).reason).toBe('pid-dead')
  })

  test('Test 4: No lock file → stale: false', async () => {
    // lockPath does not exist
    expect(existsSync(lockPath)).toBe(false)

    const result = await detectStaleLock(lockPath, 1000)

    // No lock file → not stale (nothing is blocking)
    expect(result.stale).toBe(false)
  })

  test('Test 5: releaseLock on non-existent file → no throw', async () => {
    expect(existsSync(lockPath)).toBe(false)

    // Must be a no-op, not throw ENOENT
    await expect(releaseLock(lockPath)).resolves.toBeUndefined()
  })
})
