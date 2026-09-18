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
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
  /** Preview only: nothing with a declared side effect is invoked. */
  dryRun?: boolean
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

  /**
   * A dry run writes no mark.
   *
   * This is a STRUCTURAL property rather than a defended one: the mark sits
   * below the dry-run side-effect block, which no dry run reaches for a
   * side-effecting plugin — and `approval_class: 'content'` requires at least
   * one declared side effect at `.parse()` time, so there is no content-class
   * manifest that slips past it. There is no `!dryRun` guard on the mark and
   * there should not be one; a second expression of the same fact is a second
   * thing that can disagree.
   *
   * Asserted anyway, because the property is only as good as the placement
   * staying put. Move the mark above that block and this goes red, which is the
   * whole reason to spend a case on something the control flow already
   * guarantees.
   */
  test('a dry run writes no spend mark', async () => {
    await seedLiveApproval('returns')

    await advance({ dryRun: true })

    expect(firedCount()).toBe(0)
    const record = (await readState()).approvals[CONSUMER]
    expect(record.marked_at).toBeNull()
    expect(record.effect_id).toBeNull()
    expect(record.confirmed_at).toBeNull()
  })
})

/**
 * The mark's OWN I/O failing is a named refusal, not an uncaught throw.
 *
 * The gate has already said fire by the time the mark runs, so a mark that
 * cannot read the state document is a second decision point with its own
 * answer. Before this case the read threw straight out of the level's
 * `Promise.all` and ended the advance above the run-log write: a fleet where a
 * sibling had already fired, with no artifact saying so. `mark_unavailable` is
 * the answer for the class where nothing was written.
 *
 * **What makes the document unreadable is planted BETWEEN the levels, not
 * before the advance.** Corrupting it up front would be caught by the
 * top-of-advance read instead, which is a different guard and already has its
 * own coverage. The producer's `onPluginEnd` is the only hook that fires
 * between the two levels, which is why the producer has to actually run here.
 *
 * **The leak guard is in reach of a real leak, and a positive control says so.**
 * `EngineStateInvalidError`'s message carries the state path AND the parser's
 * quotation of the document's own first token, so the sentinel below genuinely
 * travels as far as any `catch` that reads its error. A refusal string that
 * interpolated the error would carry it into the run log and `events.jsonl`,
 * where the assertions can see it.
 */
describe("the spend mark's own I/O failing is a refusal, not a dead advance", () => {
  /**
   * The FIRST token of the corrupt body, and the position is load-bearing: the
   * engine's `JSON.parse` failure quotes the offending identifier and nothing
   * else, so a sentinel buried later in the body would never reach the error
   * message and the assertions below would be green over nothing.
   */
  const SENTINEL = 'WARPLINE_STATE_DOCUMENT_LEAK_SENTINEL'
  const CORRUPT = `${SENTINEL} is not a state document`

  /**
   * The operator string the engine authors for this reason, spelled out rather
   * than rebuilt from the same pieces the engine uses. A test that recomputes
   * the string it is checking agrees with the implementation by construction.
   */
  const MARK_UNAVAILABLE_SUMMARY =
    `refused (mark_unavailable): the spend mark for '${CONSUMER}' could not be taken — the state ` +
    'document could not be locked or read, so nothing was marked and nothing was sent'

  test('the parse failure genuinely carries the sentinel (the guard is in reach)', () => {
    expect(() => JSON.parse(CORRUPT)).toThrow(new RegExp(SENTINEL))
  })

  test('a mark whose read throws refuses with mark_unavailable and the run log is still written', async () => {
    await seedLiveApproval('returns')
    // OFF for this case only, and the exemption it costs is not one this case
    // relies on: a content-class plugin is exempt from the review gate by
    // construction, and the three cases above prove the mark under the shipped
    // `review_gate: true`. It is off here because the PRODUCER is session-class
    // and would otherwise be promoted to supervised, park a gate, and stop the
    // level loop before the sender is ever evaluated — taking the only hook
    // that fires between the two levels with it.
    await writeFile(join(home.stateDir, 'preferences.json'), JSON.stringify({ review_gate: false }))

    /** The seeded document, saved before it is broken and put back afterwards. */
    let saved = ''
    /** What `onPluginEnd` was told about the sender. */
    const details: string[] = []

    const result = await advance({
      // 25 hours on: past the producer's 24 h TTL so it is due and runs, and
      // nowhere near the approval's 2099 window.
      now: Date.now() + 25 * 60 * 60 * 1000,
      // Synchronous and not awaited, so `node:fs`'s sync writers and not the
      // promise API — a write this hook only STARTS is a write the mark may
      // reach before it lands.
      onPluginEnd: (plugin, _status, _elapsed, reason) => {
        if (plugin === PRODUCER) {
          saved = readFileSync(statePath(), 'utf-8')
          writeFileSync(statePath(), CORRUPT)
        }
        if (plugin === CONSUMER) {
          // Restored before the end-of-run write, which is NOT in this plan's
          // scope: an unreadable document there still kills the advance, and
          // leaving it broken would prove that instead of proving the mark.
          writeFileSync(statePath(), saved)
          if (reason !== undefined) details.push(reason)
        }
      },
    })

    // The handler never ran. FIRST, because it is the whole claim.
    expect(firedCount()).toBe(0)
    expect(result.refused_plugins).toEqual([{ plugin: CONSUMER, reason: 'mark_unavailable' }])
    expect(details).toEqual([MARK_UNAVAILABLE_SUMMARY])

    // The advance resolved and wrote its run log, which is the continuation
    // this case exists for: the throw used to end it above this write.
    const runLogText = readFileSync(result.run_log_path, 'utf-8')
    const runLog = JSON.parse(runLogText) as {
      plugin_entries: { plugin: string; status: string; reason?: string; result_summary: string }[]
    }
    const senderEntry = runLog.plugin_entries.find((e) => e.plugin === CONSUMER)
    expect(senderEntry?.status).toBe('refused')
    expect(senderEntry?.reason).toBe('mark_unavailable')
    // `toBe` and not `toContain`: an appended error message fails this.
    expect(senderEntry?.result_summary).toBe(MARK_UNAVAILABLE_SUMMARY)
    // The level below still ran and is on the record, so "the loop continued"
    // is read off the artifact rather than inferred from the absence of a throw.
    expect(runLog.plugin_entries.find((e) => e.plugin === PRODUCER)?.status).toBe('completed')

    // Neither persisted stream carries the document's own bytes.
    expect(runLogText).not.toContain(SENTINEL)
    expect(readFileSync(join(home.runsDir, 'events.jsonl'), 'utf-8')).not.toContain(SENTINEL)

    // Nothing was marked: the write is below the read that threw.
    const record = (await readState()).approvals[CONSUMER]
    expect(record.marked_at).toBeNull()
    expect(record.effect_id).toBeNull()
    expect(record.confirmed_at).toBeNull()
  })
})

/**
 * The module-level declaration named `name`, as its own lines.
 *
 * Module scope rather than inside one `describe`, because two suites below read
 * the same extraction and a second copy of this is a second thing that can
 * disagree about what a function body is.
 *
 * Throws rather than returning empty on every failure. An enumeration that
 * found nothing is "did not look", and reporting it as clean is perfectly
 * green and exactly wrong — the failure class this repository has logged six
 * instances of.
 */
function bodyOf(name: string): string[] {
  const source = readFileSync(join(import.meta.dir, '..', 'engine.ts'), 'utf-8')
  const lines = source.split('\n')
  const start = lines.findIndex((l) => new RegExp(`^(export )?async function ${name}\\(`).test(l))
  if (start === -1) {
    throw new Error(`blind: ${name} is not declared at module level in engine.ts`)
  }
  const end = lines.findIndex((l, i) => i > start && l === '}')
  if (end === -1) throw new Error(`blind: ${name} has no closing brace at column 0`)
  const body = lines.slice(start, end + 1)
  // Non-trivial by assertion, not by hope: a one-line range names no writer
  // for the reason that it contains nothing.
  if (body.length < 20) throw new Error(`blind: ${name}'s extracted range is ${body.length} lines`)
  return body
}

/**
 * The mark is not reachable from `evaluatePlugin`.
 *
 * `evaluatePlugin` is what `warpline plan` calls, and the evaluator/orchestrator
 * seam is what keeps a preview off every write in this runtime. The seam is
 * structural, so it earns a structural assertion rather than a behavioural one.
 *
 * **This is the WEAKER of the two available checks, and the comment says so
 * because the weakness is the thing a later reader needs to know.** The strong
 * form is the AST closure walk in
 * `src/__tests__/no-approval-gate-from-content.test.ts`: start at a named
 * function, descend into every local callee, and assert the identifiers met
 * along the way name none of a forbidden set. That walk sees a writer reached
 * through a helper; this line-range scan does not. Its `offendingSymbols` helper
 * is not exported, and importing a test module from another test module would
 * re-run that file's whole suite as a side effect of the import — so reusing it
 * costs more than it buys until someone lifts it into a shared helper, which is
 * the right fix and is not this plan's.
 *
 * What carries the transitive half meanwhile is BEHAVIOURAL and lives in
 * `src/cli/__tests__/plan.test.ts`: a whole-home byte-and-mtime snapshot around
 * `warpline plan` over a home that would otherwise fire, with no exclusion list
 * and with a positive control proving the snapshot can see a write. A writer
 * reached through any depth of helper moves a byte there.
 */
describe('the spend mark is unreachable from the evaluator', () => {
  const FORBIDDEN = [
    'writeEngineState',
    'atomicWriteText',
    // Both spellings. The engine imports the derived state lock under an alias,
    // so a scan for the exported name alone would be green on the alias — the
    // shape of a guard that cannot reach the thing it was written for.
    'withStateLockAt',
    'lockStateDocument',
  ] as const

  const named = (body: readonly string[]): string[] =>
    FORBIDDEN.filter((symbol) => body.some((l) => l.includes(symbol)))

  test("evaluatePlugin's own body names no writer", () => {
    expect(named(bodyOf('evaluatePlugin'))).toEqual([])
  })

  /**
   * The positive control. Without it the assertion above is green whenever the
   * range extraction or the symbol match quietly stopped working, which is
   * indistinguishable from clean at the point it matters. `markContentApprovalSpent`
   * is the writer itself, so the same scan over it must report.
   */
  test('the same scan over the mark itself reports the writers it names', () => {
    expect(named(bodyOf('markContentApprovalSpent'))).toEqual([
      'writeEngineState',
      'lockStateDocument',
    ])
  })
})

/**
 * The write arm and its rollback are still WRITTEN.
 *
 * This is a source assertion rather than a behavioural one, and the reason is a
 * limit rather than a preference. `mark_uncertain` is returned only when
 * `writeEngineState` throws with the lock already held and the read already
 * done, and no in-process lever reaches that window:
 *
 * - `pathsForStateFile` puts `.state.lock` in the state document's own
 *   directory, so every permission change that would break the write breaks the
 *   `O_EXCL` lock acquire first — which lands in the OUTER arm and answers
 *   `mark_unavailable`, a different case that already has behavioural coverage
 *   above.
 * - `atomicWriteText`'s temp name carries `Math.random()`, so no pre-created
 *   path and no pre-made read-only file can single the write out either.
 *
 * So the arm is verified here by source assertion, and by `tsc` through
 * `markRefusalDetail`'s exhaustive `switch` over `MarkRefusal` — removing an arm
 * there makes `bun run typecheck` print an `error TS` line. Both are WEAKER than
 * a behavioural case: they assert the arm is present, never that it behaves. The
 * arm's meaning is carried by `docs/runtime-spec.md` § 5's reason table and
 * § 10's crash semantics. What this stops is a refactor deleting the rollback
 * with the whole suite green, which is worth having precisely because nothing
 * else would notice.
 *
 * Every enumeration below throws rather than returning empty, and the green
 * assertion is paired with a control over a DOCTORED copy of the real body. A
 * scan whose window arithmetic quietly stopped matching reads identical to a
 * clean one, which is the failure class this repository has logged six
 * instances of.
 */
describe('the write arm and its rollback are still written', () => {
  /** Lines to read past the inner `catch` for its rollback and its return. */
  const INNER_WINDOW = 4
  /** Lines to read past the outer `catch` for its return. */
  const OUTER_WINDOW = 3

  /**
   * The offenders in a `markContentApprovalSpent` body, or an empty list.
   *
   * PURE and taking lines, so the control below runs this exact code over a
   * modified copy of the REAL body — a hand-written fake would agree with the
   * checker by construction and prove nothing about either.
   *
   * Throws on every shape where the scan cannot see what it was written for: a
   * body naming no writer, a body holding fewer than two `catch` lines, a body
   * whose catches all sit above the write, and a body where the inner and outer
   * catch resolve to the same line. Each of those is "could not look", and
   * returning an empty offender list for one would be perfectly green.
   */
  function offendersIn(body: readonly string[]): string[] {
    const writeAt = body.findIndex((l) => l.includes('writeEngineState'))
    if (writeAt === -1) {
      throw new Error('blind: markContentApprovalSpent names no writeEngineState')
    }
    const catches = body.flatMap((l, i) => (l.includes('catch') ? [i] : []))
    if (catches.length < 2) {
      throw new Error(
        `blind: markContentApprovalSpent holds ${catches.length} lines naming catch, expected the outer and the inner arm`,
      )
    }
    const inner = catches.find((i) => i > writeAt)
    if (inner === undefined) {
      throw new Error('blind: no catch below the writeEngineState line — the write is not guarded')
    }
    const outer = catches[catches.length - 1]!
    if (outer === inner) {
      throw new Error('blind: the inner and outer arm resolve to the same catch line')
    }

    const offenders: string[] = []
    const innerLines = body.slice(inner + 1, inner + 1 + INNER_WINDOW)
    if (!innerLines.some((l) => l.includes('mark_uncertain'))) {
      offenders.push(
        "the catch around writeEngineState no longer returns 'mark_uncertain' — a write that may have landed would report as some other case, and the operator would be told a state the runtime does not know",
      )
    }
    // `=[^=]` and not a bare `=`, so a future `===` comparison cannot pass for
    // the assignment. The identical assignment further up the body — the one
    // that PLACES the mark — sits well outside this window.
    if (!innerLines.some((l) => /state\.approvals\[plugin\]\s*=[^=]/.test(l))) {
      offenders.push(
        'the catch around writeEngineState no longer restores state.approvals[plugin] — left marked, the end-of-run merge promotes a mark nothing observed land, turning a recoverable retry into a permanent indeterminate',
      )
    }
    const outerLines = body.slice(outer + 1, outer + 1 + OUTER_WINDOW)
    if (!outerLines.some((l) => l.includes('mark_unavailable'))) {
      offenders.push(
        "the outermost catch no longer returns 'mark_unavailable' — the arm that means nothing was written would answer with something else",
      )
    }
    return offenders
  }

  /**
   * The body with the single line naming `symbol` removed.
   *
   * Exactly one, asserted: doctoring a body where the symbol appears twice would
   * leave the other copy in place and the control would be green over an input
   * it never actually damaged — a positive control that is itself blind.
   */
  function without(body: readonly string[], symbol: string): string[] {
    const hits = body.flatMap((l, i) => (l.includes(symbol) ? [i] : []))
    if (hits.length !== 1) {
      throw new Error(`blind control: ${hits.length} lines name ${symbol}, expected exactly 1`)
    }
    return body.filter((_, i) => i !== hits[0])
  }

  test('the shipped body names the arm, the rollback and the outer refusal', () => {
    expect(offendersIn(bodyOf('markContentApprovalSpent'))).toEqual([])
  })

  /**
   * The positive control, and the only thing that makes the assertion above
   * mean anything. Remove the one line naming `mark_uncertain` from the real
   * body and the same function must report — otherwise a green result is
   * indistinguishable from a scan that stopped looking.
   */
  test('the same checker reports a body whose mark_uncertain line was removed', () => {
    const doctored = without(bodyOf('markContentApprovalSpent'), 'mark_uncertain')
    expect(offendersIn(doctored)).not.toEqual([])
  })

  test('a body naming no writer throws rather than reporting clean', () => {
    const doctored = without(bodyOf('markContentApprovalSpent'), 'writeEngineState')
    expect(() => offendersIn(doctored)).toThrow(/blind/)
  })

  /**
   * The weaker, structural form, as its neighbours are. The mark is not
   * exported, and staging the cross-advance race that erases the content
   * between the gate and the mark is not worth its fixture. What it pins: the
   * precondition refuses erased content, after the fingerprint compare (which
   * cannot see erasure) and before the mark check.
   */
  test("the mark refuses content_moved when the producer's content was erased under it", () => {
    const code = bodyOf('markContentApprovalSpent').filter((l) => !/^\s*(\/\/|\*)/.test(l))
    const fingerprintAt = code.findIndex((l) =>
      /record\.fingerprint !== authority\.fingerprint\)\s*return 'content_moved'/.test(l),
    )
    const erasedHits = code.flatMap((l, i) =>
      /erased_at !== undefined\)\s*return 'content_moved'/.test(l) ? [i] : [],
    )
    const indeterminateAt = code.findIndex((l) => /return 'indeterminate'/.test(l))

    expect(fingerprintAt).toBeGreaterThanOrEqual(0)
    expect(indeterminateAt).toBeGreaterThanOrEqual(0)
    expect(erasedHits).toHaveLength(1)
    expect(erasedHits[0]!).toBeGreaterThan(fingerprintAt)
    expect(erasedHits[0]!).toBeLessThan(indeterminateAt)
  })
})
