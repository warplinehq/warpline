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
 * Each arm asserts twice: that the CONSUMER still reads advance 1's record, and
 * that the persisted entry carries advance 2's real terminal status alongside
 * it. Preserving the Output by refusing to write the run's status would satisfy
 * the first assertion and falsify the run.
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
   * Two advances in one home. Returns what the consumer saw each time, plus the
   * producer's persisted entry after advance 2.
   */
  async function runArm(mode: ProducerMode) {
    await home.writePlugin('prod', { outputs: { brief: {} }, handlerBody: home.producer(mode) })
    await home.writePlugin('consumer', { dependencies: ['prod'], handlerBody: consumer })

    const r1 = await home.advance()
    const s1 = await consumerSaw(r1.run_log_path)

    await home.setMarker()

    const r2 = await home.advance()
    const s2 = await consumerSaw(r2.run_log_path)
    return { s1, s2, entry: (await home.persistedRun('prod')) as Record<string, unknown> }
  }

  test('the record survives a producer that threw', async () => {
    const { s1, s2, entry } = await runArm('throw')
    expect(s1!.seen).not.toBeNull()
    expect(s2!.seen).toEqual(s1!.seen)
    // The run is reported as it actually ended. Preserving the Output by
    // declining to write the status would pass the assertion above and lie.
    expect(entry.status).toBe('failed')
    expect(entry.last_output).toEqual(s1!.seen)
  })

  test('the record survives a producer that returned failed', async () => {
    const { s1, s2, entry } = await runArm('failed')
    expect(s1!.seen).not.toBeNull()
    expect(s2!.seen).toEqual(s1!.seen)
    expect(entry.status).toBe('failed')
    expect(entry.last_output).toEqual(s1!.seen)
  })

  test('the record survives a producer that succeeded and produced nothing', async () => {
    const { s1, s2, entry } = await runArm('success-with-nothing')
    expect(s1!.seen).not.toBeNull()
    expect(s2!.seen).toEqual(s1!.seen)
    // The discriminator. A fix keyed on `status === 'failed'` passes the other
    // two arms and fails here, which is the whole reason this arm exists.
    expect(entry.status).toBe('success')
    expect(entry.last_output).toEqual(s1!.seen)
  })
})
