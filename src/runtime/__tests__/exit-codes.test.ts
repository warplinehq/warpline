/**
 * `advanceExitCode` / `advanceCounts` — pinned against real advances.
 *
 * Every case here drives a real `runAdvance` over a fixture home, so the map the
 * mapper reads is the engine's own. A hand-built `Map` literal would pin the
 * function's arithmetic while leaving the claim that actually matters unproven:
 * that `'pending'` survives a gated advance and must land on `0`. Pinning the
 * arithmetic against a map the test invented is this project's recorded failure
 * shape — a guard running green over something outside its reach.
 *
 * The two-level gated fixture is the load-bearing one. A single-level gated root
 * cannot catch a mapper written as "every plugin reached a terminal state",
 * because on a single level there is no later level left holding `'pending'`.
 * That mapper would report `1` on every gated advance over a real fleet, which
 * is the exact inversion the exit code exists to prevent.
 *
 * The engine's own paths are passed explicitly, and the state-manager paths
 * global is re-rooted per test: `runAdvance`'s task-lock gate reads that global
 * rather than its options, so a sibling test file that set it and did not
 * restore would have these cases comparing against a directory that is gone.
 */
import { describe, test, expect, beforeEach, afterEach, afterAll } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runAdvance } from '../engine.js'
import { advanceCounts, advanceExitCode } from '../exit-codes.js'
import type { AdvanceResult } from '../engine.js'
import { grantApproval } from '../approval-gate.js'
import { createTestHome, type TestHome } from './helpers/create-test-home.js'
import { seedContentRefusals } from './helpers/content-refusal.js'
import { _getPaths, _setPaths, pathsForStateFile } from '../../board/state-manager.js'

const REAL_PATHS = _getPaths()

let ctx: TestHome
let statePath: string
let eventsPath: string
let approvalPath: string

beforeEach(async () => {
  ctx = await createTestHome()
  statePath = join(ctx.stateDir, 'engine-state.json')
  eventsPath = join(ctx.runsDir, 'events.jsonl')
  approvalPath = join(ctx.root, '.session-approval')
  _setPaths(pathsForStateFile(statePath, { eventsPath }))
})

afterEach(async () => {
  await ctx.cleanup()
})

afterAll(() => {
  _setPaths(REAL_PATHS)
})

/**
 * A plugin that loads and runs.
 *
 * `ttl_hours` is near zero so every fixture is stale and therefore due — a
 * fresh plugin is skipped, and a skip proves nothing about the state a gate
 * leaves behind.
 */
async function writePlugin(
  name: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const dir = join(ctx.pluginsDir, name)
  await mkdir(dir, { recursive: true })

  const manifest = {
    name,
    version: '1.0.0',
    description: `${name} fixture`,
    inputs: {},
    outputs: {},
    capabilities: [],
    schedule: 'on_run',
    autonomy_level: 'autonomous',
    side_effects: [],
    ttl_hours: 0.001,
    dependencies: [],
    timeout_ms: 5000,
    max_parallelism: 1,
    ...overrides,
  }

  await writeFile(join(dir, 'manifest.ts'), `export const manifest = ${JSON.stringify(manifest)}`)
  await writeFile(
    join(dir, 'handler.ts'),
    `
export async function handler() {
  return {
    status: 'success',
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

/** A plugin directory whose manifest cannot be imported at all. */
async function writeUnloadablePlugin(name: string): Promise<void> {
  const dir = join(ctx.pluginsDir, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'manifest.ts'), `throw new Error('${name} manifest is broken')`)
}

function advance(): Promise<AdvanceResult> {
  return runAdvance({
    pluginsDir: ctx.pluginsDir,
    stateDir: statePath,
    runsDir: ctx.runsDir,
    eventsPath,
    approvalPath,
  })
}

describe('advanceExitCode over a real advance', () => {
  /**
   * Two levels, the first one gating. `producer` is supervised and declares a
   * side effect, so with a live grant the approval gate passes and the
   * supervision gate parks it. The engine then stops before level 1 — leaving
   * `consumer` exactly where it was seeded.
   */
  test('a two-level gated advance is 0, and --strict makes the same result 1', async () => {
    await writePlugin('producer', {
      autonomy_level: 'supervised',
      side_effects: ['sends_email'],
    })
    await writePlugin('consumer', { dependencies: ['producer'] })
    await grantApproval('producer', 4 * 60 * 60 * 1000, approvalPath)

    const result = await advance()

    // Said out loud rather than implied: this is the invariant the mapper rests
    // on. A later-level plugin is still 'pending' when the advance returns, and
    // a mapper requiring terminality would fail here.
    expect(result.plugin_states.get('producer')).toBe('gated')
    expect(result.plugin_states.get('consumer')).toBe('pending')
    expect(result.gated_plugins).toContain('producer')

    expect(advanceExitCode(result)).toBe(0)
    expect(advanceExitCode(result, { strict: true })).toBe(1)
  })

  test('an empty plugin root is 1, with and without strict', async () => {
    const result = await advance()

    expect(result.plugin_states.size).toBe(0)
    expect(advanceExitCode(result)).toBe(1)
    expect(advanceExitCode(result, { strict: true })).toBe(1)
  })

  test('a plugin that failed to load is 1 over a non-empty map, with and without strict', async () => {
    await writePlugin('healthy')
    await writeUnloadablePlugin('broken')

    const result = await advance()

    expect(result.plugin_states.get('broken')).toBe('failed')
    expect(result.plugin_states.size).toBeGreaterThan(0)
    expect(advanceExitCode(result)).toBe(1)
    expect(advanceExitCode(result, { strict: true })).toBe(1)
  })

  test('a clean advance where every plugin completed is 0', async () => {
    await writePlugin('alpha')
    await writePlugin('bravo')

    const result = await advance()

    expect([...result.plugin_states.values()]).toEqual(['completed', 'completed'])
    expect(advanceExitCode(result)).toBe(0)
    expect(advanceExitCode(result, { strict: true })).toBe(0)
  })
})

describe('advanceCounts', () => {
  /**
   * The counts a run's own record carries come from this walk, not a second one
   * computed beside it. Two accounts of one advance only have to disagree once.
   */
  test('reports the gated and failed counts of the gated two-level result', async () => {
    await writePlugin('producer', {
      autonomy_level: 'supervised',
      side_effects: ['sends_email'],
    })
    await writePlugin('consumer', { dependencies: ['producer'] })
    await grantApproval('producer', 4 * 60 * 60 * 1000, approvalPath)

    const result = await advance()
    const counts = advanceCounts(result)

    expect(counts.gated).toBe(result.gated_plugins.length)
    expect(counts.failed).toBe(
      [...result.plugin_states.values()].filter((s) => s === 'failed').length,
    )
    expect(counts).toEqual({ gated: 1, failed: 0, refused: 0 })
  })

  test('counts a load failure as failed', async () => {
    await writePlugin('healthy')
    await writeUnloadablePlugin('broken')

    const counts = advanceCounts(await advance())

    expect(counts).toEqual({ gated: 0, failed: 1, refused: 0 })
  })
})

/**
 * A content refusal is a gate holding for a second reason, and the code says so.
 *
 * The fixture is a content-class plugin whose approval window has closed. It is
 * built by the shared helper rather than here, so the three files that need a
 * refusal describe one standing the runtime actually reaches — see
 * `helpers/content-refusal.ts` for why the window arm and not a drifted
 * fingerprint.
 *
 * Every case drives a real `runAdvance`, as the rest of this file does. The
 * claim is about the array the engine populates, and a hand-built result would
 * pin the arithmetic while leaving that unproven.
 */
describe('a content refusal in the account of an advance', () => {
  test('an advance whose only event is a refusal is 0, and --strict makes it 1', async () => {
    await seedContentRefusals({ pluginsDir: ctx.pluginsDir, statePath, names: ['sender'] })

    const result = await advance()

    // Non-vacuous: the refusal really happened, so the 0 below is the gate
    // holding rather than an advance that found nothing to do.
    expect(result.refused_plugins).toEqual([{ plugin: 'sender', reason: 'outside_window' }])
    expect(advanceCounts(result).failed).toBe(0)

    // The module's own doctrine: a held approval gate is the runtime doing its
    // job. A content refusal is the same gate holding for a different reason.
    expect(advanceExitCode(result)).toBe(0)
    expect(advanceExitCode(result, { strict: true })).toBe(1)
  })

  test('two refusals in one advance are counted individually, not collapsed', async () => {
    await seedContentRefusals({
      pluginsDir: ctx.pluginsDir,
      statePath,
      names: ['sender-a', 'sender-b'],
    })

    const counts = advanceCounts(await advance())

    expect(counts).toEqual({ gated: 0, failed: 0, refused: 2 })
  })

  test('a refusal beside a failure is 1 without --strict — a failure still outranks', async () => {
    await seedContentRefusals({ pluginsDir: ctx.pluginsDir, statePath, names: ['sender'] })
    await writeUnloadablePlugin('broken')

    const result = await advance()
    const counts = advanceCounts(result)

    expect(counts.refused).toBe(1)
    expect(counts.failed).toBe(1)
    // The existing precedence is unchanged: `failed > 0` is tested above the
    // gated-or-refused clause, so this is 1 with the flag and without it.
    expect(advanceExitCode(result)).toBe(1)
    expect(advanceExitCode(result, { strict: true })).toBe(1)
  })

  test('a refusal beside a held gate is 1 under --strict — once, not twice', async () => {
    await writePlugin('producer', {
      autonomy_level: 'supervised',
      side_effects: ['sends_email'],
    })
    await writePlugin('consumer', { dependencies: ['producer'] })
    await seedContentRefusals({ pluginsDir: ctx.pluginsDir, statePath, names: ['sender'] })
    await grantApproval('producer', 4 * 60 * 60 * 1000, approvalPath)

    const result = await advance()
    const counts = advanceCounts(result)

    // Both events are present, which is what makes the single 1 below a
    // statement about the predicate rather than about a fixture with one event.
    expect(counts.gated).toBe(1)
    expect(counts.refused).toBe(1)
    expect(counts.failed).toBe(0)

    // The predicate is gated-OR-refused, not a sum over exit codes: two reasons
    // to report 1 still report exactly 1.
    expect(advanceExitCode(result, { strict: true })).toBe(1)
    expect(advanceExitCode(result)).toBe(0)
  })

  test('an advance with no refusals reports refused 0 rather than omitting the field', async () => {
    await writePlugin('alpha')

    const counts = advanceCounts(await advance())

    // Always present, `0` included. A monitor has to be able to tell "nothing
    // was refused" from "this warpline does not report refusals" — the same
    // argument `pruned` makes about itself in the advance payload.
    expect(counts.refused).toBe(0)
  })
})
