/**
 * Approved content is erased from every copy the state document keeps, on the
 * shipped default, once no open approval for its producer binds it.
 *
 * **Why it runs on `review_gate: true`.** That is the shipped default, and it is
 * where the second copy lives. Every autonomous producer that is not
 * content-class parks a review gate, and the gate stores the whole result,
 * Outputs and all, beside the `last_output` the park writes. The sibling
 * `content-erasure.test.ts` runs with the gate off, so it never sees that copy.
 * Once applied, a gate is a spent marker, and the write that erases the content
 * erases the marker's copy with it. A gate still pending keeps its copy, because
 * it is a question the operator has not answered yet.
 *
 * **Why `ttl_hours: 24`.** The window is closed by advancing with an injected
 * `now` two hours ahead. A producer with a shorter ttl would be stale at that
 * instant, run again, and park a fresh gate that supersedes the one under test.
 *
 * **Why two clocks.** The advance reads its window and freshness at the
 * injected `now`. The gate ages on the real clock, and so does the CLI. So an
 * approval whose window closes an hour from now is closed for an advance at
 * two hours ahead, while the gate stays young.
 *
 * **Why the sentinel is built at runtime.** The handler below is written into
 * the home as source. A literal sentinel would sit in that file, and the scan
 * would find it there forever. The handler builds the body from an environment
 * variable, so the source never carries the value.
 *
 * **Why the scan walks the whole home with no exclusion list.** Naming a file
 * as "expected to hold it" would turn the check back into a list of exceptions.
 * Every consumer here returns no artifacts and a fixed summary, so nothing but
 * the runtime's own copies ever holds the sentinel.
 *
 * Every structural assertion reads through `readEngineState`, the product's
 * fail-closed read, so a gate the stored schema refuses fails the case. Copy
 * counts read the raw text.
 *
 * Writes only inside its temp home. Nothing under the repository is touched.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _setHome } from '../../lib/paths.js'
import type { EngineState, PendingGate } from '../../schemas/engine-state.js'
import { readEngineState } from '../engine-state-store.js'
import { createTestHome, type TestHome } from './helpers/create-test-home.js'
import { snapshotHome } from './helpers/snapshot-home.js'

let home: TestHome
let sentinel: string
let statePath: string

const HOUR = 3_600_000

/**
 * The relative names of the files under `root` whose text contains `needle`,
 * sorted. The same shared walk as `content-erasure.test.ts`, with no exclusion
 * list. Symlinks are recorded by the walk and never followed, so they are
 * skipped here.
 */
async function filesHolding(root: string, needle: string): Promise<string[]> {
  const kept: string[] = []
  for (const line of await snapshotHome(root)) {
    const [name, kind] = line.split('|')
    if (name === undefined || kind === 'link') continue
    const text = await readFile(join(root, name), 'utf-8')
    if (text.includes(needle)) kept.push(name)
  }
  return kept.sort()
}

/** How many times the raw state document holds the sentinel. */
async function copies(): Promise<number> {
  return (await readFile(statePath, 'utf-8')).split(sentinel).length - 1
}

/** The state document through the product's own fail-closed read. */
function stored(): Promise<EngineState> {
  return readEngineState(statePath)
}

function manifest(name: string, extra: Record<string, unknown>) {
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

/** A consumer that returns no artifacts and a fixed summary. */
const SENDER_HANDLER = `
export async function handler() {
  return { status: 'success', phases_completed: ['send'], phases_failed: [], errors: [],
    data_freshness: {}, summary: 'sender ran', schema_version: 1, artifacts_produced: [] }
}
`

/** Run `warpline approve` with stdout and stderr captured, returning the exit code. */
async function cli(argv: string[]): Promise<number> {
  const realOut = process.stdout.write
  const realErr = process.stderr.write
  process.stdout.write = (() => true) as typeof process.stdout.write
  process.stderr.write = (() => true) as typeof process.stderr.write
  try {
    const { run } = await import('../../cli/approve.js')
    return await run(argv)
  } finally {
    process.stdout.write = realOut
    process.stderr.write = realErr
  }
}

async function advance(now?: number): Promise<void> {
  const { runAdvance } = await import('../engine.js')
  await runAdvance({
    pluginsDir: home.pluginsDir,
    stateDir: statePath,
    runsDir: home.runsDir,
    eventsPath: join(home.runsDir, 'events.jsonl'),
    approvalPath: join(home.root, '.session-approval'),
    ...(now === undefined ? {} : { now }),
  })
}

/** A UTC wall clock at minute precision, the form `--not-after` takes. */
function wallClockUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16)
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

function gateOf(state: EngineState, plugin: string): PendingGate {
  const gate = state.pending_gates.find((g) => g.plugin === plugin)
  expect(gate).toBeDefined()
  return gate!
}

function lastOutputOfGate(gate: PendingGate): Record<string, unknown> {
  const out = gate.plugin_result.artifacts_produced.at(-1)
  expect(out).toBeDefined()
  return out as Record<string, unknown>
}

function lastOutputOf(state: EngineState, plugin: string): Record<string, unknown> {
  const out = state.plugin_runs[plugin]?.last_output
  expect(out).toBeDefined()
  return out as Record<string, unknown>
}

beforeEach(async () => {
  home = await createTestHome({ preferences: { review_gate: true } })
  statePath = join(home.stateDir, 'engine-state.json')
  _setHome(home.root)
  process.env.WARPLINE_GATE_ERASURE_SENTINEL = randomUUID()
  sentinel = 'approved-content:' + process.env.WARPLINE_GATE_ERASURE_SENTINEL
  await writePlugin(
    'prod',
    manifest('prod', { ttl_hours: 24 }),
    `
export async function handler() {
  return { status: 'success', phases_completed: ['prod'], phases_failed: [], errors: [],
    data_freshness: {}, summary: 'prod produced', schema_version: 1,
    artifacts_produced: [{ type: 'brief', format: 'text', body: 'approved-content:' + process.env.WARPLINE_GATE_ERASURE_SENTINEL }] }
}
`,
  )
  await writePlugin(
    'sender',
    manifest('sender', {
      approval_class: 'content',
      dependencies: ['prod'],
      side_effects: ['sends_email'],
      ttl_hours: 24,
    }),
    SENDER_HANDLER,
  )
})

afterEach(async () => {
  _setHome(null)
  delete process.env.WARPLINE_GATE_ERASURE_SENTINEL
  await home.cleanup()
})

test('on the shipped default, the applied review gate holds no copy of the approved content once the window closes', async () => {
  await advance()
  // Non-vacuity: the park put the content in `last_output` and in the gate.
  expect(await copies()).toBe(2)
  expect(await filesHolding(home.root, sentinel)).toEqual(['state/engine-state.json'])
  const parked = await stored()
  expect(parked.plugin_runs.prod?.status).toBe('gated')
  expect(parked.pending_gates.length).toBe(1)
  expect(gateOf(parked, 'prod').applied_at).toBeNull()

  expect(await cli(['prod'])).toBe(0)
  const applied = await stored()
  const appliedAt = gateOf(applied, 'prod').applied_at
  expect(appliedAt).not.toBeNull()
  expect(lastOutputOfGate(gateOf(applied, 'prod')).body).toBe(sentinel)

  expect(await cli(['sender', '--content', '--not-after', wallClockUtc(Date.now() + HOUR)])).toBe(0)

  // Inside the window the consumer fires, and the open window holds both copies.
  await advance()
  const fired = await stored()
  expect(fired.approvals.sender?.marked_at).not.toBeNull()
  expect(fired.approvals.sender?.confirmed_at).not.toBeNull()
  expect(await copies()).toBe(2)

  await advance(Date.now() + 2 * HOUR)
  expect(await filesHolding(home.root, sentinel)).toEqual([])
  const erased = await stored()
  expect(erased.approvals).toEqual({})
  const last = lastOutputOf(erased, 'prod')
  expect('body' in last).toBe(false)
  expect(typeof last.erased_at).toBe('string')
  expect(last.body_sha256).toBe(sha256Hex(sentinel))
  expect(erased.pending_gates.length).toBe(1)
  const gate = gateOf(erased, 'prod')
  expect(gate.applied_at).toBe(appliedAt)
  const gateOut = lastOutputOfGate(gate)
  expect('body' in gateOut).toBe(false)
  expect(gateOut.erased_at).toBe(last.erased_at)
  expect(gateOut.body_sha256).toBe(last.body_sha256)
  expect(gateOut.run_id).toBe(last.run_id)

  // Idempotent: a further advance changes neither record.
  await advance(Date.now() + 2 * HOUR)
  expect(await filesHolding(home.root, sentinel)).toEqual([])
  const again = await stored()
  expect(lastOutputOf(again, 'prod')).toEqual(last)
  expect(gateOf(again, 'prod')).toEqual(gate)
})

test('a gate still pending keeps its copy after the window closes, since the operator has not answered it', async () => {
  await advance()
  expect(await cli(['sender', '--content', '--not-after', wallClockUtc(Date.now() + HOUR)])).toBe(0)

  await advance(Date.now() + 2 * HOUR)
  const s = await stored()
  const last = lastOutputOf(s, 'prod')
  expect('body' in last).toBe(false)
  expect(typeof last.erased_at).toBe('string')
  expect(s.approvals).toEqual({})
  const gate = gateOf(s, 'prod')
  expect(gate.applied_at).toBeNull()
  expect(lastOutputOfGate(gate).body).toBe(sentinel)
  expect(await copies()).toBe(1)
  expect(await filesHolding(home.root, sentinel)).toEqual(['state/engine-state.json'])
})

test('withdrawing the approval erases the copy the applied gate holds, in the same write', async () => {
  await advance()
  expect(await cli(['prod'])).toBe(0)
  expect(await cli(['sender', '--content', '--not-after', wallClockUtc(Date.now() + HOUR)])).toBe(0)

  expect(await cli(['sender', '--content', '--remove'])).toBe(0)

  // No advance in between: the withdrawal's own write erased both copies.
  expect(await filesHolding(home.root, sentinel)).toEqual([])
  const s = await stored()
  expect(Object.hasOwn(s.approvals, 'sender')).toBe(false)
  const last = lastOutputOf(s, 'prod')
  expect('body' in last).toBe(false)
  expect(typeof last.erased_at).toBe('string')
  const gate = gateOf(s, 'prod')
  expect(gate.applied_at).not.toBeNull()
  const gateOut = lastOutputOfGate(gate)
  expect('body' in gateOut).toBe(false)
  expect(gateOut.erased_at).toBe(last.erased_at)
  expect(gateOut.body_sha256).toBe(last.body_sha256)
})

test('re-approving the consumer onto another producer erases the copy the applied gate holds of the replaced content, in the same write', async () => {
  // Installed in this case only: the first case asserts exactly one gate.
  await writePlugin(
    'prod2',
    manifest('prod2', {}),
    `
export async function handler() {
  return { status: 'success', phases_completed: ['prod2'], phases_failed: [], errors: [],
    data_freshness: {}, summary: 'prod2 produced', schema_version: 1,
    artifacts_produced: [{ type: 'brief', format: 'text', body: 'other-producer-bytes' }] }
}
`,
  )
  await writePlugin(
    'resender',
    manifest('resender', {
      approval_class: 'content',
      dependencies: ['prod2'],
      side_effects: ['sends_email'],
    }),
    SENDER_HANDLER,
  )

  await advance()
  const parked = await stored()
  // Found by plugin, never by index: the order of the two gates is not fixed.
  expect(parked.pending_gates.length).toBe(2)
  expect(gateOf(parked, 'prod').applied_at).toBeNull()
  expect(gateOf(parked, 'prod2').applied_at).toBeNull()

  expect(await cli(['prod'])).toBe(0)

  // Seed the binding the re-approve replaces: `resender` bound to prod's run.
  // Seeded, not approved through the CLI, because `approve --content` takes the
  // producer from the consumer's manifest, and a rewritten manifest that was
  // already imported is served from the module cache within this process.
  const doc = JSON.parse(await readFile(statePath, 'utf-8')) as Record<string, unknown>
  const runs = doc.plugin_runs as Record<string, { last_output: { run_id: string } }>
  doc.approvals = {
    resender: {
      plugin: 'resender',
      producer: 'prod',
      fingerprint: 'not-compared-here',
      run_id: runs.prod!.last_output.run_id,
      approved_at: '2000-01-01T00:00:00.000Z',
      not_before: null,
      not_after: wallClockUtc(Date.now() + HOUR),
      zone: 'UTC',
      effect_id: null,
      marked_at: null,
      confirmed_at: null,
    },
  }
  await writeFile(statePath, JSON.stringify(doc))

  expect(await cli(['resender', '--content', '--not-after', wallClockUtc(Date.now() + HOUR)])).toBe(0)

  // No advance in between: the re-approve's own write erased both copies.
  const s = await stored()
  expect(Object.keys(s.approvals)).toEqual(['resender'])
  expect(s.approvals.resender?.producer).toBe('prod2')
  const last = lastOutputOf(s, 'prod')
  expect('body' in last).toBe(false)
  expect(typeof last.erased_at).toBe('string')
  expect(last.body_sha256).toBe(sha256Hex(sentinel))
  const gate = gateOf(s, 'prod')
  expect(gate.applied_at).not.toBeNull()
  const gateOut = lastOutputOfGate(gate)
  expect('body' in gateOut).toBe(false)
  expect(gateOut.erased_at).toBe(last.erased_at)
  expect(gateOut.body_sha256).toBe(last.body_sha256)
  // The other producer's bytes are untouched: nothing released them.
  const gate2 = gateOf(s, 'prod2')
  expect(gate2.applied_at).toBeNull()
  expect(lastOutputOfGate(gate2).body).toBe('other-producer-bytes')
  expect(lastOutputOf(s, 'prod2').body).toBe('other-producer-bytes')

  expect(await copies()).toBe(0)
  expect(await filesHolding(home.root, sentinel)).toEqual([])
})

test('applying a gate after its content was erased keeps it erased, and the gate holds no copy', async () => {
  await advance()
  expect(await cli(['sender', '--content', '--not-after', wallClockUtc(Date.now() + HOUR)])).toBe(0)
  await advance(Date.now() + 2 * HOUR)
  const before = await stored()
  const erased = lastOutputOf(before, 'prod')
  expect('body' in erased).toBe(false)
  expect(typeof erased.erased_at).toBe('string')
  // Non-vacuity: the gate is still pending and still holds the bytes.
  expect(gateOf(before, 'prod').applied_at).toBeNull()
  expect(lastOutputOfGate(gateOf(before, 'prod')).body).toBe(sentinel)

  expect(await cli(['prod'])).toBe(0)
  const s = await stored()
  expect(lastOutputOf(s, 'prod')).toEqual(erased)
  const gate = gateOf(s, 'prod')
  expect(gate.applied_at).not.toBeNull()
  const gateOut = lastOutputOfGate(gate)
  expect('body' in gateOut).toBe(false)
  expect(gateOut.erased_at).toBe(erased.erased_at)
  expect(gateOut.body_sha256).toBe(erased.body_sha256)
  expect(await filesHolding(home.root, sentinel)).toEqual([])

  // The binding that released it is swept, so nothing would erase it again.
  await advance(Date.now() + 2 * HOUR)
  expect(await filesHolding(home.root, sentinel)).toEqual([])
  expect(lastOutputOf(await stored(), 'prod')).toEqual(erased)
})

test('an overlapping erasure is not undone by this advance writing its gate copy back', async () => {
  await advance()
  expect(await cli(['prod'])).toBe(0)
  expect(await cli(['sender', '--content', '--not-after', wallClockUtc(Date.now() + HOUR)])).toBe(0)

  // Stands in for another advance whose end-of-run write lands while this one
  // is mid-run: it erases prod's body and sweeps the binding. Installed only
  // now, so it runs on the next advance and never before. It hashes the body it
  // reads, so its source never carries the sentinel.
  const stamp = '2026-09-23T00:00:00.000Z'
  await writePlugin(
    'interloper',
    manifest('interloper', { ttl_hours: 1 }),
    `
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
export async function handler() {
  const p = ${JSON.stringify(statePath)}
  const doc = JSON.parse(readFileSync(p, 'utf-8'))
  const { body, ...rest } = doc.plugin_runs.prod.last_output
  doc.plugin_runs.prod.last_output = { ...rest, erased_at: ${JSON.stringify(stamp)},
    body_sha256: createHash('sha256').update(body).digest('hex') }
  doc.approvals = {}
  writeFileSync(p, JSON.stringify(doc))
  return { status: 'success', phases_completed: ['interloper'], phases_failed: [], errors: [],
    data_freshness: {}, summary: 'interloper ran', schema_version: 1, artifacts_produced: [] }
}
`,
  )

  await advance(Date.now() + 2 * HOUR)
  expect(await filesHolding(home.root, sentinel)).toEqual([])
  const s = await stored()
  const last = lastOutputOf(s, 'prod')
  expect('body' in last).toBe(false)
  // The overlapping write's record, kept by the one-way rule.
  expect(last.erased_at).toBe(stamp)
  expect(last.body_sha256).toBe(sha256Hex(sentinel))
  const gate = gateOf(s, 'prod')
  expect(gate.applied_at).not.toBeNull()
  const gateOut = lastOutputOfGate(gate)
  expect('body' in gateOut).toBe(false)
  expect(gateOut.erased_at).toBe(last.erased_at)
  expect(gateOut.body_sha256).toBe(sha256Hex(sentinel))
})

test('a withdrawal that lands while the producer re-runs ungated is not undone by the advance', async () => {
  // `ttl_hours: 1` and the gate turned off below, unlike the rest of this file:
  // the producer has to run again in the advance without parking a gate that
  // would supersede the applied one. Written before the first advance, so the
  // manifest is never served from the module cache.
  await writePlugin(
    'prod',
    manifest('prod', { ttl_hours: 1 }),
    `
export async function handler() {
  return { status: 'success', phases_completed: ['prod'], phases_failed: [], errors: [],
    data_freshness: {}, summary: 'prod produced', schema_version: 1,
    artifacts_produced: [{ type: 'brief', format: 'text', body: 'approved-content:' + process.env.WARPLINE_GATE_ERASURE_SENTINEL }] }
}
`,
  )
  await advance()
  expect(await cli(['prod'])).toBe(0)
  expect(await cli(['sender', '--content', '--not-after', wallClockUtc(Date.now() + 48 * HOUR)])).toBe(0)
  const before = await stored()
  const applied = gateOf(before, 'prod')
  expect(applied.applied_at).not.toBeNull()

  await writeFile(join(home.stateDir, 'preferences.json'), JSON.stringify({ review_gate: false }))
  // A real `approve sender --content --remove`, landing mid-advance. It checks
  // on disk that its own write erased both copies, and records the stamp the
  // gate copy got, so the case below cannot pass on a withdrawal that missed.
  const approvePath = fileURLToPath(new URL('../../cli/approve.ts', import.meta.url))
  const stampPath = join(home.root, 'withdrawal-stamp')
  await writePlugin(
    'interloper',
    manifest('interloper', {}),
    `
import { readFileSync, writeFileSync } from 'node:fs'
export async function handler() {
  const { run } = await import(${JSON.stringify(approvePath)})
  const out = process.stdout.write
  const err = process.stderr.write
  process.stdout.write = () => true
  process.stderr.write = () => true
  let code
  try { code = await run(['sender', '--content', '--remove']) }
  finally { process.stdout.write = out; process.stderr.write = err }
  if (code !== 0) throw new Error('withdrawal exited ' + code)
  const doc = JSON.parse(readFileSync(${JSON.stringify(statePath)}, 'utf-8'))
  const gate = doc.pending_gates.find((g) => g.plugin === 'prod' && g.applied_at !== null)
  const copy = gate.plugin_result.artifacts_produced.at(-1)
  if (copy.body !== undefined || copy.erased_at === undefined) throw new Error('the gate copy was not erased')
  if (doc.plugin_runs.prod.last_output.body !== undefined) throw new Error('last_output was not erased')
  writeFileSync(${JSON.stringify(stampPath)}, copy.erased_at)
  return { status: 'success', phases_completed: ['interloper'], phases_failed: [], errors: [],
    data_freshness: {}, summary: 'interloper ran', schema_version: 1, artifacts_produced: [] }
}
`,
  )

  await advance(Date.now() + 2 * HOUR)
  const s = await stored()
  expect(s.plugin_runs.interloper?.status).toBe('success')
  // The producer ran again, and parked nothing.
  expect(lastOutputOf(s, 'prod').run_id).not.toBe(applied.run_id)
  expect(s.pending_gates.length).toBe(1)
  const gate = gateOf(s, 'prod')
  expect(gate.run_id).toBe(applied.run_id)
  const gateOut = lastOutputOfGate(gate)
  expect('body' in gateOut).toBe(false)
  expect(gateOut.body_sha256).toBe(sha256Hex(sentinel))
  expect(gateOut.erased_at).toBe(await readFile(stampPath, 'utf-8'))
  // The only copy left is the fresh run's `last_output`, which nothing released.
  expect(await copies()).toBe(1)
})

/**
 * Installs a plugin that runs a real `approve prod` mid-advance, checks on disk
 * that its own write applied the gate, with the gate copy erased or not as
 * `erased` says, and records the `applied_at` it wrote. Returns the stamp path.
 */
async function installMidAdvanceApply(erased: boolean): Promise<string> {
  const approvePath = fileURLToPath(new URL('../../cli/approve.ts', import.meta.url))
  const stampPath = join(home.root, 'apply-stamp')
  await writePlugin(
    'interloper',
    manifest('interloper', { ttl_hours: 1 }),
    `
import { readFileSync, writeFileSync } from 'node:fs'
export async function handler() {
  const { run } = await import(${JSON.stringify(approvePath)})
  const out = process.stdout.write
  const err = process.stderr.write
  process.stdout.write = () => true
  process.stderr.write = () => true
  let code
  try { code = await run(['prod']) }
  finally { process.stdout.write = out; process.stderr.write = err }
  if (code !== 0) throw new Error('apply exited ' + code)
  const doc = JSON.parse(readFileSync(${JSON.stringify(statePath)}, 'utf-8'))
  const gate = doc.pending_gates.find((g) => g.plugin === 'prod')
  if (gate.applied_at === null) throw new Error('the gate was not applied')
  const copy = gate.plugin_result.artifacts_produced.at(-1)
  if ((copy.body === undefined) !== ${JSON.stringify(erased)}) throw new Error('the gate copy is not as expected')
  writeFileSync(${JSON.stringify(stampPath)}, gate.applied_at)
  return { status: 'success', phases_completed: ['interloper'], phases_failed: [], errors: [],
    data_freshness: {}, summary: 'interloper ran', schema_version: 1, artifacts_produced: [] }
}
`,
  )
  return stampPath
}

test('an apply that lands mid-advance after erasure is not reverted by the advance', async () => {
  await advance()
  expect(await cli(['sender', '--content', '--not-after', wallClockUtc(Date.now() + HOUR)])).toBe(0)
  await advance(Date.now() + 2 * HOUR)
  const before = await stored()
  const erased = lastOutputOf(before, 'prod')
  expect('body' in erased).toBe(false)
  const pending = gateOf(before, 'prod')
  expect(pending.applied_at).toBeNull()
  expect(lastOutputOfGate(pending).body).toBe(sentinel)
  expect(pending.plugin_result.status).toBe('success')
  expect(await copies()).toBe(1)

  const stampPath = await installMidAdvanceApply(true)
  await advance(Date.now() + 2 * HOUR)
  const s = await stored()
  const gate = gateOf(s, 'prod')
  expect(gate.run_id).toBe(pending.run_id)
  expect(gate.applied_at).toBe(await readFile(stampPath, 'utf-8'))
  const gateOut = lastOutputOfGate(gate)
  expect('body' in gateOut).toBe(false)
  expect(gateOut.erased_at).toBe(erased.erased_at)
  expect(gateOut.body_sha256).toBe(sha256Hex(sentinel))
  expect(s.plugin_runs.prod?.status).toBe(pending.plugin_result.status)
  expect(s.plugin_runs.prod?.last_run_at).toBe(pending.run_completed_at!)
  expect(lastOutputOf(s, 'prod')).toEqual(erased)
  expect(await copies()).toBe(0)
  expect(await filesHolding(home.root, sentinel)).toEqual([])
})

test('an apply that lands mid-advance while the content is bound is erased with it when the advance releases it', async () => {
  await advance()
  expect(await cli(['sender', '--content', '--not-after', wallClockUtc(Date.now() + HOUR)])).toBe(0)
  const before = await stored()
  const pending = gateOf(before, 'prod')
  expect(pending.applied_at).toBeNull()
  expect(lastOutputOf(before, 'prod').body).toBe(sentinel)
  expect(await copies()).toBe(2)

  // The apply lands while the content is still bound, so the gate keeps its
  // body until this advance's write releases it.
  const stampPath = await installMidAdvanceApply(false)
  await advance(Date.now() + 2 * HOUR)
  const s = await stored()
  expect(s.approvals).toEqual({})
  const last = lastOutputOf(s, 'prod')
  expect('body' in last).toBe(false)
  expect(last.body_sha256).toBe(sha256Hex(sentinel))
  const gate = gateOf(s, 'prod')
  expect(gate.run_id).toBe(pending.run_id)
  expect(gate.applied_at).toBe(await readFile(stampPath, 'utf-8'))
  const gateOut = lastOutputOfGate(gate)
  expect('body' in gateOut).toBe(false)
  expect(gateOut.erased_at).toBe(last.erased_at)
  expect(gateOut.body_sha256).toBe(last.body_sha256)
  expect(s.plugin_runs.prod?.status).toBe(pending.plugin_result.status)
  expect(await copies()).toBe(0)
  expect(await filesHolding(home.root, sentinel)).toEqual([])
})

test('an apply that lands mid-advance keeps the newer run the producer made in that advance', async () => {
  // `ttl_hours: 1` and the gate turned off below, unlike most of this file:
  // the producer has to run again in the advance without parking a gate that
  // would supersede the one under test. Written before the first advance, so
  // the manifest is never served from the module cache.
  await writePlugin(
    'prod',
    manifest('prod', { ttl_hours: 1 }),
    `
export async function handler() {
  return { status: 'success', phases_completed: ['prod'], phases_failed: [], errors: [],
    data_freshness: {}, summary: 'prod produced', schema_version: 1,
    artifacts_produced: [{ type: 'brief', format: 'text', body: 'approved-content:' + process.env.WARPLINE_GATE_ERASURE_SENTINEL }] }
}
`,
  )
  await advance()
  const pending = gateOf(await stored(), 'prod')
  expect(pending.applied_at).toBeNull()

  await writeFile(join(home.stateDir, 'preferences.json'), JSON.stringify({ review_gate: false }))
  const stampPath = await installMidAdvanceApply(false)
  await advance(Date.now() + 2 * HOUR)
  const s = await stored()
  expect(s.plugin_runs.interloper?.status).toBe('success')
  // The producer ran again, parked nothing, and its newer run is what stays.
  expect(lastOutputOf(s, 'prod').run_id).not.toBe(pending.run_id)
  expect(s.plugin_runs.prod?.last_run_at).not.toBe(pending.run_completed_at!)
  expect(s.pending_gates.length).toBe(1)
  const gate = gateOf(s, 'prod')
  expect(gate.run_id).toBe(pending.run_id)
  expect(gate.applied_at).toBe(await readFile(stampPath, 'utf-8'))
})
