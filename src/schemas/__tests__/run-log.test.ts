import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, rm, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  RunLogSchema,
  PluginLogEntrySchema,
  runLogFilename,
  ensureRunDir,
  writeRunLog,
  pruneRunLogs,
} from '../run-log.js'
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

describe('runLogFilename', () => {
  it('returns string matching run-id pattern', () => {
    const filename = runLogFilename('20260403T120000-a1b2c3d4')
    expect(filename).toBe('20260403T120000-a1b2c3d4.json')
  })
})

describe('ensureRunDir', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `run-log-test-${Date.now()}`)
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('creates directory if not exists', async () => {
    const dir = await ensureRunDir(tmpDir)
    expect(dir).toBe(tmpDir)
    // Verify it actually exists by listing it
    const entries = await readdir(tmpDir)
    expect(Array.isArray(entries)).toBe(true)
  })
})

describe('writeRunLog', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `run-log-test-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('writes JSON file with correct filename', async () => {
    const filepath = await writeRunLog(validRunLog, tmpDir)
    expect(filepath).toBe(join(tmpDir, '20260403T120000-a1b2c3d4.json'))
    // Verify actual file content
    const content = JSON.parse(await (await import('node:fs/promises')).readFile(filepath, 'utf-8'))
    expect(content.run_id).toBe(validRunLog.run_id)
  })
})

describe('pruneRunLogs', () => {
  let tmpDir: string
  const THIRTY_ONE_DAYS_MS = 31 * 24 * 60 * 60 * 1000
  const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `run-log-prune-test-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('removes files older than 30 days', async () => {
    const { utimes } = await import('node:fs/promises')
    // Write two old files and one new file
    const oldFile1 = join(tmpDir, 'old-run-1.json')
    const oldFile2 = join(tmpDir, 'old-run-2.json')
    const newFile = join(tmpDir, 'new-run.json')
    await writeFile(oldFile1, '{}')
    await writeFile(oldFile2, '{}')
    await writeFile(newFile, '{}')
    // Set mtime to 31 days ago for old files
    const oldTime = new Date(Date.now() - THIRTY_ONE_DAYS_MS)
    await utimes(oldFile1, oldTime, oldTime)
    await utimes(oldFile2, oldTime, oldTime)

    const pruned = await pruneRunLogs(tmpDir)
    expect(pruned).toBe(2)
    // Verify old files deleted, new file remains
    const remaining = await readdir(tmpDir)
    expect(remaining).toEqual(['new-run.json'])
  })

  it('keeps files within 30 days', async () => {
    const { utimes } = await import('node:fs/promises')
    const recentFile = join(tmpDir, 'recent-run.json')
    await writeFile(recentFile, '{}')
    const recentTime = new Date(Date.now() - TWO_DAYS_MS)
    await utimes(recentFile, recentTime, recentTime)

    const pruned = await pruneRunLogs(tmpDir)
    expect(pruned).toBe(0)
    const remaining = await readdir(tmpDir)
    expect(remaining).toHaveLength(1)
  })
})
