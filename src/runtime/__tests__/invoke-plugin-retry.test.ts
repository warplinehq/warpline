/**
 * invokePlugin retry loop — Phase 121 Plan 01 Task 1.2.
 *
 * Verifies:
 *   - success on first attempt (no retry)
 *   - retryable-then-success returns success with attempt_count === 2
 *   - max_retries=0 forces single-shot even on retryable fail
 *   - nonretryable failures never retry
 *   - exhausted retries produce attempt_count === max_retries + 1
 *   - backoff delays follow exp * ±25% jitter pattern, capped at 30s
 *   - emitBoardEvent is called with attempt_failed between attempts
 *
 * Follows CLAUDE.md "bun:test gotchas": describe-level spy setup/teardown,
 * no mock.module. Fixtures live at .warpline/test-utils/fixture-plugins/.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { testFixturesDir } from '../../../test-utils/fixtures'
import { invokePlugin } from '../invoke-plugin'
import * as engineEvents from '../../board/engine-events'

const FIXTURES_DIR = testFixturesDir(import.meta.url, '..', '..', '..', 'test-utils', 'fixture-plugins')

describe('invokePlugin — retry loop (Phase 121 D-01/D-04/D-05/D-06)', () => {
  let tmp: string
  let setTimeoutSpy: ReturnType<typeof spyOn<typeof globalThis, 'setTimeout'>>
  let emitAttemptFailedSpy: ReturnType<typeof spyOn<typeof engineEvents, 'emitAttemptFailed'>>
  const capturedDelays: number[] = []

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'invoke-plugin-retry-'))
    capturedDelays.length = 0
    // Record delays but still schedule real timers so awaits progress.
    const realSetTimeout = globalThis.setTimeout
    setTimeoutSpy = spyOn(globalThis, 'setTimeout')
    setTimeoutSpy.mockImplementation(((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
      if (typeof ms === 'number') capturedDelays.push(ms)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (realSetTimeout as any)(fn, ms, ...rest)
    }) as unknown as typeof setTimeout)

    emitAttemptFailedSpy = spyOn(engineEvents, 'emitAttemptFailed')
    emitAttemptFailedSpy.mockImplementation(async () => {})
  })

  afterEach(() => {
    setTimeoutSpy.mockRestore()
    emitAttemptFailedSpy.mockRestore()
    rmSync(tmp, { recursive: true, force: true })
  })

  it('success on first attempt → attempt_count=1, retried=false', async () => {
    const res = await invokePlugin('success-plugin', {}, { pluginsDir: FIXTURES_DIR })

    expect(res.attempt_count).toBe(1)
    expect(res.retried).toBe(false)
    expect(res.attempts.length).toBe(1)
    expect(res.attempts[0]?.status).toBe('success')
    expect(res.result.status).toBe('success')
    expect(res.final_error).toBeNull()
    expect(emitAttemptFailedSpy).not.toHaveBeenCalled()
  })

  it('retryable-then-success → attempt_count=2, retried=true, attempts[0].failed + attempts[1].success', async () => {
    const counterPath = join(tmp, 'counter.txt')
    writeFileSync(counterPath, '0', 'utf-8')

    const res = await invokePlugin(
      'retry-then-succeed-plugin',
      { counterPath },
      { pluginsDir: FIXTURES_DIR },
    )

    expect(res.attempt_count).toBe(2)
    expect(res.retried).toBe(true)
    expect(res.attempts[0]?.status).toBe('failed')
    expect(res.attempts[1]?.status).toBe('success')
    expect(res.result.status).toBe('success')
    expect(res.final_error).toBeNull()
    expect(emitAttemptFailedSpy).toHaveBeenCalledTimes(1)
  })

  it('maxRetriesOverride=0 forces single-shot even on retryable fail', async () => {
    const res = await invokePlugin(
      'retryable-fail-plugin',
      {},
      { pluginsDir: FIXTURES_DIR, maxRetriesOverride: 0 },
    )

    expect(res.attempt_count).toBe(1)
    expect(res.retried).toBe(false)
    expect(res.attempts[0]?.status).toBe('failed')
    expect(res.result.status).toBe('failed')
    expect(emitAttemptFailedSpy).not.toHaveBeenCalled()
  })

  it('nonretryable failure never retries', async () => {
    const res = await invokePlugin('nonretryable-fail-plugin', {}, { pluginsDir: FIXTURES_DIR })

    expect(res.attempt_count).toBe(1)
    expect(res.retried).toBe(false)
    expect(res.attempts[0]?.status).toBe('failed')
    expect(res.attempts[0]?.error).toBe('auth denied')
    expect(res.final_error).toBe('auth denied')
    expect(emitAttemptFailedSpy).not.toHaveBeenCalled()
  })

  it('exhausted retries: maxRetriesOverride=3 → 4 total attempts (1 initial + 3 retries)', async () => {
    const res = await invokePlugin(
      'retryable-fail-plugin',
      {},
      { pluginsDir: FIXTURES_DIR, maxRetriesOverride: 3 },
    )

    expect(res.attempt_count).toBe(4)
    expect(res.retried).toBe(true)
    expect(res.attempts.every(a => a.status === 'failed')).toBe(true)
    expect(emitAttemptFailedSpy).toHaveBeenCalledTimes(3)
  })

  it('backoff math: exp × jitter, each within ±25% of nominal, capped at 30s', async () => {
    // base=10, maxRetries=3 → nominals 10, 20, 40 (all below 30s cap)
    await invokePlugin(
      'retryable-fail-plugin',
      {},
      { pluginsDir: FIXTURES_DIR, maxRetriesOverride: 3 },
    )

    // Filter to delays >= 1ms that match backoff ranges; the spy also captures
    // very small async-boundary setTimeouts from Bun internals, so assert on
    // the presence of values in each expected band rather than exact length.
    const nominals = [10, 20, 40]
    for (let i = 0; i < nominals.length; i++) {
      const n = nominals[i] ?? 10
      const lo = Math.floor(n * 0.75)
      const hi = Math.ceil(n * 1.25)
      const match = capturedDelays.find(d => d >= lo && d <= hi)
      expect(match).toBeDefined()
    }
    // No delay should exceed the 30s cap × upper jitter band (37.5s ceiling).
    for (const d of capturedDelays) {
      expect(d).toBeLessThanOrEqual(30_000 * 1.25 + 1)
    }
  })

  it("emitAttemptFailed is called with type:'notice'-compatible summary for each retried attempt", async () => {
    await invokePlugin(
      'retryable-fail-plugin',
      {},
      { pluginsDir: FIXTURES_DIR, maxRetriesOverride: 2 },
    )

    expect(emitAttemptFailedSpy).toHaveBeenCalledTimes(2)
    const calls = emitAttemptFailedSpy.mock.calls
    expect(calls[0]?.[0]).toBe('retryable-fail-plugin')
    expect(calls[0]?.[1]).toBe(1) // attempt number (1-indexed)
    expect(calls[1]?.[1]).toBe(2)
  })
})
