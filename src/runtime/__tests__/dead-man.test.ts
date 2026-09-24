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
 * a run id, timestamps, a status, a reason token and five integers, and
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
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { applyPendingGate, findPendingGate, loadPluginManifests, runAdvance } from '../engine.js'
import type { AdvanceOptions, AdvanceResult } from '../engine.js'
import { readEngineState } from '../engine-state-store.js'
import type { PluginManifest } from '../../schemas/plugin-manifest.js'
import { advanceCounts, advanceExitCode } from '../exit-codes.js'
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

    expect({
      gated: doc.gated,
      failed: doc.failed,
      refused: doc.refused,
      pending_gates: doc.pending_gates,
    }).toEqual(counts)
  })

  /**
   * The disagreement the counts exist to prevent, reached through a new cause.
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
      'pending_gates',
      'pruned',
      'refused',
      'run_id',
      'skipped_reason',
      'status',
    ])
  })
})

/**
 * A standing gate is an unapplied entry in the state document's
 * `pending_gates`, whichever advance parked it. `gated` counts only what the
 * advance that wrote the file parked, so on every later tick while the same
 * gate waits it reads `0`, and a file keyed on it reads healthy while a human
 * still owes an answer. `pending_gates` is the count that does not forget.
 *
 * The second advance in each case must find the plugin NOT due. That is what
 * `ttl_hours: 24` buys: a plugin that ran again would park again, `gated` would
 * read `1`, and the case would pass for the wrong reason, which is the exact
 * blind spot this count exists to close. The required case asserts the plugin
 * was `skipped` and nothing was parked before it asserts the new contract.
 *
 * The applied control is the one case that sees the unapplied filter: a gate
 * applied and kept as a spent marker is still in the document, and it waits on
 * nobody.
 *
 * Two cases see the quiet-hours arm, which writes no document and so counts
 * from the one it read. The first proves a gate waiting overnight is counted.
 * The second proves that arm counts the same set the normal arm writes: a gate
 * past the gate ceiling is still in the document the quiet arm read, and the
 * next normal write would drop it, so it is not counted there either.
 */
describe('a gate still waiting from an earlier advance', () => {
  async function writeWaitingProducer(): Promise<void> {
    await writePlugin('producer', {
      autonomy_level: 'supervised',
      side_effects: ['sends_email'],
      ttl_hours: 24,
    })
    await grantApproval('producer', 4 * 60 * 60 * 1000, approvalPath)
  }

  test('a gate parked on an earlier advance is counted, and --strict reports it', async () => {
    await writeWaitingProducer()

    const first = await advance()
    const firstDoc = await readDeadMan()
    expect(first.gated_plugins).toEqual(['producer'])
    expect(firstDoc.gated).toBe(1)

    const second = await advance()
    const secondDoc = await readDeadMan()
    const state = await readEngineState(statePath)

    // Preconditions first, so a fixture that stopped gating or started
    // re-running fails here rather than on the contract below.
    expect(second.plugin_states.get('producer')).toBe('skipped')
    expect(second.gated_plugins).toEqual([])
    expect(second.status).toBe('complete')
    expect(state.pending_gates).toHaveLength(1)
    expect(state.pending_gates[0]?.applied_at).toBeNull()

    // The parking advance counts it in both fields, and never more parks
    // than gates still waiting.
    expect(firstDoc.pending_gates).toBe(1)
    expect(firstDoc.gated as number).toBeLessThanOrEqual(firstDoc.pending_gates as number)

    // The later advance parked nothing, and the gate is still waiting.
    expect(secondDoc.gated).toBe(0)
    expect(secondDoc.pending_gates).toBe(1)
    expect(advanceExitCode(second)).toBe(0)
    expect(advanceExitCode(second, { strict: true })).toBe(1)
  })

  test('an applied gate kept as a spent marker is not counted', async () => {
    await writeWaitingProducer()
    await advance()

    const { manifests } = await loadPluginManifests(ctx.pluginsDir)
    const parked = await readEngineState(statePath)
    const gate = findPendingGate(parked, 'producer')
    expect(gate).toBeDefined()
    const applied = await applyPendingGate(
      parked,
      gate as NonNullable<typeof gate>,
      manifests.get('producer') as PluginManifest,
      { statePath, manifests, eventsPath },
    )
    expect(applied.outcome).toBe('applied')

    const result = await advance()
    const doc = await readDeadMan()
    const state = await readEngineState(statePath)

    // Non-vacuous: the marker is still in the document, so a count that
    // skipped the unapplied filter would read 1 here.
    expect(state.pending_gates).toHaveLength(1)
    expect(typeof state.pending_gates[0]?.applied_at).toBe('string')

    expect(doc.pending_gates).toBe(0)
    expect(advanceExitCode(result, { strict: true })).toBe(0)
  })

  test('no gate at all reads pending_gates 0, present rather than omitted', async () => {
    await writePlugin('alpha')

    const result = await advance()
    const doc = await readDeadMan()

    expect(doc.pending_gates).toBe(0)
    expect(Object.keys(doc)).toContain('pending_gates')
    expect(advanceExitCode(result, { strict: true })).toBe(0)
  })

  test('a gate waiting through quiet hours is counted on the skipped advance', async () => {
    await writeWaitingProducer()
    await advance()
    await writePreferences({ quiet_hours: windowAroundNow() })

    const result = await advance()
    const doc = await readDeadMan()

    // The early return actually happened.
    expect(result.run_log_path).toBe('')
    expect(doc.skipped_reason).toBe('quiet_hours')

    expect(doc.gated).toBe(0)
    expect(doc.pending_gates).toBe(1)
    expect(advanceExitCode(result, { strict: true })).toBe(1)
    expect(advanceExitCode(result)).toBe(0)
  })

  test('a gate past the gate ceiling is not counted on a skipped advance either', async () => {
    await writeWaitingProducer()
    await advance()

    // Age the parked gate past the 23-hour ceiling by hand. The quiet arm
    // writes nothing, so this is the document it reads.
    const raw = JSON.parse(await readFile(statePath, 'utf8')) as {
      pending_gates: Array<Record<string, unknown>>
    }
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const aged = raw.pending_gates[0] as Record<string, unknown>
    aged.run_started_at = dayAgo
    aged.run_completed_at = dayAgo
    aged.created_at = dayAgo
    await writeFile(statePath, JSON.stringify(raw))
    await writePreferences({ quiet_hours: windowAroundNow() })

    const result = await advance()
    const doc = await readDeadMan()
    const state = await readEngineState(statePath)

    expect(result.run_log_path).toBe('')
    // Non-vacuous: the gate is still in the document, unapplied, so a count
    // over the raw array would read 1.
    expect(state.pending_gates).toHaveLength(1)
    expect(state.pending_gates[0]?.applied_at).toBeNull()

    expect(doc.pending_gates).toBe(0)
    expect(advanceExitCode(result, { strict: true })).toBe(0)
  })

  // A gate for a plugin this advance did not load waits on nobody: `approve`
  // and `deny` both refuse a name with no loaded manifest, so no command can
  // clear it. Counting it would page `--strict` on every tick until the
  // ceiling drops it. `alpha` stays installed so the root is not empty.
  async function parkThenUninstall(): Promise<void> {
    await writeWaitingProducer()
    await writePlugin('alpha')
    await advance()
    expect((await readDeadMan()).pending_gates).toBe(1)
    await rm(join(ctx.pluginsDir, 'producer'), { recursive: true })
  }

  test('a gate for a plugin that is no longer installed is not counted', async () => {
    await parkThenUninstall()

    const result = await advance()
    const doc = await readDeadMan()
    const state = await readEngineState(statePath)

    expect(result.status).toBe('complete')
    // Non-vacuous: the merge kept the orphan gate, unapplied, so a count that
    // ignored what loaded would read 1.
    expect(state.pending_gates).toHaveLength(1)
    expect(state.pending_gates[0]?.plugin).toBe('producer')
    expect(state.pending_gates[0]?.applied_at).toBeNull()

    expect(doc.pending_gates).toBe(0)
    expect(advanceExitCode(result, { strict: true })).toBe(0)
  })

  test('a gate for a plugin that is no longer installed is not counted on a skipped advance either', async () => {
    await parkThenUninstall()
    await writePreferences({ quiet_hours: windowAroundNow() })

    const result = await advance()
    const doc = await readDeadMan()
    const state = await readEngineState(statePath)

    expect(result.run_log_path).toBe('')
    expect(state.pending_gates).toHaveLength(1)
    expect(state.pending_gates[0]?.applied_at).toBeNull()

    expect(doc.pending_gates).toBe(0)
    expect(advanceExitCode(result, { strict: true })).toBe(0)
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
