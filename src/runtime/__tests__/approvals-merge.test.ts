/**
 * An approval written while an advance is running survives that advance.
 *
 * The phase's third mandated red-first test. `runAdvance` reads the whole state
 * document at the top and writes the whole document at the end, so anything
 * another writer put there in between is erased by a spread of a snapshot taken
 * before it existed. With one home and many attachments — possibly on different
 * machines — that window is as wide as the run, which is hours in the shape this
 * runtime is built for rather than a scheduling accident.
 *
 * **The wedge, not a forced interleave.** `src/cli/__tests__/deny.test.ts:575-583`
 * records that the interleave cannot be produced from outside the process for a
 * command that is too fast to catch mid-flight. It does not have to be, here:
 * the advance is held open on purpose. Its one firing plugin blocks in its
 * handler on a file that does not exist yet, the test does its concurrent write
 * while the advance is parked there, and only then creates the file. Nothing in
 * this file depends on which of two things happens first — the order is
 * imposed, not hoped for.
 *
 * **Every concurrent write is checked on disk before the wedge opens.** A
 * `approve --content` refused for a reason that has nothing to do with this
 * test — a missing `--not-after`, a producer that never ran, a body the command
 * reads as a path — leaves the record absent, and the end assertion would then
 * be red for the wrong reason and green the moment the merge landed. So each
 * case asserts the exit code AND re-reads the document immediately, while the
 * advance is still parked. That is the positive control this repository has
 * logged six instances of going without.
 *
 * **Two of the first four cases were green before the merge existed, and that
 * is not a weakness.** The whole-document write and the merge disagree in two
 * places only:
 *
 *   | row                                            | before | after |
 *   |------------------------------------------------|--------|-------|
 *   | on disk only (another attachment approved)     | LOST   | kept  |
 *   | in memory only, marked-unconfirmed             | kept   | kept  |
 *   | in memory only, unmarked (a `--remove` landed) | KEPT   | gone  |
 *   | both, in-memory marked                         | memory | memory|
 *
 * The two capitalised rows are the red. The other two pin the rule against the
 * opposite regression — a merge written the other way round, letting disk win
 * everything — which a test suite that only covered the red would not catch.
 *
 * **An answer never lands mid-advance.** Of the three operator writes to a
 * record an earlier advance marked (an answer, a re-approval, a removal), two
 * land while the advance is parked and are kept. The answer is refused while
 * any live advance holds the run lock, and is taken once it ends, so it has no
 * merge to survive. The last describe pins why: the one record the advance
 * could still overwrite is the one it marked, whose fire may still be landing.
 *
 * Writes only into a temp home and one temp directory beside it. Nothing under
 * the repository is touched.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { contentEffectId, proposalFingerprint, runAdvance } from '../engine.js'
import { PluginManifestSchema } from '../../schemas/plugin-manifest.js'
import type { PluginManifest } from '../../schemas/plugin-manifest.js'
import { defaultEngineState } from '../../schemas/engine-state.js'
import type { Approval, EngineState } from '../../schemas/engine-state.js'
import type { OutputRecord } from '../../schemas/skill-result.js'
import { pathsForStateFile, withStateLockAt } from '../../board/state-manager.js'
import { createTestHome, type TestHome } from './helpers/create-test-home.js'
import { _setHome } from '../../lib/paths.js'

/** The bytes the operator read and approved. */
const APPROVED_BODY = '{"batch":"the twelve invoices the operator read"}'

const PRODUCER = 'batch-builder'
/** The one plugin that fires, and the one the advance is wedged inside. */
const SENDER = 'batch-sender'
/** The second attachment's plugin. Always fresh, so it never fires. */
const SIBLING = 'report-sender'

/** A wall clock far enough out that no test run reaches it. */
const FAR_FUTURE = '2099-01-01T00:00'
const ZONE = 'UTC'

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

/** The same, from a handler that says its send did not go out. */
const FAILED_RESULT = `{
    status: 'failed',
    phases_completed: [],
    phases_failed: ['run'],
    errors: [{ code: 'dependency_unavailable', message: 'the sink refused', impact: 'HIGH', retryable: false }],
    data_freshness: {},
    summary: 'failed',
    artifacts_produced: [],
    schema_version: 1,
  }`

let home: TestHome
/** One file per handler invocation, OUTSIDE the home so `cleanup()` cannot make an absence true for the wrong reason. */
let firedDir: string
/** The sender's handler blocks until this exists. The wedge. */
let releasePath: string
/**
 * The advance a case parked and has not finished yet. A case that goes red
 * before its `finish()` would otherwise leave that advance polling in the
 * background, holding a lock in a home the next case no longer uses.
 */
let parked: Promise<unknown> | null = null

const outputOf = (body: string): OutputRecord => ({ type: 'brief', format: 'json', body })

const statePath = (): string => join(home.stateDir, 'engine-state.json')

/** How many times a given plugin's handler has been entered. */
const firedCount = (plugin: string): number =>
  readdirSync(firedDir).filter((f) => f.startsWith(`${plugin}-`)).length

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
      // Fresh for a day, and seeded as already run: the producer never fires in
      // any case here. A producer that re-ran would overwrite its own
      // `last_output` and move the bytes the approval is bound to.
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

/**
 * A content-class consumer of the producer's bytes.
 *
 * `blocks` is the wedge: the handler records that it was entered and then polls
 * for a file the test creates later. Everything the concurrent writer does
 * happens while a handler is sitting in that loop.
 *
 * The sentinel is written FIRST, before the block, so the test can tell the
 * handler was entered — which is also the proof that the mid-run spend mark has
 * already been taken and its lock released, because the mark sits between the
 * FSM going `running` and `invokePlugin`.
 */
async function writeConsumer(
  name: string,
  opts: { blocks: boolean; ttlHours: number; fails?: boolean },
): Promise<void> {
  const dir = join(home.pluginsDir, name)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'manifest.ts'),
    `export const manifest = ${JSON.stringify({
      name,
      version: '1.0.0',
      description: 'consumer',
      inputs: {},
      outputs: {},
      capabilities: [],
      schedule: 'on_run',
      autonomy_level: 'autonomous',
      side_effects: ['sends_email'],
      approval_class: 'content',
      ttl_hours: opts.ttlHours,
      dependencies: [PRODUCER],
      // Far above any wait here: the wedge is released in milliseconds, and an
      // invocation timeout firing first would end a case in a thrown error
      // rather than a failed assertion about the merge.
      timeout_ms: 120_000,
      max_retries: 0,
      retry_delay_ms: 10,
      max_parallelism: 1,
      min_tier: 'suspended',
    })}`,
  )
  // Both paths are baked in as literals rather than read from the environment:
  // `import()` caches the module, so a handler deciding anything at call time is
  // one more thing this file cannot see go wrong.
  const block = opts.blocks
    ? `  while (!existsSync(${JSON.stringify(releasePath)})) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }\n`
    : ''
  await writeFile(
    join(dir, 'handler.ts'),
    `import { writeFileSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
export async function handler() {
  writeFileSync(${JSON.stringify(firedDir)} + '/${name}-' + randomUUID(), 'the effect fired')
${block}  return ${opts.fails === true ? FAILED_RESULT : RESULT}
}
`,
  )
}

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

/** The approval the operator wrote, bound to the fingerprint of the seeded bytes. */
function approvalFor(state: EngineState, plugin: string): Approval {
  return {
    plugin,
    producer: PRODUCER,
    fingerprint: proposalFingerprint(state, PRODUCER, producerManifest()),
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

/**
 * The whole fixture: the producer, the wedged sender, and — when asked for —
 * the sibling the second attachment approves or withdraws.
 *
 * The sibling is FRESH by construction (a 24h TTL and a run seeded moments ago),
 * so it is skipped above the approval gate and never fires. Its approval record
 * is therefore read into the advance's memory at the top and left unmarked,
 * which is exactly the in-memory shape two of the merge rows are about.
 */
async function seedHome(opts: {
  sibling?: 'absent' | 'installed' | 'installed-and-approved'
  /** The sender returns `failed` once the wedge opens, leaving its mark unconfirmed. */
  senderFails?: boolean
} = {}): Promise<void> {
  const sibling = opts.sibling ?? 'absent'
  await writeProducer()
  await writeConsumer(SENDER, { blocks: true, ttlHours: 0.001, fails: opts.senderFails })
  if (sibling !== 'absent') await writeConsumer(SIBLING, { blocks: false, ttlHours: 24 })

  const state = defaultEngineState()
  state.plugin_runs[PRODUCER] = {
    last_run_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    status: 'success',
    last_output: outputOf(APPROVED_BODY),
  }
  if (sibling !== 'absent') {
    // No `last_output`: the field is optional and the sibling produces nothing.
    // Spelling it `null` is a schema violation, not an empty value.
    state.plugin_runs[SIBLING] = {
      last_run_at: new Date().toISOString(),
      status: 'success',
    }
  }
  state.approvals[SENDER] = approvalFor(state, SENDER)
  if (sibling === 'installed-and-approved') state.approvals[SIBLING] = approvalFor(state, SIBLING)
  await writeFile(statePath(), JSON.stringify(state))
}

async function advance(): Promise<Awaited<ReturnType<typeof runAdvance>>> {
  return runAdvance({
    pluginsDir: home.pluginsDir,
    stateDir: statePath(),
    runsDir: home.runsDir,
    eventsPath: join(home.runsDir, 'events.jsonl'),
    approvalPath: join(home.root, '.session-approval'),
    preferencesPath: join(home.stateDir, 'preferences.json'),
  })
}

async function readState(): Promise<EngineState> {
  return JSON.parse(await readFile(statePath(), 'utf-8')) as EngineState
}

/**
 * Run `warpline approve` in-process, with its two streams captured.
 *
 * Captured rather than silenced: when the command refuses, the reason is the
 * only thing that tells a refused control apart from a merge that did not
 * happen, and it rides into the assertion so a failure names itself.
 */
async function runApprove(argv: string[]): Promise<{ code: number; output: string }> {
  const { run } = await import('../../cli/approve.js')
  return captured(() => run(argv))
}

/**
 * Run `warpline resolve` in-process, through the dispatcher's `main` as the
 * operator's shell would reach it, with its two streams captured as above.
 */
async function runResolve(argv: string[]): Promise<{ code: number; output: string }> {
  const { main } = await import('../../cli/warpline.js')
  return captured(() => main(['resolve', ...argv]))
}

async function captured(command: () => Promise<number>): Promise<{ code: number; output: string }> {
  const realOut = process.stdout.write.bind(process.stdout)
  const realErr = process.stderr.write.bind(process.stderr)
  let output = ''
  const sink = ((chunk: string | Uint8Array): boolean => {
    output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8')
    return true
  }) as typeof process.stdout.write
  process.stdout.write = sink
  process.stderr.write = sink
  try {
    return { code: await command(), output }
  } finally {
    process.stdout.write = realOut
    process.stderr.write = realErr
  }
}

/** `[code, reason]`, so a refused command is readable in the failure rather than silent. */
const approveOutcome = (r: { code: number; output: string }): [number, string] => [
  r.code,
  r.code === 0 ? '' : r.output,
]

/**
 * Rewrite the on-disk `approvals` record under the document's own lock.
 *
 * Two rows of the merge table are reachable only this way. `approve --content
 * --remove` refuses a marked-unconfirmed record by design (R7's `indeterminate`
 * latch), and re-approving over one is refused for the same reason — so a
 * removal or a re-approval that lands on THIS document during THIS advance came
 * from a writer that saw the record before the mark, which is precisely the
 * many-attachments case. The lock is the same one every other writer takes, so
 * this is a concurrent writer rather than a test poking at bytes.
 */
async function rewriteDiskApprovals(
  mutate: (approvals: EngineState['approvals']) => void,
): Promise<void> {
  const path = statePath()
  await withStateLockAt(pathsForStateFile(path).lockPath, async () => {
    const state = JSON.parse(await readFile(path, 'utf-8')) as EngineState
    mutate(state.approvals)
    await writeFile(path, JSON.stringify(state, null, 2) + '\n')
  })
}

/**
 * The sibling's record as an earlier advance left it: marked ten minutes ago
 * under the id the runtime would have computed, and confirmed when asked.
 * Returns that effect id, which is what an operator reads off the sink.
 */
async function markSiblingOnDisk(opts: { confirmed: boolean }): Promise<string> {
  const markedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString()
  let effectId = ''
  await rewriteDiskApprovals((approvals) => {
    const record = approvals[SIBLING]
    if (record === undefined) throw new Error('seedHome should have approved the sibling')
    effectId = contentEffectId(SIBLING, record.fingerprint, markedAt)
    approvals[SIBLING] = {
      ...record,
      effect_id: effectId,
      marked_at: markedAt,
      confirmed_at: opts.confirmed ? new Date(Date.now() - 9 * 60 * 1000).toISOString() : null,
    }
  })
  return effectId
}

async function waitFor(predicate: () => boolean, what: string, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(what)
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  }
}

/** Park the advance inside the sender's handler and hand back the two halves. */
async function wedgeOpen(): Promise<{ finish: () => Promise<EngineState> }> {
  const running = advance()
  parked = running
  await waitFor(() => firedCount(SENDER) >= 1, 'the advance never entered the wedged handler')
  return {
    finish: async () => {
      writeFileSync(releasePath, 'go')
      await running
      parked = null
      return readState()
    },
  }
}

beforeEach(async () => {
  // The SHIPPED default, not the helper's test-friendly one — a content-class
  // plugin is exempt from the review gate by construction, and proving anything
  // under `review_gate: false` would prove it in a configuration nobody runs.
  home = await createTestHome({ preferences: { review_gate: true } })
  await writeFile(join(home.root, 'preferences.json'), JSON.stringify({ review_gate: true }))
  // `approve` resolves its own paths from the home, which is the point: the
  // concurrent writer must land on the same document the advance is writing.
  _setHome(home.root)
  firedDir = join(tmpdir(), `warpline-merge-fired-${randomUUID()}`)
  mkdirSync(firedDir, { recursive: true })
  releasePath = join(tmpdir(), `warpline-merge-release-${randomUUID()}`)
})

afterEach(async () => {
  if (parked !== null) {
    writeFileSync(releasePath, 'go')
    await parked.catch(() => undefined)
    parked = null
  }
  // Restored unconditionally: the override is process-global and a home left
  // pointing at a removed temp dir leaks into whatever file bun runs next.
  _setHome(null)
  rmSync(firedDir, { recursive: true, force: true })
  rmSync(releasePath, { force: true })
  await home.cleanup()
})

describe('the advance merges approvals rather than overwriting them', () => {
  test('an approval written mid-advance is present after the advance completes', async () => {
    await seedHome({ sibling: 'installed' })
    const wedge = await wedgeOpen()

    // The second attachment, through the real command: it takes the state lock
    // and writes the document the advance has already read.
    const approved = await runApprove([SIBLING, '--content', '--not-after', FAR_FUTURE, '--zone', ZONE])
    expect(approveOutcome(approved)).toEqual([0, ''])
    // The positive control, taken while the advance is still parked. Without
    // it, a refused command and a clobbered write are the same absence.
    expect(Object.keys((await readState()).approvals).sort()).toEqual([SENDER, SIBLING].sort())

    const final = await wedge.finish()

    // The whole claim. Red here means the end-of-run write spread a snapshot
    // taken before the sibling's approval existed.
    expect(Object.keys(final.approvals).sort()).toEqual([SENDER, SIBLING].sort())
    expect(final.approvals[SIBLING]?.plugin).toBe(SIBLING)
    // The sibling is fresh, so nothing it owns fired — the merge is about the
    // record, not about a second invocation.
    expect(firedCount(SIBLING)).toBe(0)
  })

  test('a marked-unconfirmed record survives a removal that landed on disk', async () => {
    await seedHome()
    const wedge = await wedgeOpen()

    // D-11a: the mark is on disk by now, so this is a writer that read the
    // record before it was marked and removed it after. If absence won the
    // merge, the only evidence that a send may have landed is destroyed.
    await rewriteDiskApprovals((approvals) => {
      delete approvals[SENDER]
    })
    expect(Object.keys((await readState()).approvals)).toEqual([])

    const final = await wedge.finish()

    const record = final.approvals[SENDER]
    expect(record).toBeDefined()
    expect(record?.marked_at).not.toBeNull()
    // The handler returned success, so the same write that kept the record also
    // progressed it: marked, then confirmed.
    expect(record?.confirmed_at).not.toBeNull()
  })

  test('an unmarked record is replaced by a removal that landed on disk', async () => {
    await seedHome({ sibling: 'installed-and-approved' })
    const wedge = await wedgeOpen()

    // The sibling never fires, so its record is unmarked in the advance's
    // memory — and a `--remove` against it is the ordinary gesture, not a
    // refused one. A merge that kept every in-memory record would resurrect an
    // approval the operator deliberately withdrew.
    const removed = await runApprove([SIBLING, '--content', '--remove'])
    expect(approveOutcome(removed)).toEqual([0, ''])
    expect(Object.keys((await readState()).approvals)).toEqual([SENDER])

    const final = await wedge.finish()

    expect(Object.hasOwn(final.approvals, SIBLING)).toBe(false)
    expect(final.approvals[SENDER]?.marked_at).not.toBeNull()
    expect(firedCount(SIBLING)).toBe(0)
  })

  test('a record present in both keeps the in-memory version and its confirmation', async () => {
    await seedHome()
    const wedge = await wedgeOpen()

    // The instant the advance marked, read before anything overwrites it. The
    // final assertion compares against THIS rather than against "not null", so
    // a disk record winning is distinguishable from the in-memory one winning.
    const markedAt = (await readState()).approvals[SENDER]?.marked_at
    expect(markedAt).not.toBeNull()

    // A re-approval landing mid-advance: same key, unmarked, freshly stamped.
    await rewriteDiskApprovals((approvals) => {
      const record = approvals[SENDER]
      if (record === undefined) throw new Error('the mark should have written this record')
      approvals[SENDER] = {
        ...record,
        approved_at: new Date().toISOString(),
        effect_id: null,
        marked_at: null,
        confirmed_at: null,
      }
    })
    expect((await readState()).approvals[SENDER]?.marked_at).toBeNull()

    const final = await wedge.finish()

    const record = final.approvals[SENDER]
    expect(record?.marked_at).toBe(markedAt as string)
    expect(record?.confirmed_at).not.toBeNull()
    // Recomputed from the three stored values rather than compared against a
    // hard-coded digest: the claim is that the id survives the merge intact.
    expect(record?.effect_id).toBe(
      contentEffectId(record!.plugin, record!.fingerprint, record!.marked_at as string),
    )
  })

  // The three cases below share one shape. The sibling's record is marked on
  // disk BEFORE the wedge opens, so the advance reads it marked at its start,
  // as an earlier advance left it, and never marks it itself: the sibling is
  // fresh and does not fire. While the advance is parked, the operator tries
  // three writes to that record: an answer, a re-approval, a removal. The
  // answer is refused while the advance runs, because the refusal is on the
  // run lock and not on the record, and it is taken once the advance ends.
  // The other two land, and the advance's copy is the read it took at its
  // start, so it can only be older than the disk: writing it back would undo
  // the operator. Nothing sends either way. Only a record THIS advance marked
  // may win over the disk, which the four cases above hold in place.

  test('an answer attempted mid-advance is refused, even for a fire that advance did not mark, and is taken once it ends', async () => {
    await seedHome({ sibling: 'installed-and-approved' })
    const effectId = await markSiblingOnDisk({ confirmed: false })
    const wedge = await wedgeOpen()

    const refused = await runResolve([SIBLING, '--not-shipped', effectId])
    // A copy: bun's `toMatchObject` writes its matchers into the object it was
    // handed, so the original would no longer hold the output for the lines below.
    expect({ ...refused }).toMatchObject({ code: 1, output: expect.stringContaining('An advance is running') })
    expect(refused.output).toContain('Nothing was written')
    expect(Object.hasOwn((await readState()).approvals[SIBLING]!, 'not_shipped_at')).toBe(false)

    const final = await wedge.finish()

    const record = final.approvals[SIBLING]!
    expect(record.marked_at).not.toBeNull()
    expect(record.confirmed_at).toBeNull()
    expect(Object.hasOwn(record, 'not_shipped_at')).toBe(false)

    // The advance is over, so nothing it marked can still be landing.
    expect(approveOutcome(await runResolve([SIBLING, '--not-shipped', effectId]))).toEqual([0, ''])
    expect((await readState()).approvals[SIBLING]?.not_shipped_at).toBeString()
    expect(firedCount(SIBLING)).toBe(0)
  })

  test('a re-approval over a spent record that lands mid-advance is kept', async () => {
    await seedHome({ sibling: 'installed-and-approved' })
    await markSiblingOnDisk({ confirmed: true })
    const wedge = await wedgeOpen()

    const approved = await runApprove([SIBLING, '--content', '--not-after', FAR_FUTURE, '--zone', ZONE])
    expect(approveOutcome(approved)).toEqual([0, ''])
    expect((await readState()).approvals[SIBLING]?.marked_at).toBeNull()

    const final = await wedge.finish()

    expect(final.approvals[SIBLING]?.marked_at).toBeNull()
    expect(final.approvals[SIBLING]?.confirmed_at).toBeNull()
  })

  test('a spent record removed mid-advance stays removed', async () => {
    await seedHome({ sibling: 'installed-and-approved' })
    await markSiblingOnDisk({ confirmed: true })
    const wedge = await wedgeOpen()

    const removed = await runApprove([SIBLING, '--content', '--remove'])
    expect(approveOutcome(removed)).toEqual([0, ''])
    expect(Object.keys((await readState()).approvals)).toEqual([SENDER])

    const final = await wedge.finish()

    expect(Object.hasOwn(final.approvals, SIBLING)).toBe(false)
    // The sender's own mark, taken by this advance, still wins.
    expect(final.approvals[SENDER]?.marked_at).not.toBeNull()
    expect(final.approvals[SENDER]?.confirmed_at).not.toBeNull()
  })
})

// The mark lands on disk before the handler runs, and the advance's own write
// comes after it. Between the two, the disk reads indeterminate while the fire
// may still land. An answer given then is overwritten by that write if the
// fire fails, dropped if it succeeds, and a double send if the process dies
// after the send and the operator re-approves. The refusal is on the run lock
// because that window is exactly the time an advance holds it.
describe('resolve waits for the advance that may still be firing', () => {
  /** The sender's mark as the advance wrote it, read while the handler is parked. */
  async function senderMark(): Promise<{ markedAt: string; effectId: string }> {
    const record = (await readState()).approvals[SENDER]
    // The positive control: the mark landed, so the record does read
    // indeterminate on disk, and a refusal below is not an absent record.
    expect(record?.marked_at).toBeString()
    expect(record?.effect_id).toBeString()
    return { markedAt: record!.marked_at as string, effectId: record!.effect_id as string }
  }

  test('the fire the running advance marked cannot be resolved, and the advance confirms it untouched', async () => {
    await seedHome()
    const wedge = await wedgeOpen()
    const { effectId } = await senderMark()

    const refused = await runResolve([SENDER, '--not-shipped', effectId])
    expect({ ...refused }).toMatchObject({ code: 1, output: expect.stringContaining('An advance is running') })
    expect(refused.output).not.toContain('Resolved')
    expect(Object.hasOwn((await readState()).approvals[SENDER]!, 'not_shipped_at')).toBe(false)

    const final = await wedge.finish()

    const record = final.approvals[SENDER]!
    expect(record.confirmed_at).not.toBeNull()
    expect(Object.hasOwn(record, 'not_shipped_at')).toBe(false)
    expect(firedCount(SENDER)).toBe(1)
  })

  test('a fire the running advance marked and then failed is answered once the advance ends, and the answer stays', async () => {
    await seedHome({ senderFails: true })
    const wedge = await wedgeOpen()
    const { markedAt, effectId } = await senderMark()

    const refused = await runResolve([SENDER, '--not-shipped', effectId])
    expect({ ...refused }).toMatchObject({ code: 1, output: expect.stringContaining('An advance is running') })
    expect(Object.hasOwn((await readState()).approvals[SENDER]!, 'not_shipped_at')).toBe(false)

    const final = await wedge.finish()

    const record = final.approvals[SENDER]!
    expect(record.marked_at).toBe(markedAt)
    expect(record.confirmed_at).toBeNull()
    expect(Object.hasOwn(record, 'not_shipped_at')).toBe(false)

    // Now the answer is about a fire that has ended, and the operator checked it.
    expect(approveOutcome(await runResolve([SENDER, '--not-shipped', effectId]))).toEqual([0, ''])
    expect((await readState()).approvals[SENDER]?.not_shipped_at).toBeString()

    // A later advance keeps it, and the spent record fires nothing.
    await advance()
    expect((await readState()).approvals[SENDER]?.not_shipped_at).toBeString()
    expect(firedCount(SENDER)).toBe(1)
  })
})
