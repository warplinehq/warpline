import { describe, test, expect } from 'bun:test'
import { isPluginFresh } from '../staleness.js'
import type { PluginManifest } from '../../schemas/plugin-manifest.js'
import type { EngineState } from '../../schemas/engine-state.js'

// Build a minimal valid manifest for testing
function makeManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    name: 'test-plugin',
    version: '1.0.0',
    description: 'Test plugin',
    inputs: {},
    outputs: {},
    capabilities: [],
    schedule: 'on_run',
    autonomy_level: 'autonomous',
    side_effects: [],
    ttl_hours: 24,
    dependencies: [],
    timeout_ms: 5000,
    max_parallelism: 1,
    min_tier: 'normal',
    max_retries: 1,
    retry_delay_ms: 2000,
    ...overrides,
  }
}

// Build a minimal valid EngineState for testing
function makeState(pluginRuns: Record<string, { last_run_at: string; status: 'success' | 'partial' | 'failed' | 'skipped'; duration_ms?: number }> = {}): EngineState {
  return {
    schema_version: 1,
    last_run_id: null,
    last_run_at: null,
    last_interaction_at: null,
    deferrals: [],
    task_aging: [],
    plugin_runs: pluginRuns,
    completed_tasks: [],
    pending_gates: [],
    extensions: {},
  }
}

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString()
}

describe('isPluginFresh', () => {
  test('Test 1: plugin never run → { fresh: false, reason: "never run" }', () => {
    const manifest = makeManifest({ name: 'test-plugin', ttl_hours: 24, dependencies: [] })
    const state = makeState({}) // no plugin_runs entry for test-plugin

    const result = isPluginFresh('test-plugin', manifest, state)

    expect(result.fresh).toBe(false)
    expect(result.reason).toBe('never run')
  })

  test('Test 2: plugin run 1 hour ago, ttl_hours: 24 → fresh: true, within TTL', () => {
    const manifest = makeManifest({ name: 'test-plugin', ttl_hours: 24, dependencies: [] })
    const state = makeState({
      'test-plugin': { last_run_at: hoursAgo(1), status: 'success' },
    })

    const result = isPluginFresh('test-plugin', manifest, state)

    expect(result.fresh).toBe(true)
    expect(result.reason).toContain('within TTL')
  })

  // D-14 gate-2 reversal (2026-07-28): past TTL means STALE. Previously this
  // returned fresh:true unless a dependency had re-run, which made ttl_hours a
  // one-way latch — a plugin with no dependencies ran exactly once, ever.
  test('Test 3: TTL expired (25h ago), no deps → fresh: false (TTL is the primary gate)', () => {
    const manifest = makeManifest({ name: 'test-plugin', ttl_hours: 24, dependencies: [] })
    const state = makeState({
      'test-plugin': { last_run_at: hoursAgo(25), status: 'success' },
    })

    const result = isPluginFresh('test-plugin', manifest, state)

    expect(result.fresh).toBe(false)
    expect(result.reason).toContain('TTL expired')
  })

  test('Test 3b: a dependency-less plugin stays eligible run after run', () => {
    // Regression guard for the one-way latch. Two consecutive checks past TTL
    // must both say "run" — the bug made the second (and every later) check skip.
    const manifest = makeManifest({ name: 'test-plugin', ttl_hours: 24, dependencies: [] })
    for (const age of [25, 100, 2000]) {
      const state = makeState({
        'test-plugin': { last_run_at: hoursAgo(age), status: 'success' },
      })
      expect(isPluginFresh('test-plugin', manifest, state).fresh).toBe(false)
    }
  })

  test('Test 3c: dependency re-ran INSIDE the TTL window → fresh: false (invalidation is additive)', () => {
    // Chain awareness must be able to pull a downstream plugin through early;
    // it is an extra trigger, not a precondition.
    const manifest = makeManifest({
      name: 'test-plugin',
      ttl_hours: 24,
      dependencies: ['upstream-plugin'],
    })
    const state = makeState({
      'test-plugin': { last_run_at: hoursAgo(5), status: 'success' }, // well within TTL
      'upstream-plugin': { last_run_at: hoursAgo(1), status: 'success' }, // ran after it
    })

    const result = isPluginFresh('test-plugin', manifest, state)

    expect(result.fresh).toBe(false)
    expect(result.reason).toContain('dependency re-ran')
  })

  test('Test 4: TTL expired, dep ran 2h ago (after last run) → fresh: false, dependency re-ran', () => {
    const manifest = makeManifest({
      name: 'test-plugin',
      ttl_hours: 24,
      dependencies: ['upstream-plugin'],
    })
    const state = makeState({
      'test-plugin': { last_run_at: hoursAgo(25), status: 'success' },
      'upstream-plugin': { last_run_at: hoursAgo(2), status: 'success' }, // ran AFTER test-plugin
    })

    const result = isPluginFresh('test-plugin', manifest, state)

    expect(result.fresh).toBe(false)
    expect(result.reason).toContain('dependency re-ran')
  })

  test('Test 5: empty dependencies array, TTL expired → fresh: false (nothing to invalidate, but TTL still governs)', () => {
    const manifest = makeManifest({
      name: 'test-plugin',
      ttl_hours: 24,
      dependencies: [],
    })
    const state = makeState({
      'test-plugin': { last_run_at: hoursAgo(25), status: 'success' },
    })

    const result = isPluginFresh('test-plugin', manifest, state)

    expect(result.fresh).toBe(false)
    expect(result.reason).toContain('TTL expired')
  })

  test('Test 6: TTL expired, dep exists in manifest but dep never ran → fresh: false (TTL governs; dep cannot invalidate)', () => {
    const manifest = makeManifest({
      name: 'test-plugin',
      ttl_hours: 24,
      dependencies: ['never-ran-dep'],
    })
    const state = makeState({
      'test-plugin': { last_run_at: hoursAgo(25), status: 'success' },
      // never-ran-dep has NO entry in plugin_runs
    })

    const result = isPluginFresh('test-plugin', manifest, state)

    expect(result.fresh).toBe(false)
    expect(result.reason).toContain('TTL expired')
  })

  test('Test 6c: TTL expired, dep ran but is OLDER than us → fresh: false (a stale upstream must not block us)', () => {
    // Pins the design choice called out in the D-14 reversal. Real case:
    // `experiment-checker` depends on `hypothesis-gen`, which is schedule:'weekly'
    // and therefore filtered out of every daily profile run. Under "past TTL AND a
    // dependency is newer", experiment-checker could never run on a daily profile —
    // the old bug wearing a better justification. TTL is the primary gate.
    const manifest = makeManifest({
      name: 'test-plugin',
      ttl_hours: 24,
      dependencies: ['stale-upstream'],
    })
    const state = makeState({
      'test-plugin': { last_run_at: hoursAgo(25), status: 'success' },
      'stale-upstream': { last_run_at: hoursAgo(400), status: 'success' }, // ran long BEFORE us
    })

    const result = isPluginFresh('test-plugin', manifest, state)

    expect(result.fresh).toBe(false)
    expect(result.reason).toContain('TTL expired')
  })

  test('Test 6b: within TTL, dep exists but never ran → fresh: true (no invalidation, TTL holds)', () => {
    const manifest = makeManifest({
      name: 'test-plugin',
      ttl_hours: 24,
      dependencies: ['never-ran-dep'],
    })
    const state = makeState({
      'test-plugin': { last_run_at: hoursAgo(1), status: 'success' },
    })

    const result = isPluginFresh('test-plugin', manifest, state)

    expect(result.fresh).toBe(true)
    expect(result.reason).toContain('within TTL')
  })

  test('Test 7: --force flag overrides freshness → { fresh: false, reason: "forced" }', () => {
    const manifest = makeManifest({ name: 'test-plugin', ttl_hours: 24, dependencies: [] })
    // Plugin ran 1 minute ago — would normally be fresh
    const state = makeState({
      'test-plugin': { last_run_at: hoursAgo(0.017), status: 'success' }, // ~1 min ago
    })

    const result = isPluginFresh('test-plugin', manifest, state, { force: true })

    expect(result.fresh).toBe(false)
    expect(result.reason).toBe('forced')
  })
})
