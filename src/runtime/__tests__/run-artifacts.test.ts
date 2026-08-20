/**
 * run-artifacts tests.
 *
 * Uses mkdtemp for isolation. No mock.module (CLAUDE.md gotchas).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { warplineHome } from '../../lib/paths.js'
import {
  writeRunArtifact, appendRunLog, writeRunLog, trimPluginHistory,
  getRunsDir, type RunArtifact,
} from '../run-artifacts.js'

describe('run-artifacts', () => {
  let runsDir: string

  beforeEach(async () => {
    runsDir = await mkdtemp(join(tmpdir(), 'warpline-runs-'))
  })

  afterEach(async () => {
    await rm(runsDir, { recursive: true, force: true })
  })

  function makeArtifact(overrides: Partial<RunArtifact> = {}): RunArtifact {
    return {
      run_id: 'r1',
      plugin: 'test-plugin',
      started_at: '2026-04-20T00:00:00.000Z',
      completed_at: '2026-04-20T00:00:01.000Z',
      status: 'success',
      summary: 'ok',
      user_initiated: true,
      attempts: [{ attempt: 1, started_at: '2026-04-20T00:00:00.000Z', elapsed_ms: 50, status: 'success', error: null }],
      final_error: null,
      cancelled: false,
      timed_out: false,
      ...overrides,
    }
  }

  test('writeRunArtifact writes a JSON file with the expected shape', async () => {
    await writeRunArtifact(makeArtifact({ run_id: 'r-write-1' }), { runsDir })
    const raw = await readFile(join(runsDir, 'r-write-1.json'), 'utf8')
    const parsed = JSON.parse(raw)
    expect(parsed.run_id).toBe('r-write-1')
    expect(parsed.plugin).toBe('test-plugin')
    expect(parsed.user_initiated).toBe(true)
    expect(parsed.attempts).toHaveLength(1)
    expect(parsed.cancelled).toBe(false)
    expect(parsed.timed_out).toBe(false)
  })

  test('appendRunLog creates the log file and appends subsequent calls', async () => {
    await appendRunLog('r-log-1', 'first line', { runsDir })
    await appendRunLog('r-log-1', 'second line', { runsDir })
    const raw = await readFile(join(runsDir, 'r-log-1.log'), 'utf8')
    expect(raw).toContain('first line')
    expect(raw).toContain('second line')
  })

  test('writeRunLog inserts the === Attempt N === delimiter', async () => {
    await writeRunLog('r-log-2', 1, 'stdout from attempt 1\n', { runsDir })
    await writeRunLog('r-log-2', 2, 'stdout from attempt 2\n', { runsDir })
    const raw = await readFile(join(runsDir, 'r-log-2.log'), 'utf8')
    expect(raw).toContain('=== Attempt 1 ===')
    expect(raw).toContain('=== Attempt 2 ===')
    expect(raw.indexOf('=== Attempt 1 ===')).toBeLessThan(raw.indexOf('=== Attempt 2 ==='))
  })

  test('trimPluginHistory with 21 artifacts keeps the 20 newest and deletes oldest JSON + .log atomically', async () => {
    // Seed 21 artifacts for 'plugin-x' plus 1 log per artifact.
    for (let i = 0; i < 21; i++) {
      const runId = `plugin-x-${String(i).padStart(3, '0')}`
      const ts = new Date(Date.UTC(2026, 3, 1, 0, 0, i)).toISOString() // monotonically increasing
      await writeRunArtifact(makeArtifact({ run_id: runId, plugin: 'plugin-x', started_at: ts }), { runsDir })
      await appendRunLog(runId, `log-${i}`, { runsDir })
    }
    const evicted = await trimPluginHistory('plugin-x', 20, { runsDir })
    expect(evicted).toBe(1)
    const files = await readdir(runsDir)
    const jsonCount = files.filter((f) => f.endsWith('.json')).length
    const logCount = files.filter((f) => f.endsWith('.log')).length
    expect(jsonCount).toBe(20)
    expect(logCount).toBe(20)
    // The oldest (plugin-x-000) should be gone for both .json and .log.
    expect(files).not.toContain('plugin-x-000.json')
    expect(files).not.toContain('plugin-x-000.log')
  })

  test('trimPluginHistory with < 20 artifacts is a no-op', async () => {
    for (let i = 0; i < 5; i++) {
      const runId = `plugin-y-${i}`
      await writeRunArtifact(makeArtifact({ run_id: runId, plugin: 'plugin-y' }), { runsDir })
    }
    const evicted = await trimPluginHistory('plugin-y', 20, { runsDir })
    expect(evicted).toBe(0)
    const files = await readdir(runsDir)
    expect(files.filter((f) => f.endsWith('.json')).length).toBe(5)
  })

  test('trimPluginHistory does NOT touch other plugins artifacts', async () => {
    // 21 of plugin-a and 5 of plugin-b
    for (let i = 0; i < 21; i++) {
      const runId = `pa-${String(i).padStart(3, '0')}`
      const ts = new Date(Date.UTC(2026, 3, 1, 0, 0, i)).toISOString()
      await writeRunArtifact(makeArtifact({ run_id: runId, plugin: 'plugin-a', started_at: ts }), { runsDir })
      await appendRunLog(runId, `log`, { runsDir })
    }
    for (let i = 0; i < 5; i++) {
      const runId = `pb-${i}`
      await writeRunArtifact(makeArtifact({ run_id: runId, plugin: 'plugin-b' }), { runsDir })
      await appendRunLog(runId, `log`, { runsDir })
    }
    await trimPluginHistory('plugin-a', 20, { runsDir })
    const files = await readdir(runsDir)
    // plugin-a: 20 json + 20 log. plugin-b: 5 json + 5 log. Total 50.
    expect(files.filter((f) => f.startsWith('pa-') && f.endsWith('.json')).length).toBe(20)
    expect(files.filter((f) => f.startsWith('pa-') && f.endsWith('.log')).length).toBe(20)
    expect(files.filter((f) => f.startsWith('pb-') && f.endsWith('.json')).length).toBe(5)
    expect(files.filter((f) => f.startsWith('pb-') && f.endsWith('.log')).length).toBe(5)
  })

  test('trimPluginHistory skips malformed artifact files instead of throwing', async () => {
    await writeRunArtifact(makeArtifact({ run_id: 'good-1', plugin: 'plugin-mal' }), { runsDir })
    await mkdir(runsDir, { recursive: true })
    await writeFile(join(runsDir, 'broken.json'), 'not json')
    const evicted = await trimPluginHistory('plugin-mal', 20, { runsDir })
    expect(evicted).toBe(0)
    // Broken file stays untouched.
    const files = await readdir(runsDir)
    expect(files).toContain('broken.json')
    expect(files).toContain('good-1.json')
  })

  test('getRunsDir() with no override resolves to RUNS_DIR (env-overridable)', () => {
    const p = getRunsDir()
    expect(p.endsWith('/runs')).toBe(true)
    expect(p).toBe(join(warplineHome(), 'runs'))
  })

  test('getRunsDir(override) returns the override untouched', () => {
    expect(getRunsDir('/tmp/foo')).toBe('/tmp/foo')
  })
})
