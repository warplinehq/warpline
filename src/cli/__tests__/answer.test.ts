/**
 * The Answer verbs: an Answer comes back through `approve` bound to its Ask's
 * nonce and digest, and says who answered, through what, on what evidence and
 * how long it took. Temp homes only (AGENTS.md Rule 2).
 *
 * Every case starts from one home holding two open Asks, both raised by a real
 * advance with an `ok` notify stub: a missing-Grant Ask on `p` and a content
 * Ask on `sender`. `p` gets a handler before that advance, so once it holds a
 * Grant it runs and parks.
 *
 * `FORMS` is the one fixture table the Answer tests share: each entry opens an
 * Ask of its kind and says how that form is typed bare and as an Answer. The
 * unreadable-store table is built from it, one row per form and per typing.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { liveGrantScopes, readStandingStore, renewStanding, writeStandingStore } from '../../runtime/approval-gate.js'
import { runAdvance } from '../../runtime/engine.js'
import { readAsks, writeAsks, type Ask, type AskAnswer } from '../../lib/asks.js'
import { sessionApprovalPath } from '../../lib/paths.js'
import { readRegistry, standingRegistry } from '../../lib/principals.js'
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

type StoredAsk = {
  id: string
  nonce: string
  kind: string
  scope: string
  plugin: string | null
  digest: string
  raised_at: string
  expires_at: string
  state: string
  closed_at: string | null
  answer: string | null
  tries: Array<{ seq: number; outcome: string }>
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

/** Rewrite the stored Ask with this id, the way a later clock or an advance would leave it. */
function rewriteAsk(id: string, patch: Partial<StoredAsk>): void {
  const store = JSON.parse(readFileSync(asksFile(), 'utf-8')) as { asks: StoredAsk[] }
  store.asks = store.asks.map((a) => (a.id === id ? { ...a, ...patch } : a))
  writeFileSync(asksFile(), JSON.stringify(store))
}

/** The stored Ask with this id, in whatever state it is now. */
const askById = (id: string): StoredAsk => storedAsks().find((a) => a.id === id)!

/** An Ask's digest prefix as an Answer types it: the first 12 hex. */
const prefix = (ask: StoredAsk): string => ask.digest.slice(0, 12)

const snap = (): Promise<string[]> => snapshotHome(vh.home)

/**
 * Give `p` a second side effect, so its live proposal digest moves. A manifest
 * is imported once per path in a process, so the moved copy lives in a fresh
 * plugin root that `WARPLINE_PLUGINS_DIR` points every later verb at.
 */
function moveP(): void {
  const root = join(vh.home, `plugins-moved-${randomBytes(4).toString('hex')}`)
  cpSync(join(vh.home, 'plugins'), root, { recursive: true })
  const file = join(root, 'p', 'manifest.ts')
  const text = readFileSync(file, 'utf-8')
  const moved = text.replace('"side_effects":["creates_issue"]', '"side_effects":["creates_issue","sends_email"]')
  expect(moved).not.toBe(text)
  writeFileSync(file, moved)
  process.env.WARPLINE_PLUGINS_DIR = root
}

async function ok(argv: string[]): Promise<{ stdout: string; stderr: string }> {
  const r = await capture(argv)
  if (r.code !== 0) throw new Error(`${argv.join(' ')} exited ${r.code}: ${r.stderr}`)
  return r
}

/** The account name `ask.answered.os_user` is expected to carry. */
function expectedOsUser(): string {
  try {
    const name = userInfo().username
    return /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/.test(name) ? name : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** The handler file and an `ok` notify stub, set on a home before its first advance. */
async function prepare(home: string, withNotify: boolean): Promise<void> {
  writeFileSync(join(home, 'plugins', 'p', 'handler.ts'), P_HANDLER)
  if (withNotify) {
    const stub = await notifyStub(home, 'ok')
    setNotify(join(home, 'preferences.json'), { argv: stub.argv })
  }
}

interface Form {
  label: string
  /** Leaves the home with an open Ask of this form's kind, and returns it. */
  open: () => Promise<StoredAsk>
  /** The form typed with no Answer flags, or null when it has no bare form. */
  bare: (() => string[]) | null
  /** The form typed as an Answer, carrying `--principal ops`. */
  answer: (nonce: string, digestPrefix: string) => string[]
  /** The `answer` its `ask.answered` records. */
  recorded: AskAnswer
}

const CONTENT_WINDOW = ['--not-after', '2099-01-01T00:00']

/** The id of the one standing grant the home holds. */
const standingId = (): string =>
  (JSON.parse(readFileSync(join(vh.home, 'standing-grants.json'), 'utf-8')) as { grants: { id: string }[] }).grants[0]!.id

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

const FORMS: Form[] = [
  {
    label: 'approve p',
    open: async () => askFor('p'),
    bare: () => ['approve', 'p'],
    answer: (nonce, digest) => ['approve', 'p', '--nonce', nonce, '--digest', digest, '--principal', 'ops'],
    recorded: 'approve',
  },
  {
    label: 'approve p on a parked result',
    open: async () => {
      const grant = askFor('p')
      await ok(FORMS[0]!.answer(grant.nonce, prefix(grant)))
      await ok(['advance'])
      const parked = askFor('p')
      expect(parked.kind).toBe('parked_result')
      return parked
    },
    bare: () => ['approve', 'p'],
    answer: (nonce, digest) => ['approve', 'p', '--nonce', nonce, '--digest', digest, '--principal', 'ops'],
    recorded: 'approve',
  },
  {
    label: 'approve sender --content',
    open: async () => askFor('sender'),
    bare: () => ['approve', 'sender', '--content', ...CONTENT_WINDOW],
    answer: (nonce, digest) => [
      'approve',
      'sender',
      '--content',
      ...CONTENT_WINDOW,
      '--nonce',
      nonce,
      '--digest',
      digest,
      '--principal',
      'ops',
    ],
    recorded: 'approve_content',
  },
  {
    label: 'deny p',
    open: async () => askFor('p'),
    bare: () => ['deny', 'p'],
    answer: (nonce, digest) => ['deny', 'p', '--nonce', nonce, '--digest', digest, '--principal', 'ops'],
    recorded: 'deny',
  },
  {
    label: 'deny --standing',
    open: openRenewal,
    // It answers an Ask and does nothing else, so it has no bare form.
    bare: null,
    answer: (nonce, digest) => [
      'deny',
      '--standing',
      standingId(),
      '--nonce',
      nonce,
      '--digest',
      digest,
      '--principal',
      'ops',
    ],
    recorded: 'deny',
  },
  {
    label: 'renew',
    open: openRenewal,
    // renew always names its human, so the bare form carries --principal too.
    bare: () => ['renew', standingId(), '--principal', 'ops'],
    answer: (nonce, digest) => ['renew', standingId(), '--nonce', nonce, '--digest', digest, '--principal', 'ops'],
    recorded: 'renew',
  },
]

const form = (label: string): Form => FORMS.find((f) => f.label === label)!

/** A fresh home with the principals seeded and the two Asks raised. */
async function setupHome(): Promise<void> {
  vh = makeVerbHome()
  await seedPrincipals([
    ['ops', 'human'],
    ['ann', 'human'],
    ['ci', 'machine'],
    ['bot2', 'machine'],
  ])
  await ok(['principal', 'disable', 'bot2'])
  await prepare(vh.home, true)
  await ok(['advance'])
}

/** Swap the home for a fresh one, for a case that walks several forms from the start. */
async function resetHome(): Promise<void> {
  delete process.env.WARPLINE_PLUGINS_DIR
  vh.cleanup()
  await setupHome()
}

beforeEach(setupHome)

afterEach(() => {
  delete process.env.WARPLINE_PLUGINS_DIR
  restoreSpies()
  vh.cleanup()
})

describe('an Answer through approve is bound to its Ask and says who answered', () => {
  test('approve answers a missing-Grant Ask with its nonce and digest prefix, and the Answer record says who, through what and how long', async () => {
    const ask = askFor('p')
    expect(ask.kind).toBe('missing_grant')

    const r = await capture(['approve', 'p', '--nonce', ask.nonce, '--digest', prefix(ask), '--principal', 'ops'])
    expect(r.code).toBe(0)

    const after = askById(ask.id)
    expect(after.state).toBe('answered')
    expect(after.answer).toBe('approve')
    expect(after.closed_at).not.toBeNull()

    const answered = auditRecords(vh.home, 'ask.answered')
    expect(answered).toHaveLength(1)
    expect(answered[0]).toEqual({
      id: ask.id,
      kind: 'missing_grant',
      scope: 'p',
      answer: 'approve',
      digest: ask.digest,
      principal: 'ops',
      via: null,
      os_user: expectedOsUser(),
      evidence: null,
      assurance: 'asserted',
      raised_at: ask.raised_at,
      decide_ms: Date.parse(after.closed_at!) - Date.parse(ask.raised_at),
    })

    // The Answer is on the record before the Grant it lets through.
    const lines = auditRecords(vh.home)
    const answeredSeq = lines.find((l) => l.type === 'warpline.audit.ask.answered')!.warplineseq
    const issued = lines.filter((l) => l.type === 'warpline.audit.grant.issued')
    expect(issued).toHaveLength(1)
    expect(answeredSeq).toBeLessThan(issued[0]!.warplineseq)

    const live = await liveGrantScopes(sessionApprovalPath(), Date.now())
    expect(live.map((w) => w.scope)).toContain('p')
  })

  test(
    'a parked result is answered through approve, and the Answer path takes the principal a bare apply refuses',
    async () => {
      const parked = form('approve p on a parked result')
      const ask = await parked.open()
      const r = await capture(parked.answer(ask.nonce, prefix(ask)))
      expect(r.code).toBe(0)
      expect(r.stdout).toContain('Applied the parked result for p')
      expect(askById(ask.id).state).toBe('answered')
      const answered = auditRecords(vh.home, 'ask.answered')
      expect(answered.map((d) => d.kind)).toEqual(['missing_grant', 'parked_result'])
      expect(answered[1]).toMatchObject({ id: ask.id, answer: 'approve', principal: 'ops', digest: ask.digest })

      // With notify unset no Ask is raised, so a bare apply is today's verb and
      // still refuses --principal.
      vh.cleanup()
      vh = makeVerbHome()
      await prepare(vh.home, false)
      await ok(['approve', 'p'])
      await ok(['advance'])
      const before = await snap()
      const bare = await capture(['approve', 'p', '--principal', 'ops'])
      expect(bare.code).toBe(1)
      expect(bare.stderr).toContain('--principal')
      expect(bare.stderr).toContain('applying a parked result')
      expect(await snap()).toEqual(before)
    },
    SLOW,
  )

  test('content is answered through approve --content', async () => {
    const content = form('approve sender --content')
    const ask = await content.open()
    expect(ask.kind).toBe('content')
    const r = await capture(content.answer(ask.nonce, prefix(ask)))
    expect(r.code).toBe(0)
    expect(askById(ask.id).state).toBe('answered')

    const answered = auditRecords(vh.home, 'ask.answered')
    expect(answered).toHaveLength(1)
    expect(answered[0]).toMatchObject({ id: ask.id, kind: 'content', scope: 'sender', answer: 'approve_content' })

    const lines = auditRecords(vh.home)
    const answeredSeq = lines.find((l) => l.type === 'warpline.audit.ask.answered')!.warplineseq
    const issued = lines.find((l) => l.type === 'warpline.audit.content_approval.issued')!
    expect(answeredSeq).toBeLessThan(issued.warplineseq)
  })

  test('an Answer relayed by a registered machine records it as via', async () => {
    const ask = askFor('p')
    const r = await capture([...form('approve p').answer(ask.nonce, prefix(ask)), '--via', 'ci'])
    expect(r.code).toBe(0)
    expect(auditRecords(vh.home, 'ask.answered')[0]).toMatchObject({ principal: 'ops', via: 'ci' })
  })

  test('a via naming a human, an unregistered id or a disabled principal refuses and writes nothing', async () => {
    const ask = askFor('p')
    const before = await snap()
    for (const via of ['ann', 'nobody', 'bot2']) {
      const r = await capture([...form('approve p').answer(ask.nonce, prefix(ask)), '--via', via])
      expect(r.code).toBe(1)
      expect(r.stderr).toContain('--via')
      expect(r.stderr).not.toContain(ask.nonce)
      expect(await snap()).toEqual(before)
    }
  })

  test('an evidence reference is recorded, and one off the token rule refuses before anything is read', async () => {
    const ask = askFor('p')
    const before = await snap()
    const bad = await capture([...form('approve p').answer(ask.nonce, prefix(ask)), '--evidence', 'has a space'])
    expect(bad.code).toBe(1)
    expect(bad.stderr).toContain('--evidence')
    expect(bad.stderr).not.toContain('has a space')
    expect(await snap()).toEqual(before)

    const r = await capture([...form('approve p').answer(ask.nonce, prefix(ask)), '--evidence', 'OPS-123'])
    expect(r.code).toBe(0)
    expect(auditRecords(vh.home, 'ask.answered')[0]).toMatchObject({ evidence: 'OPS-123' })
  })

  test('the Answer flags are checked before anything is read', async () => {
    const ask = askFor('p')
    const n = ask.nonce
    const d = prefix(ask)
    const cases: Array<{ argv: string[]; names: string }> = [
      { argv: ['approve', 'p', '--nonce', n, '--principal', 'ops'], names: '--digest' },
      { argv: ['approve', 'p', '--digest', d, '--principal', 'ops'], names: '--nonce' },
      { argv: ['approve', 'p', '--via', 'ci', '--principal', 'ops'], names: '--via' },
      { argv: ['approve', 'p', '--evidence', 'OPS-123', '--principal', 'ops'], names: '--evidence' },
      { argv: ['approve', 'p', 'sender', '--nonce', n, '--digest', d, '--principal', 'ops'], names: '--nonce' },
      { argv: ['approve', '--all', '--nonce', n, '--digest', d, '--principal', 'ops'], names: '--all' },
      {
        argv: ['approve', 'p', '--standing', '--holder', 'ci', '--nonce', n, '--digest', d, '--principal', 'ops'],
        names: '--standing',
      },
      {
        argv: ['approve', 'sender', '--content', '--remove', '--nonce', n, '--digest', d, '--principal', 'ops'],
        names: '--remove',
      },
      { argv: ['approve', 'p', '--nonce', n, '--digest', 'zzzzzzzzzzzz', '--principal', 'ops'], names: '--digest' },
      { argv: ['approve', 'p', '--nonce', n, '--digest', d], names: '--principal' },
    ]
    const before = await snap()
    for (const c of cases) {
      const r = await capture(c.argv)
      expect({ argv: c.argv, code: r.code }).toEqual({ argv: c.argv, code: 1 })
      expect(r.stderr).toContain(c.names)
      expect(r.stderr).not.toContain(n)
      expect(await snap()).toEqual(before)
    }
  })

  test('a bare approve refuses while an open Ask covers the plugin, naming the Ask and approvals show, never the nonce', async () => {
    const before = await snap()
    for (const f of [form('approve p'), form('approve sender --content')]) {
      const ask = await f.open()
      const r = await capture(f.bare!())
      expect(r.code).toBe(1)
      expect(r.stderr).toContain(ask.id)
      expect(r.stderr).toContain(`warpline approvals show ${ask.id}`)
      expect(r.stderr).not.toContain(ask.nonce)
      expect(r.stdout).not.toContain(ask.nonce)
      expect(await snap()).toEqual(before)
    }
  })

  test('approve --all is Grant issuance and leaves open Asks open', async () => {
    const r = await capture(['approve', '--all'])
    expect(r.code).toBe(0)
    expect(storedAsks().filter((a) => a.state === 'open').map((a) => a.scope).sort()).toEqual(['p', 'sender'])
    expect(auditRecords(vh.home, 'ask.answered')).toEqual([])
  })

  test('a refused ask.answered refuses the Answer and writes nothing', async () => {
    const ask = askFor('p')
    const before = await snap()
    const fail = failAppendOnce('ask.answered')
    const r = await capture(form('approve p').answer(ask.nonce, prefix(ask)))
    expect(fail.trips()).toBe(1)
    expect(r.code).not.toBe(0)
    expect(await snap()).toEqual(before)
  })

  test('the OS user is recorded beside the principal and never as one', async () => {
    const saved = { USER: process.env.USER, WARPLINE_PRINCIPAL: process.env.WARPLINE_PRINCIPAL }
    process.env.USER = 'ops'
    process.env.WARPLINE_PRINCIPAL = 'ops'
    try {
      const ask = askFor('p')
      const r = await capture(['approve', 'p', '--nonce', ask.nonce, '--digest', prefix(ask), '--principal', 'ann'])
      expect(r.code).toBe(0)
      const answered = auditRecords(vh.home, 'ask.answered')
      expect(answered).toHaveLength(1)
      expect(answered[0]).toMatchObject({ principal: 'ann', os_user: expectedOsUser() })
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })
})

describe('an unreadable asks.json refuses every Answer form, naming the file', () => {
  type Row = { f: Form; mode: 'bare' | 'answering' }
  const UNREADABLE: Row[] = FORMS.flatMap((f) => [
    ...(f.bare === null ? [] : [{ f, mode: 'bare' as const }]),
    { f, mode: 'answering' as const },
  ])

  for (const { f, mode } of UNREADABLE) {
    test(
      `an unreadable asks.json refuses ${f.label} (${mode}), naming the file`,
      async () => {
        const ask = await f.open()
        writeFileSync(asksFile(), '{')
        const before = await snap()
        const r = await capture(mode === 'bare' ? f.bare!() : f.answer(ask.nonce, prefix(ask)))
        expect(r.code).toBe(1)
        expect(r.stderr).toContain('asks.json cannot be read (')
        expect(r.stderr).not.toContain(ask.nonce)
        expect(await snap()).toEqual(before)
      },
      SLOW,
    )
  }
})

type Reason = 'prefix shorter than 12' | 'unknown' | 'superseded' | 'expired' | 'nonce reused' | 'digest mismatch'

/** The text that names `reason` and nothing else: a bare word such as `unknown` could come from any message. */
const marker = (reason: Reason): string =>
  reason === 'prefix shorter than 12' ? 'prefix shorter than 12:' : `refused (${reason})`

/**
 * `argv` exits 1 naming `reason` and never the nonce it presented, and the
 * whole home is byte-identical across the run.
 */
async function refused(argv: string[], reason: Reason): Promise<void> {
  const before = await snap()
  const r = await capture(argv)
  expect({ argv, code: r.code }).toEqual({ argv, code: 1 })
  expect(r.stderr).toContain(marker(reason))
  const at = argv.indexOf('--nonce')
  if (at >= 0) expect(r.stderr).not.toContain(argv[at + 1]!)
  expect(await snap()).toEqual(before)
}

describe('every Answer refusal is named, in its fixed order, and writes nothing', () => {
  test('a digest prefix shorter than 12 refuses as prefix shorter than 12', async () => {
    const ask = askFor('p')
    await refused(form('approve p').answer(ask.nonce, ask.digest.slice(0, 11)), 'prefix shorter than 12')
  })

  test('an upper-case prefix of the right digest is accepted', async () => {
    const ask = askFor('p')
    const r = await capture(form('approve p').answer(ask.nonce, prefix(ask).toUpperCase()))
    expect(r.code).toBe(0)
    expect(askById(ask.id).state).toBe('answered')
  })

  test('a nonce that names no Ask on that scope refuses as unknown', async () => {
    // builder holds no Ask at all.
    expect(storedAsks().filter((a) => a.scope === 'builder')).toEqual([])
    const nonce = randomBytes(16).toString('hex')
    const digest = randomBytes(6).toString('hex')
    await refused(['approve', 'builder', '--nonce', nonce, '--digest', digest, '--principal', 'ops'], 'unknown')
  })

  test(
    'an Answer to a superseded Ask refuses as superseded',
    async () => {
      const old = askFor('p')
      moveP()
      await ok(['advance'])
      expect(askById(old.id).state).toBe('superseded')
      expect(askFor('p').id).not.toBe(old.id)
      await refused(form('approve p').answer(old.nonce, prefix(old)), 'superseded')
    },
    SLOW,
  )

  test('an Answer to an expired Ask refuses as expired, whether or not an advance marked it', async () => {
    const ask = askFor('p')
    const answer = form('approve p').answer(ask.nonce, prefix(ask))

    // Past its expiry, still open: no advance has marked it.
    rewriteAsk(ask.id, { expires_at: new Date(Date.now() - 60_000).toISOString(), state: 'open' })
    await refused(answer, 'expired')

    // Marked expired, its expiry still ahead: the state alone refuses.
    rewriteAsk(ask.id, {
      expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
      state: 'expired',
      closed_at: new Date().toISOString(),
    })
    await refused(answer, 'expired')
  })

  test('a nonce already used refuses as nonce reused', async () => {
    const ask = askFor('p')
    const answer = form('approve p').answer(ask.nonce, prefix(ask))
    await ok(answer)
    expect(askById(ask.id).state).toBe('answered')
    await refused(answer, 'nonce reused')
    expect(auditRecords(vh.home, 'ask.answered')).toHaveLength(1)
  })

  test('a digest that does not match refuses as digest mismatch (a prefix of another digest)', async () => {
    const ask = askFor('p')
    const other = (ask.digest[0] === '0' ? '1' : '0') + ask.digest.slice(1, 12)
    await refused(form('approve p').answer(ask.nonce, other), 'digest mismatch')
  })

  test('a digest that does not match refuses as digest mismatch (the decision moved before any advance)', async () => {
    const ask = askFor('p')
    moveP()
    await refused(form('approve p').answer(ask.nonce, prefix(ask)), 'digest mismatch')
  })

  test('a digest that does not match refuses as digest mismatch (a content Ask through the grant form)', async () => {
    const ask = askFor('sender')
    expect(ask.kind).toBe('content')
    await refused(
      ['approve', 'sender', '--nonce', ask.nonce, '--digest', prefix(ask), '--principal', 'ops'],
      'digest mismatch',
    )
  })

  test('a run that fails two checks names the first in the fixed order', async () => {
    const ask = askFor('p')
    rewriteAsk(ask.id, { expires_at: new Date(Date.now() - 60_000).toISOString() })
    const wrong = (ask.digest[0] === '0' ? '1' : '0') + ask.digest.slice(1, 12)
    await refused(form('approve p').answer(ask.nonce, wrong), 'expired')
  })

  test("the nonce of another scope's open Ask is refused as unknown", async () => {
    const p = askFor('p')
    expect(askFor('sender').nonce).not.toBe(p.nonce)
    for (const argv of [
      form('approve sender --content').answer(p.nonce, prefix(p)),
      ['approve', 'sender', '--nonce', p.nonce, '--digest', prefix(p), '--principal', 'ops'],
    ]) {
      await refused(argv, 'unknown')
    }
    expect(askById(p.id).state).toBe('open')
  })
})

/** The state document's denials, as the file holds them. */
const denials = (): Record<string, unknown> =>
  (JSON.parse(readFileSync(vh.statePath, 'utf-8')) as { denials: Record<string, unknown> }).denials

describe('deny answers an Ask, and costs what approve costs', () => {
  test('deny answers a missing-Grant Ask and records answer deny before the denial', async () => {
    const ask = askFor('p')
    expect(ask.kind).toBe('missing_grant')

    const r = await capture(form('deny p').answer(ask.nonce, prefix(ask)))
    expect(r.code).toBe(0)

    const after = askById(ask.id)
    expect(after.state).toBe('answered')
    expect(after.answer).toBe('deny')

    const answered = auditRecords(vh.home, 'ask.answered')
    expect(answered).toHaveLength(1)
    expect(answered[0]).toMatchObject({ id: ask.id, kind: 'missing_grant', scope: 'p', answer: 'deny', principal: 'ops' })

    const lines = auditRecords(vh.home)
    const answeredSeq = lines.find((l) => l.type === 'warpline.audit.ask.answered')!.warplineseq
    const denied = lines.filter((l) => l.type === 'warpline.audit.denial.recorded')
    expect(denied).toHaveLength(1)
    expect(answeredSeq).toBeLessThan(denied[0]!.warplineseq)
    expect(Object.keys(denials())).toEqual(['p'])
  })

  test("deny answers a content Ask against the producer's digest", async () => {
    const ask = askFor('sender')
    expect(ask.kind).toBe('content')
    const r = await capture(['deny', 'sender', '--nonce', ask.nonce, '--digest', prefix(ask), '--principal', 'ops'])
    expect(r.code).toBe(0)
    expect(askById(ask.id)).toMatchObject({ state: 'answered', answer: 'deny' })
    expect(auditRecords(vh.home, 'ask.answered')[0]).toMatchObject({ kind: 'content', scope: 'sender', answer: 'deny' })
  })

  test(
    'deny answers a parked-result Ask and discards the gate',
    async () => {
      const ask = await form('approve p on a parked result').open()
      const r = await capture(form('deny p').answer(ask.nonce, prefix(ask)))
      expect(r.code).toBe(0)
      expect(r.stdout).toContain('The parked result was discarded')
      expect(askById(ask.id)).toMatchObject({ state: 'answered', answer: 'deny' })
      expect(auditRecords(vh.home, 'ask.answered').at(-1)).toMatchObject({ kind: 'parked_result', answer: 'deny' })
      const state = JSON.parse(readFileSync(vh.statePath, 'utf-8')) as { pending_gates: Array<{ plugin: string }> }
      expect(state.pending_gates.filter((g) => g.plugin === 'p')).toEqual([])
    },
    SLOW,
  )

  test('a bare deny refuses while an open Ask covers the plugin', async () => {
    const ask = askFor('p')
    const before = await snap()
    const r = await capture(form('deny p').bare!())
    expect(r.code).toBe(1)
    expect(r.stderr).toContain(ask.id)
    expect(r.stderr).toContain(`warpline approvals show ${ask.id}`)
    expect(r.stderr).not.toContain(ask.nonce)
    expect(r.stdout).not.toContain(ask.nonce)
    expect(await snap()).toEqual(before)
  })

  test('a reused nonce through deny refuses as nonce reused', async () => {
    const ask = askFor('p')
    const answer = form('deny p').answer(ask.nonce, prefix(ask))
    await ok(answer)
    await refused(answer, 'nonce reused')
    expect(auditRecords(vh.home, 'ask.answered')).toHaveLength(1)
  })
})

describe('renew and deny --standing answer a renewal Ask', () => {
  let ask: StoredAsk
  beforeEach(async () => {
    ask = await openRenewal()
  })

  const standingFile = (): string => join(vh.home, 'standing-grants.json')

  test(
    'renew answers a renewal Ask and records answer renew before the renewal',
    async () => {
      const r = await capture(form('renew').answer(ask.nonce, prefix(ask)))
      expect(r.code).toBe(0)
      expect(askById(ask.id)).toMatchObject({ state: 'answered', answer: 'renew' })
      const answered = auditRecords(vh.home, 'ask.answered')
      expect(answered).toHaveLength(1)
      expect(answered[0]).toMatchObject({ kind: 'renewal', scope: standingId(), answer: 'renew', principal: 'ops' })
      const lines = auditRecords(vh.home)
      const answeredSeq = lines.find((l) => l.type === 'warpline.audit.ask.answered')!.warplineseq
      const renewed = lines.filter((l) => l.type === 'warpline.audit.grant.renewed')
      expect(renewed).toHaveLength(1)
      expect(answeredSeq).toBeLessThan(renewed[0]!.warplineseq)
    },
    SLOW,
  )

  test(
    'a renewal Ask whose grant was renewed since refuses as digest mismatch',
    async () => {
      await Bun.sleep(5)
      const read = await readStandingStore()
      if (!read.readable) throw new Error('standing grants file unreadable')
      const change = renewStanding(read.store, ask.scope, 'ops', Date.now(), standingRegistry(await readRegistry()))
      if ('refused' in change) throw new Error(`renewStanding refused: ${change.refused.code}`)
      await writeStandingStore(change.store)
      await refused(form('renew').answer(ask.nonce, prefix(ask)), 'digest mismatch')
    },
    SLOW,
  )

  test(
    'a nonce used by renew cannot be reused through deny --standing',
    async () => {
      await ok(form('renew').answer(ask.nonce, prefix(ask)))
      await refused(form('deny --standing').answer(ask.nonce, prefix(ask)), 'nonce reused')
    },
    SLOW,
  )

  test(
    'a bare renew refuses while an open renewal Ask covers the grant',
    async () => {
      const before = await snap()
      const r = await capture(form('renew').bare!())
      expect(r.code).toBe(1)
      expect(r.stderr).toContain(ask.id)
      expect(r.stderr).toContain(`warpline approvals show ${ask.id}`)
      expect(r.stderr).not.toContain(ask.nonce)
      expect(await snap()).toEqual(before)
    },
    SLOW,
  )

  test(
    "renew's Answer still needs an active human, and its via an active machine",
    async () => {
      const id = standingId()
      const base = ['renew', id, '--nonce', ask.nonce, '--digest', prefix(ask)]
      const before = await snap()
      for (const { argv, names } of [
        { argv: [...base, '--principal', 'ci'], names: '--principal' },
        { argv: [...base, '--principal', 'ops', '--via', 'ops'], names: '--via' },
      ]) {
        const r = await capture(argv)
        expect({ argv, code: r.code }).toEqual({ argv, code: 1 })
        expect(r.stderr).toContain(names)
        expect(r.stderr).not.toContain(ask.nonce)
        expect(await snap()).toEqual(before)
      }
    },
    SLOW,
  )

  test(
    'deny --standing answers a renewal Ask, writes only the Answer record, and the next advance does not ask again',
    async () => {
      const grants = readFileSync(standingFile())
      const state = readFileSync(vh.statePath)
      const seen = auditRecords(vh.home).length

      const r = await capture(form('deny --standing').answer(ask.nonce, prefix(ask)))
      expect(r.code).toBe(0)
      expect(askById(ask.id)).toMatchObject({ state: 'answered', answer: 'deny' })
      expect(auditRecords(vh.home).slice(seen).map((l) => l.type)).toEqual(['warpline.audit.ask.answered'])
      expect(auditRecords(vh.home, 'ask.answered')[0]).toMatchObject({ kind: 'renewal', answer: 'deny' })
      expect(readFileSync(standingFile()).equals(grants)).toBe(true)
      expect(readFileSync(vh.statePath).equals(state)).toBe(true)

      await ok(['advance'])
      expect(storedAsks().filter((a) => a.scope === ask.scope && a.state === 'open')).toEqual([])
      expect(readFileSync(standingFile()).equals(grants)).toBe(true)
    },
    SLOW,
  )

  test(
    'deny --standing without --nonce refuses by name',
    async () => {
      const id = standingId()
      const before = await snap()
      for (const argv of [
        ['deny', '--standing', id, '--principal', 'ops'],
        ['deny', '--standing', id, '--digest', prefix(ask), '--principal', 'ops'],
      ]) {
        const r = await capture(argv)
        expect({ argv, code: r.code }).toEqual({ argv, code: 1 })
        expect(r.stderr).toContain('--nonce')
        expect(await snap()).toEqual(before)
      }
    },
    SLOW,
  )
})

describe('the four Answer forms take one flag set', () => {
  /** `argv` without `flag` and the value after it. */
  const drop = (argv: string[], flag: string): string[] => {
    const at = argv.indexOf(flag)
    return [...argv.slice(0, at), ...argv.slice(at + 2)]
  }

  test(
    'dropping --nonce, --digest or --principal refuses every form, and the full set with --via and --evidence is accepted by each',
    async () => {
      const LABELS = ['approve p', 'deny p', 'renew', 'deny --standing']
      const FLAGS = ['--nonce', '--digest', '--principal']
      const refusing: Record<string, string[]> = {}
      const accepted: Record<string, number> = {}
      for (const label of LABELS) {
        await resetHome()
        const f = form(label)
        const ask = await f.open()
        const full = f.answer(ask.nonce, prefix(ask))
        refusing[label] = []
        for (const flag of FLAGS) {
          const before = await snap()
          const r = await capture(drop(full, flag))
          const after = await snap()
          if (r.code === 1 && r.stderr.includes(flag) && JSON.stringify(after) === JSON.stringify(before)) {
            refusing[label].push(flag)
          }
        }
        accepted[label] = (await capture([...full, '--via', 'ci', '--evidence', 'OPS-1'])).code
      }
      expect(refusing).toEqual(Object.fromEntries(LABELS.map((l) => [l, FLAGS])))
      expect(accepted).toEqual(Object.fromEntries(LABELS.map((l) => [l, 0])))
    },
    120_000,
  )
})

describe('an Answer during a send', () => {
  async function until(done: () => boolean, ms: number): Promise<void> {
    const end = Date.now() + ms
    while (!done()) {
      if (Date.now() > end) throw new Error('timed out waiting for notify to start')
      await Bun.sleep(20)
    }
  }

  test(
    'an Answer that lands while notify runs stays answered after the try is recorded, and its replay refuses',
    async () => {
      vh.cleanup()
      vh = makeVerbHome()
      await seedPrincipals([
        ['ops', 'human'],
        ['ci', 'machine'],
      ])
      await prepare(vh.home, false)
      const stub = await notifyStub(vh.home, 'block')
      setNotify(join(vh.home, 'preferences.json'), { argv: stub.argv })

      // The library call, so no output capture is installed while approve's runs.
      const advancing = runAdvance()
      try {
        await until(() => existsSync(stub.startedPath), 15_000)
        const ask = askFor('p')
        const answer = form('approve p').answer(ask.nonce, prefix(ask))
        const r = await capture(answer)
        expect(r.code).toBe(0)
        writeFileSync(stub.releasePath, '')
        await advancing

        const after = askById(ask.id)
        expect(after.state).toBe('answered')
        expect(after.tries.at(-1)?.outcome).toBe('delivered')
        await refused(answer, 'nonce reused')
      } finally {
        writeFileSync(stub.releasePath, '')
        await advancing.catch(() => {})
      }
    },
    SLOW,
  )
})

describe('every refusal is observed through every Answer form', () => {
  /** Rewrite one stored Ask through the lib, so the store stays schema-valid. */
  async function patchAsk(id: string, patch: Partial<Ask>): Promise<void> {
    const read = await readAsks(vh.statePath)
    if (!read.readable) throw new Error(`asks.json unreadable: ${read.cause}`)
    await writeAsks(vh.statePath, { ...read.store, asks: read.store.asks.map((a) => (a.id === id ? { ...a, ...patch } : a)) })
  }

  /** The digest prefix of `ask` with its first character changed. */
  const otherPrefix = (ask: StoredAsk): string => (ask.digest[0] === '0' ? '1' : '0') + ask.digest.slice(1, 12)

  const REASONS: Array<{ reason: Reason; apply: (f: Form, ask: StoredAsk) => Promise<[nonce: string, digest: string]> }> = [
    { reason: 'prefix shorter than 12', apply: async (_f, ask) => [ask.nonce, ask.digest.slice(0, 11)] },
    { reason: 'unknown', apply: async (_f, ask) => [randomBytes(16).toString('hex'), prefix(ask)] },
    {
      reason: 'superseded',
      apply: async (_f, ask) => {
        await patchAsk(ask.id, { state: 'superseded', closed_at: new Date().toISOString() })
        return [ask.nonce, prefix(ask)]
      },
    },
    {
      reason: 'expired',
      apply: async (_f, ask) => {
        await patchAsk(ask.id, { expires_at: new Date(Date.now() - 60_000).toISOString(), state: 'open' })
        return [ask.nonce, prefix(ask)]
      },
    },
    {
      reason: 'nonce reused',
      apply: async (f, ask) => {
        await patchAsk(ask.id, { state: 'answered', closed_at: new Date().toISOString(), answer: f.recorded })
        return [ask.nonce, prefix(ask)]
      },
    },
    { reason: 'digest mismatch', apply: async (_f, ask) => [ask.nonce, otherPrefix(ask)] },
  ]

  for (const f of FORMS) {
    for (const { reason, apply } of REASONS) {
      test(
        `refusal matrix: ${f.label}, ${reason}`,
        async () => {
          const ask = await f.open()
          const [nonce, digest] = await apply(f, ask)
          await refused(f.answer(nonce, digest), reason)
        },
        SLOW,
      )
    }
  }
})
