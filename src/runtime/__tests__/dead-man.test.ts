/**
 * The dead-man file — `<state>/last-successful-advance`.
 *
 * This runtime ships no HTTP surface and no alerting hook, and a warpline that
 * has stopped cannot alert that it has stopped. So the file's own age is the
 * monitor interface, and a detector outside this process reads it to tell a
 * healthy fleet from an all-gated one from a broken one from an asleep one
 * from a stopped one.
 *
 * Every case drives `runAdvance` DIRECTLY. The claim is about the advance, not
 * about the command — the benchmark harness calls the advance with no options
 * at all — so a suite routing through the CLI would leave that claim unpinned.
 *
 * Two cases carry most of the value.
 *
 * The not-written-on-a-throw case asserts an UNCHANGED pre-existing file, not
 * an absent one. Asserting absence would pass on a home where no advance ever
 * succeeded, which is not the case the requirement is about: the point is that
 * a held lock, a missing home or unreadable state leaves the LAST good file
 * standing, because a stale file is precisely the signal an operator needs.
 *
 * The key-enumeration case asserts the exact top-level key set. The document is
 * a run id, timestamps, a status, a reason token and four integers, and
 * nothing else — no plugin summary, no plugin output, no operator
 * configuration value, no path outside the home. This project has twice had to
 * fix a leak where operator values reached a summary field, and a free-text
 * field here reopens that class. The enumeration is what makes adding one a
 * deliberate act that turns a gate red.
 *
 * The counts are asserted against `advanceCounts` — the function the exit code
 * itself uses — rather than recomputed here. Two counters computed in two
 * places is how the file and the monitor start disagreeing about one advance.
 */
import { describe, test, expect, beforeEach, afterEach, afterAll } from 'bun:test'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { runAdvance } from '../engine.js'
import type { AdvanceOptions, AdvanceResult } from '../engine.js'
import { advanceCounts } from '../exit-codes.js'
import { grantApproval } from '../approval-gate.js'
import { createTestHome, type TestHome } from './helpers/create-test-home.js'
import { seedContentRefusals } from './helpers/content-refusal.js'
import { _setHome, lastSuccessfulAdvancePath } from '../../lib/paths.js'
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
  // Both, and for different reasons. `_setHome` re-roots the path helpers so
  // the writer under test is provably inside the temp root; `_setPaths`
  // re-roots the task-lock gate, which reads a module global rather than the
  // advance's options.
  _setHome(ctx.root)
  _setPaths(pathsForStateFile(statePath, { eventsPath }))
})

afterEach(async () => {
  _setHome(null)
  await ctx.cleanup()
})

afterAll(() => {
  _setPaths(REAL_PATHS)
})

/** A plugin that loads and runs. Near-zero TTL so it is always due. */
async function writePlugin(
  name: string,
  overrides: Record<string, unknown> = {},
  resultStatus: 'success' | 'failed' = 'success',
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
    status: '${resultStatus}',
    phases_completed: [],
    phases_failed: ${resultStatus === 'failed' ? `['${name}']` : '[]'},
    errors: ${resultStatus === 'failed' ? `['${name} refused']` : '[]'},
    data_freshness: {},
    summary: '${name} ${resultStatus}',
    artifacts_produced: [],
    schema_version: 1,
  }
}
`,
  )
}

/**
 * A quiet-hours window that contains right now, whatever "now" is.
 *
 * Derived rather than hardcoded, because `isQuietHours` reads the LOCAL clock
 * and a fixed `22:00`-`07:00` pair asserts one branch at noon and the other at
 * midnight. Quiet hours are opt-in and the window defaults to off, so every
 * case below that wants the arm configures it.
 */
function windowAroundNow(): { start: string; end: string } {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const at = (offsetMs: number): string => {
    const d = new Date(Date.now() + offsetMs)
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
  return { start: at(-60 * 60 * 1000), end: at(60 * 60 * 1000) }
}

async function writePreferences(extra: Record<string, unknown>): Promise<void> {
  await writeFile(
    join(ctx.stateDir, 'preferences.json'),
    JSON.stringify({ review_gate: false, ...extra }),
  )
}

function advance(overrides: Partial<AdvanceOptions> = {}): Promise<AdvanceResult> {
  return runAdvance({
    pluginsDir: ctx.pluginsDir,
    stateDir: statePath,
    runsDir: ctx.runsDir,
    eventsPath,
    approvalPath,
    ...overrides,
  })
}

/** The document as written, parsed. */
async function readDeadMan(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(lastSuccessfulAdvancePath(), 'utf8')) as Record<string, unknown>
}

describe('the dead-man file is written on every arm that returned', () => {
  test('a complete advance writes it beside the engine state document', async () => {
    await writePlugin('alpha')

    const result = await advance()
    const doc = await readDeadMan()

    // Beside `engine-state.json`, not a field inside it.
    expect(lastSuccessfulAdvancePath()).toBe(join(ctx.stateDir, 'last-successful-advance'))
    expect(result.status).toBe('complete')
    expect(doc.run_id).toBe(result.run_id)
    expect(doc.status).toBe('complete')
    expect(doc.gated).toBe(0)
    expect(doc.failed).toBe(0)
    expect(doc.skipped_reason).toBeNull()
  })

  test('a gated advance writes it, with the gate counted and nothing failed', async () => {
    // Two levels, the first gating: `producer` is supervised and declares a
    // side effect, so with a live grant the approval gate passes and the
    // supervision gate parks it. This is the case the requirement exists for —
    // a held gate is the runtime doing its job, and the switch must not fire on
    // a healthy day whose healthy thing is a gate.
    await writePlugin('producer', { autonomy_level: 'supervised', side_effects: ['sends_email'] })
    await writePlugin('consumer', { dependencies: ['producer'] })
    await grantApproval('producer', 4 * 60 * 60 * 1000, approvalPath)

    const result = await advance()
    const doc = await readDeadMan()

    expect(result.gated_plugins).toContain('producer')
    expect(doc.gated).toBe(result.gated_plugins.length)
    expect(doc.failed).toBe(0)
  })

  test('an advance with one failed plugin counts it', async () => {
    await writePlugin('breaks', {}, 'failed')

    const result = await advance()
    const doc = await readDeadMan()

    expect(result.plugin_states.get('breaks')).toBe('failed')
    expect(doc.failed).toBe(1)
  })

  test('a skipped advance records the reason — when quiet hours are configured', async () => {
    await writePlugin('alpha')
    await writePreferences({ quiet_hours: windowAroundNow() })

    const result = await advance()
    const doc = await readDeadMan()

    // The early return actually happened.
    expect(result.run_log_path).toBe('')
    // This field is what lets a detector reading only this file tell an asleep
    // fleet from a broken one.
    expect(doc.skipped_reason).toBe('quiet_hours')
    expect(doc.run_id).toBe(result.run_id)
    expect(doc.gated).toBe(0)
    expect(doc.failed).toBe(0)
  })

  test('a zero-manifest advance still writes the file', async () => {
    const result = await advance()
    const doc = await readDeadMan()

    // The file exists even when nothing ran. A monitor that never sees a file
    // cannot tell an empty plugin root from a stopped warpline, and those need
    // different answers from an operator.
    expect(result.status).toBe('failed')
    expect(doc.status).toBe('failed')
    expect(doc.gated).toBe(0)
    expect(doc.failed).toBe(0)
  })

  test('the counts are the exit code own counter, not a second walk', async () => {
    await writePlugin('producer', { autonomy_level: 'supervised', side_effects: ['sends_email'] })
    await writePlugin('consumer', { dependencies: ['producer'] })
    await writePlugin('breaks', {}, 'failed')
    await grantApproval('producer', 4 * 60 * 60 * 1000, approvalPath)

    const result = await advance()
    const doc = await readDeadMan()
    const counts = advanceCounts(result)

    expect({ gated: doc.gated, failed: doc.failed, refused: doc.refused }).toEqual(counts)
  })

  /**
   * The disagreement HEAD-12 exists to prevent, reached through a new cause.
   *
   * A content refusal exits `0`, so a monitor keying on the exit code alone
   * learns nothing from it — which is the point: a held gate is the runtime
   * doing its job. The failure that leaves is silent. A fleet can refuse every
   * send on every advance for a week while this file reads healthy, and the
   * count is the only thing standing between an operator and that week.
   *
   * Asserted through the file alone, not through the result: a detector reads
   * this document and nothing else, so the claim has to be stated in the terms
   * that detector has.
   */
  test('a refusal-only advance is non-zero in refused, so the file and the exit code agree', async () => {
    await seedContentRefusals({ pluginsDir: ctx.pluginsDir, statePath, names: ['sender'] })

    const result = await advance()
    const doc = await readDeadMan()

    // Non-vacuous: the refusal really happened on this advance.
    expect(result.refused_plugins).toEqual([{ plugin: 'sender', reason: 'outside_window' }])

    expect(doc.refused).toBe(1)
    // The other two are zero, which is what makes `refused` the field that
    // tells this file apart from a healthy one — the same property `gated` has.
    expect(doc.gated).toBe(0)
    expect(doc.failed).toBe(0)
    expect(doc.skipped_reason).toBeNull()
  })

  test('the prune count reaches the result and the file', async () => {
    await writePlugin('alpha')
    // Nothing survives its bucket, so every pre-existing record is doomed. Two
    // documents written before the advance, both classifiable, neither
    // protected.
    await writePreferences({ retention: { keep_per_plugin: 0 } })
    await writeFile(join(ctx.runsDir, 'old-a.json'), JSON.stringify({ run_id: 'old-a', status: 'complete' }))
    await writeFile(join(ctx.runsDir, 'old-b.json'), JSON.stringify({ run_id: 'old-b', status: 'complete' }))

    const result = await advance()
    const doc = await readDeadMan()

    expect(existsSync(join(ctx.runsDir, 'old-a.json'))).toBe(false)
    expect(existsSync(join(ctx.runsDir, 'old-b.json'))).toBe(false)
    expect(result.pruned).toBe(2)
    expect(doc.pruned).toBe(2)
  })

  test('the top-level key set is exactly the documented one', async () => {
    await writePlugin('alpha')

    await advance()
    const doc = await readDeadMan()

    // Enumerated, not spot-checked. A field added to this document is a field
    // an operator's detector can start reading, and the ones that carry free
    // text are the ones that leak. Adding one has to turn this red.
    expect(Object.keys(doc).sort()).toEqual([
      'completed_at',
      'failed',
      'gated',
      'pruned',
      'refused',
      'run_id',
      'skipped_reason',
      'status',
    ])
  })
})

describe('the dead-man file follows a relocated state file', () => {
  test('a state override puts the file beside it and never under the live home', async () => {
    // Every other case in this file runs with the home and the state override
    // pointing at the SAME temp root, so all of them are equally satisfied by a
    // writer that ignores the override and always uses the live-home default.
    // This is the one case that tells those two implementations apart, and it
    // is the guard shape this project has recorded running green over something
    // outside its reach six times.
    const elsewhere = await createTestHome()
    try {
      const relocated = join(elsewhere.stateDir, 'engine-state.json')
      await writePlugin('alpha')

      const result = await advance({ stateDir: relocated, runsDir: elsewhere.runsDir })

      expect(result.status).toBe('complete')
      const beside = join(elsewhere.stateDir, 'last-successful-advance')
      expect(existsSync(beside)).toBe(true)
      expect(JSON.parse(await readFile(beside, 'utf8')).run_id).toBe(result.run_id)

      // `_setHome` still points at `ctx.root`, so this is the live-home path
      // the default derivation would have produced. Nothing was written there.
      expect(existsSync(lastSuccessfulAdvancePath())).toBe(false)
    } finally {
      await elsewhere.cleanup()
    }
  })
})

describe('the dead-man file is not written on a throw', () => {
  test('a throw from inside the advance leaves the last good file exactly as it was', async () => {
    await writePlugin('alpha')

    // First, a real advance, so there IS a file to leave alone. Asserting mere
    // absence would pass on a home where no advance ever succeeded, which is
    // not what the requirement is about.
    const good = await advance()
    const before = await readFile(lastSuccessfulAdvancePath(), 'utf8')
    const beforeStat = await stat(lastSuccessfulAdvancePath())

    // Corrupt the state document. The read is the first thing inside the
    // locked span, so this throws below the acquire and above every write —
    // which is the arm that discriminates. A plugin root that cannot be read
    // is refused ABOVE the span and would be satisfied by a writer sitting in
    // the `finally`.
    await writeFile(statePath, '{"schema_version": 1, "plugin_runs":')

    await expect(advance()).rejects.toThrow()

    const after = await readFile(lastSuccessfulAdvancePath(), 'utf8')
    const afterStat = await stat(lastSuccessfulAdvancePath())

    expect(after).toBe(before)
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs)
    // And the stale file still names the run that actually succeeded, which is
    // the whole of the signal: its age says the fleet stopped.
    expect(JSON.parse(after).run_id).toBe(good.run_id)
  })

  test('a plugin root that cannot be read writes no file at all', async () => {
    await expect(advance({ pluginsDir: join(ctx.root, 'no-such-root') })).rejects.toThrow(/ENOENT/)

    expect(existsSync(lastSuccessfulAdvancePath())).toBe(false)
  })
})
