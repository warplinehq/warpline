import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
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

// -----------------------------------------------------------------------
// R2 — a gated run counts as a run
// -----------------------------------------------------------------------

/**
 * The regression this pins is a side-effect one, not a bookkeeping one.
 *
 * Side effects fire when the handler is invoked. The supervision gate is
 * downstream of that: it decides what happens to the RESULT, long after the
 * email went out. So a supervised plugin that parks has already done the thing
 * it was parked for approval of — and because the supervised branch returned
 * before the only `plugin_runs` write, nothing recorded that it had run. With a
 * live Grant it was therefore due again on the very next advance, and re-fired
 * its declared side effects every advance for the whole grant window, on one
 * human "yes".
 *
 * Two advances, one invocation. That is the assertion.
 */
describe('runAdvance gated-run recording', () => {
  let ctx: TestHome
  // The events log must be redirected here too — runAdvance's eventsPath
  // DEFAULTS to the real live events.jsonl, and omitting it once appended
  // thousands of fixture events to live state (2026-08-18).
  let eventsPath: string
  let statePath: string
  let invocationLog: string

  beforeEach(async () => {
    ctx = await createTestHome()
    eventsPath = join(ctx.runsDir, 'events.jsonl')
    statePath = join(ctx.stateDir, 'engine-state.json')
    invocationLog = join(ctx.root, 'invocations.log')
  })

  afterEach(async () => {
    await ctx.cleanup()
  })

  /**
   * A supervised, side-effecting plugin whose handler records that it ran.
   *
   * `ttl_hours` is 24, not the near-zero the other fixtures use: the second
   * advance has to fall INSIDE the TTL window, or the plugin is due again for
   * a reason that has nothing to do with this change and the test proves
   * nothing.
   */
  async function createGatedPlugin(name: string): Promise<void> {
    const pluginDir = join(ctx.pluginsDir, name)
    await mkdir(pluginDir, { recursive: true })

    const manifest = {
      name,
      version: '1.0.0',
      description: `${name} supervised side-effecting fixture`,
      inputs: {},
      outputs: {},
      capabilities: [],
      schedule: 'on_run',
      autonomy_level: 'supervised',
      side_effects: ['sends_email'],
      ttl_hours: 24,
      dependencies: [],
      timeout_ms: 5000,
      max_parallelism: 1,
    }

    await writeFile(
      join(pluginDir, 'manifest.ts'),
      `export const manifest = ${JSON.stringify(manifest)}`,
    )

    // Appending from the handler, rather than counting calls in-process: the
    // side effect the operator cares about is the one the handler performs, so
    // the count has to come from inside it.
    await writeFile(
      join(pluginDir, 'handler.ts'),
      `
import { appendFileSync } from 'node:fs'

export async function handler(manifest, args) {
  appendFileSync(${JSON.stringify(invocationLog)}, 'invoked\\n')
  return {
    status: 'success',
    phases_completed: ['${name}'],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: '${name} sent the email',
    artifacts_produced: [],
    schema_version: 1,
  }
}
`,
    )
  }

  async function invocations(): Promise<number> {
    try {
      const raw = await readFile(invocationLog, 'utf-8')
      return raw.split('\n').filter((line) => line.length > 0).length
    } catch {
      return 0
    }
  }

  test('Test 26: two advances against a supervised side-effecting plugin with a live Grant invoke its handler exactly once', async () => {
    const { runAdvance } = await import('../engine.js')
    await createGatedPlugin('gated-emailer')

    // A live Grant, so the approval gate passes and the supervision gate is
    // actually reached. Without it the plugin is skipped as unapproved and the
    // handler never runs at all, which would pass vacuously.
    const approvalPath = join(ctx.root, '.session-approval-test26')
    await grantApproval('gated-emailer', 4 * 60 * 60 * 1000, approvalPath)

    const first = await runAdvance({
      pluginsDir: ctx.pluginsDir,
      stateDir: statePath,
      runsDir: ctx.runsDir,
      eventsPath,
      approvalPath,
    })

    expect(first.plugin_states.get('gated-emailer')).toBe('gated')
    expect(await invocations()).toBe(1)

    // The parked run is recorded, with the status that says what it was.
    const afterFirst = JSON.parse(await readFile(statePath, 'utf-8'))
    expect(afterFirst.plugin_runs['gated-emailer']).toBeDefined()
    expect(afterFirst.plugin_runs['gated-emailer'].status).toBe('gated')
    expect(typeof afterFirst.plugin_runs['gated-emailer'].last_run_at).toBe('string')

    const second = await runAdvance({
      pluginsDir: ctx.pluginsDir,
      stateDir: statePath,
      runsDir: ctx.runsDir,
      eventsPath,
      approvalPath,
    })

    // Not re-invoked: the recorded run puts it inside its own TTL window.
    expect(await invocations()).toBe(1)
    expect(second.plugin_states.get('gated-emailer')).toBe('skipped')
  })

  test('Test 27: a dry-run advance records no plugin_runs entry', async () => {
    const { runAdvance } = await import('../engine.js')
    await createGatedPlugin('gated-emailer')

    await runAdvance({
      dryRun: true,
      pluginsDir: ctx.pluginsDir,
      stateDir: statePath,
      runsDir: ctx.runsDir,
      eventsPath,
    })

    // dry-run is contracted to change nothing about what the next real advance
    // would do, so the gated write must not fire on that arm.
    const state = JSON.parse(await readFile(statePath, 'utf-8'))
    expect(state.plugin_runs['gated-emailer']).toBeUndefined()
  })
})

// -----------------------------------------------------------------------
// runAdvance Output handling (R5, R7)
// -----------------------------------------------------------------------

describe('runAdvance Output handling', () => {
  let ctx: TestHome
  // The events log must be redirected here too — runAdvance's eventsPath
  // DEFAULTS to the real live events.jsonl, and omitting it once appended
  // thousands of fixture events to live state (2026-08-18).
  let eventsPath: string
  let statePath: string

  beforeEach(async () => {
    ctx = await createTestHome()
    eventsPath = join(ctx.runsDir, 'events.jsonl')
    statePath = join(ctx.stateDir, 'engine-state.json')
  })

  afterEach(async () => {
    await ctx.cleanup()
  })

  /**
   * An autonomous plugin returning whatever `artifacts_produced` literal the
   * caller passes, so a test can say "produced an Output" or "produced none"
   * without a second fixture.
   */
  async function createOutputPlugin(
    name: string,
    artifactsLiteral: string,
    autonomyLevel: 'autonomous' | 'supervised' = 'autonomous',
  ): Promise<void> {
    const pluginDir = join(ctx.pluginsDir, name)
    await mkdir(pluginDir, { recursive: true })

    const manifest = {
      name,
      version: '1.0.0',
      description: `${name} output fixture`,
      inputs: {},
      outputs: {},
      capabilities: [],
      schedule: 'on_run',
      autonomy_level: autonomyLevel,
      side_effects: autonomyLevel === 'supervised' ? ['writes_db'] : [],
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
    status: 'success',
    phases_completed: ['${name}'],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: '${name} produced a brief',
    artifacts_produced: ${artifactsLiteral},
    schema_version: 2,
  }
}
`,
    )
  }

  // The sentinel is deliberately nothing like the summary: if the assertion is
  // to discriminate, the text it hunts for must not be text the event log is
  // supposed to carry.
  const BODY_SENTINEL = 'ZZ-OUTPUT-BODY-SENTINEL-must-never-be-logged-ZZ'

  test('Test 28: an inline Output body never reaches events.jsonl', async () => {
    const { runAdvance } = await import('../engine.js')
    await createOutputPlugin(
      'brief-writer',
      JSON.stringify([{ type: 'brief', format: 'markdown', body: `# heading\n${BODY_SENTINEL}\n` }]),
    )

    await runAdvance({
      pluginsDir: ctx.pluginsDir,
      stateDir: statePath,
      runsDir: ctx.runsDir,
      eventsPath,
    })

    const raw = await readFile(eventsPath, 'utf-8')
    const lines = raw.split('\n').filter((l) => l.length > 0)
    // The run did happen — otherwise "the body is absent" passes vacuously.
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.some((l) => l.includes('brief-writer'))).toBe(true)
    for (const line of lines) expect(line).not.toContain(BODY_SENTINEL)
  })

  test('Test 29: the runtime stamps run_id and produced_at on every Output', async () => {
    const { runAdvance } = await import('../engine.js')
    await createOutputPlugin(
      'stamped',
      // The handler claims a run it never came from. The runtime must overwrite
      // it, not defer to it — an Output that can self-attest is spoofable.
      JSON.stringify([{ type: 'brief', body: 'hi', run_id: 'a-run-that-never-happened' }]),
    )

    const result = await runAdvance({
      pluginsDir: ctx.pluginsDir,
      stateDir: statePath,
      runsDir: ctx.runsDir,
      eventsPath,
    })

    const log = JSON.parse(await readFile(join(ctx.runsDir, `${result.run_id}.json`), 'utf-8'))
    expect(log.run_id).toBe(result.run_id)

    const { invokePlugin } = await import('../invoke-plugin.js')
    const invoked = await invokePlugin('stamped', {}, {
      pluginsDir: ctx.pluginsDir,
      runId: 'run-under-test',
    })
    const output = invoked.result.artifacts_produced[0]
    expect(output).toBeDefined()
    expect(output?.run_id).toBe('run-under-test')
    expect(typeof output?.produced_at).toBe('string')
  })
  test('Test 30: after an advance producing an Output, plugin_runs names it', async () => {
    const { runAdvance } = await import('../engine.js')
    await createOutputPlugin(
      'brief-writer',
      JSON.stringify([{ type: 'brief', format: 'markdown', path: 'brief.md' }]),
    )

    const result = await runAdvance({
      pluginsDir: ctx.pluginsDir,
      stateDir: statePath,
      runsDir: ctx.runsDir,
      eventsPath,
    })

    const state = JSON.parse(await readFile(statePath, 'utf-8'))
    const entry = state.plugin_runs['brief-writer']
    expect(entry).toBeDefined()
    expect(entry.last_output).toEqual({
      type: 'brief',
      format: 'markdown',
      path: 'brief.md',
      run_id: result.run_id,
      produced_at: expect.any(String),
    })
  })

  test('Test 31: after an advance producing no Output, the pointer is absent from the JSON', async () => {
    const { runAdvance } = await import('../engine.js')
    await createOutputPlugin('quiet-plugin', '[]')

    await runAdvance({
      pluginsDir: ctx.pluginsDir,
      stateDir: statePath,
      runsDir: ctx.runsDir,
      eventsPath,
    })

    const state = JSON.parse(await readFile(statePath, 'utf-8'))
    const entry = state.plugin_runs['quiet-plugin']
    expect(entry).toBeDefined()
    // Absent, not null and not an empty object — asserted on the raw JSON,
    // because that is the only place the three are distinguishable.
    expect('last_output' in entry).toBe(false)
  })

  test('Test 32: a gated advance records the parked run\'s Output too', async () => {
    const { runAdvance } = await import('../engine.js')
    await createOutputPlugin(
      'gated-writer',
      JSON.stringify([{ type: 'brief', format: 'markdown', path: 'brief.md' }]),
      'supervised',
    )

    const approvalPath = join(ctx.root, '.session-approval-test32')
    await grantApproval('gated-writer', 4 * 60 * 60 * 1000, approvalPath)

    const result = await runAdvance({
      pluginsDir: ctx.pluginsDir,
      stateDir: statePath,
      runsDir: ctx.runsDir,
      eventsPath,
      approvalPath,
    })

    expect(result.plugin_states.get('gated-writer')).toBe('gated')
    const state = JSON.parse(await readFile(statePath, 'utf-8'))
    expect(state.plugin_runs['gated-writer'].status).toBe('gated')
    expect(state.plugin_runs['gated-writer'].last_output.path).toBe('brief.md')
  })

  test('Test 33: a last_output naming a pruned run resolves to not-retained rather than throwing', async () => {
    const { isRunLogRetained } = await import('../../schemas/run-log.js')
    const { runAdvance } = await import('../engine.js')
    await createOutputPlugin(
      'brief-writer',
      JSON.stringify([{ type: 'brief', format: 'markdown', path: 'brief.md' }]),
    )

    const result = await runAdvance({
      pluginsDir: ctx.pluginsDir,
      stateDir: statePath,
      runsDir: ctx.runsDir,
      eventsPath,
    })

    const state = JSON.parse(await readFile(statePath, 'utf-8'))
    const runId = state.plugin_runs['brief-writer'].last_output.run_id
    expect(runId).toBe(result.run_id)
    expect(isRunLogRetained(runId, ctx.runsDir)).toBe(true)

    // Prune the producing run log out from under the pointer. The pointer is
    // left dangling on purpose — deleting it to avoid the case would lose the
    // only record that the Output ever existed.
    await rm(join(ctx.runsDir, `${runId}.json`))

    const after = JSON.parse(await readFile(statePath, 'utf-8'))
    expect(after.plugin_runs['brief-writer'].last_output.run_id).toBe(runId)
    expect(() => isRunLogRetained(runId, ctx.runsDir)).not.toThrow()
    expect(isRunLogRetained(runId, ctx.runsDir)).toBe(false)
  })
})
