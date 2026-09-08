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
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createTwoAdvanceHome, type TwoAdvanceHome } from './helpers/two-advance-home.js'

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
