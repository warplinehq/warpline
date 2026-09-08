/**
 * A consumer keeps reading its declared dependency's last Output across a run
 * of that dependency which produced none.
 *
 * The two-advance mechanism — one home, a marker file deciding what the
 * producer does on the second advance — now lives in
 * `helpers/two-advance-home.ts`, because `dependency-run-status-leak.test.ts`
 * drives the same shape for a different invariant. What the harness does and
 * why it cannot be a rewritten `handler.ts` is documented there.
 *
 *   Advance 1: no marker  → the producer succeeds and records a `last_output`.
 *   Advance 2: marker set → the producer takes one of three behaviours.
 *
 * The three behaviours are the point. A run producing no Output is not one
 * shape: it can throw, it can return `failed`, and it can SUCCEED carrying an
 * empty `artifacts_produced`. Preservation is keyed on the run producing
 * nothing, never on how the run ended, so all three must hold — and the third
 * is what discriminates against a fix that keys off `status === 'failed'`.
 *
 * Every arm asserts that the persisted entry carries advance 2's real terminal
 * status alongside advance 1's record. Preserving the Output by refusing to
 * write the run's status would satisfy preservation and falsify the run.
 *
 * Where the two failing arms differ from the third: they can no longer read the
 * record through the CONSUMER, because the `dependency_failed` gate means a
 * plugin whose declared dependency's last run failed is never invoked. Their
 * consumer-side assertion becomes the gate's own row — the consumer is
 * `skipped`, naming `prod` — and preservation is asserted on the persisted
 * `last_output`, which is where it always lived. The third arm keeps the full
 * consumer-side read: a producer that succeeded and produced nothing does not
 * arm the gate, and this arm is exactly the discriminator against a
 * preservation fix keyed on `status === 'failed'`, so it is the one that must
 * still go all the way through the seam.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import {
  createTwoAdvanceHome,
  type ProducerMode,
  type TwoAdvanceHome,
} from './helpers/two-advance-home.js'

describe('a dependency Output survives a later run of its producer that made none', () => {
  let home: TwoAdvanceHome

  beforeEach(async () => {
    home = await createTwoAdvanceHome()
  })

  afterEach(async () => {
    await home.cleanup()
  })

  /**
   * Writes what the seam handed it into its own `result_summary`, which the run
   * log persists — so the assertion reads what the CONSUMER saw rather than
   * what the state file holds. Those are two different claims and this file
   * makes both.
   */
  const consumer = `
export async function handler(manifest, args, signal, capabilities) {
  return {
    status: 'success',
    phases_completed: ['consumer'],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: JSON.stringify({ seen: capabilities.dependencies.lastOutput(capabilities.caller, 'prod') }),
    artifacts_produced: [],
    schema_version: 1,
  }
}
`

  async function consumerSaw(runLogPath: string) {
    const entry = await home.entryFor(runLogPath, 'consumer')
    return entry ? (JSON.parse(entry.result_summary) as { seen: unknown }) : null
  }

  /**
   * Two advances in one home. Returns what the consumer saw on advance 1, its
   * raw run-log row from advance 2 — which is the gate's row when the producer
   * failed — and the producer's persisted entry after advance 2.
   */
  async function runArm(mode: ProducerMode) {
    await home.writePlugin('prod', { outputs: { brief: {} }, handlerBody: home.producer(mode) })
    await home.writePlugin('consumer', { dependencies: ['prod'], handlerBody: consumer })

    const r1 = await home.advance()
    const s1 = await consumerSaw(r1.run_log_path)

    await home.setMarker()

    const r2 = await home.advance()
    return {
      s1,
      r2,
      row2: await home.entryFor(r2.run_log_path, 'consumer'),
      entry: (await home.persistedRun('prod')) as Record<string, unknown>,
    }
  }

  /**
   * The two arms whose producer records `failed`. Preservation is asserted on
   * the persisted record; the consumer is asserted GATED, which is what makes
   * the missing consumer-side read a stated fact rather than an omission.
   */
  function expectGatedAndPreserved(
    s1: { seen: unknown } | null,
    row2: { status: string; result_summary: string } | null,
    entry: Record<string, unknown>,
  ) {
    expect(s1!.seen).not.toBeNull()
    // The run is reported as it actually ended. Preserving the Output by
    // declining to write the status would pass preservation and lie.
    expect(entry.status).toBe('failed')
    expect(entry.last_output).toEqual(s1!.seen)
    expect(row2).not.toBeNull()
    expect(row2!.status).toBe('skipped')
    expect(row2!.result_summary).toContain("'prod'")
  }

  test('the record survives a producer that threw', async () => {
    const { s1, row2, entry } = await runArm('throw')
    expectGatedAndPreserved(s1, row2, entry)
  })

  test('the record survives a producer that returned failed', async () => {
    const { s1, row2, entry } = await runArm('failed')
    expectGatedAndPreserved(s1, row2, entry)
  })

  test('the record survives a producer that succeeded and produced nothing', async () => {
    const { s1, r2, entry } = await runArm('success-with-nothing')
    // The one arm that still reads through the CONSUMER, because it is the one
    // whose producer does not arm the `dependency_failed` gate.
    const s2 = await consumerSaw(r2.run_log_path)
    expect(s1!.seen).not.toBeNull()
    expect(s2!.seen).toEqual(s1!.seen)
    // The discriminator. A fix keyed on `status === 'failed'` passes the other
    // two arms and fails here, which is the whole reason this arm exists.
    expect(entry.status).toBe('success')
    expect(entry.last_output).toEqual(s1!.seen)
  })
})
