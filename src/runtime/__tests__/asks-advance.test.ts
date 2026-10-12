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
 * The second describe adds the other three kinds. `builder` emits one inline
 * Output, `sender` is a content-class consumer of it, and `reviewed` is a
 * supervised session-class plugin holding a session grant, so it runs and
 * parks. Their sentinels are drawn per case at run time, so no source file in
 * the repository holds one.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _setHome } from '../../lib/paths.js'
import { loadRegistry } from '../../lib/principals.js'
import { _getPaths, _setPaths, pathsForStateFile } from '../../board/state-manager.js'
import { denialFingerprint, proposalFingerprint, runAdvance, type AdvanceOptions } from '../engine.js'
import { readEngineState } from '../engine-state-store.js'
import * as gate from '../approval-gate.js'
import type { PluginManifest } from '../../schemas/plugin-manifest.js'
import { capture } from '../../cli/__tests__/helpers/verb-home.js'
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

/** Every `warpline.audit.<kind>` line under `<home>/audit/`, segments in name order. */
function auditOf(kind: string): Line[] {
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
    .filter((l) => l.type === `warpline.audit.${kind}`)
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

  type Principal = { id: string; type: 'human' | 'machine'; status: 'active' | 'disabled' }

  async function seedRegistry(): Promise<void> {
    const principals: Principal[] = [
      { id: 'ops', type: 'human', status: 'active' },
      { id: 'ci', type: 'machine', status: 'active' },
    ]
    writeFileSync(join(home, 'principals.json'), JSON.stringify({ principals }))
    expect('refused' in (await loadRegistry(statePath()))).toBe(false)
  }

  /** A standing grant held by `ci`, issued by `ops`, over `mailer`, through the gate's own writer. Returns its id. */
  async function issueGrant(issuedAt: number, periodMs: number, hardMaxMs: number): Promise<string> {
    const read = await gate.readStandingStore()
    if (!read.readable) throw new Error(`standing grants file unreadable: ${read.cause}`)
    const id = gate.newStandingId()
    const next = gate.issueStanding(
      read.store,
      { id, holder: 'ci', issuer: 'ops', scopes: ['mailer'], periodMs, hardMaxMs },
      issuedAt,
    )
    if ('refused' in next) throw new Error(`issue refused: ${next.refused.code}`)
    await gate.writeStandingStore(next.store)
    return id
  }

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
