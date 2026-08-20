/**
 * Wave 0 — JSONL run logger tests (append + 30-day prune)
 *
 * Covers decisions:
 *   D-11: JsonlRunLogger appends structured JSON lines to {logsDir}/runs/{YYYY-MM-DD}.jsonl
 *   D-12: Each line is a valid RunJsonlEvent with ts, run_id, level, event fields
 *   D-13: prune(days) removes JSONL files older than N days; retains newer files
 *
 * STATUS: RED — `.warpline/shared/jsonl-logger.ts` does not yet exist.
 * Wave 2 Plan 02 Task 3 will create it and turn these green.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, rm, readFile, utimes } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { JsonlRunLogger } from '../jsonl-logger.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function todayDateString(): string {
  return new Date().toISOString().slice(0, 10) // YYYY-MM-DD
}

// ---------------------------------------------------------------------------
// Test fixture
// ---------------------------------------------------------------------------

let tmpDir: string
let logsDir: string
let logger: InstanceType<typeof JsonlRunLogger>

const TEST_RUN_ID = 'run-jsonl-test-001'

beforeEach(async () => {
  tmpDir = join(tmpdir(), `warpline-jsonl-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  logsDir = join(tmpDir, 'logs')
  await mkdir(logsDir, { recursive: true })

  // Instantiate logger pointing at isolated tmpDir (D-11)
  logger = new JsonlRunLogger({ logsDir, runId: TEST_RUN_ID })
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('JsonlRunLogger — appendEvent (D-11/D-12)', () => {
  test('Test 1: Single appendEvent creates {date}.jsonl with one newline-terminated line', async () => {
    await logger.appendEvent({ level: 'info', event: 'run_started' })

    const expectedFile = join(logsDir, 'runs', `${todayDateString()}.jsonl`)
    expect(existsSync(expectedFile)).toBe(true)

    const content = await readFile(expectedFile, 'utf8')

    // Must be exactly one line, terminated with \n (D-11)
    const lines = content.split('\n').filter(l => l.length > 0)
    expect(lines).toHaveLength(1)

    // Line must be valid JSON
    const parsed = JSON.parse(lines[0])
    expect(parsed).toBeTruthy()
  })

  test('Test 2: Two appendEvents → two lines, each valid JSON', async () => {
    await logger.appendEvent({ level: 'info', event: 'run_started' })
    await logger.appendEvent({ level: 'info', event: 'run_completed' })

    const expectedFile = join(logsDir, 'runs', `${todayDateString()}.jsonl`)
    const content = await readFile(expectedFile, 'utf8')

    const lines = content.split('\n').filter(l => l.length > 0)
    expect(lines).toHaveLength(2)

    // Both must be valid JSON
    for (const line of lines) {
      const parsed = JSON.parse(line) // must not throw
      expect(parsed).toBeTruthy()
    }
  })

  test('Test 4 (schema): Each event line contains required fields ts, run_id, level, event', async () => {
    // D-12: RunJsonlEvent schema requires ts, run_id, level, event
    await logger.appendEvent({ level: 'warn', event: 'plugin_skipped', plugin: 'fx-test' })

    const expectedFile = join(logsDir, 'runs', `${todayDateString()}.jsonl`)
    const content = await readFile(expectedFile, 'utf8')
    const lines = content.split('\n').filter(l => l.length > 0)

    const event = JSON.parse(lines[0])

    // Required fields per D-12 RunJsonlEvent schema
    expect(typeof event.ts).toBe('string')
    expect(event.ts.length).toBeGreaterThan(0)
    expect(event.run_id).toBe(TEST_RUN_ID)
    expect(event.level).toBe('warn')
    expect(event.event).toBe('plugin_skipped')
  })
})

describe('JsonlRunLogger — prune (D-13)', () => {
  test('Test 3: prune(30) removes files older than 30 days, retains newer files', async () => {
    const runsSubdir = join(logsDir, 'runs')
    await mkdir(runsSubdir, { recursive: true })

    // Seed an OLD file (31 days ago) — should be removed by prune(30)
    const oldFile = join(runsSubdir, '2025-01-01.jsonl')
    await rm(oldFile, { force: true })
    const oldContent = JSON.stringify({ ts: '2025-01-01T00:00:00Z', run_id: 'old', level: 'info', event: 'x' }) + '\n'
    // Write file then backdate its mtime to 31 days ago
    const { writeFile: wf } = await import('node:fs/promises')
    await wf(oldFile, oldContent, 'utf8')
    const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000)
    await utimes(oldFile, thirtyOneDaysAgo, thirtyOneDaysAgo)

    // Seed a CURRENT file (today) — should be retained
    const newFile = join(runsSubdir, `${todayDateString()}.jsonl`)
    await wf(newFile, JSON.stringify({ ts: new Date().toISOString(), run_id: 'new', level: 'info', event: 'y' }) + '\n', 'utf8')

    // Run prune with 30-day retention window
    await logger.prune(30)

    // Old file should be gone
    expect(existsSync(oldFile)).toBe(false)

    // New file should still exist
    expect(existsSync(newFile)).toBe(true)
  })
})
