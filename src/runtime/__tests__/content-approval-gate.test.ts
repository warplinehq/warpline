/**
 * An operator's approved bytes fire on a later unattended advance, and nothing
 * else does.
 *
 * This is the phase's tracer: one content-class manifest, one approval record,
 * one predicate, one handler firing. The two halves below are the whole claim,
 * and they are written as one file because neither is evidence without the
 * other.
 *
 *   NEGATIVE, the one that matters. A content-class consumer holding a LIVE
 *   `scopes: '*'` session grant and a DRIFTED frozen batch must not fire. The
 *   wildcard grant is the point: if the two authorities composed additively the
 *   freeze would be decorative, and a live wildcard is the cheapest way to
 *   prove they do not. The drift is one byte in the producer's `last_output`,
 *   which is the smallest change a fingerprint comparison must still catch.
 *
 *   POSITIVE, proving the negative is not vacuous. The same consumer with a
 *   byte-identical Output and a live in-window approval DOES fire, with no
 *   session grant anywhere. Without this half the negative half passes on a
 *   fixture whose handler could never have run for reasons that have nothing to
 *   do with the gate.
 *
 * **The assertion is a sentinel file written OUTSIDE the test home, not a
 * reason string.** A reason string is the runtime's account of what it decided;
 * the sentinel is what the handler actually did. This repository's recorded
 * failure — six times over — is a guard running green while the thing it exists
 * to catch sits outside its reach, and a gate asserted on its own narration is
 * exactly that shape. Outside the home because a path under `ctx.root` is
 * removed by `cleanup()` whether the handler wrote it or not, which would make
 * the absence assertion true for the wrong reason.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import {
  runAdvance,
  proposalFingerprint,
  approvalStanding,
  contentEffectId,
  evaluatePlugin,
} from '../engine.js'
import type { EvalContext } from '../engine.js'
import { mergeGrant } from '../approval-gate.js'
import { PluginManifestSchema } from '../../schemas/plugin-manifest.js'
import type { PluginManifest } from '../../schemas/plugin-manifest.js'
import { defaultEngineState } from '../../schemas/engine-state.js'
import type { EngineState } from '../../schemas/engine-state.js'
import type { OutputRecord, StoredOutputRecord } from '../../schemas/skill-result.js'
import { createTestHome, type TestHome } from './helpers/create-test-home.js'
import { _setHome } from '../../lib/paths.js'

/** The bytes the operator reads and approves. */
const APPROVED_BODY = '{"batch":"the twelve invoices the operator read"}'
/** The same batch with one byte changed. Nothing else about it moves. */
const DRIFTED_BODY = APPROVED_BODY.replace('twelve', 'thirteen')

const PRODUCER = 'batch-builder'
const CONSUMER = 'batch-sender'

const outputOf = (body: string): OutputRecord => ({
  type: 'brief',
  format: 'json',
  body,
})

/**
 * The same Output after the runtime erased its content: no `body`, the erasure
 * stamped, and the hash of what it held kept so the fingerprint does not move.
 */
const erasedOf = (body: string): StoredOutputRecord => ({
  type: 'brief',
  format: 'json',
  erased_at: '2026-09-15T00:00:00.000Z',
  body_sha256: createHash('sha256').update(body, 'utf8').digest('hex'),
})

let home: TestHome
let sentinel: string

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

interface PluginSpec {
  readonly dependencies?: string[]
  readonly sideEffects?: string[]
  readonly approvalClass?: 'session' | 'content'
  readonly autonomy?: 'autonomous' | 'supervised' | 'manual'
  /**
   * Whether this plugin's handler writes the sentinel. Off by default, so a
   * fixture plugin that merely has to EXIST cannot write the file the
   * assertions read and make a negative case pass or fail for a reason that has
   * nothing to do with the gate.
   */
  readonly sends?: boolean
}

async function writePlugin(name: string, spec: PluginSpec): Promise<void> {
  const dir = join(home.pluginsDir, name)
  await mkdir(dir, { recursive: true })
  const manifest = {
    name,
    version: '1.0.0',
    description: `${name} content-approval fixture`,
    inputs: {},
    outputs: {},
    capabilities: [],
    schedule: 'on_run',
    autonomy_level: spec.autonomy ?? 'autonomous',
    side_effects: spec.sideEffects ?? [],
    approval_class: spec.approvalClass ?? 'session',
    ttl_hours: 24,
    dependencies: spec.dependencies ?? [],
    timeout_ms: 5000,
    max_parallelism: 1,
  }
  await writeFile(join(dir, 'manifest.ts'), `export const manifest = ${JSON.stringify(manifest)}`)

  // The sentinel path is baked into the handler as a literal rather than read
  // from the environment: `import()` caches the module, so a handler resolving
  // its own target at call time is one more thing that can be wrong in a way
  // this file cannot see.
  const body = spec.sends
    ? `import { writeFileSync } from 'node:fs'
export async function handler() {
  writeFileSync(${JSON.stringify(sentinel)}, 'the effect fired')
  return ${RESULT}
}
`
    : `export async function handler() {
  return ${RESULT}
}
`
  await writeFile(join(dir, 'handler.ts'), body)
}

const statePath = (): string => join(home.stateDir, 'engine-state.json')

/**
 * The producer's manifest as the runtime will parse it, so the fingerprint this
 * file computes is produced by the same arithmetic the gate will use rather
 * than by a hand-built lookalike.
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

/**
 * A state document in which the producer has already run and is still fresh.
 *
 * Fresh on purpose. A producer that re-runs on the asserted advance overwrites
 * its own `last_output`, and the drift this file installs would be undone by
 * the fixture before the gate ever read it.
 */
function seedState(body: string): EngineState {
  const state = defaultEngineState()
  state.plugin_runs[PRODUCER] = {
    last_run_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    status: 'success',
    last_output: outputOf(body),
  }
  return state
}

async function writeState(state: EngineState): Promise<void> {
  await writeFile(statePath(), JSON.stringify(state))
}

/**
 * The approval the operator wrote, bound to the fingerprint of `approvedBody`.
 *
 * Computed through `proposalFingerprint` with the PRODUCER as its subject,
 * which is the one entry point. A hand-rolled hash here would prove this file
 * agrees with itself.
 */
function approvalFor(approvedBody: string): EngineState['approvals'][string] {
  const fingerprintState = seedState(approvedBody)
  return {
    plugin: CONSUMER,
    producer: PRODUCER,
    fingerprint: proposalFingerprint(fingerprintState, PRODUCER, producerManifest()),
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

async function advance(now?: number): Promise<Awaited<ReturnType<typeof runAdvance>>> {
  return runAdvance({
    pluginsDir: home.pluginsDir,
    stateDir: statePath(),
    runsDir: home.runsDir,
    eventsPath: join(home.runsDir, 'events.jsonl'),
    approvalPath: join(home.root, '.session-approval'),
    now,
  })
}

async function readState(): Promise<EngineState> {
  return JSON.parse(await readFile(statePath(), 'utf-8')) as EngineState
}

/** The producer and the consumer, in the shape every case below wants them. */
async function writeTracerPair(): Promise<void> {
  await writePlugin(PRODUCER, {})
  await writePlugin(CONSUMER, {
    dependencies: [PRODUCER],
    sideEffects: ['sends_email'],
    approvalClass: 'content',
    sends: true,
  })
}

/** An `EvalContext` over the fixture, for the cases that assert the decision. */
function evalCtxFor(state: EngineState, consumerManifest: PluginManifest): EvalContext {
  return {
    currentTier: 'normal',
    force: false,
    state,
    approvalPath: join(home.root, '.session-approval'),
    manifests: new Map([
      [PRODUCER, producerManifest()],
      [CONSUMER, consumerManifest],
    ]),
  }
}

/** The consumer's manifest as the runtime parses it. */
function consumerManifestFor(producer: string): PluginManifest {
  return PluginManifestSchema.parse({
    name: CONSUMER,
    version: '1.0.0',
    description: 'consumer',
    autonomy_level: 'autonomous',
    side_effects: ['sends_email'],
    approval_class: 'content',
    dependencies: [producer],
    ttl_hours: 24,
  })
}

beforeEach(async () => {
  // The SHIPPED default, not the helper's test-friendly one. Everything in this
  // file is proven under `review_gate: true`, which is what an operator
  // actually runs — a fixture that disabled the review gate would prove the
  // send works in a configuration nobody has.
  home = await createTestHome({ preferences: { review_gate: true } })
  sentinel = join(tmpdir(), `warpline-content-sentinel-${randomUUID()}`)
})

afterEach(async () => {
  // Restored unconditionally. The override is process-global and the state
  // helpers resolve through it, so a home left pointing at a removed temp dir
  // leaks into whatever file bun runs next.
  _setHome(null)
  await rm(sentinel, { force: true })
  await home.cleanup()
})

describe('a content approval fires the approved bytes and nothing else', () => {
  /**
   * The wildcard grant is live and wide, and it buys the consumer nothing: the
   * content class does not consult it. What decides is that the frozen batch
   * moved, so the operator's yes no longer answers what would ship.
   */
  test('a drifted batch does not fire, even under a live wildcard session grant', async () => {
    await writeTracerPair()

    const state = seedState(DRIFTED_BODY)
    state.approvals[CONSUMER] = approvalFor(APPROVED_BODY)
    await writeState(state)

    await mergeGrant('*', { now: Date.now() }, join(home.root, '.session-approval'))

    await advance()

    expect(existsSync(sentinel)).toBe(false)
  })

  /**
   * No grant of any kind exists here. The approval record is the whole
   * authority, which is what makes the negative half above a statement about
   * the content path rather than about a missing fixture.
   */
  test('a byte-identical batch fires under the approval alone, with no session grant', async () => {
    await writeTracerPair()

    const state = seedState(APPROVED_BODY)
    state.approvals[CONSUMER] = approvalFor(APPROVED_BODY)
    await writeState(state)

    await advance()

    expect(existsSync(sentinel)).toBe(true)
    expect(await readFile(sentinel, 'utf-8')).toBe('the effect fired')
  })

  /**
   * The wildcard grant would admit any session-class plugin declaring these
   * effects. A content-class plugin with nothing on file is not admitted by it,
   * which is the disjointness stated as an outcome rather than as a comment.
   */
  test('a content-class plugin with no approval on file does not fire under a wildcard grant', async () => {
    await writeTracerPair()
    await writeState(seedState(APPROVED_BODY))
    await mergeGrant('*', { now: Date.now() }, join(home.root, '.session-approval'))

    await advance()

    expect(existsSync(sentinel)).toBe(false)
  })

  /**
   * The mirror image, and it is what makes the case above a statement about the
   * class rather than about the record: a SESSION-class plugin is unaffected by
   * an approvals entry, whether or not one is there. The record is not consulted
   * for it at all, so the wildcard grant alone decides — and here there is none.
   */
  test('the approvals record buys a session-class plugin nothing', async () => {
    await writePlugin(PRODUCER, {})
    await writePlugin(CONSUMER, {
      dependencies: [PRODUCER],
      sideEffects: ['sends_email'],
      approvalClass: 'session',
      sends: true,
    })

    const state = seedState(APPROVED_BODY)
    state.approvals[CONSUMER] = approvalFor(APPROVED_BODY)
    await writeState(state)

    await advance()

    expect(existsSync(sentinel)).toBe(false)
  })

  /**
   * A lapsed window does not fire, and — the half worth asserting — it does not
   * quietly extend itself or re-approve.
   *
   * This used to assert that the record on disk was BYTE-IDENTICAL afterwards,
   * which was the cheapest way to say "nothing rewrote it". It no longer is,
   * and not because the guard weakened: a lapsed, unmarked record is now SWEPT
   * by the end-of-run assembly, because retaining a recipient-bound binding
   * past its window with no deletion path is the thing the fourth Prohibition
   * forbids. Absence is a strictly stronger answer than byte-identity to the
   * question this case asks — a record that is gone has certainly not extended
   * itself — so the assertion moved rather than being dropped. The sweep's own
   * arms, including the marked-unconfirmed record it must NOT delete, are
   * `approval-retention.test.ts`.
   */
  test('a lapsed window does not fire, does not extend and does not re-approve', async () => {
    await writeTracerPair()

    const state = seedState(APPROVED_BODY)
    state.approvals[CONSUMER] = { ...approvalFor(APPROVED_BODY), not_after: '2020-01-01T00:00' }
    await writeState(state)
    expect((await readState()).approvals[CONSUMER]).toBeDefined()

    await advance()

    expect(existsSync(sentinel)).toBe(false)
    // Not extended, not re-approved, and not left behind either.
    expect((await readState()).approvals[CONSUMER]).toBeUndefined()
  })

  /**
   * Approve against X, then rewrite the consumer's single declared dependency to
   * Y. X's Output has not moved and the stored fingerprint still matches it — so
   * a fingerprint comparison alone reads `live` and ships Y's bytes, which no
   * human reviewed. The producer-identity conjunct is the only thing between
   * that edit and an unreviewed send.
   */
  test('rewriting the declared dependency after approval does not fire', async () => {
    const OTHER = 'other-builder'
    await writePlugin(PRODUCER, {})
    await writePlugin(OTHER, {})
    await writePlugin(CONSUMER, {
      dependencies: [OTHER],
      sideEffects: ['sends_email'],
      approvalClass: 'content',
      sends: true,
    })

    const state = seedState(APPROVED_BODY)
    // The record still names the producer the operator read, and its Output is
    // untouched — the drift is in the manifest, not in the bytes.
    state.approvals[CONSUMER] = approvalFor(APPROVED_BODY)
    await writeState(state)

    await advance()

    expect(existsSync(sentinel)).toBe(false)
    expect(
      approvalStanding(
        await readState(),
        CONSUMER,
        new Map([
          [PRODUCER, producerManifest()],
          [CONSUMER, consumerManifestFor(OTHER)],
        ]),
        Date.now(),
      ).standing,
    ).toBe('content_moved')
  })
})

/**
 * The review gate promotes an `autonomous` plugin to `supervised` after
 * invocation, and a parked gate stops the level loop. Left unexempted, a
 * content-approved sender would fire, park, and halt everything behind it on
 * every advance — for a review the operator already performed when they read
 * the bytes.
 *
 * The exemption is SCOPED, and the third case is what proves that rather than
 * asserting it: an ordinary `autonomous` plugin in the same home is still
 * promoted. Without it these cases are equally green on a blanket disable.
 */
describe('the review gate and the content class', () => {
  async function fireUnderGate(reviewGate: boolean): Promise<EngineState> {
    // The preferences file is read once per advance, and `beforeEach` already
    // built a home — so this replaces it rather than shadowing it, and removes
    // the first one so nothing is left under tmpdir.
    await home.cleanup()
    home = await createTestHome({ preferences: { review_gate: reviewGate } })
    await writeTracerPair()
    const state = seedState(APPROVED_BODY)
    state.approvals[CONSUMER] = approvalFor(APPROVED_BODY)
    await writeState(state)

    expect((await readState()).pending_gates).toHaveLength(0)
    await advance()
    return await readState()
  }

  test('a content-approved send fires under review_gate: true and parks no gate', async () => {
    const after = await fireUnderGate(true)

    expect(existsSync(sentinel)).toBe(true)
    expect(after.pending_gates).toHaveLength(0)
  })

  test('the outcome with the review gate turned off is identical', async () => {
    const after = await fireUnderGate(false)

    expect(existsSync(sentinel)).toBe(true)
    expect(after.pending_gates).toHaveLength(0)
  })

  test('an ordinary autonomous plugin in the same advance is still promoted', async () => {
    const PLAIN = 'plain-autonomous'
    await writePlugin(PRODUCER, {})
    await writePlugin(CONSUMER, {
      dependencies: [PRODUCER],
      sideEffects: ['sends_email'],
      approvalClass: 'content',
      sends: true,
    })
    // Same level as the consumer, so both are evaluated in one pass and the
    // exemption is observed as a DIFFERENCE between two plugins rather than as
    // a fact about a home.
    await writePlugin(PLAIN, { dependencies: [PRODUCER] })

    const state = seedState(APPROVED_BODY)
    state.approvals[CONSUMER] = approvalFor(APPROVED_BODY)
    await writeState(state)

    await advance()

    const after = await readState()
    expect(existsSync(sentinel)).toBe(true)
    expect(after.pending_gates).toHaveLength(1)
    expect(after.pending_gates[0]!.plugin).toBe(PLAIN)
  })
})

describe('the content-authority decision', () => {
  /**
   * Before the opening bound is ORDINARY not-due. It is the operator's own
   * instruction arriving on time, so the gate reports the window and nothing
   * stronger — a refusal here would tell them they did something wrong.
   */
  test('before not_before is ordinary not-due, naming the window', async () => {
    const state = seedState(APPROVED_BODY)
    const soon = new Date(Date.now() + 60 * 60 * 1000)
    state.approvals[CONSUMER] = {
      ...approvalFor(APPROVED_BODY),
      not_before: soon.toISOString().slice(0, 16),
    }

    const manifest = consumerManifestFor(PRODUCER)
    const result = await evaluatePlugin(CONSUMER, manifest, evalCtxFor(state, manifest), Date.now())

    expect(result.due).toBe(false)
    if (result.due) throw new Error('unreachable')
    expect(result.reason).toBe('unapproved')
    expect(result.detail).toContain('has not opened yet')
  })

  /**
   * Determinism, narrowed to what is actually claimed: the CONTENT-AUTHORITY
   * decision is a pure function of `(state, manifest, now)`. Not the advance
   * result, whose `run_id`, `started_at` and `completed_at` are unseeded clock
   * reads by design.
   */
  test('two evaluations at one injected instant produce an identical authority', async () => {
    const state = seedState(APPROVED_BODY)
    state.approvals[CONSUMER] = approvalFor(APPROVED_BODY)

    const manifest = consumerManifestFor(PRODUCER)
    const ctx = evalCtxFor(state, manifest)
    // One instant, captured once and injected into both evaluations. Read from
    // the clock rather than frozen: every fixture here derives from the live
    // clock (`approvalFor` sets `approved_at` to now - 30min with a null
    // `not_before`), so a frozen literal drifts out of the approval window and
    // the case stops being due — a time bomb, not a determinism check.
    const now = Date.now()

    const first = await evaluatePlugin(CONSUMER, manifest, ctx, now)
    const second = await evaluatePlugin(CONSUMER, manifest, ctx, now)

    expect(first.due).toBe(true)
    if (!first.due || !second.due) throw new Error('unreachable')
    expect(first.content).toBeDefined()
    expect(first.content).toEqual(second.content!)
    expect(first.content!.effect_id).toBe(
      contentEffectId(CONSUMER, first.content!.fingerprint, first.content!.fire_instant),
    )
  })

  /**
   * The refusal detail carries no operator-typed value.
   *
   * The window bounds and the zone arrive on a command line and are stored
   * verbatim, and the approvals record on disk is hand-editable besides — so
   * none of the three may reach a detail string, which lands in the run log's
   * summary, the board event and `warpline plan`, all of them read and shared.
   * Asserted as an ABSENCE of distinctive sentinel values rather than as a
   * substring match on the wording: the wording is allowed to change, and a
   * leak appended to a correct sentence is invisible to `toContain`.
   */
  test('a refusal detail carries no operator-typed window value', async () => {
    const state = seedState(APPROVED_BODY)
    state.approvals[CONSUMER] = {
      ...approvalFor(APPROVED_BODY),
      not_after: '2020-03-14T15:09',
      zone: 'America/Argentina/Ushuaia',
    }

    const manifest = consumerManifestFor(PRODUCER)
    const result = await evaluatePlugin(CONSUMER, manifest, evalCtxFor(state, manifest), Date.now())

    expect(result.due).toBe(false)
    if (result.due) throw new Error('unreachable')
    expect(result.detail).not.toContain('2020-03-14T15:09')
    expect(result.detail).not.toContain('Ushuaia')
    expect(result.detail).not.toContain('Argentina')
    // Non-vacuity: the detail is a real refusal, not an empty string that would
    // satisfy every assertion above.
    expect(result.detail).toContain('window has closed')
  })

  /**
   * The same for the content-moved arm. The record's `producer` is exactly the
   * name that may no longer be the declared dependency, so it is not a declared
   * plugin name and does not belong in a shared string. The hex fingerprint is
   * runtime-derived and does.
   */
  test('the content-moved detail carries the fingerprint and no producer name', async () => {
    const OTHER = 'other-builder'
    const state = seedState(APPROVED_BODY)
    state.approvals[CONSUMER] = approvalFor(APPROVED_BODY)

    // The manifest now declares OTHER, so the record's producer is stale.
    const manifest = consumerManifestFor(OTHER)
    const ctx: EvalContext = {
      currentTier: 'normal',
      force: false,
      state,
      approvalPath: join(home.root, '.session-approval'),
      manifests: new Map([
        [PRODUCER, producerManifest()],
        [CONSUMER, manifest],
      ]),
    }

    const result = await evaluatePlugin(CONSUMER, manifest, ctx, Date.now())

    expect(result.due).toBe(false)
    if (result.due) throw new Error('unreachable')
    expect(result.detail).not.toContain(PRODUCER)
    expect(result.detail).toContain(state.approvals[CONSUMER]!.fingerprint)
  })

  /**
   * The erased arm shares the reason code and must not share the cause. Its
   * fingerprint still matches by design, so the drift sentence would send an
   * operator looking for a change that did not happen.
   */
  test('the content-moved detail over erased content says erased, not moved', async () => {
    const state = seedState(APPROVED_BODY)
    state.approvals[CONSUMER] = approvalFor(APPROVED_BODY)
    state.plugin_runs[PRODUCER] = {
      ...state.plugin_runs[PRODUCER]!,
      last_output: erasedOf(APPROVED_BODY),
    }
    const manifest = consumerManifestFor(PRODUCER)
    const ctx: EvalContext = {
      currentTier: 'normal',
      force: false,
      state,
      approvalPath: join(home.root, '.session-approval'),
      manifests: new Map([
        [PRODUCER, producerManifest()],
        [CONSUMER, manifest],
      ]),
    }

    const result = await evaluatePlugin(CONSUMER, manifest, ctx, Date.now())

    expect(result.due).toBe(false)
    if (result.due) throw new Error('unreachable')
    expect(result.reason).toBe('unapproved')
    expect(result.detail).toContain('erased')
    expect(result.detail).toContain('still matches')
    expect(result.detail).not.toContain('no longer what would ship')
    expect(result.detail).not.toContain(PRODUCER)
    expect(result.detail).toContain(state.approvals[CONSUMER]!.fingerprint)
  })

  /**
   * The backstop edge. A host tz database that no longer knows the zone must
   * land on a refusal, never on a fire and never on a throw — a throw here would
   * reach `plan`, which is contracted never to fail.
   */
  test('a zone the host cannot resolve refuses rather than throwing', () => {
    const state = seedState(APPROVED_BODY)
    state.approvals[CONSUMER] = { ...approvalFor(APPROVED_BODY), zone: 'Mars/Olympus_Mons' }

    const standing = approvalStanding(
      state,
      CONSUMER,
      new Map([
        [PRODUCER, producerManifest()],
        [CONSUMER, consumerManifestFor(PRODUCER)],
      ]),
      Date.now(),
    )

    expect(standing.standing).toBe('outside_window')
  })

  /**
   * The other fail-open edge. With no `not_before`, the window opens at
   * `approved_at`, and `Date.parse` answers an unreadable one with NaN. Every
   * comparison against NaN is false, so without a guard the window reads open.
   */
  test('an approved_at that cannot be parsed refuses rather than opening the window', () => {
    const state = seedState(APPROVED_BODY)
    state.approvals[CONSUMER] = { ...approvalFor(APPROVED_BODY), approved_at: 'not-an-instant' }

    const standing = approvalStanding(
      state,
      CONSUMER,
      new Map([
        [PRODUCER, producerManifest()],
        [CONSUMER, consumerManifestFor(PRODUCER)],
      ]),
      Date.now(),
    )

    expect(standing.standing).toBe('outside_window')
  })

  /**
   * The two state reports. Neither is the operator having done something wrong,
   * and neither fires.
   */
  test('a spent approval reports spent and a marked-but-unconfirmed one reports indeterminate', () => {
    const state = seedState(APPROVED_BODY)
    const manifests = new Map([
      [PRODUCER, producerManifest()],
      [CONSUMER, consumerManifestFor(PRODUCER)],
    ])

    state.approvals[CONSUMER] = {
      ...approvalFor(APPROVED_BODY),
      marked_at: '2026-09-14T11:00:00.000Z',
      confirmed_at: '2026-09-14T11:00:01.000Z',
    }
    expect(approvalStanding(state, CONSUMER, manifests, Date.now()).standing).toBe('spent')

    state.approvals[CONSUMER] = {
      ...approvalFor(APPROVED_BODY),
      marked_at: '2026-09-14T11:00:00.000Z',
    }
    expect(approvalStanding(state, CONSUMER, manifests, Date.now()).standing).toBe('indeterminate')
  })

  /**
   * Erasure is invisible to the fingerprint on purpose: the stored hash keeps
   * it equal, so a denial stays bound. That means the compare cannot be what
   * refuses here. Both preconditions are asserted first, so a fixture whose
   * fingerprint had moved would fail loudly instead of passing for the wrong
   * reason.
   */
  test('an approval over erased content refuses content_moved though the fingerprint still matches', () => {
    const state = seedState(APPROVED_BODY)
    const approval = approvalFor(APPROVED_BODY)
    state.approvals[CONSUMER] = approval
    const manifests = new Map([
      [PRODUCER, producerManifest()],
      [CONSUMER, consumerManifestFor(PRODUCER)],
    ])
    expect(approvalStanding(state, CONSUMER, manifests, Date.now()).standing).toBe('live')

    state.plugin_runs[PRODUCER] = {
      ...state.plugin_runs[PRODUCER]!,
      last_output: erasedOf(APPROVED_BODY),
    }
    expect(proposalFingerprint(state, PRODUCER, producerManifest())).toBe(approval.fingerprint)

    expect(approvalStanding(state, CONSUMER, manifests, Date.now()).standing).toBe('content_moved')
  })

  /**
   * The lookup is an own-property one. A bare index answers `toString` with an
   * inherited function, and an existence test believes it.
   */
  test('an inherited key is absent, not present', () => {
    const state = seedState(APPROVED_BODY)
    expect(approvalStanding(state, 'toString', new Map(), Date.now()).standing).toBe('none')
  })
})

/**
 * Every refusal reason, in the order the three are decided.
 *
 * Written out by hand rather than read off the schema's own member array: a
 * list derived from the source asserts the implementation against itself,
 * which is the one thing this block exists not to do. The discipline is
 * `gate-order.test.ts:38-48`, copied deliberately.
 *
 * `19-SPEC.md:125` names the three in a different sequence, but that line is a
 * list of the enum's members and its trailing clause reads loosely as a
 * precedence claim. Two other places state the real order — the Acceptance
 * Criteria and Interview Log round 5 — and it is the defensible one: an
 * `indeterminate` mark means the runtime cannot tell whether the bytes already
 * shipped, and that question outranks both "the window closed" and "the bytes
 * moved", neither of which can be answered honestly while the first is open.
 */
const DECLARED_REFUSAL_ORDER = ['indeterminate', 'outside_window', 'content_moved']

describe('a content refusal carries a machine-readable reason', () => {
  /**
   * The consumer's verdict over a state the caller has already shaped, reduced
   * to the one field these cases are about.
   *
   * Asserting `unapproved` on the way through is what keeps a case honest: a
   * fixture that drifted into `fresh` or `dependency_failed` would report
   * `undefined` here and look like a deliberate no-refusal case.
   */
  async function refusalOver(state: EngineState): Promise<string | undefined> {
    const manifest = consumerManifestFor(PRODUCER)
    const result = await evaluatePlugin(CONSUMER, manifest, evalCtxFor(state, manifest), Date.now())

    expect(result.due).toBe(false)
    if (result.due) throw new Error('unreachable')
    expect(result.reason).toBe('unapproved')
    return result.refusal
  }

  /** A record carrying a mark, a lapsed bound AND drifted bytes. */
  function markedLapsedAndDrifted(): EngineState {
    const state = seedState(DRIFTED_BODY)
    state.approvals[CONSUMER] = {
      ...approvalFor(APPROVED_BODY),
      not_after: '2020-01-01T00:00',
      marked_at: '2026-09-14T11:00:00.000Z',
    }
    return state
  }

  /** The same, one condition removed. */
  function lapsedAndDrifted(): EngineState {
    const state = seedState(DRIFTED_BODY)
    state.approvals[CONSUMER] = { ...approvalFor(APPROVED_BODY), not_after: '2020-01-01T00:00' }
    return state
  }

  /** And one more removed: the bytes moved and nothing else did. */
  function driftedOnly(): EngineState {
    const state = seedState(DRIFTED_BODY)
    state.approvals[CONSUMER] = approvalFor(APPROVED_BODY)
    return state
  }

  /**
   * The bytes are gone and nothing else moved. The fingerprint still matches,
   * so this is the erased arm and not the compare.
   */
  function erasedOnly(): EngineState {
    const state = seedState(APPROVED_BODY)
    state.plugin_runs[PRODUCER] = {
      ...state.plugin_runs[PRODUCER]!,
      last_output: erasedOf(APPROVED_BODY),
    }
    state.approvals[CONSUMER] = approvalFor(APPROVED_BODY)
    return state
  }

  test('an erased Output alone reports content_moved', async () => {
    expect(await refusalOver(erasedOnly())).toBe('content_moved')
  })

  /** The erased arm reads only a live binding, so a closed window keeps precedence. */
  test('an erased Output past its window still reports outside_window', async () => {
    const state = erasedOnly()
    state.approvals[CONSUMER] = { ...state.approvals[CONSUMER]!, not_after: '2020-01-01T00:00' }
    expect(await refusalOver(state)).toBe('outside_window')
  })

  test('a marked, lapsed and drifted record reports indeterminate', async () => {
    expect(await refusalOver(markedLapsedAndDrifted())).toBe('indeterminate')
  })

  test('a lapsed and drifted record reports outside_window', async () => {
    expect(await refusalOver(lapsedAndDrifted())).toBe('outside_window')
  })

  test('a drifted record alone reports content_moved', async () => {
    expect(await refusalOver(driftedOnly())).toBe('content_moved')
  })

  /**
   * The order asserted a second time, as a sequence rather than as three
   * independent facts. Each state below drops exactly one condition from the
   * one above it, so the three verdicts walk the precedence from the top down
   * and must land on the hand-written list in the same sequence.
   */
  test('the three cases reproduce the declared order', async () => {
    const observed: (string | undefined)[] = [
      await refusalOver(markedLapsedAndDrifted()),
      await refusalOver(lapsedAndDrifted()),
      await refusalOver(driftedOnly()),
    ]

    expect(observed).toEqual(DECLARED_REFUSAL_ORDER)
  })

  /**
   * A spent approval is a STATE REPORT and not a refusal: the runtime already
   * fired these bytes, which is the operator's instruction having been carried
   * out rather than anything having gone wrong. So it is ordinary not-due and
   * there is nothing for a scheduler to switch on.
   */
  test('a spent approval is ordinary not-due with no refusal', async () => {
    const state = seedState(APPROVED_BODY)
    state.approvals[CONSUMER] = {
      ...approvalFor(APPROVED_BODY),
      marked_at: '2026-09-14T11:00:00.000Z',
      confirmed_at: '2026-09-14T11:00:01.000Z',
    }

    expect(await refusalOver(state)).toBeUndefined()
  })

  /**
   * The same for a window that has not opened: the operator's own instruction
   * arriving on time. A refusal here would tell them they did something wrong.
   */
  test('a window that has not opened is ordinary not-due with no refusal', async () => {
    const state = seedState(APPROVED_BODY)
    const soon = new Date(Date.now() + 60 * 60 * 1000)
    state.approvals[CONSUMER] = {
      ...approvalFor(APPROVED_BODY),
      not_before: soon.toISOString().slice(0, 16),
    }

    expect(await refusalOver(state)).toBeUndefined()
  })

  /**
   * The pair leaves the advance structured, one entry per refused plugin.
   * Never a bare `string[]`, which drops the reason, and never a parallel
   * record keyed by plugin, which is two accounts of one advance.
   */
  test('the advance reports the refused plugin and its reason', async () => {
    await writeTracerPair()
    const state = seedState(DRIFTED_BODY)
    state.approvals[CONSUMER] = approvalFor(APPROVED_BODY)
    await writeState(state)

    const result = await advance()

    expect(result.refused_plugins).toEqual([{ plugin: CONSUMER, reason: 'content_moved' }])
    expect(existsSync(sentinel)).toBe(false)

    // A refusal adds no state of its own. The consumer reads `skipped`, the
    // same as any other not-due plugin. The `has` check comes first, because
    // a missing entry would fail `toBe` with an unhelpful `undefined`.
    expect(result.plugin_states.has(CONSUMER)).toBe(true)
    expect(result.plugin_states.get(CONSUMER)).toBe('skipped')
  })
})

/**
 * A sentinel planted in the approved bytes reaches the operator's terminal and
 * nothing else.
 *
 * The approved content is recipient-bound data sitting one interpolation away
 * from four strings that are read and shared: the run log's `result_summary`,
 * the board event's summary, its `metadata_json`, and the gate `detail` that
 * `warpline plan` renders. This repository has twice paid for an
 * operator-configured value arriving in a result summary.
 *
 * **The four are asserted as exact equality, not `toContain`.** A leak appended
 * to an otherwise correct sentence is invisible to a substring match, which is
 * the reason `engine.ts` states in print at the detail-string docstring.
 *
 * The positive half is not decoration: without it every absence assertion below
 * is equally green on a sentinel the fixture never produced, which is this
 * repository's recorded failure — a guard running green while the thing it
 * exists to catch sits outside its reach.
 */
describe('a content refusal leaks none of the approved bytes', () => {
  /** Distinctive, and alnum-plus-hyphen so the operator escaping cannot alter it. */
  const LEAK = 'SENTINELb7f3donotleak'
  const LEAKY_APPROVED = `{"batch":"${LEAK} the twelve invoices the operator read"}`
  const LEAKY_DRIFTED = LEAKY_APPROVED.replace('twelve', 'thirteen')

  /** The `approve --content` stdout for the fixture, with the home overridden. */
  async function approveByContent(): Promise<string> {
    const realOut = process.stdout.write
    let stdout = ''
    process.stdout.write = ((chunk: string) => {
      stdout += chunk
      return true
    }) as typeof process.stdout.write
    try {
      const { run } = await import('../../cli/approve.js')
      const code = await run([CONSUMER, '--content', '--not-after', FAR_FUTURE])
      expect(code).toBe(0)
    } finally {
      process.stdout.write = realOut
    }
    return stdout
  }

  test('the sentinel reaches the terminal and no persisted string', async () => {
    _setHome(home.root)
    await writeTracerPair()
    await writeState(seedState(LEAKY_APPROVED))

    // The operator reads the bytes and says yes to them. The record the CLI
    // writes is the authority every assertion below is about.
    const approvalStdout = await approveByContent()

    // Then the batch moves under the approval, with the sentinel still in it.
    const drifted = await readState()
    drifted.plugin_runs[PRODUCER]!.last_output = outputOf(LEAKY_DRIFTED)
    await writeState(drifted)

    const result = await advance()
    const after = await readState()
    const fingerprint = after.approvals[CONSUMER]!.fingerprint
    const expectedDetail =
      `unapproved: the approved content has moved — the fingerprint on file ` +
      `(${fingerprint}) is no longer what would ship`

    // -- the sentinel is reachable, which is what makes the absences below mean
    //    something --
    expect(approvalStdout).toContain(LEAK)
    expect(existsSync(sentinel)).toBe(false)

    // -- 1. the run-log entry --
    const runLog = JSON.parse(await readFile(result.run_log_path, 'utf-8')) as {
      plugin_entries: { plugin: string; status: string; reason?: string; result_summary: string }[]
    }
    const entry = runLog.plugin_entries.find((e) => e.plugin === CONSUMER)!
    expect(entry.status).toBe('refused')
    expect(entry.reason).toBe('content_moved')
    expect(entry.result_summary).toBe(expectedDetail)

    // -- 2 and 3. the board event and its metadata --
    const events = (await readFile(join(home.runsDir, 'events.jsonl'), 'utf-8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    const refusal = events.find(
      (e) => e['type'] === 'notice' && String(e['metadata_json']).includes('plugin_refused'),
    )!
    expect(refusal['summary']).toBe(`${CONSUMER}: refused — content_moved`)
    expect(refusal['metadata_json']).toBe(
      JSON.stringify({
        event: 'plugin_refused',
        plugin: CONSUMER,
        run_id: result.run_id,
        reason: 'content_moved',
      }),
    )

    // -- 4. the gate detail `warpline plan` renders --
    const manifest = consumerManifestFor(PRODUCER)
    const ev = await evaluatePlugin(CONSUMER, manifest, evalCtxFor(after, manifest), Date.now())
    expect(ev.due).toBe(false)
    if (ev.due) throw new Error('unreachable')
    expect(ev.detail).toBe(expectedDetail)

    // -- and the record on disk, which an operator shares when they paste a
    //    state document into a bug report --
    expect(JSON.stringify(after.approvals)).not.toContain(LEAK)
  })
})
