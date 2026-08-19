import { describe, test, expect, beforeEach } from 'bun:test'
import { ApiBudgetTracker, DEFAULT_BUDGETS } from '../api-budget'
import type { BudgetSnapshot } from '../api-budget'

describe('ApiBudgetTracker', () => {
  let tracker: ApiBudgetTracker

  beforeEach(() => {
    tracker = new ApiBudgetTracker()
  })

  describe('recordCalls', () => {
    test('recordCalls("posthog", 5) adds 5 to posthog domain count', () => {
      tracker.recordCalls('posthog', 5)
      const snap = tracker.snapshot()
      const posthog = snap.domains.find(d => d.domain === 'posthog')
      expect(posthog?.calls_this_window).toBe(5)
    })

    test('recordCalls("github", 3) adds 3 to github domain count', () => {
      tracker.recordCalls('github', 3)
      const snap = tracker.snapshot()
      const github = snap.domains.find(d => d.domain === 'github')
      expect(github?.calls_this_window).toBe(3)
    })

    test('multiple recordCalls accumulate for same domain', () => {
      tracker.recordCalls('posthog', 5)
      tracker.recordCalls('posthog', 10)
      const snap = tracker.snapshot()
      const posthog = snap.domains.find(d => d.domain === 'posthog')
      expect(posthog?.calls_this_window).toBe(15)
    })
  })

  describe('snapshot', () => {
    test('snapshot() returns all domain counts + remaining headroom', () => {
      tracker.recordCalls('posthog', 12)
      tracker.recordCalls('github', 45)
      const snap = tracker.snapshot()
      expect(snap.domains.length).toBeGreaterThan(0)
      const posthog = snap.domains.find(d => d.domain === 'posthog')
      expect(posthog?.calls_this_window).toBe(12)
      expect(posthog?.remaining).toBe(600 - 12)
    })

    test('snapshot() for posthog shows max_per_window of 600', () => {
      const snap = tracker.snapshot()
      const posthog = snap.domains.find(d => d.domain === 'posthog')
      expect(posthog?.max_per_window).toBe(600)
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
      tracker.recordPluginCalls('hypothesis-gen', 'posthog', 2)
      const snap = tracker.snapshot()
      const posthog = snap.domains.find(d => d.domain === 'posthog')
      expect(posthog?.calls_this_window).toBe(2)
      expect(posthog?.by_plugin['hypothesis-gen']).toBe(2)
    })

    test('recordPluginCalls accumulates per-plugin across multiple calls', () => {
      tracker.recordPluginCalls('hypothesis-gen', 'posthog', 2)
      tracker.recordPluginCalls('result-checker', 'posthog', 3)
      tracker.recordPluginCalls('hypothesis-gen', 'posthog', 1)
      const snap = tracker.snapshot()
      const posthog = snap.domains.find(d => d.domain === 'posthog')
      expect(posthog?.calls_this_window).toBe(6)
      expect(posthog?.by_plugin['hypothesis-gen']).toBe(3)
      expect(posthog?.by_plugin['result-checker']).toBe(3)
    })
  })

  describe('reset', () => {
    test('reset() zeros all counters', () => {
      tracker.recordCalls('posthog', 100)
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
      tracker.recordCalls('posthog', 12)
      tracker.recordPluginCalls('hypothesis-gen', 'github', 5)
      const snap = tracker.snapshot()

      // Serialise to JSON and back
      const json = JSON.stringify(snap)
      const parsed: BudgetSnapshot = JSON.parse(json)

      // Restore from snapshot
      const restored = ApiBudgetTracker.fromSnapshot(parsed)
      const restoredSnap = restored.snapshot()

      const posthog = restoredSnap.domains.find(d => d.domain === 'posthog')
      expect(posthog?.calls_this_window).toBe(12)
      const github = restoredSnap.domains.find(d => d.domain === 'github')
      expect(github?.by_plugin['hypothesis-gen']).toBe(5)
    })

    test('toJSON() is alias for snapshot()', () => {
      tracker.recordCalls('posthog', 7)
      const snap = tracker.snapshot()
      const json = tracker.toJSON()
      expect(json).toEqual(snap)
    })
  })

  describe('DEFAULT_BUDGETS', () => {
    test('DEFAULT_BUDGETS contains posthog with max 600', () => {
      const posthog = DEFAULT_BUDGETS.find(b => b.domain === 'posthog')
      expect(posthog?.max_per_window).toBe(600)
    })

    test('DEFAULT_BUDGETS contains github with max 5000', () => {
      const github = DEFAULT_BUDGETS.find(b => b.domain === 'github')
      expect(github?.max_per_window).toBe(5000)
    })
  })
})
