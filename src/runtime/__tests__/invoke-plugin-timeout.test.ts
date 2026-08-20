/**
 * invokePlugin timeout + abort — Phase 121 Plan 01 Task 1.2.
 *
 * Verifies:
 *   - handler running past manifest.timeout_ms → timed_out=true, no retry (D-12)
 *   - handler completing inside timeout → clean success
 *   - external AbortSignal cancels an in-flight handler and marks cancelled=true (D-31)
 *
 * Uses fixture plugins from .warpline/test-utils/fixture-plugins/.
 */
import { describe, it, expect } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { testFixturesDir } from '../../../test-utils/fixtures.js'
import { invokePlugin } from '../invoke-plugin.js'

const FIXTURES_DIR = testFixturesDir(import.meta.url, '..', '..', '..', 'test-utils', 'fixture-plugins')
// Retry notices default to the REAL .warpline/state/events.jsonl — redirect them
// so fixture attempt_failed events stop leaking into live state (2026-08-18).
const EVENTS_PATH = join(tmpdir(), `invoke-plugin-timeout-events-${Date.now()}.jsonl`)

describe('invokePlugin — per-attempt timeout (Phase 121 D-12/D-13)', () => {
  it('times out when handler sleeps past manifest.timeout_ms; no retry afterwards', async () => {
    // abort-unaware-plugin: manifest timeout_ms=200, handler sleeps 5s, max_retries=0
    const res = await invokePlugin('abort-unaware-plugin', {}, { pluginsDir: FIXTURES_DIR, eventsPath: EVENTS_PATH })

    expect(res.timed_out).toBe(true)
    expect(res.cancelled).toBe(false)
    expect(res.attempt_count).toBe(1)
    expect(res.attempts[0]?.status).toBe('timeout')
  }, 10_000)

  it('times out even when max_retries > 0 — timeout is fatal', async () => {
    const res = await invokePlugin(
      'timeout-plugin',
      {},
      { pluginsDir: FIXTURES_DIR, eventsPath: EVENTS_PATH },
    )
    // manifest max_retries=2 but timeout should break out of loop immediately
    expect(res.timed_out).toBe(true)
    expect(res.attempt_count).toBe(1)
    expect(res.attempts[0]?.status).toBe('timeout')
  }, 10_000)

  it('clean success when handler completes inside timeout', async () => {
    const res = await invokePlugin('success-plugin', {}, { pluginsDir: FIXTURES_DIR, eventsPath: EVENTS_PATH })
    expect(res.timed_out).toBe(false)
    expect(res.cancelled).toBe(false)
    expect(res.result.status).toBe('success')
  })
})

describe('invokePlugin — external AbortSignal (Phase 121 D-31)', () => {
  it('abort-aware handler exits early when caller aborts', async () => {
    const controller = new AbortController()
    // Fire abort on next tick so handler starts before abort arrives.
    setTimeout(() => controller.abort('cancel-by-test'), 20)

    const res = await invokePlugin(
      'abort-aware-plugin',
      {},
      { pluginsDir: FIXTURES_DIR, eventsPath: EVENTS_PATH, signal: controller.signal },
    )

    expect(res.cancelled).toBe(true)
    expect(res.timed_out).toBe(false)
    expect(res.attempts[0]?.status).toBe('cancelled')
    expect(res.attempt_count).toBe(1) // no retry after cancel
  }, 10_000)

  it('signal aborted before invocation still marks the run cancelled', async () => {
    const controller = new AbortController()
    controller.abort('pre-aborted')

    const res = await invokePlugin(
      'abort-aware-plugin',
      {},
      { pluginsDir: FIXTURES_DIR, eventsPath: EVENTS_PATH, signal: controller.signal },
    )

    expect(res.cancelled).toBe(true)
    expect(res.attempt_count).toBe(1)
  }, 10_000)
})
