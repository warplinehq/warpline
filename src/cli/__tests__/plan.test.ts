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
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { createTestHome } from '../../runtime/__tests__/helpers/create-test-home.js'
import type { TestHome } from '../../runtime/__tests__/helpers/create-test-home.js'
import { _setHome } from '../../lib/paths.js'
import { _getPaths, _setPaths, pathsForStateFile } from '../../board/state-manager.js'
import { denialFingerprint, proposalFingerprint, runAdvance } from '../../runtime/engine.js'
import type { AdvanceResult } from '../../runtime/engine.js'
import { grantApproval } from '../../runtime/approval-gate.js'
import { snapshotHome } from '../../runtime/__tests__/helpers/snapshot-home.js'
import { PluginManifestSchema } from '../../schemas/plugin-manifest.js'
import type { PluginManifest } from '../../schemas/plugin-manifest.js'
import { defaultEngineState } from '../../schemas/engine-state.js'
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

/**
 * A handler that returns a valid `SkillResult` whose `status` is `failed`.
 *
 * The `errors` entry is spelled out rather than left empty because
 * `SkillResultSchema` requires the shape, and a fixture the runtime rejects
 * would record `failed` for the wrong reason.
 */
const FAILING_HANDLER = `
export async function handler(_manifest, _args) {
  return {
    status: 'failed',
    phases_completed: [],
    phases_failed: ['fixture'],
    errors: [{ code: 'dependency_unavailable', message: 'declined', impact: 'HIGH', retryable: false }],
    data_freshness: {},
    summary: 'fixture failed',
    artifacts_produced: [],
    schema_version: 1,
  }
}
`

async function writeHandler(home: TestHome, name: string, body = SUCCESS_HANDLER): Promise<void> {
  await writeFile(join(home.pluginsDir, name, 'handler.ts'), body)
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

  test('a declared handoff marks the entry in both sections, and only a declared one', async () => {
    await writePlugin(home, 'hands-off-due', { llm_handoff: true })
    await writePlugin(home, 'hands-off-fresh', { llm_handoff: true })
    await writePlugin(home, 'plain')
    await writeState(home, {
      'hands-off-fresh': {
        last_run_at: new Date(Date.now() - 60_000).toISOString(),
        status: 'success',
      },
    })

    const model = await buildPlanModel(Date.now())

    const dueEntry = model.due.find((e) => e.plugin === 'hands-off-due')
    expect(dueEntry?.llmHandoff).toBe(true)

    const freshEntry = model.notDue.find((e) => e.plugin === 'hands-off-fresh')
    expect(freshEntry?.reason).toBe('fresh')
    expect(freshEntry?.llmHandoff).toBe(true)

    // No key at all, not `false`: a non-declaring entry is shaped as it always was.
    const plainEntry = [...model.due, ...model.notDue].find((e) => e.plugin === 'plain')
    expect(plainEntry).toBeDefined()
    expect(Object.hasOwn(plainEntry!, 'llmHandoff')).toBe(false)
  })

  test('Test 3: --profile weekly narrows the due set and bypasses supervised plugins', async () => {
    await writePlugin(home, 'weekly-one', { schedule: 'weekly' })
    await writePlugin(home, 'manual-schedule', { schedule: 'manual' })
    await writePlugin(home, 'supervised-one', { autonomy_level: 'supervised' })

    const unprofiled = await buildPlanModel(Date.now())
    expect(unprofiled.due.map((e) => e.plugin).sort()).toEqual([
      'supervised-one',
      'weekly-one',
    ])
    expect(unprofiled.notDue.find((e) => e.plugin === 'manual-schedule')?.reason).toBe(
      'profile_schedule',
    )
    // Whole string, `toBe` and never `toContain`. This detail is what an
    // operator reads off the Not-due row, and a substring match is exactly
    // what let a detail opening with the word the skip emitter already prints
    // ship once. It also holds the wording to a profile name rather than a
    // command-line flag, which no verb offers.
    expect(unprofiled.notDue.find((e) => e.plugin === 'manual-schedule')?.detail).toBe(
      "schedule 'manual': requires profile 'manual'",
    )

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

    expect(unprofiled.stdout).toContain('Due (2):')
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
 *    fixture below has two side-effecting plugins and grants neither anything,
 *    so both are not-due in `plan` and blocked in the run — absent from both
 *    sets, for reasons that agree. No `.session-approval` file is written
 *    anywhere in this fixture, and none may be added.
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
 * Clock: `now` is injected into `buildPlanModel` and now reaches every read it
 * makes — `isPluginFresh` and `checkApproval` both take it (WR-19). The
 * fixture boundaries below are still hours away from their thresholds rather
 * than milliseconds, because this proof is about set membership, not about
 * edge timing — the exactly-at-TTL edges are pinned in the runtime's own
 * tests, and widening this fixture to chase them would prove less, not more.
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
   * meaningful rather than vacuous: a twelve-plugin home where nine are excluded
   * for eight DIFFERENT reasons and three are due.
   *
   * Nine exclusions and eight reasons, not nine of each: `failed-producer`
   * exists to arm the dependency gate on the plugin below it and is itself
   * excluded as `fresh`, which `fresh-one` already covers. It adds a plugin
   * without adding a reason.
   *
   * `recover-producer` / `dep-recovers` are the OTHER half of the dependency
   * gate, and they are here because the fixture used to be blind to it. They
   * are due rather than excluded: the producer is seeded failed and STALE, so
   * plan finds it due and the advance re-runs it into a success, and the
   * dependent — declaring no side effects, so nothing else can hold it back —
   * is due on both surfaces. That is the self-clearing path `runtime-spec.md`
   * calls the ordinary one, and it is the case the equality below has to be
   * able to see. The residual, where such a producer fails AGAIN, is a
   * divergence and lives in its own test outside this fixture; putting it here
   * would turn Test 1 red for a disagreement that is disclosed rather than a
   * defect.
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
    await writePlugin(home, 'failed-producer', tolerant)
    // TWO side-effecting plugins, and no .session-approval file exists anywhere
    // in this fixture — see constraint 1 above. NEITHER is granted, and neither
    // may be. They are here for different reasons: `gated-one` is the approval
    // gate's own case, and `dep-failed-one` is the proof that the dependency
    // gate is reached FIRST — it declares an effect precisely so that the wrong
    // ordering has something to report instead.
    await writePlugin(home, 'gated-one', { ...tolerant, side_effects: ['sends_email'] })
    await writePlugin(home, 'dep-failed-one', {
      ...tolerant,
      dependencies: ['failed-producer'],
      side_effects: ['sends_email'],
    })
    // The ninth gate, armed against a producer that actually re-runs. No side
    // effects on the dependent: the dry-run block would otherwise hold it out
    // of the attempted set for a reason that has nothing to do with the gate,
    // which is what `dep-failed-one` above is for.
    await writePlugin(home, 'recover-producer', tolerant)
    await writePlugin(home, 'dep-recovers', { ...tolerant, dependencies: ['recover-producer'] })
    // The NINTH not-due reason, and the one this fixture was blind to. A THIRD
    // side-effecting plugin, deliberately: `denied` is ordered before
    // `unapproved`, so a plugin that could be caught by either is the only one
    // that proves which fires. Declare no effect and the plugin reports
    // `denied` whatever the ordering, which is the vacuous version of this
    // assertion. The denial itself is seeded in state below — no
    // `.session-approval` file appears anywhere, so fixture constraint 1 holds.
    await writePlugin(home, 'denied-one', { ...tolerant, side_effects: ['sends_email'] })

    for (const name of [
      'due-one',
      'weekly-one',
      'tier-blocked',
      'supervised-one',
      'manual-one',
      'fresh-one',
      'locked-one',
      'failed-producer',
      'gated-one',
      'dep-failed-one',
      'recover-producer',
      'dep-recovers',
      'denied-one',
    ]) {
      await writeHandler(home, name)
    }

    await writeState(
      home,
      {
        // 1 hour into a 24h TTL — hours from the boundary in both directions.
        'fresh-one': { last_run_at: new Date(Date.now() - 3_600_000).toISOString(), status: 'success' },
        // Seeded failed AND fresh, and the freshness is load-bearing rather
        // than decorative. The harness runs the plan model first and a real
        // advance second (constraint 2). A seeded-failed producer that were DUE
        // would be attempted by that advance, its autonomous arm would overwrite
        // the seeded status with a success, and by `dep-failed-one`'s level the
        // gate would read a success — while the plan side, having run first,
        // read the failure. Freshness keys on the timestamp and ignores the
        // status (`staleness.ts`), and the freshness arm writes a run-log row
        // and no run record, so this row survives the advance byte for byte.
        //
        // What the freshness does NOT buy any more is the fixture's blindness to
        // the gate. `recover-producer` below is stale on purpose and does
        // re-run; this pair is here for Test 2's reason coverage, which needs a
        // `dependency_failed` verdict to read and needs the producer to hold
        // still while it reads it.
        'failed-producer': {
          last_run_at: new Date(Date.now() - 3_600_000).toISOString(),
          status: 'failed',
        },
        // Failed and STALE — 25 hours into a 24h TTL. Plan finds it due, the
        // advance re-runs it, `SUCCESS_HANDLER` overwrites the seeded status,
        // and `dep-recovers` is ungated on both surfaces. The clearing this
        // fixture used to be built to avoid is the thing it now proves.
        'recover-producer': {
          last_run_at: new Date(Date.now() - 25 * 3_600_000).toISOString(),
          status: 'failed',
        },
      },
      {
        // A LIVE denial: the fingerprint is computed from the same three inputs
        // `proposalFingerprint` reads — the plugin name, its declared effects,
        // and its last output — so it still matches and the standing is `live`
        // rather than `superseded`. `denied-one` has no `plugin_runs` row, so
        // the output half is the empty list on both sides. Recomputed here from
        // the real `denialFingerprint` rather than pasted as a literal: a hash
        // frozen into a fixture stops tracking the function that produces it,
        // and the failure mode is a silent `superseded` that reports
        // `unapproved` and looks like the ordering broke.
        denials: {
          'denied-one': {
            plugin: 'denied-one',
            reason: 'operator declined the fixture proposal',
            denied_at: new Date(Date.now() - 2 * DAY_MS).toISOString(),
            note: null,
            fingerprint: denialFingerprint('denied-one', ['sends_email'], []),
          },
        },
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
    expect([...planned].sort()).toEqual(['dep-recovers', 'due-one', 'recover-producer'])
  })

  test('Test 2: the fixture spans every guard, so the equality is not vacuous', async () => {
    await writeSpanningFixture()
    const { statePath, eventsPath } = routeStateManager()

    const model = await buildPlanModel(Date.now(), 'daily')
    const attempted = await attemptedByRun(statePath, eventsPath, 'daily')

    const reason = (n: string) => model.notDue.find((e) => e.plugin === n)?.reason

    // Ten excluded plugins, NINE distinct not-due reason codes — every arm of
    // evaluatePlugin's chain, in chain order. `failed-producer` shares
    // `fresh-one`'s reason, which is why ten exclusions span nine codes.
    //
    // The title says every guard and now means it. It used to span eight of the
    // nine with `denied` absent, so a chain that dropped the denial arm
    // altogether stayed green here — the plugin would simply have reported
    // `unapproved` instead and no assertion asked.
    expect(reason('weekly-one')).toBe('profile_schedule')
    expect(reason('tier-blocked')).toBe('min_tier')
    expect(reason('supervised-one')).toBe('headless_supervised')
    expect(reason('manual-one')).toBe('manual')
    expect(reason('fresh-one')).toBe('fresh')
    expect(reason('failed-producer')).toBe('fresh')
    expect(reason('locked-one')).toBe('task_locked')
    // The ordering assertion, and it belongs HERE rather than in Test 1. Set
    // equality is satisfied either way: a consumer gated as `unapproved` is
    // dry-run blocked and absent from both sets, so Test 1 stays green over the
    // wrong ordering and proves nothing about order. This per-plugin reason is
    // what separates them — the plugin declares a side effect and holds no
    // grant, so `unapproved` is armed and waiting to be reported instead.
    expect(reason('dep-failed-one')).toBe('dependency_failed')
    // The second ordering assertion, and it reads the same way as the one
    // above. `denied-one` declares a side effect and holds no grant, so
    // `unapproved` is armed behind the denial arm and waiting to be reported in
    // its place. `denied` is what makes the ordering visible.
    expect(reason('denied-one')).toBe('denied')
    expect(reason('gated-one')).toBe('unapproved')
    expect(new Set(model.notDue.map((e) => e.reason)).size).toBe(9)

    // …and the three that survived all eight did so in both surfaces. Sorted:
    // a level runs its plugins concurrently, so insertion order into the
    // attempted set is not a property this fixture may assert.
    expect(model.due).toHaveLength(3)
    expect([...attempted].sort()).toEqual(['dep-recovers', 'due-one', 'recover-producer'])

    // The ninth gate, on the surface it was blind to. `recover-producer` is
    // seeded failed; `dep-recovers` declares it and is due anyway, in plan
    // because Task 1's projection saw the producer go due at level 0, and in the
    // run because the producer had already overwritten the seeded status by the
    // time the gate read it.
    expect(reason('dep-recovers')).toBeUndefined()
    expect(attempted.has('dep-recovers')).toBe(true)

    // Both side-effecting plugins are absent from both sets for reasons that
    // agree: the chain blocks them in `plan`, and in the run `gated-one` meets
    // the dry-run block while `dep-failed-one` never reaches it, having already
    // been gated on its dependency. Fixture constraint 1 holding, asserted.
    expect(attempted.has('gated-one')).toBe(false)
    expect(attempted.has('dep-failed-one')).toBe(false)
    // Third side-effecting plugin, same agreement: the denial arm returns
    // before `invokePlugin` in the run, and the chain blocks it in `plan`.
    expect(attempted.has('denied-one')).toBe(false)
  })

  /**
   * The one disagreement the two surfaces are allowed to have, characterized.
   *
   * `docs/runtime-spec.md` § "What the dependency gate does not cover", FIFTH
   * entry. `plan` cannot know whether a producer it finds due will succeed, only
   * that this advance will attempt it. It assumes the latch clears, because the
   * alternative assumption — that it does not — is what made plan publish a skip
   * for every self-clearing dependent, and a preview that under-states an
   * advance is the input to a wrong approval in a runtime that gates side
   * effects on an informed answer.
   *
   * So a producer that is due and fails AGAIN leaves plan saying due where the
   * run skips. That is the accepted residual of the fix, not a defect awaiting
   * repair: the divergence is irreducible for a gate keyed on a run outcome the
   * preview does not compute, and this direction is the safe one. It is asserted
   * here so it cannot drift silently — a limitation with no test is a limitation
   * that rots.
   *
   * Deliberately NOT in the spanning fixture. A fail-again producer there turns
   * Test 1's set equality red, and the repair that suggests itself is re-seeding
   * the fixture until the case cannot arise — which is exactly the blindness
   * this file has just had removed.
   */
  test('Test 2b: the residual — a producer that fails again leaves plan due where the run skips', async () => {
    await writePlugin(home, 'fails-again')
    await writePlugin(home, 'dep-fails-again', { dependencies: ['fails-again'] })
    await writeHandler(home, 'fails-again', FAILING_HANDLER)
    await writeHandler(home, 'dep-fails-again')

    await writeState(home, {
      // Stale, so it is due and re-run rather than held by freshness.
      'fails-again': {
        last_run_at: new Date(Date.now() - 25 * 3_600_000).toISOString(),
        status: 'failed',
      },
    })

    const { statePath, eventsPath } = routeStateManager()
    const model = await buildPlanModel(Date.now())
    const attempted = await attemptedByRun(statePath, eventsPath)

    // PLAN: both due. The producer because its TTL expired, the dependent
    // because the producer went due at an earlier level of this same preview.
    expect(model.due.map((e) => e.plugin).sort()).toEqual(['dep-fails-again', 'fails-again'])

    // RUN: the producer alone. Its handler returned `failed`, the autonomous arm
    // wrote that status, and the gate read the write.
    expect([...attempted]).toEqual(['fails-again'])

    // The direction, stated as an assertion rather than left to the reader:
    // plan over-reports, never under-reports. Nothing the run attempted is
    // missing from the plan.
    const planned = new Set(model.due.map((e) => e.plugin))
    expect([...attempted].filter((p) => !planned.has(p))).toEqual([])
  })

  /**
   * The second hop, on both surfaces. `held-root` is seeded failed and fresh,
   * so it holds still and holds `held-mid` back. `held-mid` writes no record,
   * so the preview can only hold `held-tail` back from its own verdict about
   * `held-mid`, which is what the advance does from its own skip. A preview
   * that read the state document alone would report `held-tail` due, the
   * advance would skip it, and the equality below would name it.
   */
  test('Test 2c: a dependency held back by a failed dependency holds back its dependent in both', async () => {
    const tolerant = { min_tier: 'suspended' }
    await writePlugin(home, 'held-root', tolerant)
    await writePlugin(home, 'held-mid', { ...tolerant, dependencies: ['held-root'] })
    await writePlugin(home, 'held-tail', { ...tolerant, dependencies: ['held-mid'] })
    for (const name of ['held-root', 'held-mid', 'held-tail']) await writeHandler(home, name)

    await writeState(home, {
      // 1 hour into a 24h TTL: fresh, so the advance does not re-run it.
      'held-root': { last_run_at: new Date(Date.now() - 3_600_000).toISOString(), status: 'failed' },
    })

    const { statePath, eventsPath } = routeStateManager()
    const model = await buildPlanModel(Date.now(), 'daily')
    const attempted = await attemptedByRun(statePath, eventsPath, 'daily')

    const notDue = (n: string) => model.notDue.find((e) => e.plugin === n)
    expect(notDue('held-mid')?.reason).toBe('dependency_failed')
    expect(notDue('held-tail')?.reason).toBe('dependency_failed')
    expect(notDue('held-tail')?.detail).toBe(
      "dependency failed — 'held-mid' held back by a failed dependency",
    )
    expect(attempted.has('held-mid')).toBe(false)
    expect(attempted.has('held-tail')).toBe(false)
    expect(model.due.map((e) => e.plugin).sort()).toEqual([...attempted].sort())
  })

  /**
   * A content consumer whose producer this advance runs first.
   *
   * The preview cannot know what a producer due this advance will produce, so
   * it must not decide a content standing that producer's run can change.
   * Carried, erased and moved bytes are three such standings. In each case
   * below the producer re-produces the approved bytes, so the consumer fires,
   * and the preview must say it may.
   *
   * A REAL advance, not the dry run above. The consumer declares an effect, and
   * the dry-run block holds every such plugin out of the attempted set, which
   * would make the equality vacuous.
   */
  const PREVIEW_BODY = '{"batch":"the invoices the operator read"}'
  const liveOutput = (body = PREVIEW_BODY) => ({ type: 'brief', format: 'json', body })

  /**
   * `<prefix>-producer`, stale so the preview finds it due and the advance runs
   * it, and `<prefix>-consumer`, a content-class sender of its bytes with an
   * open, unmarked approval over `PREVIEW_BODY`. `producerRun` is the cause's
   * shape, laid over the producer's entry.
   */
  async function writeContentPair(
    prefix: string,
    producerRun: Record<string, unknown>,
    approvalOverride: Record<string, unknown> = {},
  ): Promise<{ producer: string; consumer: string }> {
    const tolerant = { min_tier: 'suspended' }
    const producer = `${prefix}-producer`
    const consumer = `${prefix}-consumer`
    await writePlugin(home, producer, { ...tolerant, outputs: { brief: { type: 'json' } } })
    await writeHandler(
      home,
      producer,
      `
export async function handler() {
  return {
    status: 'success',
    phases_completed: ['run'],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: 'produced',
    artifacts_produced: [{ type: 'brief', format: 'json', body: ${JSON.stringify(PREVIEW_BODY)} }],
    schema_version: 1,
  }
}
`,
    )
    await writePlugin(home, consumer, {
      ...tolerant,
      side_effects: ['sends_email'],
      approval_class: 'content',
      dependencies: [producer],
      // Stale on every evaluation, so the consumer reaches the approval gate.
      ttl_hours: 0.001,
    })
    await writeHandler(home, consumer)

    // The fingerprint the operator approved: the live bytes, through the one
    // entry point the gate uses.
    const fingerprintState = defaultEngineState()
    fingerprintState.plugin_runs[producer] = { status: 'success', last_output: liveOutput() } as never
    const manifest = PluginManifestSchema.parse({
      name: producer,
      version: '1.0.0',
      description: 'producer',
      autonomy_level: 'autonomous',
      ttl_hours: 24,
    })

    await writeState(
      home,
      {
        [producer]: {
          // 25 hours into a 24h TTL: stale, so due in the preview and run by the advance.
          last_run_at: new Date(Date.now() - 25 * 3_600_000).toISOString(),
          status: 'success',
          ...producerRun,
        },
      },
      {
        approvals: {
          [consumer]: {
            plugin: consumer,
            producer,
            fingerprint: proposalFingerprint(fingerprintState, producer, manifest),
            run_id: 'run-the-operator-read',
            approved_at: new Date(Date.now() - 30 * 60_000).toISOString(),
            not_before: null,
            not_after: '2099-01-01T00:00',
            zone: 'UTC',
            effect_id: null,
            marked_at: null,
            confirmed_at: null,
            ...approvalOverride,
          },
        },
      },
    )
    return { producer, consumer }
  }

  /** `attemptedByRun` without `dryRun`, returning the advance's result as well. */
  async function attemptedByRealRun(
    statePath: string,
    eventsPath: string,
  ): Promise<{ attempted: Set<string>; result: AdvanceResult }> {
    const attempted = new Set<string>()
    const result = await runAdvance({
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
    return { attempted, result }
  }

  test('Test 2d: a content consumer over carried bytes whose producer is due is due in both', async () => {
    const { consumer } = await writeContentPair('carried', {
      // The producer's latest run produced nothing and carried the approved
      // bytes forward from the run the operator read.
      run_id: 'run-quiet',
      last_output: { ...liveOutput(), run_id: 'run-the-operator-read' },
    })
    const { statePath, eventsPath } = routeStateManager()

    const model = await buildPlanModel(Date.now())
    const { stdout } = await capture(() => main(['plan']))
    const { attempted } = await attemptedByRealRun(statePath, eventsPath)

    const planned = model.due.map((e) => e.plugin).sort()
    expect(planned).toEqual([...attempted].sort())
    expect(planned).toContain(consumer)
    expect(model.due.find((e) => e.plugin === consumer)?.approved).toBe(true)
    expect(stdout).toContain("may fire if 'carried-producer' re-produces the approved bytes this advance")
    // The effect line's skip marker. The grant header says "would be SKIPPED"
    // whenever no grant exists, and none does here, so the marker is what is
    // asked about.
    expect(stdout).not.toContain('⚠ unapproved — would be SKIPPED')
  })

  test('Test 2e: a content consumer over erased bytes whose producer is due is due in both', async () => {
    const { consumer } = await writeContentPair('erased', {
      run_id: 'run-the-operator-read',
      last_output: {
        type: 'brief',
        format: 'json',
        run_id: 'run-the-operator-read',
        erased_at: '2026-09-20T00:00:00.000Z',
        body_sha256: createHash('sha256').update(PREVIEW_BODY, 'utf8').digest('hex'),
      },
    })
    const { statePath, eventsPath } = routeStateManager()

    const model = await buildPlanModel(Date.now())
    const { attempted, result } = await attemptedByRealRun(statePath, eventsPath)

    const planned = model.due.map((e) => e.plugin).sort()
    expect(planned).toEqual([...attempted].sort())
    expect(planned).toContain(consumer)
    expect(attempted.has(consumer)).toBe(true)
    expect(model.due.find((e) => e.plugin === consumer)?.approved).toBe(true)
    // The advance read an erased record, ran the producer over it and
    // re-produced the approved bytes, so nothing refuses the fire.
    expect(result.refused_plugins).toEqual([])
  })

  test('Test 2f: a content consumer over moved bytes whose producer is due is due in both', async () => {
    const { consumer } = await writeContentPair('moved', {
      // A batch nobody approved. The producer's run puts the approved one back.
      last_output: liveOutput('{"batch":"a different batch nobody approved"}'),
    })
    const { statePath, eventsPath } = routeStateManager()

    const model = await buildPlanModel(Date.now())
    const { attempted } = await attemptedByRealRun(statePath, eventsPath)

    const planned = model.due.map((e) => e.plugin).sort()
    expect(planned).toEqual([...attempted].sort())
    expect(planned).toContain(consumer)
    expect(model.due.find((e) => e.plugin === consumer)?.approved).toBe(true)
  })

  // The hint is narrow on purpose. The condition line promises a fire only
  // while the approval's own declared producer is due at an earlier level, so
  // a producer that will not run, or an approval about some other producer,
  // leaves the consumer refused in the preview as in the advance.

  test('Test 2g: a content consumer over carried bytes whose producer is fresh gets no hint', async () => {
    const { consumer } = await writeContentPair('fresh', {
      // A minute old in a 24h TTL: not due, so nothing can re-produce the bytes.
      last_run_at: new Date(Date.now() - 60_000).toISOString(),
      run_id: 'run-quiet',
      last_output: { ...liveOutput(), run_id: 'run-the-operator-read' },
    })
    const { statePath, eventsPath } = routeStateManager()

    const model = await buildPlanModel(Date.now())
    const { stdout } = await capture(() => main(['plan']))
    const { attempted } = await attemptedByRealRun(statePath, eventsPath)

    expect(model.notDue.find((e) => e.plugin === consumer)?.reason).toBe('unapproved')
    expect(model.due.map((e) => e.plugin)).not.toContain(consumer)
    expect(attempted.has(consumer)).toBe(false)
    expect(stdout).not.toContain('may fire if')
  })

  test('Test 2h: an approval naming a producer the consumer does not declare gets no hint', async () => {
    // The declared producer is due, but the approval is about bytes some other
    // producer proposed. Re-running the declared one cannot make it live.
    const { consumer } = await writeContentPair(
      'renamed',
      { last_output: liveOutput('{"batch":"a different batch nobody approved"}') },
      { producer: 'retired-producer' },
    )
    const { statePath, eventsPath } = routeStateManager()

    const model = await buildPlanModel(Date.now())
    const { stdout } = await capture(() => main(['plan']))
    const { attempted } = await attemptedByRealRun(statePath, eventsPath)

    expect(model.notDue.find((e) => e.plugin === consumer)?.reason).toBe('unapproved')
    expect(model.due.map((e) => e.plugin)).not.toContain(consumer)
    expect(attempted.has(consumer)).toBe(false)
    expect(stdout).not.toContain('may fire if')
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

/**
 * `warpline plan` writes nothing at all — including no spend mark, and
 * including no `.session-approval` file.
 *
 * A whole-home byte-and-mtime snapshot taken around the command, with **no
 * exclusion list**. An exclusion list is how a snapshot test stops seeing the
 * file that matters: name a path as "expected to change" and the test stops
 * proving the prohibition and starts documenting an exception.
 *
 * The fixture is the one that would fire. A live, in-window content approval
 * over a byte-identical producer Output is the exact input that makes a real
 * advance take the spend mark and invoke the handler — so a preview over the
 * same home is the case where a write could actually happen. A home with
 * nothing approved would pass this assertion for the reason that there was
 * never anything to write.
 *
 * Two prohibitions, one assertion. The mark is the new one; `.session-approval`
 * is the standing one from `docs/doctrine.md` — nothing reachable from a run
 * writes that file — and both are discharged here precisely because the
 * snapshot covers the WHOLE HOME rather than the state directory.
 *
 * Why the whole home is the right unit rather than `engine-state.json` alone:
 * `plan` shares `evaluatePlugin` with the run that writes the mark, and the
 * seam that keeps the two apart is structural, not a path comparison. A write
 * that escaped through it would not necessarily land where a narrower snapshot
 * was looking.
 */
describe('warpline plan writes nothing, over a home that would otherwise fire', () => {
  const PRODUCER = 'batch-builder'
  const CONSUMER = 'batch-sender'
  const APPROVED_BODY = '{"batch":"the twelve invoices the operator read"}'

  /**
   * The producer's manifest as the runtime parses it, so the fingerprint comes
   * from the same arithmetic the gate uses rather than a hand-built lookalike.
   */
  function producerManifest(): PluginManifest {
    return PluginManifestSchema.parse({
      name: PRODUCER,
      version: '1.0.0',
      description: 'producer',
      autonomy_level: 'autonomous',
      ttl_hours: 24,
    })
  }

  test('a live content approval previews with the home byte- and mtime-identical', async () => {
    await writePlugin(home, PRODUCER, { min_tier: 'suspended' })
    await writeHandler(home, PRODUCER)
    await writePlugin(home, CONSUMER, {
      min_tier: 'suspended',
      side_effects: ['sends_email'],
      approval_class: 'content',
      dependencies: [PRODUCER],
      // Stale on every preview, so the consumer reaches the approval gate
      // rather than being held by freshness above it.
      ttl_hours: 0.001,
    })
    await writeHandler(home, CONSUMER)

    const producerRun = {
      last_run_at: new Date(Date.now() - 60 * 60_000).toISOString(),
      status: 'success',
      last_output: { type: 'brief', format: 'json', body: APPROVED_BODY },
    }
    // The fingerprint is computed over the same shape the state document
    // carries, through the one entry point.
    const fingerprintState = defaultEngineState()
    fingerprintState.plugin_runs[PRODUCER] = producerRun as never
    await writeState(
      home,
      { [PRODUCER]: producerRun },
      {
        approvals: {
          [CONSUMER]: {
            plugin: CONSUMER,
            producer: PRODUCER,
            fingerprint: proposalFingerprint(fingerprintState, PRODUCER, producerManifest()),
            run_id: 'run-the-operator-read',
            approved_at: new Date(Date.now() - 30 * 60_000).toISOString(),
            not_before: null,
            not_after: '2099-01-01T00:00',
            zone: 'UTC',
            effect_id: null,
            marked_at: null,
            confirmed_at: null,
          },
        },
      },
    )

    const before = await snapshotHome(home.root)
    // Non-empty by construction, so the equality below cannot be green over a
    // walk that saw nothing — the did-not-look failure this repository has
    // logged six instances of.
    expect(before.length).toBeGreaterThan(0)

    const { code, stdout } = await capture(() => main(['plan']))

    expect(code).toBe(0)
    // The preview really did reach the consumer — otherwise the equality below
    // would hold because nothing was evaluated.
    expect(stdout).toContain(CONSUMER)
    expect(await snapshotHome(home.root)).toEqual(before)
    // Named explicitly as well, so a later reader can tell the snapshot covers
    // it: `.session-approval` sits at the home root, inside the walk above.
    expect(existsSync(join(home.root, '.session-approval'))).toBe(false)

    // THE POSITIVE CONTROL, and it is not optional. An equality over a walk
    // that cannot see the paths in question is green for the wrong reason —
    // this repository's recorded failure shape. A real advance over the SAME
    // home writes exactly what a preview must not: the spend mark into
    // `state/engine-state.json`, a run log, an event. If the snapshot cannot
    // tell that apart from the preview, it was never proving anything.
    await runAdvance({
      pluginsDir: home.pluginsDir,
      stateDir: join(home.stateDir, 'engine-state.json'),
      runsDir: home.runsDir,
      eventsPath: join(home.stateDir, 'events.jsonl'),
      preferencesPath: join(home.stateDir, 'preferences.json'),
      approvalPath: join(home.root, '.session-approval'),
    })
    expect(await snapshotHome(home.root)).not.toEqual(before)
  })
})

/**
 * `plan`'s `approved:` column, rendered from the mechanism that actually
 * authorises the plugin's class.
 *
 * Rendered unconditionally from the session grant — which is what it did — the
 * column was wrong in BOTH directions for a content-class plugin, and each
 * direction is its own kind of harm at the moment an operator is deciding
 * whether to intervene:
 *
 *   - a content-class plugin with a live approval and no grant read
 *     `approved: false` while genuinely authorised, so the operator sees a
 *     batch they reviewed and approved reported as blocked, and goes looking
 *     for a gate that is not there;
 *   - one under a live `scopes: '*'` grant and no approval read
 *     `approved: true` while genuinely refused, which is the worse of the two:
 *     the operator walks away believing a send will go out and it will not.
 *
 * The session-class cases in the same two homes are what make this a BRANCH
 * rather than a replacement. `checkApproval` keeps every other plugin, and the
 * import stays.
 */
describe('plan renders the approved column from the authorising mechanism', () => {
  const PRODUCER = 'batch-builder'
  const CONTENT = 'batch-sender'
  const SESSION = 'digest-sender'
  const APPROVED_BODY = '{"batch":"the twelve invoices the operator read"}'

  function producerManifest(): PluginManifest {
    return PluginManifestSchema.parse({
      name: PRODUCER,
      version: '1.0.0',
      description: 'producer',
      autonomy_level: 'autonomous',
      ttl_hours: 24,
    })
  }

  /** The producer, a content-class consumer of its bytes, and a session-class sibling. */
  async function writeTrio(): Promise<void> {
    await writePlugin(home, PRODUCER, { min_tier: 'suspended' })
    await writePlugin(home, CONTENT, {
      min_tier: 'suspended',
      side_effects: ['sends_email'],
      approval_class: 'content',
      dependencies: [PRODUCER],
      ttl_hours: 0.001,
    })
    await writePlugin(home, SESSION, {
      min_tier: 'suspended',
      side_effects: ['sends_email'],
      ttl_hours: 0.001,
    })
  }

  const producerRun = () => ({
    last_run_at: new Date(Date.now() - 60 * 60_000).toISOString(),
    status: 'success',
    last_output: { type: 'brief', format: 'json', body: APPROVED_BODY },
  })

  /** Seed the producer's Output, and an in-window approval over exactly those bytes. */
  async function seedApproval(): Promise<void> {
    const run = producerRun()
    const fingerprintState = defaultEngineState()
    fingerprintState.plugin_runs[PRODUCER] = run as never
    await writeState(
      home,
      { [PRODUCER]: run },
      {
        approvals: {
          [CONTENT]: {
            plugin: CONTENT,
            producer: PRODUCER,
            fingerprint: proposalFingerprint(fingerprintState, PRODUCER, producerManifest()),
            run_id: 'run-the-operator-read',
            approved_at: new Date(Date.now() - 30 * 60_000).toISOString(),
            not_before: null,
            not_after: '2099-01-01T00:00',
            zone: 'UTC',
            effect_id: null,
            marked_at: null,
            confirmed_at: null,
          },
        },
      },
    )
  }

  /** The same home with no approval at all, and a blanket session grant instead. */
  async function seedWildcardGrant(): Promise<void> {
    await writeState(home, { [PRODUCER]: producerRun() })
    await grantApproval('*', 4 * 60 * 60 * 1000, join(home.root, '.session-approval'))
  }

  const columnOf = (
    model: Awaited<ReturnType<typeof buildPlanModel>>,
    plugin: string,
  ): boolean | undefined =>
    [...model.due, ...model.notDue].find((e) => e.plugin === plugin)?.approved

  test('a content-class plugin with a live approval and no grant renders approved: true', async () => {
    await writeTrio()
    await seedApproval()

    const model = await buildPlanModel(Date.now())

    // No grant file exists at all, so the old column read `false` here while
    // the plugin was genuinely authorised and a real advance would have fired.
    expect(existsSync(join(home.root, '.session-approval'))).toBe(false)
    expect(columnOf(model, CONTENT)).toBe(true)
  })

  test('a session-class sibling in that same home is unchanged, and still reads the grant', async () => {
    await writeTrio()
    await seedApproval()

    const model = await buildPlanModel(Date.now())

    // Non-vacuity for the case above: same home, same advance, and the only
    // difference is the class. A record written for one plugin buys the other
    // nothing, and no grant exists, so the answer is false.
    expect(columnOf(model, SESSION)).toBe(false)
  })

  test('a content-class plugin under a live wildcard grant and no approval renders approved: false', async () => {
    await writeTrio()
    await seedWildcardGrant()

    const model = await buildPlanModel(Date.now())

    // The dangerous direction, and the one this column existed to get right:
    // the grant is live and covers everything, and it authorises this plugin's
    // send exactly not at all.
    expect(columnOf(model, CONTENT)).toBe(false)
  })

  test('a session-class sibling under that same wildcard grant renders approved: true', async () => {
    await writeTrio()
    await seedWildcardGrant()

    const model = await buildPlanModel(Date.now())

    // Non-vacuity for the case above: the grant is real, it is live, and the
    // branch that still consults it answers true. Without this, "the content
    // plugin reads false" would also pass over a grant file that never loaded.
    expect(columnOf(model, SESSION)).toBe(true)
  })
})
