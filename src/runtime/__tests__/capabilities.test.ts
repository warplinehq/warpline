/**
 * A capability cannot be registered without declaring its effect, and a plugin
 * that did not declare that effect never receives the member performing it.
 *
 * The registry is the iteration source. Never a hand-written list of member
 * names: a hand list reports "clean" when it means "did not look", and the two
 * are indistinguishable from the outside — the one property a guard must not
 * have. `no-orphan-schema-fields.test.ts` says the same thing in its own words
 * about `git ls-files`. Iterating the registry is what makes a member added
 * without an effect fail BY OMISSION rather than by a list mismatch.
 *
 * Effect values are checked against `SideEffectType.options` — the live enum,
 * read rather than copied — so the table cannot drift from the closed five.
 *
 * Same helper, two roots, in the shape `manifests.test.ts` already ships: the
 * real registry must return no offenders, and a deliberately broken fixture
 * registry must return exactly the two it was broken with. The second half is
 * what stops the first from being a vacuous pass — the production registry is
 * empty today, so on its own it would report clean forever.
 */
import { describe, expect, test } from 'bun:test'
import {
  CAPABILITY_EFFECTS,
  CAPABILITY_REGISTRY,
  mintContext,
  type CapabilityEntry,
  type CapabilityGrantWitness,
} from '../capabilities.js'
import { PluginManifestSchema, SideEffectType } from '../../schemas/plugin-manifest.js'
import type { PluginManifest } from '../../schemas/plugin-manifest.js'

/** A real manifest, parsed by the live schema so every default is the real one. */
function manifestDeclaring(sideEffects: SideEffectType[]): PluginManifest {
  return PluginManifestSchema.parse({
    name: 'fixture-plugin',
    version: '1.0.0',
    description: 'a fixture manifest, used only to mint against',
    autonomy_level: 'autonomous',
    ttl_hours: 24,
    side_effects: sideEffects,
  })
}

const GRANTED: CapabilityGrantWitness = { granted: true, scope: 'fixture-plugin' }
const NOT_GRANTED: CapabilityGrantWitness = { granted: false, reason: 'manual-run' }

/**
 * The members production does not have yet, two sound and two broken.
 *
 * `noEffectDeclared` is built through a cast on purpose. Without it TypeScript
 * refuses the object literal outright — which is the FIRST of the two refusals
 * and is demonstrated separately — and the runtime assertion below would never
 * get to run. Do not delete the cast as sloppy: it is what lets the second
 * refusal be observed at all.
 *
 * `bogusEffect` carries a string outside the closed enum, which is the drift
 * the effects assertion exists to catch.
 */
const FIXTURE_REGISTRY: Readonly<Record<string, CapabilityEntry>> = {
  callExternalApi: {
    effect: 'external_api',
    description: 'fixture member standing in for an outbound call',
    mint: () => 'external-api-member',
  },
  readClock: {
    effect: null,
    description: 'fixture member performing no declared effect',
    mint: () => 'clock-member',
  },
  bogusEffect: {
    effect: 'sends_smoke_signals' as SideEffectType,
    description: 'fixture member whose effect is not in the enum',
    mint: () => 'bogus-member',
  },
  noEffectDeclared: {
    description: 'fixture member registered without an effect at all',
    mint: () => 'undeclared-member',
  } as unknown as CapabilityEntry,
}

/**
 * Offenders as `name: reason` strings, so a failure names the member it found
 * rather than reporting a count. Two independent checks: the key is absent
 * (omission), or the value is not `null` and not in the live enum (drift).
 */
function effectOffenders(registry: Readonly<Record<string, CapabilityEntry>>): string[] {
  return Object.keys(registry).flatMap((name) => {
    const entry = registry[name] as CapabilityEntry | undefined
    if (entry === undefined || !('effect' in entry)) {
      return [`${name}: no effect declared`]
    }
    const effect: unknown = entry.effect
    if (effect === null) return []
    if (typeof effect !== 'string' || !(SideEffectType.options as string[]).includes(effect)) {
      return [`${name}: effect ${JSON.stringify(effect)} is not a member of SideEffectType`]
    }
    return []
  })
}

describe('every registered capability declares an effect from the closed enum', () => {
  test('the real registry has no offender', () => {
    expect(effectOffenders(CAPABILITY_REGISTRY)).toEqual([])
  })

  /**
   * The registry is empty of production members today, so the assertion above
   * passes without looking at anything. This is what makes it non-vacuous: the
   * identical helper, pointed at a registry broken in the two ways that matter,
   * must name both — by name, not by count.
   */
  test('the same helper names both broken fixture members', () => {
    expect(effectOffenders(FIXTURE_REGISTRY).sort()).toEqual([
      'bogusEffect: effect "sends_smoke_signals" is not a member of SideEffectType',
      'noEffectDeclared: no effect declared',
    ])
  })

  test('every member in the registry has a key in the effects projection', () => {
    const missing = Object.keys(CAPABILITY_REGISTRY).filter((name) => !(name in CAPABILITY_EFFECTS))
    expect(missing).toEqual([])
  })

  test('the projection carries exactly what the registry declared', () => {
    const disagreeing = Object.keys(CAPABILITY_REGISTRY).filter(
      (name) => CAPABILITY_EFFECTS[name] !== CAPABILITY_REGISTRY[name]?.effect,
    )
    expect(disagreeing).toEqual([])
  })
})

describe('the declaration is what mints', () => {
  test('a manifest that declared nothing does not receive the effect-carrying member', () => {
    const minted = mintContext({ manifest: manifestDeclaring([]) }, NOT_GRANTED, FIXTURE_REGISTRY)
    expect('callExternalApi' in minted.context).toBe(false)
  })

  test('a manifest that declared it, on a granted run, does receive it', () => {
    const minted = mintContext(
      { manifest: manifestDeclaring(['external_api']) },
      GRANTED,
      FIXTURE_REGISTRY,
    )
    expect(minted.context['callExternalApi']).toBe('external-api-member')
  })

  test('the refusal names the missing entry and the manifest field to add it to', () => {
    const minted = mintContext({ manifest: manifestDeclaring([]) }, NOT_GRANTED, FIXTURE_REGISTRY)
    const refusal = minted.withheld.find((w) => w.member === 'callExternalApi')?.reason ?? ''
    expect(refusal).toContain('external_api')
    expect(refusal).toContain('side_effects')
  })

  test('an ungated member is minted for a manifest declaring no side effects at all', () => {
    const minted = mintContext({ manifest: manifestDeclaring([]) }, NOT_GRANTED, FIXTURE_REGISTRY)
    expect(minted.context['readClock']).toBe('clock-member')
  })

  /**
   * The declaration is necessary and not sufficient. A plugin that declared the
   * effect still gets nothing when the caller's witness says the Grant was not
   * read, or was read and refused.
   */
  test('a declared effect on an ungranted run is still withheld', () => {
    const minted = mintContext(
      { manifest: manifestDeclaring(['external_api']) },
      NOT_GRANTED,
      FIXTURE_REGISTRY,
    )
    expect('callExternalApi' in minted.context).toBe(false)
    expect(minted.withheld.map((w) => w.member)).toContain('callExternalApi')
  })

  /**
   * Exact string equality, both directions. A comparison that lowercased or
   * trimmed would rescue a registry that has drifted from the closed enum, and
   * rescuing it silently is how the drift survives.
   */
  test('the effect comparison is exact — a differently-cased declaration is not a match', () => {
    const shouted = manifestDeclaring([])
    const minted = mintContext(
      { manifest: { ...shouted, side_effects: ['EXTERNAL_API' as SideEffectType] } },
      GRANTED,
      FIXTURE_REGISTRY,
    )
    expect('callExternalApi' in minted.context).toBe(false)
  })

  test('the refusal never carries a value read from the manifest', () => {
    const withSecret = manifestDeclaring([])
    const minted = mintContext(
      { manifest: { ...withSecret, description: 'token=hunter2' } },
      NOT_GRANTED,
      FIXTURE_REGISTRY,
    )
    expect(minted.withheld.map((w) => w.reason).join('\n')).not.toContain('hunter2')
  })
})
