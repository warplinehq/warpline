/**
 * TDD RED scaffold for the state manager.
 *
 * Tests define the expected behavior of state-manager.ts.
 * All tests should FAIL initially — the implementation does not exist yet.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { writeFile, readFile, mkdir, rm, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Import from the module we're about to build
import {
  withStateLock,
  readTasks,
  completeTask,
  deferTask,
  createTask,
  checkTaskLock,
  readEvents,
  appendEvent,
  mutateState,
  readAcks,
  writeAcks,
  toTaskDisplay,
  _setPaths, // test-only path injection
} from '../state-manager.js'
import { installStatePathIsolation } from '../../../test-utils/state-path-isolation.js'

let tmpDir: string
let stateDir: string

// Snapshot/restore the module-global StatePaths file-globally so this file's
// per-test `_setPaths` temp injection never leaks a deleted lock path to a
// sibling test file (D-01 — the actual Phase-2 leaker).
installStatePathIsolation()

beforeEach(async () => {
  tmpDir = join(tmpdir(), `warpline-sm-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  stateDir = join(tmpDir, 'state')
  await mkdir(stateDir, { recursive: true })

  // Inject test paths
  _setPaths({
    v2StatePath: join(stateDir, 'engine-state.json'),
    eventsPath: join(stateDir, 'events.jsonl'),
    acksPath: join(stateDir, 'acknowledgements.json'),
    lockPath: join(stateDir, '.state.lock'),
  })
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

// ── Helpers ──────────────────────────────────────────────────────

function minimalV2State(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    last_run_id: null,
    last_run_at: null,
    deferrals: [],
    task_aging: [],
    completed_tasks: [],
    plugin_runs: {},
    pending_gates: [],
    ...overrides,
  }
}

async function writeV2State(overrides: Record<string, unknown> = {}) {
  const path = join(stateDir, 'engine-state.json')
  await writeFile(path, JSON.stringify(minimalV2State(overrides), null, 2))
}

// ── withStateLock ────────────────────────────────────────────────

describe('withStateLock', () => {
  test('prevents concurrent execution — second call waits for first to complete', async () => {
    await writeV2State()
    const order: number[] = []

    const p1 = withStateLock(async () => {
      order.push(1)
      await Bun.sleep(100)
      order.push(2)
    })
    // Small delay to ensure p1 acquires lock first
    await Bun.sleep(10)
    const p2 = withStateLock(async () => {
      order.push(3)
    })

    await Promise.all([p1, p2])
    // If locking works: 1, 2, 3 (sequential). If not: 1, 3, 2 (interleaved)
    expect(order).toEqual([1, 2, 3])
  })

  test('auto-expires stale lock after 10s', async () => {
    await writeV2State()
    const lockPath = join(stateDir, '.state.lock')
    // Write a stale lock file with timestamp 11s in the past
    const staleTs = String(Date.now() - 11_000)
    await writeFile(lockPath, staleTs)

    // Should succeed quickly (stale lock broken) rather than waiting 10s
    const start = Date.now()
    await withStateLock(async () => { /* no-op */ })
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(2000) // Should be near-instant, not 10s
  })
})

// ── readTasks ────────────────────────────────────────────────────

describe('readTasks', () => {
  test('returns TaskDisplay[] with computed state, deferred_until, age_badge, created_at fields', async () => {
    const now = new Date().toISOString()
    const futureDate = new Date(Date.now() + 86400000).toISOString()

    await writeV2State({
      task_aging: [
        { task_id: 't1', first_flagged: now, description: 'Task one', severity: 'warning', run_count: 1, last_detail: '', source_check: 'plugin-a' },
        { task_id: 't2', first_flagged: now, description: 'Task two', severity: 'critical', run_count: 2, last_detail: 'det', source_check: 'plugin-b' },
      ],
      deferrals: [
        { task_id: 't1', reason: 'busy', deferred_at: now, expires_at: futureDate },
      ],
    })

    const tasks = await readTasks()
    expect(tasks.length).toBe(2)

    // Deferred task
    const deferred = tasks.find(t => t.task_id === 't1')!
    expect(deferred.state).toBe('deferred')
    expect(deferred.deferred_until).toBe(futureDate)
    expect(deferred.created_at).toBe(now) // mapped from first_flagged

    // Non-deferred task
    const pending = tasks.find(t => t.task_id === 't2')!
    expect(pending.state).toBe('pending')
    expect(pending.deferred_until).toBeNull()
    expect(typeof pending.age_badge).toBe('string')
    expect(pending.age_badge.length).toBeGreaterThan(0)
  })
})

// ── completeTask ─────────────────────────────────────────────────

describe('completeTask', () => {
  test('moves task from task_aging to completed_tasks with completed_at timestamp', async () => {
    const now = new Date().toISOString()
    await writeV2State({
      task_aging: [
        { task_id: 't1', first_flagged: now, description: 'Task one', severity: 'warning', run_count: 1, last_detail: '', source_check: '' },
      ],
    })

    await completeTask('t1')

    const raw = JSON.parse(await readFile(join(stateDir, 'engine-state.json'), 'utf-8'))
    expect(raw.task_aging).toHaveLength(0)
    expect(raw.completed_tasks).toHaveLength(1)
    expect(raw.completed_tasks[0].task_id).toBe('t1')
    expect(raw.completed_tasks[0].completed_at).toBeDefined()
  })
})

// ── deferTask ────────────────────────────────────────────────────

describe('deferTask', () => {
  test('adds entry to deferrals array', async () => {
    const now = new Date().toISOString()
    const futureDate = new Date(Date.now() + 86400000).toISOString()
    await writeV2State({
      task_aging: [
        { task_id: 't1', first_flagged: now, description: 'Task one', severity: 'info', run_count: 1, last_detail: '', source_check: '' },
      ],
    })

    await deferTask('t1', futureDate)

    const raw = JSON.parse(await readFile(join(stateDir, 'engine-state.json'), 'utf-8'))
    expect(raw.deferrals).toHaveLength(1)
    expect(raw.deferrals[0].task_id).toBe('t1')
    expect(raw.deferrals[0].expires_at).toBe(futureDate)
  })
})

// ── createTask ───────────────────────────────────────────────────

describe('createTask', () => {
  test('appends to task_aging with defaults for run_count, last_detail, source_check', async () => {
    await writeV2State()

    await createTask({
      task_id: 'new-1',
      first_flagged: new Date().toISOString(),
      description: 'New task',
      severity: 'warning',
      due_date: null,
    })

    const raw = JSON.parse(await readFile(join(stateDir, 'engine-state.json'), 'utf-8'))
    expect(raw.task_aging).toHaveLength(1)
    expect(raw.task_aging[0].task_id).toBe('new-1')
    expect(raw.task_aging[0].run_count).toBe(1)
    expect(raw.task_aging[0].last_detail).toBe('')
    expect(raw.task_aging[0].source_check).toBe('')
  })
})

// ── checkTaskLock ────────────────────────────────────────────────

describe('checkTaskLock', () => {
  test('returns true when source_check matches and task is active', async () => {
    const now = new Date().toISOString()
    await writeV2State({
      task_aging: [
        { task_id: 't1', first_flagged: now, description: 'Check', severity: 'warning', run_count: 1, last_detail: '', source_check: 'my-plugin' },
      ],
    })

    const locked = await checkTaskLock('my-plugin')
    expect(locked).toBe(true)
  })

  test('returns false when task is deferred', async () => {
    const now = new Date().toISOString()
    const futureDate = new Date(Date.now() + 86400000).toISOString()
    await writeV2State({
      task_aging: [
        { task_id: 't1', first_flagged: now, description: 'Check', severity: 'warning', run_count: 1, last_detail: '', source_check: 'my-plugin' },
      ],
      deferrals: [
        { task_id: 't1', reason: 'deferred', deferred_at: now, expires_at: futureDate },
      ],
    })

    const locked = await checkTaskLock('my-plugin')
    expect(locked).toBe(false)
  })
})

// ── readEvents / appendEvent ─────────────────────────────────────

describe('readEvents / appendEvent', () => {
  test('readEvents returns BoardEvent[] from events.jsonl', async () => {
    const eventsPath = join(stateDir, 'events.jsonl')
    const e1 = { event_id: 'e1', type: 'notice', timestamp: '2026-04-09T10:00:00Z', source: 'test', summary: 'Hello', severity: 'info', task_id: null, metadata_json: null }
    const e2 = { event_id: 'e2', type: 'notice', timestamp: '2026-04-09T11:00:00Z', source: 'test', summary: 'World', severity: 'info', task_id: null, metadata_json: null }
    await writeFile(eventsPath, JSON.stringify(e1) + '\n' + JSON.stringify(e2) + '\n')

    const events = await readEvents()
    expect(events).toHaveLength(2)
    expect(events[0].event_id).toBe('e1')
    expect(events[1].event_id).toBe('e2')
  })

  test('appendEvent appends a line to events.jsonl', async () => {
    await writeV2State()
    const event = { event_id: 'e3', type: 'notice' as const, timestamp: '2026-04-09T12:00:00Z', source: 'test', summary: 'Appended', severity: 'info' as const, task_id: null, metadata_json: null }

    await appendEvent(event)

    const content = await readFile(join(stateDir, 'events.jsonl'), 'utf-8')
    const lines = content.trim().split('\n')
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0])
    expect(parsed.event_id).toBe('e3')
  })
})

// ── mutateState ──────────────────────────────────────────────────

describe('mutateState', () => {
  test('applies function within lock and writes atomically', async () => {
    await writeV2State()

    await mutateState((s) => {
      s.task_aging.push({
        task_id: 'mut-1',
        first_flagged: new Date().toISOString(),
        description: 'Mutated',
        severity: 'info',
        run_count: 1,
        clean_streak: 0,
        last_detail: '',
        source_check: '',
        action_type: 'self_directed',
        extensions: {},
        due_date: null,
      })
    })

    const raw = JSON.parse(await readFile(join(stateDir, 'engine-state.json'), 'utf-8'))
    expect(raw.task_aging).toHaveLength(1)
    expect(raw.task_aging[0].task_id).toBe('mut-1')
  })
})

// ── readAcks / writeAcks ─────────────────────────────────────────

describe('readAcks / writeAcks', () => {
  test('round-trips acknowledgements', async () => {
    await writeV2State()
    const acks = { 'e1': { acknowledged_at: '2026-04-09T10:00:00Z', action_taken: 'acknowledge' as const } }

    await writeAcks(acks)
    const read = await readAcks()

    expect(read['e1']).toBeDefined()
    expect(read['e1'].action_taken).toBe('acknowledge')
  })
})
