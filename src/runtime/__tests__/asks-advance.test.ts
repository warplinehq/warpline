/**
 * `runAdvance` raises Asks and sends them through `notify`.
 *
 * Each case drives a real advance over a temp home (AGENTS.md Rule 2), with
 * the `notify` command built by `test-utils/notify-stub.ts` under that home.
 * The stub records every call and every message it receives, so "it was sent
 * once" is a count on disk, not a guess. Later plans of this phase add their
 * describes here.
 *
 * The fixture is one plugin, `mailer`: session class, autonomous, declaring
 * `sends_email`, with no Grant anywhere. Every advance skips it for want of a
 * Grant, which is the decision a missing-Grant Ask is raised for.
 *
 * The four-kind home adds the other three kinds, and the second and third
 * describes build on it. `builder` emits one inline Output, `sender` is a
 * content-class consumer of it, and `reviewed` is a supervised session-class
 * plugin holding a session grant, so it runs and parks. Their sentinels are
 * drawn per case at run time, so no source file in the repository holds one.
 *
 * A module once imported is never read again in one process, so a case that
 * changes a manifest between advances writes a fresh plugin root rather than
 * rewriting the file in place.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _setHome } from '../../lib/paths.js'
import { loadRegistry, standingRegistry } from '../../lib/principals.js'
import { _getPaths, _setPaths, pathsForStateFile } from '../../board/state-manager.js'
import { denialFingerprint, proposalFingerprint, runAdvance, type AdvanceOptions } from '../engine.js'
import { readEngineState } from '../engine-state-store.js'
import * as gate from '../approval-gate.js'
import type { PluginManifest } from '../../schemas/plugin-manifest.js'
import { auditRecords, capture, failAppendOnce, makeVerbHome, restoreSpies, type VerbHome } from '../../cli/__tests__/helpers/verb-home.js'
import { testFixturesDir } from '../../../test-utils/fixtures.js'
import { notifyStub, setNotify } from '../../../test-utils/notify-stub.js'

const REAL_PATHS = _getPaths()
const HOUR = 60 * 60 * 1000
const T0 = Date.parse('2026-10-11T08:00:00.000Z')

let home: string

const statePath = (): string => join(home, 'state', 'engine-state.json')
const prefsPath = (): string => join(home, 'state', 'preferences.json')
const eventsPath = (): string => join(home, 'runs', 'events.jsonl')
const asksFile = (): string => join(home, 'state', 'asks.json')

/** Every manifest field spelled out, so no fixture leans on a schema default. */
function manifestOf(name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    version: '1.0.0',
    description: `${name} fixture plugin`,
    inputs: {},
    outputs: {},
    capabilities: [],
    secrets: [],
    schedule: 'on_run',
    autonomy_level: 'autonomous',
    approval_class: 'session',
    llm_handoff: false,
    side_effects: ['sends_email'],
    ttl_hours: 24,
    dependencies: [],
    timeout_ms: 5000,
    max_parallelism: 1,
    min_tier: 'normal',
    max_retries: 1,
    retry_delay_ms: 2000,
    ...overrides,
  }
}

/** A handler that returns a successful result with `fields` laid over it. */
function resultHandler(fields: Record<string, unknown> = {}): string {
  const result = {
    status: 'success',
    phases_completed: [],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: 'fixture ok',
    artifacts_produced: [],
    schema_version: 1,
    ...fields,
  }
  return `export async function handler(_manifest, _args) {\n  return ${JSON.stringify(result)}\n}\n`
}

function writeFixture(name: string, manifest: Record<string, unknown>, handler: string): void {
  const dir = join(home, 'plugins', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'manifest.ts'), `export const manifest = ${JSON.stringify(manifest)}`)
  writeFileSync(join(dir, 'handler.ts'), handler)
}

/** A session-class plugin that declares a side effect and would succeed if it ran. */
function writePlugin(name: string): void {
  writeFixture(name, manifestOf(name), resultHandler())
}

function writePrefs(prefs: Record<string, unknown>): void {
  writeFileSync(prefsPath(), JSON.stringify(prefs))
}

function advance(now: number, extra: Partial<AdvanceOptions> = {}): ReturnType<typeof runAdvance> {
  return runAdvance({
    pluginsDir: join(home, 'plugins'),
    stateDir: statePath(),
    runsDir: join(home, 'runs'),
    eventsPath: eventsPath(),
    preferencesPath: prefsPath(),
    now,
    ...extra,
  })
}

type StoredAsk = Record<string, unknown> & {
  id: string
  events: Array<{ seq: number; event: string; at: string }>
  tries: Array<{ seq: number; at: string; outcome: string; exit_code: number | null }>
}

/** The parsed Ask store, or null when the file is absent. */
function asks(): { min_reader_version: number; asks: StoredAsk[] } | null {
  return existsSync(asksFile()) ? JSON.parse(readFileSync(asksFile(), 'utf-8')) : null
}

type Line = { type: string; warplineseq: number; data: Record<string, unknown> }

/** Every audit line under `<home>/audit/`, segments in name order. */
function auditLines(): Line[] {
  const dir = join(home, 'audit')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .flatMap((f) =>
      readFileSync(join(dir, f), 'utf-8')
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as Line),
    )
}

/** Every `warpline.audit.<kind>` line under `<home>/audit/`, segments in name order. */
function auditOf(kind: string): Line[] {
  return auditLines().filter((l) => l.type === `warpline.audit.${kind}`)
}

/** A quiet window from an hour ago to an hour ahead, on the real clock the guard reads. */
function windowAroundNow(): { start: string; end: string } {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const at = (offsetMs: number): string => {
    const d = new Date(Date.now() + offsetMs)
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
  return { start: at(-HOUR), end: at(HOUR) }
}

// -- The four-kind home, shared by the describes below --------------------------

const BUILDER = manifestOf('builder', { side_effects: [], outputs: { brief: { type: 'json' } } })
const SENDER = manifestOf('sender', {
  approval_class: 'content',
  dependencies: ['builder'],
  // Near zero, so sender is stale on every advance and reaches the content gate.
  ttl_hours: 0.001,
})
const REVIEWED = manifestOf('reviewed', {
  autonomy_level: 'supervised',
  side_effects: ['creates_issue'],
  dependencies: ['builder'],
  ttl_hours: 2,
  outputs: { note: { type: 'text' } },
})
const MAILER = manifestOf('mailer')
const asManifest = (m: Record<string, unknown>): PluginManifest => m as unknown as PluginManifest

let BODY_SENTINEL: string
let PARKED_SENTINEL: string
let SUMMARY_SENTINEL: string
let ERROR_SENTINEL: string

const sessionPath = (): string => join(home, '.session-approval')
const capturePath = (): string => join(home, 'notify-ok.capture')
type Entry = Record<string, unknown> & { kind: string; scope: string }

beforeEach(() => {
  BODY_SENTINEL = `body-${randomUUID()}`
  PARKED_SENTINEL = `parked-${randomUUID()}`
  SUMMARY_SENTINEL = `summary-${randomUUID()}`
  ERROR_SENTINEL = `error-${randomUUID()}`
})

/** `builder` and `sender`; `sender` reports `failed` while `<home>/fail` exists. */
function writeContentPair(): void {
  writeFixture(
    'builder',
    BUILDER,
    resultHandler({
      summary: 'built',
      artifacts_produced: [{ type: 'brief', format: 'json', body: JSON.stringify({ note: BODY_SENTINEL }) }],
    }),
  )
  writeFixture(
    'sender',
    SENDER,
    `import { existsSync } from 'node:fs'
export async function handler() {
  const failed = existsSync(${JSON.stringify(join(home, 'fail'))})
  return {
    status: failed ? 'failed' : 'success',
    phases_completed: [],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: failed ? 'the send reported a failure' : 'sent',
    artifacts_produced: [],
    schema_version: 1,
  }
}
`,
  )
}

/** The three-decision home: `mailer` with no Grant, `sender` with no approval, `reviewed` granted and supervised. */
async function writeThreeDecisions(): Promise<void> {
  writeContentPair()
  writeFixture(
    'reviewed',
    REVIEWED,
    resultHandler({
      summary: SUMMARY_SENTINEL,
      errors: [{ code: 'data_missing', message: ERROR_SENTINEL, impact: 'LOW' }],
      artifacts_produced: [{ type: 'note', format: 'text', body: PARKED_SENTINEL }],
    }),
  )
  await gate.mergeGrant(['reviewed'], {}, sessionPath())
}

async function state() {
  return readEngineState(statePath(), { eventsPath: eventsPath(), announceDiscards: false })
}

const open = (): StoredAsk[] => (asks()?.asks ?? []).filter((a) => a.state === 'open')

type Principal = { id: string; type: 'human' | 'machine'; status: 'active' | 'disabled' }

async function seedRegistry(): Promise<void> {
  const principals: Principal[] = [
    { id: 'ops', type: 'human', status: 'active' },
    { id: 'ci', type: 'machine', status: 'active' },
  ]
  writeFileSync(join(home, 'principals.json'), JSON.stringify({ principals }))
  expect('refused' in (await loadRegistry(statePath()))).toBe(false)
}

/** A standing grant held by `ci`, issued by `ops`, over `scopes` (`mailer` unless named), through the gate's own writer. Returns its id. */
async function issueGrant(
  issuedAt: number,
  periodMs: number,
  hardMaxMs: number,
  { scopes = ['mailer'] }: { scopes?: string[] } = {},
): Promise<string> {
  const read = await gate.readStandingStore()
  if (!read.readable) throw new Error(`standing grants file unreadable: ${read.cause}`)
  const id = gate.newStandingId()
  const next = gate.issueStanding(
    read.store,
    { id, holder: 'ci', issuer: 'ops', scopes, periodMs, hardMaxMs },
    issuedAt,
  )
  if ('refused' in next) throw new Error(`issue refused: ${next.refused.code}`)
  await gate.writeStandingStore(next.store)
  return id
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'warpline-asks-advance-'))
  _setHome(home)
  mkdirSync(join(home, 'state'), { recursive: true })
  mkdirSync(join(home, 'runs'), { recursive: true })
  _setPaths(pathsForStateFile(statePath(), { eventsPath: eventsPath() }))
  writePrefs({ review_gate: false })
  writePlugin('mailer')
})

afterEach(() => {
  _setHome(null)
  rmSync(home, { recursive: true, force: true })
})

afterAll(() => {
  _setPaths(REAL_PATHS)
})

describe('an advance raises a missing-Grant Ask and sends it through notify', () => {
  test('a missing Grant raises one Ask, recorded before the Checkpoint, and notify receives one message', async () => {
    const stub = await notifyStub(home, 'ok')
    setNotify(prefsPath(), { argv: stub.argv })

    const result = await advance(T0)
    expect(result.plugin_states.get('mailer')).toBe('skipped')

    const store = asks()
    expect(store).not.toBeNull()
    expect(store!.asks).toHaveLength(1)
    const ask = store!.asks[0]!
    expect(ask).toMatchObject({
      kind: 'missing_grant',
      scope: 'mailer',
      plugin: 'mailer',
      digest: denialFingerprint('mailer', ['sends_email'], []),
      raised_at: new Date(T0).toISOString(),
      expires_at: new Date(T0 + 23 * HOUR).toISOString(),
      state: 'open',
    })
    expect(ask.events).toEqual([{ seq: 1, event: 'raised', at: new Date(T0).toISOString() }])
    expect(ask.tries).toHaveLength(1)
    expect(ask.tries[0]).toMatchObject({ seq: 1, outcome: 'delivered', exit_code: 0 })
    expect(new Date(ask.tries[0]!.at).toISOString()).toBe(ask.tries[0]!.at)
    expect(statSync(asksFile()).mode & 0o777).toBe(0o600)

    const raised = auditOf('ask.raised')
    expect(raised).toHaveLength(1)
    expect(raised[0]!.data).toEqual({
      id: ask.id,
      kind: ask.kind,
      scope: ask.scope,
      plugin: ask.plugin,
      digest: ask.digest,
      raised_at: ask.raised_at,
      expires_at: ask.expires_at,
    })
    const checkpoints = auditOf('checkpoint.recorded')
    expect(checkpoints.length).toBeGreaterThan(0)
    expect(raised[0]!.warplineseq).toBeLessThan(checkpoints.at(-1)!.warplineseq)

    const messages = stub.messages() as Array<{ entries: Array<Record<string, unknown>> }>
    expect(messages).toHaveLength(1)
    expect(messages[0]!.entries).toHaveLength(1)
    expect(messages[0]!.entries[0]).toEqual({
      id: ask.id,
      seq: 1,
      event: 'raised',
      kind: ask.kind,
      scope: ask.scope,
      plugin: ask.plugin,
      digest: ask.digest,
      nonce: ask.nonce,
      summary: ask.summary,
      raised_at: ask.raised_at,
      expires_at: ask.expires_at,
    })
    expect('content' in messages[0]!.entries[0]!).toBe(false)
  })

  test('ten advances over the unchanged decision leave one open Ask and send one message', async () => {
    const stub = await notifyStub(home, 'ok')
    setNotify(prefsPath(), { argv: stub.argv })

    for (let i = 0; i < 10; i++) await advance(T0 + i * 60_000)

    const store = asks()
    expect(store).not.toBeNull()
    expect(store!.asks.filter((a) => a.state === 'open')).toHaveLength(1)
    expect(store!.asks).toHaveLength(1)
    expect(auditOf('ask.raised')).toHaveLength(1)
    expect(stub.invocations()).toBe(1)
  })

  test('with notify unset, an advance that skips for a Grant writes no Ask and sends nothing', async () => {
    const result = await advance(T0)

    expect(result.plugin_states.get('mailer')).toBe('skipped')
    expect(asks()).toBeNull()
    expect(auditOf('ask.raised')).toHaveLength(0)
  })

  test('a dry run and a quiet-hours advance raise and send nothing', async () => {
    const stub = await notifyStub(home, 'ok')
    setNotify(prefsPath(), { argv: stub.argv })

    await advance(T0, { dryRun: true })
    expect(asks()).toBeNull()
    expect(auditOf('ask.raised')).toHaveLength(0)
    expect(stub.invocations()).toBe(0)

    writePrefs({ review_gate: false, quiet_hours: windowAroundNow(), notify: { argv: stub.argv } })
    await advance(T0)
    expect(asks()).toBeNull()
    expect(auditOf('ask.raised')).toHaveLength(0)
    expect(stub.invocations()).toBe(0)
  })

  test('an unusable notify block raises and sends nothing, and the advance completes', async () => {
    const stub = await notifyStub(home, 'ok')
    setNotify(prefsPath(), { argv: [] })

    const result = await advance(T0)

    expect(result.plugin_states.get('mailer')).toBe('skipped')
    expect(asks()).toBeNull()
    expect(auditOf('ask.raised')).toHaveLength(0)
    expect(stub.invocations()).toBe(0)
  })
})

describe('every waited-on decision raises an Ask, one message per advance', () => {

  test('three due decisions in one advance send one message holding three Asks, the parked one first', async () => {
    await writeThreeDecisions()
    const stub = await notifyStub(home, 'ok')
    setNotify(prefsPath(), { argv: stub.argv })

    // The real clock: the gate's own clocks are wall-clock reads.
    const result = await advance(Date.now())
    expect(result.plugin_states.get('reviewed')).toBe('gated')
    expect(result.plugin_states.get('mailer')).toBe('skipped')
    expect(result.plugin_states.get('sender')).toBe('skipped')

    const messages = stub.messages() as Array<{ entries: Entry[] }>
    expect(messages).toHaveLength(1)
    const entries = messages[0]!.entries
    expect(entries).toHaveLength(3)
    expect(entries[0]!.kind).toBe('parked_result')
    expect(entries.slice(1).map((e) => e.kind).sort()).toEqual(['content', 'missing_grant'])
    for (const e of entries) expect(e.digest).toMatch(/^[0-9a-f]{64}$/)

    const stored = open()
    expect(stored).toHaveLength(3)
    for (const a of stored) {
      for (const key of ['id', 'nonce', 'kind', 'scope', 'plugin', 'digest', 'summary', 'raised_at', 'expires_at', 'events', 'tries']) {
        expect(a).toHaveProperty(key)
      }
      expect(a.digest).toMatch(/^[0-9a-f]{64}$/)
    }
    const byKind = Object.fromEntries(stored.map((a) => [a.kind as string, a]))
    const written = await state()
    expect(byKind.parked_result).toMatchObject({ scope: 'reviewed', plugin: 'reviewed' })
    expect(byKind.parked_result!.digest).toBe(proposalFingerprint(written, 'reviewed', asManifest(REVIEWED)))
    expect(byKind.missing_grant).toMatchObject({ scope: 'mailer', plugin: 'mailer' })
    expect(byKind.missing_grant!.digest).toBe(proposalFingerprint(written, 'mailer', asManifest(MAILER)))
    expect(byKind.content).toMatchObject({ scope: 'sender', plugin: 'sender' })
    expect(byKind.content!.digest).toBe(proposalFingerprint(written, 'builder', asManifest(BUILDER)))
  })

  test('a parked Ask expires with its gate', async () => {
    await writeThreeDecisions()
    const stub = await notifyStub(home, 'ok')
    setNotify(prefsPath(), { argv: stub.argv })

    await advance(Date.now())

    const gateOf = (await state()).pending_gates.find((g) => g.plugin === 'reviewed')
    expect(gateOf).toBeDefined()
    const parked = open().find((a) => a.kind === 'parked_result')
    expect(parked).toBeDefined()
    expect(parked!.expires_at).toBe(new Date(Date.parse(gateOf!.run_completed_at!) + 2 * HOUR).toISOString())
  })


  test('a standing grant due within 23 hours raises a renewal Ask with no plugin and the grant id as scope', async () => {
    await seedRegistry()
    const id = await issueGrant(T0 - HOUR, 12 * HOUR, 30 * 24 * HOUR)
    const stub = await notifyStub(home, 'ok')
    setNotify(prefsPath(), { argv: stub.argv })

    await advance(T0)

    const renewals = (asks()?.asks ?? []).filter((a) => a.kind === 'renewal')
    expect(renewals).toHaveLength(1)
    const ask = renewals[0]!
    const g = (
      JSON.parse(readFileSync(join(home, 'standing-grants.json'), 'utf-8')) as {
        grants: Array<{
          id: string
          holder: string
          issuer: string
          scopes: string[]
          issued_at: string
          period_start: string
          period_ms: number
          hard_max_ms: number
        }>
      }
    ).grants.find((x) => x.id === id)!
    const digest = createHash('sha256')
      .update(
        JSON.stringify({
          id: g.id,
          holder: g.holder,
          issuer: g.issuer,
          scopes: [...g.scopes].sort(),
          issued_at: g.issued_at,
          period_start: g.period_start,
          period_ms: g.period_ms,
          hard_max_ms: g.hard_max_ms,
        }),
      )
      .digest('hex')
    expect(ask).toMatchObject({ scope: id, plugin: null, digest, expires_at: new Date(T0 + 11 * HOUR).toISOString() })

    const raised = auditOf('ask.raised').filter((l) => l.data.kind === 'renewal')
    expect(raised).toHaveLength(1)
    expect(raised[0]!.data).toMatchObject({ scope: id, plugin: null })
    const entry = (stub.messages() as Array<{ entries: Entry[] }>).flatMap((m) => m.entries).find((e) => e.kind === 'renewal')
    expect(entry).toMatchObject({ scope: id, plugin: null })
  })

  test('a standing grant not yet due, or whose deadline is its hard maximum, raises nothing', async () => {
    await seedRegistry()
    await issueGrant(T0 - HOUR, 48 * HOUR, 30 * 24 * HOUR)
    await issueGrant(T0 - HOUR, 12 * HOUR, 12 * HOUR)
    // The positive control: a grant due within the hour beside them is asked about.
    const due = await issueGrant(T0 - HOUR, 2 * HOUR, 30 * 24 * HOUR)
    const stub = await notifyStub(home, 'ok')
    setNotify(prefsPath(), { argv: stub.argv })

    await advance(T0)

    expect((asks()?.asks ?? []).filter((a) => a.kind === 'renewal').map((a) => a.scope)).toEqual([due])
  })

  test('a content standing no Answer can settle raises nothing: a window that opens tomorrow (before_window)', async () => {
    writeContentPair()
    await advance(Date.now())
    const tomorrow = new Date(Date.now() + 24 * HOUR).toISOString().slice(0, 16)
    const approved = await capture(['approve', 'sender', '--content', '--not-before', tomorrow, '--not-after', '2099-01-01T00:00'])
    expect(approved.code).toBe(0)

    const stub = await notifyStub(home, 'ok')
    setNotify(prefsPath(), { argv: stub.argv })
    const result = await advance(Date.now())

    expect(result.plugin_states.get('sender')).toBe('skipped')
    // The pass ran: mailer's missing Grant is asked about.
    expect(open().map((a) => a.kind)).toContain('missing_grant')
    expect(open().filter((a) => a.kind === 'content')).toEqual([])
  })

  test('a content standing no Answer can settle raises nothing: a fire marked and never confirmed (indeterminate)', async () => {
    writeContentPair()
    await advance(Date.now())
    const approved = await capture(['approve', 'sender', '--content', '--not-after', '2099-01-01T00:00'])
    expect(approved.code).toBe(0)
    writeFileSync(join(home, 'fail'), '')
    await advance(Date.now())
    const record = (await state()).approvals.sender
    expect(record?.marked_at).not.toBeNull()
    expect(record?.confirmed_at).toBeNull()

    const stub = await notifyStub(home, 'ok')
    setNotify(prefsPath(), { argv: stub.argv })
    await advance(Date.now())

    expect(open().map((a) => a.kind)).toContain('missing_grant')
    expect(open().filter((a) => a.kind === 'content')).toEqual([])
  })

  test('a plugin with a parked result and no Grant is asked about its parked result only', async () => {
    await writeThreeDecisions()
    // Parked with notify unset, so the next advance sees both decisions at once.
    await advance(Date.now())
    expect((await state()).pending_gates.map((g) => g.plugin)).toEqual(['reviewed'])
    await gate.revokeApproval(sessionPath())

    const stub = await notifyStub(home, 'ok')
    setNotify(prefsPath(), { argv: stub.argv })
    const result = await advance(Date.now(), { force: true })
    expect(result.plugin_states.get('reviewed')).toBe('skipped')

    const onReviewed = open().filter((a) => a.scope === 'reviewed')
    expect(onReviewed.map((a) => a.kind)).toEqual(['parked_result'])
  })

  test('content is in no notify payload unless include_content is set', async () => {
    await writeThreeDecisions()
    const stub = await notifyStub(home, 'ok')
    setNotify(prefsPath(), { argv: stub.argv })

    await advance(Date.now())

    expect(stub.invocations()).toBe(1)
    const raw = readFileSync(capturePath(), 'utf-8')
    for (const s of [BODY_SENTINEL, PARKED_SENTINEL, SUMMARY_SENTINEL, ERROR_SENTINEL]) expect(raw).not.toContain(s)
  })

  test('with include_content set, only the approved-bytes kinds carry their inline body', async () => {
    await writeThreeDecisions()
    const stub = await notifyStub(home, 'ok')
    setNotify(prefsPath(), { argv: stub.argv, include_content: true })

    await advance(Date.now())

    const entries = (stub.messages() as Array<{ entries: Entry[] }>).flatMap((m) => m.entries)
    const byKind = Object.fromEntries(entries.map((e) => [e.kind, e]))
    expect(String(byKind.parked_result?.content)).toContain(PARKED_SENTINEL)
    expect(String(byKind.content?.content)).toContain(BODY_SENTINEL)
    expect(byKind.missing_grant).toBeDefined()
    expect(byKind.missing_grant!.content).toBeNull()
    const raw = readFileSync(capturePath(), 'utf-8')
    expect(raw).not.toContain(SUMMARY_SENTINEL)
    expect(raw).not.toContain(ERROR_SENTINEL)
  })
})

describe('one open Ask per scope, on a schedule, until it expires', () => {
  const MIN = 60 * 1000
  type Message = { entries: Array<Entry & { id: string; seq: number; event: string }> }
  const shape = (m: Message): Array<[string, number, string]> => m.entries.map((e) => [e.id, e.seq, e.event])
  const byId = (id: string): StoredAsk => asks()!.asks.find((a) => a.id === id)!

  /** A copy of the plugin root in which `mailer` declares a second side effect, so its proposal moves. */
  function rootWithChangedMailer(): string {
    const root = join(home, 'plugins-changed')
    cpSync(join(home, 'plugins'), root, { recursive: true })
    const manifest = manifestOf('mailer', { side_effects: ['sends_email', 'creates_issue'] })
    writeFileSync(join(root, 'mailer', 'manifest.ts'), `export const manifest = ${JSON.stringify(manifest)}`)
    return root
  }

  test('a changed decision supersedes: the old Ask closes, a superseded entry is sent, and the new Ask has a new nonce', async () => {
    const stub = await notifyStub(home, 'ok')
    setNotify(prefsPath(), { argv: stub.argv })

    await advance(T0)
    const old = asks()!.asks[0]!
    await advance(T0 + 10 * MIN, { pluginsDir: rootWithChangedMailer() })

    const messages = stub.messages() as Message[]
    expect(messages).toHaveLength(2)
    const fresh = asks()!.asks.find((a) => a.id !== old.id)
    expect(fresh).toBeDefined()
    expect(shape(messages[1]!)).toEqual([
      [old.id, 2, 'superseded'],
      [fresh!.id, 1, 'raised'],
    ])
    expect(open().map((a) => a.id)).toEqual([fresh!.id])
    expect(fresh!.nonce).not.toBe(old.nonce)
    expect(byId(old.id)).toMatchObject({ state: 'superseded', closed_at: new Date(T0 + 10 * MIN).toISOString() })
  })

  test('reminders follow the schedule, never every advance', async () => {
    const stub = await notifyStub(home, 'ok')
    setNotify(prefsPath(), { argv: stub.argv })

    for (const at of [0, 59 * MIN, HOUR, 90 * MIN, 5 * HOUR]) await advance(T0 + at)

    expect(stub.invocations()).toBe(3)
    const messages = stub.messages() as Message[]
    const id = asks()!.asks[0]!.id
    expect(shape(messages[1]!)).toEqual([[id, 2, 'reminder']])
    expect(shape(messages[2]!)).toEqual([[id, 3, 'reminder']])
  })

  test('an Ask for a never-granted plugin expires 23 hours after it was raised, sends one expired entry, and the next advance raises a new nonce', async () => {
    const stub = await notifyStub(home, 'ok')
    setNotify(prefsPath(), { argv: stub.argv })

    await advance(T0)
    const old = asks()!.asks[0]!
    expect(old.expires_at).toBe(new Date(T0 + 23 * HOUR).toISOString())

    await advance(T0 + 23 * HOUR)
    expect(byId(old.id)).toMatchObject({ state: 'expired', closed_at: new Date(T0 + 23 * HOUR).toISOString(), answer: null })
    expect(open()).toEqual([])
    let messages = stub.messages() as Message[]
    expect(messages).toHaveLength(2)
    expect(shape(messages[1]!)).toEqual([[old.id, 2, 'expired']])

    await advance(T0 + 23 * HOUR + MIN)
    const fresh = open()
    expect(fresh).toHaveLength(1)
    expect(fresh[0]!.id).not.toBe(old.id)
    expect(fresh[0]!.nonce).not.toBe(old.nonce)
    messages = stub.messages() as Message[]
    expect(messages).toHaveLength(3)
    expect(shape(messages[2]!)).toEqual([[fresh[0]!.id, 1, 'raised']])
  })

  test('a parked result past its plugin TTL is asked about once, and the Grant it lacks is asked about instead', async () => {
    // No dependency, so no re-run of another plugin can discard its gate.
    writeFixture(
      'parker',
      manifestOf('parker', { autonomy_level: 'supervised', side_effects: ['creates_issue'], ttl_hours: 2 }),
      resultHandler(),
    )
    await gate.mergeGrant(['parker'], {}, sessionPath())
    const stub = await notifyStub(home, 'ok')
    setNotify(prefsPath(), { argv: stub.argv })

    const t0 = Date.now()
    const first = await advance(t0)
    expect(first.plugin_states.get('parker')).toBe('gated')
    expect(open().filter((a) => a.scope === 'parker').map((a) => a.kind)).toEqual(['parked_result'])
    await gate.revokeApproval(sessionPath())

    // Past the 2-hour TTL, inside the 23-hour gate ceiling. `force` evaluates
    // parker, so its missing-Grant decision is seen.
    for (let i = 0; i < 5; i++) await advance(t0 + 3 * HOUR + i * 5 * MIN, { force: true })

    const raised = auditOf('ask.raised').filter((l) => l.data.scope === 'parker')
    expect(raised.filter((l) => l.data.kind === 'parked_result')).toHaveLength(1)
    expect(raised.filter((l) => l.data.kind === 'missing_grant')).toHaveLength(1)

    const stored = asks()!.asks
    expect(stored.filter((a) => Date.parse(a.expires_at as string) <= Date.parse(a.raised_at as string))).toEqual([])
    const parked = stored.filter((a) => a.scope === 'parker' && a.kind === 'parked_result')
    expect(parked).toHaveLength(1)
    expect(parked[0]!.events.map((e) => e.event)).toEqual(['raised', 'expired'])
    expect(open().filter((a) => a.scope === 'parker').map((a) => a.kind)).toEqual(['missing_grant'])

    const sent = (stub.messages() as Message[]).flatMap((m) => m.entries).filter((e) => e.id === parked[0]!.id)
    expect(sent.map((e) => e.event)).toEqual(['raised', 'expired'])
  })

  test('no raise, reminder, supersede, expiry or send writes an Answer, a Grant, a content approval or a renewal, for any kind of Ask', async () => {
    await writeThreeDecisions()
    await seedRegistry()
    // The real clock, read once: the parked gate's clocks are wall-clock reads.
    const t0 = Date.now()
    // Over `builder`, which declares no side effect: the grant changes nothing that fires, and `mailer` still lacks a Grant.
    const grantId = await issueGrant(t0 - HOUR, 12 * HOUR, 30 * 24 * HOUR, { scopes: ['builder'] })

    // With notify unset: writes the state document and parks `reviewed`, so every authority store exists before the sequence.
    await advance(t0 - 60_000)
    const standingPath = join(home, 'standing-grants.json')
    expect(existsSync(sessionPath())).toBe(true)
    expect(existsSync(standingPath)).toBe(true)
    expect(existsSync(statePath())).toBe(true)
    expect((await state()).pending_gates.map((g) => g.plugin)).toEqual(['reviewed'])
    expect(asks()).toBeNull()

    const stub = await notifyStub(home, 'ok')
    setNotify(prefsPath(), { argv: stub.argv })

    const authority = async () => {
      const s = await state()
      return {
        session: readFileSync(sessionPath(), 'utf-8'),
        standing: readFileSync(standingPath, 'utf-8'),
        approvals: JSON.stringify(s.approvals),
        denials: JSON.stringify(s.denials),
        applied: s.pending_gates
          .filter((g) => g.applied_at !== null)
          .map((g) => `${g.plugin}:${g.run_id}`)
          .sort(),
      }
    }
    const answersOrGrants = (type: string): boolean =>
      type === 'warpline.audit.ask.answered' || /^warpline\.audit\.(grant|content_approval|denial)\./.test(type)
    /** One advance, holding every authority store and the audit store's answer and grant kinds still across it. */
    async function step(now: number, extra: Partial<AdvanceOptions> = {}): Promise<void> {
      const before = await authority()
      const mark = auditLines().length
      await advance(now, extra)
      expect(await authority()).toEqual(before)
      expect(auditLines().slice(mark).map((l) => l.type).filter(answersOrGrants)).toEqual([])
    }
    const kindsOf = (list: StoredAsk[]): Record<string, StoredAsk> => Object.fromEntries(list.map((a) => [a.kind as string, a]))

    // 1. Raise: one Ask of each kind.
    await step(t0)
    const first = kindsOf(open())
    expect(open()).toHaveLength(4)
    expect(Object.keys(first).sort()).toEqual(['content', 'missing_grant', 'parked_result', 'renewal'])
    expect(first.parked_result!.scope).toBe('reviewed')
    expect(first.content!.scope).toBe('sender')
    expect(first.missing_grant!.scope).toBe('mailer')
    expect(first.renewal!.scope).toBe(grantId)

    // 2. Remind: each of the four.
    await step(t0 + HOUR)
    for (const a of Object.values(first)) expect(byId(a.id).events.map((e) => e.event)).toContain('reminder')

    // 3. Supersede: mailer's proposal moves, and the grant is renewed the way `warpline renew` does it.
    const pluginsDir = rootWithChangedMailer()
    const read = await gate.readStandingStore()
    if (!read.readable) throw new Error(`standing grants file unreadable: ${read.cause}`)
    const renewed = gate.renewStanding(read.store, grantId, 'ops', t0 + 90 * MIN, standingRegistry(await loadRegistry(statePath())))
    if ('refused' in renewed) throw new Error(`renew refused: ${renewed.refused.code}`)
    await gate.writeStandingStore(renewed.store)
    await step(t0 + 90 * MIN, { pluginsDir })
    expect(byId(first.missing_grant!.id).state).toBe('superseded')
    expect(byId(first.renewal!.id).state).toBe('superseded')
    const third = kindsOf(open())
    expect(open()).toHaveLength(4)
    expect(third.missing_grant!.id).not.toBe(first.missing_grant!.id)
    expect(third.renewal!.id).not.toBe(first.renewal!.id)
    expect(third.parked_result!.id).toBe(first.parked_result!.id)
    expect(third.content!.id).toBe(first.content!.id)

    // 4. Expire: every Ask open after step 3.
    await step(t0 + 25 * HOUR, { pluginsDir })
    for (const a of Object.values(third)) expect(byId(a.id).state).toBe('expired')
  })

  test('an advance with nothing due sends no message', async () => {
    const stub = await notifyStub(home, 'ok')
    setNotify(prefsPath(), { argv: stub.argv })

    await advance(T0)
    expect(stub.invocations()).toBe(1)
    expect(asks()!.asks[0]!.tries.map((t) => t.outcome)).toEqual(['delivered'])

    await advance(T0 + 10 * MIN)
    expect(stub.invocations()).toBe(1)
  })
})

// -- Delivery that outlives a broken notify -------------------------------------

/** The bin entry, the path a scheduler runs. */
const ENTRY = testFixturesDir(import.meta.url, '../../bin/warpline.ts')

/** Poll until `check` holds, or throw after `ms`. */
async function until(check: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  }
}

/**
 * Each case drives `warpline advance` in process over `makeVerbHome()`: `p` is
 * skipped for want of a Grant and `sender` waits on content `builder` made, so
 * every advance holds two decisions. The exit code a broken `notify` must not
 * move is read off a twin home that has no `notify` at all.
 */
describe('delivery outlives a broken notify', () => {
  // Three tries with their waits run past bun's own 5 s default, which a run
  // of several files was seen to apply despite the preload's 20 s, so the
  // cases that wait on tries carry their own.
  const SLOW = 30_000
  let vh: VerbHome
  const vhPrefs = (): string => join(vh.home, 'preferences.json')
  const vhAsksFile = (): string => join(vh.home, 'state', 'asks.json')
  const vhAsks = (): StoredAsk[] =>
    existsSync(vhAsksFile()) ? (JSON.parse(readFileSync(vhAsksFile(), 'utf-8')) as { asks: StoredAsk[] }).asks : []
  const vhOpen = (): StoredAsk[] => vhAsks().filter((a) => a.state === 'open')
  const lines = (stderr: string, needle: string): string[] => stderr.split('\n').filter((l) => l.includes(needle))

  /** Point the home and the board's paths at `h`, so the verbs and the advance read one home. */
  const use = (h: VerbHome): void => {
    _setHome(h.home)
    _setPaths(null)
  }

  /** The exit code the same advance gives with `notify` unset, off a fresh twin home. */
  async function twinExit(): Promise<number> {
    const twin = makeVerbHome()
    try {
      use(twin)
      return (await capture(['advance'])).code
    } finally {
      twin.cleanup()
      use(vh)
    }
  }

  beforeEach(() => {
    vh = makeVerbHome()
    use(vh)
  })

  afterEach(() => {
    restoreSpies()
    vh.cleanup()
  })

  test('a notify that always fails leaves every try on the Ask, one stderr line naming it, and the exit code a run without notify gives', async () => {
    const baseline = await twinExit()
    const stub = await notifyStub(vh.home, 'fail', { exitCode: 3 })
    setNotify(vhPrefs(), { argv: stub.argv })

    const { code, stdout, stderr } = await capture(['advance'])

    expect(code).toBe(baseline)
    expect(stub.invocations()).toBe(3)
    const open = vhOpen()
    expect(open.map((a) => a.scope).sort()).toEqual(['p', 'sender'])
    for (const a of open) {
      expect(a.tries.map(({ seq, outcome, exit_code }) => ({ seq, outcome, exit_code }))).toEqual([
        { seq: 1, outcome: 'failed', exit_code: 3 },
        { seq: 1, outcome: 'failed', exit_code: 3 },
        { seq: 1, outcome: 'failed', exit_code: 3 },
      ])
    }
    const said = stderr.split('\n').filter((l) => l.startsWith('warpline advance: notify did not deliver Ask'))
    expect(said).toHaveLength(1)
    for (const a of open) {
      expect(said[0]).toContain(a.id)
      expect(stdout).not.toContain(a.id)
    }
  }, SLOW)

  test('the next advance sends the undelivered Ask again with the same id and seq', async () => {
    const failing = await notifyStub(vh.home, 'fail', { exitCode: 3 })
    setNotify(vhPrefs(), { argv: failing.argv })
    await capture(['advance'])
    const ids = vhOpen()
      .map((a) => a.id)
      .sort()
    expect(ids).toHaveLength(2)

    const ok = await notifyStub(vh.home, 'ok')
    setNotify(vhPrefs(), { argv: ok.argv })
    await capture(['advance'])

    const messages = ok.messages() as Array<{ entries: Array<{ id: string; seq: number }> }>
    expect(messages).toHaveLength(1)
    expect(messages[0]!.entries.map((e) => e.id).sort()).toEqual(ids)
    for (const e of messages[0]!.entries) expect(e.seq).toBe(1)
    for (const a of vhAsks().filter((x) => ids.includes(x.id))) expect(a.tries.at(-1)!.outcome).toBe('delivered')
  }, SLOW)

  test('an Ask recorded and never sent is sent by the next advance', async () => {
    const ok = await notifyStub(vh.home, 'ok')
    setNotify(vhPrefs(), { argv: ok.argv })
    await capture(['advance'])
    expect(ok.messages()).toHaveLength(1)

    // What a process killed between record and send leaves: the Asks, no try.
    const file = JSON.parse(readFileSync(vhAsksFile(), 'utf-8')) as { asks: StoredAsk[] }
    for (const a of file.asks) a.tries = []
    writeFileSync(vhAsksFile(), JSON.stringify(file))
    const ids = file.asks.map((a) => a.id).sort()

    await capture(['advance'])

    const messages = ok.messages() as Array<{ entries: Array<{ id: string; seq: number }> }>
    expect(messages).toHaveLength(2)
    expect(messages[1]!.entries.map((e) => e.id).sort()).toEqual(ids)
    for (const e of messages[1]!.entries) expect(e.seq).toBe(1)
  })

  test('a hanging notify never holds the state lock against approve', async () => {
    const stub = await notifyStub(vh.home, 'hang')
    setNotify(vhPrefs(), { argv: stub.argv, timeout_ms: 1500 })

    // The library call, so no output capture is installed while approve's runs.
    const advancing = runAdvance()
    await until(() => existsSync(stub.startedPath), 5000, 'notify to start')

    const started = Date.now()
    const approved = await capture(['approve', 'builder'])
    const took = Date.now() - started

    expect(approved.code).toBe(0)
    expect(took).toBeLessThan(1000)
    await advancing
    const tried = vhAsks().filter((a) => a.tries.length > 0)
    expect(tried.length).toBeGreaterThan(0)
    for (const a of tried) expect(a.tries[0]).toMatchObject({ outcome: 'timeout', exit_code: null })
  }, SLOW)

  test('an interrupted advance takes its notify down with it', async () => {
    const stub = await notifyStub(vh.home, 'hang', { grandchild: true })
    setNotify(vhPrefs(), { argv: stub.argv, timeout_ms: 60000 })

    // An explicit env: a bun child spawned with the default one sees this process's env as it started.
    const child = spawn(process.execPath, [ENTRY, 'advance'], {
      env: { WARPLINE_HOME: vh.home, PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
      stdio: 'ignore',
    })
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      child.on('exit', (code, signal) => resolve({ code, signal }))
    })
    await until(() => existsSync(stub.startedPath), 15000, 'notify to start')

    child.kill('SIGTERM')
    const { code, signal } = await exited

    expect(signal).toBeNull()
    expect(code).toBe(130)
    const alive = (): boolean => spawnSync('pgrep', ['-f', `sleep ${stub.marker}`]).status !== 1
    await until(() => !alive(), 3000, 'the notify group to go').catch(() => {})
    expect(spawnSync('pgrep', ['-f', `sleep ${stub.marker}`]).status).toBe(1)
  }, SLOW)

  test('an unusable notify block raises and sends nothing, says so once, and keeps the exit code', async () => {
    const baseline = await twinExit()
    setNotify(vhPrefs(), { argv: [] })

    const { code, stdout, stderr } = await capture(['advance'])

    expect(code).toBe(baseline)
    expect(lines(stderr, 'notify.argv')).toHaveLength(1)
    expect(stdout).not.toContain('notify.argv')
    expect(existsSync(vhAsksFile())).toBe(false)
    expect(auditRecords(vh.home, 'preferences.observed').length).toBeGreaterThan(0)
  })

  test('an unreadable asks.json raises and sends nothing, says so naming the file, and keeps the exit code', async () => {
    const baseline = await twinExit()
    const stub = await notifyStub(vh.home, 'ok')
    setNotify(vhPrefs(), { argv: stub.argv })
    writeFileSync(vhAsksFile(), '{')

    const { code, stderr } = await capture(['advance'])

    expect(code).toBe(baseline)
    const said = lines(stderr, vhAsksFile())
    expect(said).toHaveLength(1)
    expect(said[0]).toContain('corrupt')
    expect(readFileSync(vhAsksFile(), 'utf-8')).toBe('{')
    expect(stub.invocations()).toBe(0)
  })

  test('an ask.raised the store refuses is not raised or sent, and the run says so with its exit code unchanged', async () => {
    const baseline = await twinExit()
    const stub = await notifyStub(vh.home, 'ok')
    setNotify(vhPrefs(), { argv: stub.argv })
    const spy = failAppendOnce('ask.raised')

    const { code, stderr } = await capture(['advance'])

    expect(spy.trips()).toBe(1)
    expect(code).toBe(baseline)
    expect(code).not.toBe(70)
    // Two decisions, one refused: one Ask stored, and only it sent.
    const stored = vhAsks()
    expect(stored).toHaveLength(1)
    expect(auditRecords(vh.home, 'ask.raised').map((r) => r.id)).toEqual([stored[0]!.id])
    const messages = stub.messages() as Array<{ entries: Array<{ id: string }> }>
    expect(messages.flatMap((m) => m.entries.map((e) => e.id))).toEqual([stored[0]!.id])
    expect(lines(stderr, 'the audit store could not record')).toHaveLength(1)
    expect(lines(stderr, 'Ask')).toHaveLength(1)
  })
})
