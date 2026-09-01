/**
 * Engine state shapes, and nothing that touches disk.
 *
 * The read-policy block and the six cases that round-tripped through a real
 * state document moved to `src/runtime/__tests__/engine-state-store.test.ts`
 * with the helpers they exercise — `./schemas/*` is a wildcard export, so a
 * test that could only be written against a filesystem helper was a test of
 * something that should never have been under this directory. What remains is
 * `safeParse` and `parse` assertions against the shapes this module publishes.
 */
import { describe, it, expect } from 'bun:test'
import {
  DenialSchema,
  PendingGateSchema,
  PluginRunSchema,
  TaskAgingSchema,
  defaultEngineState,
  isStubGate,
} from '../engine-state.js'

describe('PluginRunSchema.status', () => {
  const base = { last_run_at: '2026-08-01T00:00:00Z', duration_ms: 12 }

  /**
   * A parked supervised plugin records a run. Before it did, the supervised
   * branch returned before the only `plugin_runs` write, so a side-effecting
   * plugin with a live Grant was due again on the very next advance and
   * re-fired its effects for the whole grant window on one human "yes".
   */
  it('accepts the gated member', () => {
    const result = PluginRunSchema.safeParse({ ...base, status: 'gated' })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.status).toBe('gated')
  })

  it('still accepts the four members that were already there', () => {
    for (const status of ['success', 'partial', 'failed', 'skipped']) {
      expect(PluginRunSchema.safeParse({ ...base, status }).success).toBe(true)
    }
  })

  it('is still a closed enum', () => {
    expect(PluginRunSchema.safeParse({ ...base, status: 'approved' }).success).toBe(false)
  })
})

// ── The per-plugin last Output pointer (R7) ──────────────────────────────

describe('PluginRunSchema.last_output', () => {
  const base = { last_run_at: '2026-08-01T00:00:00Z', status: 'success' as const }
  const output = {
    type: 'brief',
    format: 'markdown' as const,
    run_id: '20260801T000000-abcd1234',
    produced_at: '2026-08-01T00:00:00Z',
    path: 'brief.md',
  }

  it('parses a run carrying a last_output', () => {
    const result = PluginRunSchema.safeParse({ ...base, last_output: output })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.last_output).toEqual(output)
  })

  it('reuses the Output record shape rather than defining a second one', () => {
    // Both-present is invalid for an Output, so it must be invalid here too.
    const result = PluginRunSchema.safeParse({
      ...base,
      last_output: { type: 'brief', body: 'x', path: 'y.md' },
    })
    expect(result.success).toBe(false)
  })
})

/**
 * Run linkage on task aging (R4). The fields live here rather than in
 * `board.ts` because `TaskAgingSchema` does: `TaskDisplaySchema` extends it and
 * `EngineStateSchema.task_aging` holds it.
 */
describe('TaskAgingSchema run linkage', () => {
  const baseTask = {
    task_id: 'task-001',
    first_flagged: '2026-08-01T10:00:00Z',
    description: 'Renewal certificate expires in 12 days',
    severity: 'warning' as const,
  }

  it('reads null for both run ids on a task written before run linkage', () => {
    const result = TaskAgingSchema.parse(baseTask)
    expect(result.first_run_id).toBeNull()
    expect(result.last_flagged_run_id).toBeNull()
  })

  it('carries the run that first raised the task and the run that last re-flagged it', () => {
    const result = TaskAgingSchema.parse({
      ...baseTask,
      first_run_id: 'run-a',
      last_flagged_run_id: 'run-c',
    })
    expect(result.first_run_id).toBe('run-a')
    expect(result.last_flagged_run_id).toBe('run-c')
  })

  /**
   * A run that raises a task and re-flags it in the same advance writes the
   * same id twice. That is the ordinary first-advance case, not a corruption
   * to reject — the two fields answer different questions that happen to have
   * one answer here.
   */
  it('accepts the same run id in both fields — a run that raised and re-flagged in one advance', () => {
    const result = TaskAgingSchema.parse({
      ...baseTask,
      first_run_id: 'run-a',
      last_flagged_run_id: 'run-a',
    })
    expect(result.first_run_id).toBe(result.last_flagged_run_id)
    expect(result.first_run_id).toBe('run-a')
  })
})

/**
 * `PendingGateSchema` — the parked result, and telling a real one from a stub.
 *
 * A parked gate used to be a fabrication: `status: 'partial'`, an empty
 * `artifacts_produced`, and no record of when the gated run started or ended.
 * The real result the plugin returned was dropped on the floor. R8 needs the
 * real thing — the approve verb anchors `plugin_runs.last_run_at` at the gated
 * run's completion, refuses when a dependency moved since its start, and plan
 * 05 hashes the Outputs — so the two clock fields and the real result are the
 * whole point of these cases.
 *
 * The two clocks are also the stub discriminator, which is why the recogniser
 * gets a case of its own: it must not misfire on a gate this build wrote.
 */
describe('PendingGateSchema', () => {
  const realResult = {
    status: 'success' as const,
    phases_completed: ['render'],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: 'rendered the weekly brief',
    artifacts_produced: [
      { type: 'brief', format: 'markdown' as const, path: 'brief.md', run_id: 'run-a', produced_at: '2026-08-29T10:00:00.000Z' },
    ],
    schema_version: 2,
  }

  const realGate = {
    plugin: 'brief-writer',
    run_id: 'run-a',
    created_at: '2026-08-29T10:00:01.000Z',
    payload_summary: 'rendered the weekly brief',
    plugin_result: realResult,
    run_started_at: '2026-08-29T09:59:58.000Z',
    run_completed_at: '2026-08-29T10:00:00.000Z',
  }

  /** Exactly what `engine.ts` fabricated before this plan: no clocks, no Outputs. */
  const stubGate = {
    plugin: 'brief-writer',
    run_id: 'run-a',
    created_at: '2026-08-29T10:00:01.000Z',
    payload_summary: 'rendered the weekly brief',
    plugin_result: {
      status: 'partial' as const,
      phases_completed: [],
      phases_failed: [],
      errors: [],
      data_freshness: {},
      summary: 'rendered the weekly brief',
      artifacts_produced: [],
      schema_version: 1,
    },
  }

  it('parses a gate carrying the real result and both clock fields', () => {
    const parsed = PendingGateSchema.parse(realGate)
    expect(parsed.run_started_at).toBe('2026-08-29T09:59:58.000Z')
    expect(parsed.run_completed_at).toBe('2026-08-29T10:00:00.000Z')
    expect(parsed.plugin_result.status).toBe('success')
    expect(parsed.plugin_result.artifacts_produced[0]?.path).toBe('brief.md')
    expect(parsed.applied_at).toBeNull()
  })

  /**
   * The discriminator gets a test of its own so it is a named predicate rather
   * than an implicit heuristic buried in a filter. Both directions: a stub is
   * recognised, and a gate this build wrote is not.
   */
  it('recognises a pre-Phase-8 stub gate by its missing clocks, and a real gate as not one', () => {
    expect(isStubGate(PendingGateSchema.parse(stubGate))).toBe(true)
    expect(isStubGate(PendingGateSchema.parse(realGate))).toBe(false)
  })

  it('reads a pre-Phase-8 gate with both clocks null rather than rejecting the file', () => {
    const parsed = PendingGateSchema.parse(stubGate)
    expect(parsed.run_started_at).toBeNull()
    expect(parsed.run_completed_at).toBeNull()
  })
})

/**
 * The denials record.
 *
 * Keyed by plugin name rather than held as an array, and that shape is the
 * whole idempotency story: a second denial for the same plugin lands on the
 * same key, so re-denying cannot accumulate duplicates and there is no de-dupe
 * scan to get wrong. It also makes a fleet-wide denial inexpressible — there is
 * no key that means every plugin.
 */
describe('DenialSchema and the denials record', () => {
  const denial = {
    plugin: 'digest-sender',
    reason: 'operator declined the parked result',
    denied_at: '2026-08-29T10:00:00.000Z',
    fingerprint: 'a'.repeat(64),
  }

  it('parses a denial and defaults the optional note to null', () => {
    const parsed = DenialSchema.parse(denial)
    expect(parsed.plugin).toBe('digest-sender')
    expect(parsed.fingerprint).toBe('a'.repeat(64))
    expect(parsed.note).toBeNull()
  })

  /**
   * The structural half of "denying twice is a no-op": the record's key does
   * it, not a scan. The other half — that a second deny with an UNCHANGED
   * fingerprint writes nothing at all — is asserted in `deny.test.ts`, where
   * the verb decides it.
   */
  it('replaces rather than accumulates when the same plugin is denied again', () => {
    const state = defaultEngineState()
    state.denials['digest-sender'] = DenialSchema.parse(denial)
    state.denials['digest-sender'] = DenialSchema.parse({
      ...denial,
      fingerprint: 'b'.repeat(64),
      denied_at: '2026-08-29T11:00:00.000Z',
    })

    expect(Object.keys(state.denials)).toEqual(['digest-sender'])
    expect(state.denials['digest-sender']?.fingerprint).toBe('b'.repeat(64))
  })
})
