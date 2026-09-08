/**
 * A plugin whose declared dependency last ran and failed does not run, and the
 * run log says which dependency.
 *
 * This file covers a runtime gate whose whole purpose is to distinguish absence
 * of observation from absence of change. Without it, a diff-against-history
 * consumer whose producer failed reads the snapshot the producer left behind on
 * some earlier cycle, finds it identical to what it already published, and
 * returns `success` with "no change" — a run log recording a healthy result that
 * observed nothing. There is no error, no signal, and no field an operator can
 * read to tell the two apart.
 *
 * The invariant, stated once: a dependency whose `plugin_runs` entry records
 * `failed` makes its dependents not-due for the reason `dependency_failed`, the
 * dependent is recorded `skipped` with a summary naming every such dependency in
 * manifest-declared order, and the dependent gets NO run record — because it did
 * not run.
 *
 * The arms:
 *
 *   POSITIVE, both recorded-failure paths. A handler that throws and a handler
 *   that returns a failed result are two different routes into the same
 *   `plugin_runs` status, and a gate reading that status must fire on both. The
 *   throwing arm is the two-advance form, so the consumer's run record from the
 *   healthy advance is in hand and can be shown NOT to move; the failed-result
 *   arm sets the marker before the first advance, so the consumer never ran at
 *   all and the absence of a record is total rather than merely unchanged.
 *
 *   POSITIVE, the detail. Two failed dependencies declared in an order that is
 *   not alphabetical, asserted as an EXACT string. Exact and not `toContain`,
 *   because the thing being proved is as much what the summary does not carry as
 *   what it does: this string lands in the run log, which is read and shared, and
 *   this repository has twice paid for an operator-configured value reaching a
 *   result summary. A substring assertion is green with a leaked path appended.
 *
 *   NEGATIVE, twice. A dependency whose last run succeeded, and a declared
 *   dependency with no run record at all. A gate that fires on every status is
 *   not this gate — gating on a handoff would break every judgment chain in the
 *   repository, and a dependency that never ran cannot invalidate anything.
 *
 * Presence first, throughout, the discipline `dependency-run-status-leak.test.ts`
 * uses: before the consumer's skip is attributed to the producer, the producer's
 * `failed` status is asserted to be in state. An assertion about a cause is worth
 * nothing if the cause was never established — a producer that silently never ran
 * would satisfy "the consumer was skipped" for a reason that has nothing to do
 * with this gate.
 *
 * And the assertions read the EMITTED RUN-LOG ROW, never the evaluator's returned
 * reason alone. The fallthrough hazard this gate is built beside stays green under
 * an evaluator unit test by construction: the reason is right and the orchestrator
 * files it under the wrong arm. Only what was written can see that.
 *
 * Driven by `createTwoAdvanceHome` rather than a hand-built two-plugin home. Its
 * producer modes are exactly the two recorded-failure paths, and its marker
 * defeats the module cache — `import()` caches a handler module, so a rewritten
 * `handler.ts` is never re-read between advances and a hand-rolled version gets
 * that wrong silently.
 */
import { describe, test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { existsSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { createTwoAdvanceHome, type TwoAdvanceHome } from './helpers/two-advance-home.js'
import { _setPaths } from '../../board/state-manager.js'
import { installStatePathIsolation } from '../../../test-utils/state-path-isolation.js'
import { warplineHome } from '../../lib/paths.js'
import { denialFingerprint } from '../engine.js'

/** The evaluator's whole detail for the task-lock arm, copied from `engine.ts`. */
const LOCK_DETAIL = 'task locked — active on board'

/** The evaluator's whole detail for a single failed dependency named `prod`. */
const DEPENDENCY_FAILED_DETAIL =
  "skipped: dependency failed — 'prod' last recorded status 'failed'"

/** What the approval arm writes for a consumer declaring one effect. */
const UNAPPROVED_SUMMARY =
  'skipped (unapproved): side effects [sends_email] require session approval'

/**
 * A consumer that does nothing but succeed.
 *
 * It reads no dependency member on purpose. What is under test is whether the
 * consumer is invoked at all, and a handler that consulted the seam would make a
 * gated run and a run that consulted an empty seam look alike in the one place
 * the assertions read.
 */
const CONSUMER = `
export async function handler(manifest, args, signal, capabilities) {
  return {
    status: 'success',
    phases_completed: ['consumer'],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: 'consumer ran',
    artifacts_produced: [],
    schema_version: 1,
  }
}
`

describe('a plugin whose dependency failed does not run against what it left behind', () => {
  let home: TwoAdvanceHome

  beforeEach(async () => {
    home = await createTwoAdvanceHome()
  })

  afterEach(async () => {
    await home.cleanup()
  })

  test('a producer that throws gates its consumer, and moves no timestamp', async () => {
    await home.writePlugin('prod', {
      outputs: { brief: {} },
      handlerBody: home.producer('throw'),
    })
    await home.writePlugin('consumer', { dependencies: ['prod'], handlerBody: CONSUMER })

    await home.advance()
    // The healthy advance's record, captured before anything can move it. The
    // gate's promise is that the second advance leaves this exact object alone.
    const consumerBefore = await home.persistedRun('consumer')
    expect(consumerBefore).toBeDefined()

    await home.setMarker()
    const r2 = await home.advance()

    // PRESENCE. The cause, established before the effect is attributed to it.
    expect((await home.persistedRun('prod'))?.status).toBe('failed')

    const entry = await home.entryFor(r2.run_log_path, 'consumer')
    expect(entry).not.toBeNull()
    expect(entry!.status).toBe('skipped')
    expect(entry!.result_summary).toBe(
      "skipped: dependency failed — 'prod' last recorded status 'failed'",
    )

    // No run record for a run that did not happen. Unchanged, byte for byte:
    // a write here would move `last_run_at`, re-arming the freshness latch for
    // a plugin that never ran.
    expect(await home.persistedRun('consumer')).toEqual(consumerBefore)
  })

  test('a producer that returns a failed result gates its consumer, which gets no record at all', async () => {
    await home.writePlugin('prod', {
      outputs: { brief: {} },
      handlerBody: home.producer('failed'),
    })
    await home.writePlugin('consumer', { dependencies: ['prod'], handlerBody: CONSUMER })

    // The marker before the FIRST advance, so the producer takes its mode
    // straight away and the consumer has never run. Absence of a record is then
    // total, not merely unmoved — and a plugin that never ran must be
    // distinguishable from one that ran and produced nothing.
    await home.setMarker()
    const r1 = await home.advance()

    expect((await home.persistedRun('prod'))?.status).toBe('failed')

    const entry = await home.entryFor(r1.run_log_path, 'consumer')
    expect(entry).not.toBeNull()
    expect(entry!.status).toBe('skipped')
    expect(entry!.result_summary).toBe(
      "skipped: dependency failed — 'prod' last recorded status 'failed'",
    )
    expect(await home.persistedRun('consumer')).toBeUndefined()
  })

  test('two failed dependencies are named in manifest-declared order', async () => {
    await home.writePlugin('prod', {
      outputs: { brief: {} },
      handlerBody: home.producer('throw'),
    })
    await home.writePlugin('prod2', {
      outputs: { brief: {} },
      handlerBody: home.producer('failed'),
    })
    // Declared out of alphabetical order deliberately. Sorted output would agree
    // with `['prod', 'prod2']` by accident, and the claim is manifest order.
    await home.writePlugin('consumer', {
      dependencies: ['prod2', 'prod'],
      handlerBody: CONSUMER,
    })

    await home.setMarker()
    const r1 = await home.advance()

    expect((await home.persistedRun('prod'))?.status).toBe('failed')
    expect((await home.persistedRun('prod2'))?.status).toBe('failed')

    const entry = await home.entryFor(r1.run_log_path, 'consumer')
    expect(entry).not.toBeNull()
    expect(entry!.status).toBe('skipped')
    // EXACT. Nothing appended, nothing interpolated but the two declared names
    // and the one closed enum value.
    expect(entry!.result_summary).toBe(
      "skipped: dependency failed — 'prod2', 'prod' last recorded status 'failed'",
    )
  })

  test('a dependency whose last run succeeded does not gate its consumer', async () => {
    await home.writePlugin('prod', {
      outputs: { brief: {} },
      handlerBody: home.producer('success-with-nothing'),
    })
    await home.writePlugin('consumer', { dependencies: ['prod'], handlerBody: CONSUMER })

    await home.advance()
    await home.setMarker()
    const r2 = await home.advance()

    // The producer really did take its mode arm — otherwise this case proves
    // nothing beyond "an untouched fixture runs".
    expect((await home.persistedRun('prod'))?.status).toBe('success')

    const entry = await home.entryFor(r2.run_log_path, 'consumer')
    expect(entry).not.toBeNull()
    expect(entry!.status).toBe('completed')
    expect(await home.persistedRun('consumer')).toBeDefined()
  })

  /**
   * A producer that hands its work to an LLM, and one that publishes some of
   * what it was asked for. Written out here rather than taken from the helper,
   * whose three modes are the failure paths this file's positive cases need.
   *
   * The two statuses are the ones a reader assumes are covered by "the
   * dependency did not really work". They are not, and the reasons differ: a
   * `[needs-llm]` handoff and a plain skip lead a consumer to the same action —
   * read the carried-forward Output — so gating on `skipped` would stop every
   * judgment chain in the repository; and a `partial` producer published data
   * the authoring guide tells consumers to read.
   *
   * `gated` has no case here and cannot have one. A level holding a gate stops
   * the advance, so a supervised dependency's dependents are never evaluated at
   * all and there is no verdict to assert.
   */
  const producerReturning = (status: 'skipped' | 'partial', summary: string) => `
export async function handler(manifest, args, signal, capabilities) {
  return {
    status: ${JSON.stringify(status)},
    phases_completed: [],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: ${JSON.stringify(summary)},
    artifacts_produced: [],
    schema_version: 1,
  }
}
`

  test('a dependency that handed its work to an LLM does not gate its consumer', async () => {
    await home.writePlugin('prod', {
      outputs: { brief: {} },
      handlerBody: producerReturning('skipped', '[needs-llm] summarise the brief'),
    })
    await home.writePlugin('consumer', { dependencies: ['prod'], handlerBody: CONSUMER })

    const r1 = await home.advance()

    expect((await home.persistedRun('prod'))?.status).toBe('skipped')

    const entry = await home.entryFor(r1.run_log_path, 'consumer')
    expect(entry).not.toBeNull()
    expect(entry!.status).toBe('completed')
  })

  test('a dependency that ended partial does not gate its consumer', async () => {
    await home.writePlugin('prod', {
      outputs: { brief: {} },
      handlerBody: producerReturning('partial', 'prod published half of it'),
    })
    await home.writePlugin('consumer', { dependencies: ['prod'], handlerBody: CONSUMER })

    const r1 = await home.advance()

    expect((await home.persistedRun('prod'))?.status).toBe('partial')

    const entry = await home.entryFor(r1.run_log_path, 'consumer')
    expect(entry).not.toBeNull()
    expect(entry!.status).toBe('completed')
  })

  test('a declared dependency with no run record at all does not gate its consumer', async () => {
    // `ghost` is declared and never installed. `topoSort` ignores a dependency
    // that is not in the plugin map, so the consumer is a root and `ghost` has
    // no `plugin_runs` entry on any advance. A dependency that never ran cannot
    // invalidate anything.
    await home.writePlugin('consumer', { dependencies: ['ghost'], handlerBody: CONSUMER })

    const r1 = await home.advance()

    expect(await home.persistedRun('ghost')).toBeUndefined()

    const entry = await home.entryFor(r1.run_log_path, 'consumer')
    expect(entry).not.toBeNull()
    expect(entry!.status).toBe('completed')
    expect(await home.persistedRun('consumer')).toBeDefined()
  })
})

/**
 * Where the gate sits in the chain, proved pairwise against each of its three
 * neighbours, on the row the engine emitted.
 *
 * The chain's declared order is pinned as a list by `gate-order.test.ts`. That
 * proves `GATES` says what it says; it cannot prove the orchestrator agrees,
 * because a scan that returns the right reason and an arm that files it under
 * the wrong heading are two different mistakes and only the second one reaches
 * an operator. So every case here arms TWO guards on one plugin at once and
 * reads which of them the run log names — the one observation that separates
 * them.
 *
 * Three pairs, one per neighbour:
 *
 *   AFTER the task lock. A task lock is a human holding the plugin open on the
 *   board, and that answer outranks a statement about the plugin's inputs. A
 *   locked-and-dependency-failed plugin must read as locked.
 *
 *   BEFORE the denial. A denial answers a proposal this plugin is not making
 *   this cycle, so the failed dependency is the fact the operator can act on.
 *
 *   BEFORE the approval check, which is the security-relevant one. Moving a
 *   gate ahead of the approval check is the class of change that can admit an
 *   ungranted side effect, so this case asserts the outcome as well as the
 *   reason: the side-effecting consumer holds no grant, gets no run record, and
 *   its handler is never entered. The operator sees a different reason; nobody
 *   sees a different outcome.
 *
 * NON-VACUITY. Two of the three cases would pass over the wrong ordering if
 * their second guard were never armed at all — an unmatched denial fingerprint
 * or an approval gate that let the plugin through would leave the dependency
 * failure as the only reason in play, and the assertion would prove nothing.
 * Both run a control advance FIRST, with the producer healthy, and assert the
 * other guard fires on its own. Only then is the marker set and the dependency
 * failed. The task-lock case needs no such control: it asserts the LOCK detail,
 * so a lock that never armed fails it directly.
 *
 * Presence-first throughout, as in the block above: the producer's `failed`
 * status is asserted in state before any skip is attributed to it.
 */
describe('the dependency gate sits where the chain declares it', () => {
  installStatePathIsolation()

  let home: TwoAdvanceHome
  /** The home this process resolved BEFORE any fixture pointed the env var elsewhere. */
  let realHome: string

  beforeAll(() => {
    realHome = warplineHome()
  })

  beforeEach(async () => {
    // Undo whatever a sibling file pinned on the state-manager global, so
    // `activePaths()` resolves lazily from `WARPLINE_HOME` again. `_getPaths`
    // MATERIALISES a snapshot rather than reporting that no override is
    // installed, so a sibling restoring its own capture pins this process at
    // paths that have nothing to do with us — and `checkTaskLock` is the one
    // guard in the chain that reads that global.
    _setPaths(null)
    home = await createTwoAdvanceHome()
  })

  afterEach(async () => {
    await home.cleanup()
  })

  /**
   * One advance with the fixture home exported, so `checkTaskLock` reads the
   * same `engine-state.json` the engine does.
   *
   * `checkTaskLock` takes no path parameter — it reads `activePaths()`, which
   * with no override installed derives from `stateDir()`, which joins
   * `WARPLINE_HOME`. The fixture's own `statePath` IS `<root>/state/engine-
   * state.json`, so the env var and the helper's explicit `stateDir` option
   * resolve to one file and there is no split brain. Routing the state-manager
   * global at a different path instead is what would create one: the engine
   * would read the option's file while the lock check read the override's, and
   * both the assertion and its control would go vacuous.
   */
  async function advanceInFixtureHome(): Promise<{ run_log_path: string }> {
    const root = resolve(home.root)
    // Two homes that overlap would let one engine's grant authorise the
    // other's side effects. Asserted in both directions before anything runs.
    const within = (a: string, b: string) => a === b || a.startsWith(b.endsWith(sep) ? b : b + sep)
    expect(within(root, realHome)).toBe(false)
    expect(within(realHome, root)).toBe(false)

    const real = process.env.WARPLINE_HOME
    process.env.WARPLINE_HOME = root
    try {
      // If a sibling file left a `paths.ts` override installed it beats the env
      // var inside `resolveHome`, and this is how that is detected without
      // installing one of our own.
      expect(warplineHome()).toBe(root)
      return await home.advance()
    } finally {
      if (real === undefined) delete process.env.WARPLINE_HOME
      else process.env.WARPLINE_HOME = real
    }
  }

  test('a plugin that is both task-locked and dependency-failed is recorded as task-locked', async () => {
    await home.writePlugin('prod', {
      outputs: { brief: {} },
      handlerBody: home.producer('failed'),
    })
    await home.writePlugin('consumer', { dependencies: ['prod'], handlerBody: CONSUMER })
    await home.seedState({
      task_aging: [
        {
          task_id: 'locked-task',
          first_flagged: new Date(Date.now() - 86_400_000).toISOString(),
          description: 'an open task locking the consumer',
          // 'critical' deliberately: a degraded tier auto-defers info-severity
          // tasks, and a deferred task is not an active lock — the fixture
          // would release its own lock partway through.
          severity: 'critical',
          source_check: 'consumer',
        },
      ],
    })

    // The marker before the first advance, so the producer fails immediately
    // and both guards are armed on the same evaluation.
    await home.setMarker()
    const r1 = await advanceInFixtureHome()

    expect((await home.persistedRun('prod'))?.status).toBe('failed')

    const entry = await home.entryFor(r1.run_log_path, 'consumer')
    expect(entry).not.toBeNull()
    expect(entry!.status).toBe('skipped')
    expect(entry!.result_summary).toBe(LOCK_DETAIL)
    // Stated the other way round too, so a future value that is neither still
    // names which mistake it made.
    expect(entry!.result_summary).not.toBe(DEPENDENCY_FAILED_DETAIL)
  })

  test('a plugin that is both dependency-failed and denied is recorded as dependency-failed', async () => {
    await home.writePlugin('prod', {
      outputs: { brief: {} },
      handlerBody: home.producer('failed'),
    })
    await home.writePlugin('consumer', { dependencies: ['prod'], handlerBody: CONSUMER })
    await home.seedState({
      denials: {
        consumer: {
          plugin: 'consumer',
          reason: 'the operator said no to this proposal',
          denied_at: new Date(Date.now() - 3_600_000).toISOString(),
          note: null,
          // Computed, never hardcoded: the value the evaluator recomputes on
          // every advance is the value that has to match, and a literal hex
          // string would go stale the day the hashed object changes shape.
          // The consumer declares no side effects and has no run record, so the
          // proposal hashes the empty sets scoped by its name.
          fingerprint: denialFingerprint('consumer', [], []),
        },
      },
    })

    // CONTROL. Producer healthy, so the denial is the only guard armed. If this
    // row is not `denied`, the fingerprint does not match and the case below
    // would pass over the wrong ordering for want of a second guard.
    const control = await home.advance()
    const controlEntry = await home.entryFor(control.run_log_path, 'consumer')
    expect(controlEntry).not.toBeNull()
    expect(controlEntry!.status).toBe('denied')
    // The denied arm writes no run record, so the consumer still has no
    // `last_output` and the fingerprint that just matched still matches.
    expect(await home.persistedRun('consumer')).toBeUndefined()

    await home.setMarker()
    const r2 = await home.advance()

    expect((await home.persistedRun('prod'))?.status).toBe('failed')

    const entry = await home.entryFor(r2.run_log_path, 'consumer')
    expect(entry).not.toBeNull()
    // `skipped` and not `denied`: the denial arm is the only one in the chain
    // that files a different run-log status, so the status alone separates the
    // two orderings before the summary is even read.
    expect(entry!.status).toBe('skipped')
    expect(entry!.result_summary).toBe(DEPENDENCY_FAILED_DETAIL)
  })

  test('a dependency-failed plugin needing a grant is recorded as dependency-failed, and still does not run', async () => {
    const tripwire = join(home.root, 'CONSUMER_WAS_INVOKED')
    // A handler that records the one thing no run-log row can prove on its own:
    // that control reached the plugin. A gate that reports correctly and
    // invokes anyway would be green on every other assertion here.
    const TRIPWIRE_CONSUMER = `
import { writeFileSync } from 'node:fs'
export async function handler(manifest, args, signal, capabilities) {
  writeFileSync(${JSON.stringify(tripwire)}, 'reached')
  return {
    status: 'success',
    phases_completed: ['consumer'],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: 'consumer ran',
    artifacts_produced: [],
    schema_version: 1,
  }
}
`
    await home.writePlugin('prod', {
      outputs: { brief: {} },
      handlerBody: home.producer('failed'),
    })
    await home.writePlugin('consumer', {
      dependencies: ['prod'],
      sideEffects: ['sends_email'],
      handlerBody: TRIPWIRE_CONSUMER,
    })

    // CONTROL. Producer healthy, so the approval gate is the only guard armed.
    // No `.session-approval` file exists anywhere under the fixture root and
    // none may be added — a grant here would make the case below prove nothing.
    const control = await home.advance()
    const controlEntry = await home.entryFor(control.run_log_path, 'consumer')
    expect(controlEntry).not.toBeNull()
    expect(controlEntry!.status).toBe('skipped')
    expect(controlEntry!.result_summary).toBe(UNAPPROVED_SUMMARY)

    await home.setMarker()
    const r2 = await home.advance()

    expect((await home.persistedRun('prod'))?.status).toBe('failed')

    const entry = await home.entryFor(r2.run_log_path, 'consumer')
    expect(entry).not.toBeNull()
    expect(entry!.status).toBe('skipped')
    expect(entry!.result_summary).toBe(DEPENDENCY_FAILED_DETAIL)
    expect(entry!.result_summary).not.toBe(UNAPPROVED_SUMMARY)

    // THE OUTCOME, which the reordering must not have changed. A reason moved
    // ahead of the approval check may only ever move a plugin from due to
    // not-due; if it could admit a side-effecting plugin holding no grant, this
    // is where that would show.
    expect(await home.persistedRun('consumer')).toBeUndefined()
    expect(existsSync(tripwire)).toBe(false)
  })
})
