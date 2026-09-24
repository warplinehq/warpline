/**
 * A write that lands while an advance runs is still there after the advance.
 *
 * `runAdvance` reads the state document at the top and writes it at the end,
 * and it holds no state lock across its plugins. Every other writer of the
 * document takes that lock and can land in between: `deny`, `deny --remove`,
 * `approve` answering a parked gate, `approve --content` and its withdrawal,
 * the board, and a second advance that healed this one's run lock by its
 * two-hour TTL. The end-of-run write starts from a fresh read taken inside the
 * state lock and applies only what this advance changed, field by field. A
 * field it has no change for is written as the fresh read holds it.
 *
 * **One case per writer, driven by the real writer.** Each concurrent write is
 * made by an interloper plugin that calls the real command or library function
 * mid-advance, then re-reads the document and throws unless its own write
 * landed. A thrown handler records the interloper `failed`, so every case first
 * asserts the interloper's recorded status. That is the positive control: the
 * end assertions below it cannot pass on a write that never happened.
 *
 * The withdrawal and the apply cases live in `gate-content-erasure.test.ts`,
 * beside the erasure they also pin.
 *
 * Every structural assertion reads through `readEngineState`, the product's
 * fail-closed read.
 *
 * Writes only inside its temp home. Nothing under the repository is touched.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _setHome } from '../../lib/paths.js'
import { _setPaths, createTask, mutateState, pathsForStateFile } from '../../board/state-manager.js'
import type { EngineState, PendingGate } from '../../schemas/engine-state.js'
import { readEngineState } from '../engine-state-store.js'
import { createTestHome, type TestHome } from './helpers/create-test-home.js'

let home: TestHome
let statePath: string

const HOUR = 3_600_000
const DAY = 24 * HOUR

const APPROVE = fileURLToPath(new URL('../../cli/approve.ts', import.meta.url))
const DENY = fileURLToPath(new URL('../../cli/deny.ts', import.meta.url))
const BOARD = fileURLToPath(new URL('../../board/state-manager.ts', import.meta.url))

/** The state document through the product's own fail-closed read. */
function stored(): Promise<EngineState> {
  return readEngineState(statePath)
}

function gateOf(state: EngineState, plugin: string): PendingGate {
  const gate = state.pending_gates.find((g) => g.plugin === plugin)
  expect(gate).toBeDefined()
  return gate!
}

function manifest(name: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    version: '1.0.0',
    description: `${name} fixture`,
    inputs: {},
    outputs: {},
    capabilities: [],
    secrets: [],
    schedule: 'on_run',
    autonomy_level: 'autonomous',
    approval_class: 'session',
    llm_handoff: false,
    side_effects: [],
    ttl_hours: 24,
    dependencies: [],
    timeout_ms: 5000,
    max_parallelism: 1,
    min_tier: 'normal',
    max_retries: 1,
    retry_delay_ms: 2000,
    ...extra,
  }
}

async function writePlugin(name: string, m: Record<string, unknown>, handler: string): Promise<void> {
  const dir = join(home.pluginsDir, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'manifest.ts'), `export const manifest = ${JSON.stringify(m)}`)
  await writeFile(join(dir, 'handler.ts'), handler)
}

/** A producer whose one Output carries the sentinel, built at runtime from an environment variable. */
const PRODUCER = `
export async function handler() {
  return { status: 'success', phases_completed: ['prod'], phases_failed: [], errors: [],
    data_freshness: {}, summary: 'prod produced', schema_version: 1,
    artifacts_produced: [{ type: 'brief', format: 'text', body: 'approved-content:' + process.env.WARPLINE_MERGE_SENTINEL }] }
}
`

/** Run a CLI verb in-process with its output silenced, returning the exit code. */
async function cli(verb: 'approve' | 'deny', argv: string[]): Promise<number> {
  const realOut = process.stdout.write
  const realErr = process.stderr.write
  process.stdout.write = (() => true) as typeof process.stdout.write
  process.stderr.write = (() => true) as typeof process.stderr.write
  try {
    const { run } = await import(verb === 'approve' ? APPROVE : DENY)
    return await run(argv)
  } finally {
    process.stdout.write = realOut
    process.stderr.write = realErr
  }
}

function advanceOptions() {
  return {
    pluginsDir: home.pluginsDir,
    stateDir: statePath,
    runsDir: home.runsDir,
    eventsPath: join(home.runsDir, 'events.jsonl'),
    approvalPath: join(home.root, '.session-approval'),
  }
}

async function advance(now?: number): Promise<{ run_id: string }> {
  const { runAdvance } = await import('../engine.js')
  return runAdvance({ ...advanceOptions(), ...(now === undefined ? {} : { now }) })
}

/**
 * Installs `interloper`, whose handler runs `script` and then returns success.
 * The script sees `quiet(fn)`, which silences a CLI verb's output, and
 * `onDisk()`, which re-reads the raw state document. It throws unless its own
 * write landed. Installed only when the case is ready, so it runs on the next
 * advance and never before.
 */
async function interloper(script: string, extra: Record<string, unknown> = {}): Promise<void> {
  await writePlugin(
    'interloper',
    manifest('interloper', { ttl_hours: 1, ...extra }),
    `
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
async function quiet(fn) {
  const out = process.stdout.write
  const err = process.stderr.write
  process.stdout.write = () => true
  process.stderr.write = () => true
  try { return await fn() }
  finally { process.stdout.write = out; process.stderr.write = err }
}
function onDisk() {
  return JSON.parse(readFileSync(${JSON.stringify(statePath)}, 'utf-8'))
}
export async function handler() {
${script}
  return { status: 'success', phases_completed: ['interloper'], phases_failed: [], errors: [],
    data_freshness: {}, summary: 'interloper ran', schema_version: 1, artifacts_produced: [] }
}
`,
  )
}

beforeEach(async () => {
  home = await createTestHome({ preferences: { review_gate: true } })
  statePath = join(home.stateDir, 'engine-state.json')
  _setHome(home.root)
  // The board's writers lock and write whatever the state manager's module
  // paths name. Pointed at this home, for the test and for the interloper,
  // which imports the same module.
  _setPaths(pathsForStateFile(statePath))
  process.env.WARPLINE_MERGE_SENTINEL = randomUUID()
})

afterEach(async () => {
  _setPaths(null)
  _setHome(null)
  delete process.env.WARPLINE_MERGE_SENTINEL
  await home.cleanup()
})

describe('a denial that lands mid-advance', () => {
  /** Parks prod's gate, then denies prod mid-advance. Returns the state after it. */
  async function denyMidAdvance(): Promise<{ s: EngineState; parked: PendingGate }> {
    await writePlugin('prod', manifest('prod'), PRODUCER)
    await advance()
    const parked = gateOf(await stored(), 'prod')
    expect(parked.applied_at).toBeNull()
    await interloper(`
  const { run } = await import(${JSON.stringify(DENY)})
  const code = await quiet(() => run(['prod']))
  if (code !== 0) throw new Error('deny exited ' + code)
  const doc = onDisk()
  if (doc.denials.prod === undefined) throw new Error('the denial is not on disk')
  if (doc.pending_gates.some((g) => g.plugin === 'prod')) throw new Error('the gate was not discarded')
`)
    await advance(Date.now() + 2 * HOUR)
    const s = await stored()
    // The positive control: the interloper returned, so its own checks passed.
    expect(s.plugin_runs.interloper?.status).toBe('gated')
    return { s, parked }
  }

  test('is still recorded after the advance', async () => {
    const { s } = await denyMidAdvance()
    expect(Object.keys(s.denials)).toEqual(['prod'])
  })
})

test('a denial removed mid-advance stays removed', async () => {
  await writePlugin('prod', manifest('prod'), PRODUCER)
  expect(await cli('deny', ['prod'])).toBe(0)
  expect(Object.keys((await stored()).denials)).toEqual(['prod'])

  await interloper(`
  const { run } = await import(${JSON.stringify(DENY)})
  const code = await quiet(() => run(['--remove', 'prod']))
  if (code !== 0) throw new Error('deny --remove exited ' + code)
  if (onDisk().denials.prod !== undefined) throw new Error('the denial is still on disk')
`)
  await advance()
  const s = await stored()
  expect(s.plugin_runs.interloper?.status).toBe('gated')
  expect(s.denials).toEqual({})
})

describe('a board write that lands mid-advance', () => {
  function task(task_id: string, severity: 'warning' | 'info') {
    return { task_id, first_flagged: new Date().toISOString(), description: `${task_id} fixture`, severity, due_date: null }
  }

  const COMPLETE = `
  const { completeTask } = await import(${JSON.stringify(BOARD)})
  await completeTask('task-done')
  const doc = onDisk()
  if (doc.task_aging.some((t) => t.task_id === 'task-done')) throw new Error('the task is still open on disk')
  if (!doc.completed_tasks.some((t) => t.task_id === 'task-done')) throw new Error('the completion is not on disk')
`

  test('a completion is still recorded after the advance', async () => {
    await createTask(task('task-done', 'warning'))
    await interloper(COMPLETE)
    await advance()
    const s = await stored()
    expect(s.plugin_runs.interloper?.status).toBe('gated')
    expect(s.task_aging).toEqual([])
    expect(s.completed_tasks.map((t) => t.task_id)).toEqual(['task-done'])
  })

  test('a degraded advance auto-defers the task still open, and the completion stands', async () => {
    await createTask(task('task-quiet', 'info'))
    await createTask(task('task-done', 'info'))
    // Three days idle is the degraded tier. The interloper runs in any tier.
    await mutateState((s) => {
      s.last_interaction_at = new Date(Date.now() - 3 * DAY).toISOString()
    })
    await interloper(COMPLETE, { min_tier: 'suspended' })
    await advance()
    const s = await stored()
    expect(s.plugin_runs.interloper?.status).toBe('gated')
    expect(s.completed_tasks.map((t) => t.task_id)).toEqual(['task-done'])
    expect(s.task_aging.map((t) => t.task_id)).toEqual(['task-quiet'])
    // No deferral for the task that is no longer open.
    expect(s.deferrals.map((d) => [d.task_id, d.reason])).toEqual([['task-quiet', 'Auto-deferred: degraded tier']])
  })

  test('a suspended advance archives the task still open, and the completion stands', async () => {
    await createTask(task('task-quiet', 'info'))
    await createTask(task('task-done', 'info'))
    // Fifteen days idle is the suspended tier.
    await mutateState((s) => {
      s.last_interaction_at = new Date(Date.now() - 15 * DAY).toISOString()
    })
    await interloper(COMPLETE, { min_tier: 'suspended' })
    await advance()
    const s = await stored()
    expect(s.plugin_runs.interloper?.status).toBe('gated')
    expect(s.completed_tasks.map((t) => t.task_id)).toEqual(['task-done'])
    expect(s.task_aging.map((t) => [t.task_id, typeof t.archived_at])).toEqual([['task-quiet', 'string']])
  })
})

/**
 * The end-of-run merge stays in one locked region.
 *
 * `engine.ts` says a gate counts the state lock's name and holds it at two:
 * the import and the one call inside `lockStateDocument`. Nothing counted it
 * until this. The lock is a non-reentrant `O_EXCL` file, so a second region
 * nested in the first self-deadlocks for ten seconds and then throws. A bound
 * on the name is the cheapest way to notice one appearing. The wrapper's own
 * calls are bounded the same way: the spend mark's region and the end-of-run
 * region, and no third.
 *
 * Exact counts, never a floor. A read that found nothing fails both.
 */
describe('the state lock is taken in exactly two places in engine.ts', () => {
  const source = readFileSync(fileURLToPath(new URL('../engine.ts', import.meta.url)), 'utf-8')
  const count = (needle: string): number => source.split(needle).length - 1

  test('the lock name appears twice: the import and the wrapper', () => {
    expect(count('withStateLockAt')).toBe(2)
  })

  test('the wrapper is called twice: the spend mark and the end-of-run write', () => {
    expect(count('lockStateDocument(')).toBe(2)
  })
})
