/**
 * `gateApplicable` is the one answer every gate reader shares: whether a
 * parked gate can still be applied. Apply, the count of waiting gates and the
 * parked-result Asks all read it, so they cannot disagree about one gate.
 *
 * Pure: no home, no clock read, no write. Every case hands in its own `now`.
 * The detail sentences are pinned where they are printed (approve.test.ts);
 * here only the verdict and its reason are.
 *
 * The module is imported as a namespace so a missing export fails each case on
 * its own rather than failing the whole file to load.
 */
import { describe, expect, test } from 'bun:test'
import * as engine from '../engine.js'
import type { EngineState, PendingGate } from '../../schemas/engine-state.js'
import type { PluginManifest } from '../../schemas/plugin-manifest.js'

const HOUR = 60 * 60 * 1000
const S = Date.parse('2026-10-13T08:00:00.000Z')
const C = S + 60_000
const iso = (ms: number): string => new Date(ms).toISOString()

function gateOf(overrides: Partial<PendingGate> = {}): PendingGate {
  return {
    plugin: 'g',
    run_id: 'run-1',
    created_at: iso(C),
    payload_summary: 'parked',
    plugin_result: { status: 'success', summary: 'ok' },
    run_started_at: iso(S),
    run_completed_at: iso(C),
    applied_at: null,
    ...overrides,
  } as unknown as PendingGate
}

function stateOf(plugin_runs: Record<string, Record<string, unknown>> = { g: { last_run_at: iso(C), status: 'gated', run_id: 'run-1' } }): EngineState {
  return { plugin_runs, pending_gates: [] } as unknown as EngineState
}

function manifestOf(ttl_hours = 2, dependencies: string[] = []): PluginManifest {
  return { name: 'g', ttl_hours, dependencies } as unknown as PluginManifest
}

describe('gateApplicable is the one answer to whether a parked gate can still be applied', () => {
  test('a gate inside its ceiling with nothing moved can be applied, up to and including the ceiling instant', () => {
    expect(engine.gateApplicable(stateOf(), gateOf(), manifestOf(2), C + HOUR)).toMatchObject({ applicable: true })
    expect(engine.gateApplicable(stateOf(), gateOf(), manifestOf(2), C + 2 * HOUR)).toMatchObject({ applicable: true })
  })

  test('one millisecond past the earlier of ttl_hours and 23 hours is expired', () => {
    expect(engine.gateApplicable(stateOf(), gateOf(), manifestOf(2), C + 2 * HOUR + 1)).toMatchObject({
      applicable: false,
      reason: 'expired',
    })
    expect(engine.gateApplicable(stateOf(), gateOf(), manifestOf(48), C + engine.GATE_MAX_AGE_MS)).toMatchObject({
      applicable: true,
    })
    expect(engine.gateApplicable(stateOf(), gateOf(), manifestOf(48), C + engine.GATE_MAX_AGE_MS + 1)).toMatchObject({
      applicable: false,
      reason: 'expired',
    })
  })

  test('an applied gate reports already applied', () => {
    expect(engine.gateApplicable(stateOf(), gateOf({ applied_at: iso(C + HOUR) }), manifestOf(), C + HOUR)).toMatchObject({
      applicable: false,
      reason: 'already_applied',
    })
  })

  test('a gate missing either clock is unclocked', () => {
    expect(engine.gateApplicable(stateOf(), gateOf({ run_started_at: null }), manifestOf(), C + HOUR)).toMatchObject({
      applicable: false,
      reason: 'unclocked',
    })
    expect(engine.gateApplicable(stateOf(), gateOf({ run_completed_at: null }), manifestOf(), C + HOUR)).toMatchObject({
      applicable: false,
      reason: 'unclocked',
    })
  })

  test('an entry naming another run supersedes the gate; an entry with no run_id, or no entry, does not', () => {
    const later = stateOf({ g: { last_run_at: iso(C + HOUR), status: 'failed', run_id: 'run-2' } })
    expect(engine.gateApplicable(later, gateOf(), manifestOf(), C + HOUR)).toMatchObject({
      applicable: false,
      reason: 'superseded',
    })
    const unnamed = stateOf({ g: { last_run_at: iso(C), status: 'gated' } })
    expect(engine.gateApplicable(unnamed, gateOf(), manifestOf(), C + HOUR)).toMatchObject({ applicable: true })
    expect(engine.gateApplicable(stateOf({}), gateOf(), manifestOf(), C + HOUR)).toMatchObject({ applicable: true })
  })

  test('a dependency that ran after the gated run started moves it; one that ran at that instant, or never, does not', () => {
    const own = { last_run_at: iso(C), status: 'gated', run_id: 'run-1' }
    const moved = stateOf({ g: own, d: { last_run_at: iso(S + 1), status: 'success' } })
    expect(engine.gateApplicable(moved, gateOf(), manifestOf(2, ['d']), C + HOUR)).toMatchObject({
      applicable: false,
      reason: 'dependency_moved',
    })
    const atStart = stateOf({ g: own, d: { last_run_at: iso(S), status: 'success' } })
    expect(engine.gateApplicable(atStart, gateOf(), manifestOf(2, ['d']), C + HOUR)).toMatchObject({ applicable: true })
    expect(engine.gateApplicable(stateOf({ g: own }), gateOf(), manifestOf(2, ['d']), C + HOUR)).toMatchObject({
      applicable: true,
    })
  })

  test('refusals come in apply order: applied, unclocked, superseded, dependency moved, expired', () => {
    const superseding = { last_run_at: iso(C + HOUR), status: 'failed', run_id: 'run-2' }
    const depMoved = { last_run_at: iso(S + 1), status: 'success' }
    const late = C + 3 * HOUR
    expect(
      engine.gateApplicable(stateOf({ g: superseding }), gateOf({ applied_at: iso(C) }), manifestOf(), C + HOUR),
    ).toMatchObject({ applicable: false, reason: 'already_applied' })
    expect(
      engine.gateApplicable(stateOf({ g: superseding }), gateOf({ run_completed_at: null }), manifestOf(), C + HOUR),
    ).toMatchObject({ applicable: false, reason: 'unclocked' })
    expect(
      engine.gateApplicable(stateOf({ g: superseding, d: depMoved }), gateOf(), manifestOf(2, ['d']), late),
    ).toMatchObject({ applicable: false, reason: 'superseded' })
    expect(
      engine.gateApplicable(
        stateOf({ g: { last_run_at: iso(C), status: 'gated', run_id: 'run-1' }, d: depMoved }),
        gateOf(),
        manifestOf(2, ['d']),
        late,
      ),
    ).toMatchObject({ applicable: false, reason: 'dependency_moved' })
  })
})
