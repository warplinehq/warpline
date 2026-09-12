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

/**
 * One clock reading for every fixture in this file.
 *
 * Aging each file off its own `Date.now()` gives two runs written in the same
 * breath two different mtimes, so a tie-break case would never see a tie and
 * would pass on insertion order while proving nothing.
 */
const NOW = Date.now()

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
  const when = new Date(NOW - fx.ageDays * DAY_MS)
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

// ---------------------------------------------------------------------------
// pruneRunLogs — the count and byte bounds, applied after the exemptions
// ---------------------------------------------------------------------------

/**
 * A minimal document for the byte cases. Every id below is five characters, so
 * `DOC_BYTES` is the same for all of them and the arithmetic in a budget is the
 * arithmetic in the assertion rather than an incidental property of a fixture.
 */
const byteDoc = (id: string) => ({ run_id: id, status: 'complete' })
const DOC_BYTES = JSON.stringify(byteDoc('xxxxx')).length

/** An artifact document naming a plugin — what the per-plugin trim writes. */
const artifactDoc = (id: string, plugin: string) => ({
  run_id: id,
  plugin,
  status: 'success',
  started_at: '2026-04-03T12:00:00Z',
})

describe('pruneRunLogs bounds', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'run-log-bounds-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('evicts nothing by the byte rule when the survivor set is within budget', async () => {
    for (const id of ['run-a', 'run-b', 'run-c']) {
      await writeRun(tmpDir, id, { doc: byteDoc(id), logBytes: 1_000, ageDays: 1 })
    }

    const pruned = await pruneRunLogs(tmpDir, policy({ max_bytes: 1_000_000 }), new Set())

    expect(pruned).toBe(0)
    expect(await readdir(tmpDir)).toHaveLength(6)
  })

  it('counts a run as the sum of both its files, not the document alone', async () => {
    await writeRun(tmpDir, 'solo1', { doc: byteDoc('solo1'), logBytes: 1_000, ageDays: 1 })

    // The document alone fits this budget. The pair does not.
    const pruned = await pruneRunLogs(tmpDir, policy({ max_bytes: DOC_BYTES + 500 }), new Set())

    expect(pruned).toBe(1)
    expect(await readdir(tmpDir)).toEqual([])
  })

  it('treats a total exactly equal to the budget as within budget', async () => {
    await writeRun(tmpDir, 'solo1', { doc: byteDoc('solo1'), logBytes: 1_000, ageDays: 1 })

    const pruned = await pruneRunLogs(tmpDir, policy({ max_bytes: DOC_BYTES + 1_000 }), new Set())

    expect(pruned).toBe(0)
    expect((await readdir(tmpDir)).sort()).toEqual(['solo1.json', 'solo1.log'])
  })

  it('evicts oldest-first, one run at a time, until the total is within budget', async () => {
    await writeRun(tmpDir, 'run-a', { doc: byteDoc('run-a'), logBytes: 1_000, ageDays: 3 })
    await writeRun(tmpDir, 'run-b', { doc: byteDoc('run-b'), logBytes: 1_000, ageDays: 2 })
    await writeRun(tmpDir, 'run-c', { doc: byteDoc('run-c'), logBytes: 1_000, ageDays: 1 })

    const oneRun = DOC_BYTES + 1_000
    const pruned = await pruneRunLogs(tmpDir, policy({ max_bytes: 2 * oneRun }), new Set())

    expect(pruned).toBe(1)
    expect((await readdir(tmpDir)).sort()).toEqual(['run-b.json', 'run-b.log', 'run-c.json', 'run-c.log'])
  })

  it('never evicts a delegated or protected run by the byte rule, even as the two oldest and largest', async () => {
    // The fixture this rule is most easily written wrong against: the two
    // records worth protecting are the two oldest and the two largest, and a
    // byte loop written over the raw listing takes them first.
    await writeRun(tmpDir, 'dele1', { doc: delegatedDoc('dele1'), logBytes: 20_000, ageDays: 400 })
    await writeRun(tmpDir, 'prot1', { doc: byteDoc('prot1'), logBytes: 20_000, ageDays: 399 })
    await writeRun(tmpDir, 'run-c', { doc: byteDoc('run-c'), logBytes: 100, ageDays: 1 })

    const pruned = await pruneRunLogs(tmpDir, policy({ max_bytes: 1_000 }), new Set(['prot1']))

    expect(pruned).toBe(1)
    expect((await readdir(tmpDir)).sort()).toEqual(['dele1.json', 'dele1.log', 'prot1.json', 'prot1.log'])
  })

  it('evicts every non-exempt survivor at a budget of zero and leaves every exempt one', async () => {
    await writeRun(tmpDir, 'dele1', { doc: delegatedDoc('dele1'), logBytes: 100, ageDays: 1 })
    await writeRun(tmpDir, 'prot1', { doc: byteDoc('prot1'), logBytes: 100, ageDays: 1 })
    await writeRun(tmpDir, 'run-c', { doc: byteDoc('run-c'), logBytes: 100, ageDays: 1 })

    const pruned = await pruneRunLogs(tmpDir, policy({ max_bytes: 0 }), new Set(['prot1']))

    expect(pruned).toBe(1)
    expect((await readdir(tmpDir)).sort()).toEqual(['dele1.json', 'dele1.log', 'prot1.json', 'prot1.log'])
  })

  it('lets one large transcript evict several small runs — the accepted cost, asserted', async () => {
    await writeRun(tmpDir, 'bigxx', { doc: byteDoc('bigxx'), logBytes: 50_000, ageDays: 1 })
    for (const [id, age] of [['sml-a', 5], ['sml-b', 4], ['sml-c', 3]] as const) {
      await writeRun(tmpDir, id, { doc: byteDoc(id), logBytes: 1_000, ageDays: age })
    }

    // A budget the big run exactly fills: the three small ones all go.
    const pruned = await pruneRunLogs(tmpDir, policy({ max_bytes: 50_000 + DOC_BYTES }), new Set())

    expect(pruned).toBe(3)
    expect((await readdir(tmpDir)).sort()).toEqual(['bigxx.json', 'bigxx.log'])
  })

  it('keeps the newest N non-exempt runs, with exempt runs not consuming the count', async () => {
    for (const [id, age] of [['cnt-a', 5], ['cnt-b', 4], ['cnt-c', 3], ['cnt-d', 2], ['cnt-e', 1]] as const) {
      await writeRun(tmpDir, id, { doc: byteDoc(id), logBytes: 10, ageDays: age })
    }
    await writeRun(tmpDir, 'dele1', { doc: delegatedDoc('dele1'), logBytes: 10, ageDays: 1 })

    const pruned = await pruneRunLogs(tmpDir, policy({ keep_per_plugin: 2 }), new Set())

    // Three of the five non-exempt go. The delegated run is not in the set
    // being sliced, so it does not push a sixth run over the cap.
    expect(pruned).toBe(3)
    expect((await readdir(tmpDir)).sort()).toEqual([
      'cnt-d.json', 'cnt-d.log', 'cnt-e.json', 'cnt-e.log', 'dele1.json', 'dele1.log',
    ])
  })

  it('applies the count bound within one plugin rather than across the directory', async () => {
    for (const plugin of ['alpha', 'bravo']) {
      for (const age of [3, 2, 1]) {
        const id = `${plugin}-${age}`
        await writeRun(tmpDir, id, { doc: artifactDoc(id, plugin), logBytes: 10, ageDays: age })
      }
    }
    for (const age of [3, 2, 1]) {
      const id = `engine-${age}`
      await writeRun(tmpDir, id, { doc: byteDoc(id), logBytes: 10, ageDays: age })
    }

    const pruned = await pruneRunLogs(tmpDir, policy({ keep_per_plugin: 2 }), new Set())

    // One per bucket, not four out of nine. A directory-wide cap here would
    // evict artifacts the per-plugin trim had just decided to keep.
    expect(pruned).toBe(3)
    const left = (await readdir(tmpDir)).filter((f) => f.endsWith('.json')).sort()
    expect(left).toEqual(['alpha-1.json', 'alpha-2.json', 'bravo-1.json', 'bravo-2.json', 'engine-1.json', 'engine-2.json'])
  })

  it('breaks ties in age by run id, not by the order the directory listed them', async () => {
    // Identical mtimes, written in an order that disagrees with id order, so
    // keeping `tie-c` cannot be insertion order wearing a tie-break's clothes.
    // The total order is (age ascending, id ascending); the newest-first slice
    // therefore keeps the highest id.
    for (const id of ['tie-c', 'tie-a', 'tie-b']) {
      await writeRun(tmpDir, id, { doc: byteDoc(id), logBytes: 10, ageDays: 1 })
    }

    const pruned = await pruneRunLogs(tmpDir, policy({ keep_per_plugin: 1 }), new Set())

    expect(pruned).toBe(2)
    expect((await readdir(tmpDir)).sort()).toEqual(['tie-c.json', 'tie-c.log'])
  })
})
