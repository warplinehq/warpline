import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { writeFile, mkdir, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  checkApproval,
  grantApproval,
  revokeApproval,
  mergeGrant,
  MAX_GRANT_WINDOW_MS,
} from '../approval-gate.js'
import { runAdvance } from '../engine.js'
import type { PluginManifest } from '../../schemas/plugin-manifest.js'

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
    const result = await checkApproval('enrich.issue-render', approvalPath)
    expect(result).toBe(false)
  })

  test('returns true when valid approval file exists with matching scope', async () => {
    await grantApproval('enrich.issue-render', 4 * 60 * 60 * 1000, approvalPath)
    const result = await checkApproval('enrich.issue-render', approvalPath)
    expect(result).toBe(true)
  })

  test('returns false when approval file is expired (> 4 hours old)', async () => {
    const expired = {
      granted_at: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
      expires_at: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(), // 1 hour ago
      scopes: ['enrich.issue-render'],
    }
    await writeFile(approvalPath, JSON.stringify(expired))
    const result = await checkApproval('enrich.issue-render', approvalPath)
    expect(result).toBe(false)
  })

  test('returns false when scope does not match', async () => {
    await grantApproval('ops.digest-sender', 4 * 60 * 60 * 1000, approvalPath)
    const result = await checkApproval('enrich.issue-render', approvalPath)
    expect(result).toBe(false)
  })

  test('returns true when scopes is wildcard "*"', async () => {
    await grantApproval('*', 4 * 60 * 60 * 1000, approvalPath)
    const result = await checkApproval('enrich.issue-render', approvalPath)
    expect(result).toBe(true)
  })
})

describe('grantApproval', () => {
  test('creates file with granted_at, expires_at, scopes fields', async () => {
    const before = Date.now()
    await grantApproval('enrich.issue-render', 4 * 60 * 60 * 1000, approvalPath)
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
    await grantApproval(['enrich.issue-render', 'ops.digest-sender'], 4 * 60 * 60 * 1000, approvalPath)
    const raw = JSON.parse(await Bun.file(approvalPath).text())
    expect(Array.isArray(raw.scopes)).toBe(true)
    expect(raw.scopes).toContain('enrich.issue-render')
    expect(raw.scopes).toContain('ops.digest-sender')
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
    await grantApproval('enrich.issue-render', shortTtl, approvalPath)
    const raw = JSON.parse(await Bun.file(approvalPath).text())
    const grantedAt = new Date(raw.granted_at).getTime()
    const expiresAt = new Date(raw.expires_at).getTime()
    const diff = expiresAt - grantedAt
    // Should be close to 1 minute (within 100ms tolerance)
    expect(diff).toBeGreaterThanOrEqual(shortTtl - 100)
    expect(diff).toBeLessThanOrEqual(shortTtl + 100)
  })
})

// ---------------------------------------------------------------------------
// mergeGrant — additive grants under a first-grant ceiling
// ---------------------------------------------------------------------------

const HOUR = 60 * 60 * 1000
const iso = (ms: number) => new Date(ms).toISOString()
const readGrant = async () => JSON.parse(await Bun.file(approvalPath).text())

/** A fixed wall clock, so every ceiling assertion is an exact equality. */
const T0 = Date.UTC(2026, 7, 20, 12, 0, 0)

describe('mergeGrant', () => {
  test('1: granting a then b unions the scopes sorted and preserves expires_at', async () => {
    const first = await mergeGrant('b', { now: T0 }, approvalPath)
    const second = await mergeGrant('a', { now: T0 + 60_000 }, approvalPath)

    const raw = await readGrant()
    expect(raw.scopes).toEqual(['a', 'b'])
    expect(raw.expires_at).toBe(first.expires_at)
    expect(second.expires_at).toBe(first.expires_at)
    expect(second.capped).toBe(false)
    expect(second.extended).toBe(false)
  })

  test('2: first_granted_at is the FIRST grant timestamp, granted_at the latest', async () => {
    await mergeGrant('a', { now: T0 }, approvalPath)
    await mergeGrant('b', { now: T0 + 60_000 }, approvalPath)

    const raw = await readGrant()
    expect(raw.first_granted_at).toBe(iso(T0))
    expect(raw.granted_at).toBe(iso(T0 + 60_000))
  })

  test('3: a legacy grant with no first_granted_at treats granted_at as first issue', async () => {
    await writeFile(
      approvalPath,
      JSON.stringify({
        granted_at: iso(T0),
        expires_at: iso(T0 + 4 * HOUR),
        scopes: ['a'],
      }),
    )

    const result = await mergeGrant('b', { now: T0 + 60_000 }, approvalPath)

    expect(result.first_granted_at).toBe(iso(T0))
    expect(result.scopes).toEqual(['a', 'b'])
    expect((await readGrant()).first_granted_at).toBe(iso(T0))
  })

  test('4: a TTL past first_granted_at + 24h is capped, and the cap is reported', async () => {
    await mergeGrant('a', { now: T0 }, approvalPath)

    const result = await mergeGrant('a', { ttlMs: 30 * 24 * HOUR, now: T0 + 1000 }, approvalPath)

    expect(result.capped).toBe(true)
    expect(result.extended).toBe(false)
    expect(result.expires_at).toBe(iso(T0 + MAX_GRANT_WINDOW_MS))
    expect((await readGrant()).expires_at).toBe(iso(T0 + MAX_GRANT_WINDOW_MS))
  })

  test('5: an explicit long-lived merge exceeds the ceiling and reports the extension', async () => {
    await mergeGrant('a', { now: T0 }, approvalPath)

    const result = await mergeGrant(
      'a',
      { ttlMs: 30 * 24 * HOUR, long: true, now: T0 + 1000 },
      approvalPath,
    )

    expect(result.extended).toBe(true)
    expect(result.capped).toBe(false)
    expect(result.expires_at).toBe(iso(T0 + 1000 + 30 * 24 * HOUR))
  })

  test('6: replace overwrites the scopes and resets expires_at, keeping first_granted_at', async () => {
    await mergeGrant(['a', 'b'], { ttlMs: HOUR, now: T0 }, approvalPath)

    const result = await mergeGrant(
      'c',
      { replace: true, ttlMs: 2 * HOUR, now: T0 + 1000 },
      approvalPath,
    )

    expect(result.scopes).toEqual(['c'])
    expect(result.first_granted_at).toBe(iso(T0))
    expect(result.expires_at).toBe(iso(T0 + 1000 + 2 * HOUR))
    expect((await readGrant()).scopes).toEqual(['c'])
  })

  test('a wildcard absorbs named scopes in either merge direction', async () => {
    await mergeGrant('a', { now: T0 }, approvalPath)
    expect((await mergeGrant('*', { now: T0 + 1000 }, approvalPath)).scopes).toBe('*')
    expect((await mergeGrant('b', { now: T0 + 2000 }, approvalPath)).scopes).toBe('*')
  })

  test('an expired grant is not merged onto — the window restarts', async () => {
    await mergeGrant('a', { ttlMs: HOUR, now: T0 }, approvalPath)

    const later = T0 + 2 * HOUR
    const result = await mergeGrant('b', { now: later }, approvalPath)

    expect(result.scopes).toEqual(['b'])
    expect(result.first_granted_at).toBe(iso(later))
  })

  test('7: the existing three-argument grantApproval call shape is unchanged', async () => {
    await grantApproval('enrich.issue-render', 60_000, approvalPath)

    const raw = await readGrant()
    expect(raw.scopes).toEqual(['enrich.issue-render'])
    expect(raw.first_granted_at).toBe(raw.granted_at)
    expect(new Date(raw.expires_at).getTime() - new Date(raw.granted_at).getTime()).toBe(60_000)
    expect(await checkApproval('enrich.issue-render', approvalPath)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 8: prohibition — nothing reachable from runAdvance() writes the grant file
// ---------------------------------------------------------------------------

function sideEffectManifest(name: string, sideEffects: string[]): PluginManifest {
  return {
    name,
    version: '1.0.0',
    description: `${name} fixture plugin`,
    inputs: {},
    outputs: {},
    capabilities: [],
    schedule: 'on_run',
    autonomy_level: 'autonomous',
    side_effects: sideEffects as PluginManifest['side_effects'],
    ttl_hours: 24,
    dependencies: [],
    timeout_ms: 5000,
    max_parallelism: 1,
    min_tier: 'normal',
    max_retries: 1,
    retry_delay_ms: 2000,
  }
}

const FIXTURE_HANDLER = `
export async function handler(_manifest, _args) {
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
`

describe('run-path prohibition', () => {
  test('8: a full engine advance leaves the grant file byte- and mtime-identical', async () => {
    const pluginsDir = join(tmpDir, 'plugins')
    const stateDir = join(tmpDir, 'state')
    const runsDir = join(tmpDir, 'runs')
    await mkdir(stateDir, { recursive: true })
    await mkdir(runsDir, { recursive: true })

    // Two side-effecting plugins: one approved, one not. Both arms of the gate
    // are exercised in a single advance.
    for (const m of [
      sideEffectManifest('fx-approved', ['creates_issue']),
      sideEffectManifest('fx-unapproved', ['sends_email']),
    ]) {
      const dir = join(pluginsDir, m.name)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'manifest.ts'), `export const manifest = ${JSON.stringify(m)}`)
      await writeFile(join(dir, 'handler.ts'), FIXTURE_HANDLER)
    }
    await writeFile(join(stateDir, 'preferences.json'), JSON.stringify({ review_gate: false }))

    await mergeGrant('fx-approved', {}, approvalPath)
    const before = await Bun.file(approvalPath).text()
    const beforeStat = await stat(approvalPath)

    const result = await runAdvance({
      pluginsDir,
      stateDir: join(stateDir, 'engine-state.json'),
      runsDir,
      eventsPath: join(runsDir, 'events.jsonl'),
      preferencesPath: join(stateDir, 'preferences.json'),
      approvalPath,
    })

    // The gate actually fired — otherwise the assertion below is vacuous.
    expect(result.plugin_states.get('fx-approved')).toBe('completed')
    expect(result.plugin_states.get('fx-unapproved')).toBe('skipped')

    expect(await Bun.file(approvalPath).text()).toBe(before)
    const afterStat = await stat(approvalPath)
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs)
  })
})
