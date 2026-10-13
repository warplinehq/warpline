/**
 * Every Ask an advance raises is answered by its own nonce through the verb for
 * its kind. Temp homes only (AGENTS.md Rule 2).
 *
 * The few helpers below are copied from answer.test.ts on purpose: that file's
 * quick run already sits at its 60 s budget, so this table lives here.
 *
 * Every case starts from `makeVerbHome()` after one advance with an `ok` notify
 * stub, which leaves a missing-Grant Ask on `p` and a content Ask on `sender`.
 * The dead-gate rows add a fourth plugin, `q`, with a 2 h TTL and a dependency
 * on `builder`, because `p` can neither pass its TTL inside the 23-hour floor
 * nor have a dependency move.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { liveGrantScopes } from '../../runtime/approval-gate.js'
import { sessionApprovalPath } from '../../lib/paths.js'
import { renewalDigest } from '../../lib/asks.js'
import { notifyStub, setNotify } from '../../../test-utils/notify-stub.js'
import {
  auditRecords,
  capture,
  failAppendOnce,
  makeVerbHome,
  restoreSpies,
  seedPrincipals,
  snapshotHome,
  type VerbHome,
} from './helpers/verb-home.js'

/** A case that runs more than one advance. */
const SLOW = 30_000

/** `p`'s handler: a successful result, so a run under a Grant parks for review. */
const P_HANDLER = `export async function handler() {
  return {
    status: 'success',
    phases_completed: ['file'],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: 'filed',
    artifacts_produced: [],
    schema_version: 1,
  }
}
`

/** `q`'s handler: the same result, carrying the `note` Output its manifest declares. */
const Q_HANDLER = `export async function handler() {
  return {
    status: 'success',
    phases_completed: ['file'],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: 'filed',
    artifacts_produced: [{ type: 'note', format: 'text', body: 'q note' }],
    schema_version: 1,
  }
}
`

type StoredAsk = {
  id: string
  nonce: string
  kind: string
  scope: string
  plugin: string | null
  digest: string
  state: string
  answer: string | null
}

type Gate = Record<string, unknown> & { plugin: string; run_id: string; applied_at: string | null }
type StateDoc = {
  plugin_runs: Record<string, Record<string, unknown>>
  pending_gates: Gate[]
  approvals: Record<string, { fingerprint: string }>
}

let vh: VerbHome

const asksFile = (): string => join(vh.home, 'state', 'asks.json')

function storedAsks(): StoredAsk[] {
  return (JSON.parse(readFileSync(asksFile(), 'utf-8')) as { asks: StoredAsk[] }).asks
}

/** The one open Ask on `scope`, which must exist. */
function askFor(scope: string): StoredAsk {
  const found = storedAsks().filter((a) => a.state === 'open' && a.scope === scope)
  expect(found).toHaveLength(1)
  return found[0]!
}

/** The stored Ask with this id, in whatever state it is now. */
const askById = (id: string): StoredAsk => storedAsks().find((a) => a.id === id)!

/** An Ask's digest prefix as an Answer types it: the first 12 hex. */
const prefix = (ask: StoredAsk): string => ask.digest.slice(0, 12)

async function ok(argv: string[]): Promise<{ stdout: string; stderr: string }> {
  const r = await capture(argv)
  if (r.code !== 0) throw new Error(`${argv.join(' ')} exited ${r.code}: ${r.stderr}`)
  return r
}

/** The scopes the session Grant holds live now. */
const grantedScopes = async (): Promise<string[]> =>
  (await liveGrantScopes(sessionApprovalPath(), Date.now())).map((w) => w.scope)

const readState = (): StateDoc => JSON.parse(readFileSync(vh.statePath, 'utf-8')) as StateDoc

/** Rewrite the raw state document through `fn`. */
function editState(fn: (doc: StateDoc) => void): void {
  const doc = readState()
  fn(doc)
  writeFileSync(vh.statePath, JSON.stringify(doc))
}

/** The gate notices the board holds for `plugin`, each as its metadata. */
function gateNotices(plugin: string): Record<string, unknown>[] {
  const file = join(vh.home, 'state', 'events.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(JSON.parse(l).metadata_json ?? '{}') as Record<string, unknown>)
    .filter((m) => m.plugin === plugin && (m.event === 'gate_expired' || m.event === 'gate_invalidated'))
}

const standingFile = (): string => join(vh.home, 'standing-grants.json')
/** The one standing grant the home holds, as stored. */
const storedGrant = (): Parameters<typeof renewalDigest>[0] =>
  (JSON.parse(readFileSync(standingFile(), 'utf-8')) as { grants: Parameters<typeof renewalDigest>[0][] }).grants[0]!
const standingId = (): string => storedGrant().id

/**
 * A standing grant for `ci` over `p`, due for renewal within the 23 hours an
 * Ask can live, and the renewal Ask the next advance raises for it.
 */
async function openRenewal(): Promise<StoredAsk> {
  await ok(['approve', 'p', '--holder', 'ci', '--principal', 'ops', '--standing', '--period', '12h', '--hard-max', '30d'])
  await ok(['advance'])
  const ask = askFor(standingId())
  expect(ask.kind).toBe('renewal')
  return ask
}

const answerApprove = (plugin: string, ask: StoredAsk, extra: string[] = []): string[] => [
  'approve',
  plugin,
  '--nonce',
  ask.nonce,
  '--digest',
  prefix(ask),
  '--principal',
  'ops',
  ...extra,
]

/** `q`: `p`'s manifest with every field spelled out, a 2 h TTL, a dependency on `builder` and a `note` Output. */
function writeQ(): void {
  const text = readFileSync(join(vh.home, 'plugins', 'p', 'manifest.ts'), 'utf-8')
  const base = JSON.parse(text.slice(text.indexOf('export const manifest = ') + 'export const manifest = '.length)) as Record<
    string,
    unknown
  >
  const q = {
    ...base,
    name: 'q',
    description: 'q fixture plugin',
    ttl_hours: 2,
    dependencies: ['builder'],
    outputs: { note: { type: 'text' } },
  }
  const dir = join(vh.home, 'plugins', 'q')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'manifest.ts'), `export const manifest = ${JSON.stringify(q)}`)
  writeFileSync(join(dir, 'handler.ts'), Q_HANDLER)
}

const qGate = (doc: StateDoc): Gate => doc.pending_gates.find((g) => g.plugin === 'q')!
const earlier = (at: unknown): string => new Date(Date.parse(at as string) - 3 * 60 * 60 * 1000).toISOString()

type Kill = 'ttl' | 'superseded' | 'dependency'

/** The three ways a parked gate on `q` stops being applicable, as the engine rows make them. */
const KILLS: Record<Kill, (doc: StateDoc) => void> = {
  // Three hours pass for every plugin, so no dependency moves and only the TTL kills the gate.
  ttl: (doc) => {
    for (const run of Object.values(doc.plugin_runs)) run.last_run_at = earlier(run.last_run_at)
    const g = qGate(doc)
    for (const key of ['run_started_at', 'run_completed_at', 'created_at']) g[key] = earlier(g[key])
  },
  // The record a later run of `q` leaves when it failed: a failed run parks nothing.
  superseded: (doc) => {
    doc.plugin_runs.q!.run_id = `${qGate(doc).run_id}-later`
    doc.plugin_runs.q!.status = 'failed'
  },
  dependency: (doc) => {
    doc.plugin_runs.builder!.last_run_at = new Date().toISOString()
  },
}

/**
 * `q` parks a result under a Grant, the Grant is revoked, the gate is killed,
 * and one advance raises the missing-Grant Ask beside the dead gate.
 */
async function parkQThenKill(kill: Kill): Promise<{ ask: StoredAsk; gate: Gate; run: Record<string, unknown> }> {
  writeQ()
  await ok(['advance'])
  const grant = askFor('q')
  expect(grant.kind).toBe('missing_grant')
  await ok(answerApprove('q', grant))
  await ok(['advance'])
  expect(askFor('q').kind).toBe('parked_result')
  await ok(['revoke'])
  editState(KILLS[kill])
  const adv = await ok(['advance'])
  expect(adv.stdout).toContain('Pending gates: 0')
  const ask = askFor('q')
  expect(ask.kind).toBe('missing_grant')
  const gates = readState().pending_gates.filter((g) => g.plugin === 'q' && g.applied_at === null)
  expect(gates).toHaveLength(1)
  const run = readState().plugin_runs.q!
  expect(run.last_output).toBeDefined()
  return { ask, gate: gates[0]!, run }
}

beforeEach(async () => {
  vh = makeVerbHome()
  await seedPrincipals([
    ['ops', 'human'],
    ['ci', 'machine'],
  ])
  writeFileSync(join(vh.home, 'plugins', 'p', 'handler.ts'), P_HANDLER)
  const stub = await notifyStub(vh.home, 'ok')
  setNotify(join(vh.home, 'preferences.json'), { argv: stub.argv })
  await ok(['advance'])
})

afterEach(() => {
  restoreSpies()
  vh.cleanup()
})

interface Row {
  label: string
  kind: string
  answer: string
  run: () => Promise<{ code: number; ask: StoredAsk }>
}

/** A dead-gate row: the Answer drops the gate, keeps the run record, grants, and `q` runs again. */
function deadGateRow(label: string, kill: Kill, reason: string, event: string, via: string[]): Row {
  return {
    label,
    kind: 'missing_grant',
    answer: 'approve',
    run: async () => {
      const { ask, gate, run } = await parkQThenKill(kill)
      const r = await capture(answerApprove('q', ask, via))
      // The stderr rides along, so a refusal shows its reason.
      expect({ code: r.code, stderr: r.stderr }).toMatchObject({ code: 0 })
      expect(r.stdout).toContain(`Discarded the parked result for q from run ${gate.run_id}`)
      expect(await grantedScopes()).toContain('q')
      expect(readState().pending_gates.filter((g) => g.plugin === 'q')).toEqual([])
      expect(readState().plugin_runs.q).toEqual(run)
      expect(gateNotices('q')).toEqual([{ event, plugin: 'q', run_id: gate.run_id, reason }])
      if (via.length > 0) expect(auditRecords(vh.home, 'ask.answered').at(-1)!.via).toBe('ci')

      await ok(['advance'])
      const next = askFor('q')
      expect(next.kind).toBe('parked_result')
      expect(next.id).not.toBe(ask.id)
      return { code: r.code, ask }
    },
  }
}

const ROWS: Row[] = [
  {
    label: 'missing_grant with no gate, through approve',
    kind: 'missing_grant',
    answer: 'approve',
    run: async () => {
      const ask = askFor('p')
      expect(ask.kind).toBe('missing_grant')
      const r = await capture(answerApprove('p', ask))
      expect(await grantedScopes()).toContain('p')
      return { code: r.code, ask }
    },
  },
  {
    label: 'parked_result on a gate it can still apply, through approve',
    kind: 'parked_result',
    answer: 'approve',
    run: async () => {
      await ok(answerApprove('p', askFor('p')))
      await ok(['advance'])
      const ask = askFor('p')
      expect(ask.kind).toBe('parked_result')
      const r = await capture(answerApprove('p', ask))
      expect(r.stdout).toContain('Applied the parked result for p')
      expect(readState().pending_gates.find((g) => g.plugin === 'p')!.applied_at).not.toBeNull()
      return { code: r.code, ask }
    },
  },
  {
    label: 'content, through approve --content',
    kind: 'content',
    answer: 'approve_content',
    run: async () => {
      const ask = askFor('sender')
      expect(ask.kind).toBe('content')
      const r = await capture(answerApprove('sender', ask, ['--content', '--not-after', '2099-01-01T00:00']))
      expect(readState().approvals.sender!.fingerprint).toBe(ask.digest)
      expect(auditRecords(vh.home, 'content_approval.issued')).toHaveLength(1)
      return { code: r.code, ask }
    },
  },
  {
    label: 'renewal, through renew',
    kind: 'renewal',
    answer: 'renew',
    run: async () => {
      const ask = await openRenewal()
      const before = storedGrant()
      expect(renewalDigest(before)).toBe(ask.digest)
      const r = await capture(['renew', standingId(), '--nonce', ask.nonce, '--digest', prefix(ask), '--principal', 'ops'])
      expect(auditRecords(vh.home, 'grant.renewed')).toHaveLength(1)
      expect(storedGrant().period_start).not.toBe(before.period_start)
      return { code: r.code, ask }
    },
  },
  deadGateRow(
    'missing_grant beside a gate past its plugin TTL, through approve',
    'ttl',
    'expired',
    'gate_expired',
    ['--via', 'ci'],
  ),
  deadGateRow(
    'missing_grant beside a gate a later run superseded, through approve',
    'superseded',
    'superseded',
    'gate_invalidated',
    [],
  ),
  deadGateRow(
    'missing_grant beside a gate whose dependency re-ran, through approve',
    'dependency',
    'dependency_moved',
    'gate_invalidated',
    [],
  ),
]

describe('every Ask an advance raises is answered by its own nonce through the verb for its kind', () => {
  for (const row of ROWS) {
    test(
      row.label,
      async () => {
        const { code, ask } = await row.run()
        expect(code).toBe(0)
        expect(askById(ask.id)).toMatchObject({ state: 'answered', answer: row.answer })
        expect(auditRecords(vh.home, 'ask.answered').at(-1)).toMatchObject({ id: ask.id, kind: row.kind, digest: ask.digest })
      },
      SLOW,
    )
  }
})

describe('the bare form beside a gate it cannot apply', () => {
  test(
    'a bare approve beside a gate it cannot apply refuses while the missing-Grant Ask is open, and writes nothing',
    async () => {
      const { ask } = await parkQThenKill('ttl')
      const before = await snapshotHome(vh.home)
      const r = await capture(['approve', 'q'])
      expect(r.code).toBe(1)
      expect(r.stderr).toContain(ask.id)
      expect(r.stderr).toContain(`warpline approvals show ${ask.id}`)
      expect(r.stderr).not.toContain(ask.nonce)
      expect(await snapshotHome(vh.home)).toEqual(before)
    },
    SLOW,
  )
})

describe('an Answer beside a gate it cannot apply is on the record before the gate is dropped', () => {
  test(
    'a refused ask.answered beside a gate it cannot apply refuses the Answer, drops no gate and writes nothing',
    async () => {
      const { ask } = await parkQThenKill('ttl')
      const before = await snapshotHome(vh.home)
      // The Answer is on the record before its effect, the dead gate's drop included, so a refused record leaves the gate, the board and the state as they were.
      const fail = failAppendOnce('ask.answered')
      const r = await capture(answerApprove('q', ask))
      expect(fail.trips()).toBe(1)
      expect(r.code).not.toBe(0)
      expect(r.stdout).not.toContain('Discarded the parked result for q')
      expect(await snapshotHome(vh.home)).toEqual(before)
    },
    SLOW,
  )
})
