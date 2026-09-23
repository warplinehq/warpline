/**
 * `plugin_runs[name].status` says how the run actually ended, and `lastRun`
 * therefore does too.
 *
 * Both arms here are the same defect seen from two sides: the engine wrote a
 * status it had narrowed, and a consumer reading `lastRun` was told something
 * the run did not do. Until 13.1-05 that lossiness was internal — nothing
 * outside the engine read the field. `lastRun` published it, and both specs
 * describe a vocabulary the writer could not produce.
 *
 *   1. A `skipped` result — every dispatched declared handoff — was
 *      folded to `'success'` by the autonomous write's `else` arm.
 *      `PluginRunSchema` has always admitted `'skipped'`; only the mapping
 *      refused to emit it. A consumer following the shipped four-state table
 *      read "produced, and its latest run is healthy" for a producer that
 *      handed its work to an LLM and produced nothing.
 *
 *   2. When `invokePlugin` ITSELF throws, the engine's catch pushed a
 *      `plugin_entries` row and returned before any `plugin_runs` write, so
 *      `lastRun` kept answering with the PREVIOUS run's status. Note this is
 *      not a handler that throws: that is caught inside `invokePlugin` and
 *      comes back as a `failed` result, which the normal write handles. The
 *      reachable case is `loadPluginConfig` rethrowing a non-`PluginConfigError`
 *      (`invoke-plugin.ts:378`) — here a config path that is a directory, so
 *      `readFile` raises EISDIR rather than ENOENT.
 *
 * Arm 2 no longer reads the status through a consumer, because it cannot: the
 * `dependency_failed` gate means a plugin whose declared dependency's last run
 * failed is never invoked. It reads the gate instead, and the substitution is
 * an upgrade rather than a concession. The gate fires on `plugin_runs[prod]
 * .status === 'failed'` and on nothing else, so if the catch had skipped its
 * write the record would still hold advance 1's `success`, the consumer would
 * run, and the assertion would fail — the same defect caught through a
 * shorter chain.
 *
 * Arm 1 is untouched, and it doubles as a negative case for that gate: a
 * `[needs-llm]` handoff records `skipped`, which does not arm it, so the
 * consumer runs and reads the status exactly as before.
 *
 * A handoff counts as dispatched only from a plugin whose manifest declares
 * `llm_handoff: true`. The undeclared cases below are the other side of that:
 * the runtime refuses the handoff, so the run is recorded `failed`, it
 * publishes no Output, and the gate stops the consumer.
 *
 * The supervised cases at the end hold the same under supervision, in both
 * homes: the default `review_gate: true` and a manifest declaring
 * `autonomy_level: 'supervised'`. A failed result, the refusal included, is
 * recorded `failed` and is not parked, so nobody is asked to approve a run
 * that did nothing. Each case first checks that supervision engaged at all,
 * because without it every other assertion would pass for the wrong reason.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { _setHome } from '../../lib/paths.js'
import { createTwoAdvanceHome, type TwoAdvanceHome } from './helpers/two-advance-home.js'
import { advanceExitCode } from '../exit-codes.js'

/** Reads `lastRun` and serialises it, so the assertion can be on what the CONSUMER saw. */
const consumer = `
export async function handler(manifest, args, signal, capabilities) {
  return {
    status: 'success',
    phases_completed: ['consumer'],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: JSON.stringify({ ran: capabilities.dependencies.lastRun(capabilities.caller, 'prod') }),
    artifacts_produced: [],
    schema_version: 1,
  }
}
`

/**
 * Produces on advance 1; hands off on advance 2 once the marker exists.
 * `prefix` is the older summary-prefix arm, `field` the structured one.
 */
function handoffProducer(arm: 'prefix' | 'field', marker: string): string {
  const handoff =
    arm === 'prefix'
      ? `summary: '[needs-llm] summarise the brief',`
      : `summary: 'summarise the brief',
      needs_llm: { task: 'Summarise the brief', context_path: 'state/brief.json' },`
  return `
import { existsSync } from 'node:fs'
export async function handler(manifest, args, signal, capabilities) {
  if (existsSync(${JSON.stringify(marker)})) {
    return {
      status: 'skipped',
      phases_completed: [],
      phases_failed: [],
      errors: [],
      data_freshness: {},
      ${handoff}
      artifacts_produced: [],
      schema_version: 1,
    }
  }
  return {
    status: 'success',
    phases_completed: ['prod'],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: 'prod produced',
    artifacts_produced: [{ type: 'brief', format: 'json', body: '{"advance":1}' }],
    schema_version: 1,
  }
}
`
}

/** Produces on advance 1; returns `partial` on advance 2 once the marker exists. */
function partialProducer(marker: string): string {
  return `
import { existsSync } from 'node:fs'
export async function handler(manifest, args, signal, capabilities) {
  if (existsSync(${JSON.stringify(marker)})) {
    return {
      status: 'partial',
      phases_completed: ['prod'],
      phases_failed: ['enrich'],
      errors: [],
      data_freshness: {},
      summary: 'prod returned partial',
      artifacts_produced: [],
      schema_version: 1,
    }
  }
  return {
    status: 'success',
    phases_completed: ['prod'],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: 'prod produced',
    artifacts_produced: [{ type: 'brief', format: 'json', body: '{"advance":1}' }],
    schema_version: 1,
  }
}
`
}

describe('the persisted run status is the status the run reached', () => {
  let home: TwoAdvanceHome

  beforeEach(async () => {
    home = await createTwoAdvanceHome()
  })

  afterEach(async () => {
    _setHome(null)
    await home.cleanup()
  })

  async function consumerSaw(runLogPath: string) {
    const entry = await home.entryFor(runLogPath, 'consumer')
    return entry ? (JSON.parse(entry.result_summary) as { ran: unknown }) : null
  }

  test('a [needs-llm] handoff is recorded as skipped, not as success', async () => {
    await home.writePlugin('prod', {
      outputs: { brief: {} },
      llmHandoff: true,
      handlerBody: handoffProducer('prefix', home.marker),
    })
    await home.writePlugin('consumer', { dependencies: ['prod'], handlerBody: consumer })

    await home.advance()
    await home.setMarker()
    const r2 = await home.advance()

    const entry = (await home.persistedRun('prod')) as Record<string, unknown>
    expect(entry.status).toBe('skipped')
    // And the consumer is told the same thing the state file holds — one fact,
    // not two that can drift.
    expect((await consumerSaw(r2.run_log_path))!.ran).toBe('skipped')
    // The handoff produced nothing, so advance 1's record carries forward. This
    // is what makes the old behaviour a false claim rather than merely a vague
    // one: 'success' beside a carried record reads as "produced, and healthy".
    expect(entry.last_output).toMatchObject({ type: 'brief', body: '{"advance":1}' })
  })

  for (const arm of ['field', 'prefix'] as const) {
    test(`an undeclared ${arm} handoff is recorded as failed, and the prior output carries forward`, async () => {
      // No `llmHandoff`: the manifest says nothing, which is undeclared.
      await home.writePlugin('prod', { outputs: { brief: {} }, handlerBody: handoffProducer(arm, home.marker) })
      await home.writePlugin('consumer', { dependencies: ['prod'], handlerBody: consumer })

      await home.advance()
      await home.setMarker()
      const r2 = await home.advance()

      const prodEntry = await home.entryFor(r2.run_log_path, 'prod')
      expect(prodEntry).not.toBeNull()
      expect(prodEntry!.status).toBe('failed')
      expect(prodEntry!.result_summary).toBe('prod: undeclared handoff')

      const entry = (await home.persistedRun('prod')) as Record<string, unknown>
      expect(entry.status).toBe('failed')
      // The refusal publishes no Output, so advance 1's record carries forward.
      expect(entry.last_output).toMatchObject({ type: 'brief', body: '{"advance":1}' })

      const events = (await readFile(home.eventsPath, 'utf-8'))
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as { type: string; source: string; run_id: string | null; summary: string })
        .filter((e) => e.source === 'prod' && e.run_id === r2.run_id)
      const errors = events.filter((e) => e.type === 'error')
      expect(errors).toHaveLength(1)
      expect(errors[0]!.summary).toBe('prod: prod: undeclared handoff')
      expect(
        events.filter((e) => e.type === 'plugin_result').map((e) => e.summary),
      ).toEqual(['prod: started'])

      // A refused run is a failed run, so the dependency gate stops the consumer.
      const consumerEntry = await home.entryFor(r2.run_log_path, 'consumer')
      expect(consumerEntry).not.toBeNull()
      expect(consumerEntry!.status).toBe('skipped')
    })
  }

  test('a run whose invocation threw records that run, not the one before it', async () => {
    await home.writePlugin('prod', {
      outputs: { brief: {} },
      handlerBody: home.producer('success-with-nothing'),
    })
    await home.writePlugin('consumer', { dependencies: ['prod'], handlerBody: consumer })

    await home.advance()

    // `pluginConfigPath` resolves through `warplineHome()`, so point it at the
    // fixture and make prod's config path a DIRECTORY: `readFile` raises
    // EISDIR, which is not ENOENT, so `loadPluginConfig` rethrows it raw and
    // `invokePlugin` throws out of the engine's try.
    _setHome(home.root)
    await mkdir(join(home.root, 'config', 'prod.json'), { recursive: true })

    const r2 = await home.advance()

    const entry = (await home.persistedRun('prod')) as Record<string, unknown>
    expect(entry.status).toBe('failed')
    // The Output is a fact about the PLUGIN and survives a run that produced
    // none — the same carry-forward the normal write performs.
    expect(entry.last_output).toMatchObject({ type: 'brief', body: '{"advance":1}' })

    // Read through the gate, not through the consumer. The gate reads exactly
    // the field this test is about, so a catch that skipped its write leaves
    // advance 1's `success` in place, the consumer runs, and this fails.
    const consumerEntry = await home.entryFor(r2.run_log_path, 'consumer')
    expect(consumerEntry).not.toBeNull()
    expect(consumerEntry!.status).toBe('skipped')
    expect(consumerEntry!.result_summary).toContain("'prod'")
  })
})

for (const supervision of ['review_gate', 'supervised'] as const) {
  describe(`under supervision (${supervision}), a failed result is recorded failed and never parked`, () => {
    let home: TwoAdvanceHome
    const autonomyLevel = supervision === 'supervised' ? 'supervised' : 'autonomous'

    beforeEach(async () => {
      // The review_gate home writes `<root>/state/preferences.json`, the file
      // `runAdvance` reads when it is given a `stateDir`.
      home = await createTwoAdvanceHome(
        supervision === 'review_gate' ? { preferences: { review_gate: true } } : {},
      )
    })

    afterEach(async () => {
      _setHome(null)
      await home.cleanup()
    })

    for (const arm of ['field', 'prefix', 'returned'] as const) {
      test(`[${supervision}] a ${arm === 'returned' ? 'returned failed result' : `refused ${arm} handoff`} is recorded failed, not gated`, async () => {
        await home.writePlugin('prod', {
          outputs: { brief: {} },
          autonomyLevel,
          handlerBody: arm === 'returned' ? home.producer('failed') : handoffProducer(arm, home.marker),
        })
        await home.writePlugin('consumer', { dependencies: ['prod'], handlerBody: consumer })

        const r1 = await home.advance()
        // CONTROL: supervision engaged, so advance 1's success was parked.
        // Without it every assertion below could pass for the wrong reason: an
        // autonomous plugin already records a failed result as failed.
        expect(r1.gated_plugins).toEqual(['prod'])

        await home.setMarker()
        const r2 = await home.advance()

        const summary = arm === 'returned' ? 'prod returned failed' : 'prod: undeclared handoff'
        const prodEntry = await home.entryFor(r2.run_log_path, 'prod')
        expect(prodEntry).not.toBeNull()
        expect(prodEntry!.status).toBe('failed')
        expect(prodEntry!.result_summary).toBe(summary)

        const entry = (await home.persistedRun('prod')) as Record<string, unknown>
        expect(entry.status).toBe('failed')
        expect(entry.last_output).toMatchObject({ type: 'brief', body: '{"advance":1}' })

        expect(r2.gated_plugins).toEqual([])
        const state = JSON.parse(await readFile(home.statePath, 'utf-8')) as {
          pending_gates: { run_id: string }[]
          plugin_runs: Record<string, { status: string }>
        }
        // Nothing parked BY this run. Advance 1's gate may still be live.
        expect(state.pending_gates.filter((g) => g.run_id === r2.run_id)).toEqual([])

        const events = (await readFile(home.eventsPath, 'utf-8'))
          .split('\n')
          .filter((line) => line.trim() !== '')
          .map((line) => JSON.parse(line) as { type: string; source: string; run_id: string | null; summary: string })
          .filter((e) => e.source === 'prod' && e.run_id === r2.run_id)
        expect(events.filter((e) => e.type === 'error').map((e) => e.summary)).toEqual([`prod: ${summary}`])
        expect(events.filter((e) => e.type === 'plugin_result').map((e) => e.summary)).toEqual(['prod: started'])

        expect(advanceExitCode(r2)).toBe(1)
        const deadMan = JSON.parse(await readFile(join(dirname(home.statePath), 'last-successful-advance'), 'utf-8'))
        expect(deadMan).toMatchObject({ gated: 0, failed: 1 })

        const consumerEntry = await home.entryFor(r2.run_log_path, 'consumer')
        expect(consumerEntry).not.toBeNull()
        expect(consumerEntry!.status).toBe('skipped')

        // Negative guarantee, not a red-first guard: neither the run log nor
        // plugin_runs has a `delegated` member, so this cannot fail today.
        const log = JSON.parse(await readFile(r2.run_log_path, 'utf-8')) as { plugin_entries: { status: string }[] }
        expect(log.plugin_entries.map((e) => e.status)).not.toContain('delegated')
        expect(Object.values(state.plugin_runs).map((r) => r.status)).not.toContain('delegated')
      })
    }

    // The other side of the same condition. Only a failed result skips the
    // park: a declared handoff (`skipped`) and a `partial` result are parked
    // exactly as a success is.
    for (const kind of ['skipped', 'partial'] as const) {
      test(`[${supervision}] a ${kind === 'skipped' ? 'declared handoff (skipped)' : 'partial result'} is still parked`, async () => {
        await home.writePlugin('prod', {
          outputs: { brief: {} },
          autonomyLevel,
          llmHandoff: kind === 'skipped',
          handlerBody: kind === 'skipped' ? handoffProducer('prefix', home.marker) : partialProducer(home.marker),
        })

        const r1 = await home.advance()
        // CONTROL: supervision engaged, so advance 1's success was parked.
        expect(r1.gated_plugins).toEqual(['prod'])

        await home.setMarker()
        const r2 = await home.advance()

        // Asserted first, so a result that stopped parking fails here, on the
        // status it was recorded with instead.
        expect(((await home.persistedRun('prod')) as Record<string, unknown>).status).toBe('gated')
        expect(r2.gated_plugins).toEqual(['prod'])
        const state = JSON.parse(await readFile(home.statePath, 'utf-8')) as {
          pending_gates: { run_id: string; plugin_result: { status: string } }[]
        }
        expect(state.pending_gates.filter((g) => g.run_id === r2.run_id).map((g) => g.plugin_result.status)).toEqual([kind])
      })
    }
  })
}

describe('a supervised dry run', () => {
  let home: TwoAdvanceHome

  beforeEach(async () => {
    home = await createTwoAdvanceHome()
  })

  afterEach(async () => {
    _setHome(null)
    await home.cleanup()
  })

  test('a supervised dry run that succeeds reports it would pause', async () => {
    // CONTROL: the same fixture as the case below, without the marker, so the
    // handler succeeds. It proves this fixture reaches the supervised dry-run
    // arm, which a plugin declaring a side effect never does.
    await home.writePlugin('prod', { outputs: { brief: {} }, autonomyLevel: 'supervised', handlerBody: home.producer('failed') })
    const r = await home.advance(undefined, { dryRun: true })
    const prodEntry = await home.entryFor(r.run_log_path, 'prod')
    expect(prodEntry).not.toBeNull()
    expect(prodEntry!.status).toBe('completed')
    expect(prodEntry!.result_summary).toBe('[dry-run] would pause here: prod produced')
    expect(await home.persistedRun('prod')).toBeUndefined()
  })

  test('a supervised dry run that fails is recorded failed, not reported as a pause', async () => {
    await home.writePlugin('prod', { outputs: { brief: {} }, autonomyLevel: 'supervised', handlerBody: home.producer('failed') })
    await home.setMarker()
    const r = await home.advance(undefined, { dryRun: true })
    const prodEntry = await home.entryFor(r.run_log_path, 'prod')
    expect(prodEntry).not.toBeNull()
    expect(prodEntry!.status).toBe('failed')
    expect(prodEntry!.result_summary).toBe('prod returned failed')
    expect(((await home.persistedRun('prod')) as Record<string, unknown>).status).toBe('failed')
  })
})
