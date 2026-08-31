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
// sibling test file — which is where the leak actually came from.
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
    const event = { event_id: 'e3', type: 'notice' as const, timestamp: '2026-04-09T12:00:00Z', source: 'test', summary: 'Appended', severity: 'info' as const, task_id: null, run_id: null, metadata_json: null }

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
        first_run_id: null,
        last_flagged_run_id: null,
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

// ── Run reference resolution ─────────────────────────────────────

/**
 * A run id outlives the run log it names: `pruneRunLogs` deletes on mtime past
 * 30 days, and nothing rewrites the identifiers pointing at what it deleted.
 * Deleting a dangling pointer to dodge the case would lose the only record
 * that the run ever happened, so the readers resolve through one helper that
 * names the three states instead.
 */
describe('run reference resolution', () => {
  let runsBase: string

  beforeEach(async () => {
    runsBase = join(tmpDir, 'runs')
    await mkdir(runsBase, { recursive: true })
  })

  async function seedRunLog(runId: string): Promise<void> {
    const { RunLogSchema } = await import('../../schemas/run-log.js')
    const { writeRunLog } = await import('../../runtime/run-log-store.js')
    await writeRunLog(
      RunLogSchema.parse({
        run_id: runId,
        started_at: '2026-08-01T10:00:00Z',
        completed_at: '2026-08-01T10:00:05Z',
        status: 'complete',
          summary: 'seeded',
      }),
      runsBase,
    )
  }

  test('an event whose run log is on disk resolves to that run', async () => {
    const { resolveRunRef } = await import('../../runtime/run-log-store.js')
    await writeV2State()
    await seedRunLog('run-live')
    await appendEvent({
      event_id: 'e-live', type: 'notice' as const, timestamp: '2026-08-01T10:00:01Z',
      source: 'engine', summary: 'live', severity: 'info' as const,
      task_id: null, run_id: 'run-live', metadata_json: null,
    })

    const [event] = await readEvents()
    const ref = resolveRunRef(event!.run_id, runsBase)
    expect(ref).toEqual({ kind: 'retained', run_id: 'run-live' })
  })

  test('an event whose run log has been pruned resolves to not-retained, and says so', async () => {
    const { resolveRunRef, describeRunRef } = await import('../../runtime/run-log-store.js')
    await writeV2State()
    await seedRunLog('run-aged')
    await appendEvent({
      event_id: 'e-aged', type: 'notice' as const, timestamp: '2026-08-01T10:00:01Z',
      source: 'engine', summary: 'aged', severity: 'info' as const,
      task_id: null, run_id: 'run-aged', metadata_json: null,
    })
    await unlink(join(runsBase, 'run-aged.json'))

    const [event] = await readEvents()
    let ref!: ReturnType<typeof resolveRunRef>
    expect(() => { ref = resolveRunRef(event!.run_id, runsBase) }).not.toThrow()
    expect(ref.kind).toBe('not_retained')

    const rendered = describeRunRef(ref)
    expect(rendered).not.toBe('')
    expect(rendered).toContain('no longer retained')
  })

  test('an event carrying no run id renders as no run — not as not-retained', async () => {
    const { resolveRunRef, describeRunRef } = await import('../../runtime/run-log-store.js')
    await writeV2State()
    await appendEvent({
      event_id: 'e-null', type: 'notice' as const, timestamp: '2026-08-01T10:00:01Z',
      source: 'engine', summary: 'outside any run', severity: 'info' as const,
      task_id: null, run_id: null, metadata_json: null,
    })

    const [event] = await readEvents()
    const ref = resolveRunRef(event!.run_id, runsBase)
    expect(ref).toEqual({ kind: 'none' })
    // The two absences are different facts: never part of a run, versus a run
    // whose record aged out. Collapsing them loses the second one.
    expect(describeRunRef(ref)).not.toContain('no longer retained')
    expect(describeRunRef(ref)).not.toBe(describeRunRef({ kind: 'not_retained', run_id: 'x' }))
  })

  test('the same helper resolves a last_output pointer whose producing run is gone', async () => {
    const { resolveRunRef } = await import('../../runtime/run-log-store.js')
    await seedRunLog('run-output')

    // The shape plan 02 writes into plugin_runs — a pointer carrying the run
    // that produced it. It dangles exactly the way an event's run_id does, and
    // resolves through the same symbol so the two renderings cannot drift.
    const lastOutput = { type: 'brief', format: 'markdown', path: 'brief.md', run_id: 'run-output' }
    expect(resolveRunRef(lastOutput.run_id, runsBase).kind).toBe('retained')

    await unlink(join(runsBase, 'run-output.json'))
    expect(resolveRunRef(lastOutput.run_id, runsBase).kind).toBe('not_retained')
  })
})
