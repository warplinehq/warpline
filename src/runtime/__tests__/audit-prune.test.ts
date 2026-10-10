/**
 * Retention never reaches the audit store.
 *
 * Four paths delete or rewrite files in a home under an operator's bounds: the
 * run-log prune, the JSONL run-log prune, the per-plugin artifact trim and the
 * events-log trim. Each runs here at its tightest bound, over a home whose
 * every seeded file, the store's segments included, is two days old. Each must
 * remove what it owns, and `<home>/audit/` must come out byte-identical,
 * mtimes included.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { appendAudit } from '../../lib/audit-log.js'
import { JsonlRunLogger } from '../../lib/jsonl-logger.js'
import { _trimEventsLog } from '../../board/engine-events.js'
import { pruneRunLogs } from '../run-log-store.js'
import { trimPluginHistory } from '../run-artifacts.js'
import { createTestHome, type TestHome } from './helpers/create-test-home.js'
import { snapshotHome } from './helpers/snapshot-home.js'

const NAME = /^\d{16}\.jsonl$/
const TWO_DAYS_AGO = (Date.now() - 2 * 86_400_000) / 1000

let home: TestHome
let auditDir: string

beforeEach(async () => {
  home = await createTestHome()
  auditDir = join(home.root, 'audit')
})

afterEach(async () => {
  await home.cleanup()
})

const age = (path: string) => utimesSync(path, TWO_DAYS_AGO, TWO_DAYS_AGO)
const segments = (dir: string) => readdirSync(dir).filter((n) => NAME.test(n)).sort()

async function seedAudit(): Promise<void> {
  const statePath = join(home.stateDir, 'engine-state.json')
  for (let i = 0; i < 40 && (!existsSync(auditDir) || segments(auditDir).length < 2); i++) {
    await appendAudit(statePath, 'denial.lifted', { plugin: `p${i}`, fingerprint: null, principal: null }, { maxSegmentBytes: 2048 })
  }
  expect(segments(auditDir).length).toBeGreaterThanOrEqual(2)
  for (const name of readdirSync(auditDir)) age(join(auditDir, name))
}

describe('no prune reaches the audit store', () => {
  test('the four prunes at their tightest bounds each act, and audit/ is byte-identical', async () => {
    await seedAudit()

    const run = (id: string, doc: object) => {
      const json = join(home.runsDir, `${id}.json`)
      const log = join(home.runsDir, `${id}.log`)
      writeFileSync(json, JSON.stringify(doc))
      writeFileSync(log, 'transcript\n')
      age(json)
      age(log)
    }
    const old = new Date(Date.now() - 2 * 86_400_000).toISOString()
    run('artifact-1', { run_id: 'artifact-1', plugin: 'p', started_at: old, completed_at: old, status: 'success' })
    run('runlog-1', { run_id: 'runlog-1', plugin: 'q', status: 'success' })

    const jsonlDir = join(home.root, 'logs', 'runs')
    mkdirSync(jsonlDir, { recursive: true })
    const jsonl = join(jsonlDir, '2026-01-01.jsonl')
    writeFileSync(jsonl, '{"event":"run_start"}\n')
    age(jsonl)

    const eventsPath = join(home.stateDir, 'events.jsonl')
    writeFileSync(eventsPath, '{"n":1}\n{"n":2}\n{"n":3}\n')
    age(eventsPath)

    const before = await snapshotHome(auditDir)

    // The artifact trim goes first: the run-log prune at keep 0 would take the
    // artifact too, and the trim would then have nothing to show it acted.
    expect(await trimPluginHistory('p', 0, { runsDir: home.runsDir })).toBe(1)
    expect(await pruneRunLogs(home.runsDir, { days: 0, keep_per_plugin: 0, max_bytes: 0 }, new Set())).toBe(1)
    expect(await new JsonlRunLogger({ logsDir: join(home.root, 'logs'), runId: 'x' }).prune(0)).toBe(1)
    await _trimEventsLog(eventsPath, 1, 0)

    expect(readdirSync(home.runsDir)).toEqual([])
    expect(existsSync(jsonl)).toBe(false)
    expect(readFileSync(eventsPath, 'utf8')).toBe('{"n":3}\n')
    expect(await snapshotHome(auditDir)).toEqual(before)
  })

  test('the snapshot comparison reports one byte appended to a segment', async () => {
    await seedAudit()
    const copy = join(home.root, 'audit-copy')
    cpSync(auditDir, copy, { recursive: true })
    const before = await snapshotHome(copy)
    const first = segments(copy)[0] as string
    appendFileSync(join(copy, first), 'x')

    const after = await snapshotHome(copy)
    expect(after).not.toEqual(before)
    expect(after.filter((l) => !before.includes(l)).map((l) => l.split('|')[0])).toEqual([first])
  })
})
