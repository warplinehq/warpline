/**
 * Every authority verb's record says who acted, and with no `--principal`
 * that is nobody: `principal: null`.
 *
 * The process carries `WARPLINE_PRINCIPAL=ops` and `USER=ops`, and `ops` is a
 * registered active human, so a verb that took its actor from the environment
 * or the account running it would record `ops` here. None may (SPEC R5).
 *
 * The approve and revoke records also say which kind of grant they are about:
 * `kind: 'session'`.
 *
 * Every case gets its own temp home through the shared verb-home helper
 * (AGENTS.md Rule 2).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as audit from '../../lib/audit-log.js'
import { principalsPath, sessionApprovalPath } from '../../lib/paths.js'
import { pathsForStateFile, withStateLockAt } from '../../board/state-manager.js'
import {
  auditRecords,
  capture,
  makeVerbHome,
  restoreSpies,
  seedPrincipals,
  snapshotHome,
  type VerbHome,
} from './helpers/verb-home.js'

let vh: VerbHome
let saved: { principal: string | undefined; user: string | undefined }

beforeEach(async () => {
  vh = makeVerbHome()
  // Every principal is in place before any snapshot, so a later observe of the
  // registry has nothing to record (P10): `alice` is the disabled one.
  await seedPrincipals([
    ['ops', 'human'],
    ['ci', 'machine'],
    ['alice', 'human'],
  ])
  const disabled = await capture(['principal', 'disable', 'alice'])
  if (disabled.code !== 0) throw new Error(`principal disable alice exited ${disabled.code}: ${disabled.stderr}`)
  saved = { principal: process.env.WARPLINE_PRINCIPAL, user: process.env.USER }
  process.env.WARPLINE_PRINCIPAL = 'ops'
  process.env.USER = 'ops'
})

afterEach(() => {
  if (saved.principal === undefined) delete process.env.WARPLINE_PRINCIPAL
  else process.env.WARPLINE_PRINCIPAL = saved.principal
  if (saved.user === undefined) delete process.env.USER
  else process.env.USER = saved.user
  restoreSpies()
  vh.cleanup()
})

/** Run a verb that must succeed. */
async function ok(argv: string[]): Promise<void> {
  const r = await capture(argv)
  if (r.code !== 0) throw new Error(`${argv.join(' ')} exited ${r.code}: ${r.stderr}`)
}

/** The newest record of `kind`, which must exist. */
function newest(kind: string): Record<string, unknown> {
  const records = auditRecords(vh.home, kind)
  expect(records.length).toBeGreaterThan(0)
  return records.at(-1)!
}

/** A key's value, or `'absent'` when the record has no such key, so a missing field never reads as null. */
const field = (record: Record<string, unknown>, key: string): unknown =>
  Object.hasOwn(record, key) ? record[key] : 'absent'

/** builder's Output on the record, then sender approved over it. */
async function contentApproved(): Promise<void> {
  await capture(['advance'])
  await ok(['approve', 'sender', '--content', '--not-after', '2099-01-01T00:00'])
}

describe('no --principal records principal null', () => {
  test('approve p', async () => {
    await ok(['approve', 'p'])

    const record = newest('grant.issued')
    expect({ kind: field(record, 'kind'), principal: field(record, 'principal') }).toEqual({
      kind: 'session',
      principal: null,
    })
  })

  test('approve --all', async () => {
    await ok(['approve', '--all'])

    const record = newest('grant.issued')
    expect({ kind: field(record, 'kind'), principal: field(record, 'principal') }).toEqual({
      kind: 'session',
      principal: null,
    })
  })

  test('approve --content', async () => {
    await contentApproved()

    expect(field(newest('content_approval.issued'), 'principal')).toBeNull()
  })

  test('approve --content --remove', async () => {
    await contentApproved()
    await ok(['approve', 'sender', '--content', '--remove'])

    expect(field(newest('content_approval.withdrawn'), 'principal')).toBeNull()
  })

  test('deny', async () => {
    await ok(['deny', 'p'])

    expect(field(newest('denial.recorded'), 'principal')).toBeNull()
  })

  test('deny --remove', async () => {
    await ok(['deny', 'p'])
    await ok(['deny', '--remove', 'p'])

    expect(field(newest('denial.lifted'), 'principal')).toBeNull()
  })

  test('resolve --intent', async () => {
    const { seq } = await audit.appendAudit(vh.statePath, 'fire.intent', {
      plugin: 'p',
      run_id: 'run-1',
      class: 'session',
      effect_id: null,
      fingerprint: null,
      grants: [],
    })
    await ok(['resolve', '--intent', String(seq), '--not-shipped'])

    expect(field(newest('fire.resolved'), 'principal')).toBeNull()
  })

  test('resolve by plugin', async () => {
    writeFileSync(join(vh.home, 'fail'), '')
    await contentApproved()
    await capture(['advance'])
    const state = JSON.parse(readFileSync(vh.statePath, 'utf-8')) as {
      approvals: Record<string, { effect_id: string | null }>
    }
    const effectId = state.approvals.sender!.effect_id
    expect(effectId).toMatch(/^[0-9a-f]{64}$/)
    await ok(['resolve', 'sender', '--not-shipped', effectId!])

    expect(field(newest('fire.resolved'), 'principal')).toBeNull()
  })

  test('revoke', async () => {
    await ok(['approve', 'p'])
    await ok(['revoke'])

    const record = newest('grant.revoked')
    expect({ kind: field(record, 'kind'), principal: field(record, 'principal') }).toEqual({
      kind: 'session',
      principal: null,
    })
  })
})

/** An open `fire.intent` for p, whose seq `resolve --intent` answers. */
async function openIntent(): Promise<number> {
  const { seq } = await audit.appendAudit(vh.statePath, 'fire.intent', {
    plugin: 'p',
    run_id: 'run-1',
    class: 'session',
    effect_id: null,
    fingerprint: null,
    grants: [],
  })
  return seq
}

/** sender's indeterminate fire, after a failed send, and its effect id. */
async function indeterminateSend(): Promise<string> {
  writeFileSync(join(vh.home, 'fail'), '')
  await contentApproved()
  await capture(['advance'])
  const state = JSON.parse(readFileSync(vh.statePath, 'utf-8')) as {
    approvals: Record<string, { effect_id: string | null }>
  }
  const effectId = state.approvals.sender!.effect_id
  expect(effectId).toMatch(/^[0-9a-f]{64}$/)
  return effectId!
}

describe('a named principal is recorded', () => {
  const ops = ['--principal', 'ops']

  test('approve p', async () => {
    await ok(['approve', 'p', ...ops])

    expect(field(newest('grant.issued'), 'principal')).toBe('ops')
  })

  test('approve p, naming a machine', async () => {
    await ok(['approve', 'p', '--principal', 'ci'])

    expect(field(newest('grant.issued'), 'principal')).toBe('ci')
  })

  test('approve --all', async () => {
    await ok(['approve', '--all', ...ops])

    expect(field(newest('grant.issued'), 'principal')).toBe('ops')
  })

  test('approve --content', async () => {
    await capture(['advance'])
    await ok(['approve', 'sender', '--content', '--not-after', '2099-01-01T00:00', ...ops])

    expect(field(newest('content_approval.issued'), 'principal')).toBe('ops')
  })

  test('approve --content --remove', async () => {
    await contentApproved()
    await ok(['approve', 'sender', '--content', '--remove', ...ops])

    expect(field(newest('content_approval.withdrawn'), 'principal')).toBe('ops')
  })

  test('deny', async () => {
    await ok(['deny', 'p', ...ops])

    expect(field(newest('denial.recorded'), 'principal')).toBe('ops')
  })

  test('deny --remove', async () => {
    await ok(['deny', 'p'])
    await ok(['deny', '--remove', 'p', ...ops])

    expect(field(newest('denial.lifted'), 'principal')).toBe('ops')
  })

  test('resolve --intent', async () => {
    const seq = await openIntent()
    await ok(['resolve', '--intent', String(seq), '--not-shipped', ...ops])

    expect(field(newest('fire.resolved'), 'principal')).toBe('ops')
  })

  test('resolve by plugin', async () => {
    const effectId = await indeterminateSend()
    await ok(['resolve', 'sender', '--not-shipped', effectId, ...ops])

    expect(field(newest('fire.resolved'), 'principal')).toBe('ops')
  })
})

describe('a principal that names nobody writes nothing', () => {
  // Three verbs by three values. Each row asserts its reason, so it can only
  // pass for that reason: an unknown `--principal` option also exits 1 with
  // nothing written.
  const verbs: ReadonlyArray<readonly [string, () => Promise<string[]>]> = [
    ['approve p', async () => ['approve', 'p']],
    ['deny p', async () => ['deny', 'p']],
    ['resolve --intent', async () => ['resolve', '--intent', String(await openIntent()), '--not-shipped']],
  ]
  const values: ReadonlyArray<readonly [string, string, string]> = [
    ['nobody', 'an id no principal has', '--principal: no principal has that id'],
    ['alice', 'a disabled principal', '--principal: that principal is disabled'],
    ['', 'an empty id', '--principal: an empty id names no principal'],
  ]

  for (const [verb, argv] of verbs) {
    for (const [value, what, reason] of values) {
      test(`${verb} --principal naming ${what} exits non-zero, says why, and leaves the home unchanged`, async () => {
        const args = await argv()
        const before = await snapshotHome(vh.home)

        const r = await capture([...args, '--principal', value])

        expect(r.code).not.toBe(0)
        expect(r.stderr).toContain(reason)
        expect(await snapshotHome(vh.home)).toEqual(before)
      })
    }
  }

  test('approve p --principal with no value is a usage error', async () => {
    const before = await snapshotHome(vh.home)

    const r = await capture(['approve', 'p', '--principal'])

    expect(r.code).toBe(1)
    expect(r.stderr).toContain('argument missing')
    expect(await snapshotHome(vh.home)).toEqual(before)
  })
})

describe('the window remembers its issuer', () => {
  type Windows = Record<string, { issuer?: string }>
  const windows = (): Windows =>
    (JSON.parse(readFileSync(sessionApprovalPath(), 'utf-8')) as { scope_windows: Windows }).scope_windows

  test('approve p --principal ops writes p\'s issuer', async () => {
    await ok(['approve', 'p', '--principal', 'ops'])

    expect(windows().p!.issuer).toBe('ops')
  })

  test('approve of another scope by another principal leaves p\'s issuer', async () => {
    // The home has no plugin `q`; `builder` is the other installed scope.
    await ok(['approve', 'p', '--principal', 'ops'])
    await ok(['approve', 'builder', '--principal', 'ci'])

    expect(windows().p!.issuer).toBe('ops')
    expect(windows().builder!.issuer).toBe('ci')
  })

  test('approve p with no --principal removes p\'s issuer', async () => {
    await ok(['approve', 'p', '--principal', 'ops'])
    await ok(['approve', 'p'])

    expect(Object.hasOwn(windows().p!, 'issuer')).toBe(false)
  })
})

describe('the flag is refused where nothing would record it', () => {
  test('approve p --principal ops with a parked result waiting applies nothing and writes nothing', async () => {
    const at = new Date(Date.now() - 30_000).toISOString()
    writeFileSync(
      vh.statePath,
      JSON.stringify({
        schema_version: 1,
        plugin_runs: { p: { last_run_at: at, status: 'gated' } },
        denials: {},
        approvals: {},
        pending_gates: [
          {
            plugin: 'p',
            run_id: 'run-a',
            created_at: at,
            payload_summary: 'p did the thing',
            plugin_result: {
              status: 'success',
              phases_completed: ['p'],
              phases_failed: [],
              errors: [],
              data_freshness: {},
              summary: 'p did the thing',
              artifacts_produced: [],
              schema_version: 2,
            },
            run_started_at: new Date(Date.now() - 60_000).toISOString(),
            run_completed_at: at,
            applied_at: null,
          },
        ],
      }),
    )
    const before = await snapshotHome(vh.home)

    const r = await capture(['approve', 'p', '--principal', 'ops'])

    expect(r.code).toBe(1)
    expect(r.stderr).toContain('applying a parked result is not recorded with a principal')
    expect(await snapshotHome(vh.home)).toEqual(before)
  })

  test('deny --list --principal ops is refused, because --list records nothing', async () => {
    const before = await snapshotHome(vh.home)

    const r = await capture(['deny', '--list', '--principal', 'ops'])

    expect(r.code).toBe(1)
    expect(r.stderr).toContain('--list records nothing')
    expect(await snapshotHome(vh.home)).toEqual(before)
  })
})

test('approve p --principal ops: a principal disabled while approve waits on the state lock is refused', async () => {
  let open!: () => void
  const gate = new Promise<void>((resolve) => {
    open = resolve
  })
  const held = withStateLockAt(pathsForStateFile(vh.statePath).lockPath, () => gate)

  const pending = capture(['approve', 'p', '--principal', 'ops'])
  // Long enough for approve to reach the lock and wait on it.
  await new Promise((resolve) => setTimeout(resolve, 200))
  const registry = JSON.parse(readFileSync(principalsPath(), 'utf-8')) as {
    principals: { id: string; status: string }[]
  }
  for (const p of registry.principals) if (p.id === 'ops') p.status = 'disabled'
  writeFileSync(principalsPath(), JSON.stringify(registry))
  open()
  await held

  const r = await pending

  expect(r.code).toBe(1)
  expect(r.stderr).toContain('--principal: that principal is disabled')
  expect(auditRecords(vh.home, 'grant.issued').filter((g) => g.principal === 'ops')).toEqual([])
  expect(existsSync(sessionApprovalPath())).toBe(false)
})

describe('no verb reads the account running it', () => {
  const OS_USER = /process\.env\.(USER|LOGNAME|USERNAME)|userInfo\(|os\.userInfo/

  /** The code lines of a source file, comment lines dropped, that match `re`. */
  const offending = (path: string, re: RegExp): string[] =>
    readFileSync(path, 'utf-8')
      .split('\n')
      .filter((text) => !/^\s*(\*|\/\/|\/\*)/.test(text))
      .filter((text) => re.test(text))

  test('approve.ts, deny.ts and resolve.ts hold no code line that reads the OS user', () => {
    for (const verb of ['approve', 'deny', 'resolve']) {
      expect(offending(join(import.meta.dir, '..', `${verb}.ts`), OS_USER)).toEqual([])
    }
  })

  test('the scan finds a planted read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'warpline-principal-flag-fixture-'))
    const path = join(dir, 'verb.ts')
    writeFileSync(path, '/**\n * A planted offender.\n */\nconst who = process.env.USER ?? null\n')

    try {
      expect(offending(path, OS_USER)).toEqual(['const who = process.env.USER ?? null'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
