/**
 * A producer's own free TEXT never reaches a consumer through the dependency
 * seam, and the guard that says so is watched catching a leak.
 *
 * The seam hands a consumer two facts about a declared dependency: what it last
 * produced, and how its last run ended. The second is a closed status enum and
 * must stay one. The free text beside it is the producer's `summary` — a field
 * every run writes, and the field both failure paths write a throw into:
 *
 *   - `executeHandler`'s catch in `invoke-plugin.ts` — a HANDLER throw, turned
 *     into a failed `SkillResult` whose `summary` AND whose `errors[0].message`
 *     both carry the thrown message.
 *   - the `catch` around `invokePlugin` in `runAdvance` — `invokePlugin` ITSELF
 *     throwing, which builds `invocation threw: <message>`.
 *
 * Neither is exercised below, and neither needs to be. Both land in `summary`,
 * so `summary` is the field under test, and a producer that SUCCEEDS with a
 * sentinel in its summary reaches it without arming anything else.
 *
 * That is not cosmetic. Under the `dependency_failed` gate a consumer whose
 * declared dependency last FAILED is never invoked at all — so an arm built on a
 * failing producer proves a property of the gate's own summary string and never
 * crosses the seam it is named for. The gate's string has its own guard:
 * `dependency-failed.test.ts` asserts it as an exact sentence, and an exact
 * assertion fails on anything appended. This file's job is the seam, and the
 * only way to keep it is a producer the gate does not fire on.
 *
 * Two arms, one file, the shape `no-dependency-path-fallback.test.ts` uses:
 *
 *   ARM 1, end to end. A real two-advance home. The producer succeeds on
 *   advance 2 carrying an operator-path-shaped sentinel in its summary and
 *   producing nothing, and a declared consumer — invoked, because the gate has
 *   no reason to hold it — serialises everything the seam handed it into its own
 *   run-log row. The sentinel is asserted PRESENT in the producer's row FIRST,
 *   then ABSENT from the consumer's. Presence first is the whole point: absence
 *   alone is green when the value never resolved at all, which is the blindness
 *   that let the 0.2.0 config leak ship.
 *
 *   The positive anchor is on the consumer's side too. Its row must carry the
 *   record and the status the seam actually delivered, so a row that resolved
 *   nothing cannot satisfy the absence below by being empty.
 *
 *   ARM 2, the planted offender. One predicate, two handles: the real minted
 *   one, which must come back clean, and one minted from a planted registry
 *   whose run-status member hands back the producer's failure text, which must
 *   be NAMED. A predicate nobody has watched catch anything is the failure class
 *   this repository has logged four times.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import {
  createTwoAdvanceHome,
  type TwoAdvanceHome,
} from './helpers/two-advance-home.js'
import {
  mintContext,
  type CapabilityCaller,
  type CapabilityEntry,
  type DependencyRun,
} from '../capabilities.js'
import { PluginManifestSchema } from '../../schemas/plugin-manifest.js'

/**
 * The forbidden string, in ONE binding, on ONE unbroken line. Every use below
 * derives from this const. A literal that a formatter wraps across two lines
 * stops matching the thing it was written to match, and the assertion goes
 * green because it can no longer see — which is the failure mode this whole
 * file exists to refuse.
 *
 * Shaped like a path an operator actually configures, because that is the shape
 * the leak takes when it takes one: the message a handler throws carries
 * whatever the handler was holding.
 */
const SENTINEL = '/Users/operator/warpline-private/acct-4471/credentials.json'

// ── Arm 2's predicate ────────────────────────────────────────────────────

/** Every string reachable from `value` that carries the sentinel, by path. */
function scan(value: unknown, path: string, out: string[]): void {
  if (typeof value === 'string') {
    if (value.includes(SENTINEL)) out.push(path)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => scan(v, `${path}[${i}]`, out))
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) scan(v, `${path}.${k}`, out)
  }
}

/**
 * Calls every function member on a dependencies handle for one declared name
 * and reports where the sentinel surfaced, if anywhere.
 *
 * It walks `Object.entries` rather than naming the members, so a THIRD member
 * added later is covered without editing this file — the leak this guards
 * against is a widening, and a widening is exactly what a hand-written member
 * list would not see. A member that throws is scanned too: an error message is
 * a string a consumer receives.
 */
export function leaks(handle: object, caller: CapabilityCaller, dependencyName: string): string[] {
  const out: string[] = []
  for (const [member, value] of Object.entries(handle)) {
    if (typeof value !== 'function') {
      scan(value, member, out)
      continue
    }
    const fn = value as (c: CapabilityCaller, n: string) => unknown
    try {
      scan(fn(caller, dependencyName), member, out)
    } catch (err) {
      scan(err instanceof Error ? err.message : String(err), `${member} (threw)`, out)
    }
  }
  return out.sort()
}

describe("a producer's own text cannot reach a consumer through the seam", () => {
  let home: TwoAdvanceHome

  beforeEach(async () => {
    home = await createTwoAdvanceHome()
  })

  afterEach(async () => {
    await home.cleanup()
  })

  /**
   * A producer that SUCCEEDS on advance 2, carrying the sentinel in its summary
   * and producing nothing.
   *
   * Written here rather than taken from `home.producer`, whose `thrownMessage`
   * parameter reaches the throwing mode only. Both of that helper's failing
   * modes arm the `dependency_failed` gate, and a gated consumer is never
   * invoked — which would leave this arm asserting the gate's summary instead of
   * the seam. `success-with-nothing` is the shape, with one field changed.
   *
   * Producing nothing on advance 2 is deliberate: the consumer then reads the
   * Output advance 1 recorded, so `lastOutput` answers with a real record rather
   * than an absence the positive anchor could not tell from a leak-free empty.
   */
  const producerCarrying = (marker: string): string => `
import { existsSync } from 'node:fs'
export async function handler(manifest, args, signal, capabilities) {
  const second = existsSync(${JSON.stringify(marker)})
  return {
    status: 'success',
    phases_completed: ['prod'],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: second ? ${JSON.stringify(`prod read ${SENTINEL} and had nothing new to say`)} : 'prod produced',
    artifacts_produced: second ? [] : [{ type: 'brief', format: 'json', body: '{"advance":1}' }],
    schema_version: 1,
  }
}
`

  /**
   * Serialises EVERYTHING it was handed for `prod` — the record and the run
   * status, both, in full. Anything the seam leaks therefore lands in this
   * plugin's own persisted `result_summary`, where the assertion reads it.
   */
  const consumer = `
export async function handler(manifest, args, signal, capabilities) {
  return {
    status: 'success',
    phases_completed: ['consumer'],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: JSON.stringify({
      record: capabilities.dependencies.lastOutput(capabilities.caller, 'prod'),
      run: capabilities.dependencies.lastRun(capabilities.caller, 'prod'),
    }),
    artifacts_produced: [],
    schema_version: 1,
  }
}
`

  test('the sentinel is in the producer log and in nothing the consumer received', async () => {
    await home.writePlugin('prod', {
      outputs: { brief: {} },
      handlerBody: producerCarrying(home.marker),
    })
    await home.writePlugin('consumer', { dependencies: ['prod'], handlerBody: consumer })

    await home.advance()
    await home.setMarker()
    const r2 = await home.advance()

    // PRESENCE, first. No count: the summary reaches the row through more than
    // one field and more than one occurrence is correct.
    const prodEntry = await home.entryFor(r2.run_log_path, 'prod')
    expect(prodEntry).not.toBeNull()
    expect(JSON.stringify(prodEntry)).toContain(SENTINEL)

    const consumerEntry = await home.entryFor(r2.run_log_path, 'consumer')
    expect(consumerEntry).not.toBeNull()
    // The consumer RAN. `completed` is the run-LOG vocabulary (`run-log.ts:26`),
    // not the `plugin_runs` one — the two enums differ and the difference is
    // easy to write past. A `skipped` here would mean the producer armed a gate
    // and this arm had stopped crossing the seam.
    expect(consumerEntry!.status).toBe('completed')

    // POSITIVE, before absence, and on BOTH members. The row carries the Output
    // advance 1 recorded and the bare status enum `lastRun` projects, so a
    // handle that resolved nothing at all cannot satisfy the absence below by
    // being empty. `"run":"success"` and not `"run":{…}`: the member returns
    // `PluginRun['status']`, one string, which is the narrowing that makes the
    // leak hard — and a widening back to the record is what arm 2 plants.
    expect(consumerEntry!.result_summary).toContain('"type":"brief"')
    expect(consumerEntry!.result_summary).toContain('"run":"success"')

    // ABSENCE. The seam read the record beside the summary the sentinel is in,
    // and delivered the two fields it is allowed to deliver; nothing of the
    // producer's own prose came along.
    expect(consumerEntry!.result_summary).not.toContain(SENTINEL)

    // And the record survived a run that produced nothing — plan 04's
    // invariant, still true and now read through the seam rather than beside it.
    expect((await home.persistedRun('prod'))?.last_output).not.toBeUndefined()
  })

  describe('the predicate that says so', () => {
    const CALLER: CapabilityCaller = { plugin: 'leak-fixture', runId: 'run-1' }
    const MANIFEST = PluginManifestSchema.parse({
      name: 'leak-fixture',
      version: '1.0.0',
      description: 'a fixture manifest, used only to mint against',
      autonomy_level: 'autonomous',
      ttl_hours: 24,
      side_effects: [],
      dependencies: ['prod'],
    })
    const PROD_RUN: DependencyRun = {
      status: 'failed',
      last_output: { type: 'brief', format: 'json', body: '{"advance":1}' },
    }
    const RUNS: Readonly<Record<string, DependencyRun | null>> = { prod: PROD_RUN }

    test('it reports clean for the real minted handle', () => {
      const handle = mintContext(
        { manifest: MANIFEST, caller: CALLER, dependencyRuns: RUNS },
        { granted: false, reason: 'manual-run' },
      ).context.dependencies
      expect(leaks(handle, CALLER, 'prod')).toEqual([])
    })

    /**
     * The mistake somebody would actually make: hand the mint the whole run
     * record and return it, so the producer's failure text rides along in a
     * field nobody looked at. Minted through `mintContext`'s registry seam —
     * the real `CAPABILITY_REGISTRY` is not edited for a test.
     */
    test('it names the offender for a handle that hands back the failure text', () => {
      const planted: Readonly<Record<string, CapabilityEntry>> = {
        dependencies: {
          effect: null,
          description: 'a planted widening of the real entry',
          mint: () => ({
            lastOutput: () => PROD_RUN.last_output,
            lastRun: () => ({
              status: 'failed',
              summary: `prod handler threw: ${SENTINEL}`,
            }),
          }),
        },
      }
      const handle = mintContext(
        { manifest: MANIFEST, caller: CALLER, dependencyRuns: RUNS },
        { granted: false, reason: 'manual-run' },
        planted,
      ).context.dependencies
      expect(leaks(handle, CALLER, 'prod')).toEqual(['lastRun.summary'])
    })
  })
})
