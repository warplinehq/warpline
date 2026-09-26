/**
 * Approved content is erased from the state document once no open approval
 * for its producer binds it.
 *
 * **What it guards.** An operator's content approval binds a producer's Output
 * by `run_id`. That content is recipient data. While a window is open it has
 * to stay readable, because the consumer is still allowed to send it. Once the
 * last window of an approval for that producer binding it has closed, nothing
 * may keep it: the advance erases `last_output.body` at its end-of-run write
 * and leaves the record, marked, behind.
 *
 * **Why the scan walks the whole home with no exclusion list.** The content
 * was never in the run log. It lived in `plugin_runs[producer].last_output` in
 * the state document, and a guard that looked only at the run log was green
 * over nothing. So this one reads every regular file under the home and asks
 * which of them still holds the content. Naming a file as "expected to hold
 * it" would turn the check back into a list of exceptions.
 *
 * **Why the sentinel is built at runtime.** The handler below is written into
 * the home as source. A literal sentinel would sit in that source file, and
 * the scan would find it there forever, red for a reason that has nothing to
 * do with the runtime. The handler builds the body by concatenation from an
 * environment variable, so the source never carries the value.
 *
 * **Why an installed consumer never copies the content.** Most cases key the
 * approval to a name with no installed plugin, as `approval-retention.test.ts`
 * does. Where a case installs a consumer, its handler returns no artifacts and
 * a fixed summary, or serialises three booleans and nothing it was handed. A
 * consumer that copied the content into its own Outputs or summary would make
 * the scan measure the consumer, so nothing but `last_output.body` ever holds
 * the sentinel.
 *
 * Writes only inside its temp home. Nothing under the repository is touched.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { _setHome } from '../../lib/paths.js'
import { resolveWallClock } from '../../lib/wall-clock.js'
import type { Approval, EngineState } from '../../schemas/engine-state.js'
import { PluginManifestSchema } from '../../schemas/plugin-manifest.js'
import { approvalStanding, loadPluginManifests, proposalFingerprint } from '../engine.js'
import { createTwoAdvanceHome, type TwoAdvanceHome } from './helpers/two-advance-home.js'
import { snapshotHome } from './helpers/snapshot-home.js'

let h: TwoAdvanceHome
let sentinel: string

/**
 * The relative names of the files under `root` whose text contains `needle`,
 * sorted. Built on the one shared walk: a second recursive reader would be a
 * second place for an exclusion list to appear. Symlinks are recorded by the
 * walk and never followed, so they are skipped here.
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

/**
 * One binding whose window closed long ago, naming `runId` for `prod`. Keyed
 * by a consumer that is not installed.
 */
async function seedClosedBinding(runId: string): Promise<void> {
  const state = JSON.parse(await readFile(h.statePath, 'utf-8')) as Record<string, unknown>
  state.approvals = {
    ...((state.approvals as Record<string, unknown> | undefined) ?? {}),
    'batch-sender': {
      plugin: 'batch-sender',
      producer: 'prod',
      fingerprint: 'not-compared-here',
      run_id: runId,
      approved_at: '2026-08-29T11:00:00.000Z',
      not_before: null,
      not_after: '2000-01-02T00:00',
      zone: 'UTC',
      effect_id: null,
      marked_at: null,
      confirmed_at: null,
    },
  }
  await writeFile(h.statePath, JSON.stringify(state))
}

beforeEach(async () => {
  h = await createTwoAdvanceHome()
  // The helper does not re-root the home. Without this, the run journal and
  // the dead-man file land outside the scan, and the scan cannot see them.
  _setHome(h.root)
  process.env.WARPLINE_ERASURE_SENTINEL = randomUUID()
  sentinel = 'approved-content:' + process.env.WARPLINE_ERASURE_SENTINEL

  await h.writePlugin('prod', {
    outputs: { brief: {} },
    handlerBody: `
import { existsSync } from 'node:fs'
export async function handler() {
  if (existsSync(${JSON.stringify(h.marker)})) {
    return {
      status: 'success',
      phases_completed: ['prod'],
      phases_failed: [],
      errors: [],
      data_freshness: {},
      summary: 'prod produced nothing',
      artifacts_produced: [],
      schema_version: 1,
    }
  }
  return {
    status: 'success',
    phases_completed: ['prod'],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: 'prod produced',
    artifacts_produced: [
      { type: 'brief', format: 'text', body: 'approved-content:' + process.env.WARPLINE_ERASURE_SENTINEL },
    ],
    schema_version: 1,
  }
}
`,
  })
})

afterEach(async () => {
  _setHome(null)
  delete process.env.WARPLINE_ERASURE_SENTINEL
  await h.cleanup()
})

test('R8: once the last window naming a run closes, the approved content is nowhere under the home', async () => {
  await h.advance()
  // Non-vacuity: the fixture really put the content where the runtime holds
  // it, and nowhere else. Without this, an empty scan below proves nothing.
  expect(await filesHolding(h.root, sentinel)).toEqual(['state/engine-state.json'])

  const prior = (await h.persistedRun('prod'))!.last_output as Record<string, unknown>
  expect(typeof prior.run_id).toBe('string')
  expect((prior.run_id as string).length).toBeGreaterThan(0)

  // One closed binding naming the run that produced the content.
  await seedClosedBinding(prior.run_id as string)

  await h.setMarker()
  await h.advance()

  // The assertion whose failure names the file still holding the content.
  expect(await filesHolding(h.root, sentinel)).toEqual([])

  const after = (await h.persistedRun('prod'))!.last_output as Record<string, unknown>
  expect('body' in after).toBe(false)
  expect(Number.isNaN(Date.parse(after.erased_at as string))).toBe(false)
  expect(after.body_sha256).toMatch(/^[0-9a-f]{64}$/)
  expect(after.body_sha256).toBe(createHash('sha256').update(sentinel).digest('hex'))
  expect(after.type).toBe(prior.type)
  expect(after.format).toBe(prior.format)
  expect(after.run_id).toBe(prior.run_id)
  expect(after.produced_at).toBe(prior.produced_at)
  const swept = JSON.parse(await readFile(h.statePath, 'utf-8')) as {
    approvals?: Record<string, unknown>
  }
  expect(swept.approvals?.['batch-sender']).toBeUndefined()

  // The next fail-closed read accepts the erased record, and erasing again
  // does not move the stamp.
  await h.advance()
  expect(await filesHolding(h.root, sentinel)).toEqual([])
  expect((await h.persistedRun('prod'))!.last_output).toEqual(after)
})

/**
 * The gate decides authority by fingerprint, not by run. A producer that
 * re-produced byte-identical content under a later run leaves an approval
 * naming the earlier run `live`. A closed binding on the later run must not
 * erase under it, and must still be there to release the content once the
 * earlier one closes too.
 */
describe('an open binding that matches the bytes holds them, whichever run it names', () => {
  const OPEN = '2099-01-01T00:00'

  function binding(plugin: string, runId: string, notAfter: string, fingerprint: string): Approval {
    return {
      plugin,
      producer: 'prod',
      fingerprint,
      run_id: runId,
      approved_at: '2000-01-01T00:00:00.000Z',
      not_before: null,
      not_after: notAfter,
      zone: 'UTC',
      effect_id: null,
      marked_at: null,
      confirmed_at: null,
    }
  }

  /** Never installed, so it never fires. Only `approvalStanding` reads it. */
  const consumer = PluginManifestSchema.parse({
    name: 'batch-sender',
    version: '1.0.0',
    description: 'batch-sender',
    inputs: {},
    outputs: {},
    capabilities: [],
    schedule: 'on_run',
    autonomy_level: 'autonomous',
    side_effects: ['sends_email'],
    approval_class: 'content',
    ttl_hours: 24,
    dependencies: ['prod'],
    timeout_ms: 5000,
    max_parallelism: 1,
  })

  const readState = async (): Promise<EngineState> =>
    JSON.parse(await readFile(h.statePath, 'utf-8')) as EngineState

  test('WR-01: a closed binding on the current run leaves a live one on an earlier run live, and the content goes once both have closed', async () => {
    await h.advance()
    expect(await filesHolding(h.root, sentinel)).toEqual(['state/engine-state.json'])

    const { manifests } = await loadPluginManifests(h.pluginsDir)
    const doc = await readState()
    const runId = doc.plugin_runs['prod']!.last_output!.run_id!
    const fingerprint = proposalFingerprint(doc, 'prod', manifests.get('prod')!)
    doc.approvals = {
      // A yes to the same bytes, produced by an earlier run, window open.
      'batch-sender': binding('batch-sender', 'an-earlier-run', OPEN, fingerprint),
      // A yes to the current run, window closed.
      'second-sender': binding('second-sender', runId, '2000-01-02T00:00', fingerprint),
    }
    await writeFile(h.statePath, JSON.stringify(doc))

    await h.setMarker()
    await h.advance()

    const held = await readState()
    expect(held.plugin_runs['prod']!.last_output!.body).toBe(sentinel)
    const standingManifests = new Map(manifests).set('batch-sender', consumer)
    // The open binding still holds the bytes, which is what defers the
    // erasure. The gate refuses to ship them all the same: the producer's
    // latest run produced no Output, so they are carried, not what it proposes
    // now.
    expect(approvalStanding(held, 'batch-sender', standingManifests, Date.now())).toMatchObject({
      standing: 'content_moved',
      carried: true,
    })
    // Kept, because its erasure was deferred. It is what releases the content.
    expect(held.approvals['second-sender']).toBeDefined()

    await h.advance(resolveWallClock(OPEN, 'UTC') + 1)

    expect(await filesHolding(h.root, sentinel)).toEqual([])
    const after = await readState()
    expect(after.plugin_runs['prod']!.last_output!.erased_at).toBeDefined()
    expect(after.approvals).toEqual({})
  })
})

/**
 * `approve --content --remove` is a closure. Withdrawn, a binding no longer
 * names its run, so if the removal did not release the content, no later
 * advance would.
 */
describe('withdrawing a binding releases the content it bound', () => {
  const OPEN = '2099-01-01T00:00'

  function binding(plugin: string, runId: string, fingerprint = 'not-compared-here'): Approval {
    return {
      plugin,
      producer: 'prod',
      fingerprint,
      run_id: runId,
      approved_at: '2000-01-01T00:00:00.000Z',
      not_before: null,
      not_after: OPEN,
      zone: 'UTC',
      effect_id: null,
      marked_at: null,
      confirmed_at: null,
    }
  }

  /** Runs the CLI verb with its output swallowed, and returns its exit code. */
  async function withdraw(consumer: string): Promise<number> {
    const realOut = process.stdout.write
    const realErr = process.stderr.write
    process.stdout.write = (() => true) as typeof process.stdout.write
    process.stderr.write = (() => true) as typeof process.stderr.write
    try {
      const { run } = await import('../../cli/approve.js')
      return await run([consumer, '--content', '--remove'])
    } finally {
      process.stdout.write = realOut
      process.stderr.write = realErr
    }
  }

  async function seed(approvals: Record<string, Approval>): Promise<EngineState> {
    const doc = JSON.parse(await readFile(h.statePath, 'utf-8')) as EngineState
    doc.approvals = approvals
    await writeFile(h.statePath, JSON.stringify(doc))
    return doc
  }

  test('WR-02: --remove on the only open binding erases the content in the same write', async () => {
    await h.advance()
    const runId = ((await h.persistedRun('prod'))!.last_output as { run_id: string }).run_id
    // Open window: whatever erases the content here is the removal, not a closure.
    await seed({ 'batch-sender': binding('batch-sender', runId) })
    expect(await filesHolding(h.root, sentinel)).toEqual(['state/engine-state.json'])

    expect(await withdraw('batch-sender')).toBe(0)

    expect(await filesHolding(h.root, sentinel)).toEqual([])
    const after = JSON.parse(await readFile(h.statePath, 'utf-8')) as EngineState
    expect(after.approvals).toEqual({})
    expect(after.plugin_runs['prod']!.last_output!.erased_at).toBeDefined()
  })

  test('WR-02: --remove leaves content another open binding on the same run still holds', async () => {
    await h.advance()
    const runId = ((await h.persistedRun('prod'))!.last_output as { run_id: string }).run_id
    await seed({
      'batch-sender': binding('batch-sender', runId),
      'second-sender': binding('second-sender', runId),
    })

    expect(await withdraw('batch-sender')).toBe(0)

    expect(await filesHolding(h.root, sentinel)).toEqual(['state/engine-state.json'])
    const after = JSON.parse(await readFile(h.statePath, 'utf-8')) as EngineState
    expect(after.approvals['batch-sender']).toBeUndefined()
    expect(after.plugin_runs['prod']!.last_output!.body).toBe(sentinel)
  })

  test('WR-02: content a withdrawal left to a fingerprint holder on an earlier run goes when that holder closes', async () => {
    await h.advance()
    const { manifests } = await loadPluginManifests(h.pluginsDir)
    const doc = JSON.parse(await readFile(h.statePath, 'utf-8')) as EngineState
    const runId = doc.plugin_runs['prod']!.last_output!.run_id!
    const fingerprint = proposalFingerprint(doc, 'prod', manifests.get('prod')!)
    await seed({
      'batch-sender': binding('batch-sender', runId, fingerprint),
      // Names an earlier run of the same bytes, so only the fingerprint holds.
      'second-sender': binding('second-sender', 'an-earlier-run', fingerprint),
    })

    expect(await withdraw('batch-sender')).toBe(0)
    expect(await filesHolding(h.root, sentinel)).toEqual(['state/engine-state.json'])

    // Nothing names the current run now. The holder's own closure releases it.
    await h.setMarker()
    await h.advance(resolveWallClock(OPEN, 'UTC') + 1)

    expect(await filesHolding(h.root, sentinel)).toEqual([])
    const after = JSON.parse(await readFile(h.statePath, 'utf-8')) as EngineState
    expect(after.approvals).toEqual({})
  })
})

/**
 * A `run_id` is the advance's id, shared by every plugin that produced in that
 * advance. So an approval for another producer names this content's run by
 * accident: it never reads these bytes, and it could never release them. If it
 * held them, nothing would.
 *
 * The foreign holder is a real, installed co-producer, `prod2`. It produces in
 * the same advance, so it shares the run id naturally, and it honours the
 * marker, so its `last_output` keeps that run. A foreign holder with no
 * `plugin_runs` entry would bind nothing whichever rule held, and prove
 * nothing.
 */
describe('only an approval for the producer holds or releases its content', () => {
  const OPEN = '2099-01-01T00:00'
  const CLOSED = '2000-01-02T00:00'
  const CO_PRODUCED = 'co-producer-bytes'

  function binding(
    plugin: string,
    producer: string,
    runId: string,
    notAfter: string,
    fingerprint = 'not-compared-here',
    zone = 'UTC',
  ): Approval {
    return {
      plugin,
      producer,
      fingerprint,
      run_id: runId,
      approved_at: '2000-01-01T00:00:00.000Z',
      not_before: null,
      not_after: notAfter,
      zone,
      effect_id: null,
      marked_at: null,
      confirmed_at: null,
    }
  }

  const readState = async (): Promise<EngineState> =>
    JSON.parse(await readFile(h.statePath, 'utf-8')) as EngineState

  async function seed(approvals: Record<string, Approval>): Promise<void> {
    const doc = await readState()
    doc.approvals = approvals
    await writeFile(h.statePath, JSON.stringify(doc))
  }

  /** Runs the CLI verb with its output swallowed, and returns its exit code. */
  async function cli(args: string[]): Promise<number> {
    const realOut = process.stdout.write
    const realErr = process.stderr.write
    process.stdout.write = (() => true) as typeof process.stdout.write
    process.stderr.write = (() => true) as typeof process.stderr.write
    try {
      const { run } = await import('../../cli/approve.js')
      return await run(args)
    } finally {
      process.stdout.write = realOut
      process.stderr.write = realErr
    }
  }

  /**
   * Installs a content-class consumer of `dependency`. Its handler returns no
   * artifacts, and no case advances after installing it, so it never reads
   * the content. It is here so `approve --content` can write a record for it.
   */
  async function writeSender(dependency: string): Promise<void> {
    const dir = join(h.pluginsDir, 'sender')
    await mkdir(dir, { recursive: true })
    const manifest = {
      name: 'sender',
      version: '1.0.0',
      description: 'sender',
      inputs: {},
      outputs: {},
      capabilities: [],
      schedule: 'on_run',
      autonomy_level: 'autonomous',
      side_effects: ['sends_email'],
      approval_class: 'content',
      ttl_hours: 24,
      dependencies: [dependency],
      timeout_ms: 5000,
      max_parallelism: 1,
    }
    await writeFile(join(dir, 'manifest.ts'), `export const manifest = ${JSON.stringify(manifest)}`)
    await writeFile(
      join(dir, 'handler.ts'),
      `export async function handler() {
  return { status: 'success', phases_completed: [], phases_failed: [], errors: [], data_freshness: {}, summary: 'sent nothing', artifacts_produced: [], schema_version: 1 }
}
`,
    )
  }

  /** Advance 1, which runs both producers. Returns the run id they share. */
  async function produceBoth(): Promise<string> {
    await h.advance()
    const doc = await readState()
    const runId = doc.plugin_runs['prod']!.last_output!.run_id!
    expect(doc.plugin_runs['prod2']!.last_output!.run_id).toBe(runId)
    expect(doc.plugin_runs['prod2']!.last_output!.body).toBe(CO_PRODUCED)
    expect(await filesHolding(h.root, sentinel)).toEqual(['state/engine-state.json'])
    return runId
  }

  beforeEach(async () => {
    await h.writePlugin('prod2', {
      outputs: { brief: {} },
      handlerBody: `
import { existsSync } from 'node:fs'
export async function handler() {
  const base = { status: 'success', phases_completed: ['prod2'], phases_failed: [], errors: [], data_freshness: {}, schema_version: 1 }
  if (existsSync(${JSON.stringify(h.marker)})) return { ...base, summary: 'prod2 produced nothing', artifacts_produced: [] }
  return { ...base, summary: 'prod2 produced', artifacts_produced: [{ type: 'brief', format: 'text', body: ${JSON.stringify(CO_PRODUCED)} }] }
}
`,
    })
  })

  test('withdrawing a binding erases the content even when an open binding for another producer names the same run', async () => {
    const runId = await produceBoth()
    await seed({
      'batch-sender': binding('batch-sender', 'prod', runId, OPEN),
      'other-sender': binding('other-sender', 'prod2', runId, OPEN),
    })

    expect(await cli(['batch-sender', '--content', '--remove'])).toBe(0)

    // Straight after the withdrawal's own write, with no advance between.
    expect(await filesHolding(h.root, sentinel)).toEqual([])
    const after = await readState()
    expect(Object.keys(after.approvals)).toEqual(['other-sender'])
    expect(after.plugin_runs['prod2']!.last_output!.body).toBe(CO_PRODUCED)
  })

  test('a closed fingerprint binding erases the content even when an open binding for another producer names the current run', async () => {
    const runId = await produceBoth()
    const { manifests } = await loadPluginManifests(h.pluginsDir)
    const fingerprint = proposalFingerprint(await readState(), 'prod', manifests.get('prod')!)
    await seed({
      'batch-sender': binding('batch-sender', 'prod', 'an-earlier-run', CLOSED, fingerprint),
      'other-sender': binding('other-sender', 'prod2', runId, OPEN),
    })

    await h.setMarker()
    // One advance: the first end-of-run write is the one that must erase.
    await h.advance()

    expect(await filesHolding(h.root, sentinel)).toEqual([])
    expect(Object.keys((await readState()).approvals)).toEqual(['other-sender'])
  })

  test('an open binding for another producer in a zone the host cannot resolve does not hold the content', async () => {
    const runId = await produceBoth()
    await seed({
      'batch-sender': binding('batch-sender', 'prod', runId, CLOSED),
      'other-sender': binding('other-sender', 'prod2', runId, OPEN, 'x', 'Not/AZone'),
    })

    await h.setMarker()
    await h.advance(resolveWallClock(OPEN, 'UTC') + 1)

    expect(await filesHolding(h.root, sentinel)).toEqual([])
    const after = await readState()
    // Kept by its own zone rule, which retains, and holding nothing.
    expect(after.approvals['other-sender']).toBeDefined()
    expect(after.approvals['batch-sender']).toBeUndefined()
  })

  test('re-approving a consumer onto another producer releases the binding it replaces in the same write', async () => {
    const runId = await produceBoth()
    // The consumer now depends on prod2. Its record was written when it read prod.
    await writeSender('prod2')
    await seed({ sender: binding('sender', 'prod', runId, OPEN) })

    expect(await cli(['sender', '--content', '--not-after', OPEN, '--zone', 'UTC'])).toBe(0)

    // Straight after the re-approve's own write, with no advance between.
    const after = await readState()
    expect(after.approvals['sender']!.producer).toBe('prod2')
    expect(after.plugin_runs['prod']!.last_output!.erased_at).toBeDefined()
    expect(await filesHolding(h.root, sentinel)).toEqual([])
    expect(after.plugin_runs['prod2']!.last_output!.body).toBe(CO_PRODUCED)
  })

  test('re-approving a consumer onto the same producer keeps the content the new binding names', async () => {
    const runId = await produceBoth()
    await writeSender('prod')
    await seed({ sender: binding('sender', 'prod', runId, OPEN) })

    expect(await cli(['sender', '--content', '--not-after', OPEN, '--zone', 'UTC'])).toBe(0)

    const after = await readState()
    expect(after.plugin_runs['prod']!.last_output!.body).toBe(sentinel)
    expect(await filesHolding(h.root, sentinel)).toEqual(['state/engine-state.json'])
    expect(after.approvals['sender']!.producer).toBe('prod')
    // The record really was replaced, not left as seeded.
    expect(after.approvals['sender']!.approved_at).not.toBe('2000-01-01T00:00:00.000Z')
  })

  test('a closed fingerprint binding is kept while a holder for the same producer is open, and releases the content once that holder has fired and its window has closed', async () => {
    await produceBoth()
    const { manifests } = await loadPluginManifests(h.pluginsDir)
    const fingerprint = proposalFingerprint(await readState(), 'prod', manifests.get('prod')!)
    await seed({
      'batch-sender': binding('batch-sender', 'prod', 'an-earlier-run', CLOSED, fingerprint),
      'second-sender': binding('second-sender', 'prod', 'another-earlier-run', OPEN, fingerprint),
    })

    await h.setMarker()
    await h.advance()

    const held = await readState()
    expect(held.plugin_runs['prod']!.last_output!.body).toBe(sentinel)
    // Kept, though it names neither the current run nor an open window: it
    // is what releases the content once the holder stops binding it.
    expect(held.approvals['batch-sender']).toBeDefined()

    // The holder fires and confirms inside its window. Fired and confirmed, it
    // still binds by fingerprint until its window closes, so it still holds.
    held.approvals['second-sender'] = {
      ...held.approvals['second-sender']!,
      marked_at: '2026-09-18T00:00:00.000Z',
      effect_id: 'e',
      confirmed_at: '2026-09-18T00:00:01.000Z',
    }
    await writeFile(h.statePath, JSON.stringify(held))

    await h.advance()

    const fired = await readState()
    expect(fired.plugin_runs['prod']!.last_output!.body).toBe(sentinel)
    expect(fired.approvals['batch-sender']).toBeDefined()
    expect(fired.approvals['second-sender']).toBeDefined()

    await h.advance(resolveWallClock(OPEN, 'UTC') + 1)

    expect(await filesHolding(h.root, sentinel)).toEqual([])
    expect(Object.keys((await readState()).approvals)).toEqual([])
  })

  test('a closed fingerprint binding releases the content once a holder for the same producer is left marked and unconfirmed', async () => {
    await produceBoth()
    const { manifests } = await loadPluginManifests(h.pluginsDir)
    const fingerprint = proposalFingerprint(await readState(), 'prod', manifests.get('prod')!)
    await seed({
      'batch-sender': binding('batch-sender', 'prod', 'an-earlier-run', CLOSED, fingerprint),
      'second-sender': binding('second-sender', 'prod', 'another-earlier-run', OPEN, fingerprint),
    })

    await h.setMarker()
    await h.advance()

    // The holder began a fire it cannot prove finished. Left unconfirmed, it
    // binds by run only, and it names an earlier run.
    const held = await readState()
    held.approvals['second-sender'] = {
      ...held.approvals['second-sender']!,
      marked_at: '2026-09-18T00:00:00.000Z',
      effect_id: 'e',
    }
    await writeFile(h.statePath, JSON.stringify(held))

    await h.advance()

    expect(await filesHolding(h.root, sentinel)).toEqual([])
    // The marked-unconfirmed record is kept, and the released closed one is swept.
    expect(Object.keys((await readState()).approvals)).toEqual(['second-sender'])
  })

  /**
   * A closed binding that has fired and been confirmed still binds its
   * producer's content by fingerprint. While another approval for the same
   * producer holds that content open, the sweep keeps the confirmed record.
   * Dropping it would leave nothing to erase the content once the holder
   * stops holding it. When the holder is left marked and unconfirmed, it binds
   * by run only, so the content goes and the confirmed record goes with it.
   */
  test('a closed CONFIRMED fingerprint binding is kept while a holder is open, and releases once the holder is left unconfirmed', async () => {
    await produceBoth()
    const { manifests } = await loadPluginManifests(h.pluginsDir)
    const fingerprint = proposalFingerprint(await readState(), 'prod', manifests.get('prod')!)
    await seed({
      'batch-sender': { ...binding('batch-sender', 'prod', 'an-earlier-run', CLOSED, fingerprint), marked_at: '2000-01-01T01:00:00.000Z', effect_id: 'x', confirmed_at: '2000-01-01T01:00:01.000Z' },
      'second-sender': binding('second-sender', 'prod', 'another-earlier-run', OPEN, fingerprint),
    })
    await h.setMarker()
    await h.advance()
    const held = await readState()
    expect(held.plugin_runs['prod']!.last_output!.body).toBe(sentinel)
    expect(held.approvals['batch-sender']).toBeDefined()
    held.approvals['second-sender'] = { ...held.approvals['second-sender']!, marked_at: '2026-09-18T00:00:00.000Z', effect_id: 'e' }
    await writeFile(h.statePath, JSON.stringify(held))
    await h.advance()
    expect(await filesHolding(h.root, sentinel)).toEqual([])
    expect(Object.keys((await readState()).approvals)).toEqual(['second-sender'])
  })
})

/**
 * Live and binds are two questions. A fired approval can never authorise
 * another fire, but its window still keeps the bytes it shipped, and those can
 * sit under a later run than the one it names: the producer re-produced them
 * before the fire, or makes them again after it. A fire left marked and
 * unconfirmed is the one exception. Its record is kept for good, so it binds by
 * run only.
 *
 * Each case installs a real content-class consumer of `prod` that is due on
 * every advance, and fires it through the gate, so the mark is the runtime's
 * own. Its handler returns no artifacts and a fixed summary.
 */
describe('an approval that has fired binds the bytes it shipped until its window closes', () => {
  const OPEN = '2099-01-01T00:00'
  const PAST = resolveWallClock(OPEN, 'UTC') + 60_000

  const readState = async (): Promise<EngineState> =>
    JSON.parse(await readFile(h.statePath, 'utf-8')) as EngineState

  /** Runs the CLI verb with its output swallowed, and returns its exit code. */
  async function cli(args: string[]): Promise<number> {
    const realOut = process.stdout.write
    const realErr = process.stderr.write
    process.stdout.write = (() => true) as typeof process.stdout.write
    process.stderr.write = (() => true) as typeof process.stderr.write
    try {
      const { run } = await import('../../cli/approve.js')
      return await run(args)
    } finally {
      process.stdout.write = realOut
      process.stderr.write = realErr
    }
  }

  /**
   * Installs a content-class consumer of `prod`, due on every advance. Its
   * handler sends nothing it was handed.
   */
  async function writeFiringSender(name: string): Promise<void> {
    const dir = join(h.pluginsDir, name)
    await mkdir(dir, { recursive: true })
    const manifest = {
      name,
      version: '1.0.0',
      description: name,
      inputs: {},
      outputs: {},
      capabilities: [],
      schedule: 'on_run',
      autonomy_level: 'autonomous',
      side_effects: ['sends_email'],
      approval_class: 'content',
      ttl_hours: 0.0000001,
      dependencies: ['prod'],
      timeout_ms: 5000,
      max_parallelism: 1,
    }
    await writeFile(join(dir, 'manifest.ts'), `export const manifest = ${JSON.stringify(manifest)}`)
    await writeFile(
      join(dir, 'handler.ts'),
      `export async function handler() {
  return { status: 'success', phases_completed: [], phases_failed: [], errors: [], data_freshness: {}, summary: 'sent', artifacts_produced: [], schema_version: 1 }
}
`,
    )
  }

  beforeEach(async () => {
    await writeFiringSender('sender')
  })

  test('content a fired approval shipped under a later run than it names is erased when its window closes', async () => {
    await h.advance()
    const r1 = (await readState()).plugin_runs['prod']!.last_output!.run_id!
    expect(await filesHolding(h.root, sentinel)).toEqual(['state/engine-state.json'])

    expect(await cli(['sender', '--content', '--not-after', OPEN, '--zone', 'UTC'])).toBe(0)

    // The producer re-produces the same bytes under r2, and the consumer fires
    // on them in the same advance.
    await h.advance()
    const fired = await readState()
    const r2 = fired.plugin_runs['prod']!.last_output!.run_id!
    expect(r2).not.toBe(r1)
    expect(fired.plugin_runs['prod']!.last_output!.body).toBe(sentinel)
    expect(fired.approvals['sender']!.run_id).toBe(r1)
    expect(fired.approvals['sender']!.marked_at).not.toBeNull()
    expect(fired.approvals['sender']!.confirmed_at).not.toBeNull()

    await h.setMarker()
    await h.advance(PAST)

    expect(await filesHolding(h.root, sentinel)).toEqual([])
    const after = await readState()
    expect(Object.keys(after.approvals)).toEqual([])
    expect(after.plugin_runs['prod']!.last_output!.erased_at).toBeDefined()
    expect(after.plugin_runs['prod']!.last_output!.run_id).toBe(r2)
  })

  test('bytes the producer makes again after the fire are held while the window is open and erased when it closes', async () => {
    await h.advance()
    const r1 = (await readState()).plugin_runs['prod']!.last_output!.run_id!

    expect(await cli(['sender', '--content', '--not-after', OPEN, '--zone', 'UTC'])).toBe(0)

    // While the producer is silent the consumer does not fire: the bytes on
    // file are carried from r1, not the producer's latest proposal.
    await h.setMarker()
    const silent = await h.advance()
    expect(silent.refused_plugins).toEqual([{ plugin: 'sender', reason: 'content_moved' }])
    expect((await readState()).approvals['sender']!.marked_at).toBeNull()

    // The producer re-produces the same bytes under r2, and the consumer fires
    // on them.
    await rm(h.marker)
    await h.advance()
    const fired = await readState()
    expect(fired.approvals['sender']!.confirmed_at).not.toBeNull()
    expect(fired.approvals['sender']!.run_id).toBe(r1)
    const r2 = fired.plugin_runs['prod']!.last_output!.run_id!
    expect(r2).not.toBe(r1)

    // The producer makes the same bytes again, under r3, after the fire and
    // inside the window.
    await h.advance()
    const again = await readState()
    const r3 = again.plugin_runs['prod']!.last_output!.run_id!
    expect(r3).not.toBe(r2)
    expect(again.approvals['sender']!.confirmed_at).toBe(fired.approvals['sender']!.confirmed_at)
    expect(again.plugin_runs['prod']!.last_output!.body).toBe(sentinel)
    expect(again.approvals['sender']).toBeDefined()

    await h.setMarker()
    await h.advance(PAST)

    expect(await filesHolding(h.root, sentinel)).toEqual([])
    const after = await readState()
    expect(after.plugin_runs['prod']!.last_output!.erased_at).toBeDefined()
    expect(after.plugin_runs['prod']!.last_output!.run_id).toBe(r3)
    expect(after.approvals).toEqual({})
  })

  test('a fire left unconfirmed binds by run only, so bytes the producer makes again stay and can still be approved', async () => {
    await h.advance()
    const r1 = (await readState()).plugin_runs['prod']!.last_output!.run_id!

    expect(await cli(['sender', '--content', '--not-after', OPEN, '--zone', 'UTC'])).toBe(0)

    // As a handler that never returned would leave it: marked, unconfirmed.
    const doc = await readState()
    doc.approvals['sender'] = { ...doc.approvals['sender']!, marked_at: '2026-09-18T00:00:00.000Z', effect_id: 'e' }
    await writeFile(h.statePath, JSON.stringify(doc))

    // The window closes. The content the record names by run still goes.
    await h.setMarker()
    await h.advance(PAST)
    const closed = await readState()
    expect(closed.plugin_runs['prod']!.last_output!.erased_at).toBeDefined()
    expect(await filesHolding(h.root, sentinel)).toEqual([])
    expect(closed.approvals['sender']).toBeDefined()
    expect(closed.approvals['sender']!.confirmed_at).toBeNull()

    // The producer makes the same bytes again. The kept record does not erase them.
    await rm(h.marker)
    await h.advance(PAST + 60_000)
    const again = await readState()
    const out = again.plugin_runs['prod']!.last_output!
    expect(out.run_id).not.toBe(r1)
    expect(out.body).toBe(sentinel)
    expect(out.erased_at).toBeUndefined()
    expect(await filesHolding(h.root, sentinel)).toEqual(['state/engine-state.json'])
    expect(again.approvals['sender']!.confirmed_at).toBeNull()

    // A second consumer of the producer can still approve them. The kept record
    // itself refuses a fresh approval by design.
    await writeFiringSender('sender2')
    expect(await cli(['sender2', '--content', '--not-after', OPEN, '--zone', 'UTC'])).toBe(0)
    expect((await readState()).approvals['sender2']!.run_id).toBe(out.run_id!)
  })
})

describe('a consumer reads erased content as produced', () => {
  /**
   * Reads its dependency through the capability and reports three booleans
   * about what it was handed. It never serialises the record, so its summary
   * in the run log cannot hold the content and the scan stays about the
   * runtime.
   */
  const consumer = `
export async function handler(manifest, args, signal, capabilities) {
  const rec = capabilities.dependencies.lastOutput(capabilities.caller, 'prod')
  return {
    status: 'success',
    phases_completed: ['cons'],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: JSON.stringify({
      nonNull: rec !== null,
      erased: rec !== null && rec.erased_at !== undefined,
      hasBody: rec !== null && 'body' in rec,
    }),
    artifacts_produced: [],
    schema_version: 1,
  }
}
`

  async function consSaw(runLogPath: string): Promise<unknown> {
    return JSON.parse((await h.entryFor(runLogPath, 'cons'))!.result_summary)
  }

  test('R3: after erasure a consumer receives the record, non-null, marked erased, with no body', async () => {
    await h.writePlugin('cons', { dependencies: ['prod'], handlerBody: consumer })

    const first = await h.advance()
    // Non-vacuity: before erasure the same consumer saw the content.
    expect(await consSaw(first.run_log_path)).toEqual({ nonNull: true, erased: false, hasBody: true })

    const prior = (await h.persistedRun('prod'))!.last_output as Record<string, unknown>
    await seedClosedBinding(prior.run_id as string)
    await h.setMarker()

    // The erasure is the end-of-run write of this advance, so the consumer in
    // it still reads the record as it was. The next advance is the one that
    // hands it the erased record.
    await h.advance()
    const third = await h.advance()
    expect(await consSaw(third.run_log_path)).toEqual({ nonNull: true, erased: true, hasBody: false })

    expect(await filesHolding(h.root, sentinel)).toEqual([])
  })
})

/**
 * These are pins. The handler boundary rejected both shapes before content
 * could be erased, and these tests keep it that way now that the stored schema
 * admits an erased arm: the erased state is one only the runtime can write.
 */
describe('a handler cannot hand the runtime an erased Output', () => {
  function returning(output: Record<string, unknown>): string {
    return `
export async function handler() {
  return {
    status: 'success',
    phases_completed: ['prod'],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: 'prod produced',
    artifacts_produced: [${JSON.stringify(output)}],
    schema_version: 1,
  }
}
`
  }

  test('R2: stored-only keys beside a body are stripped at the boundary', async () => {
    await h.writePlugin('prod', {
      outputs: { brief: {} },
      handlerBody: returning({
        type: 'brief',
        format: 'text',
        body: 'kept',
        erased_at: '2026-01-01T00:00:00.000Z',
        body_sha256: 'c'.repeat(64),
      }),
    })

    await h.advance()

    const run = (await h.persistedRun('prod'))!
    expect(run.status).toBe('success')
    const out = run.last_output as Record<string, unknown>
    expect(out.body).toBe('kept')
    expect('erased_at' in out).toBe(false)
    expect('body_sha256' in out).toBe(false)
  })

  test('R2: a bodiless Output carrying erased_at is refused, and nothing lands', async () => {
    await h.writePlugin('prod', {
      outputs: { brief: {} },
      handlerBody: returning({ type: 'brief', format: 'text', erased_at: '2026-01-01T00:00:00.000Z' }),
    })

    await h.advance()

    const run = (await h.persistedRun('prod'))!
    expect(run.status).toBe('failed')
    expect('last_output' in run).toBe(false)
  })
})
