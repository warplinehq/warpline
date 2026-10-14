/**
 * `runAdvance` writes one Handoff record per declared `[needs-llm]` handoff,
 * under the home's `handoffs/` directory, named `<run_id>.<plugin>.json`.
 *
 * The directory is the advance's own home: the one its state file sits in,
 * never the process home. Every case builds a `createTwoAdvanceHome` temp dir
 * (AGENTS.md Rule 2), so the records land under that root and nowhere else.
 *
 * Later describes in this file cover the review gate.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { _setHome } from '../../lib/paths.js'
import { readOpenHandoffs } from '../../lib/handoffs.js'
import { createTwoAdvanceHome, type TwoAdvanceHome } from './helpers/two-advance-home.js'
import { advanceExitCode } from '../exit-codes.js'
import { grantApproval } from '../approval-gate.js'
import { buildPlanModel } from '../../cli/plan.js'

const BOTH_SUMMARY = '[needs-llm] Summarise the brief. Context: /elsewhere/brief.json'

/** Both arms at once, with different paths, so the record shows which one it took. */
const BOTH = `export async function handler() {
  return {
    status: 'skipped',
    phases_completed: [],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: ${JSON.stringify(BOTH_SUMMARY)},
    needs_llm: { task: 'Summarise the brief', context_path: 'state/brief.json' },
    artifacts_produced: [],
    schema_version: 1,
  }
}
`

/** The summary-prefix arm only, with an absolute out-of-home path. */
const PREFIX = `export async function handler() {
  return {
    status: 'skipped',
    phases_completed: [],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: '[needs-llm] Triage 2 new feed entries. Context: /tmp/payload.json',
    artifacts_produced: [],
    schema_version: 1,
  }
}
`

const SUCCESS = `export async function handler() {
  return {
    status: 'success',
    phases_completed: [],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: 'ran',
    artifacts_produced: [],
    schema_version: 1,
  }
}
`

const OUTPUT_BODY = '{"draft":"unreviewed"}'

/** A declared handoff that also carries a `brief` Output, so there is something to read downstream. */
const HANDOFF_WITH_OUTPUT = `export async function handler() {
  return {
    status: 'skipped',
    phases_completed: [],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: 'Summarise the brief',
    needs_llm: { task: 'Summarise the brief', context_path: 'state/brief.json' },
    artifacts_produced: [{ type: 'brief', format: 'json', body: ${JSON.stringify(OUTPUT_BODY)} }],
    schema_version: 1,
  }
}
`

/** Serialises `prod`'s Output as this dependent saw it, so the assertion is on what it read. */
const READS_PROD = `export async function handler(manifest, args, signal, capabilities) {
  return {
    status: 'success',
    phases_completed: [],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: JSON.stringify({ seen: capabilities.dependencies.lastOutput(capabilities.caller, 'prod') }),
    artifacts_produced: [],
    schema_version: 1,
  }
}
`

describe('an advance writes one Handoff record per declared handoff', () => {
  let home: TwoAdvanceHome
  let handoffs: string

  afterEach(async () => {
    _setHome(null)
    await home.cleanup()
  })

  async function freshHome(opts: { preferences?: Record<string, unknown> } = {}): Promise<void> {
    home = await createTwoAdvanceHome(opts)
    handoffs = join(home.root, 'handoffs')
  }

  test('the reader lists the one open record an advance with a declared handoff leaves, its fields matching the result', async () => {
    await freshHome()
    await home.writePlugin('prod', { llmHandoff: true, handlerBody: BOTH })

    const r = await home.advance()

    expect(readdirSync(handoffs)).toEqual([`${r.run_id}.prod.json`])
    const read = await readOpenHandoffs(handoffs)
    expect(read.unreadable).toEqual([])
    expect(read.open).toHaveLength(1)
    expect(read.open[0]).toMatchObject({
      min_reader_version: 1,
      id: `${r.run_id}.prod`,
      run_id: r.run_id,
      plugin: 'prod',
      task: 'Summarise the brief',
      context_path: 'state/brief.json',
      state: 'open',
      closed_at: null,
    })

    // The record moves nothing the run already recorded.
    expect((await home.entryFor(r.run_log_path, 'prod'))!.status).toBe('completed')
    expect((await home.persistedRun('prod'))!.status).toBe('skipped')
  })

  test('a prefix-only handoff records its Context: path raw', async () => {
    await freshHome()
    await home.writePlugin('prod', { llmHandoff: true, handlerBody: PREFIX })

    await home.advance()

    const read = await readOpenHandoffs(handoffs)
    expect(read.open).toHaveLength(1)
    expect(read.open[0]!.task).toBe('Triage 2 new feed entries')
    expect(read.open[0]!.context_path).toBe('/tmp/payload.json')
  })

  test('an undeclared handoff is refused and leaves no record', async () => {
    await freshHome()
    await home.writePlugin('prod', { handlerBody: BOTH })

    const r = await home.advance()

    const entry = await home.entryFor(r.run_log_path, 'prod')
    expect(entry!.status).toBe('failed')
    expect(entry!.result_summary).toBe('prod: undeclared handoff')
    expect(existsSync(handoffs)).toBe(false)
  })

  test('a record that cannot be written fails its plugin by name, and the advance goes on', async () => {
    await freshHome()
    // A regular file where the directory must be. Not `chmod`, which uid 0 ignores.
    await writeFile(handoffs, 'not a directory')
    await home.writePlugin('prod', { llmHandoff: true, handlerBody: BOTH })
    await home.writePlugin('other', { handlerBody: SUCCESS })
    await home.writePlugin('consumer', { dependencies: ['prod'], handlerBody: SUCCESS })

    const r = await home.advance()

    const prod = await home.entryFor(r.run_log_path, 'prod')
    expect(prod!.status).toBe('failed')
    expect(prod!.result_summary).toBe('prod: handoff not recorded')
    expect((await home.persistedRun('prod'))!.status).toBe('failed')

    expect((await home.entryFor(r.run_log_path, 'other'))!.status).toBe('completed')

    const consumer = await home.entryFor(r.run_log_path, 'consumer')
    expect(consumer!.status).toBe('skipped')
    expect(consumer!.result_summary).toContain('dependency failed')
    expect(consumer!.result_summary).toContain("'prod' last recorded status 'failed'")

    expect(r.gated_plugins).toEqual([])
    expect(advanceExitCode(r)).toBe(1)
    expect(readFileSync(handoffs, 'utf-8')).toBe('not a directory')
  })

  // A guarantee, not a red-first guard: no advance writes a record today, so
  // this passes before the engine writes one. The plan's `!dryRun` mutation is
  // what shows it can fail.
  test('a dry run and plan write no record', async () => {
    await freshHome()
    await home.writePlugin('prod', { llmHandoff: true, handlerBody: BOTH })

    const r = await home.advance(undefined, { dryRun: true })

    // Presence first: the handler ran and handed off.
    expect((await home.entryFor(r.run_log_path, 'prod'))!.result_summary).toBe(BOTH_SUMMARY)
    expect(existsSync(handoffs)).toBe(false)

    _setHome(home.root)
    await buildPlanModel(Date.now())
    expect(existsSync(handoffs)).toBe(false)
  })

  test('a handoff from a plugin declaring a side effect still parks, and leaves an open record', async () => {
    await freshHome({ preferences: { review_gate: true } })
    await home.writePlugin('prod', { sideEffects: ['sends_email'], llmHandoff: true, handlerBody: BOTH })
    _setHome(home.root)
    await grantApproval('prod', 60 * 60_000, join(home.root, '.session-approval'))

    const r = await home.advance()

    expect(r.gated_plugins).toEqual(['prod'])
    expect((await home.persistedRun('prod'))!.status).toBe('gated')
    expect((await readOpenHandoffs(handoffs)).open.map((h) => h.plugin)).toEqual(['prod'])
  })

  test('a record whose advance lost its state write is superseded by the next handoff of its plugin', async () => {
    await freshHome()
    await home.writePlugin('prod', { llmHandoff: true, handlerBody: BOTH })

    const r1 = await home.advance()
    // Stands for the state write that never landed after the record did.
    await rm(home.statePath, { force: true })
    const r2 = await home.advance()

    const first = JSON.parse(readFileSync(join(handoffs, `${r1.run_id}.prod.json`), 'utf-8')) as {
      state: string
      closed_at: string | null
    }
    const second = JSON.parse(readFileSync(join(handoffs, `${r2.run_id}.prod.json`), 'utf-8')) as {
      created_at: string
    }
    expect(first.state).toBe('superseded')
    expect(first.closed_at).toBe(second.created_at)
    expect((await readOpenHandoffs(handoffs)).open.map((h) => h.id)).toEqual([`${r2.run_id}.prod`])
  })
})

describe('under the review gate, an effect-free handoff does not stop its level', () => {
  let home: TwoAdvanceHome

  afterEach(async () => {
    _setHome(null)
    await home.cleanup()
  })

  test('an effect-free handoff does not stop its level: its dependent runs in the same advance', async () => {
    home = await createTwoAdvanceHome({ preferences: { review_gate: true } })
    await home.writePlugin('prod', { llmHandoff: true, handlerBody: BOTH })
    await home.writePlugin('consumer', { dependencies: ['prod'], handlerBody: SUCCESS })

    const r = await home.advance()

    expect((await home.persistedRun('prod'))!.status).toBe('skipped')
    expect((await home.entryFor(r.run_log_path, 'prod'))!.status).toBe('completed')
    // It ran, and the review gate parked its success as any autonomous plugin's.
    const consumer = await home.entryFor(r.run_log_path, 'consumer')
    expect(consumer).not.toBeNull()
    expect(consumer!.status).toBe('gated')
    expect(r.gated_plugins).toEqual(['consumer'])
    expect((await readOpenHandoffs(join(home.root, 'handoffs'))).open.map((h) => h.plugin)).toEqual(['prod'])
  })

  // The review gate does not hold back an exempt handoff's Output, by
  // decision. This case pins it, so that narrowing the exemption to handoffs
  // with no Output, the alternative that was declined, cannot land silently.
  test('the Output of an effect-free handoff reaches its dependent unreviewed, and a dependent declaring a side effect still parks', async () => {
    home = await createTwoAdvanceHome({ preferences: { review_gate: true } })
    await home.writePlugin('prod', { outputs: { brief: {} }, llmHandoff: true, handlerBody: HANDOFF_WITH_OUTPUT })
    await home.writePlugin('consumer', { dependencies: ['prod'], sideEffects: ['sends_email'], handlerBody: READS_PROD })
    _setHome(home.root)
    await grantApproval('consumer', 60 * 60_000, join(home.root, '.session-approval'))

    const r = await home.advance()

    const prod = (await home.persistedRun('prod')) as Record<string, unknown>
    expect(prod.status).toBe('skipped')
    expect(prod.last_output).toMatchObject({ type: 'brief', body: OUTPUT_BODY })

    // What the consumer saw, not what the state file holds.
    const consumer = await home.entryFor(r.run_log_path, 'consumer')
    expect(consumer).not.toBeNull()
    expect(consumer!.status).toBe('gated')
    expect((JSON.parse(consumer!.result_summary) as { seen: unknown }).seen).toMatchObject({ type: 'brief', body: OUTPUT_BODY })

    expect(r.gated_plugins).toEqual(['consumer'])
    const state = JSON.parse(readFileSync(home.statePath, 'utf-8')) as {
      pending_gates: { run_id: string; plugin: string }[]
    }
    expect(state.pending_gates.filter((g) => g.run_id === r.run_id).map((g) => g.plugin)).toEqual(['consumer'])
  })
})
