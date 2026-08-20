import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { writeFile, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { checkApproval, grantApproval, revokeApproval } from '../approval-gate.js'

let tmpDir: string
let approvalPath: string

beforeEach(async () => {
  tmpDir = join(tmpdir(), `warpline-approval-test-${Date.now()}`)
  await mkdir(tmpDir, { recursive: true })
  approvalPath = join(tmpDir, '.session-approval')
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('checkApproval', () => {
  test('returns false when no approval file exists', async () => {
    const result = await checkApproval('enrich.render-issue', approvalPath)
    expect(result).toBe(false)
  })

  test('returns true when valid approval file exists with matching scope', async () => {
    await grantApproval('enrich.render-issue', 4 * 60 * 60 * 1000, approvalPath)
    const result = await checkApproval('enrich.render-issue', approvalPath)
    expect(result).toBe(true)
  })

  test('returns false when approval file is expired (> 4 hours old)', async () => {
    const expired = {
      granted_at: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
      expires_at: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(), // 1 hour ago
      scopes: ['enrich.render-issue'],
    }
    await writeFile(approvalPath, JSON.stringify(expired))
    const result = await checkApproval('enrich.render-issue', approvalPath)
    expect(result).toBe(false)
  })

  test('returns false when scope does not match', async () => {
    await grantApproval('ops.outreach-generator', 4 * 60 * 60 * 1000, approvalPath)
    const result = await checkApproval('enrich.render-issue', approvalPath)
    expect(result).toBe(false)
  })

  test('returns true when scopes is wildcard "*"', async () => {
    await grantApproval('*', 4 * 60 * 60 * 1000, approvalPath)
    const result = await checkApproval('enrich.render-issue', approvalPath)
    expect(result).toBe(true)
  })
})

describe('grantApproval', () => {
  test('creates file with granted_at, expires_at, scopes fields', async () => {
    const before = Date.now()
    await grantApproval('enrich.render-issue', 4 * 60 * 60 * 1000, approvalPath)
    const after = Date.now()

    expect(existsSync(approvalPath)).toBe(true)
    const raw = JSON.parse(await Bun.file(approvalPath).text())
    expect(raw.granted_at).toBeDefined()
    expect(raw.expires_at).toBeDefined()
    expect(raw.scopes).toBeDefined()

    const grantedAt = new Date(raw.granted_at).getTime()
    expect(grantedAt).toBeGreaterThanOrEqual(before)
    expect(grantedAt).toBeLessThanOrEqual(after)
  })

  test('stores array of scopes when given array', async () => {
    await grantApproval(['enrich.render-issue', 'ops.outreach-generator'], 4 * 60 * 60 * 1000, approvalPath)
    const raw = JSON.parse(await Bun.file(approvalPath).text())
    expect(Array.isArray(raw.scopes)).toBe(true)
    expect(raw.scopes).toContain('enrich.render-issue')
    expect(raw.scopes).toContain('ops.outreach-generator')
  })
})

describe('revokeApproval', () => {
  test('deletes the approval file', async () => {
    await grantApproval('*', 4 * 60 * 60 * 1000, approvalPath)
    expect(existsSync(approvalPath)).toBe(true)
    await revokeApproval(approvalPath)
    expect(existsSync(approvalPath)).toBe(false)
  })

  test('is no-op when file does not exist (does not throw)', async () => {
    await expect(revokeApproval(approvalPath)).resolves.toBeUndefined()
  })

  test('custom TTL overrides default 4 hours', async () => {
    const shortTtl = 60 * 1000 // 1 minute
    await grantApproval('enrich.render-issue', shortTtl, approvalPath)
    const raw = JSON.parse(await Bun.file(approvalPath).text())
    const grantedAt = new Date(raw.granted_at).getTime()
    const expiresAt = new Date(raw.expires_at).getTime()
    const diff = expiresAt - grantedAt
    // Should be close to 1 minute (within 100ms tolerance)
    expect(diff).toBeGreaterThanOrEqual(shortTtl - 100)
    expect(diff).toBeLessThanOrEqual(shortTtl + 100)
  })
})
