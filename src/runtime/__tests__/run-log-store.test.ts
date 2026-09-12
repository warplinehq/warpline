/**
 * The filesystem half of the run log, tested where it now lives.
 *
 * These four blocks moved out of `src/schemas/__tests__/run-log.test.ts` with
 * the helpers they exercise. The schemas subpath is a wildcard export, so a
 * filesystem helper under `src/schemas/` was public API for disk I/O; the
 * helpers moved to `src/runtime/run-log-store.ts` and their tests followed.
 * Behaviour is unchanged for the first three blocks — the same assertions
 * against the same functions at a new import path.
 *
 * The `pruneRunLogs` block is not. The prune was rewritten to delete RUNS
 * rather than files: it enumerates run ids from one directory read, unlinks a
 * run's document and its transcript together, exempts what an operator is
 * preserving, and applies three bounds in a fixed order. Every case below
 * writes its fixture into a `mkdtemp`-backed directory and sets mtimes
 * explicitly, so no assertion depends on wall-clock timing or on the order the
 * directory happened to list its entries.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, mkdtemp, rm, readdir, utimes, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  runLogFilename,
  ensureRunDir,
  writeRunLog,
  pruneRunLogs,
} from '../run-log-store.js'
import type { RetentionPolicy } from '../../lib/preferences.js'
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


// ---------------------------------------------------------------------------
// pruneRunLogs
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000

/** The operator's policy, with only the bound under test moved off its default. */
function policy(over: Partial<RetentionPolicy> = {}): RetentionPolicy {
  return { days: 30, keep_per_plugin: 20, max_bytes: 104857600, ...over }
}

interface Fixture {
  /** The document written as `<id>.json`. Omit for an orphan transcript. */
  doc?: unknown
  /** Transcript size in bytes. Omit to write no `<id>.log` at all. */
  logBytes?: number
  /** Raw `<id>.json` contents, for the malformed cases. Wins over `doc`. */
  raw?: string
  /** Age of BOTH files, in days. */
  ageDays: number
}

/**
 * Write one run's files and age them deliberately. Sizes are padded rather than
 * inherited from whatever the fixture happens to weigh, so the arithmetic in an
 * assertion is the arithmetic in the test.
 */
async function writeRun(dir: string, id: string, fx: Fixture): Promise<void> {
  const when = new Date(Date.now() - fx.ageDays * DAY_MS)
  if (fx.raw !== undefined) {
    await writeFile(join(dir, `${id}.json`), fx.raw)
    await utimes(join(dir, `${id}.json`), when, when)
  } else if (fx.doc !== undefined) {
    await writeFile(join(dir, `${id}.json`), JSON.stringify(fx.doc))
    await utimes(join(dir, `${id}.json`), when, when)
  }
  if (fx.logBytes !== undefined) {
    await writeFile(join(dir, `${id}.log`), 'x'.repeat(fx.logBytes))
    await utimes(join(dir, `${id}.log`), when, when)
  }
}

/** A completed engine run log. Its status is not the delegated one. */
const runLogDoc = (id: string) => ({ ...validRunLog, run_id: id, status: 'complete' })

/** A run artifact parked pending approval — the one exempt status. */
const delegatedDoc = (id: string, plugin = 'some-plugin') => ({
  run_id: id,
  plugin,
  status: 'delegated',
  started_at: '2026-04-03T12:00:00Z',
})

describe('pruneRunLogs', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'run-log-prune-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('deletes a run rather than a file: the document and its transcript go together', async () => {
    await writeRun(tmpDir, 'old-run', { doc: runLogDoc('old-run'), logBytes: 64, ageDays: 31 })
    await writeRun(tmpDir, 'new-run', { doc: runLogDoc('new-run'), logBytes: 64, ageDays: 2 })

    const pruned = await pruneRunLogs(tmpDir, policy(), new Set())

    // One RUN, not two files.
    expect(pruned).toBe(1)
    expect(existsSync(join(tmpDir, 'old-run.json'))).toBe(false)
    expect(existsSync(join(tmpDir, 'old-run.log'))).toBe(false)
    expect((await readdir(tmpDir)).sort()).toEqual(['new-run.json', 'new-run.log'])
  })

  it('reclaims an orphan transcript that has no document to enumerate it by', async () => {
    // The class the old rule left immortal: every advance since the prune
    // shipped unlinked the `.json` alone.
    await writeRun(tmpDir, 'orphan', { logBytes: 128, ageDays: 31 })

    const pruned = await pruneRunLogs(tmpDir, policy(), new Set())

    expect(pruned).toBe(1)
    expect(await readdir(tmpDir)).toEqual([])
  })

  it('keeps a run inside the window', async () => {
    await writeRun(tmpDir, 'recent', { doc: runLogDoc('recent'), logBytes: 32, ageDays: 2 })

    const pruned = await pruneRunLogs(tmpDir, policy(), new Set())

    expect(pruned).toBe(0)
    expect((await readdir(tmpDir)).sort()).toEqual(['recent.json', 'recent.log'])
  })

  it('exempts a delegated run unconditionally, while its age-peer is deleted', async () => {
    // The age-peer is what makes this an exemption rather than a prune that
    // did nothing.
    await writeRun(tmpDir, 'delegated-run', { doc: delegatedDoc('delegated-run'), logBytes: 64, ageDays: 400 })
    await writeRun(tmpDir, 'peer-run', { doc: runLogDoc('peer-run'), logBytes: 64, ageDays: 400 })

    const pruned = await pruneRunLogs(tmpDir, policy(), new Set())

    expect(pruned).toBe(1)
    expect(existsSync(join(tmpDir, 'delegated-run.json'))).toBe(true)
    expect(existsSync(join(tmpDir, 'delegated-run.log'))).toBe(true)
    expect(existsSync(join(tmpDir, 'peer-run.json'))).toBe(false)
    expect(existsSync(join(tmpDir, 'peer-run.log'))).toBe(false)
  })

  it('protects a run the caller names and lets a run reached only by a stored pointer go', async () => {
    // Both directions in one body. A pending gate still points at the first;
    // the second is reachable only through a last-output pointer, whose dangle
    // is documented as by design. Treating a pointer as protective would be
    // retain-forever by accident.
    await writeRun(tmpDir, 'gated-run', { doc: runLogDoc('gated-run'), logBytes: 64, ageDays: 400 })
    await writeRun(tmpDir, 'pointed-at-run', { doc: runLogDoc('pointed-at-run'), logBytes: 64, ageDays: 400 })

    const pruned = await pruneRunLogs(tmpDir, policy(), new Set(['gated-run']))

    expect(pruned).toBe(1)
    expect(existsSync(join(tmpDir, 'gated-run.json'))).toBe(true)
    expect(existsSync(join(tmpDir, 'gated-run.log'))).toBe(true)
    expect(existsSync(join(tmpDir, 'pointed-at-run.json'))).toBe(false)
    expect(existsSync(join(tmpDir, 'pointed-at-run.log'))).toBe(false)
  })

  it('leaves a document it cannot read on disk and does not throw', async () => {
    await writeRun(tmpDir, 'truncated', { raw: '{"run_id": "trunca', logBytes: 16, ageDays: 400 })
    await writeRun(tmpDir, 'not-a-run', { raw: '{"something": "else"}', ageDays: 400 })

    const pruned = await pruneRunLogs(tmpDir, policy(), new Set())

    expect(pruned).toBe(0)
    expect((await readdir(tmpDir)).sort()).toEqual(['not-a-run.json', 'truncated.json', 'truncated.log'])
  })

  it('returns 0 for a missing runs directory rather than throwing', async () => {
    const missing = join(tmpDir, 'not-here')
    expect(await pruneRunLogs(missing, policy(), new Set())).toBe(0)
  })

  it('is idempotent: a second prune immediately after the first deletes nothing', async () => {
    await writeRun(tmpDir, 'old-a', { doc: runLogDoc('old-a'), logBytes: 32, ageDays: 31 })
    await writeRun(tmpDir, 'old-b', { doc: runLogDoc('old-b'), logBytes: 32, ageDays: 31 })
    await writeRun(tmpDir, 'keep-me', { doc: runLogDoc('keep-me'), logBytes: 32, ageDays: 1 })

    expect(await pruneRunLogs(tmpDir, policy(), new Set())).toBe(2)
    expect(await pruneRunLogs(tmpDir, policy(), new Set())).toBe(0)
    expect((await readdir(tmpDir)).sort()).toEqual(['keep-me.json', 'keep-me.log'])
  })
})
