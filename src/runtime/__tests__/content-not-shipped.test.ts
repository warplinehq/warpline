/**
 * An indeterminate content fire, answered by the operator as not shipped.
 *
 * **What an unanswered fire is.** Before a content consumer's handler runs, the
 * runtime marks its approval spent (`marked_at`, `effect_id`). When the advance
 * sees the handler finish, it confirms the mark (`confirmed_at`). A handler that
 * returns `failed`, or a process that dies mid-call, leaves the mark and no
 * confirmation. The runtime cannot tell from there whether the bytes reached
 * the sink: a `failed` return may come after a send that landed. So it refuses
 * `indeterminate` on every advance, and it never clears the mark on a handler's
 * word.
 *
 * **Why the answer is the operator's, and why it binds to one effect id.** The
 * sink is the only place the question is settled, and the runtime cannot see
 * it. The operator can, with the effect id in hand. So the answer is their
 * word, recorded as their word, and it names the one fire they checked. An id
 * that does not match is a different fire, or a typo, and neither is answered.
 *
 * **Why it is its own verb.** `approve` says yes to bytes for fires to come.
 * This answers a claim about a fire that already began, and it grants nothing,
 * so it does not live under `approve`.
 *
 * **Why an answered record reads spent, not live.** The answer says the bytes
 * did not ship. It does not say the operator still wants them shipped, or that
 * the bytes are still the ones they read. A retry is a second yes, given with
 * `approve --content` over bytes the operator reads again, and until then
 * nothing fires. That is what the first case pins between the answer and the
 * re-approval.
 *
 * **Why the four cases together.** One predicate says whether a marked fire is
 * still unanswered, and three places read it: the standing the gate reports,
 * the sweep that drops closed approvals, and the rule that releases content a
 * closed approval binds. The first two cases pin the standing, the third the
 * sweep, and the fourth the release. Any one reader left on its own copy of the
 * predicate turns one of them red.
 *
 * **The invocation count is a directory of sentinel files outside the home.**
 * A file per invocation is what the handler did, and the count tells one fire
 * from two. Outside the home because `cleanup()` removes everything under it,
 * which would make an absence assertion true for the wrong reason
 * (`content-spend-mark.test.ts` states the same rule).
 *
 * Writes only into a temp home and one temp directory beside it.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  eraseIfReleased,
  proposalFingerprint,
  runAdvance,
  type AdvanceOptions,
  type AdvanceResult,
} from '../engine.js'
import { defaultEngineState } from '../../schemas/engine-state.js'
import type { Approval, EngineState } from '../../schemas/engine-state.js'
import { PluginManifestSchema } from '../../schemas/plugin-manifest.js'
import type { PluginManifest } from '../../schemas/plugin-manifest.js'
import { _setHome } from '../../lib/paths.js'
import { createTestHome, type TestHome } from './helpers/create-test-home.js'

const PRODUCER = 'invoice-builder'
const CONSUMER = 'invoice-sender'

/** The bytes the operator reads and approves. The producer always returns them. */
const BODY = '{"batch":"the four invoices the operator read"}'

/** A wall clock far enough out that no test run reaches it. */
const FAR_FUTURE = '2099-01-01T00:00'

/** The instant the planted records were answered. */
const ANSWERED_AT = '2026-09-26T10:00:00.000Z'

let home: TestHome
/** One file per consumer invocation. The COUNT is the assertion. */
let firedDir: string
/** While this exists, the consumer returns `failed`. */
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

const RESULT_FIELDS = `phases_failed: [],
    data_freshness: {},
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
      ttl_hours: 24,
      dependencies: [],
    }),
  )
  await writeFile(
    join(producerDir, 'handler.ts'),
    `export async function handler() {
  return {
    status: 'success',
    phases_completed: ['run'],
    errors: [],
    summary: 'built',
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
      // Near zero, so the consumer is stale on every advance and reaches the
      // content gate rather than the freshness one.
      ttl_hours: 0.001,
      dependencies: [PRODUCER],
    }),
  )
  // The sentinel is written first, whatever the handler goes on to return: a
  // `failed` return is a send that may have landed, never one that did not.
  await writeFile(
    join(consumerDir, 'handler.ts'),
    `import { existsSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
export async function handler() {
  writeFileSync(${JSON.stringify(firedDir)} + '/' + randomUUID(), 'fired')
  if (existsSync(${JSON.stringify(marker)})) {
    return {
      status: 'failed',
      phases_completed: [],
      errors: [{ phase: 'run', message: 'the sink answered 500', recoverable: false }],
      summary: 'the send reported a failure',
      ${RESULT_FIELDS}
      artifacts_produced: [],
    }
  }
  return {
    status: 'success',
    phases_completed: ['run'],
    errors: [],
    summary: 'sent',
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

async function readState(): Promise<EngineState> {
  return JSON.parse(await readFile(statePath(), 'utf-8')) as EngineState
}

/**
 * The CLI in-process through the dispatcher, both streams captured, so a
 * refusal names itself in a failing assertion.
 */
async function cli(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const { main } = await import('../../cli/warpline.js')
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
    return { code: await main(argv), stdout, stderr }
  } finally {
    process.stdout.write = realOut
    process.stderr.write = realErr
  }
}

/** The operator reads the producer's bytes and approves them. */
async function approveWhatWasRead(): Promise<void> {
  const approved = await cli(['approve', CONSUMER, '--content', '--not-after', FAR_FUTURE])
  expect(approved.stderr).toBe('')
  expect(approved.code).toBe(0)
}

/**
 * Rewrite the consumer's record on disk as a fire the operator already
 * answered, keeping everything else the approval wrote.
 */
async function plantAnswered(over: Record<string, unknown> = {}): Promise<void> {
  const doc = JSON.parse(await readFile(statePath(), 'utf-8')) as {
    approvals: Record<string, Record<string, unknown>>
  }
  doc.approvals[CONSUMER] = {
    ...doc.approvals[CONSUMER],
    effect_id: 'c'.repeat(64),
    marked_at: '2026-09-26T09:00:00.000Z',
    confirmed_at: null,
    not_shipped_at: ANSWERED_AT,
    ...over,
  }
  await writeFile(statePath(), JSON.stringify(doc))
}

beforeEach(async () => {
  home = await createTestHome()
  _setHome(home.root)
  firedDir = join(tmpdir(), `warpline-not-shipped-fired-${randomUUID()}`)
  mkdirSync(firedDir, { recursive: true })
  marker = join(home.root, 'FAIL_THE_SEND_NOW')
  await writePlugins()
})

afterEach(async () => {
  _setHome(null)
  await home.cleanup()
  rmSync(firedDir, { recursive: true, force: true })
})

describe('an indeterminate content fire the operator resolved as not shipped', () => {
  test('a failed fire refuses until it is resolved as not shipped, and a re-approval then fires it once', async () => {
    await advance()
    await approveWhatWasRead()

    writeFileSync(marker, 'x')
    await advance()

    expect(firedCount()).toBe(1)
    expect((await readState()).plugin_runs[CONSUMER]!.status).toBe('failed')
    const marked = (await readState()).approvals[CONSUMER]!
    expect(marked.marked_at).not.toBeNull()
    expect(marked.confirmed_at).toBeNull()

    // The sink is healthy again, and the runtime still will not guess.
    rmSync(marker)
    const held = await advance({ force: true })
    expect(firedCount()).toBe(1)
    expect(held.refused_plugins).toEqual([{ plugin: CONSUMER, reason: 'indeterminate' }])

    // The operator checked the sink with the effect id and found nothing.
    const answered = await cli(['resolve', CONSUMER, '--not-shipped', marked.effect_id as string])
    expect(answered.stderr).toBe('')
    expect(answered.code).toBe(0)

    // Answered is not approved: nothing fires and nothing is refused.
    const quiet = await advance({ force: true })
    expect(firedCount()).toBe(1)
    expect(quiet.refused_plugins).toEqual([])

    await approveWhatWasRead()
    const retried = await advance({ force: true })

    expect(firedCount()).toBe(2)
    expect(retried.refused_plugins).toEqual([])
    expect((await readState()).plugin_runs[CONSUMER]!.status).toBe('success')
    expect((await readState()).approvals[CONSUMER]!.confirmed_at).not.toBeNull()
  })

  test('a resolved record reads spent, names when it was resolved, and refuses nothing', async () => {
    await advance()
    await approveWhatWasRead()
    await plantAnswered()

    const reasons: string[] = []
    const result = await advance({
      force: true,
      onPluginEnd: (plugin, _status, _elapsed, reason) => {
        if (plugin === CONSUMER && reason !== undefined) reasons.push(reason)
      },
    })

    expect(firedCount()).toBe(0)
    expect(result.refused_plugins).toEqual([])
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toContain('answered not shipped')
    expect(reasons[0]).toContain(ANSWERED_AT)
  })

  test('a resolved record is swept once its window closes', async () => {
    await advance()
    await approveWhatWasRead()
    await plantAnswered({ not_after: '2020-01-01T00:00', zone: 'UTC' })

    await advance()

    // Kept, it would say nothing a closed window does not already say. Only
    // an unanswered fire is kept past its window, as the evidence it is.
    expect(Object.hasOwn((await readState()).approvals, CONSUMER)).toBe(false)
  })

  test('a resolved record releases content it binds by fingerprint when its window closes', () => {
    const producerManifest: PluginManifest = PluginManifestSchema.parse({
      name: PRODUCER,
      version: '1.0.0',
      description: 'producer',
      autonomy_level: 'autonomous',
      ttl_hours: 24,
    })
    const manifests = new Map([[PRODUCER, producerManifest]])

    const answered = defaultEngineState()
    answered.plugin_runs[PRODUCER] = {
      last_run_at: '2026-09-26T09:30:00.000Z',
      status: 'success',
      run_id: 'run-later',
      last_output: { type: 'brief', format: 'json', body: BODY, run_id: 'run-later' },
    }
    // Bound to an earlier run of the same bytes, so only the fingerprint can
    // match. A binding by run would pass whatever the predicate said.
    answered.approvals[CONSUMER] = {
      plugin: CONSUMER,
      producer: PRODUCER,
      fingerprint: proposalFingerprint(answered, PRODUCER, producerManifest),
      run_id: 'run-earlier',
      approved_at: '2019-12-01T00:00:00.000Z',
      not_before: null,
      not_after: '2020-01-01T00:00',
      zone: 'UTC',
      effect_id: 'c'.repeat(64),
      marked_at: '2019-12-02T00:00:00.000Z',
      confirmed_at: null,
      not_shipped_at: ANSWERED_AT,
    } as Approval

    // The same state, the fire never answered.
    const unanswered = structuredClone(answered)
    const { not_shipped_at: _answer, ...open } = unanswered.approvals[CONSUMER] as Approval & {
      not_shipped_at?: string
    }
    unanswered.approvals[CONSUMER] = open as Approval

    const now = Date.now()
    eraseIfReleased(answered.plugin_runs, answered.pending_gates, PRODUCER, answered.approvals, manifests, now)
    eraseIfReleased(unanswered.plugin_runs, unanswered.pending_gates, PRODUCER, unanswered.approvals, manifests, now)

    // Answered, it binds by fingerprint as a confirmed fire does, so its
    // closed window releases the bytes.
    expect(answered.plugin_runs[PRODUCER]!.last_output!.erased_at).toBeDefined()
    expect(answered.plugin_runs[PRODUCER]!.last_output!.body).toBeUndefined()
    // Unanswered, it binds by run only, so identical bytes from a later run are
    // not released on its account.
    expect(unanswered.plugin_runs[PRODUCER]!.last_output!.body).toBe(BODY)
  })
})
