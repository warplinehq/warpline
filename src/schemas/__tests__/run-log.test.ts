import { describe, it, expect } from 'bun:test'
import { RunLogSchema, PluginLogEntrySchema } from '../run-log.js'
import type { RunLog } from '../run-log.js'

const validRunLog: RunLog = {
  run_id: '20260403T120000-a1b2c3d4',
  started_at: '2026-04-03T12:00:00Z',
  completed_at: '2026-04-03T12:05:00Z',
  status: 'complete',
  resumed_from: null,
  summary: 'Health check complete',
  plugin_entries: [],
}

describe('RunLogSchema', () => {
  it('accepts a valid complete run log', () => {
    const result = RunLogSchema.safeParse(validRunLog)
    expect(result.success).toBe(true)
  })

  it('rejects missing started_at field', () => {
    const { started_at, ...missing } = validRunLog
    const result = RunLogSchema.safeParse(missing)
    expect(result.success).toBe(false)
  })

  it('accepts completed_at as null (interrupted run)', () => {
    const interrupted = { ...validRunLog, completed_at: null, status: 'interrupted' as const }
    const result = RunLogSchema.safeParse(interrupted)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.completed_at).toBeNull()
    }
  })

  it('accepts status values: complete, partial, failed, interrupted', () => {
    for (const status of ['complete', 'partial', 'failed', 'interrupted'] as const) {
      const log = { ...validRunLog, status }
      const result = RunLogSchema.safeParse(log)
      expect(result.success).toBe(true)
    }
  })

  it('rejects status "unknown"', () => {
    const log = { ...validRunLog, status: 'unknown' }
    const result = RunLogSchema.safeParse(log)
    expect(result.success).toBe(false)
  })

  /**
   * A log already on disk, written by 0.1.2, carries six keys this schema no
   * longer declares. Zod strips unknown keys rather than rejecting them, which
   * is the whole reason the removal needed no migration, no defaulted
   * placeholder and no read-compatibility shim. That claim is only worth making
   * if something asserts it.
   */
  it('strips the pre-0.2 keys from a stored log rather than rejecting it', () => {
    const stored = {
      ...validRunLog,
      modes_run: [{ mode: 'health', status: 'pass', skills_invoked: [] }],
      tasks_surfaced: [{ task_id: 't-1', severity: 'warning', status: 'new' }],
      tasks_resolved: ['t-0'],
      deferrals_active: 2,
      verification_results: [{ task_id: 't-1', status: 'pass', method: 'recheck' }],
      metrics_summary: { computed_at: '2026-04-03T12:05:00Z' },
    }
    const result = RunLogSchema.safeParse(stored)
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(Object.keys(result.data).sort()).toEqual([
      'completed_at',
      'plugin_entries',
      'resumed_from',
      'run_id',
      'started_at',
      'status',
      'summary',
    ])
  })
})

describe('PluginLogEntrySchema', () => {
  const entry = {
    plugin: 'digest-sender',
    status: 'completed' as const,
    started_at: '2026-04-03T12:00:00Z',
    elapsed_ms: 120,
    result_summary: 'sent the digest',
  }

  /**
   * `denied` is an outcome of supervision, exactly as `gated` is. Recording a
   * denial as `skipped` instead would put it in the same bucket as "no Grant"
   * and "already fresh", which is the conflation a denied outcome exists to
   * remove — the log would no longer say whether a human answered.
   */
  it('accepts every status including the denied outcome', () => {
    for (const status of ['completed', 'failed', 'skipped', 'gated', 'denied'] as const) {
      expect(PluginLogEntrySchema.safeParse({ ...entry, status }).success).toBe(true)
    }
  })

  it('still rejects a status outside the set', () => {
    expect(PluginLogEntrySchema.safeParse({ ...entry, status: 'refused' }).success).toBe(false)
  })
})
