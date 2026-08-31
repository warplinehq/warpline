/**
 * The filesystem half of the run log, tested where it now lives.
 *
 * These four blocks moved out of `src/schemas/__tests__/run-log.test.ts` with
 * the helpers they exercise. The schemas subpath is a wildcard export, so a
 * filesystem helper under `src/schemas/` was public API for disk I/O; the
 * helpers moved to `src/runtime/run-log-store.ts` and their tests followed.
 * Behaviour is unchanged — this is the same assertions against the same
 * functions at a new import path.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, rm, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  runLogFilename,
  ensureRunDir,
  writeRunLog,
  pruneRunLogs,
} from '../run-log-store.js'
import type { RunLog } from '../../schemas/run-log.js'

const validRunLog: RunLog = {
  run_id: '20260403T120000-a1b2c3d4',
  started_at: '2026-04-03T12:00:00Z',
  completed_at: '2026-04-03T12:05:00Z',
  status: 'complete',
  resumed_from: null,
  summary: 'Health check complete',
  plugin_entries: [],
}

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
