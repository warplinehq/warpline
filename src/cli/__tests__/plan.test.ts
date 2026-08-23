/**
 * `warpline plan` builder + entry-point tests — fixture homes, in process.
 *
 * `createTestHome` is imported across directories rather than re-implemented:
 * one helper means one definition of "a warpline home with every required
 * fixture". `_setHome` re-roots path resolution, and the state-manager paths
 * global is snapshotted once and restored in `afterAll`, because bun's module
 * state is process-global and a leaked temp path breaks sibling files in the
 * same shard.
 */
import { describe, test, expect, beforeEach, afterEach, afterAll, setSystemTime } from 'bun:test'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createTestHome } from '../../runtime/__tests__/helpers/create-test-home.js'
import type { TestHome } from '../../runtime/__tests__/helpers/create-test-home.js'
import { _setHome } from '../../lib/paths.js'
import { _getPaths, _setPaths, pathsForStateFile } from '../../board/state-manager.js'
import { runAdvance } from '../../runtime/engine.js'
import { buildPlanModel, run } from '../plan.js'
import { main } from '../warpline.js'

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

async function writeState(
  home: TestHome,
  pluginRuns: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Promise<void> {
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
      ...extra,
    }),
  )
}

/**
 * A handler that returns a valid `SkillResult`.
 *
 * `plan` never reads this file — that is the point of the prohibition tests in
 * `plan-prohibition.test.ts`. It exists because the equivalence proof below
 * runs a REAL `runAdvance`, which invokes every plugin it attempts; a plugin
 * with no `handler.ts` would still be "attempted" but the failure noise buys
 * nothing.
 */
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

async function writeHandler(home: TestHome, name: string): Promise<void> {
  await writeFile(join(home.pluginsDir, name, 'handler.ts'), SUCCESS_HANDLER)
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

  /**
   * WR-02 regression witness: `currentTier` must come from the INJECTED `now`,
   * never from `computeTier`'s `Date.now()` default.
   *
   * Every other test here passes `Date.now()` as `now`, so the two clocks agree
   * and no assertion can separate them — which is how the bug survived. This
   * fixture forces them apart: `now` is pinned to a fixed 2020 instant and
   * `last_interaction_at` is 3 days before THAT.
   *
   *   injected `now`  -> idle 3 days -> 'degraded'
   *   real Date.now() -> idle ~6 yrs -> 'suspended'
   *
   * `currentTier` never leaves `buildPlanModel`, so it is observed through the
   * gate it feeds: `min_tier: 'degraded'` runs at 'degraded' and is blocked at
   * 'suspended' (tier.ts:89 — a plugin runs when the current tier's order is <=
   * its min_tier order). The same plugin therefore lands on opposite sides
   * depending on which clock was read. Drop the second argument at plan.ts:132
   * and this turns red.
   */
  test('Test 5: currentTier comes from the injected clock, not the wall clock', async () => {
    const PINNED_NOW = Date.parse('2020-06-01T12:00:00.000Z')
    const IDLE_DAYS_MS = 3 * 86_400_000

    await writePlugin(home, 'tier-sensitive', { min_tier: 'degraded' })
    await writeState(
      home,
      {},
      { last_interaction_at: new Date(PINNED_NOW - IDLE_DAYS_MS).toISOString() },
    )

    const model = await buildPlanModel(PINNED_NOW)

    // Due under the injected clock ('degraded'); min_tier-blocked under the
    // wall clock ('suspended').
    expect(model.due.map((e) => e.plugin)).toEqual(['tier-sensitive'])
    expect(model.notDue.find((e) => e.plugin === 'tier-sensitive')).toBeUndefined()
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

/**
 * The dispatcher arm needed no change when the stub body was replaced —
 * `src/cli/warpline.ts` was closed for modification in plan 02-01 precisely so
 * the subcommand plans could land in parallel. These cases go through
 * `main(argv)` to prove it.
 */
describe('main([plan]) end to end', () => {
  test('some due: exit 0, side effects indented under their plugin with a marker', async () => {
    await writePlugin(home, 'alpha')
    await writePlugin(home, 'gated-one', { side_effects: ['sends_email', 'writes_db'] })
    await writeFile(
      join(home.root, '.session-approval'),
      JSON.stringify({
        granted_at: new Date(Date.now() - 60_000).toISOString(),
        // +30s of slack so the floored minute count cannot straddle a boundary
        // between this write and the clock read inside `run`.
        expires_at: new Date(Date.now() + 90 * 60_000 + 30_000).toISOString(),
        scopes: ['gated-one'],
      }),
    )

    const { code, stdout, stderr } = await capture(() => main(['plan']))

    expect(code).toBe(0)
    expect(stderr).toBe('')
    expect(stdout).toContain('Grant: gated-one — 90m remaining')
    expect(stdout).toContain('  gated-one (level 0)')
    // Manifest declaration order, each effect carrying its own marker.
    expect(stdout).toContain('    sends_email: ✓ approved')
    expect(stdout).toContain('    writes_db: ✓ approved')
    expect(stdout.indexOf('sends_email')).toBeLessThan(stdout.indexOf('writes_db'))
    expect(stdout).toContain('  alpha (level 0)')
    expect(stdout).toContain('    (no declared side effects)')
    // Both plugins are due, and the not-due section is still there saying so.
    expect(stdout).toContain('Not due: none — every plugin passed the filter chain.')
  })

  test('none due: exit 0, the distinct message and a not-due entry for every plugin', async () => {
    await writePlugin(home, 'alpha')
    await writePlugin(home, 'bravo')
    const recent = new Date(Date.now() - 60_000).toISOString()
    await writeState(home, {
      alpha: { last_run_at: recent, status: 'success' },
      bravo: { last_run_at: recent, status: 'success' },
    })

    const { code, stdout } = await capture(() => main(['plan']))

    expect(code).toBe(0)
    expect(stdout).toContain('Nothing is due — no plugin passed the filter chain.')
    expect(stdout).toContain('Not due (2):')
    expect(stdout).toContain('  alpha — within TTL (24h)')
    expect(stdout).toContain('  bravo — within TTL (24h)')
    expect(stdout).not.toContain('Due (')
  })

  test('no plugins installed: exit 0, names the directory and points at scaffold', async () => {
    await rm(home.pluginsDir, { recursive: true, force: true })

    const { code, stdout } = await capture(() => main(['plan']))

    expect(code).toBe(0)
    expect(stdout).toContain('No plugins installed.')
    expect(stdout).toContain(home.pluginsDir)
    expect(stdout).toContain('warpline scaffold')
  })

  test('byte identity: two consecutive runs on a frozen clock produce equal stdout', async () => {
    // A grant and a fresh plugin between them exercise every clock-derived
    // string in the output: the remaining-minutes header and "Nm ago".
    const frozen = new Date('2026-08-20T12:00:00.000Z')
    await writePlugin(home, 'alpha')
    await writePlugin(home, 'bravo')
    await writeState(home, {
      bravo: {
        last_run_at: new Date(frozen.getTime() - 12 * 60_000).toISOString(),
        status: 'success',
      },
    })
    await writeFile(
      join(home.root, '.session-approval'),
      JSON.stringify({
        granted_at: frozen.toISOString(),
        expires_at: new Date(frozen.getTime() + 37 * 60_000 + 59_000).toISOString(),
        scopes: '*',
      }),
    )

    setSystemTime(frozen)
    try {
      const first = await capture(() => main(['plan']))
      const second = await capture(() => main(['plan']))

      expect(first.code).toBe(0)
      expect(first.stdout).toBe(second.stdout)
      // Rounded down, never up: 37m59s of grant left reads 37m.
      expect(first.stdout).toContain('Grant: all plugins (*) — 37m remaining')
      expect(first.stdout).toContain('last run 12m ago')
      expect(first.stdout.includes(String.fromCharCode(0x1b))).toBe(false)
    } finally {
      setSystemTime()
    }
  })

  test('--profile weekly: exit 0 and output differs from the unprofiled run', async () => {
    await writePlugin(home, 'weekly-one', { schedule: 'weekly' })
    await writePlugin(home, 'manual-schedule', { schedule: 'manual' })
    await writePlugin(home, 'supervised-one', { autonomy_level: 'supervised' })

    const unprofiled = await capture(() => main(['plan']))
    const weekly = await capture(() => main(['plan', '--profile', 'weekly']))

    expect(weekly.code).toBe(0)
    expect(weekly.stdout).not.toBe(unprofiled.stdout)

    expect(unprofiled.stdout).toContain('Due (3):')
    expect(weekly.stdout).toContain('Due (1):')
    expect(weekly.stdout).toContain('  weekly-one (level 0)')
    expect(weekly.stdout).toContain(
      '  supervised-one — headless mode: supervised plugin bypassed (no interactive gate)',
    )
    expect(weekly.stdout).toContain("  manual-schedule — profile 'weekly' filter")
  })

  test('--profile bogus: exit 1 with output on stderr, nothing on stdout', async () => {
    await writePlugin(home, 'alpha')

    const { code, stdout, stderr } = await capture(() => main(['plan', '--profile', 'bogus']))

    expect(code).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).not.toBe('')
  })
})

/**
 * The equivalence proof: `plan`'s due-set is exactly what a run would attempt.
 *
 * This is the assertion that makes `plan` worth printing. `buildPlanModel` and
 * `runAdvance` share `evaluatePlugin`, so the two agree *by construction* — but
 * "by construction" is a claim about today's code, and the whole reason the
 * evaluator was extracted is that the two used to be separate guard
 * chains that drifted by one comparison operator. This test is what makes a
 * future re-divergence a red test instead of a support ticket.
 *
 * ── Two fixture constraints that are load-bearing ──
 *
 * 1. **No plugin may have both a non-empty `side_effects` array and an approval
 *    covering it**. `runAdvance`'s dry-run block sits OUTSIDE
 *    `evaluatePlugin` and skips every side-effecting plugin before the approval
 *    check, so under `dryRun: true` an approved side-effecting plugin is "not
 *    attempted" while `plan` correctly renders it as due-and-approved. That is
 *    not a defect in either — `plan` models a real run, not a dry run. Adding an
 *    approved side-effecting plugin here would encode that contradiction into
 *    the assertion and force someone to "fix" it by weakening the proof. The
 *    fixture below has exactly one side-effecting plugin and deliberately grants
 *    it nothing, so it is not-due in `plan` and dry-run-blocked in the run —
 *    absent from both sets, for two different reasons that agree.
 *
 * 2. **`buildPlanModel` runs BEFORE `runAdvance`, always.** A real run writes
 *    `plugin_runs`, `last_run_at` and (in a degraded tier) auto-deferrals. Plan
 *    it second and it reads state the run just mutated, and the freshness and
 *    task-lock fixtures evaporate.
 *
 * The whole test routes through `state-manager`'s `_setPaths` seam because
 * `checkTaskLock` reads `activePaths().v2StatePath` — a module global with no
 * override parameter. Without the seam the task-lock guard consults
 * live state and the fixture proves nothing. The global is restored in this
 * file's existing `afterAll`.
 *
 * Clock: `now` is injected into `buildPlanModel`, but `isPluginFresh` and
 * `checkApproval` read the wall clock directly (02-04's documented seam limit),
 * so every fixture boundary below is hours away from its threshold rather than
 * milliseconds. This proof is about set membership, not about edge timing —
 * the exactly-at-TTL edges are pinned in the runtime's own tests.
 */
describe('plan ≡ what a run would attempt', () => {
  const DAY_MS = 86_400_000

  /** Point the state-manager global at this fixture home and return the paths. */
  function routeStateManager(): { statePath: string; eventsPath: string } {
    const statePath = join(home.stateDir, 'engine-state.json')
    const eventsPath = join(home.stateDir, 'events.jsonl')
    _setPaths(pathsForStateFile(statePath, { eventsPath }))
    return { statePath, eventsPath }
  }

  /**
   * The set of plugins the run actually reached, taken from `onPluginStart` —
   * the callback `runAdvance` fires immediately after setting a plugin's FSM to
   * 'running'. That is the definition of "attempted": it fires after every skip
   * arm AND after the dry-run block, so it cannot be confused with a plugin that
   * was merely considered.
   */
  async function attemptedByRun(
    statePath: string,
    eventsPath: string,
    profile?: 'daily' | 'weekly' | 'manual',
  ): Promise<Set<string>> {
    const attempted = new Set<string>()
    await runAdvance({
      dryRun: true,
      profile,
      pluginsDir: home.pluginsDir,
      stateDir: statePath,
      runsDir: home.runsDir,
      eventsPath,
      preferencesPath: join(home.stateDir, 'preferences.json'),
      approvalPath: join(home.root, '.session-approval'),
      onPluginStart: (plugin) => {
        attempted.add(plugin)
      },
    })
    return attempted
  }

  /**
   * One fixture spanning every guard in the chain, so the set equality below is
   * meaningful rather than vacuous: an eight-plugin home where seven are
   * excluded for seven DIFFERENT reasons and one is due.
   *
   * `min_tier: 'suspended'` on everything except `tier-blocked` reads backwards
   * and is correct — 'suspended' means "runs at any degradation level" and
   * 'normal' means "only in normal tier" (see tier.ts). The state's
   * `last_interaction_at` is 3 days stale, so the tier is 'degraded' and only
   * `tier-blocked` is caught by it.
   */
  async function writeSpanningFixture(): Promise<void> {
    const tolerant = { min_tier: 'suspended' }
    await writePlugin(home, 'due-one', tolerant)
    await writePlugin(home, 'weekly-one', { ...tolerant, schedule: 'weekly' })
    await writePlugin(home, 'tier-blocked', { min_tier: 'normal' })
    await writePlugin(home, 'supervised-one', { ...tolerant, autonomy_level: 'supervised' })
    await writePlugin(home, 'manual-one', { ...tolerant, autonomy_level: 'manual' })
    await writePlugin(home, 'fresh-one', tolerant)
    await writePlugin(home, 'locked-one', tolerant)
    // The ONLY side-effecting plugin, and no .session-approval file exists —
    // see fixture constraint 1 above. Do not grant this.
    await writePlugin(home, 'gated-one', { ...tolerant, side_effects: ['sends_email'] })

    for (const name of [
      'due-one',
      'weekly-one',
      'tier-blocked',
      'supervised-one',
      'manual-one',
      'fresh-one',
      'locked-one',
      'gated-one',
    ]) {
      await writeHandler(home, name)
    }

    await writeState(
      home,
      // 1 hour into a 24h TTL — hours from the boundary in both directions.
      { 'fresh-one': { last_run_at: new Date(Date.now() - 3_600_000).toISOString(), status: 'success' } },
      {
        last_interaction_at: new Date(Date.now() - 3 * DAY_MS).toISOString(),
        task_aging: [
          {
            task_id: 'locked-task',
            first_flagged: new Date(Date.now() - DAY_MS).toISOString(),
            description: 'an open task locking its source plugin',
            // 'critical', deliberately: a degraded tier auto-defers
            // info-severity tasks, which would release the lock mid-fixture.
            severity: 'critical',
            source_check: 'locked-one',
          },
        ],
      },
    )
  }

  test('Test 1: the due-set and the attempted-set are the same set', async () => {
    await writeSpanningFixture()
    const { statePath, eventsPath } = routeStateManager()

    // Plan first — a real run mutates the state this fixture depends on.
    const model = await buildPlanModel(Date.now(), 'daily')
    const attempted = await attemptedByRun(statePath, eventsPath, 'daily')

    const planned = new Set(model.due.map((e) => e.plugin))

    // Asserted as sorted arrays so a mismatch names the offending plugin
    // instead of printing "Set(1) !== Set(2)".
    expect([...planned].sort()).toEqual([...attempted].sort())
    expect([...planned].sort()).toEqual(['due-one'])
  })

  test('Test 2: the fixture spans every guard, so the equality is not vacuous', async () => {
    await writeSpanningFixture()
    const { statePath, eventsPath } = routeStateManager()

    const model = await buildPlanModel(Date.now(), 'daily')
    const attempted = await attemptedByRun(statePath, eventsPath, 'daily')

    const reason = (n: string) => model.notDue.find((e) => e.plugin === n)?.reason

    // Seven plugins, seven distinct not-due reason codes — every arm of
    // evaluatePlugin's chain, in chain order.
    expect(reason('weekly-one')).toBe('profile_schedule')
    expect(reason('tier-blocked')).toBe('min_tier')
    expect(reason('supervised-one')).toBe('headless_supervised')
    expect(reason('manual-one')).toBe('manual')
    expect(reason('fresh-one')).toBe('fresh')
    expect(reason('locked-one')).toBe('task_locked')
    expect(reason('gated-one')).toBe('unapproved')
    expect(new Set(model.notDue.map((e) => e.reason)).size).toBe(7)

    // …and exactly one plugin survived all seven, in both surfaces.
    expect(model.due).toHaveLength(1)
    expect([...attempted]).toEqual(['due-one'])

    // The side-effecting plugin is absent from both sets for two reasons that
    // agree: the gate blocks it in `plan`, the dry-run block skips it in the
    // run. This is fixture constraint 1 holding, asserted.
    expect(attempted.has('gated-one')).toBe(false)
  })

  test('Test 3: with no engine-state.json at all, every plugin is never-run, due, and attempted', async () => {
    // createTestHome writes no state file — this is the fresh-install shape an
    // operator hits on their first `warpline plan`, and the case where every
    // read defaults. It is also the shape that used to write a `.corrupt`
    // backup on the way through (02-05 Deviation 3).
    for (const name of ['alpha', 'bravo', 'charlie']) {
      await writePlugin(home, name)
      await writeHandler(home, name)
    }
    const { statePath, eventsPath } = routeStateManager()
    expect(existsSync(statePath)).toBe(false)

    const model = await buildPlanModel(Date.now())
    const attempted = await attemptedByRun(statePath, eventsPath)

    expect(model.due.map((e) => e.plugin).sort()).toEqual(['alpha', 'bravo', 'charlie'])
    expect(model.notDue).toEqual([])
    expect([...attempted].sort()).toEqual([...model.due.map((e) => e.plugin)].sort())
  })

  test('Test 4: a task-locked plugin is not-due in both, through the _setPaths seam', async () => {
    await writePlugin(home, 'locked-one')
    await writePlugin(home, 'free-one')
    await writeHandler(home, 'locked-one')
    await writeHandler(home, 'free-one')
    await writeState(home, {}, {
      task_aging: [
        {
          task_id: 'locked-task',
          first_flagged: new Date(Date.now() - DAY_MS).toISOString(),
          description: 'an open task locking its source plugin',
          severity: 'critical',
          source_check: 'locked-one',
        },
      ],
    })
    const { statePath, eventsPath } = routeStateManager()

    const model = await buildPlanModel(Date.now())
    const attempted = await attemptedByRun(statePath, eventsPath)

    expect(model.notDue.find((e) => e.plugin === 'locked-one')?.reason).toBe('task_locked')
    expect(model.due.map((e) => e.plugin)).toEqual(['free-one'])
    expect([...attempted]).toEqual(['free-one'])
    expect(attempted.has('locked-one')).toBe(false)
  })
})
