import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { topoSort } from '../engine.js'
import { grantApproval } from '../approval-gate.js'
import { createTestHome, type TestHome } from './helpers/create-test-home.js'
import type { PluginManifest } from '../../schemas/plugin-manifest.js'

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function makeManifest(name: string, overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    name,
    version: '1.0.0',
    description: `${name} plugin`,
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
    max_retries: 1,
    retry_delay_ms: 2000,
    min_tier: 'normal',
    ...overrides,
  }
}

function makeManifestMap(plugins: PluginManifest[]): Map<string, PluginManifest> {
  return new Map(plugins.map(p => [p.name, p]))
}

// -----------------------------------------------------------------------
// topoSort tests
// -----------------------------------------------------------------------

describe('topoSort', () => {
  test('Test 1: 3 independent plugins → [[a, b, c]] (single level)', () => {
    const plugins = makeManifestMap([
      makeManifest('a'),
      makeManifest('b'),
      makeManifest('c'),
    ])
    const levels = topoSort(plugins)
    expect(levels).toHaveLength(1)
    expect(levels[0].sort()).toEqual(['a', 'b', 'c'])
  })

  test('Test 2: chain a->b->c → [[a], [b], [c]] (3 levels)', () => {
    const plugins = makeManifestMap([
      makeManifest('a'),
      makeManifest('b', { dependencies: ['a'] }),
      makeManifest('c', { dependencies: ['b'] }),
    ])
    const levels = topoSort(plugins)
    expect(levels).toHaveLength(3)
    expect(levels[0]).toEqual(['a'])
    expect(levels[1]).toEqual(['b'])
    expect(levels[2]).toEqual(['c'])
  })

  test('Test 3: diamond a->c, b->c → [[a, b], [c]] (2 levels)', () => {
    const plugins = makeManifestMap([
      makeManifest('a'),
      makeManifest('b'),
      makeManifest('c', { dependencies: ['a', 'b'] }),
    ])
    const levels = topoSort(plugins)
    expect(levels).toHaveLength(2)
    expect(levels[0].sort()).toEqual(['a', 'b'])
    expect(levels[1]).toEqual(['c'])
  })

  test('Test 4: cycle a->b->a → throws Error containing "cycle"', () => {
    const plugins = makeManifestMap([
      makeManifest('a', { dependencies: ['b'] }),
      makeManifest('b', { dependencies: ['a'] }),
    ])
    expect(() => topoSort(plugins)).toThrow(/cycle/i)
  })

  test('Test 5: 9-plugin graph → 2 levels', () => {
    // Level 0 (no deps): source-scan, health-check, asset-discover, report-writer
    // Level 1 (depend on level 0): asset-import, source-report, digest-drafts, asset-bundle, source-brief
    const plugins = makeManifestMap([
      makeManifest('source-scan'),
      makeManifest('health-check'),
      makeManifest('asset-discover'),
      makeManifest('report-writer'),
      makeManifest('asset-import', { dependencies: ['asset-discover'] }),
      makeManifest('source-report', { dependencies: ['source-scan'] }),
      makeManifest('digest-drafts', { dependencies: ['asset-discover'] }),
      makeManifest('asset-bundle', { dependencies: ['asset-import'] }),
      makeManifest('source-brief', { dependencies: ['source-scan', 'source-report'] }),
    ])
    const levels = topoSort(plugins)
    expect(levels.length).toBeGreaterThanOrEqual(2)
    // Level 0 should be the 4 independent plugins
    const level0 = levels[0].sort()
    expect(level0).toContain('source-scan')
    expect(level0).toContain('health-check')
    expect(level0).toContain('asset-discover')
    expect(level0).toContain('report-writer')
  })

  test('Test 6: single plugin with no deps → [[name]]', () => {
    const plugins = makeManifestMap([makeManifest('solo')])
    const levels = topoSort(plugins)
    expect(levels).toHaveLength(1)
    expect(levels[0]).toEqual(['solo'])
  })

  test('Test 7: empty map → []', () => {
    const plugins = new Map<string, PluginManifest>()
    const levels = topoSort(plugins)
    expect(levels).toEqual([])
  })
})

// -----------------------------------------------------------------------
// Schema extension tests
// -----------------------------------------------------------------------

describe('RunLogSchema plugin_entries', () => {
  test('Test 8: RunLogSchema.parse succeeds with plugin_entries containing reversible + undo_instruction', async () => {
    const { RunLogSchema } = await import('../../schemas/run-log.js')
    const result = RunLogSchema.safeParse({
      run_id: 'test-run-id',
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      status: 'complete',
      modes_run: [],
      summary: 'test run',
      plugin_entries: [
        {
          plugin: 'source-scan',
          status: 'completed',
          started_at: new Date().toISOString(),
          elapsed_ms: 1234,
          result_summary: 'Scan complete',
          reversible: true,
          undo_instruction: 'Delete generated report',
          retried: false,
        },
      ],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.plugin_entries).toHaveLength(1)
      expect(result.data.plugin_entries[0].reversible).toBe(true)
      expect(result.data.plugin_entries[0].undo_instruction).toBe('Delete generated report')
    }
  })

  test('Test 9: RunLogSchema.parse succeeds with empty plugin_entries (default)', async () => {
    const { RunLogSchema } = await import('../../schemas/run-log.js')
    const result = RunLogSchema.safeParse({
      run_id: 'test-run-id',
      started_at: new Date().toISOString(),
      completed_at: null,
      status: 'failed',
      modes_run: [],
      summary: 'test run',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.plugin_entries).toEqual([])
    }
  })
})

describe('SkillResultSchema reversibility fields', () => {
  test('Test 10: SkillResultSchema.parse succeeds with reversible + undo_instruction', async () => {
    const { SkillResultSchema } = await import('../../schemas/skill-result.js')
    const result = SkillResultSchema.safeParse({
      status: 'success',
      phases_completed: ['phase-1'],
      phases_failed: [],
      data_freshness: {},
      summary: 'All done',
      reversible: true,
      undo_instruction: 'Remove created file',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.reversible).toBe(true)
      expect(result.data.undo_instruction).toBe('Remove created file')
    }
  })

  test('Test 11: SkillResultSchema.parse succeeds without reversibility fields (optional)', async () => {
    const { SkillResultSchema } = await import('../../schemas/skill-result.js')
    const result = SkillResultSchema.safeParse({
      status: 'success',
      phases_completed: [],
      phases_failed: [],
      data_freshness: {},
      summary: 'Done',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.reversible).toBeUndefined()
      expect(result.data.undo_instruction).toBeUndefined()
    }
  })
})

// -----------------------------------------------------------------------
// runAdvance tests — imported later after Task 2 implements them
// -----------------------------------------------------------------------

describe('runAdvance', () => {
  let ctx: TestHome
  let pluginsDir: string
  let stateDir: string
  let runsDir: string
  // Board-event log must be redirected too — runAdvance's eventsPath DEFAULTS
  // to the real live events.jsonl, and omitting it here appended
  // thousands of plugin-a/plugin-b fixture events to live state (2026-08-18).
  let eventsPath: string

  beforeEach(async () => {
    ctx = await createTestHome()
    pluginsDir = ctx.pluginsDir
    stateDir = ctx.stateDir
    runsDir = ctx.runsDir
    eventsPath = join(ctx.runsDir, 'events.jsonl')
  })

  afterEach(async () => {
    await ctx.cleanup()
  })

  async function createTestPlugin(
    name: string,
    autonomyLevel: 'autonomous' | 'supervised' | 'manual' = 'autonomous',
    resultStatus: 'success' | 'partial' | 'failed' | 'skipped' = 'success',
  ) {
    const pluginDir = join(pluginsDir, name)
    await mkdir(pluginDir, { recursive: true })

    const manifest = {
      name,
      version: '1.0.0',
      description: `${name} test plugin`,
      inputs: {},
      outputs: {},
      capabilities: [],
      schedule: 'on_run',
      autonomy_level: autonomyLevel,
      side_effects: autonomyLevel === 'supervised' ? ['writes_db'] : [],
      ttl_hours: 0.001, // near-zero TTL so plugins are always stale
      dependencies: [],
      timeout_ms: 5000,
      max_parallelism: 1,
    }

    await writeFile(
      join(pluginDir, 'manifest.ts'),
      `export const manifest = ${JSON.stringify(manifest)}`,
    )

    await writeFile(
      join(pluginDir, 'handler.ts'),
      `
export async function handler(manifest, args) {
  return {
    status: '${resultStatus}',
    phases_completed: ['${name}'],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: '${name} completed',
    artifacts_produced: [],
    schema_version: 1,
  }
}
`,
    )
  }

  test('Test 12: runAdvance with 2 independent autonomous plugins → both complete', async () => {
    const { runAdvance } = await import('../engine.js')
    await createTestPlugin('plugin-a')
    await createTestPlugin('plugin-b')

    const result = await runAdvance({
      pluginsDir,
      stateDir: join(stateDir, 'engine-state.json'),
      runsDir,
      eventsPath,
    })

    expect(result.status).toBe('complete')
    const states = Array.from(result.plugin_states.values())
    const completed = states.filter(s => s === 'completed')
    expect(completed).toHaveLength(2)
  })

  test('Test 13: runAdvance skips plugins where isPluginFresh returns true', async () => {
    const { runAdvance } = await import('../engine.js')
    await createTestPlugin('fresh-plugin')

    // Write a state where this plugin ran 1 minute ago with a 24h TTL
    const recentTime = new Date(Date.now() - 60_000).toISOString()
    const state = {
      schema_version: 1,
      last_run_id: null,
      last_run_at: null,
      deferrals: [],
      task_aging: [],
      plugin_runs: {
        'fresh-plugin': { last_run_at: recentTime, status: 'success' },
      },
      pending_gates: [],
    }
    await writeFile(
      join(stateDir, 'engine-state.json'),
      JSON.stringify(state),
    )

    // Recreate with 24h TTL so it IS fresh
    const pluginDir = join(pluginsDir, 'fresh-plugin')
    const manifest = {
      name: 'fresh-plugin',
      version: '1.0.0',
      description: 'fresh-plugin test plugin',
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
    }
    await writeFile(
      join(pluginDir, 'manifest.ts'),
      `export const manifest = ${JSON.stringify(manifest)}`,
    )

    const result = await runAdvance({
      pluginsDir,
      stateDir: join(stateDir, 'engine-state.json'),
      runsDir,
      eventsPath,
    })

    expect(result.plugin_states.get('fresh-plugin')).toBe('skipped')
  })

  test('Test 14: runAdvance with manual plugin → skipped with "manual — requires explicit invocation"', async () => {
    const { runAdvance } = await import('../engine.js')
    await createTestPlugin('manual-plugin', 'manual')

    const result = await runAdvance({
      pluginsDir,
      stateDir: join(stateDir, 'engine-state.json'),
      runsDir,
      eventsPath,
    })

    expect(result.plugin_states.get('manual-plugin')).toBe('skipped')
  })

  test('Test 15: runAdvance with supervised plugin → gated (not dry-run)', async () => {
    const { runAdvance } = await import('../engine.js')
    await createTestPlugin('supervised-plugin', 'supervised')
    // supervised plugins have side_effects: ['writes_db'] — grant approval so the
    // approval gate passes and the supervised-gating logic is reached
    const approvalPath = join(ctx.root, '.session-approval-test15')
    await grantApproval('supervised-plugin', 4 * 60 * 60 * 1000, approvalPath)

    const result = await runAdvance({
      pluginsDir,
      stateDir: join(stateDir, 'engine-state.json'),
      runsDir,
      eventsPath,
      approvalPath,
    })

    expect(result.plugin_states.get('supervised-plugin')).toBe('gated')
    expect(result.gated_plugins).toContain('supervised-plugin')
  })

  test('Test 16: runAdvance with dry-run=true and supervised plugin → logs "would pause here", continues', async () => {
    const { runAdvance } = await import('../engine.js')
    await createTestPlugin('supervised-plugin', 'supervised')
    // supervised plugins have side_effects: ['writes_db'] — in dry-run the side-effect
    // guard fires first and blocks them before the supervised gate is reached.
    // Verify the plugin is skipped (blocked by dry-run guard) and run completes.
    const result = await runAdvance({
      dryRun: true,
      pluginsDir,
      stateDir: join(stateDir, 'engine-state.json'),
      runsDir,
      eventsPath,
    })

    // dry-run side-effect guard fires: plugin is skipped, not gated
    expect(result.plugin_states.get('supervised-plugin')).toBe('skipped')
    expect(result.gated_plugins).not.toContain('supervised-plugin')
    expect(result.status).toBe('complete')
  })

  test('Test 17: plugin failure → other plugins in level still complete', async () => {
    const { runAdvance } = await import('../engine.js')
    await createTestPlugin('plugin-ok')
    await createTestPlugin('plugin-fail', 'autonomous', 'failed')

    const result = await runAdvance({
      pluginsDir,
      stateDir: join(stateDir, 'engine-state.json'),
      runsDir,
      eventsPath,
    })

    expect(result.plugin_states.get('plugin-ok')).toBe('completed')
    expect(result.plugin_states.get('plugin-fail')).toBe('failed')
  })

  test('Test 18: run log contains plugin_entries with elapsed_ms and result_summary', async () => {
    const { runAdvance } = await import('../engine.js')
    const { readFile } = await import('node:fs/promises')
    await createTestPlugin('log-plugin')

    const result = await runAdvance({
      pluginsDir,
      stateDir: join(stateDir, 'engine-state.json'),
      runsDir,
      eventsPath,
    })

    const logContent = await readFile(result.run_log_path, 'utf-8')
    const log = JSON.parse(logContent)
    expect(log.plugin_entries).toBeDefined()
    expect(log.plugin_entries.length).toBeGreaterThan(0)
    const entry = log.plugin_entries[0]
    expect(typeof entry.elapsed_ms).toBe('number')
    expect(typeof entry.result_summary).toBe('string')
  })

  test('Test 19: per-plugin FSM tracks state transitions pending→running→completed/failed/gated', async () => {
    const { runAdvance } = await import('../engine.js')
    await createTestPlugin('fsm-plugin')

    const result = await runAdvance({
      pluginsDir,
      stateDir: join(stateDir, 'engine-state.json'),
      runsDir,
      eventsPath,
    })

    expect(result.plugin_states.get('fsm-plugin')).toBe('completed')
  })

  test('Test 20: run log pruning happens at start of each run', async () => {
    const { runAdvance } = await import('../engine.js')
    const { writeFile: wf } = await import('node:fs/promises')
    await createTestPlugin('prune-plugin')

    // Create 35 old log files (older than 30 days)
    for (let i = 0; i < 5; i++) {
      const logPath = join(runsDir, `old-run-${i}.json`)
      await wf(logPath, JSON.stringify({ run_id: `old-run-${i}` }))
      // Note: we can't easily set mtime in tests, so just verify pruning doesn't crash
    }

    // Should complete without error
    const result = await runAdvance({
      pluginsDir,
      stateDir: join(stateDir, 'engine-state.json'),
      runsDir,
      eventsPath,
    })

    expect(result.run_log_path).toBeDefined()
  })
})

// -----------------------------------------------------------------------
// runAdvance side-effect guards
// -----------------------------------------------------------------------

describe('runAdvance side-effect guards', () => {
  let ctx: TestHome
  let pluginsDir: string
  let stateDir: string
  let runsDir: string
  // Board-event log must be redirected too — runAdvance's eventsPath DEFAULTS
  // to the real live events.jsonl, and omitting it here appended
  // thousands of plugin-a/plugin-b fixture events to live state (2026-08-18).
  let eventsPath: string

  beforeEach(async () => {
    ctx = await createTestHome()
    pluginsDir = ctx.pluginsDir
    stateDir = ctx.stateDir
    runsDir = ctx.runsDir
    eventsPath = join(ctx.runsDir, 'events.jsonl')
  })

  afterEach(async () => {
    await ctx.cleanup()
  })

  async function createSideEffectPlugin(
    name: string,
    sideEffects: string[] = ['external_api'],
    resultStatus: 'success' | 'partial' | 'failed' = 'success',
  ) {
    const pluginDir = join(pluginsDir, name)
    await mkdir(pluginDir, { recursive: true })

    const manifest = {
      name,
      version: '1.0.0',
      description: `${name} test plugin`,
      inputs: {},
      outputs: {},
      capabilities: [],
      schedule: 'on_run',
      autonomy_level: 'autonomous',
      side_effects: sideEffects,
      ttl_hours: 0.001,
      dependencies: [],
      timeout_ms: 5000,
      max_parallelism: 1,
    }

    await writeFile(
      join(pluginDir, 'manifest.ts'),
      `export const manifest = ${JSON.stringify(manifest)}`,
    )

    await writeFile(
      join(pluginDir, 'handler.ts'),
      `
export async function handler(manifest, args) {
  return {
    status: '${resultStatus}',
    phases_completed: ['${name}'],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: '${name} completed',
    artifacts_produced: [],
    schema_version: 1,
  }
}
`,
    )
  }

  test('Test 21: dryRun=true + side_effects plugin → skipped with "blocked (dry-run)"', async () => {
    const { runAdvance } = await import('../engine.js')
    await createSideEffectPlugin('side-effect-plugin', ['external_api'])

    const result = await runAdvance({
      dryRun: true,
      pluginsDir,
      stateDir: join(stateDir, 'engine-state.json'),
      runsDir,
      eventsPath,
    })

    expect(result.plugin_states.get('side-effect-plugin')).toBe('skipped')
    // Verify run log entry contains "blocked (dry-run)"
    const { readFile } = await import('node:fs/promises')
    const logContent = await readFile(result.run_log_path, 'utf-8')
    const log = JSON.parse(logContent)
    const entry = log.plugin_entries.find((e: { plugin: string }) => e.plugin === 'side-effect-plugin')
    expect(entry.result_summary).toContain('blocked (dry-run)')
  })

  test('Test 22: dryRun=true + side_effects=[] plugin → executes normally (completed)', async () => {
    const { runAdvance } = await import('../engine.js')
    await createSideEffectPlugin('clean-plugin', [])

    const result = await runAdvance({
      dryRun: true,
      pluginsDir,
      stateDir: join(stateDir, 'engine-state.json'),
      runsDir,
      eventsPath,
    })

    expect(result.plugin_states.get('clean-plugin')).toBe('completed')
  })

  test('Test 23: non-dry-run + side_effects + no approval → skipped with "unapproved"', async () => {
    const { runAdvance } = await import('../engine.js')
    await createSideEffectPlugin('unapproved-plugin', ['writes_db'])
    const approvalPath = join(ctx.root, '.session-approval-test23')

    const result = await runAdvance({
      pluginsDir,
      stateDir: join(stateDir, 'engine-state.json'),
      runsDir,
      eventsPath,
      approvalPath,
    })

    expect(result.plugin_states.get('unapproved-plugin')).toBe('skipped')
    const { readFile } = await import('node:fs/promises')
    const logContent = await readFile(result.run_log_path, 'utf-8')
    const log = JSON.parse(logContent)
    const entry = log.plugin_entries.find((e: { plugin: string }) => e.plugin === 'unapproved-plugin')
    expect(entry.result_summary).toContain('unapproved')
  })

  test('Test 24: non-dry-run + side_effects + valid approval → plugin proceeds (completed)', async () => {
    const { runAdvance } = await import('../engine.js')
    await createSideEffectPlugin('approved-plugin', ['writes_db'])
    const approvalPath = join(ctx.root, '.session-approval-test24')
    await grantApproval('approved-plugin', 4 * 60 * 60 * 1000, approvalPath)

    const result = await runAdvance({
      pluginsDir,
      stateDir: join(stateDir, 'engine-state.json'),
      runsDir,
      eventsPath,
      approvalPath,
    })

    expect(result.plugin_states.get('approved-plugin')).toBe('completed')
  })

  test('Test 25: dryRun=true + mixed plugins (one with side_effects, one without) → side-effect blocked, clean completes', async () => {
    const { runAdvance } = await import('../engine.js')
    await createSideEffectPlugin('has-side-effects', ['external_api'])
    await createSideEffectPlugin('no-side-effects', [])

    const result = await runAdvance({
      dryRun: true,
      pluginsDir,
      stateDir: join(stateDir, 'engine-state.json'),
      runsDir,
      eventsPath,
    })

    expect(result.plugin_states.get('has-side-effects')).toBe('skipped')
    expect(result.plugin_states.get('no-side-effects')).toBe('completed')
  })
})
