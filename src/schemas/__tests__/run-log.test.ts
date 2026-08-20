import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, rm, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  RunLogSchema,
  ModeRunSchema,
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
  modes_run: [
    {
      mode: 'health',
      status: 'pass',
      skills_invoked: [
        {
          skill: 'technical-seo-checker',
          result: {
            status: 'success',
            phases_completed: ['crawl', 'analyze'],
            phases_failed: [],
            errors: [],
            data_freshness: { gsc: '2026-04-03' },
            summary: 'All checks passed',
            artifacts_produced: ['.warpline/runs/report.md'],
            schema_version: 1,
          },
        },
      ],
    },
  ],
  resumed_from: null,
  summary: 'Health check complete',
  tasks_surfaced: [],
  tasks_resolved: [],
  deferrals_active: 0,
  plugin_entries: [],
  verification_results: [],
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
})

describe('ModeRunSchema', () => {
  it('accepts mode status values: pass, partial, fail, skipped', () => {
    for (const status of ['pass', 'partial', 'fail', 'skipped'] as const) {
      const mode = { mode: 'health', status, skills_invoked: [] }
      const result = ModeRunSchema.safeParse(mode)
      expect(result.success).toBe(true)
    }
  })

  it('validates nested SkillResultSchema within skills_invoked', () => {
    const mode = {
      mode: 'intelligence',
      status: 'pass' as const,
      skills_invoked: [
        {
          skill: 'competitor-analysis',
          result: {
            status: 'partial',
            phases_completed: ['scan'],
            phases_failed: ['deep-dive'],
            errors: [{ code: 'timeout', message: 'API timed out', impact: 'MEDIUM' }],
            data_freshness: { competitors: '2026-04-01' },
            summary: 'Partial scan completed',
            artifacts_produced: [],
          },
        },
      ],
    }
    const result = ModeRunSchema.safeParse(mode)
    expect(result.success).toBe(true)
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
