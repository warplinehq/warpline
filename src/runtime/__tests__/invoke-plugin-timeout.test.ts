/**
 * invokePlugin timeout + abort.
 *
 * Verifies:
 *   - handler running past manifest.timeout_ms → timed_out=true, no retry
 *   - handler completing inside timeout → clean success
 *   - external AbortSignal cancels an in-flight handler and marks cancelled=true
 *
 * Uses fixture plugins from .warpline/test-utils/fixture-plugins/.
 */
import { describe, it, expect, spyOn } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { testFixturesDir } from '../../../test-utils/fixtures.js'
import { invokePlugin } from '../invoke-plugin.js'

const FIXTURES_DIR = testFixturesDir(import.meta.url, '..', '..', '..', 'test-utils', 'fixture-plugins')
// Retry notices default to the REAL .warpline/state/events.jsonl — redirect them
// so fixture attempt_failed events stop leaking into live state (2026-08-18).
const EVENTS_PATH = join(tmpdir(), `invoke-plugin-timeout-events-${Date.now()}.jsonl`)

describe('invokePlugin — per-attempt timeout', () => {
  it('times out when handler sleeps past manifest.timeout_ms; no retry afterwards', async () => {
    // abort-unaware-plugin: manifest timeout_ms=200, handler sleeps 5s, max_retries=0
    const res = await invokePlugin('abort-unaware-plugin', {}, { pluginsDir: FIXTURES_DIR, eventsPath: EVENTS_PATH }, { granted: false, reason: 'manual-run' })

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
    { granted: false, reason: 'manual-run' },
    )
    // manifest max_retries=2 but timeout should break out of loop immediately
    expect(res.timed_out).toBe(true)
    expect(res.attempt_count).toBe(1)
    expect(res.attempts[0]?.status).toBe('timeout')
  }, 10_000)

  // #30: a timer that fires far past its deadline means the process could not
  // run (a sleep, or a blocked event loop). Still a timeout, but the record
  // says so, so it can be told apart from a slow plugin.
  it('a timeout whose timer fired late says so in the summary and the error', async () => {
    const res = await invokePlugin('late-timer-plugin', {}, { pluginsDir: FIXTURES_DIR, eventsPath: EVENTS_PATH }, { granted: false, reason: 'manual-run' })

    expect(res.timed_out).toBe(true)
    expect(res.result.summary).toStartWith('late-timer-plugin: timeout (timer fired ')
    expect(res.result.summary).toContain('late against timeout_ms=100: the event loop was blocked)')
    expect(res.result.errors[0]?.message).toContain('late against timeout_ms=100')
  }, 10_000)

  // #30: `timeout_ms` bounds AWAKE time. Under Bun on macOS a `setTimeout`
  // counts a system sleep and fires on wake, while `performance.now()` stops
  // (measured 2026-09-30: 124s asleep, wall 131.2s, performance.now 9.9s).
  // Here the awake clock runs at a tenth of wall speed, so 600ms of wall time
  // is 60ms awake, well inside the 200ms budget: the plugin must complete.
  it('a timer that fires after a sleep re-arms for the awake remainder instead of timing out', async () => {
    const realNow = performance.now.bind(performance)
    const origin = realNow()
    const spy = spyOn(performance, 'now').mockImplementation(() => origin + (realNow() - origin) / 10)
    try {
      const res = await invokePlugin('slept-through-plugin', {}, { pluginsDir: FIXTURES_DIR, eventsPath: EVENTS_PATH }, { granted: false, reason: 'manual-run' })
      expect(res.timed_out).toBe(false)
      expect(res.result.status).toBe('success')
    } finally {
      spy.mockRestore()
    }
  }, 10_000)

  it('an on-time timeout keeps the plain summary', async () => {
    const res = await invokePlugin('abort-unaware-plugin', {}, { pluginsDir: FIXTURES_DIR, eventsPath: EVENTS_PATH }, { granted: false, reason: 'manual-run' })
    expect(res.result.summary).toBe('abort-unaware-plugin: timeout')
  }, 10_000)

  it('clean success when handler completes inside timeout', async () => {
    const res = await invokePlugin('success-plugin', {}, { pluginsDir: FIXTURES_DIR, eventsPath: EVENTS_PATH }, { granted: false, reason: 'manual-run' })
    expect(res.timed_out).toBe(false)
    expect(res.cancelled).toBe(false)
    expect(res.result.status).toBe('success')
  })
})

describe('invokePlugin — external AbortSignal', () => {
  it('abort-aware handler exits early when caller aborts', async () => {
    const controller = new AbortController()
    // Fire abort on next tick so handler starts before abort arrives.
    setTimeout(() => controller.abort('cancel-by-test'), 20)

    const res = await invokePlugin(
      'abort-aware-plugin',
      {},
      { pluginsDir: FIXTURES_DIR, eventsPath: EVENTS_PATH, signal: controller.signal },
    { granted: false, reason: 'manual-run' },
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
    { granted: false, reason: 'manual-run' },
    )

    expect(res.cancelled).toBe(true)
    expect(res.attempt_count).toBe(1)
  }, 10_000)
})
