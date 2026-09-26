/**
 * A content consumer fires only on the Output its producer's latest run
 * produced.
 *
 * **The root cause.** The runtime carries a producer's last Output forward
 * across a run that produced none, on purpose: `last_output` is a fact about the
 * plugin, and a `lastOutput` reader must not conclude it never produced. But a
 * content approval is a yes to the producer's CURRENT proposal. A producer that
 * ran, succeeded and returned nothing has proposed nothing, and the bytes an
 * operator approved before it are a leftover. The fingerprint cannot see that:
 * it is computed over the carried bytes, which are the approved ones, so it
 * still matches. Without a separate fact about which run wrote the Output, the
 * approval outlives the run that should have replaced it and the consumer ships
 * bytes nobody is proposing any more.
 *
 * **Fixture plugins, not a shipped example.** The cadence example met this
 * first, and its producer now returns an empty outbox on a quiet run rather
 * than no Output. That fix is right and it stays, but it masks this route: the
 * shipped producer can no longer return nothing, so it cannot exercise the
 * runtime's own answer. Any producer an adopter writes can. The fixture here is
 * the smallest one that does: a producer that returns one fixed Output unless a
 * marker file exists, and then succeeds with none.
 *
 * **Why the second case exists.** A producer that ran and produced nothing is
 * usually still fresh on the next advance, so it is not re-run and nothing in
 * that advance says it produced nothing. A check made only inside the advance
 * that ran it would let the next advance ship the stale bytes. The refusal has
 * to rest on something durable, and that case is what fails if it does not.
 *
 * **Why the two controls are evidence.** Four cases say the consumer does not
 * fire or the approval does not bind. On their own they would also pass for a
 * runtime that refused every content fire. The two controls prove the ordinary
 * paths still fire exactly once: a producer still fresh from the run the
 * operator read, and a producer that re-produced the same bytes, which keep the
 * approval live because the fingerprint is over the bytes and never the run.
 *
 * **The invocation count is a directory of sentinel files outside the home.**
 * A reason string is the runtime's account of what it decided. A file per
 * invocation is what the handler did. Outside the home because `cleanup()`
 * removes everything under it, which would make an absence assertion true for
 * the wrong reason (`content-spend-mark.test.ts` states the same rule).
 *
 * Writes only into a temp home and one temp directory beside it.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAdvance, type AdvanceOptions, type AdvanceResult } from '../engine.js'
import type { EngineState } from '../../schemas/engine-state.js'
import { _setHome } from '../../lib/paths.js'
import { createTestHome, type TestHome } from './helpers/create-test-home.js'

const PRODUCER = 'quiet-producer'
const CONSUMER = 'quiet-sender'

/** The bytes the operator reads and approves. */
const BODY = '{"batch":"the three invoices the operator read"}'

/** A wall clock far enough out that no test run reaches it. */
const FAR_FUTURE = '2099-01-01T00:00'

const HOUR_MS = 60 * 60 * 1000

let home: TestHome
/** One file per consumer invocation. The COUNT is the assertion. */
let firedDir: string
/** When this exists, the producer succeeds and returns no Output. */
let marker: string

const statePath = (): string => join(home.stateDir, 'engine-state.json')
const firedCount = (): number => readdirSync(firedDir).length

function manifestSource(fields: Record<string, unknown>): string {
  return `export const manifest = ${JSON.stringify({
    version: '1.0.0',
    inputs: {},
    capabilities: [],
    schedule: 'on_run',
    autonomy_level: 'autonomous',
    timeout_ms: 5000,
    max_retries: 0,
    retry_delay_ms: 10,
    max_parallelism: 1,
    min_tier: 'suspended',
    ...fields,
  })}`
}

const RESULT_FIELDS = `status: 'success',
    phases_completed: ['run'],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: 'ran',
    schema_version: 1,`

async function writePlugins(): Promise<void> {
  const producerDir = join(home.pluginsDir, PRODUCER)
  await mkdir(producerDir, { recursive: true })
  await writeFile(
    join(producerDir, 'manifest.ts'),
    manifestSource({
      name: PRODUCER,
      description: 'producer',
      outputs: { brief: { type: 'json' } },
      side_effects: [],
      approval_class: 'session',
      // Fresh for a day, so an advance an hour on skips it and reads what its
      // last run left.
      ttl_hours: 24,
      dependencies: [],
    }),
  )
  await writeFile(
    join(producerDir, 'handler.ts'),
    `import { existsSync } from 'node:fs'
export async function handler() {
  if (existsSync(${JSON.stringify(marker)})) {
    return {
    ${RESULT_FIELDS}
    artifacts_produced: [],
  }
  }
  return {
    ${RESULT_FIELDS}
    artifacts_produced: [{ type: 'brief', format: 'json', body: ${JSON.stringify(BODY)} }],
  }
}
`,
  )

  const consumerDir = join(home.pluginsDir, CONSUMER)
  await mkdir(consumerDir, { recursive: true })
  await writeFile(
    join(consumerDir, 'manifest.ts'),
    manifestSource({
      name: CONSUMER,
      description: 'consumer',
      outputs: {},
      side_effects: ['sends_email'],
      approval_class: 'content',
      // Near zero, so the consumer is due on every advance and reaches the
      // content gate. A fresh consumer would be held by the freshness gate,
      // and the case would be about the wrong guard.
      ttl_hours: 0.001,
      dependencies: [PRODUCER],
    }),
  )
  await writeFile(
    join(consumerDir, 'handler.ts'),
    `import { writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
export async function handler() {
  writeFileSync(${JSON.stringify(firedDir)} + '/' + randomUUID(), 'sent')
  return {
    ${RESULT_FIELDS}
    artifacts_produced: [],
  }
}
`,
  )
}

/** One advance, with every path pinned to the temp home. */
async function advance(opts: Partial<AdvanceOptions> = {}): Promise<AdvanceResult> {
  return runAdvance({
    pluginsDir: home.pluginsDir,
    stateDir: statePath(),
    runsDir: home.runsDir,
    eventsPath: join(home.runsDir, 'events.jsonl'),
    approvalPath: join(home.root, '.session-approval'),
    preferencesPath: join(home.stateDir, 'preferences.json'),
    ...opts,
  })
}

/** An advance that records the reason `onPluginEnd` gave for the consumer. */
async function advanceNoting(
  opts: Partial<AdvanceOptions> = {},
): Promise<{ result: AdvanceResult; reasons: string[] }> {
  const reasons: string[] = []
  const result = await advance({
    ...opts,
    onPluginEnd: (plugin, status, elapsed, reason) => {
      opts.onPluginEnd?.(plugin, status, elapsed, reason)
      if (plugin === CONSUMER && reason !== undefined) reasons.push(reason)
    },
  })
  return { result, reasons }
}

async function readState(): Promise<EngineState> {
  return JSON.parse(await readFile(statePath(), 'utf-8')) as EngineState
}

/**
 * `warpline approve` in-process, both streams captured, so a refusal names
 * itself in a failing assertion.
 */
async function approve(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const { run } = await import('../../cli/approve.js')
  const realOut = process.stdout.write.bind(process.stdout)
  const realErr = process.stderr.write.bind(process.stderr)
  let stdout = ''
  let stderr = ''
  const sink = (into: (s: string) => void) =>
    ((chunk: string | Uint8Array): boolean => {
      into(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'))
      return true
    }) as typeof process.stdout.write
  process.stdout.write = sink((s) => (stdout += s))
  process.stderr.write = sink((s) => (stderr += s))
  try {
    return { code: await run(argv), stdout, stderr }
  } finally {
    process.stdout.write = realOut
    process.stderr.write = realErr
  }
}

const approveContent = () => approve([CONSUMER, '--content', '--not-after', FAR_FUTURE])

/** The operator reads the producer's bytes and approves them. */
async function approveWhatWasRead(): Promise<void> {
  const approved = await approveContent()
  expect(approved.stderr).toBe('')
  expect(approved.code).toBe(0)
  expect(approved.stdout).toContain('the three invoices the operator read')
}

beforeEach(async () => {
  home = await createTestHome()
  _setHome(home.root)
  firedDir = join(tmpdir(), `warpline-carried-fired-${randomUUID()}`)
  mkdirSync(firedDir, { recursive: true })
  marker = join(home.root, 'PRODUCE_NOTHING_NOW')
  await writePlugins()
})

afterEach(async () => {
  _setHome(null)
  await home.cleanup()
  rmSync(firedDir, { recursive: true, force: true })
})

describe('a content consumer fires only on the Output its producer last produced', () => {
  test('a producer run that produces nothing voids the approved bytes for its content consumer', async () => {
    await advance()
    await approveWhatWasRead()

    writeFileSync(marker, 'x')
    const { result, reasons } = await advanceNoting({ force: true })

    // The handler never ran. First, because it is the whole claim.
    expect(firedCount()).toBe(0)
    expect(result.refused_plugins).toEqual([{ plugin: CONSUMER, reason: 'content_moved' }])
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toContain('produced no Output')
    expect((await readState()).approvals[CONSUMER]!.marked_at).toBeNull()
  })

  test('the next advance, with that producer still fresh, does not ship them either', async () => {
    await advance()
    await approveWhatWasRead()
    writeFileSync(marker, 'x')
    await advance({ force: true })

    // An hour on and unforced: the producer is inside its 24 h TTL, so it is
    // not re-run, and nothing in this advance says it produced nothing.
    const quietRun = (await readState()).plugin_runs[PRODUCER]!.last_run_at
    const { result } = await advanceNoting({ now: Date.now() + HOUR_MS })

    expect(firedCount()).toBe(0)
    // Skipped as fresh: its entry is the one the quiet run wrote.
    expect((await readState()).plugin_runs[PRODUCER]!.last_run_at).toBe(quietRun)
    expect(result.refused_plugins).toEqual([{ plugin: CONSUMER, reason: 'content_moved' }])
  })

  test('a producer still fresh from the run the operator read keeps the approval live', async () => {
    await advance()
    await approveWhatWasRead()

    const { result } = await advanceNoting({ now: Date.now() + HOUR_MS })

    expect(firedCount()).toBe(1)
    expect(result.refused_plugins).toEqual([])
  })

  test('a producer that re-produces the same bytes keeps the approval live', async () => {
    await advance()
    await approveWhatWasRead()

    const { result } = await advanceNoting({ force: true })

    expect(firedCount()).toBe(1)
    expect(result.refused_plugins).toEqual([])
  })

  test("approve --content refuses bytes the producer's latest run did not produce", async () => {
    await advance()
    writeFileSync(marker, 'x')
    await advance({ force: true })

    const refused = await approveContent()

    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain('latest run produced no Output')
    expect(refused.stderr).toContain('Nothing was written')
    expect(Object.hasOwn((await readState()).approvals, CONSUMER)).toBe(false)
  })

  test('the spend mark refuses bytes a carried write left under it after the gate read them', async () => {
    await advance()
    await approveWhatWasRead()

    /** Whether the planted write really found an entry to rewrite. */
    let planted = false
    // The producer re-produces the same bytes, so the gate, reading this
    // advance's in-memory state, finds the approval live. Its `onPluginEnd`
    // is the only hook between the two levels: synchronously, it rewrites the
    // document on disk so the producer's entry reads carried, as another
    // advance's write landing after this one's run lock expired would. The
    // spend mark re-reads the disk under its lock, and that is what must
    // refuse. The approval is left exactly as read, or the case would refuse
    // at the missing-record check above the one it exists for.
    const { result, reasons } = await advanceNoting({
      force: true,
      onPluginEnd: (plugin) => {
        if (plugin !== PRODUCER) return
        const doc = JSON.parse(readFileSync(statePath(), 'utf-8')) as EngineState
        const entry = doc.plugin_runs[PRODUCER] as Record<string, unknown> | undefined
        if (entry === undefined) return
        entry['run_id'] = 'a-later-run'
        writeFileSync(statePath(), JSON.stringify(doc))
        planted = doc.plugin_runs[PRODUCER]!.last_output?.run_id !== 'a-later-run'
      },
    })

    expect(firedCount()).toBe(0)
    expect(planted).toBe(true)
    expect(result.refused_plugins).toEqual([{ plugin: CONSUMER, reason: 'content_moved' }])
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toStartWith(
      'refused (content_moved): the approved content moved or was erased between the gate and the spend mark',
    )
  })
})
