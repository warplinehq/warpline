/**
 * What the seam hands a consumer is a COPY, and a consumer that writes to it
 * does not write into the engine's state.
 *
 * The projection in `engine.ts` copies `status` by value — it is a string — and
 * used to copy `last_output` by reference, straight out of `state.plugin_runs`.
 * `capabilities.ts` then returns that same object to the handler. So the record
 * a consumer received WAS the producer's persisted record, and
 * `writeEngineState` performs no validation on the way out: a consumer that
 * normalised the record in place — `rec.body = JSON.stringify(patched)` is the
 * obvious shape — rewrote its producer's entry in `engine-state.json`.
 *
 * Two consequences, neither needing any hostile intent:
 *
 *   1. A rewritten body over the 16 KiB `OutputRecordSchema` cap makes every
 *      later fail-closed read of the single state document throw, and the
 *      engine stays bricked until someone repairs the file by hand.
 *   2. `proposalFingerprint` hashes `plugin_runs[plugin].last_output`, so the
 *      mutation moves the PRODUCER's fingerprint. A live denial against that
 *      producer then reads `superseded`, the producer becomes due again, and
 *      the side effects an operator declined re-fire.
 *
 * One advance is enough to show it: level ordering puts the producer's write
 * before the consumer's invocation, and the persist happens after both.
 *
 * The assertion is on the STATE FILE, not on what the consumer saw. The
 * consumer is supposed to be able to scribble on its own copy — that is what a
 * copy is for — so a test that asserted the handler could not mutate the object
 * would be testing the wrong invariant and would forbid a legitimate use.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createTwoAdvanceHome, type TwoAdvanceHome } from './helpers/two-advance-home.js'

describe('the Output handed across the dependency seam is a copy', () => {
  let home: TwoAdvanceHome

  beforeEach(async () => {
    home = await createTwoAdvanceHome()
  })

  afterEach(async () => {
    await home.cleanup()
  })

  /**
   * Mutates every field of the record it is handed, in place. `body` is the
   * field `proposalFingerprint` hashes and the field the size cap bounds, so it
   * is the one that carries both consequences; `type` and `format` are here
   * because a fix that copied only `body` would still leak the other two.
   */
  const mutatingConsumer = `
export async function handler(manifest, args, signal, capabilities) {
  const rec = capabilities.dependencies.lastOutput(capabilities.caller, 'prod')
  if (rec) {
    rec.body = '{"MUTATED":true}'
    rec.type = 'mutated'
    rec.format = 'text'
  }
  return {
    status: 'success',
    phases_completed: ['consumer'],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: JSON.stringify({ mutated: rec !== null }),
    artifacts_produced: [],
    schema_version: 1,
  }
}
`

  test("a consumer's writes to the record do not reach the producer's persisted entry", async () => {
    await home.writePlugin('prod', {
      outputs: { brief: {} },
      handlerBody: home.producer('success-with-nothing'),
    })
    await home.writePlugin('consumer', {
      dependencies: ['prod'],
      handlerBody: mutatingConsumer,
    })

    const r = await home.advance()

    // Non-vacuity: if the consumer never received a record there is nothing to
    // mutate, and the assertions below would pass for the wrong reason.
    const consumerEntry = await home.entryFor(r.run_log_path, 'consumer')
    expect(JSON.parse(consumerEntry!.result_summary)).toEqual({ mutated: true })

    // The three fields the consumer wrote to, named individually: the record
    // also carries `produced_at` and `run_id`, which the runtime stamps and no
    // fixture can predict.
    const prod = (await home.persistedRun('prod')) as {
      last_output: { type: string; format: string; body: string }
    }
    expect(prod.last_output.type).toBe('brief')
    expect(prod.last_output.format).toBe('json')
    expect(prod.last_output.body).toBe('{"advance":1}')
  })
})
