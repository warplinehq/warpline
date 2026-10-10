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
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as audit from '../../lib/audit-log.js'
import { auditRecords, capture, makeVerbHome, restoreSpies, seedPrincipals, type VerbHome } from './helpers/verb-home.js'

let vh: VerbHome
let saved: { principal: string | undefined; user: string | undefined }

beforeEach(async () => {
  vh = makeVerbHome()
  await seedPrincipals([
    ['ops', 'human'],
    ['ci', 'machine'],
  ])
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
