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
 *   1. A `skipped` result — every dispatched `[needs-llm]` handoff — was
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
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { _setHome } from '../../lib/paths.js'
import { createTwoAdvanceHome, type TwoAdvanceHome } from './helpers/two-advance-home.js'

describe('the persisted run status is the status the run reached', () => {
  let home: TwoAdvanceHome

  beforeEach(async () => {
    home = await createTwoAdvanceHome()
  })

  afterEach(async () => {
    _setHome(null)
    await home.cleanup()
  })

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

  async function consumerSaw(runLogPath: string) {
    const entry = await home.entryFor(runLogPath, 'consumer')
    return entry ? (JSON.parse(entry.result_summary) as { ran: unknown }) : null
  }

  test('a [needs-llm] handoff is recorded as skipped, not as success', async () => {
    // Produces on advance 1; hands off on advance 2 once the marker exists.
    const handoffProducer = `
import { existsSync } from 'node:fs'
export async function handler(manifest, args, signal, capabilities) {
  if (existsSync(${JSON.stringify(home.marker)})) {
    return {
      status: 'skipped',
      phases_completed: [],
      phases_failed: [],
      errors: [],
      data_freshness: {},
      summary: '[needs-llm] summarise the brief',
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
    await home.writePlugin('prod', { outputs: { brief: {} }, handlerBody: handoffProducer })
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
