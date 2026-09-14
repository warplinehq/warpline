/**
 * An item that fired is never re-fired, and a crash mid-send says so rather
 * than guessing.
 *
 * The phase's second mandated red-first test. Two halves, and neither is
 * evidence without the other:
 *
 *   THE KILL CASE, the one that matters. A child process runs a real advance
 *   against a temp home; its handler writes a sentinel the instant it is
 *   entered and then blocks. The parent SIGKILLs the child once that sentinel
 *   appears — uncatchable, which is the honest simulation of the process crash
 *   the durability ceiling is stated against, and the one signal `warpline
 *   advance`'s own SIGINT/SIGTERM handler cannot turn into an orderly exit. A
 *   SECOND advance then runs against the same home and must NOT fire again.
 *
 *   THE POSITIVE HALF, proving the kill case is not vacuous. The same fixture
 *   without the kill completes, the record reads `confirmed_at` non-null, and a
 *   subsequent advance reports ordinary not-due naming the spent approval and
 *   the instant it fired. `already_spent` is a state report, not a refusal, so
 *   `refused_plugins` is empty for it.
 *
 * **The assertion is a directory of sentinel files written OUTSIDE the test
 * home, not a reason string.** A reason string is the runtime's account of what
 * it decided; a file per invocation is what the handler actually did, and a
 * COUNT is what tells one fire from two. Outside the home because `cleanup()`
 * removes anything under it whether the handler wrote it or not, which would
 * make an absence assertion true for the wrong reason — the sibling
 * `content-approval-gate.test.ts` states the same rule at greater length.
 *
 * **The handler's block is released by a file, not by a timer.** `import()`
 * caches the module, so a handler whose behaviour must differ between two
 * advances has to branch on something outside itself — the mechanism
 * `helpers/two-advance-home.ts` uses, for the same reason. Without the release
 * the second advance's re-fire would block until the suite timeout, and a
 * timeout is a thrown error rather than a failed assertion: it would prove
 * nothing about a mark that does not exist.
 *
 * Writes only into a temp home and two temp paths beside it. Nothing under the
 * repository is touched.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { contentEffectId, proposalFingerprint, runAdvance } from '../engine.js'
import { PluginManifestSchema } from '../../schemas/plugin-manifest.js'
import type { PluginManifest } from '../../schemas/plugin-manifest.js'
import { defaultEngineState } from '../../schemas/engine-state.js'
import type { EngineState } from '../../schemas/engine-state.js'
import type { OutputRecord } from '../../schemas/skill-result.js'
import { createTestHome, type TestHome } from './helpers/create-test-home.js'
import { _setHome } from '../../lib/paths.js'
import { testFixturesDir } from '../../../test-utils/fixtures.js'

/** The bin entry, not the engine module: the child runs the path a scheduler runs. */
const ENTRY = testFixturesDir(import.meta.url, '../../bin/warpline.ts')

/** The bytes the operator read and approved. */
const APPROVED_BODY = '{"batch":"the twelve invoices the operator read"}'

const PRODUCER = 'batch-builder'
const CONSUMER = 'batch-sender'

const outputOf = (body: string): OutputRecord => ({
  type: 'brief',
  format: 'json',
  body,
})

/** The one `SkillResult` every fixture handler returns. */
const RESULT = `{
    status: 'success',
    phases_completed: ['run'],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: 'ran',
    artifacts_produced: [],
    schema_version: 1,
  }`

/** A wall clock far enough out that no test run reaches it. */
const FAR_FUTURE = '2099-01-01T00:00'
const ZONE = 'UTC'

let home: TestHome
/** One file per handler invocation. The COUNT is the assertion. */
let firedDir: string
/** The handler blocks until this exists. Never created before the kill. */
let releasePath: string

async function writeProducer(): Promise<void> {
  const dir = join(home.pluginsDir, PRODUCER)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'manifest.ts'),
    `export const manifest = ${JSON.stringify({
      name: PRODUCER,
      version: '1.0.0',
      description: 'producer',
      inputs: {},
      outputs: {},
      capabilities: [],
      schedule: 'on_run',
      autonomy_level: 'autonomous',
      side_effects: [],
      approval_class: 'session',
      // Fresh for a day. A producer that re-runs overwrites its own
      // `last_output`, and the bytes the approval is bound to would move
      // underneath the gate before it ever read them.
      ttl_hours: 24,
      dependencies: [],
      timeout_ms: 5000,
      max_retries: 0,
      retry_delay_ms: 10,
      max_parallelism: 1,
      min_tier: 'suspended',
    })}`,
  )
  await writeFile(join(dir, 'handler.ts'), `export async function handler() {\n  return ${RESULT}\n}\n`)
}

/** How the consumer's handler behaves once it has been entered. */
type ConsumerMode =
  /** Return success immediately. */
  | 'returns'
  /** Wait on the release file, so the parent can kill it mid-invocation. */
  | 'blocks'
  /** Return a `SkillResult` whose status is `failed`. */
  | 'fails'

/**
 * The consumer: content class, one declared dependency, one declared effect.
 *
 * The sentinel is written FIRST in every mode, before the handler does anything
 * else, so the parent can see it was entered whatever it goes on to do — and so
 * the `fails` mode is a send that may well have landed rather than one that
 * demonstrably did not.
 */
async function writeConsumer(mode: ConsumerMode): Promise<void> {
  const dir = join(home.pluginsDir, CONSUMER)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'manifest.ts'),
    `export const manifest = ${JSON.stringify({
      name: CONSUMER,
      version: '1.0.0',
      description: 'consumer',
      inputs: {},
      outputs: {},
      capabilities: [],
      schedule: 'on_run',
      autonomy_level: 'autonomous',
      side_effects: ['sends_email'],
      approval_class: 'content',
      // Near zero, so the consumer is stale on EVERY advance and reaches the
      // approval gate. At the default 24h the second advance in the positive
      // half would be held by the freshness gate instead, and the assertion
      // would be about the wrong guard.
      ttl_hours: 0.001,
      dependencies: [PRODUCER],
      // Far above any wait this test performs: the kill lands in milliseconds,
      // and an invocation timeout firing first would be a retry writing a
      // second sentinel for a reason that has nothing to do with the mark.
      timeout_ms: 120_000,
      max_retries: 0,
      retry_delay_ms: 10,
      max_parallelism: 1,
      min_tier: 'suspended',
    })}`,
  )
  // Both paths are baked in as literals rather than read from the environment:
  // the child resolves nothing of its own, and `import()` caches the module, so
  // a handler deciding anything at call time is one more thing this file cannot
  // see go wrong.
  const block =
    mode === 'blocks'
      ? `  while (!existsSync(${JSON.stringify(releasePath)})) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }\n`
      : ''
  // A valid `SkillResult` whose status is `failed`. The `errors` entry is
  // spelled out because the schema requires the shape, and a fixture the
  // runtime rejects would record `failed` for the wrong reason.
  const returned =
    mode === 'fails'
      ? `{
    status: 'failed',
    phases_completed: [],
    phases_failed: ['run'],
    errors: [{ phase: 'run', message: 'the sink answered 500', recoverable: false }],
    data_freshness: {},
    summary: 'the send reported a failure',
    artifacts_produced: [],
    schema_version: 1,
  }`
      : RESULT
  await writeFile(
    join(dir, 'handler.ts'),
    `import { writeFileSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
export async function handler() {
  writeFileSync(${JSON.stringify(firedDir)} + '/' + randomUUID(), 'the effect fired')
${block}  return ${returned}
}
`,
  )
}

const statePath = (): string => join(home.stateDir, 'engine-state.json')

/** How many times the consumer's handler has been entered, across all processes. */
const firedCount = (): number => readdirSync(firedDir).length

/**
 * The producer's manifest as the runtime parses it, so the fingerprint this
 * file computes comes from the same arithmetic the gate uses rather than from a
 * hand-built lookalike.
 */
function producerManifest(): PluginManifest {
  return PluginManifestSchema.parse({
    name: PRODUCER,
    version: '1.0.0',
    description: 'producer',
    autonomy_level: 'autonomous',
    ttl_hours: 24,
  })
}

/** A state document in which the producer has already run and is still fresh. */
function seedState(body: string): EngineState {
  const state = defaultEngineState()
  state.plugin_runs[PRODUCER] = {
    last_run_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    status: 'success',
    last_output: outputOf(body),
  }
  return state
}

/** The approval the operator wrote, bound to the fingerprint of `approvedBody`. */
function approvalFor(approvedBody: string): EngineState['approvals'][string] {
  return {
    plugin: CONSUMER,
    producer: PRODUCER,
    fingerprint: proposalFingerprint(seedState(approvedBody), PRODUCER, producerManifest()),
    run_id: 'run-the-operator-read',
    approved_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    not_before: null,
    not_after: FAR_FUTURE,
    zone: ZONE,
    effect_id: null,
    marked_at: null,
    confirmed_at: null,
  }
}

/** The whole fixture: both plugins, and a live approval over unmoved bytes. */
async function seedLiveApproval(mode: ConsumerMode): Promise<void> {
  await writeProducer()
  await writeConsumer(mode)
  const state = seedState(APPROVED_BODY)
  state.approvals[CONSUMER] = approvalFor(APPROVED_BODY)
  await writeFile(statePath(), JSON.stringify(state))
}

interface AdvanceHooks {
  onPluginEnd?: (plugin: string, status: string, elapsed: number, reason?: string) => void
  /**
   * The injected clock, threaded into every guard's reads.
   *
   * An advance moments after a fire finds the consumer inside its own TTL and
   * is held by the FRESHNESS gate — which is not the guard any case here is
   * about and reports no reason to `onPluginEnd`. Moving the clock forward is
   * the right lever and `force` is not: `force` would also un-freshen the
   * PRODUCER, which is session-class under `review_gate: true`, so it would
   * park a gate, stop the level loop, and the consumer would never be
   * evaluated at all.
   */
  now?: number
}

async function advance(hooks: AdvanceHooks = {}): Promise<Awaited<ReturnType<typeof runAdvance>>> {
  return runAdvance({
    pluginsDir: home.pluginsDir,
    stateDir: statePath(),
    runsDir: home.runsDir,
    eventsPath: join(home.runsDir, 'events.jsonl'),
    approvalPath: join(home.root, '.session-approval'),
    preferencesPath: join(home.stateDir, 'preferences.json'),
    ...hooks,
  })
}

async function readState(): Promise<EngineState> {
  return JSON.parse(await readFile(statePath(), 'utf-8')) as EngineState
}

async function waitFor(predicate: () => boolean, what: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(what)
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  }
}

beforeEach(async () => {
  // The SHIPPED default, not the helper's test-friendly one — a content-class
  // plugin is exempt from the review gate by construction, and proving the fire
  // under `review_gate: false` would prove it in a configuration nobody runs.
  home = await createTestHome({ preferences: { review_gate: true } })
  // The child resolves preferences through the HOME default, not the state
  // directory: it passes no `stateDir` override, so `createTestHome`'s copy
  // under `state/` is invisible to it.
  await writeFile(join(home.root, 'preferences.json'), JSON.stringify({ review_gate: true }))
  firedDir = join(tmpdir(), `warpline-spend-fired-${randomUUID()}`)
  mkdirSync(firedDir, { recursive: true })
  releasePath = join(tmpdir(), `warpline-spend-release-${randomUUID()}`)
})

afterEach(async () => {
  // Restored unconditionally: the override is process-global and a home left
  // pointing at a removed temp dir leaks into whatever file bun runs next.
  _setHome(null)
  rmSync(firedDir, { recursive: true, force: true })
  rmSync(releasePath, { force: true })
  await home.cleanup()
})

describe('a content approval is marked spent before the handler runs', () => {
  test('a kill between the mark and the handler return does not re-fire', async () => {
    await seedLiveApproval('blocks')

    const child = spawn(process.execPath, [ENTRY, 'advance'], {
      env: { ...process.env, WARPLINE_HOME: home.root },
      stdio: 'ignore',
    })
    const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()))

    await waitFor(() => firedCount() >= 1, 'the child never entered the handler')
    // SIGKILL, not SIGINT or SIGTERM. `warpline advance` installs a handler for
    // both of those and exits 130 through it, which is an orderly exit and not
    // the crash this case is about.
    child.kill('SIGKILL')
    await exited

    // Released only now, so the second advance's handler returns immediately if
    // it is reached at all. A blocked re-fire would end this test in a timeout,
    // and a timeout proves nothing about a mark.
    writeFileSync(releasePath, 'go')
    // A killed advance never reaches its release, so the run lock is still on
    // disk. `advance-sigint.test.ts` clears it between launches for the same
    // reason: contention here would throw `AdvanceLockedError` instead of
    // failing an assertion about the mark.
    rmSync(join(home.stateDir, '.lock'), { force: true })

    const second = await advance()

    // FIRST, and deliberately: this is the whole claim, and it is the assertion
    // that must be the one to fail while no mark is written.
    expect(firedCount()).toBe(1)
    expect(second.refused_plugins).toEqual([{ plugin: CONSUMER, reason: 'indeterminate' }])

    const record = (await readState()).approvals[CONSUMER]
    expect(record.marked_at).not.toBeNull()
    expect(record.confirmed_at).toBeNull()
    // A whole hex string, untruncated.
    expect(record.effect_id).toMatch(/^[0-9a-f]{64}$/)
    // RECOMPUTED from the three stored values, never compared against a
    // hard-coded digest: the claim is that a reader holding the triple can
    // check the id they were handed, not that a retry regenerates one.
    expect(record.effect_id).toBe(
      contentEffectId(record.plugin, record.fingerprint, record.marked_at as string),
    )
  })

  test('a completed advance confirms the mark, and the next advance reports it spent', async () => {
    await seedLiveApproval('returns')

    await advance()

    expect(firedCount()).toBe(1)
    const marked = (await readState()).approvals[CONSUMER]
    expect(marked.marked_at).not.toBeNull()
    expect(marked.confirmed_at).not.toBeNull()
    expect(marked.effect_id).toBe(
      contentEffectId(marked.plugin, marked.fingerprint, marked.marked_at as string),
    )

    const details: string[] = []
    const second = await advance({
      // An hour on. Past the consumer's TTL, well inside the producer's, and
      // nowhere near the approval's 2099 window.
      now: Date.now() + 60 * 60 * 1000,
      onPluginEnd: (plugin, _status, _elapsed, reason) => {
        if (plugin === CONSUMER && reason !== undefined) details.push(reason)
      },
    })

    expect(firedCount()).toBe(1)
    // `already_spent` is a STATE REPORT, not a refusal: the operator did
    // nothing wrong and there is nothing here for a consumer to switch on.
    expect(second.refused_plugins).toEqual([])
    expect(details).toHaveLength(1)
    expect(details[0]).toContain(`already spent at ${marked.confirmed_at}`)
  })

  /**
   * The third post-fire state, and the one that is easy to get backwards.
   *
   * A handler returning `failed` leaves the record MARKED-UNCONFIRMED. The mark
   * is not cleared: a `failed` return does not prove the sink never received the
   * bytes — the handler had already written its sentinel before it decided it
   * had failed — and clearing it would re-arm a send that may well have gone
   * out. The operator resolves it at the sink with the effect id.
   */
  test('a handler returning failed leaves the record marked-unconfirmed', async () => {
    await seedLiveApproval('fails')

    await advance()

    expect(firedCount()).toBe(1)
    const record = (await readState()).approvals[CONSUMER]
    expect(record.marked_at).not.toBeNull()
    expect(record.confirmed_at).toBeNull()
    expect(record.effect_id).toBe(
      contentEffectId(record.plugin, record.fingerprint, record.marked_at as string),
    )

    const second = await advance({ now: Date.now() + 60 * 60 * 1000 })

    expect(firedCount()).toBe(1)
    expect(second.refused_plugins).toEqual([{ plugin: CONSUMER, reason: 'indeterminate' }])
  })
})
