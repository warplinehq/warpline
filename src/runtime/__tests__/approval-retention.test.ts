/**
 * What a content approval protects, and the instant it stops protecting it.
 *
 * Three consumers of ONE predicate, tested together because they are the same
 * decision seen from three sides:
 *
 *   - **The protected set (R15).** A run's log holds a summary of that run,
 *     never the approved content, and ordinary retention would evict it while
 *     the operator's yes was still outstanding. So an approval's `run_id` joins
 *     the set `pruneRunLogs` exempts, and protection keeps the log while the yes
 *     is outstanding — the second kind of held record its own docstring
 *     anticipated, joined by the caller, with `run-log-store.ts` unchanged.
 *
 *   - **The expiry sweep (OQ3, half B).** The same reference must not pin
 *     anything forever. A frozen batch is recipient data, and the fourth
 *     Prohibition forbids retaining its binding past the window with no
 *     deletion path. So protection is unioned only for approvals whose window
 *     is still OPEN: the moment it closes, the run falls back to ordinary
 *     retention, and the binding itself is dropped from the record.
 *
 *   - **The content erasure.** The approved content is the producer's
 *     `last_output.body` in the state document. Once no open window of an
 *     approval for that producer binds it, the end-of-run write erases it, just
 *     before the sweep. It is tested in `content-erasure.test.ts` and in this
 *     file's later cases.
 *
 * **One `windowClosed`, three readers, and that is the property under test.**
 * Independently computed window checks are answers that can disagree about the
 * same approval — a run released while its binding is retained, or a binding
 * deleted while its run is still pinned. Every case below is written so that a
 * second, drifting predicate would show up as a contradiction rather than as a
 * pass.
 *
 * **The marked-unconfirmed exception is not an oversight (D-11a).** A record
 * with `marked_at` set and `confirmed_at` null is the did-it-ship evidence for
 * a send that may have landed. It survives the sweep, and it is safe to: it
 * holds a fingerprint, a producer name and a pointer, and its bound content is
 * erased by the same rule as any other.
 *
 * Every case drives a REAL advance against a temp home. The protected set is
 * built inside `runAdvance` and handed to `pruneRunLogs`; asserting it at the
 * prune's own signature would prove the parameter works and say nothing about
 * whether the engine ever fills it.
 *
 * Writes only into a temp home. Nothing under the repository is touched.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFile, utimes, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { denialStanding, proposalFingerprint, runAdvance } from '../engine.js'
import { defaultEngineState } from '../../schemas/engine-state.js'
import type { Approval, EngineState, PluginRun } from '../../schemas/engine-state.js'
import { PluginManifestSchema } from '../../schemas/plugin-manifest.js'
import type { StoredOutputRecord } from '../../schemas/skill-result.js'
import { resolveWallClock } from '../../lib/wall-clock.js'
import { createTestHome, type TestHome } from './helpers/create-test-home.js'
import { _setHome } from '../../lib/paths.js'

/** The consumer an approval is keyed by. It never has to exist as a plugin. */
const CONSUMER = 'batch-sender'
const PRODUCER = 'batch-builder'

/** A wall clock far enough out that no test run reaches it. */
const OPEN = '2099-01-01T00:00'
/** A wall clock far enough back that no host clock skew reaches it. */
const CLOSED = '2000-01-02T00:00'

const DAY_MS = 86_400_000

let home: TestHome
let statePath: string
let eventsPath: string
let approvalPath: string

/**
 * One autonomous plugin with no side effects, whose handler returns
 * `artifactsSource` (source text) as its `artifacts_produced`. Returns the
 * manifest object it wrote.
 *
 * A plugin that produces declares the one Output the handler returns, because
 * the loader validates manifests. One that produces nothing keeps `outputs:
 * {}`, so the filler's manifest is byte-identical to what it always was.
 */
async function writeAutonomous(name: string, artifactsSource = '[]'): Promise<Record<string, unknown>> {
  const dir = join(home.pluginsDir, name)
  const { mkdir } = await import('node:fs/promises')
  await mkdir(dir, { recursive: true })
  const manifest = {
    name,
    version: '1.0.0',
    description: name,
    inputs: {},
    outputs: artifactsSource === '[]' ? {} : { brief: { type: 'json' } },
    capabilities: [],
    schedule: 'on_run',
    autonomy_level: 'autonomous',
    side_effects: [],
    approval_class: 'session',
    ttl_hours: 24,
    dependencies: [],
    timeout_ms: 5000,
    max_retries: 0,
    retry_delay_ms: 10,
    max_parallelism: 1,
    min_tier: 'suspended',
  }
  await writeFile(join(dir, 'manifest.ts'), `export const manifest = ${JSON.stringify(manifest)}`)
  await writeFile(
    join(dir, 'handler.ts'),
    `export async function handler() {
  return {
    status: 'success',
    phases_completed: ['run'],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: 'ran',
    artifacts_produced: ${artifactsSource},
    schema_version: 1,
  }
}
`,
  )
  return manifest
}

/**
 * One trivial plugin, so the advance has something to load and reaches its
 * end-of-run assembly. It declares no side effects and is not the subject of
 * any assertion here.
 */
async function writeFiller(): Promise<void> {
  await writeAutonomous('filler')
}

/** A run log old enough that ordinary retention would evict it. */
async function writeAgedRun(id: string, ageDays = 400): Promise<void> {
  const when = new Date(Date.now() - ageDays * DAY_MS)
  const doc = {
    run_id: id,
    started_at: '2026-04-03T12:00:00Z',
    completed_at: '2026-04-03T12:05:00Z',
    status: 'complete',
    resumed_from: null,
    summary: 'an old run',
    plugin_entries: [],
  }
  await writeFile(join(home.runsDir, `${id}.json`), JSON.stringify(doc))
  await utimes(join(home.runsDir, `${id}.json`), when, when)
  await writeFile(join(home.runsDir, `${id}.log`), 'x'.repeat(64))
  await utimes(join(home.runsDir, `${id}.log`), when, when)
}

function approval(overrides: Partial<Approval> = {}): Approval {
  return {
    plugin: CONSUMER,
    producer: PRODUCER,
    // Never compared on any arm these cases reach: the producer's manifest is
    // absent from the plugin root, so the standing is decided above the
    // fingerprint. Deliberate — this file is about the WINDOW.
    fingerprint: 'not-compared-here',
    run_id: 'approved-run',
    approved_at: '2026-08-29T11:00:00.000Z',
    not_before: null,
    not_after: OPEN,
    zone: 'UTC',
    effect_id: null,
    marked_at: null,
    confirmed_at: null,
    ...overrides,
  }
}

async function seedState(patch: Partial<EngineState> = {}): Promise<void> {
  await writeFile(statePath, JSON.stringify({ ...defaultEngineState(), ...patch }))
}

const readState = async (): Promise<EngineState> =>
  JSON.parse(await readFile(statePath, 'utf-8')) as EngineState

/** `now` is passed only when given, so every case without it is unchanged. */
const advance = (now?: number) =>
  runAdvance({
    pluginsDir: home.pluginsDir,
    stateDir: statePath,
    runsDir: home.runsDir,
    eventsPath,
    approvalPath,
    ...(now === undefined ? {} : { now }),
  })

/** The approved content: the producer's inline body. */
const BODY = '{"batch":"twelve invoices"}'

/** The producer's Output from the approved run, carrying `BODY`. */
function produced(overrides: Partial<StoredOutputRecord> = {}): StoredOutputRecord {
  return {
    type: 'brief',
    format: 'json',
    body: BODY,
    run_id: 'approved-run',
    produced_at: '2026-08-29T10:00:00.000Z',
    ...overrides,
  } as StoredOutputRecord
}

/**
 * The producer's `plugin_runs` entry. Its last run is older than the manifest
 * TTL, so an installed producer is due.
 */
function producerRun(lastOutput?: StoredOutputRecord): PluginRun {
  return {
    last_run_at: '2026-01-01T00:00:00.000Z',
    status: 'success',
    ...(lastOutput === undefined ? {} : { last_output: lastOutput }),
  }
}

const hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')

const survives = (id: string): boolean =>
  existsSync(join(home.runsDir, `${id}.json`)) && existsSync(join(home.runsDir, `${id}.log`))

describe('what a content approval protects', () => {
  beforeEach(async () => {
    home = await createTestHome()
    _setHome(home.root)
    statePath = join(home.stateDir, 'engine-state.json')
    eventsPath = join(home.stateDir, 'events.jsonl')
    approvalPath = join(home.root, '.session-approval')
    await writeFiller()
  })

  afterEach(async () => {
    await home.cleanup()
  })

  test('a run referenced by a live approval survives a prune that would otherwise evict it', async () => {
    await writeAgedRun('approved-run')
    // The age-peer is what makes this an exemption rather than a prune that
    // did nothing.
    await writeAgedRun('peer-run')
    await seedState({ approvals: { [CONSUMER]: approval() } })

    await advance()

    expect(survives('approved-run')).toBe(true)
    expect(survives('peer-run')).toBe(false)
  })

  test('a run id referenced by both a pending gate and a live approval is protected once, not twice', async () => {
    await writeAgedRun('shared-run')
    await writeAgedRun('peer-run')
    await seedState({
      approvals: { [CONSUMER]: approval({ run_id: 'shared-run' }) },
      pending_gates: [
        {
          plugin: 'filler',
          run_id: 'shared-run',
          created_at: new Date(Date.now() - 60_000).toISOString(),
          payload_summary: 'parked',
          plugin_result: {
            status: 'success',
            phases_completed: ['filler'],
            phases_failed: [],
            errors: [],
            data_freshness: {},
            summary: 'parked',
            artifacts_produced: [],
            schema_version: 2,
          },
          run_started_at: new Date(Date.now() - 120_000).toISOString(),
          run_completed_at: new Date(Date.now() - 60_000).toISOString(),
          applied_at: null,
        },
      ],
    } as Partial<EngineState>)

    const result = await advance()

    expect(survives('shared-run')).toBe(true)
    expect(survives('peer-run')).toBe(false)
    // The set is a `Set`, and this is what pins that it stayed one: exactly the
    // peer was reclaimed. A union that counted the shared id twice, or a
    // protected set built as an array the prune de-duplicated differently,
    // would move this integer.
    expect(result.pruned).toBe(1)
  })

  test('with no approvals the protected set is unchanged and ordinary retention reclaims everything due', async () => {
    // Non-vacuity for the two cases above: same fixture, same ages, no record.
    await writeAgedRun('approved-run')
    await writeAgedRun('peer-run')
    await seedState()

    const result = await advance()

    expect(survives('approved-run')).toBe(false)
    expect(survives('peer-run')).toBe(false)
    expect(result.pruned).toBe(2)
  })

  test('an approval whose window has closed stops protecting its run, so ordinary retention reclaims the payload', async () => {
    await writeAgedRun('approved-run')
    await seedState({
      approvals: {
        // Marked-unconfirmed, so the record itself survives the sweep and the
        // only thing under test is whether it still PROTECTS. Without that the
        // record would be gone and this case would pass for two reasons at
        // once.
        [CONSUMER]: approval({
          not_after: CLOSED,
          marked_at: '2026-08-29T12:00:00.000Z',
        }),
      },
    })

    await advance()

    expect(survives('approved-run')).toBe(false)
  })
})

describe('when a content approval is swept', () => {
  beforeEach(async () => {
    home = await createTestHome()
    _setHome(home.root)
    statePath = join(home.stateDir, 'engine-state.json')
    eventsPath = join(home.stateDir, 'events.jsonl')
    approvalPath = join(home.root, '.session-approval')
    await writeFiller()
  })

  afterEach(async () => {
    await home.cleanup()
  })

  test('a closed window with no mark is dropped from the record at the end-of-run write', async () => {
    await seedState({ approvals: { [CONSUMER]: approval({ not_after: CLOSED }) } })

    await advance()

    expect((await readState()).approvals[CONSUMER]).toBeUndefined()
  })

  test('an open window is left alone', async () => {
    // Non-vacuity for the case above: same record, same advance, and the only
    // difference is the bound.
    await seedState({ approvals: { [CONSUMER]: approval() } })

    await advance()

    expect((await readState()).approvals[CONSUMER]).toBeDefined()
  })

  test('a closed window that is marked-unconfirmed survives, because it is the did-it-ship evidence', async () => {
    await seedState({
      approvals: {
        [CONSUMER]: approval({
          not_after: CLOSED,
          marked_at: '2026-08-29T12:00:00.000Z',
          effect_id: 'deadbeef',
        }),
      },
    })

    await advance()

    const after = (await readState()).approvals[CONSUMER]
    expect(after).toBeDefined()
    // D-11a: never replaced by absence, and never silently resolved either. The
    // operator settles it at the sink with the effect id, and until they do the
    // record says exactly what the runtime knows.
    expect(after?.marked_at).toBe('2026-08-29T12:00:00.000Z')
    expect(after?.confirmed_at).toBeNull()
    expect(after?.effect_id).toBe('deadbeef')
  })

  test('a closed window that is confirmed is dropped, and its state-report detail goes with it', async () => {
    await seedState({
      approvals: {
        [CONSUMER]: approval({
          not_after: CLOSED,
          marked_at: '2026-08-29T12:00:00.000Z',
          confirmed_at: '2026-08-29T12:00:05.000Z',
          effect_id: 'deadbeef',
        }),
      },
    })

    await advance()

    expect((await readState()).approvals[CONSUMER]).toBeUndefined()
  })

  test('an approval whose zone this host no longer resolves is retained, and the advance does not throw', async () => {
    // The tzdb backstop edge, and the conservative direction is RETAIN.
    // Deleting a recipient-bound record because the host forgot a timezone is
    // not a deletion policy, it is data loss — and a throw escaping the window
    // check would fail the whole advance over one unparseable record.
    await seedState({
      approvals: {
        [CONSUMER]: approval({ not_after: CLOSED, zone: 'Mars/Olympus_Mons' }),
      },
    })

    const result = await advance()

    expect(result.status).not.toBe('failed')
    expect((await readState()).approvals[CONSUMER]).toBeDefined()
  })
})

describe('when a content approval releases its content', () => {
  beforeEach(async () => {
    home = await createTestHome()
    _setHome(home.root)
    statePath = join(home.stateDir, 'engine-state.json')
    eventsPath = join(home.stateDir, 'events.jsonl')
    approvalPath = join(home.root, '.session-approval')
    await writeFiller()
  })

  afterEach(async () => {
    await home.cleanup()
  })

  test('R1: a closed binding with nothing open on its run erases the content and keeps the record', async () => {
    await seedState({
      plugin_runs: { [PRODUCER]: producerRun(produced()) },
      approvals: { [CONSUMER]: approval({ not_after: CLOSED }) },
    })

    await advance()

    const after = await readState()
    const out = after.plugin_runs[PRODUCER]!.last_output!
    expect('body' in out).toBe(false)
    expect(out.body_sha256).toBe(hex(BODY))
    expect(Number.isNaN(Date.parse(out.erased_at!))).toBe(false)
    expect(out.type).toBe('brief')
    expect(out.format).toBe('json')
    expect(out.run_id).toBe('approved-run')
    expect(out.produced_at).toBe('2026-08-29T10:00:00.000Z')
    expect(after.approvals[CONSUMER]).toBeUndefined()
  })

  test('R1: at the exact closing instant neither the sweep nor the erasure acts, and one millisecond later both do', async () => {
    const t = resolveWallClock(CLOSED, 'UTC')
    await seedState({
      plugin_runs: { [PRODUCER]: producerRun(produced()) },
      approvals: { [CONSUMER]: approval({ not_after: CLOSED }) },
    })

    await advance(t)

    const atClose = await readState()
    expect(atClose.approvals[CONSUMER]).toBeDefined()
    expect('body' in atClose.plugin_runs[PRODUCER]!.last_output!).toBe(true)

    // No re-seed: the binding and body kept at `t` are the record judged at
    // `t + 1`. The filler may not be due at an instant before its own last
    // run, and that does not matter here: `runAdvance` returns early only for
    // quiet hours, so the end-of-run write is reached either way.
    await advance(t + 1)

    const past = await readState()
    expect(past.approvals[CONSUMER]).toBeUndefined()
    const out = past.plugin_runs[PRODUCER]!.last_output!
    expect('body' in out).toBe(false)
    expect(out.erased_at).toBe(new Date(t + 1).toISOString())
  })

  test('R6: a marked-unconfirmed binding past its window keeps its record and loses its content, and a second advance changes neither', async () => {
    await seedState({
      plugin_runs: { [PRODUCER]: producerRun(produced()) },
      approvals: {
        [CONSUMER]: approval({
          not_after: CLOSED,
          marked_at: '2026-08-29T12:00:00.000Z',
          effect_id: 'deadbeef',
        }),
      },
    })

    await advance()

    const first = await readState()
    const kept = first.approvals[CONSUMER]
    expect(kept).toBeDefined()
    expect(kept?.marked_at).toBe('2026-08-29T12:00:00.000Z')
    expect(kept?.effect_id).toBe('deadbeef')
    expect(kept?.confirmed_at).toBeNull()
    const out = first.plugin_runs[PRODUCER]!.last_output!
    expect('body' in out).toBe(false)
    expect(out.erased_at).toBeDefined()

    await advance()

    const second = await readState()
    // A raw `JSON.parse` keeps the written key order, so a rewrite that reorders keys fails this.
    expect(JSON.stringify(second.plugin_runs[PRODUCER])).toBe(
      JSON.stringify(first.plugin_runs[PRODUCER]),
    )
    expect(second.plugin_runs[PRODUCER]!.last_output!.erased_at).toBe(out.erased_at)
    expect(second.approvals[CONSUMER]).toBeDefined()
  })

  test('R1: with two bindings on one run, an open one holds the content until both have closed', async () => {
    await seedState({
      plugin_runs: { [PRODUCER]: producerRun(produced()) },
      approvals: {
        [CONSUMER]: approval({ not_after: CLOSED }),
        'second-sender': approval({ plugin: 'second-sender' }),
      },
    })

    await advance()

    const first = await readState()
    expect(first.plugin_runs[PRODUCER]!.last_output!.body).toBe(BODY)
    // The closed binding is kept while its erasure is deferred. Swept here, it
    // would leave nothing to release the content once the open one closes.
    expect(first.approvals[CONSUMER]).toBeDefined()
    expect(first.approvals['second-sender']).toBeDefined()

    await advance(resolveWallClock(OPEN, 'UTC') + 1)

    const second = await readState()
    const out = second.plugin_runs[PRODUCER]!.last_output!
    expect('body' in out).toBe(false)
    expect(out.erased_at).toBeDefined()
    expect(second.approvals).toEqual({})
  })

  test('R1: an open binding for another producer on the same run does not hold the content', async () => {
    await seedState({
      plugin_runs: { [PRODUCER]: producerRun(produced()) },
      approvals: {
        [CONSUMER]: approval({ not_after: CLOSED }),
        'other-sender': approval({ plugin: 'other-sender', producer: 'another-producer' }),
      },
    })

    await advance()

    // A run id is the advance's, shared by every plugin in it. The other
    // producer's approval never reads these bytes, so it cannot hold them.
    const after = await readState()
    const out = after.plugin_runs[PRODUCER]!.last_output!
    expect('body' in out).toBe(false)
    expect(out.erased_at).toBeDefined()
    expect(after.approvals[CONSUMER]).toBeUndefined()
    expect(after.approvals['other-sender']).toBeDefined()
  })

  test('R1: a producer that produces again in the same advance keeps its new content', async () => {
    await writeAutonomous(
      PRODUCER,
      `[{ type: 'brief', format: 'json', body: '{"batch":"thirteen invoices"}' }]`,
    )
    await seedState({
      plugin_runs: { [PRODUCER]: producerRun(produced()) },
      approvals: { [CONSUMER]: approval({ not_after: CLOSED }) },
    })

    const result = await advance()

    const out = (await readState()).plugin_runs[PRODUCER]!.last_output!
    expect(out.body).toBe('{"batch":"thirteen invoices"}')
    expect(out.run_id).toBe(result.run_id)
    expect('erased_at' in out).toBe(false)
  })

  test('WR-03: content an overlapping advance erased is not written back by this one', async () => {
    // Stands in for a second advance whose end-of-run write lands while this
    // one is mid-run: it erases the producer's body and sweeps the binding.
    // Run as a plugin, so the write lands between this advance's read and its
    // own end-of-run write, which is the window two advances overlap in.
    const stamp = '2026-09-18T00:00:00.000Z'
    const dir = join(home.pluginsDir, 'interloper')
    await writeAutonomous('interloper')
    await writeFile(
      join(dir, 'handler.ts'),
      `import { readFileSync, writeFileSync } from 'node:fs'
export async function handler() {
  const doc = JSON.parse(readFileSync(${JSON.stringify(statePath)}, 'utf-8'))
  const { body, ...rest } = doc.plugin_runs[${JSON.stringify(PRODUCER)}].last_output
  doc.plugin_runs[${JSON.stringify(PRODUCER)}].last_output = {
    ...rest,
    erased_at: ${JSON.stringify(stamp)},
    body_sha256: ${JSON.stringify(hex(BODY))},
  }
  doc.approvals = {}
  writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(doc))
  return {
    status: 'success',
    phases_completed: ['run'],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: 'ran',
    artifacts_produced: [],
    schema_version: 1,
  }
}
`,
    )
    await seedState({
      plugin_runs: { [PRODUCER]: producerRun(produced()) },
      approvals: { [CONSUMER]: approval({ not_after: CLOSED }) },
    })

    await advance()

    const out = (await readState()).plugin_runs[PRODUCER]!.last_output!
    expect('body' in out).toBe(false)
    expect(out.erased_at).toBe(stamp)
    expect(out.body_sha256).toBe(hex(BODY))
    expect(out.run_id).toBe('approved-run')
  })

  test('R7: a live denial on the producer is still live after its content is erased', async () => {
    const manifest = PluginManifestSchema.parse(await writeAutonomous(PRODUCER))
    const seeded: EngineState = {
      ...defaultEngineState(),
      plugin_runs: { [PRODUCER]: producerRun(produced()) },
      approvals: { [CONSUMER]: approval({ not_after: CLOSED }) },
    }
    seeded.denials = {
      [PRODUCER]: {
        plugin: PRODUCER,
        reason: 'the operator said no to this batch',
        denied_at: '2026-08-29T11:30:00.000Z',
        note: null,
        fingerprint: proposalFingerprint(seeded, PRODUCER, manifest),
      },
    }
    expect(denialStanding(seeded, PRODUCER, manifest).standing).toBe('live')
    await writeFile(statePath, JSON.stringify(seeded))

    await advance()

    const after = await readState()
    const out = after.plugin_runs[PRODUCER]!.last_output!
    expect(out.erased_at).toBeDefined()
    expect('body' in out).toBe(false)
    expect(denialStanding(after, PRODUCER, manifest).standing).toBe('live')
  })
})

/**
 * These are pins. Each is paired with a positive case in the describe above
 * and differs from it by the one condition its title names, so a pin cannot
 * pass because the erasure never ran at all.
 *
 * The null pairing guards against a loose equality between a binding's null
 * `run_id` and an Output that carries no `run_id`: both are "no run", and
 * neither names one. The file-pointer case records that the runtime erases
 * only the bytes it holds.
 */
describe('content erasure leaves everything else alone', () => {
  beforeEach(async () => {
    home = await createTestHome()
    _setHome(home.root)
    statePath = join(home.stateDir, 'engine-state.json')
    eventsPath = join(home.stateDir, 'events.jsonl')
    approvalPath = join(home.root, '.session-approval')
    await writeFiller()
  })

  afterEach(async () => {
    await home.cleanup()
  })

  /** Seed, advance once, and assert the producer's entry did not move. */
  async function leftAlone(patch: Partial<EngineState>): Promise<void> {
    await seedState(patch)
    const before = structuredClone(patch.plugin_runs?.[PRODUCER])

    const result = await advance()

    expect(result.status).not.toBe('failed')
    // Widened: the entry may be absent on both sides, and the index type
    // alone does not say so.
    const after = (await readState()).plugin_runs[PRODUCER] as PluginRun | undefined
    expect(after).toEqual(before)
  }

  test('R5: a closed binding naming another run leaves the Output alone', async () => {
    await leftAlone({
      plugin_runs: { [PRODUCER]: producerRun(produced({ run_id: 'newer-run' })) },
      approvals: { [CONSUMER]: approval({ not_after: CLOSED }) },
    })
  })

  test('R5: a binding with a null run id leaves an Output that carried none alone', async () => {
    // Built without the key. Setting it to undefined would read the same after
    // `JSON.stringify` drops it, and hide what the case is about.
    const noRunId = {
      type: 'brief',
      format: 'json',
      body: BODY,
      produced_at: '2026-08-29T10:00:00.000Z',
    } as StoredOutputRecord
    expect('run_id' in noRunId).toBe(false)
    await leftAlone({
      plugin_runs: { [PRODUCER]: producerRun(noRunId) },
      approvals: { [CONSUMER]: approval({ run_id: null, not_after: CLOSED }) },
    })
  })

  test('R5: an open binding leaves the Output alone', async () => {
    await leftAlone({
      plugin_runs: { [PRODUCER]: producerRun(produced()) },
      approvals: { [CONSUMER]: approval() },
    })
  })

  test('R5: a binding whose zone the host cannot resolve leaves the Output alone', async () => {
    await leftAlone({
      plugin_runs: { [PRODUCER]: producerRun(produced()) },
      approvals: { [CONSUMER]: approval({ not_after: CLOSED, zone: 'Mars/Olympus_Mons' }) },
    })
  })

  test('R5: a closed binding for a producer with no plugin_runs entry changes nothing and does not fail', async () => {
    await leftAlone({
      approvals: { [CONSUMER]: approval({ not_after: CLOSED }) },
    })
  })

  test('a file-pointer Output is never erased', async () => {
    await leftAlone({
      plugin_runs: {
        [PRODUCER]: producerRun({
          type: 'report',
          format: 'markdown',
          path: 'report.md',
          run_id: 'approved-run',
          produced_at: '2026-08-29T10:00:00.000Z',
        } as StoredOutputRecord),
      },
      approvals: { [CONSUMER]: approval({ not_after: CLOSED }) },
    })
  })
})
