/**
 * The engine's read-only seam: loader failure reporting, the extracted
 * evaluatePlugin, and the assertion that the extraction did
 * not change what a run skips.
 *
 * The loader used to swallow every manifest import error in a bare `catch {}`,
 * so a broken plugin vanished from the due-set with nothing to show for it.
 * It now returns `{ manifests, failures }` with `failures` sorted by directory
 * name inside the loader, so ordering is a property of the data rather than of
 * whichever surface renders it.
 *
 * Fixtures use the zero-import `export const manifest = {…}` form so a fixture
 * never depends on module resolution from a temp directory.
 */
import { describe, test, expect, beforeEach, afterEach, setSystemTime } from 'bun:test'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadPluginManifests, evaluatePlugin, runAdvance } from '../engine.js'
import type { EvalContext } from '../engine.js'
import { computeTier } from '../tier.js'
import { defaultEngineState, readEngineState, writeEngineState } from '../../schemas/engine-state.js'
import type { PluginManifest } from '../../schemas/plugin-manifest.js'

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

let pluginsDir: string
let root: string

async function writeValidPlugin(name: string): Promise<void> {
  const dir = join(pluginsDir, name)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'manifest.ts'),
    `export const manifest = ${JSON.stringify(makeManifest(name))}`,
  )
}

/** A manifest that throws on import — unterminated object literal. */
async function writeBrokenPlugin(name: string): Promise<void> {
  const dir = join(pluginsDir, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'manifest.ts'), `export const manifest = { name: '${name}',`)
}

beforeEach(async () => {
  root = join(tmpdir(), `warpline-loader-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  pluginsDir = join(root, 'plugins')
  await mkdir(pluginsDir, { recursive: true })
})

afterEach(async () => {
  // setSystemTime is process-global — reset unconditionally, or a frozen clock
  // leaks into sibling files in the same bun process.
  setSystemTime()
  await rm(root, { recursive: true, force: true })
})

describe('loadPluginManifests — per-plugin load failures', () => {
  test('Test 1: a broken manifest is reported in failures with a non-empty error', async () => {
    await writeValidPlugin('fx-good')
    await writeBrokenPlugin('fx-broken')

    const { manifests, failures } = await loadPluginManifests(pluginsDir)

    expect(manifests.has('fx-good')).toBe(true)
    expect(failures).toHaveLength(1)
    expect(failures[0]!.plugin).toBe('fx-broken')
    expect(failures[0]!.error.length).toBeGreaterThan(0)
  })

  test('Test 2: the broken directory is absent from manifests', async () => {
    await writeValidPlugin('fx-good')
    await writeBrokenPlugin('fx-broken')

    const { manifests } = await loadPluginManifests(pluginsDir)

    expect(manifests.has('fx-broken')).toBe(false)
    expect(Array.from(manifests.keys())).toEqual(['fx-good'])
  })

  test('Test 3: failures come back sorted by directory name regardless of creation order', async () => {
    await writeBrokenPlugin('zeta-broken')
    await writeBrokenPlugin('alpha-broken')
    await writeBrokenPlugin('mid-broken')

    const { failures } = await loadPluginManifests(pluginsDir)

    expect(failures.map((f) => f.plugin)).toEqual(['alpha-broken', 'mid-broken', 'zeta-broken'])
  })

  test('Test 4: an all-valid directory returns an empty failures array, not undefined', async () => {
    await writeValidPlugin('fx-a')
    await writeValidPlugin('fx-b')

    const { manifests, failures } = await loadPluginManifests(pluginsDir)

    expect(manifests.size).toBe(2)
    expect(Array.isArray(failures)).toBe(true)
    expect(failures).toEqual([])
  })

  test('Test 5: a missing plugins directory returns empty manifests and empty failures without throwing', async () => {
    const { manifests, failures } = await loadPluginManifests(join(root, 'does-not-exist'))

    expect(manifests.size).toBe(0)
    expect(failures).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// evaluatePlugin
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<EvalContext> = {}): EvalContext {
  return {
    currentTier: 'normal',
    headless: false,
    force: false,
    state: defaultEngineState(),
    approvalPath: join(root, 'no-such-approval'),
    ...overrides,
  }
}

/** Every file under `dir`, sorted — the purity snapshot. */
async function listTree(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  return entries
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name))
    .sort()
}

describe('evaluatePlugin — pure, clock-injected due-ness', () => {
  test('Test 1: a schedule outside the profile tier is not due', async () => {
    const manifest = makeManifest('fx-weekly', { schedule: 'weekly' })
    const ctx = makeCtx({
      profile: 'daily',
      allowedSchedules: new Set(['on_run', 'daily']),
    })

    const result = await evaluatePlugin('fx-weekly', manifest, ctx, Date.now())

    expect(result.due).toBe(false)
    expect(result.due === false && result.reason).toBe('profile_schedule')
    expect(result.due === false && result.detail).toContain('weekly')
  })

  test('Test 2: a plugin below the current tier is not due', async () => {
    const manifest = makeManifest('fx-normal', { min_tier: 'normal' })
    const ctx = makeCtx({ currentTier: 'degraded' })

    const result = await evaluatePlugin('fx-normal', manifest, ctx, Date.now())

    expect(result.due === false && result.reason).toBe('min_tier')
  })

  test('Test 3: headless bypasses supervised; manual is never due', async () => {
    const supervised = await evaluatePlugin(
      'fx-supervised',
      makeManifest('fx-supervised', { autonomy_level: 'supervised' }),
      makeCtx({ headless: true }),
      Date.now(),
    )
    expect(supervised.due === false && supervised.reason).toBe('headless_supervised')

    const manual = await evaluatePlugin(
      'fx-manual',
      makeManifest('fx-manual', { autonomy_level: 'manual' }),
      makeCtx(),
      Date.now(),
    )
    expect(manual.due === false && manual.reason).toBe('manual')
  })

  test('Test 4 (adjacency): a last run exactly ttl_hours ago is stale, so the plugin is due', async () => {
    // The freshness comparison is `now - lastRunMs < ttlMs` — strict, so
    // exactly-at-TTL is NOT fresh. Asserted through evaluatePlugin rather than
    // by restating the operator: a divergence here would make `plan` a lie.
    const now = Date.parse('2026-08-20T12:00:00.000Z')
    setSystemTime(new Date(now))

    const manifest = makeManifest('fx-ttl', { ttl_hours: 24 })
    const state = defaultEngineState()
    state.plugin_runs['fx-ttl'] = {
      last_run_at: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
      status: 'success',
    }

    const result = await evaluatePlugin('fx-ttl', manifest, makeCtx({ state }), now)

    expect(result.due).toBe(true)
  })

  test('Test 5 (adjacency): a grant expiring exactly at now is still approved, so the plugin is due', async () => {
    // checkApproval's comparison is `Date.now() > expires_at` — strict, so
    // exactly-at-expiry is still approved. The frozen clock is what makes this
    // pin the operator direction rather than merely "expires in the future".
    const now = Date.parse('2026-08-20T12:00:00.000Z')
    setSystemTime(new Date(now))

    const approvalPath = join(root, '.session-approval')
    await writeFile(
      approvalPath,
      JSON.stringify({
        granted_at: new Date(now - 1000).toISOString(),
        expires_at: new Date(now).toISOString(),
        scopes: ['fx-writer'],
      }),
    )

    const manifest = makeManifest('fx-writer', { side_effects: ['writes_db'] })

    const result = await evaluatePlugin('fx-writer', manifest, makeCtx({ approvalPath }), now)

    expect(result.due).toBe(true)
  })

  test('Test 6 (purity): the same inputs and the same now give deeply equal results and write nothing', async () => {
    const manifest = makeManifest('fx-pure')
    const ctx = makeCtx()
    const now = Date.parse('2026-08-20T12:00:00.000Z')

    const before = await listTree(root)
    const first = await evaluatePlugin('fx-pure', manifest, ctx, now)
    const second = await evaluatePlugin('fx-pure', manifest, ctx, now)
    const after = await listTree(root)

    expect(first).toEqual(second)
    expect(after).toEqual(before)
  })
})

// ---------------------------------------------------------------------------
// Extraction faithfulness
// ---------------------------------------------------------------------------

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

async function writeRunnablePlugin(manifest: PluginManifest): Promise<void> {
  const dir = join(pluginsDir, manifest.name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'manifest.ts'), `export const manifest = ${JSON.stringify(manifest)}`)
  await writeFile(join(dir, 'handler.ts'), SUCCESS_HANDLER)
}

describe('evaluatePlugin agrees with the run it was extracted from', () => {
  test('the set runAdvance records as skipped equals the set evaluatePlugin calls not-due', async () => {
    // No plugin here declares side effects: the dry-run block is deliberately
    // outside the evaluator, so an approved side-effecting plugin
    // would make the two disagree by design rather than by defect.
    const manifests = [
      makeManifest('fx-due', { schedule: 'on_run' }),
      makeManifest('fx-fresh', { schedule: 'daily', ttl_hours: 24 }),
      makeManifest('fx-manual', { autonomy_level: 'manual' }),
      makeManifest('fx-weekly', { schedule: 'weekly' }),
      makeManifest('fx-supervised', { autonomy_level: 'supervised' }),
    ]
    for (const m of manifests) await writeRunnablePlugin(m)

    const stateDir = join(root, 'state')
    const runsDir = join(root, 'runs')
    const statePath = join(stateDir, 'engine-state.json')
    await mkdir(runsDir, { recursive: true })
    await mkdir(stateDir, { recursive: true })
    await writeFile(join(stateDir, 'preferences.json'), JSON.stringify({ review_gate: false }))

    const seed = defaultEngineState()
    seed.last_interaction_at = new Date().toISOString()
    // 1h ago against a 24h TTL — deep inside the window, so clock drift between
    // the run and the evaluation cannot flip this one either way.
    seed.plugin_runs['fx-fresh'] = {
      last_run_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      status: 'success',
    }
    await writeEngineState(seed, statePath)

    // Evaluate against the PRE-run state: runAdvance mutates plugin_runs and
    // last_interaction_at and persists them, so a post-run read would report
    // the just-run plugins as fresh and the two sets would diverge by design.
    const preState = await readEngineState(statePath)
    const ctx: EvalContext = {
      allowedSchedules: new Set(['on_run', 'daily']),
      profile: 'daily',
      currentTier: computeTier(preState.last_interaction_at),
      headless: true,
      force: false,
      state: preState,
      approvalPath: join(root, 'no-such-approval'),
    }
    const now = Date.now()

    const result = await runAdvance({
      pluginsDir,
      stateDir: statePath,
      runsDir,
      eventsPath: join(runsDir, 'events.jsonl'),
      profile: 'daily',
    })

    const runSkipped = Array.from(result.plugin_states.entries())
      .filter(([, status]) => status === 'skipped')
      .map(([name]) => name)
      .sort()

    const evalNotDue: string[] = []
    for (const m of manifests) {
      const ev = await evaluatePlugin(m.name, m, ctx, now)
      if (!ev.due) evalNotDue.push(m.name)
    }
    evalNotDue.sort()

    expect(evalNotDue).toEqual(runSkipped)
    // Guard against the assertion passing vacuously on two empty sets.
    expect(runSkipped).toEqual(['fx-fresh', 'fx-manual', 'fx-supervised', 'fx-weekly'])
    expect(result.plugin_states.get('fx-due')).toBe('completed')
  })
})
