/**
 * A producer's failure TEXT never reaches a consumer through the dependency
 * seam, and the guard that says so is watched catching a leak.
 *
 * The seam hands a consumer two facts about a declared dependency: what it last
 * produced, and how its last run ended. The second is a closed status enum and
 * must stay one. The free text it must never carry is built in two places from
 * whatever a handler threw:
 *
 *   - `invoke-plugin.ts:771-789` — a HANDLER throw. It is caught there and
 *     turned into a failed `SkillResult` whose `summary` AND whose
 *     `errors[0].message` both carry the thrown message. This is the arm a
 *     producer that throws actually reaches, and it is the arm arm 1 exercises.
 *   - `engine.ts:1057-1071` — `invokePlugin` ITSELF throwing, which builds
 *     `invocation threw: <message>`. Named so the sentence above is not read as
 *     covering it. This file does not exercise that arm.
 *
 * Two arms, one file, the shape `no-dependency-path-fallback.test.ts` uses:
 *
 *   ARM 1, end to end. A real two-advance home. The producer throws an
 *   operator-path-shaped sentinel on advance 2; a declared consumer serialises
 *   everything the seam handed it into its own `result_summary`. The sentinel is
 *   asserted PRESENT in the producer's own run-log entry FIRST, then ABSENT from
 *   what the consumer received. Presence first is the whole point: absence alone
 *   is green when the value never resolved at all, which is the blindness that
 *   let the 0.2.0 config leak ship. A third assertion checks the status DID
 *   arrive, because a member returning `null` for everything would satisfy
 *   absence and deliver nothing.
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
} from '../capabilities.js'
import { PluginManifestSchema } from '../../schemas/plugin-manifest.js'

/**
 * The forbidden string, in ONE binding, on ONE unbroken line. Every use below
 * derives from this const — a literal split across a line wrap has already
 * failed an acceptance check in this project (Phase 07, the POS-08 sentence).
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
    // A healthy consumer reading a failed producer succeeds on its own terms.
    // Asserted before the parse below so a consumer that could not call the
    // member fails HERE, on an assertion, rather than crashing the parse.
    expect(consumerEntry!.status).toBe('success')

    // ABSENCE.
    expect(consumerEntry!.result_summary).not.toContain(SENTINEL)

    // POSITIVE. The enum did arrive: a member returning `null` for everything
    // would satisfy the absence assertion and deliver nothing.
    const seen = JSON.parse(consumerEntry!.result_summary) as {
      record: unknown
      run: string | null
    }
    expect(seen.run).toBe('failed')
    // And the record survived the failed run — plan 04's invariant, restated
    // here because it is what makes the pair of facts worth reading together.
    expect(seen.record).not.toBeNull()
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
    const RUNS = {
      prod: {
        status: 'failed' as const,
        last_output: { type: 'brief', format: 'json', body: '{"advance":1}' },
      },
    }

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
            lastOutput: () => RUNS.prod.last_output,
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
