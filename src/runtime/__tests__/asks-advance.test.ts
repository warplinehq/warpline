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
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _setHome } from '../../lib/paths.js'
import { _getPaths, _setPaths, pathsForStateFile } from '../../board/state-manager.js'
import { denialFingerprint, runAdvance, type AdvanceOptions } from '../engine.js'
import { notifyStub, setNotify } from '../../../test-utils/notify-stub.js'

const REAL_PATHS = _getPaths()
const HOUR = 60 * 60 * 1000
const T0 = Date.parse('2026-10-11T08:00:00.000Z')

let home: string

const statePath = (): string => join(home, 'state', 'engine-state.json')
const prefsPath = (): string => join(home, 'state', 'preferences.json')
const eventsPath = (): string => join(home, 'runs', 'events.jsonl')
const asksFile = (): string => join(home, 'state', 'asks.json')

/** A session-class plugin that declares a side effect and would succeed if it ran. */
function writePlugin(name: string): void {
  const dir = join(home, 'plugins', name)
  mkdirSync(dir, { recursive: true })
  const manifest = {
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
  }
  writeFileSync(join(dir, 'manifest.ts'), `export const manifest = ${JSON.stringify(manifest)}`)
  writeFileSync(
    join(dir, 'handler.ts'),
    `export async function handler(_manifest, _args) {
  return {
    status: 'success',
    phases_completed: [],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: 'fixture ok',
    artifacts_produced: [],
    schema_version: 1,
  }
}
`,
  )
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
