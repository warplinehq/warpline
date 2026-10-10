/**
 * `warpline renew <id> --principal <human-id>` restarts a standing grant's
 * renewal period from now and moves nothing else: the hard maximum, fixed at
 * issue, stays where it was. The renewer is a named active human, never the
 * holder and never read from the environment. Its `grant.renewed` record is on
 * disk before the standing grants file is written, so a failed record renews
 * nothing.
 *
 * Every refusal exits 1 with the whole home unchanged, no record, and its
 * reason on stderr, so a row can only pass for the reason it names. A lapse
 * is worded from the gate's `final` alone: it cannot clear, or it clears only
 * before a printed moment, the grant's next expiry.
 *
 * The clock is mocked: `T0` is when the grant was issued, with a one-day
 * period and a three-day hard maximum. Every case gets its own temp home
 * through the shared verb-home helper (AGENTS.md Rule 2), and every principal
 * is seeded before any snapshot, so the audit head moves only for what a case
 * does (P10).
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from 'bun:test'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import * as gate from '../../runtime/approval-gate.js'
import { pathsForStateFile, withStateLockAt } from '../../board/state-manager.js'
import * as principals from '../../lib/principals.js'
import { loadRegistry } from '../../lib/principals.js'
import { principalsPath, sessionApprovalPath, standingGrantsPath } from '../../lib/paths.js'
import {
  auditRecords,
  capture,
  failAppendOnce,
  makeVerbHome,
  recordedBefore,
  restoreSpies,
  seedPrincipals,
  snapshotHome,
  type VerbHome,
} from './helpers/verb-home.js'

const DAY = 24 * 60 * 60 * 1000
const T0 = Date.parse('2030-01-01T00:00:00.000Z')
const iso = (ms: number): string => new Date(ms).toISOString()

/** The one re-issue sentence, word for word everywhere. */
const REISSUE = 'approve --standing issues a new grant with a new id; the lapsed one stays until revoked'

let vh: VerbHome
let id: string
let savedPrincipal: string | undefined

function storedGrant(): gate.StandingGrant {
  const grants = (JSON.parse(readFileSync(standingGrantsPath(), 'utf-8')) as gate.StandingStore).grants
  return grants.find((g) => g.id === id)!
}

/** Rewrite principals.json by hand, then let the store see it once, so a later snapshot is not moved by the observe (P10). */
type Entry = { id: string; type: string; status: string }
async function editRegistry(edit: (principals: Entry[]) => Entry[]): Promise<void> {
  const registry = JSON.parse(readFileSync(principalsPath(), 'utf-8')) as { principals: Entry[] }
  writeFileSync(principalsPath(), JSON.stringify({ principals: edit(registry.principals) }))
  const loaded = await loadRegistry(vh.statePath)
  if ('refused' in loaded) throw new Error(`loadRegistry refused: ${loaded.refused}`)
}

/** Renew at `at`, as a preparation step; its result is checked after the case's own assertions. */
async function renewAt(at: number, principal = 'carol'): Promise<number> {
  setSystemTime(new Date(at))
  return (await capture(['renew', id, '--principal', principal])).code
}

beforeEach(async () => {
  savedPrincipal = process.env.WARPLINE_PRINCIPAL
  delete process.env.WARPLINE_PRINCIPAL
  setSystemTime(new Date(T0))
  vh = makeVerbHome()
  await seedPrincipals([
    ['ops', 'human'],
    ['carol', 'human'],
    ['alice', 'human'],
    ['ci', 'machine'],
    ['bot', 'machine'],
  ])
  const disabled = await capture(['principal', 'disable', 'alice'])
  if (disabled.code !== 0) throw new Error(`principal disable alice exited ${disabled.code}: ${disabled.stderr}`)
  const issued = await capture([
    'approve',
    'p',
    '--standing',
    '--holder',
    'ci',
    '--principal',
    'ops',
    '--period',
    '1d',
    '--hard-max',
    '3d',
  ])
  if (issued.code !== 0) throw new Error(`approve --standing exited ${issued.code}: ${issued.stderr}`)
  id = (JSON.parse(readFileSync(standingGrantsPath(), 'utf-8')) as gate.StandingStore).grants[0]!.id
})

afterEach(() => {
  setSystemTime()
  restoreSpies()
  vh.cleanup()
  if (savedPrincipal === undefined) delete process.env.WARPLINE_PRINCIPAL
  else process.env.WARPLINE_PRINCIPAL = savedPrincipal
})

describe('renew restarts the period', () => {
  test('renew at exactly the deadline restarts the period and nothing else', async () => {
    const before = storedGrant()
    const fixed = (g: gate.StandingGrant): string =>
      JSON.stringify({
        id: g.id,
        holder: g.holder,
        issuer: g.issuer,
        scopes: g.scopes,
        issued_at: g.issued_at,
        period_ms: g.period_ms,
        hard_max_ms: g.hard_max_ms,
      })

    setSystemTime(new Date(T0 + DAY))
    const r = await capture(['renew', id, '--principal', 'carol'])
    expect(r.code).toBe(0)

    const after = storedGrant()
    expect(after.period_start).toBe(iso(T0 + DAY))
    expect(fixed(after)).toBe(fixed(before))
    expect(auditRecords(vh.home, 'grant.renewed')).toEqual([
      { id, holder: 'ci', principal: 'carol', renewal_deadline: iso(T0 + 2 * DAY) },
    ])

    const listing = await gate.listStandingGrants({
      now: T0 + 2 * DAY,
      registry: new Map([['ci', { type: 'machine', status: 'active' }]]),
    })
    expect(listing.readable && listing.grants.map((g) => [g.id, g.state])).toEqual([[id, 'live']])

    expect(r.stdout).toContain(`renewal deadline ${iso(T0 + 2 * DAY)}`)
    expect(r.stdout).toContain(`hard maximum ${iso(T0 + 3 * DAY)}`)
  })

  test('renew records before it writes', async () => {
    const seen = recordedBefore(gate as unknown as Record<string, unknown>, 'writeStandingStore', vh.home, 'grant.renewed')
    setSystemTime(new Date(T0 + DAY))
    const r = await capture(['renew', id, '--principal', 'carol'])
    expect(r.code).toBe(0)
    expect(seen()).toBe(true)
  })

  // The record keeps the renewal deadline, a defined term, and the hard maximum
  // is derivable from `issued_at`. The line the operator reads names the moment
  // the grant actually lapses.
  test('a renewal past the hard maximum prints the hard maximum as the next expiry', async () => {
    const steps = [await renewAt(T0 + DAY), await renewAt(T0 + 2 * DAY)]
    setSystemTime(new Date(T0 + 2.5 * DAY))
    const r = await capture(['renew', id, '--principal', 'carol'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain(`renewal deadline ${iso(T0 + 3.5 * DAY)}`)
    expect(r.stdout).toContain(`next expiry ${iso(T0 + 3 * DAY)}`)
    expect(auditRecords(vh.home, 'grant.renewed').at(-1)!.renewal_deadline).toBe(iso(T0 + 3.5 * DAY))
    expect(steps).toEqual([0, 0])
  })

  test('a renewal inside the hard maximum prints the renewal deadline as the next expiry', async () => {
    setSystemTime(new Date(T0 + DAY))
    const r = await capture(['renew', id, '--principal', 'carol'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain(`next expiry ${iso(T0 + 2 * DAY)}`)
  })

  // Hand edits take no lock, so a second read of principals.json can see an
  // edit the check never recorded. The spy lands one on any second read.
  test('renew judges the holder by the registry its check recorded, read once', async () => {
    const original = principals.readRegistry
    let reads = 0
    const spy = spyOn(principals, 'readRegistry').mockImplementation(async (path?: string) => {
      reads += 1
      if (reads === 2) {
        const registry = JSON.parse(readFileSync(principalsPath(), 'utf-8')) as { principals: Entry[] }
        for (const p of registry.principals) if (p.id === 'ci') p.status = 'disabled'
        writeFileSync(principalsPath(), JSON.stringify(registry))
      }
      return original(path)
    })
    try {
      setSystemTime(new Date(T0 + DAY))
      const r = await capture(['renew', id, '--principal', 'carol'])
      expect(r.stderr).toBe('')
      expect(r.code).toBe(0)
      expect(reads).toBe(1)
    } finally {
      spy.mockRestore()
    }
  })

  test('renew by the issuer is allowed', async () => {
    setSystemTime(new Date(T0 + DAY))
    const r = await capture(['renew', id, '--principal', 'ops'])
    expect(r.code).toBe(0)
    expect(auditRecords(vh.home, 'grant.renewed').map((d) => d.principal)).toEqual(['ops'])
  })
})

/**
 * One refusal row: an optional preparation, the argv to run, and the phrases
 * stderr must hold. `absent` names text stderr must not hold.
 */
type Row = {
  name: string
  prepare?: () => Promise<number[]>
  at?: number
  argv: () => string[]
  reasons: string[]
  absent?: string[]
}

const ROWS: Row[] = [
  {
    name: 'one millisecond after the deadline',
    at: T0 + DAY + 1,
    argv: () => ['renew', id, '--principal', 'carol'],
    reasons: ['the grant has lapsed (not renewed), and the lapse cannot clear.', REISSUE],
  },
  {
    name: 'past the hard maximum, which renewals never move',
    prepare: async () => [await renewAt(T0 + DAY), await renewAt(T0 + 2 * DAY)],
    at: T0 + 3 * DAY + 1,
    argv: () => ['renew', id, '--principal', 'carol'],
    reasons: ['the grant has lapsed (hard max), and the lapse cannot clear.', REISSUE],
  },
  {
    name: 'the holder disabled',
    prepare: async () => [(await capture(['principal', 'disable', 'ci'])).code],
    argv: () => ['renew', id, '--principal', 'carol'],
    reasons: [
      `the grant has lapsed (holder disabled). It clears if principals.json names its holder an active machine before ${iso(T0 + DAY)}, and is final after that`,
    ],
  },
  {
    // WR-01: a clock set back behind period_start leaves a period that has not started.
    name: 'before period_start, after the clock went back',
    at: T0 - 1,
    argv: () => ['renew', id, '--principal', 'carol'],
    reasons: [`the grant has lapsed (future dated). It clears when the clock reaches ${iso(T0)}, and is final after ${iso(T0 + DAY)}`],
  },
  {
    name: 'the holder gone from principals.json',
    prepare: async () => {
      await editRegistry((ps) => ps.filter((p) => p.id !== 'ci'))
      return []
    },
    argv: () => ['renew', id, '--principal', 'carol'],
    reasons: ['the grant has lapsed (holder not registered), and the lapse cannot clear.', REISSUE],
  },
  {
    name: 'a holder lapse after a late renewal names the hard maximum, the earlier end',
    prepare: async () => {
      const codes = [await renewAt(T0 + DAY), await renewAt(T0 + 2 * DAY), await renewAt(T0 + 2.5 * DAY)]
      codes.push((await capture(['principal', 'disable', 'ci'])).code)
      return codes
    },
    at: T0 + 2.5 * DAY + 1,
    argv: () => ['renew', id, '--principal', 'carol'],
    reasons: [
      `the grant has lapsed (holder disabled). It clears if principals.json names its holder an active machine before ${iso(T0 + 3 * DAY)}, and is final after that`,
    ],
    absent: [iso(T0 + 3.5 * DAY)],
  },
  {
    name: '--principal ci, the holder, a machine',
    argv: () => ['renew', id, '--principal', 'ci'],
    reasons: ['--principal: that principal is not a human'],
  },
  {
    name: 'the holder retyped to a human renews its own grant',
    prepare: async () => {
      await editRegistry((ps) => ps.map((p) => (p.id === 'ci' ? { ...p, type: 'human' } : p)))
      return []
    },
    argv: () => ['renew', id, '--principal', 'ci'],
    reasons: ['the holder cannot renew its own grant'],
  },
  {
    name: '--principal bot, another machine',
    argv: () => ['renew', id, '--principal', 'bot'],
    reasons: ['--principal: that principal is not a human'],
  },
  {
    name: '--principal nobody',
    argv: () => ['renew', id, '--principal', 'nobody'],
    reasons: ['--principal: no principal has that id'],
  },
  {
    name: '--principal alice (disabled)',
    argv: () => ['renew', id, '--principal', 'alice'],
    reasons: ['--principal: that principal is disabled'],
  },
  {
    name: 'no --principal, WARPLINE_PRINCIPAL set',
    prepare: async () => {
      process.env.WARPLINE_PRINCIPAL = 'carol'
      return []
    },
    argv: () => ['renew', id],
    reasons: ['--principal is required'],
  },
  {
    name: "--principal ''",
    argv: () => ['renew', id, '--principal', ''],
    reasons: ['--principal: an empty id names no principal'],
  },
  {
    name: 'an unknown id, 000000000000',
    argv: () => ['renew', '000000000000', '--principal', 'carol'],
    reasons: ['no standing grant has that id'],
  },
  {
    name: 'an id of the wrong shape',
    argv: () => ['renew', 'not-an-id', '--principal', 'carol'],
    reasons: ['no standing grant has that id'],
  },
  {
    name: 'an unreadable standing grants file',
    prepare: async () => {
      writeFileSync(standingGrantsPath(), '{not json')
      return []
    },
    argv: () => ['renew', id, '--principal', 'carol'],
    reasons: ['renew: the standing grants file cannot be read. Nothing was renewed.'],
  },
  {
    name: 'no id at all',
    argv: () => ['renew', '--principal', 'carol'],
    reasons: ['Usage: warpline renew'],
  },
]

describe('renew refuses and writes nothing', () => {
  for (const row of ROWS) {
    test(row.name, async () => {
      const prepared = row.prepare === undefined ? [] : await row.prepare()
      setSystemTime(new Date(row.at ?? T0))
      const renewedBefore = auditRecords(vh.home, 'grant.renewed').length
      const before = await snapshotHome(vh.home)

      const r = await capture(row.argv())

      // The reason first, so a row that fails today fails on the missing reason.
      for (const reason of row.reasons) expect(r.stderr).toContain(reason)
      for (const text of row.absent ?? []) expect(r.stderr).not.toContain(text)
      expect(r.code).toBe(1)
      expect(auditRecords(vh.home, 'grant.renewed').length).toBe(renewedBefore)
      expect(await snapshotHome(vh.home)).toEqual(before)
      expect(prepared.every((code) => code === 0)).toBe(true)
    })
  }
})

describe('renew and the files beside it', () => {
  test('renew whose record cannot be written renews nothing', async () => {
    const bytes = readFileSync(standingGrantsPath())
    const fail = failAppendOnce('grant.renewed')
    setSystemTime(new Date(T0 + DAY))
    const r = await capture(['renew', id, '--principal', 'carol'])
    expect(fail.trips()).toBe(1)
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('The audit store could not record this renewal, so nothing was renewed.')
    expect(readFileSync(standingGrantsPath())).toEqual(bytes)
    expect(auditRecords(vh.home, 'grant.renewed')).toEqual([])
  })

  test('renew by a principal disabled while it waits on the state lock is refused', async () => {
    let open!: () => void
    const held = new Promise<void>((resolve) => {
      open = resolve
    })
    const lock = withStateLockAt(pathsForStateFile(vh.statePath).lockPath, () => held)

    setSystemTime(new Date(T0 + DAY))
    const pending = capture(['renew', id, '--principal', 'carol'])
    // Long enough for renew to reach the lock and wait on it.
    await new Promise((resolve) => setTimeout(resolve, 200))
    const registry = JSON.parse(readFileSync(principalsPath(), 'utf-8')) as {
      principals: { id: string; status: string }[]
    }
    for (const p of registry.principals) if (p.id === 'carol') p.status = 'disabled'
    writeFileSync(principalsPath(), JSON.stringify(registry))
    open()
    await lock

    const r = await pending
    expect(r.stderr).toContain('--principal: that principal is disabled')
    expect(r.code).toBe(1)
    expect(auditRecords(vh.home, 'grant.renewed')).toEqual([])
  })

  test('renew leaves the session grant untouched', async () => {
    const approved = await capture(['approve', 'p'])
    expect(approved.code).toBe(0)
    const sessionBytes = readFileSync(sessionApprovalPath())
    const sessionMtime = statSync(sessionApprovalPath()).mtimeMs

    setSystemTime(new Date(T0 + DAY))
    const r = await capture(['renew', id, '--principal', 'carol'])
    expect(r.code).toBe(0)
    expect(readFileSync(sessionApprovalPath())).toEqual(sessionBytes)
    expect(statSync(sessionApprovalPath()).mtimeMs).toBe(sessionMtime)
  })

  test('backstop: reads racing a renew see a whole store, the old period or the new', async () => {
    const oldStart = storedGrant().period_start
    setSystemTime(new Date(T0 + DAY))
    const newStart = iso(T0 + DAY)

    const pending = capture(['renew', id, '--principal', 'carol'])
    const reads = await Promise.all(Array.from({ length: 50 }, () => gate.readStandingStore()))
    const r = await pending

    for (const read of reads) {
      expect(read.readable).toBe(true)
      if (!read.readable) continue
      const grant = read.store.grants.find((g) => g.id === id)
      expect([oldStart, newStart]).toContain(grant!.period_start)
    }
    expect(r.code).toBe(0)
    expect(storedGrant().period_start).toBe(newStart)
  })
})
