/**
 * `warpline plan` builder + entry-point tests — fixture homes, in process (D-27).
 *
 * `createTestHome` is imported across directories rather than re-implemented:
 * one helper means one definition of "a warpline home with every required
 * fixture". `_setHome` re-roots path resolution, and the state-manager paths
 * global is snapshotted once and restored in `afterAll`, because bun's module
 * state is process-global and a leaked temp path breaks sibling files in the
 * same shard.
 */
import { describe, test, expect, beforeEach, afterEach, afterAll } from 'bun:test'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTestHome } from '../../runtime/__tests__/helpers/create-test-home.js'
import type { TestHome } from '../../runtime/__tests__/helpers/create-test-home.js'
import { _setHome } from '../../lib/paths.js'
import { _getPaths, _setPaths } from '../../board/state-manager.js'
import { buildPlanModel, run } from '../plan.js'

const REAL_PATHS = _getPaths()

/** Run an async fn with stdout/stderr captured, always restoring the originals. */
async function capture(
  fn: () => Promise<number>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const realOut = process.stdout.write
  const realErr = process.stderr.write
  let stdout = ''
  let stderr = ''
  process.stdout.write = ((chunk: string) => {
    stdout += chunk
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string) => {
    stderr += chunk
    return true
  }) as typeof process.stderr.write
  try {
    return { code: await fn(), stdout, stderr }
  } finally {
    process.stdout.write = realOut
    process.stderr.write = realErr
  }
}

/**
 * Zero-import manifest fixture: a plain `export const manifest = {…}` with every
 * field spelled out. `loadPluginManifests` casts rather than parses, so no Zod
 * default is applied and an omitted field would read as undefined.
 */
async function writePlugin(
  home: TestHome,
  name: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const manifest = {
    name,
    version: '1.0.0',
    description: `fixture ${name}`,
    inputs: {},
    outputs: {},
    capabilities: [],
    schedule: 'on_run',
    autonomy_level: 'autonomous',
    side_effects: [],
    ttl_hours: 24,
    dependencies: [],
    timeout_ms: 5000,
    max_retries: 1,
    retry_delay_ms: 2000,
    max_parallelism: 1,
    min_tier: 'normal',
    ...overrides,
  }
  const dir = join(home.pluginsDir, name)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'manifest.ts'),
    `export const manifest = ${JSON.stringify(manifest, null, 2)}\n`,
  )
}

async function writeState(home: TestHome, pluginRuns: Record<string, unknown>): Promise<void> {
  await writeFile(
    join(home.stateDir, 'engine-state.json'),
    JSON.stringify({
      schema_version: 1,
      last_run_id: null,
      last_run_at: null,
      last_interaction_at: null,
      plugin_runs: pluginRuns,
      deferrals: [],
      task_aging: [],
      completed_tasks: [],
      pending_gates: [],
      extensions: {},
    }),
  )
}

/** Every file under `dir`, recursively, as paths relative to it. */
async function walk(dir: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const child = join(dir, entry.name)
    if (entry.isDirectory()) {
      found.push(...(await walk(child)).map((p) => join(entry.name, p)))
    } else {
      found.push(entry.name)
    }
  }
  return found
}

let home: TestHome

beforeEach(async () => {
  home = await createTestHome()
  _setHome(home.root)
})

afterEach(async () => {
  _setHome(null)
  await home.cleanup()
})

afterAll(() => {
  _setPaths(REAL_PATHS)
})

describe('buildPlanModel', () => {
  test('Test 1: due and not-due union every loaded plugin, with topoSort levels', async () => {
    await writePlugin(home, 'alpha')
    await writePlugin(home, 'bravo')
    await writePlugin(home, 'charlie', { dependencies: ['alpha'] })
    // bravo ran 10 minutes ago, inside its 24h TTL — so it is fresh, not due.
    await writeState(home, {
      bravo: { last_run_at: new Date(Date.now() - 10 * 60_000).toISOString(), status: 'success' },
    })

    const model = await buildPlanModel(Date.now())

    const names = [...model.due, ...model.notDue].map((e) => e.plugin).sort()
    expect(names).toEqual(['alpha', 'bravo', 'charlie'])
    expect(model.failures).toEqual([])

    const level = (n: string) =>
      [...model.due, ...model.notDue].find((e) => e.plugin === n)?.level
    expect(level('alpha')).toBe(0)
    expect(level('bravo')).toBe(0)
    expect(level('charlie')).toBe(1)

    expect(model.due.map((e) => e.plugin).sort()).toEqual(['alpha', 'charlie'])
    expect(model.pluginsDir).toBe(home.pluginsDir)
  })

  test('Test 2: not-due entries carry the evaluator\'s reason code, not a restated string', async () => {
    await writePlugin(home, 'fresh-one')
    await writePlugin(home, 'manual-one', { autonomy_level: 'manual' })
    await writePlugin(home, 'gated-one', { side_effects: ['sends_email'] })
    await writeState(home, {
      'fresh-one': { last_run_at: new Date(Date.now() - 60_000).toISOString(), status: 'success' },
    })

    const model = await buildPlanModel(Date.now())
    const reason = (n: string) => model.notDue.find((e) => e.plugin === n)?.reason

    expect(reason('fresh-one')).toBe('fresh')
    expect(reason('manual-one')).toBe('manual')
    // No grant file exists, so the gate blocks the side-effecting plugin — and
    // its declared effects travel with the entry so the ⚠ marker can render.
    expect(reason('gated-one')).toBe('unapproved')
    expect(model.notDue.find((e) => e.plugin === 'gated-one')?.sideEffects).toEqual(['sends_email'])
    expect(model.notDue.find((e) => e.plugin === 'gated-one')?.approved).toBe(false)
  })

  test('Test 3: --profile weekly narrows the due set and bypasses supervised plugins', async () => {
    await writePlugin(home, 'weekly-one', { schedule: 'weekly' })
    await writePlugin(home, 'manual-schedule', { schedule: 'manual' })
    await writePlugin(home, 'supervised-one', { autonomy_level: 'supervised' })

    const unprofiled = await buildPlanModel(Date.now())
    expect(unprofiled.due.map((e) => e.plugin).sort()).toEqual([
      'manual-schedule',
      'supervised-one',
      'weekly-one',
    ])

    const weekly = await buildPlanModel(Date.now(), 'weekly')
    expect(weekly.due.map((e) => e.plugin)).toEqual(['weekly-one'])

    const reason = (n: string) => weekly.notDue.find((e) => e.plugin === n)?.reason
    expect(reason('manual-schedule')).toBe('profile_schedule')
    expect(reason('supervised-one')).toBe('headless_supervised')
  })
})

describe('run', () => {
  test('Test 4: an invalid --profile and an unknown flag each exit 1 on stderr', async () => {
    await writePlugin(home, 'alpha')

    const bogus = await capture(() => run(['--profile', 'bogus']))
    expect(bogus.code).toBe(1)
    expect(bogus.stdout).toBe('')
    expect(bogus.stderr).toContain("invalid --profile 'bogus'")
    expect(bogus.stderr).toContain('Usage: warpline plan')

    const unknown = await capture(() => run(['--nope']))
    expect(unknown.code).toBe(1)
    expect(unknown.stdout).toBe('')
    expect(unknown.stderr).toContain('Usage: warpline plan')
  })

  test('Test 5: a corrupt engine-state.json produces no .corrupt file anywhere in the home', async () => {
    await writePlugin(home, 'alpha')
    await writeFile(join(home.stateDir, 'engine-state.json'), '{ this is not json')

    const { code } = await capture(() => run([]))
    expect(code).toBe(0)

    const files = await walk(home.root)
    expect(files.filter((f) => f.endsWith('.corrupt'))).toEqual([])
  })

  test('Test 6: a home with no plugins directory exits 0 and names the resolved directory', async () => {
    await rm(home.pluginsDir, { recursive: true, force: true })

    const { code, stdout } = await capture(() => run([]))

    expect(code).toBe(0)
    expect(stdout).toContain(home.pluginsDir)
    expect(stdout).toContain('No plugins installed.')
  })
})
