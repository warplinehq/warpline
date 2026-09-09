/**
 * `task_locked` proved end to end through the `WARPLINE_HOME` seam, with the
 * unlocked control that makes the locked assertion mean something.
 *
 * The invariant: a plugin with an open task on the board is not run, and the
 * run log says so in its own row — `status: 'skipped'` carrying the
 * evaluator's task-lock detail. Everything below drives that through the
 * public, documented seam and nothing else. `runAdvance` is called with no
 * options at all.
 *
 * This restores coverage that was given up on a premise measured false. The
 * standing claim was that `checkTaskLock` reads a module global with no
 * override parameter, so only the state-manager paths seam can reach it. That
 * is true of the parameter and false of the path: `resolveHome()` in
 * `src/lib/paths.ts` reads `process.env.WARPLINE_HOME` before it does anything
 * else, `stateDir()` joins it, and `activePaths()` derives from `stateDir()`
 * whenever no override is installed. The env var was never tried.
 *
 * The two arms:
 *
 *   LOCKED. One `task_aging` entry whose `source_check` is the plugin's name.
 *   The plugin's `plugin_entries` row must read `skipped` with the lock detail.
 *
 *   UNLOCKED, the control. The identical home with an empty `task_aging`. The
 *   same row must reach `gated`.
 *
 * Why the control reads `gated` and not `success`, which is the one thing a
 * later reader is most likely to "fix" and thereby destroy: `review_gate` on
 * `PreferencesSchema` defaults to TRUE, and `runAdvance` promotes an
 * `autonomous` plugin to `supervised` for as long as that gate is on. The
 * shared `createTestHome` helper does write a `review_gate: false` file, but it
 * writes it to `<root>/state/preferences.json` while `preferencesPath()`
 * resolves to the home ROOT — so under a pure `WARPLINE_HOME` seam, with no
 * preferences override passed, the PRODUCTION default applies and every
 * autonomous plugin gates. That is correct here and is deliberately left
 * alone. Adding a preferences file at the root would turn the control's
 * expected value into `success` and would prove exactly as much, but it would
 * also be one more thing this fixture overrides, and the point of the fixture
 * is how little it overrides. Do not add one.
 *
 * Non-vacuity, in three parts. The control is the first: the two arms differ
 * only in that one `task_aging` entry, so an assertion that passed with no lock
 * armed would fail the control. The second is that the row is read from the
 * persisted run log rather than from `evaluatePlugin`'s returned reason — the
 * question is what the engine RECORDED, and a guard that decides correctly and
 * files the wrong row is the regression this is placed to catch. The third is
 * that both arms assert the resolved home is the fixture's own, so a stale
 * `homeOverride` left by a sibling file fails on an assertion here rather than
 * silently reading somebody else's state.
 *
 * Additive beside `src/cli/__tests__/plan.test.ts` Test 4, which proves a
 * different thing: that `plan` and a real run agree about which plugins are
 * not due, routed through the state-manager paths seam and asserted on
 * `onPluginStart` membership. Neither test replaces the other — that one is
 * about plan/run equality, this one is about what the run log publishes.
 *
 * Four fixture constraints, all binding:
 *
 *   1. `_setPaths(null)` in `beforeEach`. `_getPaths()` MATERIALISES a concrete
 *      snapshot rather than reporting that no override is installed, so a
 *      sibling file restoring its capture pins the state-manager global at the
 *      paths that were current when IT loaded — which kills the lazy
 *      `WARPLINE_HOME` resolution this whole file depends on. The null is
 *      `_setPaths` used to UNROUTE a sibling's leak, not to route anything of
 *      ours. `installStatePathIsolation()` is the audited capture/restore for
 *      the same global and puts our own leak back where we found it.
 *   2. No state-file override is passed to `runAdvance`. The engine would read
 *      the option's file while `checkTaskLock` kept reading the
 *      `WARPLINE_HOME`-derived one, and on that split brain both the assertion
 *      and its control go vacuous.
 *   3. No preferences override either — see the `review_gate` paragraph above.
 *   4. The home is never moved with the `paths.ts` override seam. That override
 *      beats the env var inside `resolveHome` and is sticky for the rest of the
 *      shard, so this file must not set one and must fail loudly if it finds
 *      one already set.
 */
import { describe, test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { createTestHome, type TestHome } from './helpers/create-test-home.js'
import type { RunLogEntry } from './helpers/two-advance-home.js'
import { _setPaths } from '../../board/state-manager.js'
import { installStatePathIsolation } from '../../../test-utils/state-path-isolation.js'
import { warplineHome } from '../../lib/paths.js'
import { runAdvance } from '../engine.js'

/** The plugin both arms are about. */
const PLUGIN = 'locked-one'

/**
 * The evaluator's detail string for the task-lock arm, copied from
 * `engine.ts`'s `task_locked` return. Asserted whole rather than by substring:
 * the run log's row is the published artifact, and "contains the word locked"
 * would stay green through a rewording that changed what an operator reads.
 */
const LOCK_DETAIL = 'task locked — active on board'

const DAY_MS = 86_400_000

/**
 * Set one env var for the duration of `fn` and put it back exactly as found —
 * DELETING it when it was previously unset rather than assigning the string
 * `"undefined"`, which is a truthy value `resolveHome()` would happily join
 * paths onto. Copied from `src/__tests__/shape-coverage.test.ts` rather than
 * extracted: that file and `examples/plugins/feed-triage/handler.test.ts`
 * already hold the two existing copies, and a shared home for a nine-line
 * save/restore is not worth the import edge from `examples/` into `src/`.
 */
async function withEnv<T>(name: string, value: string, fn: () => Promise<T>): Promise<T> {
  const real = process.env[name]
  process.env[name] = value
  try {
    return await fn()
  } finally {
    if (real === undefined) delete process.env[name]
    else process.env[name] = real
  }
}

/** A plugin that succeeds when it is reached at all. */
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

/** One autonomous, side-effect-free plugin under the home's default root. */
async function writePlugin(home: TestHome, name: string): Promise<void> {
  const dir = join(home.pluginsDir, name)
  await mkdir(dir, { recursive: true })
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
  }
  await writeFile(join(dir, 'manifest.ts'), `export const manifest = ${JSON.stringify(manifest)}\n`)
  await writeFile(join(dir, 'handler.ts'), SUCCESS_HANDLER)
}

/**
 * The engine state, written at the path `WARPLINE_HOME` resolves to and at no
 * other. `taskAging` is the ONLY thing the two arms vary.
 */
async function writeState(home: TestHome, taskAging: unknown[]): Promise<void> {
  await writeFile(
    join(home.stateDir, 'engine-state.json'),
    JSON.stringify({
      schema_version: 1,
      last_run_id: null,
      last_run_at: null,
      last_interaction_at: null,
      plugin_runs: {},
      deferrals: [],
      task_aging: taskAging,
      completed_tasks: [],
      pending_gates: [],
      extensions: {},
    }),
  )
}

/**
 * One open task locking its source plugin.
 *
 * `severity` is `'critical'` deliberately: a degraded tier auto-defers
 * info-severity tasks, and a deferred task is not an active lock — the fixture
 * would release its own lock partway through and the arm would pass for the
 * wrong reason.
 */
const OPEN_TASK = {
  task_id: 'locked-task',
  first_flagged: new Date(Date.now() - DAY_MS).toISOString(),
  description: 'an open task locking its source plugin',
  severity: 'critical',
  source_check: PLUGIN,
}

/** One plugin's row in a persisted run log, or null when it produced none. */
async function entryFor(runLogPath: string, plugin: string): Promise<RunLogEntry | null> {
  const log = JSON.parse(await readFile(runLogPath, 'utf-8')) as {
    plugin_entries: RunLogEntry[]
  }
  return log.plugin_entries.find((e) => e.plugin === plugin) ?? null
}

/** True when `a` is `b` itself or lies underneath it. */
function isWithin(a: string, b: string): boolean {
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep)
}

describe('task_locked through the WARPLINE_HOME seam', () => {
  installStatePathIsolation()

  let home: TestHome
  /** The home this process resolved BEFORE the fixture pointed the env var elsewhere. */
  let realHome: string

  beforeAll(() => {
    realHome = warplineHome()
  })

  beforeEach(async () => {
    // Constraint 1. Undo whatever a sibling file pinned, so the accessors below
    // resolve lazily from the env var again.
    _setPaths(null)
    home = await createTestHome()
    await writePlugin(home, PLUGIN)
  })

  afterEach(async () => {
    await home.cleanup()
  })

  /**
   * Runs one advance with the fixture home exported and NOTHING overridden,
   * asserting the two safety facts first: the fixture home does not overlap the
   * real one in either direction (two overlapping homes let one engine's
   * session-approval grant authorise the other engine's side effects), and the
   * home the accessors actually resolve is the fixture's own (constraint 4 —
   * an override installed by anyone earlier in the shard would beat the env var
   * inside `resolveHome`, and this is how that is detected without installing
   * one).
   */
  async function advanceInFixtureHome(): Promise<RunLogEntry | null> {
    const root = resolve(home.root)
    expect(isWithin(root, realHome)).toBe(false)
    expect(isWithin(realHome, root)).toBe(false)

    return withEnv('WARPLINE_HOME', root, async () => {
      expect(warplineHome()).toBe(root)
      const result = await runAdvance()
      expect(result.run_log_path).not.toBe('')
      return entryFor(result.run_log_path, PLUGIN)
    })
  }

  test('locked: an open task on the board files the plugin as skipped, with the lock detail', async () => {
    await writeState(home, [OPEN_TASK])

    const row = await advanceInFixtureHome()

    expect(row).not.toBeNull()
    expect(row!.status).toBe('skipped')
    expect(row!.result_summary).toBe(LOCK_DETAIL)
  })

  test('unlocked control: with no task armed the same plugin reaches gated, not skipped', async () => {
    await writeState(home, [])

    const row = await advanceInFixtureHome()

    expect(row).not.toBeNull()
    // `gated`, because the production `review_gate` default is on — see the
    // file docstring. Asserted as an equality and then again as two explicit
    // non-equalities, so a future value that is neither of the three still
    // names which mistake it made.
    expect(row!.status).toBe('gated')
    expect(row!.status).not.toBe('skipped')
    expect(row!.result_summary).not.toBe(LOCK_DETAIL)
  })
})
