/**
 * A producer's failure TEXT never reaches a consumer through the dependency
 * seam, and the guard that says so is watched catching a leak.
 *
 * The seam hands a consumer two facts about a declared dependency: what it last
 * produced, and how its last run ended. The second is a closed status enum and
 * must stay one. The free text it must never carry is built in two places from
 * whatever a handler threw:
 *
 *   - `executeHandler`'s catch in `invoke-plugin.ts` — a HANDLER throw. It is
 *     caught there and turned into a failed `SkillResult` whose `summary` AND whose
 *     `errors[0].message` both carry the thrown message. This is the arm a
 *     producer that throws actually reaches, and it is the arm arm 1 exercises.
 *   - the `catch` around `invokePlugin` in `runAdvance` — `invokePlugin` ITSELF
 *     throwing, which builds `invocation threw: <message>`. Named so the
 *     sentence above is not read as covering it. This file does not exercise
 *     that arm.
 *
 * Two arms, one file, the shape `no-dependency-path-fallback.test.ts` uses:
 *
 *   ARM 1, end to end. A real two-advance home. The producer throws an
 *   operator-path-shaped sentinel on advance 2, and a declared consumer is
 *   watched for it. The sentinel is asserted PRESENT in the producer's own
 *   run-log entry FIRST, then ABSENT from the consumer's. Presence first is the
 *   whole point: absence alone is green when the value never resolved at all,
 *   which is the blindness that let the 0.2.0 config leak ship.
 *
 *   What the consumer's row is has changed, and the arm is stronger for it.
 *   The `dependency_failed` gate means a plugin whose declared dependency's last
 *   run failed is never invoked, so the consumer's row is now the GATE's row —
 *   a `skipped` status and the gate's own summary. That summary is the newest
 *   operator-visible string in this runtime and it is built one field away from
 *   the thrown text: the gate reads `plugin_runs[prod]`, and the record whose
 *   `status` it reads sits beside the `summary` and `errors[0].message` that
 *   carry the throw. An interpolation slip there publishes the sentinel into
 *   every run log. So the absence assertion still has a real subject, and now
 *   guards the string most likely to leak next.
 *
 *   The positive anchor moves with it: the row must NAME `prod`, so a row that
 *   resolved nothing at all cannot pass by carrying nothing. It is asserted as a
 *   substring and never as the exact sentence — `dependency-failed.test.ts`
 *   pins that wording, and pinning it twice makes one of the two the copy that
 *   goes stale. What the seam DELIVERS under an advance is proved by
 *   `plugin-run-status-honesty.test.ts` arm 1 and by
 *   `dependency-output-preservation.test.ts` arm 3, whose producers do not arm
 *   the gate; arm 2 below proves it at the mint.
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

describe("a producer's failure text cannot reach a consumer through the seam", () => {
  let home: TwoAdvanceHome

  beforeEach(async () => {
    home = await createTwoAdvanceHome()
  })

  afterEach(async () => {
    await home.cleanup()
  })

  /**
   * Serialises EVERYTHING it was handed for `prod` — the record and the run
   * status, both, in full. Anything the seam leaks therefore lands in this
   * plugin's own persisted `result_summary`, where the assertion reads it.
   *
   * It is kept, unrun, on purpose. Under the gate this handler is never
   * invoked, and a fixture written to serialise the whole seam is the thing
   * that would catch a leak the day the gate is narrowed or removed. Deleting
   * it would leave nothing to re-point.
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
      handlerBody: home.producer('throw', SENTINEL),
    })
    await home.writePlugin('consumer', { dependencies: ['prod'], handlerBody: consumer })

    await home.advance()
    await home.setMarker()
    const r2 = await home.advance()

    // PRESENCE, first. On the sentinel itself and never on a catch arm's
    // prefix — the prefix belongs to whichever arm ran and is not under test.
    // No count either: the message reaches the record through more than one
    // field, and more than one occurrence is correct.
    const prodEntry = await home.entryFor(r2.run_log_path, 'prod')
    expect(prodEntry).not.toBeNull()
    expect(JSON.stringify(prodEntry)).toContain(SENTINEL)

    const consumerEntry = await home.entryFor(r2.run_log_path, 'consumer')
    expect(consumerEntry).not.toBeNull()
    // The consumer never ran: its declared dependency's last run failed, so the
    // gate filed it `skipped` and this row is the gate's own. `skipped` is the
    // run-LOG vocabulary (`run-log.ts:26`), not the `plugin_runs` one — the two
    // enums differ and the difference is easy to write past.
    expect(consumerEntry!.status).toBe('skipped')

    // POSITIVE, before absence. The row resolved the producer's NAME, so a row
    // that resolved nothing at all cannot satisfy the absence below by being
    // empty. A substring and not the exact sentence: `dependency-failed.test.ts`
    // owns that wording.
    expect(consumerEntry!.result_summary).toContain("'prod'")

    // ABSENCE. The gate read the record the throw is stored in and published a
    // sentence about it; nothing of the throw came along.
    expect(consumerEntry!.result_summary).not.toContain(SENTINEL)

    // And the record survived the failed run — plan 04's invariant, still true
    // and still where a consumer would read it from if it ran.
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
