import { describe, test, expect, beforeEach } from 'bun:test'
import { ApiBudgetTracker, DEFAULT_BUDGETS } from '../api-budget.js'
import type { BudgetSnapshot } from '../api-budget.js'

describe('ApiBudgetTracker', () => {
  let tracker: ApiBudgetTracker

  // Explicit config rather than DEFAULT_BUDGETS: these tests exercise tracking
  // behaviour, not the shipped default roster (which has its own describe below
  // and is deliberately near-empty).
  beforeEach(() => {
    tracker = new ApiBudgetTracker([
      { domain: 'metrics-api', max_per_window: 600, window_seconds: 3600 },
      { domain: 'github', max_per_window: 5000, window_seconds: 3600 },
    ])
  })

  describe('recordCalls', () => {
    test('recordCalls("metrics-api", 5) adds 5 to the metrics-api domain count', () => {
      tracker.recordCalls('metrics-api', 5)
      const snap = tracker.snapshot()
      const metricsApi = snap.domains.find(d => d.domain === 'metrics-api')
      expect(metricsApi?.calls_this_window).toBe(5)
    })

    test('recordCalls("github", 3) adds 3 to github domain count', () => {
      tracker.recordCalls('github', 3)
      const snap = tracker.snapshot()
      const github = snap.domains.find(d => d.domain === 'github')
      expect(github?.calls_this_window).toBe(3)
    })

    test('multiple recordCalls accumulate for same domain', () => {
      tracker.recordCalls('metrics-api', 5)
      tracker.recordCalls('metrics-api', 10)
      const snap = tracker.snapshot()
      const metricsApi = snap.domains.find(d => d.domain === 'metrics-api')
      expect(metricsApi?.calls_this_window).toBe(15)
    })
  })

  describe('snapshot', () => {
    test('snapshot() returns all domain counts + remaining headroom', () => {
      tracker.recordCalls('metrics-api', 12)
      tracker.recordCalls('github', 45)
      const snap = tracker.snapshot()
      expect(snap.domains.length).toBeGreaterThan(0)
      const metricsApi = snap.domains.find(d => d.domain === 'metrics-api')
      expect(metricsApi?.calls_this_window).toBe(12)
      expect(metricsApi?.remaining).toBe(600 - 12)
    })

    test('snapshot() for metrics-api shows max_per_window of 600', () => {
      const snap = tracker.snapshot()
      const metricsApi = snap.domains.find(d => d.domain === 'metrics-api')
      expect(metricsApi?.max_per_window).toBe(600)
    })

    test('snapshot() for github shows max_per_window of 5000', () => {
      const snap = tracker.snapshot()
      const github = snap.domains.find(d => d.domain === 'github')
      expect(github?.max_per_window).toBe(5000)
    })

    test('snapshot includes window_start ISO string', () => {
      const snap = tracker.snapshot()
      expect(snap.window_start).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })
  })

  describe('recordPluginCalls', () => {
    test('recordPluginCalls attributes calls to plugin and increments domain total', () => {
      tracker.recordPluginCalls('trend-watch', 'metrics-api', 2)
      const snap = tracker.snapshot()
      const metricsApi = snap.domains.find(d => d.domain === 'metrics-api')
      expect(metricsApi?.calls_this_window).toBe(2)
      expect(metricsApi?.by_plugin['trend-watch']).toBe(2)
    })

    test('recordPluginCalls accumulates per-plugin across multiple calls', () => {
      tracker.recordPluginCalls('trend-watch', 'metrics-api', 2)
      tracker.recordPluginCalls('digest-build', 'metrics-api', 3)
      tracker.recordPluginCalls('trend-watch', 'metrics-api', 1)
      const snap = tracker.snapshot()
      const metricsApi = snap.domains.find(d => d.domain === 'metrics-api')
      expect(metricsApi?.calls_this_window).toBe(6)
      expect(metricsApi?.by_plugin['trend-watch']).toBe(3)
      expect(metricsApi?.by_plugin['digest-build']).toBe(3)
    })
  })

  describe('reset', () => {
    test('reset() zeros all counters', () => {
      tracker.recordCalls('metrics-api', 100)
      tracker.recordCalls('github', 200)
      tracker.reset()
      const snap = tracker.snapshot()
      snap.domains.forEach(d => {
        expect(d.calls_this_window).toBe(0)
        expect(d.remaining).toBe(d.max_per_window)
        expect(Object.keys(d.by_plugin).length).toBe(0)
      })
    })
  })

  describe('serialisation', () => {
    test('BudgetSnapshot serialises to/from JSON for state persistence', () => {
      tracker.recordCalls('metrics-api', 12)
      tracker.recordPluginCalls('trend-watch', 'github', 5)
      const snap = tracker.snapshot()

      // Serialise to JSON and back
      const json = JSON.stringify(snap)
      const parsed: BudgetSnapshot = JSON.parse(json)

      // Restore from snapshot
      const restored = ApiBudgetTracker.fromSnapshot(parsed)
      const restoredSnap = restored.snapshot()

      const metricsApi = restoredSnap.domains.find(d => d.domain === 'metrics-api')
      expect(metricsApi?.calls_this_window).toBe(12)
      const github = restoredSnap.domains.find(d => d.domain === 'github')
      expect(github?.by_plugin['trend-watch']).toBe(5)
    })

    test('toJSON() is alias for snapshot()', () => {
      tracker.recordCalls('metrics-api', 7)
      const snap = tracker.snapshot()
      const json = tracker.toJSON()
      expect(json).toEqual(snap)
    })
  })

  describe('DEFAULT_BUDGETS', () => {
    test('contains github with max 5000', () => {
      const github = DEFAULT_BUDGETS.find(b => b.domain === 'github')
      expect(github?.max_per_window).toBe(5000)
    })

    test('stays minimal — warpline does not guess which APIs a plugin calls', () => {
      expect(DEFAULT_BUDGETS.map(b => b.domain)).toEqual(['github'])
    })
  })
})
