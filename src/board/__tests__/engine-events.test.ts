/**
 * Tests for engine-events.ts — board event emission, gate persistence, task locking,
 * and reversibility propagation.
 *
 * Plan 84-02, Task 1 (TDD RED → GREEN)
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { grantApproval } from '../../runtime/approval-gate.js'
import { installStatePathIsolation } from '../../../test-utils/state-path-isolation.js'
import {
  emitBoardEvent,
  _trimEventsLog,
  emitRunStarted,
  emitRunCompleted,
  emitPluginStarted,
  emitPluginCompleted,
  emitPluginFailed,
  emitPluginSkipped,
  emitPluginGated,
  makeEvent,
} from '../engine-events.js'

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

let tmpDir: string
let eventsPath: string

beforeEach(async () => {
  tmpDir = join(tmpdir(), `engine-events-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  eventsPath = join(tmpDir, 'state', 'events.jsonl')
  // Do NOT pre-create the directory — tests verify auto-creation
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

async function readEvents(path: string): Promise<Record<string, unknown>[]> {
  const raw = await readFile(path, 'utf-8')
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
}

// -----------------------------------------------------------------------
// emitBoardEvent core tests
// -----------------------------------------------------------------------

describe('emitBoardEvent', () => {
  test('Test 1: appends one JSON line to events.jsonl', async () => {
    await mkdir(join(tmpDir, 'state'), { recursive: true })
    const event = makeEvent('notice', 'engine', 'hello world', 'run-abc')
    await emitBoardEvent(event, eventsPath)

    const events = await readEvents(eventsPath)
    expect(events).toHaveLength(1)
    expect(events[0]['type']).toBe('notice')
    expect(events[0]['summary']).toBe('hello world')
    expect(events[0]['source']).toBe('engine')
  })

  test('Test 2: creates parent directory if events.jsonl does not exist', async () => {
    // tmpDir doesn't exist at all yet — emitBoardEvent must create it
    const event = makeEvent('notice', 'engine', 'auto-create test', 'run-abc')
    await emitBoardEvent(event, eventsPath)

    const events = await readEvents(eventsPath)
    expect(events).toHaveLength(1)
  })

  test('Test 3: multiple calls append multiple lines (append-only)', async () => {
    for (let i = 0; i < 3; i++) {
      await emitBoardEvent(makeEvent('notice', 'engine', `event-${i}`, 'run-abc'), eventsPath)
    }
    const events = await readEvents(eventsPath)
    expect(events).toHaveLength(3)
    expect(events.map(e => e['summary'])).toEqual(['event-0', 'event-1', 'event-2'])
  })

  test('Test 4: each event has event_id, timestamp, type, source, summary, severity, task_id, metadata_json', async () => {
    const event = makeEvent('notice', 'engine', 'full fields', 'run-abc')
    await emitBoardEvent(event, eventsPath)
    const events = await readEvents(eventsPath)
    const e = events[0]
    expect(typeof e['event_id']).toBe('string')
    expect(typeof e['timestamp']).toBe('string')
    expect(e['type']).toBe('notice')
    expect(e['source']).toBe('engine')
    expect(e['summary']).toBe('full fields')
    expect(e['severity']).toBe('info')
    expect(e['task_id']).toBeNull()
    expect(e['metadata_json']).toBeNull()
  })
})

// -----------------------------------------------------------------------
// Convenience emitter tests
// -----------------------------------------------------------------------

describe('_trimEventsLog (events.jsonl size cap, 2026-08-19)', () => {
  test('trims to the newest cap lines once past cap + slack', async () => {
    await mkdir(join(tmpDir, 'state'), { recursive: true })
    const lines = Array.from({ length: 25 }, (_, i) => JSON.stringify({ i }))
    await writeFile(eventsPath, lines.join('\n') + '\n')

    await _trimEventsLog(eventsPath, 10, 5) // 25 > 10 + 5 -> trim
    const kept = (await readFile(eventsPath, 'utf-8')).trim().split('\n')
    expect(kept.length).toBe(10)
    expect(JSON.parse(kept[0]).i).toBe(15) // oldest dropped, newest kept
    expect(JSON.parse(kept[9]).i).toBe(24)
  })

  test('leaves the file alone inside the slack band (no rewrite churn)', async () => {
    await mkdir(join(tmpDir, 'state'), { recursive: true })
    const lines = Array.from({ length: 14 }, (_, i) => JSON.stringify({ i }))
    await writeFile(eventsPath, lines.join('\n') + '\n')

    await _trimEventsLog(eventsPath, 10, 5) // 14 <= 15 -> untouched
    const kept = (await readFile(eventsPath, 'utf-8')).trim().split('\n')
    expect(kept.length).toBe(14)
  })

  test('missing file is a no-op', async () => {
    await _trimEventsLog(join(tmpDir, 'state', 'nope.jsonl'), 10, 5)
  })
})

describe('emitRunStarted', () => {
  test('Test 5: emitRunStarted writes event with type=run_started, source=engine', async () => {
    await emitRunStarted('run-abc', eventsPath)
    const events = await readEvents(eventsPath)
    expect(events).toHaveLength(1)
    expect(events[0]['type']).toBe('run_started')
    expect(events[0]['source']).toBe('engine')
    expect((events[0]['summary'] as string)).toContain('run-abc')
  })
})

describe('emitRunCompleted', () => {
  test('Test 6: emitRunCompleted writes event with type=run_completed, source=engine', async () => {
    await emitRunCompleted('run-abc', 'complete', eventsPath)
    const events = await readEvents(eventsPath)
    expect(events).toHaveLength(1)
    expect(events[0]['type']).toBe('run_completed')
    expect(events[0]['source']).toBe('engine')
    expect((events[0]['summary'] as string)).toContain('run-abc')
  })
})

describe('emitPluginStarted', () => {
  test('Test 7: emitPluginStarted writes event with type=plugin_result, summary containing plugin name', async () => {
    await emitPluginStarted('source-scan', 'run-abc', eventsPath)
    const events = await readEvents(eventsPath)
    expect(events[0]['type']).toBe('plugin_result')
    expect((events[0]['summary'] as string)).toContain('source-scan')
  })
})

describe('emitPluginCompleted', () => {
  test('Test 8: emitPluginCompleted writes event with type=plugin_result', async () => {
    await emitPluginCompleted('source-scan', 'scan done', 'run-abc', eventsPath)
    const events = await readEvents(eventsPath)
    expect(events[0]['type']).toBe('plugin_result')
    expect((events[0]['summary'] as string)).toContain('source-scan')
  })
})

describe('emitPluginFailed', () => {
  test('Test 9: emitPluginFailed writes event with type=error, severity=warning', async () => {
    await emitPluginFailed('source-scan', 'timed out', 'run-abc', eventsPath)
    const events = await readEvents(eventsPath)
    expect(events[0]['type']).toBe('error')
    expect(events[0]['severity']).toBe('warning')
    expect((events[0]['summary'] as string)).toContain('source-scan')
  })
})

describe('emitPluginSkipped', () => {
  test('Test 10: emitPluginSkipped writes event with type=plugin_result, severity=info', async () => {
    await emitPluginSkipped('source-scan', 'already fresh', 'run-abc', eventsPath)
    const events = await readEvents(eventsPath)
    expect(events[0]['type']).toBe('plugin_result')
    expect(events[0]['severity']).toBe('info')
    expect((events[0]['summary'] as string)).toContain('source-scan')
    expect((events[0]['summary'] as string)).toContain('skipped')
  })
})

describe('emitPluginGated', () => {
  test('Test 11: emitPluginGated writes event with type=plugin_result, severity=warning, summary containing "awaiting approval"', async () => {
    await emitPluginGated('supervised-sender', 'run-abc', eventsPath)
    const events = await readEvents(eventsPath)
    expect(events[0]['type']).toBe('plugin_result')
    expect(events[0]['severity']).toBe('warning')
    expect((events[0]['summary'] as string)).toContain('awaiting approval')
    expect((events[0]['summary'] as string)).toContain('supervised-sender')
  })
})

// -----------------------------------------------------------------------
// Engine integration: runAdvance emits lifecycle events
// -----------------------------------------------------------------------

describe('runAdvance event emission', () => {
  // Test 15's dynamic-import `_setPaths` mutates the module-global StatePaths;
  // snapshot/restore it around this describe so the temp lock path never leaks
  // to a sibling test file.
  installStatePathIsolation()

  let pluginsDir: string
  let stateDir: string
  let runsDir: string
  let testEventsPath: string

  beforeEach(async () => {
    const base = join(tmpdir(), `advance-evt-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    pluginsDir = join(base, 'plugins')
    stateDir = join(base, 'state')
    runsDir = join(base, 'runs')
    testEventsPath = join(base, 'state', 'events.jsonl')
    await mkdir(pluginsDir, { recursive: true })
    await mkdir(stateDir, { recursive: true })
    await mkdir(runsDir, { recursive: true })
    // The source suite silently read the LIVE preferences file here (its
    // engine only knew the global path); warpline derives prefs from stateDir,
    // so give the block an explicit review_gate:false like the engine tests.
    await writeFile(join(stateDir, 'preferences.json'), JSON.stringify({ review_gate: false }))
  })

  afterEach(async () => {
    // cleanup handled by parent afterEach if using same tmpDir — independent here
  })

  async function createPlugin(
    name: string,
    autonomyLevel: 'autonomous' | 'supervised' | 'manual' = 'autonomous',
    reversible = false,
  ) {
    const dir = join(pluginsDir, name)
    await mkdir(dir, { recursive: true })
    const manifest = {
      name,
      version: '1.0.0',
      description: `${name} test plugin`,
      inputs: {},
      outputs: {},
      capabilities: [],
      schedule: 'on_run',
      autonomy_level: autonomyLevel,
      side_effects: autonomyLevel === 'supervised' ? ['writes_db'] : [],
      ttl_hours: 0.001,
      dependencies: [],
      timeout_ms: 5000,
      max_parallelism: 1,
    }
    await writeFile(join(dir, 'manifest.ts'), `export const manifest = ${JSON.stringify(manifest)}`)
    await writeFile(
      join(dir, 'handler.ts'),
      `
export async function handler(manifest, args) {
  return {
    status: 'success',
    phases_completed: ['${name}'],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: '${name} completed',
    artifacts_produced: [],
    schema_version: 1,
    ${reversible ? `reversible: true, undo_instruction: 'Close issue #42',` : ''}
  }
}
`,
    )
  }

  test('Test 12: runAdvance emits run_started at beginning and run_completed at end', async () => {
    const { runAdvance } = await import('../../runtime/engine.js')
    await createPlugin('emit-test-plugin')

    await runAdvance({
      pluginsDir,
      stateDir: join(stateDir, 'engine-state.json'),
      runsDir,
      eventsPath: testEventsPath,
    })

    const events = await readEvents(testEventsPath)
    const types = events.map(e => e['type'])
    expect(types[0]).toBe('run_started')
    expect(types[types.length - 1]).toBe('run_completed')
  })

  test('Test 13: runAdvance emits plugin_started and plugin_completed for each executed plugin', async () => {
    const { runAdvance } = await import('../../runtime/engine.js')
    await createPlugin('plugin-evt-a')
    await createPlugin('plugin-evt-b')

    await runAdvance({
      pluginsDir,
      stateDir: join(stateDir, 'engine-state.json'),
      runsDir,
      eventsPath: testEventsPath,
    })

    const events = await readEvents(testEventsPath)
    const summaries = events.map(e => e['summary'] as string)
    // Should contain "started" for each plugin
    const startedEvents = summaries.filter(s => s.includes('started'))
    expect(startedEvents.length).toBeGreaterThanOrEqual(2)
    // Should contain plugin_result events for completions
    const pluginResultEvents = events.filter(e => e['type'] === 'plugin_result')
    expect(pluginResultEvents.length).toBeGreaterThanOrEqual(2)
  })

  test('Test 14: gate payload stored in pending_gates includes plugin_result from handler', async () => {
    const { runAdvance } = await import('../../runtime/engine.js')
    const { readFile: rf } = await import('node:fs/promises')
    await createPlugin('supervised-gate', 'supervised')

    // Grant approval so supervised plugin with side_effects passes the approval gate
    const approvalPath = join(stateDir, '.session-approval')
    await grantApproval('supervised-gate', undefined, approvalPath)

    await runAdvance({
      pluginsDir,
      stateDir: join(stateDir, 'engine-state.json'),
      runsDir,
      eventsPath: testEventsPath,
      approvalPath,
    })

    const stateRaw = await rf(join(stateDir, 'engine-state.json'), 'utf-8')
    const state = JSON.parse(stateRaw)
    expect(state.pending_gates).toBeDefined()
    expect(state.pending_gates.length).toBeGreaterThan(0)
    const gate = state.pending_gates[0]
    expect(gate.plugin).toBe('supervised-gate')
    expect(gate.plugin_result).toBeDefined()
    expect(gate.plugin_result.summary).toBeDefined()
  })

  test('Test 15: task lock check reads v2 task_aging, skips plugin with active task matching source_check', async () => {
    const { runAdvance } = await import('../../runtime/engine.js')
    const { _setPaths } = await import('../state-manager.js')
    await createPlugin('locked-plugin')

    // Write a v2 state with a task in task_aging that locks the plugin
    const v2StatePath = join(stateDir, 'engine-state.json')
    const stateWithLockedTask = {
      schema_version: 1,
      last_run_id: null,
      last_run_at: null,
      deferrals: [],
      task_aging: [
        { task_id: 'task-1', first_flagged: new Date().toISOString(), description: 'test', severity: 'warning', run_count: 1, last_detail: '', source_check: 'locked-plugin' },
      ],
      completed_tasks: [],
      plugin_runs: {},
      pending_gates: [],
    }
    await writeFile(v2StatePath, JSON.stringify(stateWithLockedTask))

    // Point state-manager at the test directory
    _setPaths({
      v2StatePath,
      eventsPath: testEventsPath,
      acksPath: join(stateDir, 'acknowledgements.json'),
      lockPath: join(stateDir, '.state.lock'),
    })

    const result = await runAdvance({
      pluginsDir,
      stateDir: v2StatePath,
      runsDir,
      eventsPath: testEventsPath,
    })

    expect(result.plugin_states.get('locked-plugin')).toBe('skipped')
  })

  test('Test 16: handler returning reversible=true and undo_instruction appears in run log plugin_entries', async () => {
    const { runAdvance } = await import('../../runtime/engine.js')
    const { readFile: rf } = await import('node:fs/promises')
    await createPlugin('reversible-plugin', 'autonomous', true)

    const result = await runAdvance({
      pluginsDir,
      stateDir: join(stateDir, 'engine-state.json'),
      runsDir,
      eventsPath: testEventsPath,
    })

    const logRaw = await rf(result.run_log_path, 'utf-8')
    const log = JSON.parse(logRaw)
    const entry = log.plugin_entries.find((e: Record<string, unknown>) => e['plugin'] === 'reversible-plugin')
    expect(entry).toBeDefined()
    expect(entry['reversible']).toBe(true)
    expect(entry['undo_instruction']).toBe('Close issue #42')
  })

  test('Test 17: handler returning no reversible field results in undefined reversible in log entry', async () => {
    const { runAdvance } = await import('../../runtime/engine.js')
    const { readFile: rf } = await import('node:fs/promises')
    await createPlugin('non-reversible-plugin', 'autonomous', false)

    const result = await runAdvance({
      pluginsDir,
      stateDir: join(stateDir, 'engine-state.json'),
      runsDir,
      eventsPath: testEventsPath,
    })

    const logRaw = await rf(result.run_log_path, 'utf-8')
    const log = JSON.parse(logRaw)
    const entry = log.plugin_entries.find((e: Record<string, unknown>) => e['plugin'] === 'non-reversible-plugin')
    expect(entry).toBeDefined()
    // reversible should be undefined or absent when not set by handler
    expect(entry['reversible']).toBeUndefined()
  })

  test('Test 18: every event an advance emits names that advance', async () => {
    const { runAdvance } = await import('../../runtime/engine.js')
    await createPlugin('linked-plugin')

    const result = await runAdvance({
      pluginsDir,
      stateDir: join(stateDir, 'engine-state.json'),
      runsDir,
      eventsPath: testEventsPath,
    })

    const events = await readEvents(testEventsPath)
    expect(events.length).toBeGreaterThan(0)
    const unlinked = events.filter(e => e['run_id'] !== result.run_id)
    expect(unlinked).toEqual([])
  })
})


// -----------------------------------------------------------------------
// Run linkage (R4) — an Ask can name the Run that raised it
// -----------------------------------------------------------------------

describe('run linkage on emitted events', () => {
  installStatePathIsolation()

  test('an event emitted with a run id carries it as a top-level field', async () => {
    await mkdir(join(tmpDir, 'state'), { recursive: true })
    await emitBoardEvent(makeEvent('notice', 'engine', 'linked', 'run-abc'), eventsPath)

    const events = await readEvents(eventsPath)
    expect(events[0]!['run_id']).toBe('run-abc')
    // Never smuggled into metadata_json — a Board that has to JSON.parse a
    // string to find the run cannot index on it.
    expect(events[0]!['metadata_json']).toBeNull()
  })

  test('an event emitted outside any run carries null, not a guess', async () => {
    await mkdir(join(tmpDir, 'state'), { recursive: true })
    await emitBoardEvent(makeEvent('notice', 'engine:tier-transition', 'Entered dormant mode', null), eventsPath)

    const events = await readEvents(eventsPath)
    expect(events[0]!['run_id']).toBeNull()
  })

  test('the convenience emitters thread the run id too', async () => {
    await mkdir(join(tmpDir, 'state'), { recursive: true })
    await emitRunStarted('run-abc', eventsPath)
    await emitPluginStarted('source-scan', 'run-abc', eventsPath)
    await emitPluginCompleted('source-scan', 'done', 'run-abc', eventsPath)
    await emitPluginFailed('source-scan', 'boom', 'run-abc', eventsPath)
    await emitPluginSkipped('source-scan', 'fresh', 'run-abc', eventsPath)
    await emitPluginGated('supervised-sender', 'run-abc', eventsPath)
    await emitRunCompleted('run-abc', 'complete', eventsPath)

    const events = await readEvents(eventsPath)
    expect(events).toHaveLength(7)
    expect(events.map(e => e['run_id'])).toEqual(Array(7).fill('run-abc'))
  })

  /**
   * The read-compat shim, asserted rather than assumed. `readEvents` safeParses
   * each line independently and pushes only on success, so a line written
   * before this field existed is exactly the thing a defaultless field would
   * drop — silently, and for the whole log.
   */
  test('a raw events.jsonl line written without a run_id key is still read back', async () => {
    const { readEvents: readEventsThroughSchema, _setPaths } = await import('../state-manager.js')
    const stateDir = join(tmpDir, 'state')
    await mkdir(stateDir, { recursive: true })

    const historical = {
      event_id: 'evt-historical',
      type: 'notice',
      timestamp: '2026-01-01T00:00:00Z',
      source: 'engine',
      summary: 'written before run linkage existed',
      severity: 'info',
      task_id: null,
      metadata_json: null,
    }
    expect('run_id' in historical).toBe(false)
    await writeFile(eventsPath, JSON.stringify(historical) + '\n', 'utf-8')

    _setPaths({
      v2StatePath: join(stateDir, 'engine-state.json'),
      eventsPath,
      acksPath: join(stateDir, 'acknowledgements.json'),
      lockPath: join(stateDir, '.state.lock'),
    })

    const read = await readEventsThroughSchema()
    expect(read).toHaveLength(1)
    expect(read[0]!.event_id).toBe('evt-historical')
    expect(read[0]!.run_id).toBeNull()
  })
})
