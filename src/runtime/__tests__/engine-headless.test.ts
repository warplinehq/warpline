/**
 * Engine headless + profile filter tests
 *
 * Covers decisions:
 *   daily profile runs on_run + daily plugins only
 *   weekly profile runs on_run + daily + weekly plugins; skips manual
 *   onRunFailure fires exactly once on a non-complete status
 *   A2:   supervised plugins are skipped (not gated) in headless/profile mode
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runAdvance } from '../engine.js'
import type { PluginManifest } from '../../schemas/plugin-manifest.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManifest(name: string, overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    name,
    version: '1.0.0',
    description: `${name} fixture plugin`,
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

const SUCCESS_HANDLER = `
export async function handler(_manifest, _args) {
  return {
    status: 'success',
    phases_completed: [],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: 'fixture ok',
    artifacts_produced: [],
    schema_version: 1,
  }
}
`

async function writePlugin(
  pluginsDir: string,
  manifest: PluginManifest,
): Promise<void> {
  const dir = join(pluginsDir, manifest.name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'manifest.ts'), `export const manifest = ${JSON.stringify(manifest)}`)
  await writeFile(join(dir, 'handler.ts'), SUCCESS_HANDLER)
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

interface HeadlessFixture {
  pluginsDir: string
  /**
   * Full path to the state JSON file.
   * NOTE: engine's `stateDir` option is actually the full file path, not a directory.
   * Matches `getDefaultStatePath()` which returns `.warpline/state/engine-state.json`.
   */
  statePath: string
  runsDir: string
  eventsPath: string
  root: string
  cleanup: () => Promise<void>
}

async function createHeadlessFixture(): Promise<HeadlessFixture> {
  const root = join(tmpdir(), `warpline-headless-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  const pluginsDir = join(root, 'plugins')
  const stateDir = join(root, 'state')
  // Engine's stateDir option = full path to the JSON file (not the containing dir)
  const statePath = join(stateDir, 'engine-state.json')
  const runsDir = join(root, 'runs')

  await mkdir(pluginsDir, { recursive: true })
  await mkdir(stateDir, { recursive: true })
  await mkdir(runsDir, { recursive: true })

  // Write preferences with review_gate off so supervised plugins don't block
  await writeFile(join(stateDir, 'preferences.json'), JSON.stringify({ review_gate: false }))

  // Write 5 fixture plugins:
  await writePlugin(pluginsDir, makeManifest('fx-onrun', { schedule: 'on_run', autonomy_level: 'autonomous' }))
  await writePlugin(pluginsDir, makeManifest('fx-daily', { schedule: 'daily', autonomy_level: 'autonomous' }))
  await writePlugin(pluginsDir, makeManifest('fx-weekly', { schedule: 'weekly', autonomy_level: 'autonomous' }))
  await writePlugin(pluginsDir, makeManifest('fx-manual', { schedule: 'manual', autonomy_level: 'autonomous' }))
  await writePlugin(pluginsDir, makeManifest('fx-supervised', { schedule: 'on_run', autonomy_level: 'supervised' }))

  return {
    root,
    pluginsDir,
    statePath,
    runsDir,
    // Redirect board events too — runAdvance's eventsPath defaults to the
    // REAL .warpline/state/events.jsonl (fixture fx-* events leaked, 2026-08-18).
    eventsPath: join(runsDir, 'events.jsonl'),
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let fixture: HeadlessFixture

beforeEach(async () => {
  fixture = await createHeadlessFixture()
})

afterEach(async () => {
  await fixture.cleanup()
})

describe('Engine profile filter', () => {
  test('daily profile runs on_run + daily; skips weekly + manual', async () => {
    const result = await runAdvance({
      pluginsDir: fixture.pluginsDir,
      stateDir: fixture.statePath,
      runsDir: fixture.runsDir,
      eventsPath: fixture.eventsPath,
      profile: 'daily',
    })

    expect(result.plugin_states.get('fx-onrun')).toBe('completed')
    expect(result.plugin_states.get('fx-daily')).toBe('completed')
    expect(result.plugin_states.get('fx-weekly')).toBe('skipped')
    expect(result.plugin_states.get('fx-manual')).toBe('skipped')
  })

  test('weekly profile runs on_run + daily + weekly; skips manual', async () => {
    const result = await runAdvance({
      pluginsDir: fixture.pluginsDir,
      stateDir: fixture.statePath,
      runsDir: fixture.runsDir,
      eventsPath: fixture.eventsPath,
      profile: 'weekly',
    })

    expect(result.plugin_states.get('fx-onrun')).toBe('completed')
    expect(result.plugin_states.get('fx-daily')).toBe('completed')
    expect(result.plugin_states.get('fx-weekly')).toBe('completed')
    expect(result.plugin_states.get('fx-manual')).toBe('skipped')
  })

  // "Everything was deselected" is not "nothing was found". These two say so:
  // the manifests all load, the tier filter or the dry run then removes every
  // one of them from the work, and the run is still complete. The status that
  // marks a root which loaded nothing must not fire here.
  test('a profile that filters out every loaded manifest still reports complete', async () => {
    // A root of its own, because the shared fixture always has at least one
    // eligible plugin under every profile. Here all three manifests load and
    // the tier filter removes all three.
    const root = join(tmpdir(), `warpline-headless-allfiltered-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    const filteredPlugins = join(root, 'plugins')
    const filteredState = join(root, 'state')
    const filteredRuns = join(root, 'runs')
    await mkdir(filteredPlugins, { recursive: true })
    await mkdir(filteredState, { recursive: true })
    await mkdir(filteredRuns, { recursive: true })
    await writeFile(join(filteredState, 'preferences.json'), JSON.stringify({ review_gate: false }))
    for (const name of ['fx-w1', 'fx-w2', 'fx-w3']) {
      await writePlugin(filteredPlugins, makeManifest(name, { schedule: 'weekly', autonomy_level: 'autonomous' }))
    }

    try {
      const result = await runAdvance({
        pluginsDir: filteredPlugins,
        stateDir: join(filteredState, 'engine-state.json'),
        runsDir: filteredRuns,
        eventsPath: join(filteredRuns, 'events.jsonl'),
        // Weekly schedules are not eligible under the manual tier, so every
        // one of the three is deselected.
        profile: 'manual',
      })

      const states = Array.from(result.plugin_states.values())
      expect(states).toHaveLength(3)
      expect(states.filter((st) => st === 'skipped')).toHaveLength(3)
      expect(result.status).toBe('complete')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a dry run over a root whose manifests all load reports complete', async () => {
    const result = await runAdvance({
      pluginsDir: fixture.pluginsDir,
      stateDir: fixture.statePath,
      runsDir: fixture.runsDir,
      eventsPath: fixture.eventsPath,
      dryRun: true,
    })

    expect(result.status).toBe('complete')
  })

  test('no-profile (undefined): runs ALL plugins including manual (existing interactive behavior)', async () => {
    const result = await runAdvance({
      pluginsDir: fixture.pluginsDir,
      stateDir: fixture.statePath,
      runsDir: fixture.runsDir,
      eventsPath: fixture.eventsPath,
      // No profile — undefined — should preserve existing behavior
    })

    // When no profile is set, all non-supervised autonomous plugins run
    expect(result.plugin_states.get('fx-onrun')).toBe('completed')
    expect(result.plugin_states.get('fx-daily')).toBe('completed')
    expect(result.plugin_states.get('fx-weekly')).toBe('completed')
    expect(result.plugin_states.get('fx-manual')).toBe('completed')
  })
})

describe('Engine headless — supervised plugin handling (assumption A2)', () => {
  test('A2: supervised plugin is skipped (not gated) when profile is defined (headless mode)', async () => {
    const result = await runAdvance({
      pluginsDir: fixture.pluginsDir,
      stateDir: fixture.statePath,
      runsDir: fixture.runsDir,
      eventsPath: fixture.eventsPath,
      profile: 'daily',
    })

    // In headless mode, supervised plugins must NOT be gated (block the run).
    // They should be skipped (not gated) per assumption A2 in RESEARCH.md.
    const supervisedState = result.plugin_states.get('fx-supervised')
    expect(supervisedState).toBe('skipped')
    // Confirm it was not gated — headless runs must not block on supervision
    expect(result.gated_plugins).not.toContain('fx-supervised')
  })
})

describe('Engine headless — onRunFailure notification hook', () => {
  test('onRunFailure spy is called exactly once when overall run status is non-complete', async () => {
    let failureCallCount = 0
    let capturedReason: string | undefined

    // Create an isolated plugin dir with only a failing plugin for this test
    const failRoot = join(tmpdir(), `warpline-headless-fail-${Date.now()}`)
    const failPluginsDir = join(failRoot, 'plugins')
    const failStateFileDir = join(failRoot, 'state')
    // Engine stateDir = full path to state JSON file
    const failStatePath = join(failStateFileDir, 'engine-state.json')
    const failRunsDir = join(failRoot, 'runs')
    await mkdir(failPluginsDir, { recursive: true })
    await mkdir(failStateFileDir, { recursive: true })
    await mkdir(failRunsDir, { recursive: true })
    await writeFile(join(failStateFileDir, 'preferences.json'), JSON.stringify({ review_gate: false }))

    // Plugin that throws so the run becomes 'partial' or 'interrupted'
    const throwingManifest = makeManifest('fx-throws', { schedule: 'daily', autonomy_level: 'autonomous' })
    const throwingDir = join(failPluginsDir, 'fx-throws')
    await mkdir(throwingDir, { recursive: true })
    await writeFile(join(throwingDir, 'manifest.ts'), `export const manifest = ${JSON.stringify(throwingManifest)}`)
    await writeFile(join(throwingDir, 'handler.ts'), `
      export async function handler(_manifest, _args) {
        throw new Error('intentional failure for the onRunFailure test')
      }
    `)

    await runAdvance({
      pluginsDir: failPluginsDir,
      stateDir: failStatePath,
      runsDir: failRunsDir,
      eventsPath: fixture.eventsPath,
      profile: 'daily',
      onRunFailure: (reason: string) => {
        failureCallCount++
        capturedReason = reason
      },
    })

    await rm(failRoot, { recursive: true, force: true })

    // onRunFailure must be called exactly once when status != 'complete'
    expect(failureCallCount).toBe(1)
    expect(typeof capturedReason).toBe('string')
    expect(capturedReason!.length).toBeGreaterThan(0)
  })
})
