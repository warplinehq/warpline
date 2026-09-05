/**
 * invokePlugin retry loop.
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
import { testFixturesDir } from '../../../test-utils/fixtures.js'
import { invokePlugin, deriveRunStatus } from '../invoke-plugin.js'
import * as engineEvents from '../../board/engine-events.js'

const FIXTURES_DIR = testFixturesDir(import.meta.url, '..', '..', '..', 'test-utils', 'fixture-plugins')

describe('invokePlugin — retry loop', () => {
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

  /**
   * The run and its own attempts must tell the same story. Before 2026-08-28
   * they did not: `deriveRunStatus` said `delegated` while the attempt
   * classifier collapsed every non-success into `failed`, so one artifact
   * asserted both that the handoff dispatched and that it failed.
   *
   * The fixture carries a non-fatal `errors[]` entry on purpose. Without it
   * `firstError` is null anyway and the two error assertions below pass no
   * matter what the classifier does.
   */
  it('a [needs-llm] handoff is delegated at BOTH the run and attempt level', async () => {
    const res = await invokePlugin('needs-llm-plugin', {}, { pluginsDir: FIXTURES_DIR }, { granted: false, reason: 'manual-run' })

    expect(deriveRunStatus(res)).toBe('delegated')
    expect(res.attempts.length).toBe(1)
    expect(res.attempts[0]?.status).toBe('delegated')

    // A dispatch is not a failure, so it attributes no error — even though the
    // handoff result populates errors[].
    expect(res.result.errors?.length).toBe(1)
    expect(res.attempts[0]?.error).toBeNull()
    expect(res.final_error).toBeNull()

    // Never retried: a handoff is terminal for the plugin.
    expect(res.attempt_count).toBe(1)
  })

  it('success on first attempt → attempt_count=1, retried=false', async () => {
    const res = await invokePlugin('success-plugin', {}, { pluginsDir: FIXTURES_DIR }, { granted: false, reason: 'manual-run' })

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
    { granted: false, reason: 'manual-run' },
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
    { granted: false, reason: 'manual-run' },
    )

    expect(res.attempt_count).toBe(1)
    expect(res.retried).toBe(false)
    expect(res.attempts[0]?.status).toBe('failed')
    expect(res.result.status).toBe('failed')
    expect(emitAttemptFailedSpy).not.toHaveBeenCalled()
  })

  it('nonretryable failure never retries', async () => {
    const res = await invokePlugin('nonretryable-fail-plugin', {}, { pluginsDir: FIXTURES_DIR }, { granted: false, reason: 'manual-run' })

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
    { granted: false, reason: 'manual-run' },
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
    { granted: false, reason: 'manual-run' },
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
    { granted: false, reason: 'manual-run' },
    )

    expect(emitAttemptFailedSpy).toHaveBeenCalledTimes(2)
    const calls = emitAttemptFailedSpy.mock.calls
    expect(calls[0]?.[0]).toBe('retryable-fail-plugin')
    expect(calls[0]?.[1]).toBe(1) // attempt number (1-indexed)
    expect(calls[1]?.[1]).toBe(2)
  })

  /**
   * The linkage R4 exists to provide, on the path most likely to produce a
   * retry notice. `warpline run` passes no `runId` — `run-plugin.ts` supplies
   * `signal`, `maxRetriesOverride`, `persistArtifact` and `userInitiated`, and
   * nothing else — so the notice used to carry `options.runId ?? null` and the
   * board rendered it "no run", while the artifact it came from sat in the runs
   * directory under the synthesized id that also stamped every Output.
   */
  it('a retry notice carries the id that names the run artifact, not null', async () => {
    const runsDir = join(tmp, 'runs')
    const { result } = await invokePlugin(
      'retryable-fail-plugin',
      {},
      // Exactly what `warpline run` passes: no runId, persistArtifact true,
      // and the not-granted witness naming a manual run.
      { pluginsDir: FIXTURES_DIR, maxRetriesOverride: 1, persistArtifact: true, runsDir },
      { granted: false, reason: 'manual-run' },
    )

    const notified = emitAttemptFailedSpy.mock.calls[0]?.[3]
    expect(notified).toBeTypeOf('string')
    expect(notified).not.toBeNull()

    // Not merely non-null: the SAME id the artifact was written under, which is
    // the only thing that makes the notice resolvable.
    const { readdirSync } = await import('node:fs')
    const artifacts = readdirSync(runsDir).filter((f) => f.endsWith('.json'))
    expect(artifacts).toContain(`${notified as string}.json`)

    // …and the same id the Outputs were stamped with, if there were any, so a
    // notice, an artifact and a provenance stamp cannot disagree.
    for (const o of result.artifacts_produced) expect(o.run_id).toBe(notified as string)
  })
})
