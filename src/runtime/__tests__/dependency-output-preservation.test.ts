/**
 * A consumer keeps reading its declared dependency's last Output across a run
 * of that dependency which produced none.
 *
 * The producer's behaviour is driven by a marker FILE, not by swapping
 * `handler.ts`: `import()` caches the module, so a rewritten handler is never
 * re-read on the second advance. Every arm therefore runs two advances against
 * ONE home, with the marker written in between.
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
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTestHome, type TestHome } from './helpers/create-test-home.js'

describe('a dependency Output survives a later run of its producer that made none', () => {
  let ctx: TestHome
  let pluginsDir: string
  let stateDir: string
  let runsDir: string
  let eventsPath: string
  let statePath: string
  let marker: string

  beforeEach(async () => {
    ctx = await createTestHome()
    pluginsDir = ctx.pluginsDir
    stateDir = ctx.stateDir
    runsDir = ctx.runsDir
    // Redirected deliberately: runAdvance's eventsPath DEFAULTS to the real
    // live events.jsonl, and omitting it appends fixture events to live state.
    eventsPath = join(ctx.runsDir, 'events.jsonl')
    statePath = join(stateDir, 'engine-state.json')
    marker = join(ctx.root, 'PRODUCE_NOTHING_NOW')
  })

  afterEach(async () => {
    await ctx.cleanup()
  })

  async function writePlugin(
    name: string,
    opts: { dependencies?: string[]; outputs?: Record<string, unknown>; handlerBody: string },
  ): Promise<void> {
    const dir = join(pluginsDir, name)
    await mkdir(dir, { recursive: true })
    const manifest = {
      name,
      version: '1.0.0',
      description: `${name} preservation fixture`,
      inputs: {},
      outputs: opts.outputs ?? {},
      capabilities: [],
      schedule: 'on_run',
      autonomy_level: 'autonomous',
      side_effects: [],
      // Near-zero, so the second advance finds both plugins due again. A TTL
      // that held them fresh would make every arm pass for a reason that has
      // nothing to do with preservation.
      ttl_hours: 0.0000001,
      dependencies: opts.dependencies ?? [],
      timeout_ms: 5000,
      max_parallelism: 1,
    }
    await writeFile(join(dir, 'manifest.ts'), `export const manifest = ${JSON.stringify(manifest)}`)
    await writeFile(join(dir, 'handler.ts'), opts.handlerBody)
  }

  /** What the producer does once the marker exists. */
  type Mode = 'throw' | 'failed' | 'success-with-nothing'

  const producer = (mode: Mode) => `
import { existsSync } from 'node:fs'
export async function handler(manifest, args, signal, capabilities) {
  if (existsSync(${JSON.stringify(marker)})) {
    ${
      mode === 'throw'
        ? `throw new Error('producer blew up on advance 2')`
        : mode === 'failed'
          ? `return {
      status: 'failed',
      phases_completed: [],
      phases_failed: ['prod'],
      errors: [{ code: 'dependency_unavailable', message: 'declined', impact: 'HIGH', retryable: false }],
      data_freshness: {},
      summary: 'prod returned failed',
      artifacts_produced: [],
      schema_version: 1,
    }`
          : `return {
      status: 'success',
      phases_completed: ['prod'],
      phases_failed: [],
      errors: [],
      data_freshness: {},
      summary: 'prod succeeded and produced nothing',
      artifacts_produced: [],
      schema_version: 1,
    }`
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

  async function advance() {
    const { runAdvance } = await import('../engine.js')
    return runAdvance({ pluginsDir, stateDir: statePath, runsDir, eventsPath })
  }

  async function consumerSaw(runLogPath: string) {
    const log = JSON.parse(await readFile(runLogPath, 'utf-8'))
    const entry = log.plugin_entries.find((e: { plugin: string }) => e.plugin === 'consumer')
    return entry ? JSON.parse(entry.result_summary) : null
  }

  async function persistedProducerEntry() {
    const state = JSON.parse(await readFile(statePath, 'utf-8'))
    return state.plugin_runs.prod
  }

  /**
   * Two advances in one home. Returns what the consumer saw each time, plus the
   * producer's persisted entry after advance 2.
   */
  async function runArm(mode: Mode) {
    await writePlugin('prod', { outputs: { brief: {} }, handlerBody: producer(mode) })
    await writePlugin('consumer', { dependencies: ['prod'], handlerBody: consumer })

    const r1 = await advance()
    const s1 = await consumerSaw(r1.run_log_path)

    await writeFile(marker, 'x')

    const r2 = await advance()
    const s2 = await consumerSaw(r2.run_log_path)
    return { s1, s2, entry: await persistedProducerEntry() }
  }

  test('the record survives a producer that threw', async () => {
    const { s1, s2, entry } = await runArm('throw')
    expect(s1.seen).not.toBeNull()
    expect(s2.seen).toEqual(s1.seen)
    // The run is reported as it actually ended. Preserving the Output by
    // declining to write the status would pass the assertion above and lie.
    expect(entry.status).toBe('failed')
    expect(entry.last_output).toEqual(s1.seen)
  })

  test('the record survives a producer that returned failed', async () => {
    const { s1, s2, entry } = await runArm('failed')
    expect(s1.seen).not.toBeNull()
    expect(s2.seen).toEqual(s1.seen)
    expect(entry.status).toBe('failed')
    expect(entry.last_output).toEqual(s1.seen)
  })

  test('the record survives a producer that succeeded and produced nothing', async () => {
    const { s1, s2, entry } = await runArm('success-with-nothing')
    expect(s1.seen).not.toBeNull()
    expect(s2.seen).toEqual(s1.seen)
    // The discriminator. A fix keyed on `status === 'failed'` passes the other
    // two arms and fails here, which is the whole reason this arm exists.
    expect(entry.status).toBe('success')
    expect(entry.last_output).toEqual(s1.seen)
  })
})
