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
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CAPABILITY_EFFECTS,
  CAPABILITY_REGISTRY,
  mintContext,
  type CapabilityCaller,
  type CapabilityEntry,
  type CapabilityGrantWitness,
  type CapabilityMintInput,
  type DependenciesHandle,
  type SecretsHandle,
} from '../capabilities.js'
import { invokePlugin } from '../invoke-plugin.js'
import { PluginManifestSchema, SideEffectType } from '../../schemas/plugin-manifest.js'
import type { PluginManifest } from '../../schemas/plugin-manifest.js'
import type { OutputRecord } from '../../schemas/skill-result.js'

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

/** The same fixture manifest, declaring a dependency graph rather than effects. */
function manifestDependingOn(dependencies: string[]): PluginManifest {
  return PluginManifestSchema.parse({
    name: 'fixture-plugin',
    version: '1.0.0',
    description: 'a fixture manifest, used only to mint against',
    autonomy_level: 'autonomous',
    ttl_hours: 24,
    side_effects: [],
    dependencies,
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

/**
 * The first registered member: a handle listing credential names.
 *
 * Two properties carry the weight here, and they pull in opposite directions.
 * It lists NAMES — the manifest declared them and the pre-flight resolved them
 * — and it exposes nothing that returns a value. A handler holds
 * `process.env` regardless, in this process, so a value getter would buy a
 * violated requirement and no containment at all. The `Object.keys` assertion
 * below is the runtime half of that; the grep for environment reads in
 * `capabilities.ts` is the other half.
 *
 * The handle is UNGATED — its registry effect is `null` — because the unit it
 * stands for is a pre-flight read of the environment, which is none of the
 * five values `side_effects` is drawn from. The consequence is the one worth
 * asserting: a run carrying no grant still receives it, so the manual CLI path
 * is unchanged by this member landing.
 */
describe('the secrets handle', () => {
  const CALLER: CapabilityCaller = { plugin: 'fixture-plugin', runId: 'run-1' }

  function handleFor(resolvedSecretNames: readonly string[], witness = NOT_GRANTED): SecretsHandle {
    const minted = mintContext(
      { manifest: manifestDeclaring([]), caller: CALLER, resolvedSecretNames },
      witness,
    )
    return minted.context.secrets
  }

  test('it lists the names the manifest declared and the pre-flight resolved', () => {
    expect(handleFor(['GITHUB_TOKEN', 'SLACK_TOKEN']).resolvedNames(CALLER)).toEqual([
      'GITHUB_TOKEN',
      'SLACK_TOKEN',
    ])
  })

  /**
   * Not an absent handle. A plugin declaring nothing gets the member and an
   * empty list, so a handler never branches on whether it was handed one.
   */
  test('a plugin declaring no credentials receives a handle listing nothing', () => {
    const minted = mintContext({ manifest: manifestDeclaring([]), caller: CALLER }, NOT_GRANTED)
    expect('secrets' in minted.context).toBe(true)
    expect(minted.context.secrets.resolvedNames(CALLER)).toEqual([])
  })

  /**
   * The whole surface, asserted as a set rather than as an absence. A test
   * that greps for the word "value" passes the day somebody calls the getter
   * something else; a test that pins the key set reddens whatever it is named.
   */
  test('the handle exposes exactly one function, and it returns names', () => {
    const handle = handleFor(['GITHUB_TOKEN'])
    expect(Object.keys(handle).sort()).toEqual(['resolvedNames'])
    expect(typeof handle.resolvedNames).toBe('function')
    expect(handle.resolvedNames(CALLER)).toEqual(['GITHUB_TOKEN'])
  })

  test('it is minted on a run carrying no grant, because it is ungated', () => {
    expect(CAPABILITY_EFFECTS['secrets']).toBeNull()
    expect(handleFor(['GITHUB_TOKEN'], NOT_GRANTED).resolvedNames(CALLER)).toEqual(['GITHUB_TOKEN'])
  })

  test('a manifest declaring no side effects at all still receives it', () => {
    const minted = mintContext(
      { manifest: manifestDeclaring([]), caller: CALLER, resolvedSecretNames: ['A'] },
      { granted: false, reason: 'no-declared-side-effects' },
    )
    expect(minted.context.secrets.resolvedNames(CALLER)).toEqual(['A'])
    expect(minted.withheld).toEqual([])
  })

  /**
   * A handler is called with `(manifest, args, signal, capabilities)` and has
   * no run id of its own. Without the caller on the context, the argument the
   * next assertion requires would be one no plugin author could honestly
   * supply — so it is carried, not reconstructed.
   */
  test('the context carries the caller it was minted for', () => {
    const minted = mintContext({ manifest: manifestDeclaring([]), caller: CALLER }, NOT_GRANTED)
    expect(minted.context.caller).toEqual(CALLER)
  })
})

/**
 * The second registered member: the Output a declared dependency last produced.
 *
 * The property that carries the weight is the one the refusal keys off. It
 * reads `manifest.dependencies` — the DECLARATION — and never the key set of
 * the record it was handed. A member that answered from what happened to be
 * delivered would erode a dependency graph into a suggestion, one convenient
 * read at a time, and nothing downstream would notice.
 *
 * It is UNGATED, like `secrets`, and for the same kind of reason: projecting a
 * value the runtime already holds is none of the five effects `side_effects`
 * is drawn from. The consequence is the one that matters at the seams: a run
 * started by hand still receives the member, and reads `null` through it.
 */
describe('the dependencies handle', () => {
  const CALLER: CapabilityCaller = { plugin: 'fixture-plugin', runId: 'run-1' }
  const REC: OutputRecord = { type: 'brief', format: 'json', body: '{"n":1}' }

  function handleFor(
    dependencies: string[],
    dependencyOutputs?: Readonly<Record<string, OutputRecord | null>>,
    witness = NOT_GRANTED,
  ): DependenciesHandle {
    const input: CapabilityMintInput = {
      manifest: manifestDependingOn(dependencies),
      caller: CALLER,
      ...(dependencyOutputs === undefined ? {} : { dependencyOutputs }),
    }
    return mintContext(input, witness).context.dependencies
  }

  test('it is registered ungated, so every plugin receives it', () => {
    expect(CAPABILITY_EFFECTS['dependencies']).toBeNull()
    const minted = mintContext(
      { manifest: manifestDependingOn(['dep-a']), caller: CALLER },
      NOT_GRANTED,
    )
    expect('dependencies' in minted.context).toBe(true)
  })

  test('a declared dependency that produced an Output reads that record', () => {
    expect(handleFor(['dep-a'], { 'dep-a': REC }).lastOutput(CALLER, 'dep-a')).toEqual(REC)
  })

  test('a declared dependency that produced none reads null', () => {
    expect(handleFor(['dep-a'], {}).lastOutput(CALLER, 'dep-a')).toBeNull()
  })

  test('an undeclared name throws, naming the plugin, the name and the manifest field', () => {
    const handle = handleFor(['dep-a'], { 'dep-a': REC })
    expect(() => handle.lastOutput(CALLER, 'dep-z')).toThrow(/fixture-plugin/)
    expect(() => handle.lastOutput(CALLER, 'dep-z')).toThrow(/dep-z/)
    expect(() => handle.lastOutput(CALLER, 'dep-z')).toThrow(/dependencies/)
  })

  /**
   * The refusal keys off the declaration, not off availability. "It happened to
   * be there" is not an argument: a record delivered under a name the manifest
   * never declared is still a read the graph does not authorise.
   */
  test('a name present in the delivered record but undeclared still throws', () => {
    const handle = handleFor(['dep-a'], { 'dep-a': REC, 'dep-z': REC })
    expect(() => handle.lastOutput(CALLER, 'dep-z')).toThrow(/dep-z/)
  })

  /**
   * The whole surface, asserted as a set. One method and no enumeration — a
   * handler cannot walk the record, so the order of `manifest.dependencies` and
   * the order of the engine's projection are unobservable and are not contract.
   */
  test('the handle exposes exactly one method and no enumeration', () => {
    const handle = handleFor(['dep-a'], { 'dep-a': REC })
    expect(Object.keys(handle).sort()).toEqual(['lastOutput'])
    expect(typeof handle.lastOutput).toBe('function')
  })

  /**
   * The manual path. `effect: null` skips both withhold arms, so the
   * member is minted on a run carrying no grant and with no record supplied.
   * Every declared name reads `null`; an undeclared one still throws.
   */
  test('on the manual path it is minted, reads null, and still refuses an undeclared name', () => {
    const handle = handleFor(['dep-a', 'dep-b'])
    expect(handle.lastOutput(CALLER, 'dep-a')).toBeNull()
    expect(handle.lastOutput(CALLER, 'dep-b')).toBeNull()
    expect(() => handle.lastOutput(CALLER, 'dep-z')).toThrow(/dep-z/)
  })
})

/**
 * One end-to-end case, because everything above mints directly.
 *
 * What this adds over the unit cases is the wiring: that `invokePlugin`'s
 * pre-flight result is what fills `resolvedSecretNames`, so the list a handler
 * reads is what actually RESOLVED rather than what a manifest merely declared.
 * The two are the same set only because the pre-flight refuses the run
 * otherwise — and that refusal is proven in `secrets.test.ts`, with a marker
 * file, rather than re-proven here.
 *
 * The credential value is a sentinel, and the assertion is that it reaches
 * neither the summary the handler built out of the handle nor the result the
 * runtime returns. A handler in this process can read `process.env` whatever
 * this member does; what is being checked is that the SANCTIONED path hands
 * over names and nothing else.
 */
describe('the handle reaches a handler through invokePlugin', () => {
  let tmpDir = ''

  afterEach(async () => {
    delete process.env['CAP_HANDLE_TOKEN']
    delete process.env['CAP_HANDLE_OTHER']
    if (tmpDir !== '') await rm(tmpDir, { recursive: true, force: true })
    tmpDir = ''
  })

  test('a four-parameter handler lists the resolved names and is handed no value', async () => {
    process.env['CAP_HANDLE_TOKEN'] = 'SENTINEL-DO-NOT-LEAK'
    process.env['CAP_HANDLE_OTHER'] = 'SENTINEL-DO-NOT-LEAK-TWO'

    tmpDir = join(tmpdir(), `warpline-cap-handle-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    const pluginDir = join(tmpDir, 'handle-fixture')
    await mkdir(pluginDir, { recursive: true })
    await writeFile(
      join(pluginDir, 'manifest.ts'),
      `export const manifest = ${JSON.stringify({
        ...manifestDeclaring([]),
        name: 'handle-fixture',
        secrets: ['CAP_HANDLE_TOKEN', 'CAP_HANDLE_OTHER'],
      })}`,
    )
    await writeFile(
      join(pluginDir, 'handler.ts'),
      `
      export async function handler(manifest, args, signal, capabilities) {
        return {
          status: 'success',
          phases_completed: ['handle-fixture'],
          phases_failed: [],
          errors: [],
          data_freshness: {},
          summary: JSON.stringify({
            names: capabilities.secrets.resolvedNames(capabilities.caller),
            surface: Object.keys(capabilities.secrets).sort(),
            plugin: capabilities.caller.plugin,
            hasRunId: typeof capabilities.caller.runId === 'string',
          }),
          artifacts_produced: [],
          schema_version: 1,
        }
      }
    `,
    )

    const invocation = await invokePlugin(
      'handle-fixture',
      {},
      { pluginsDir: tmpDir },
      { granted: false, reason: 'manual-run' },
    )

    expect(invocation.result.status).toBe('success')
    const seen = JSON.parse(invocation.result.summary) as {
      names: string[]
      surface: string[]
      plugin: string
      hasRunId: boolean
    }

    expect(seen.names).toEqual(['CAP_HANDLE_TOKEN', 'CAP_HANDLE_OTHER'])
    expect(seen.surface).toEqual(['resolvedNames'])
    expect(seen.plugin).toBe('handle-fixture')
    expect(seen.hasRunId).toBe(true)
    expect(JSON.stringify(invocation)).not.toContain('SENTINEL-DO-NOT-LEAK')
  })

  /**
   * The delivery half, and the only case that proves the runtime carries the
   * record rather than a test handing a handler a literal.
   *
   * The record enters through `invokePlugin`'s third argument, is settled into
   * the mint args, is closed over by the member, and is read by a handler that
   * never saw it written. Break any hop and every direct-mint case above stays
   * green while production reads nothing.
   */
  test('a four-parameter handler reads the record its declared dependency produced', async () => {
    tmpDir = join(
      tmpdir(),
      `warpline-cap-deps-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    )
    const pluginDir = join(tmpDir, 'deps-fixture')
    await mkdir(pluginDir, { recursive: true })
    await writeFile(
      join(pluginDir, 'manifest.ts'),
      `export const manifest = ${JSON.stringify({
        ...manifestDependingOn(['dep-a']),
        name: 'deps-fixture',
      })}`,
    )
    await writeFile(
      join(pluginDir, 'handler.ts'),
      `
      export async function handler(manifest, args, signal, capabilities) {
        let undeclared = 'no-throw'
        try {
          capabilities.dependencies.lastOutput(capabilities.caller, 'dep-z')
        } catch (error) {
          undeclared = error.message
        }
        const record = capabilities.dependencies.lastOutput(capabilities.caller, 'dep-a')
        return {
          status: 'success',
          phases_completed: ['deps-fixture'],
          phases_failed: [],
          errors: [],
          data_freshness: {},
          summary: JSON.stringify({
            type: record === null ? null : record.type,
            body: record === null ? null : JSON.parse(record.body),
            surface: Object.keys(capabilities.dependencies).sort(),
            undeclared,
          }),
          artifacts_produced: [],
          schema_version: 1,
        }
      }
    `,
    )

    const invocation = await invokePlugin(
      'deps-fixture',
      {},
      {
        pluginsDir: tmpDir,
        dependencyOutputs: { 'dep-a': { type: 'brief', format: 'json', body: '{"n":1}' } },
      },
      { granted: false, reason: 'manual-run' },
    )

    expect(invocation.result.status).toBe('success')
    const seen = JSON.parse(invocation.result.summary) as {
      type: string | null
      body: { n: number } | null
      surface: string[]
      undeclared: string
    }

    expect(seen.type).toBe('brief')
    expect(seen.body).toEqual({ n: 1 })
    expect(seen.surface).toEqual(['lastOutput'])
    expect(seen.undeclared).toContain('dep-z')
    expect(seen.undeclared).toContain('dependencies')
  })
})
