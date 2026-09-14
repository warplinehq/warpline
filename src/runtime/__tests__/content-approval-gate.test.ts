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
import { randomUUID } from 'node:crypto'
import { runAdvance, proposalFingerprint } from '../engine.js'
import { mergeGrant } from '../approval-gate.js'
import { PluginManifestSchema } from '../../schemas/plugin-manifest.js'
import type { PluginManifest } from '../../schemas/plugin-manifest.js'
import { defaultEngineState } from '../../schemas/engine-state.js'
import type { EngineState } from '../../schemas/engine-state.js'
import type { OutputRecord } from '../../schemas/skill-result.js'
import { createTestHome, type TestHome } from './helpers/create-test-home.js'

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

let home: TestHome
let sentinel: string

/** A wall clock far enough out that no test run reaches it. */
const FAR_FUTURE = '2099-01-01T00:00'
const ZONE = 'UTC'

interface PluginSpec {
  readonly dependencies?: string[]
  readonly sideEffects?: string[]
  readonly approvalClass?: 'session' | 'content'
  readonly autonomy?: 'autonomous' | 'supervised' | 'manual'
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
  // The sentinel path is baked in as a literal rather than read from the
  // environment: `import()` caches the module, and a handler that resolves its
  // own target at call time is one more thing that can be wrong in a way this
  // file cannot see.
  await writeFile(
    join(dir, 'handler.ts'),
    `
import { writeFileSync } from 'node:fs'
export async function handler() {
  writeFileSync(${JSON.stringify(sentinel)}, 'the effect fired')
  return {
    status: 'success',
    phases_completed: ['send'],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: 'sent',
    artifacts_produced: [],
    schema_version: 1,
  }
}
`,
  )
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

async function advance(): Promise<Awaited<ReturnType<typeof runAdvance>>> {
  return runAdvance({
    pluginsDir: home.pluginsDir,
    stateDir: statePath(),
    runsDir: home.runsDir,
    eventsPath: join(home.runsDir, 'events.jsonl'),
    approvalPath: join(home.root, '.session-approval'),
  })
}

beforeEach(async () => {
  // review_gate false for now. The shipped default is true, and under it an
  // `autonomous` plugin is promoted to `supervised` after invocation and parks
  // a gate — which would stop the level loop behind the very send this file is
  // proving. Task 3 adds the exemption that makes the default safe and flips
  // this fixture back to it.
  home = await createTestHome({ preferences: { review_gate: false } })
  sentinel = join(tmpdir(), `warpline-content-sentinel-${randomUUID()}`)
})

afterEach(async () => {
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
    await writePlugin(PRODUCER, {})
    await writePlugin(CONSUMER, {
      dependencies: [PRODUCER],
      sideEffects: ['sends_email'],
      approvalClass: 'content',
    })

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
    await writePlugin(PRODUCER, {})
    await writePlugin(CONSUMER, {
      dependencies: [PRODUCER],
      sideEffects: ['sends_email'],
      approvalClass: 'content',
    })

    const state = seedState(APPROVED_BODY)
    state.approvals[CONSUMER] = approvalFor(APPROVED_BODY)
    await writeState(state)

    await advance()

    expect(existsSync(sentinel)).toBe(true)
    expect(await readFile(sentinel, 'utf-8')).toBe('the effect fired')
  })
})
