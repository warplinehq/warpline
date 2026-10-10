/**
 * A side-effecting fire is on the audit record before it happens and after it
 * ends, and a refusal is on the record with its reason.
 *
 * Write-ahead is intent, then the handler, then the outcome. The order case
 * does not take the engine's word for it: the handler itself reads the store
 * when it runs and writes down whether its own intent was already there. An
 * intent appended after `invokePlugin` returns passes every count below and
 * fails that one.
 *
 * The forced-failure cases make one append throw once, through a namespace
 * spy that calls through for every other kind. Each asserts the trip count, so
 * a spy that never fired cannot pass a case, and each asserts the spy's
 * message reached no file under the home.
 *
 * Every case gets its own home, because seq and count assertions over a store
 * another case shares would depend on file order. Everything this file writes
 * goes under temp dirs (AGENTS.md Rule 2).
 */
import { describe, test, expect, beforeEach, afterEach, afterAll, spyOn } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import * as audit from '../../lib/audit-log.js'
import * as store from '../engine-state-store.js'
import { issueStanding, mergeGrant, newStandingId, readStandingStore, revokeStanding, writeStandingStore } from '../approval-gate.js'
import { loadRegistry } from '../../lib/principals.js'
import { runAdvance } from '../engine.js'
import { _setHome } from '../../lib/paths.js'
import { _getPaths, _setPaths, pathsForStateFile } from '../../board/state-manager.js'
import { createTestHome, type TestHome } from './helpers/create-test-home.js'
import { seedContentRefusals } from './helpers/content-refusal.js'
import { testFixturesDir } from '../../../test-utils/fixtures.js'
import { main } from '../../cli/warpline.js'

/** The built bin, the path a real consumer runs. */
const BIN = testFixturesDir(import.meta.url, '../../../dist/bin/warpline.js')

/** The spy's error message. It must never reach a file. */
const SENTINEL = 'WARPLINE_AUDIT_FIRE_SPY_SENTINEL'

/** The fixed run-log summary of a plugin whose intent could not be recorded. */
const INTENT_UNRECORDED = 'not fired: its fire intent could not be recorded in the audit store'

const REAL_PATHS = _getPaths()

let home: TestHome
let installed: ReturnType<typeof spyOn>[] = []

const statePath = (): string => join(home.stateDir, 'engine-state.json')
const storeDir = (): string => join(home.root, 'audit')
const marksDir = (plugin: string): string => join(home.root, 'marks', plugin)

beforeEach(async () => {
  home = await createTestHome()
  _setHome(home.root)
  // `main(['advance'])` passes no preferences path, so the engine reads the
  // home default, one level shallower than the helper's fixture. Without this
  // the shipped `review_gate: true` applies to the in-process and spawned cases.
  writeFileSync(join(home.root, 'preferences.json'), JSON.stringify({ review_gate: false }))
  _setPaths(pathsForStateFile(statePath(), { eventsPath: join(home.runsDir, 'events.jsonl') }))
})

afterEach(async () => {
  for (const spy of installed) spy.mockRestore()
  installed = []
  _setHome(null)
  await home.cleanup()
})

afterAll(() => {
  _setPaths(REAL_PATHS)
})

/** Every field spelled out, so the fixture never leans on a schema default. */
function manifest(name: string): Record<string, unknown> {
  return {
    name,
    version: '1.0.0',
    description: `${name} audit-fire fixture`,
    inputs: {},
    outputs: {},
    capabilities: [],
    secrets: [],
    schedule: 'on_run',
    autonomy_level: 'autonomous',
    approval_class: 'session',
    side_effects: ['sends_email'],
    // Near zero, so the plugin is always stale and therefore due.
    ttl_hours: 0.001,
    dependencies: [],
    timeout_ms: 5000,
    max_parallelism: 1,
    min_tier: 'normal',
    max_retries: 1,
    retry_delay_ms: 2000,
  }
}

/**
 * A handler that records, on entry, that it ran and whether a `fire.intent`
 * naming it was already in the store. The store path is embedded: the handler
 * runs in this process, and reading the store is the only honest way for it to
 * say what was on disk when it started.
 */
function markerHandler(name: string): string {
  return `
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const STORE = ${JSON.stringify(storeDir())}
const MARKS = ${JSON.stringify(marksDir(name))}
const NAME = ${JSON.stringify(name)}

export async function handler() {
  mkdirSync(MARKS, { recursive: true })
  writeFileSync(join(MARKS, 'invoked'), 'yes')
  let saw = false
  if (existsSync(STORE)) {
    for (const file of readdirSync(STORE)) {
      if (!file.endsWith('.jsonl')) continue
      for (const line of readFileSync(join(STORE, file), 'utf-8').split('\\n')) {
        if (line === '') continue
        const record = JSON.parse(line)
        if (record.type === 'warpline.audit.fire.intent' && record.data.plugin === NAME) saw = true
      }
    }
  }
  writeFileSync(join(MARKS, 'saw-intent'), saw ? 'yes' : 'no')
  return {
    status: 'success',
    phases_completed: [NAME],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: NAME + ' completed',
    artifacts_produced: [],
    schema_version: 1,
  }
}
`
}

function writePlugin(name: string, overrides: Record<string, unknown> = {}): void {
  const dir = join(home.pluginsDir, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'manifest.ts'), `export const manifest = ${JSON.stringify({ ...manifest(name), ...overrides })}`)
  writeFileSync(join(dir, 'handler.ts'), markerHandler(name))
}

/** A session grant for `names`, written straight to the approval file. No record. */
async function grant(names: string[]): Promise<void> {
  await mergeGrant(names, {}, join(home.root, '.session-approval'))
}

/** What the handler wrote, or null when it never ran. */
function mark(plugin: string, file: 'invoked' | 'saw-intent'): string | null {
  const path = join(marksDir(plugin), file)
  return existsSync(path) ? readFileSync(path, 'utf-8') : null
}

function advance(): ReturnType<typeof runAdvance> {
  return runAdvance({
    pluginsDir: home.pluginsDir,
    stateDir: statePath(),
    runsDir: home.runsDir,
    eventsPath: join(home.runsDir, 'events.jsonl'),
    approvalPath: join(home.root, '.session-approval'),
    preferencesPath: join(home.stateDir, 'preferences.json'),
  })
}

type Line = { type: string; warplineseq: number; data: Record<string, unknown> }

/** Every stored line under `<home>/audit/`, segments in name order. */
function auditLines(): Line[] {
  if (!existsSync(storeDir())) return []
  return readdirSync(storeDir())
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .flatMap((f) =>
      readFileSync(join(storeDir(), f), 'utf-8')
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as Line),
    )
}

/** Every stored `fire.*` line, in seq order. */
function fireLines(): Line[] {
  return auditLines().filter((l) => l.type.startsWith('warpline.audit.fire.'))
}

function linesOf(kind: string): Line[] {
  return auditLines().filter((l) => l.type === `warpline.audit.${kind}`)
}

/** Make the append of `kind` throw once. Every other call goes to the real append. */
function failAppend(kind: string): { trips: () => number } {
  // Read BEFORE `spyOn`: afterwards the namespace property is the mock.
  const real = audit.appendAudit
  let trips = 0
  const spy = spyOn(audit, 'appendAudit').mockImplementation((async (
    path: string,
    k: string,
    data: unknown,
    opts?: unknown,
  ) => {
    if (k === kind && trips === 0) {
      trips += 1
      throw new Error(SENTINEL)
    }
    return (real as (...args: unknown[]) => Promise<unknown>)(path, k, data, opts)
  }) as typeof audit.appendAudit)
  installed.push(spy)
  return { trips: () => trips }
}

/** No file under the home holds the spy's sentinel. */
function expectNoSentinel(): void {
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = join(dir, entry.name)
      if (entry.isDirectory()) walk(child)
      else if (entry.isFile()) {
        const path = relative(home.root, child)
        expect(`${path}: ${readFileSync(child, 'utf-8').includes(SENTINEL)}`).toBe(`${path}: false`)
      }
    }
  }
  walk(home.root)
}

/** Run main(argv) with stdout/stderr captured, always restoring the originals. */
async function capture(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const realOut = process.stdout.write
  const realErr = process.stderr.write
  let stdout = ''
  let stderr = ''
  process.stdout.write = ((chunk: string) => {
    stdout += chunk
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string) => {
    stderr += chunk
    return true
  }) as typeof process.stderr.write
  try {
    return { code: await main(argv), stdout, stderr }
  } finally {
    process.stdout.write = realOut
    process.stderr.write = realErr
  }
}

/** The real bin against this home, with an explicit env (a bun child's default env is a startup snapshot). */
function bin(args: string[]): ReturnType<typeof spawnSync> {
  const env: NodeJS.ProcessEnv = { ...process.env, WARPLINE_HOME: home.root }
  delete env.NODE_ENV
  return spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf-8', timeout: 60_000 })
}

function readState(): { plugin_runs: Record<string, unknown> } {
  return JSON.parse(readFileSync(statePath(), 'utf-8')) as { plugin_runs: Record<string, unknown> }
}

function runLogEntry(runLogPath: string, plugin: string): Record<string, unknown> | undefined {
  const log = JSON.parse(readFileSync(runLogPath, 'utf-8')) as { plugin_entries: Record<string, unknown>[] }
  return log.plugin_entries.find((e) => e.plugin === plugin)
}

/** The seeded handler is replaced by a marker, so "not invoked" is observed rather than assumed. */
async function seedRefusal(): Promise<void> {
  await seedContentRefusals({ pluginsDir: home.pluginsDir, statePath: statePath(), names: ['sender'] })
  writeFileSync(join(home.pluginsDir, 'sender', 'handler.ts'), markerHandler('sender'))
}

describe('a session fire is written ahead', () => {
  test('the handler finds its own intent on disk, and the outcome follows naming the intent seq', async () => {
    writePlugin('mailer')
    await grant(['mailer'])

    const r = await advance()

    expect(r.plugin_states.get('mailer')).toBe('completed')
    expect(mark('mailer', 'saw-intent')).toBe('yes')
    const fires = fireLines()
    expect(fires.map((l) => l.type)).toEqual(['warpline.audit.fire.intent', 'warpline.audit.fire.outcome'])
    expect(fires[0]!.data).toEqual({
      plugin: 'mailer',
      run_id: r.run_id,
      class: 'session',
      effect_id: null,
      fingerprint: null,
      grants: [{ kind: 'session', scope: 'mailer', issuer: null }],
    })
    expect(fires[1]!.data).toEqual({
      plugin: 'mailer',
      run_id: r.run_id,
      intent_seq: fires[0]!.warplineseq,
      status: 'success',
    })
    expect(r.audit_failures).toEqual([])
  })

  test('an invocation that throws closes its intent with an outcome of threw', async () => {
    writePlugin('thrower')
    await grant(['thrower'])
    // `pluginConfigPath` resolves through `warplineHome()`. A config path that
    // is a directory makes `readFile` raise EISDIR, which `loadPluginConfig`
    // rethrows raw, so `invokePlugin` throws out of the engine's try.
    mkdirSync(join(home.root, 'config', 'thrower.json'), { recursive: true })

    const r = await advance()

    expect(r.plugin_states.get('thrower')).toBe('failed')
    const intents = linesOf('fire.intent')
    expect(intents.map((l) => l.data.plugin)).toEqual(['thrower'])
    expect(linesOf('fire.outcome').map((l) => l.data)).toEqual([
      { plugin: 'thrower', run_id: r.run_id, intent_seq: intents[0]!.warplineseq, status: 'threw' },
    ])
  })

  test('a plugin with no declared side effects gets no fire record, while its side-effecting sibling gets its intent', async () => {
    writePlugin('mailer')
    writePlugin('quiet', { side_effects: [] })
    await grant(['mailer'])

    await advance()

    expect(mark('quiet', 'invoked')).toBe('yes')
    expect(fireLines().filter((l) => l.data.plugin === 'quiet')).toEqual([])
    expect(linesOf('fire.intent').map((l) => l.data.plugin)).toEqual(['mailer'])
  })

  test('warpline run fires the handler and adds no fire record to the intent an advance left', async () => {
    writePlugin('mailer')
    await grant(['mailer'])
    await advance()
    const before = fireLines()
    expect(before.filter((l) => l.type === 'warpline.audit.fire.intent')).toHaveLength(1)
    rmSync(marksDir('mailer'), { recursive: true, force: true })

    const r = bin(['run', 'mailer', 'go'])

    expect(r.status).toBe(0)
    expect(mark('mailer', 'invoked')).toBe('yes')
    expect(fireLines()).toEqual(before)
  })
})

describe('a refusal is on the record with its reason', () => {
  test('a content refusal records fire.refused with its reason and no intent', async () => {
    await seedRefusal()

    const r = await advance()

    expect(r.refused_plugins).toEqual([{ plugin: 'sender', reason: 'outside_window' }])
    expect(mark('sender', 'invoked')).toBeNull()
    expect(linesOf('fire.refused').map((l) => l.data)).toEqual([
      { plugin: 'sender', run_id: r.run_id, reason: 'outside_window', intent_seq: null },
    ])
    expect(linesOf('fire.intent')).toEqual([])
  })
})

describe('a store that cannot take a fire record', () => {
  test('an intent that cannot be recorded does not fire: the plugin is failed, with no run record and no refusal', async () => {
    writePlugin('mailer')
    await grant(['mailer'])
    const spy = failAppend('fire.intent')

    const r = await advance()

    expect(spy.trips()).toBe(1)
    expect(mark('mailer', 'invoked')).toBeNull()
    expect(r.plugin_states.get('mailer')).toBe('failed')
    const entry = runLogEntry(r.run_log_path, 'mailer')
    expect(entry?.status).toBe('failed')
    expect(entry?.result_summary).toBe(INTENT_UNRECORDED)
    // A first run, so "unchanged" is "absent".
    expect(readState().plugin_runs.mailer).toBeUndefined()
    expect(r.refused_plugins).toEqual([])
    expect(r.audit_failures).toEqual([{ plugin: 'mailer', kind: 'fire.intent' }])
    // No intent, so nothing for an outcome to close.
    expect(fireLines()).toEqual([])
    expectNoSentinel()
  })

  test('an intent that cannot be recorded exits the advance 70, and stderr names the plugin', async () => {
    writePlugin('mailer')
    await grant(['mailer'])
    const spy = failAppend('fire.intent')

    const { code, stderr } = await capture(['advance'])

    expect(spy.trips()).toBe(1)
    expect(code).toBe(70)
    expect(stderr).toContain('mailer')
    expect(mark('mailer', 'invoked')).toBeNull()
    expectNoSentinel()
  })

  test('an outcome that cannot be recorded keeps every run record, retries nothing, and names its intent seq', async () => {
    writePlugin('a')
    writePlugin('b')
    await grant(['a', 'b'])
    const spy = failAppend('fire.outcome')

    const r = await advance()

    expect(spy.trips()).toBe(1)
    expect(mark('a', 'invoked')).toBe('yes')
    expect(mark('b', 'invoked')).toBe('yes')
    const runs = readState().plugin_runs
    expect(runs.a).toBeDefined()
    expect(runs.b).toBeDefined()
    expect(r.audit_failures).toHaveLength(1)
    const failure = r.audit_failures[0]!
    expect(failure.kind).toBe('fire.outcome')
    const intent = linesOf('fire.intent').find((l) => l.data.plugin === failure.plugin)
    expect(intent).toBeDefined()
    expect(failure).toEqual({ plugin: failure.plugin, kind: 'fire.outcome', intent_seq: intent!.warplineseq })
    // The sibling's outcome landed, and the failed one was not tried again.
    expect(linesOf('fire.outcome').map((l) => l.data.plugin)).toEqual([failure.plugin === 'a' ? 'b' : 'a'])
    expectNoSentinel()
  })

  test('an outcome that cannot be recorded exits 70 under --json, one document says 70, and stderr carries the intent seq', async () => {
    writePlugin('a')
    writePlugin('b')
    await grant(['a', 'b'])
    const spy = failAppend('fire.outcome')

    const { code, stdout, stderr } = await capture(['advance', '--json'])

    expect(spy.trips()).toBe(1)
    expect(code).toBe(70)
    const docs = stdout.split('\n').filter((l) => l.length > 0)
    expect(docs).toHaveLength(1)
    expect((JSON.parse(docs[0]!) as { exit_code: number }).exit_code).toBe(70)
    const closed = new Set(linesOf('fire.outcome').map((l) => l.data.intent_seq))
    const open = linesOf('fire.intent').filter((l) => !closed.has(l.warplineseq))
    expect(open).toHaveLength(1)
    expect(stderr).toContain(`seq ${open[0]!.warplineseq}`)
    expect(stderr).toContain(String(open[0]!.data.plugin))
  })

  test('a refusal that cannot be recorded still does not fire, and the advance exits 70 naming the plugin', async () => {
    await seedRefusal()
    const spy = failAppend('fire.refused')

    const { code, stderr } = await capture(['advance'])

    expect(spy.trips()).toBe(1)
    expect(code).toBe(70)
    expect(stderr).toContain('sender')
    expect(mark('sender', 'invoked')).toBeNull()
    expectNoSentinel()
  })

  test('under --strict, a held gate with an unrecorded outcome exits 70, not 1', async () => {
    writePlugin('mailer', { autonomy_level: 'supervised' })
    await grant(['mailer'])
    const spy = failAppend('fire.outcome')

    const { code, stdout } = await capture(['advance', '--strict'])

    expect(spy.trips()).toBe(1)
    expect(stdout).toContain('mailer: gated')
    expect(code).toBe(70)
  })

  // The segment file is made read-only, not the directory. A read-only
  // directory refuses the audit lock, and the advance's preferences check takes
  // that lock before any fire, so it would refuse with 75 there (pinned in
  // audit-preferences.test.ts) and never reach the intent. With no
  // preferences.json and none on the record there is nothing to append, so the
  // first append this advance tries is the intent.
  test.skipIf(process.getuid?.() === 0)(
    'a read-only segment stops the intent through the real bin: the handler never runs and the advance exits 70 (skipped as root: chmod cannot deny root)',
    () => {
      writePlugin('mailer')
      rmSync(join(home.root, 'preferences.json'))
      const approved = bin(['approve', 'mailer'])
      expect(approved.status).toBe(0)
      const segments = readdirSync(storeDir()).filter((f) => f.endsWith('.jsonl'))
      expect(segments).toHaveLength(1)
      const segment = join(storeDir(), segments[0]!)
      chmodSync(segment, 0o400)
      try {
        const r = bin(['advance'])

        expect(r.status).toBe(70)
        expect(mark('mailer', 'invoked')).toBeNull()
      } finally {
        chmodSync(segment, 0o600)
      }
    },
  )
})

// -- Content-class fires (25-06) ---------------------------------------------

/** A 64-hex digest of `s`, for seeded effect ids and fingerprints. */
const hex = (s: string): string => createHash('sha256').update(s).digest('hex')

/**
 * `builder` produces one json Output and declares no side effect, so it runs
 * ungranted. `sender` is a content-class consumer of it, with the marker
 * handler, so "not invoked" is observed rather than assumed.
 */
function writeContentPair(): void {
  const dir = join(home.pluginsDir, 'builder')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'manifest.ts'),
    `export const manifest = ${JSON.stringify({
      ...manifest('builder'),
      side_effects: [],
      outputs: { brief: { type: 'json' } },
      ttl_hours: 24,
    })}`,
  )
  writeFileSync(
    join(dir, 'handler.ts'),
    `export async function handler() {
  return {
    status: 'success',
    phases_completed: ['build'],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: 'built',
    artifacts_produced: [{ type: 'brief', format: 'json', body: ${JSON.stringify('{"batch":"four invoices"}')} }],
    schema_version: 1,
  }
}
`,
  )
  writePlugin('sender', { approval_class: 'content', dependencies: ['builder'] })
}

/** One advance produces builder's Output, and the operator approves those bytes for sender. */
async function seedContentApproval(): Promise<void> {
  writeContentPair()
  await advance()
  const approved = await capture(['approve', 'sender', '--content', '--not-after', '2099-01-01T00:00'])
  expect(approved.code).toBe(0)
  expect(mark('sender', 'invoked')).toBeNull()
}

type ApprovalRecord = {
  fingerprint: string
  effect_id: string | null
  marked_at: string | null
  confirmed_at: string | null
}

/** sender's approval as the state document holds it. */
function senderApproval(): ApprovalRecord {
  return (JSON.parse(readFileSync(statePath(), 'utf-8')) as { approvals: Record<string, ApprovalRecord> }).approvals
    .sender!
}

/** A write whose payload carries sender's mark and no confirmation: the spend mark's own write. */
const isMarkWrite = (payload: { approvals: Record<string, unknown> }): ApprovalRecord | undefined => {
  const record = Object.hasOwn(payload.approvals, 'sender') ? (payload.approvals.sender as ApprovalRecord) : undefined
  return record !== undefined && record.marked_at !== null && record.confirmed_at === null ? record : undefined
}

describe('content', () => {
  test("the intent is on disk when the mark's write is called, and the outcome closes it", async () => {
    await seedContentApproval()
    const realWrite = store.writeEngineState
    let intentAtMark: boolean | undefined
    installed.push(
      spyOn(store, 'writeEngineState').mockImplementation(async (payload, path) => {
        const record = isMarkWrite(payload)
        if (intentAtMark === undefined && record !== undefined) {
          intentAtMark = linesOf('fire.intent').some(
            (l) =>
              l.data.plugin === 'sender' &&
              l.data.class === 'content' &&
              l.data.effect_id === record.effect_id &&
              l.data.fingerprint === record.fingerprint,
          )
        }
        return realWrite(payload, path)
      }),
    )

    const r = await advance()

    expect(intentAtMark).toBe(true)
    expect(r.refused_plugins).toEqual([])
    expect(mark('sender', 'invoked')).toBe('yes')
    const approval = senderApproval()
    const intents = linesOf('fire.intent').filter((l) => l.data.plugin === 'sender')
    expect(intents.map((l) => l.data)).toEqual([
      {
        plugin: 'sender',
        run_id: r.run_id,
        class: 'content',
        effect_id: approval.effect_id,
        fingerprint: approval.fingerprint,
        grants: [],
      },
    ])
    expect(linesOf('fire.outcome').map((l) => l.data)).toEqual([
      { plugin: 'sender', run_id: r.run_id, intent_seq: intents[0]!.warplineseq, status: 'success' },
    ])
    expect(r.audit_failures).toEqual([])
  })

  test('an intent that cannot be recorded refuses mark_unavailable: nothing marked, nothing invoked, no seq', async () => {
    await seedContentApproval()
    const spy = failAppend('fire.intent')

    const r = await advance()

    expect(spy.trips()).toBe(1)
    expect(r.refused_plugins).toEqual([{ plugin: 'sender', reason: 'mark_unavailable' }])
    expect(senderApproval().marked_at).toBeNull()
    expect(mark('sender', 'invoked')).toBeNull()
    expect(linesOf('fire.refused').map((l) => l.data)).toEqual([
      { plugin: 'sender', run_id: r.run_id, reason: 'mark_unavailable', intent_seq: null },
    ])
    expect(linesOf('fire.intent')).toEqual([])
    expectNoSentinel()
  })

  test('a mark that fails after its intent landed refuses mark_uncertain with that seq, which closes it', async () => {
    await seedContentApproval()
    // The failTheMarkWrite(false) shape from content-spend-mark: the mark's own
    // write throws before the real write runs, every other write calls through.
    const realWrite = store.writeEngineState
    let trips = 0
    installed.push(
      spyOn(store, 'writeEngineState').mockImplementation(async (payload, path) => {
        if (trips === 0 && isMarkWrite(payload) !== undefined) {
          trips += 1
          throw new Error(SENTINEL)
        }
        return realWrite(payload, path)
      }),
    )

    const r = await advance()

    expect(trips).toBe(1)
    expect(r.refused_plugins).toEqual([{ plugin: 'sender', reason: 'mark_uncertain' }])
    expect(mark('sender', 'invoked')).toBeNull()
    const intents = linesOf('fire.intent').filter((l) => l.data.plugin === 'sender')
    expect(intents).toHaveLength(1)
    expect(linesOf('fire.refused').map((l) => l.data)).toEqual([
      { plugin: 'sender', run_id: r.run_id, reason: 'mark_uncertain', intent_seq: intents[0]!.warplineseq },
    ])
    expect((await audit.openIntents(statePath())).filter((i) => i.plugin === 'sender')).toEqual([])
    expectNoSentinel()
  })

  test('a failed mark whose refusal cannot be recorded leaves its intent open, and the next advance lists it as indeterminate', async () => {
    await seedContentApproval()
    const realWrite = store.writeEngineState
    let trips = 0
    installed.push(
      spyOn(store, 'writeEngineState').mockImplementation(async (payload, path) => {
        if (trips === 0 && isMarkWrite(payload) !== undefined) {
          trips += 1
          throw new Error(SENTINEL)
        }
        return realWrite(payload, path)
      }),
    )
    const refusal = failAppend('fire.refused')

    const first = await capture(['advance'])

    expect(trips).toBe(1)
    expect(refusal.trips()).toBe(1)
    expect(first.code).toBe(70)
    expect(mark('sender', 'invoked')).toBeNull()
    expect(linesOf('fire.refused')).toEqual([])
    const intents = linesOf('fire.intent').filter((l) => l.data.plugin === 'sender')
    expect(intents).toHaveLength(1)
    const seq = intents[0]!.warplineseq

    for (const spy of installed) spy.mockRestore()
    installed = []
    const second = await capture(['advance', '--json'])

    const docs = second.stdout.split('\n').filter((l) => l.length > 0)
    expect(docs).toHaveLength(1)
    const doc = JSON.parse(docs[0]!) as { audit: { indeterminate: { seq: number; plugin: string }[] } | null }
    expect(doc.audit).not.toBeNull()
    expect(doc.audit!.indeterminate.filter((i) => i.plugin === 'sender').map((i) => i.seq)).toEqual([seq])
    expectNoSentinel()
  })

  test('openIntents lists the intents no outcome, refusal or resolution closed, across a rotation too', async () => {
    expect(typeof audit.openIntents).toBe('function')
    expect(await audit.openIntents(join(home.root, 'none', 'state', 'engine-state.json'))).toEqual([])

    for (const [sub, opts] of [
      ['flat', {}],
      ['rotated', { maxSegmentBytes: 1 }],
    ] as const) {
      const path = join(home.root, sub, 'state', 'engine-state.json')
      const intent = (plugin: string, run_id: string) =>
        audit.appendAudit(
          path,
          'fire.intent',
          { plugin, run_id, class: 'content', effect_id: hex(`${plugin} effect`), fingerprint: hex(`${plugin} bytes`), grants: [] },
          opts,
        )
      const done = await intent('done', 'run-1')
      const refused = await intent('refused', 'run-1')
      const answered = await intent('answered', 'run-1')
      const open = await intent('open', 'run-2')
      await audit.appendAudit(path, 'fire.outcome', { plugin: 'done', run_id: 'run-1', intent_seq: done.seq, status: 'success' }, opts)
      await audit.appendAudit(
        path,
        'fire.refused',
        { plugin: 'refused', run_id: 'run-1', reason: 'mark_uncertain', intent_seq: refused.seq },
        opts,
      )
      await audit.appendAudit(
        path,
        'fire.resolved',
        { plugin: 'answered', effect_id: hex('answered effect'), intent_seq: answered.seq, answer: 'not_shipped', principal: null },
        opts,
      )

      expect(await audit.openIntents(path)).toEqual([
        { seq: open.seq, plugin: 'open', run_id: 'run-2', effect_id: hex('open effect') },
      ])
    }
    // The rotated store really did rotate, so the answer crossed a segment.
    expect(readdirSync(join(home.root, 'rotated', 'audit')).filter((f) => f.endsWith('.jsonl')).length).toBeGreaterThan(1)
  })
})

// -- Attribution: the grants that covered a fire (26-04) ---------------------

const DAY = 24 * 60 * 60 * 1000

/** `ops` an active human and `ci` an active machine, written and observed once (P10). */
async function seedPrincipals(): Promise<void> {
  writeFileSync(
    join(home.root, 'principals.json'),
    JSON.stringify({
      principals: [
        { id: 'ops', type: 'human', status: 'active' },
        { id: 'ci', type: 'machine', status: 'active' },
      ],
    }),
  )
  const loaded = await loadRegistry(statePath())
  expect('refused' in loaded).toBe(false)
}

/** Standing grants held by `ci`, issued by `ops`, over `mailer`, through the gate's own writer. */
async function issueStandingGrants(ids: string[], issuedAt = Date.now(), periodMs = DAY): Promise<void> {
  const read = await readStandingStore()
  if (!read.readable) throw new Error(`standing grants file unreadable: ${read.cause}`)
  let next = read.store
  for (const id of ids) {
    const issued = issueStanding(
      next,
      { id, holder: 'ci', issuer: 'ops', scopes: ['mailer'], periodMs, hardMaxMs: 30 * DAY },
      issuedAt,
    )
    if ('refused' in issued) throw new Error(`issue refused: ${issued.refused.code}`)
    next = issued.store
  }
  await writeStandingStore(next)
}

describe('a fire names the grants that covered it', () => {
  test('a session window and two standing grants are all named on the intent, sorted', async () => {
    writePlugin('mailer')
    await seedPrincipals()
    await mergeGrant(['mailer'], { principal: 'ops' }, join(home.root, '.session-approval'))
    await issueStandingGrants(['222222222222', '111111111111'])

    const r = await advance()

    expect(r.plugin_states.get('mailer')).toBe('completed')
    const intents = linesOf('fire.intent').filter((l) => l.data.plugin === 'mailer')
    expect(intents).toHaveLength(1)
    expect(intents[0]!.data.grants).toEqual([
      { kind: 'session', scope: 'mailer', issuer: 'ops' },
      { kind: 'standing', id: '111111111111', holder: 'ci', issuer: 'ops' },
      { kind: 'standing', id: '222222222222', holder: 'ci', issuer: 'ops' },
    ])
  })

  test('with one standing grant revoked first, the intent names two', async () => {
    writePlugin('mailer')
    await seedPrincipals()
    await mergeGrant(['mailer'], { principal: 'ops' }, join(home.root, '.session-approval'))
    await issueStandingGrants(['111111111111', '222222222222'])
    const read = await readStandingStore()
    if (!read.readable) throw new Error(`standing grants file unreadable: ${read.cause}`)
    const revoked = revokeStanding(read.store, ['111111111111'])
    if ('refused' in revoked) throw new Error(`revoke refused: ${revoked.refused.code}`)
    await writeStandingStore(revoked.store)

    await advance()

    const intents = linesOf('fire.intent').filter((l) => l.data.plugin === 'mailer')
    expect(intents).toHaveLength(1)
    expect(intents[0]!.data.grants).toEqual([
      { kind: 'session', scope: 'mailer', issuer: 'ops' },
      { kind: 'standing', id: '222222222222', holder: 'ci', issuer: 'ops' },
    ])
  })

  test('under a lapsed standing grant only, nothing fires and no intent is written', async () => {
    writePlugin('mailer')
    await seedPrincipals()
    await issueStandingGrants([newStandingId()], Date.now() - 3 * DAY, DAY)

    const r = await advance()

    expect(r.plugin_states.get('mailer')).toBe('skipped')
    expect(mark('mailer', 'invoked')).toBeNull()
    expect(linesOf('fire.intent').filter((l) => l.data.plugin === 'mailer')).toEqual([])
  })

  test('a content fire names no grant', async () => {
    await seedContentApproval()

    await advance()

    expect(mark('sender', 'invoked')).toBe('yes')
    const intents = linesOf('fire.intent').filter((l) => l.data.plugin === 'sender')
    expect(intents).toHaveLength(1)
    expect(intents[0]!.data.grants).toEqual([])
  })

  test('four hundred standing grants push the intent past one record and nothing fires', async () => {
    writePlugin('mailer')
    await seedPrincipals()
    await issueStandingGrants(Array.from({ length: 400 }, () => newStandingId()))

    const r = await advance()

    expect(r.audit_failures).toContainEqual({ plugin: 'mailer', kind: 'fire.intent' })
    expect(mark('mailer', 'invoked')).toBeNull()
    expect(r.plugin_states.get('mailer')).toBe('failed')
    expect(linesOf('fire.intent').filter((l) => l.data.plugin === 'mailer')).toEqual([])
  })
})
