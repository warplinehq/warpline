/**
 * Two writers that both find a crashed holder's stale lock must not both take it.
 *
 * The fork needs a waiter that judged the lock stale before the first breaker
 * removed it, and that removes it after the first breaker took it. That waiter
 * removes a lock that is still held, so the first writer's hold has to be
 * long. The drive below builds exactly that, on purpose:
 *
 * - The stale lock is padded to 32,000,000 bytes. That stretches every
 *   waiter's read of it, the way a slow disk would.
 * - The second writer starts 3 ms after the first. Its open of the padded file
 *   comes before the first writer's removal, and the end of its read comes
 *   after the first writer has taken the lock again.
 * - The active segment holds 10,000 lines and both writers pass
 *   `maxSegmentBytes: 1`, so the first writer's hold is a rotation: a full walk
 *   of the segment. The second waiter's removal lands while that lock is held.
 *
 * Measured at planning on the tree before the break file, with this exact
 * drive (32 MB, 3 ms, 10,000 lines, two writers): 5 of 5 rounds forked, each
 * leaving 10,010 lines with a repeated seq. On a 40,000-line segment, without
 * the padding, or with no stagger, 0 of 5 forked. So none of the three may be
 * dropped.
 *
 * Everything this file writes goes under temp dirs (AGENTS.md Rule 2).
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendAudit } from '../audit-log.js'
import { walkChain } from './helpers/audit-chain.js'

const STORE = join(import.meta.dir, '..', 'audit-log.ts')
const NAME = /^\d{16}\.jsonl$/
const LINES = 10_000
const LOCK_BYTES = 32_000_000
const STAGGER_MS = 3
const ROUNDS = 3

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'warpline-audit-lock-break-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

/** A seeded store, then LINES chain-valid `denial.lifted` lines appended to its active segment in one write. */
async function longSegment(statePath: string, auditDir: string): Promise<void> {
  await appendAudit(statePath, 'denial.lifted', { plugin: 'seed', fingerprint: null })
  const active = join(auditDir, readdirSync(auditDir).filter((n) => NAME.test(n)).sort().at(-1)!)
  const text = readFileSync(active, 'utf-8')
  let before = text.slice(0, -1).split('\n').at(-1)!
  const last = JSON.parse(before) as { warplineseq: number; source: string }
  const out: string[] = []
  for (let i = 1; i <= LINES; i++) {
    const seq = last.warplineseq + i
    const line = JSON.stringify({
      specversion: '1.0',
      id: String(seq),
      source: last.source,
      type: 'warpline.audit.denial.lifted',
      time: new Date().toISOString(),
      datacontenttype: 'application/json',
      warplineseq: seq,
      warplineprev: sha256(before),
      data: { plugin: `p${i}`, fingerprint: null },
    })
    out.push(`${line}\n`)
    before = line
  }
  appendFileSync(active, out.join(''))
}

/** A crashed holder's lock, 31 s old by the time it holds, padded to LOCK_BYTES. */
function staleLock(auditDir: string): void {
  const bare = JSON.stringify({ token: 'crashed', at: Date.now() - 31_000, pad: '' })
  const lock = JSON.stringify({ token: 'crashed', at: Date.now() - 31_000, pad: 'x'.repeat(LOCK_BYTES - bare.length) })
  expect(lock.length).toBe(LOCK_BYTES)
  writeFileSync(join(auditDir, '.lock'), lock)
}

test("two writers on a crashed holder's stale lock leave one chain", async () => {
  const script = join(tmp, 'writer.ts')
  writeFileSync(
    script,
    [
      `import { appendAudit } from ${JSON.stringify(STORE)}`,
      `const [statePath, at, name] = process.argv.slice(2) as [string, string, string]`,
      `const start = Number(at)`,
      `while (performance.timeOrigin + performance.now() < start) {}`,
      `await appendAudit(statePath, 'denial.lifted', { plugin: name, fingerprint: null }, { maxSegmentBytes: 1 })`,
      '',
    ].join('\n'),
  )
  const run = (statePath: string, at: number, name: string) =>
    new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [script, statePath, String(at), name], { env: { ...process.env } })
      let stderr = ''
      child.stderr.on('data', (d) => (stderr += d))
      child.on('close', (code) => resolve({ code, stderr }))
    })

  for (let round = 1; round <= ROUNDS; round++) {
    const home = join(tmp, `round-${round}`)
    const statePath = join(home, 'state', 'engine-state.json')
    const auditDir = join(home, 'audit')
    await longSegment(statePath, auditDir)
    staleLock(auditDir)

    const start = Date.now() + 500
    const results = await Promise.all([run(statePath, start, 'alpha'), run(statePath, start + STAGGER_MS, 'beta')])
    expect(results).toEqual([
      { code: 0, stderr: '' },
      { code: 0, stderr: '' },
    ])

    const walk = walkChain(auditDir)
    if (!walk.ok) throw new Error(`round ${round}: walk failed at ${walk.at}: ${walk.why}`)
    expect(walk.lines).toBe(LINES + 10)
    const seqs = readdirSync(auditDir)
      .filter((n) => NAME.test(n))
      .flatMap((n) => readFileSync(join(auditDir, n), 'utf-8').split('\n').filter(Boolean))
      .map((l) => (JSON.parse(l) as { warplineseq: number }).warplineseq)
    expect(new Set(seqs).size).toBe(seqs.length)
    expect(existsSync(join(auditDir, '.lock'))).toBe(false)
    expect(existsSync(join(auditDir, '.lock.break'))).toBe(false)
  }
}, 120_000)
