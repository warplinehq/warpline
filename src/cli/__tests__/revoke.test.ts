/**
 * `warpline revoke` has three forms. Bare, it clears the session grant and
 * never touches the standing grants file. `--holder X` revokes every standing
 * grant X holds and no other. `--standing <id>` revokes one by id. Every form
 * takes an optional `--principal`, the acting principal, checked under the
 * state lock and recorded on `grant.revoked`; a claim the registry cannot
 * confirm is kept apart as `principal_unchecked`, so `principal` always means
 * checked.
 *
 * A revoke narrows authority, so a failing audit store or registry observation
 * never blocks one: the grants go and the command exits 70. When the standing
 * grants file itself cannot be read, the standing forms refuse with nothing
 * written, name the cause, and name the one way out.
 *
 * Every refusal exits 1 with the whole home unchanged and its reason on
 * stderr, so a row can only pass for the reason it names.
 *
 * The home: plugins `p` and `q`; `ci` holds two standing grants (p and q),
 * `cd` holds one (p), and a session grant for p is live. Every case gets its
 * own temp home through the shared verb-home helper (AGENTS.md Rule 2), and
 * every principal is seeded before any snapshot, so the audit head moves only
 * for what a case does (P10).
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as audit from '../../lib/audit-log.js'
import * as gate from '../../runtime/approval-gate.js'
import { pathsForStateFile, withStateLockAt } from '../../board/state-manager.js'
import { principalsPath, sessionApprovalPath, standingGrantsPath } from '../../lib/paths.js'
import { testFixturesDir } from '../../../test-utils/fixtures.js'
import * as revokeCli from '../revoke.js'
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

const BIN = testFixturesDir(import.meta.url, '../../../dist/bin/warpline.js')
const STANDING = ['--standing', '--principal', 'ops', '--hard-max', '30d']

let vh: VerbHome
let ciIds: string[]
let cdId: string
let savedPrincipal: string | undefined

function grants(): gate.StandingGrant[] {
  return (JSON.parse(readFileSync(standingGrantsPath(), 'utf-8')) as gate.StandingStore).grants
}

const grantOf = (id: string): gate.StandingGrant | undefined => grants().find((g) => g.id === id)

const revoked = (): Record<string, unknown>[] => auditRecords(vh.home, 'grant.revoked')

async function ok(argv: string[]): Promise<void> {
  const r = await capture(argv)
  if (r.code !== 0) throw new Error(`${argv.join(' ')} exited ${r.code}: ${r.stderr}`)
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

beforeEach(async () => {
  savedPrincipal = process.env.WARPLINE_PRINCIPAL
  delete process.env.WARPLINE_PRINCIPAL
  vh = makeVerbHome()
  // q: p's manifest under another name, a second side-effecting session plugin.
  const pManifest = readFileSync(join(vh.home, 'plugins', 'p', 'manifest.ts'), 'utf-8')
  mkdirSync(join(vh.home, 'plugins', 'q'), { recursive: true })
  writeFileSync(
    join(vh.home, 'plugins', 'q', 'manifest.ts'),
    pManifest.replace('"name":"p"', '"name":"q"').replace('"p fixture plugin"', '"q fixture plugin"'),
  )
  await seedPrincipals([
    ['ops', 'human'],
    ['alice', 'human'],
    ['ci', 'machine'],
    ['cd', 'machine'],
    ['idle', 'machine'],
  ])
  await ok(['principal', 'disable', 'alice'])
  await ok(['approve', 'p', '--holder', 'ci', ...STANDING])
  await ok(['approve', 'q', '--holder', 'ci', ...STANDING])
  await ok(['approve', 'p', '--holder', 'cd', ...STANDING])
  await ok(['approve', 'p'])
  ciIds = grants()
    .filter((g) => g.holder === 'ci')
    .map((g) => g.id)
    .sort()
  cdId = grants().find((g) => g.holder === 'cd')!.id
  if (ciIds.length !== 2 || !existsSync(sessionApprovalPath())) throw new Error('fixture: grants not issued')
})

afterEach(() => {
  restoreSpies()
  vh.cleanup()
  if (savedPrincipal === undefined) delete process.env.WARPLINE_PRINCIPAL
  else process.env.WARPLINE_PRINCIPAL = savedPrincipal
})

describe('revoke takes exactly what it names', () => {
  test("revoke --holder removes exactly that holder's grants", async () => {
    const seen = recordedBefore(gate as unknown as Record<string, unknown>, 'writeStandingStore', vh.home, 'grant.revoked')
    const cdBefore = JSON.stringify(grantOf(cdId))
    const sessionBytes = readFileSync(sessionApprovalPath())
    const sessionMtime = statSync(sessionApprovalPath()).mtimeMs

    const r = await capture(['revoke', '--holder', 'ci'])

    expect(r.code).toBe(0)
    expect(grants().filter((g) => g.holder === 'ci')).toEqual([])
    expect(JSON.stringify(grantOf(cdId))).toBe(cdBefore)
    expect(readFileSync(sessionApprovalPath())).toEqual(sessionBytes)
    expect(statSync(sessionApprovalPath()).mtimeMs).toBe(sessionMtime)
    expect(revoked().at(-1)).toEqual({
      kind: 'standing',
      ids: ciIds,
      holder: 'ci',
      scopes: ['p', 'q'],
      principal: null,
      principal_unchecked: null,
    })
    expect(seen()).toBe(true)
  })

  test('revoke --standing removes exactly one, and again exits 1', async () => {
    const id = ciIds[0]!
    const others = grants()
      .map((g) => g.id)
      .filter((g) => g !== id)

    const first = await capture(['revoke', '--standing', id])
    expect(first.code).toBe(0)
    expect(grants().map((g) => g.id)).toEqual(others)

    const before = await snapshotHome(vh.home)
    const second = await capture(['revoke', '--standing', id])
    expect(second.stderr).toContain('no standing grant has that id')
    expect(second.code).toBe(1)
    expect(await snapshotHome(vh.home)).toEqual(before)
  })

  test('bare revoke leaves standing grants byte-identical', async () => {
    const bytes = readFileSync(standingGrantsPath())
    const mtime = statSync(standingGrantsPath()).mtimeMs

    const r = await capture(['revoke'])

    expect(r.code).toBe(0)
    expect(readFileSync(standingGrantsPath())).toEqual(bytes)
    expect(statSync(standingGrantsPath()).mtimeMs).toBe(mtime)
    expect(existsSync(sessionApprovalPath())).toBe(false)
    expect(revoked().at(-1)).toEqual({ kind: 'session', scopes: ['p'], principal: null, principal_unchecked: null })
  })

  test('revoke --holder of a principal holding none exits 0 and records nothing', async () => {
    const bytes = readFileSync(standingGrantsPath())
    const count = revoked().length

    const r = await capture(['revoke', '--holder', 'idle'])

    expect(r.code).toBe(0)
    expect(r.stdout).toContain('idle holds no standing grant')
    expect(revoked().length).toBe(count)
    expect(readFileSync(standingGrantsPath())).toEqual(bytes)
  })

  test('revoke --holder of a disabled holder still revokes', async () => {
    await ok(['principal', 'disable', 'ci'])

    const r = await capture(['revoke', '--holder', 'ci'])

    expect(r.code).toBe(0)
    expect(grants().filter((g) => g.holder === 'ci')).toEqual([])
    expect(grantOf(cdId)).toBeDefined()
  })
})

describe('revoke records who acted', () => {
  test.each([
    ['bare revoke', () => ['revoke', '--principal', 'ops'], 'session'],
    ['revoke --holder ci', () => ['revoke', '--holder', 'ci', '--principal', 'ops'], 'standing'],
    ["revoke --standing <cd's id>", () => ['revoke', '--standing', cdId, '--principal', 'ops'], 'standing'],
  ] as const)('%s --principal ops', async (_name, argv, kind) => {
    const r = await capture(argv())

    expect(r.code).toBe(0)
    const record = revoked().at(-1)
    expect(record?.kind).toBe(kind)
    expect(record?.principal).toBe('ops')
    expect(record?.principal_unchecked).toBeNull()
  })
})

/** One refusal row: an optional preparation, the argv to run, and the reason stderr must hold. */
type Row = { name: string; prepare?: () => void; argv: () => string[]; reason: string }

const REFUSALS: Row[] = [
  { name: '--holder nobody', argv: () => ['revoke', '--holder', 'nobody'], reason: '--holder: no principal has that id' },
  { name: "--holder ''", argv: () => ['revoke', '--holder', ''], reason: 'Usage: warpline revoke' },
  {
    name: '--standing 000000000000',
    argv: () => ['revoke', '--standing', '000000000000'],
    reason: 'no standing grant has that id',
  },
  {
    name: '--holder ci --standing <id>',
    argv: () => ['revoke', '--holder', 'ci', '--standing', cdId],
    reason: '--holder and --standing are two forms',
  },
  {
    name: '--holder ci --principal nobody',
    argv: () => ['revoke', '--holder', 'ci', '--principal', 'nobody'],
    reason: '--principal: no principal has that id',
  },
  {
    name: '--holder ci --principal alice (disabled)',
    argv: () => ['revoke', '--holder', 'ci', '--principal', 'alice'],
    reason: '--principal: that principal is disabled',
  },
  {
    name: "--holder ci --principal ''",
    argv: () => ['revoke', '--holder', 'ci', '--principal', ''],
    reason: '--principal: an empty id names no principal',
  },
  {
    name: "--holder ci --principal 'Bad Id', principals.json unreadable",
    prepare: () => writeFileSync(principalsPath(), '{not json'),
    argv: () => ['revoke', '--holder', 'ci', '--principal', 'Bad Id'],
    reason: '--principal: no principal has that id',
  },
]

describe('revoke refuses and writes nothing', () => {
  for (const row of REFUSALS) {
    test(row.name, async () => {
      row.prepare?.()
      const before = await snapshotHome(vh.home)

      const r = await capture(row.argv())

      // The reason first, so a row that fails today fails on the missing reason.
      expect(r.stderr).toContain(row.reason)
      expect(r.code).toBe(1)
      expect(await snapshotHome(vh.home)).toEqual(before)
    })
  }
})

describe('an unreadable standing grants file refuses, naming why and the way out', () => {
  const CAUSES = {
    corrupt: {
      prepare: () => writeFileSync(standingGrantsPath(), '{not json'),
      reasons: ['one bad grant makes the whole file unreadable'],
    },
    'newer reader': {
      prepare: () => {
        const store = JSON.parse(readFileSync(standingGrantsPath(), 'utf-8')) as gate.StandingStore
        writeFileSync(
          standingGrantsPath(),
          JSON.stringify({ ...store, min_reader_version: gate.STANDING_READER_VERSION + 1 }),
        )
      },
      reasons: ['a newer warpline wrote it', 'Do not edit it'],
    },
    io: {
      prepare: () => {
        rmSync(standingGrantsPath())
        mkdirSync(standingGrantsPath())
      },
      reasons: ['the file system refused the read'],
    },
  } as const
  const FORMS = {
    '--holder ci': () => ['revoke', '--holder', 'ci'],
    '--standing <id>': () => ['revoke', '--standing', cdId],
  } as const

  for (const [cause, { prepare, reasons }] of Object.entries(CAUSES)) {
    for (const [form, argv] of Object.entries(FORMS)) {
      test(`${cause}: revoke ${form}`, async () => {
        prepare()
        const before = await snapshotHome(vh.home)

        const r = await capture(argv())

        for (const reason of reasons) expect(r.stderr).toContain(reason)
        expect(r.stderr).toContain('Moving the file aside drops every standing grant in it at once')
        expect(r.code).toBe(1)
        expect(await snapshotHome(vh.home)).toEqual(before)
      })
    }
  }
})

describe('revoke and a failing store or registry', () => {
  test("revoke's usage names what --standing means here", () => {
    // Through the namespace, so a missing export fails this case and not the file.
    const usage = String((revokeCli as Record<string, unknown>).USAGE)
    expect(usage).toContain('--standing <grant-id>')
    expect(usage).toContain('Revoke one standing grant.')
    expect(usage).toContain('names one grant')
  })

  test('a failing store still revokes and exits 70', async () => {
    const fail = failAppendOnce('grant.revoked')

    const r = await capture(['revoke', '--holder', 'ci'])

    expect(fail.trips()).toBe(1)
    expect(r.code).toBe(70)
    expect(grants().filter((g) => g.holder === 'ci')).toEqual([])
    expect(r.stderr).toContain('no audit record of this revoke was written')
  })

  test('a registry edit the store cannot record still revokes and exits 70', async () => {
    const registry = JSON.parse(readFileSync(principalsPath(), 'utf-8')) as { principals: unknown[] }
    registry.principals.push({ id: 'newbot', type: 'machine', status: 'active' })
    writeFileSync(principalsPath(), JSON.stringify(registry))
    const real = audit.observeAuthorityFile
    let trips = 0
    spyOn(audit, 'observeAuthorityFile').mockImplementation((async (...args: Parameters<typeof real>) => {
      if (args[1] === 'principal_registry.observed' && trips === 0) {
        trips += 1
        throw new Error('observation refused by the test')
      }
      return real(...args)
    }) as typeof real)

    try {
      const r = await capture(['revoke', '--holder', 'ci'])

      expect(trips).toBe(1)
      expect(r.code).toBe(70)
      expect(grants().filter((g) => g.holder === 'ci')).toEqual([])
    } finally {
      ;(audit.observeAuthorityFile as unknown as { mockRestore: () => void }).mockRestore()
    }
  })

  test('an unreadable registry revokes a holder the file names, and refuses one it does not', async () => {
    writeFileSync(principalsPath(), '{not json')

    const r = await capture(['revoke', '--holder', 'ci'])
    expect(r.code).toBe(0)
    expect(grants().filter((g) => g.holder === 'ci')).toEqual([])

    const before = await snapshotHome(vh.home)
    const zz = await capture(['revoke', '--holder', 'zz'])
    expect(zz.stderr).toContain('--holder: no principal has that id')
    expect(zz.code).toBe(1)
    expect(await snapshotHome(vh.home)).toEqual(before)
  })

  test('an unreadable registry still revokes with --principal, and records the claim as unchecked', async () => {
    writeFileSync(principalsPath(), '{not json')

    const r = await capture(['revoke', '--holder', 'ci', '--principal', 'ops'])

    expect(r.code).toBe(0)
    expect(grants().filter((g) => g.holder === 'ci')).toEqual([])
    const record = revoked().at(-1)
    expect(record?.principal).toBeNull()
    expect(record?.principal_unchecked).toBe('ops')
    expect(r.stderr).toContain('could not be checked')
  })
})

describe('revoke and the state lock', () => {
  test.each([
    ['revoke', () => ['revoke'], () => existsSync(sessionApprovalPath())],
    ['revoke --standing', () => ['revoke', '--standing', cdId], () => grantOf(cdId) !== undefined],
    ['revoke --holder ci', () => ['revoke', '--holder', 'ci'], () => grants().some((g) => g.holder === 'ci')],
  ] as const)('every revoke form waits on the state lock: %s', async (_name, argv, present) => {
    let open!: () => void
    const held = new Promise<void>((resolve) => {
      open = resolve
    })
    const lock = withStateLockAt(pathsForStateFile(vh.statePath).lockPath, () => held)
    // Let the test's hold land before the revoke reaches for the lock.
    await sleep(50)

    const pending = capture(argv())
    // Long enough for the revoke to reach the lock and wait on it.
    await sleep(200)
    const stillPresent = present()
    open()
    await lock
    const r = await pending

    expect(stillPresent).toBe(true)
    expect(r.code).toBe(0)
    expect(present()).toBe(false)
  })

  test('backstop: revoke and renew of one id serialise on the state lock', async () => {
    // A bun child's default env is a startup snapshot, so the env is passed whole.
    const env: Record<string, string | undefined> = { ...process.env, WARPLINE_HOME: vh.home }
    delete env.NODE_ENV
    delete env.WARPLINE_PRINCIPAL
    const spawn = (args: string[]) =>
      Bun.spawn([process.execPath, BIN, ...args], { env, stdout: 'pipe', stderr: 'pipe' }).exited

    const [revokeCode, renewCode] = await Promise.all([
      spawn(['revoke', '--standing', cdId]),
      spawn(['renew', cdId, '--principal', 'ops']),
    ])

    expect(revokeCode).toBe(0)
    expect([0, 1]).toContain(renewCode)
    expect(grantOf(cdId)).toBeUndefined()
    const lines = auditRecords(vh.home)
    const revokedAt = lines.findIndex(
      (l) => l.type === 'warpline.audit.grant.revoked' && (l.data.ids as string[] | undefined)?.includes(cdId),
    )
    expect(revokedAt).toBeGreaterThanOrEqual(0)
    const renewedAfter = lines
      .slice(revokedAt + 1)
      .filter((l) => l.type === 'warpline.audit.grant.renewed' && l.data.id === cdId)
    expect(renewedAfter).toEqual([])
  })
})
