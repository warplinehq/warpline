/**
 * The held-out walker agrees with the writer, can disagree, and sees two
 * processes writing one store as one contiguous chain.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { appendFileSync, cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendAudit, readHead } from '../audit-log.js'
import { walkChain } from './helpers/audit-chain.js'

const HELPER = join(import.meta.dir, 'helpers', 'audit-chain.ts')
const STORE = join(import.meta.dir, '..', 'audit-log.ts')
const SPECIFIER =
  /(?<![.\w])(?:(?:from|import)\s*["']|(?:import|require)\s*\(\s*["'`])([^"'`\n]+)["'`]/g
const NAME = /^\d{16}\.jsonl$/

let tmp: string
let statePath: string
let auditDir: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'warpline-audit-chain-'))
  statePath = join(tmp, 'state', 'engine-state.json')
  auditDir = join(tmp, 'audit')
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

const segments = (dir: string) => readdirSync(dir).filter((n) => NAME.test(n)).sort()

/** 30 records over 2048-byte segments, a torn tail, then 3 more: a rotated store with an acknowledged fragment. */
async function rotatedTornStore(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await appendAudit(statePath, 'denial.lifted', { plugin: `p${i}`, fingerprint: null }, { maxSegmentBytes: 2048 })
  }
  const names = segments(auditDir)
  appendFileSync(join(auditDir, names[names.length - 1] as string), '{"specversion":"1.0","id":')
  for (let i = 30; i < 33; i++) {
    await appendAudit(statePath, 'denial.lifted', { plugin: `p${i}`, fingerprint: null }, { maxSegmentBytes: 2048 })
  }
}

describe('the held-out chain walker', () => {
  test('imports nothing from the store it checks', () => {
    const specifiers = [...readFileSync(HELPER, 'utf8').matchAll(SPECIFIER)].map((m) => m[1] as string)
    expect(specifiers.length).toBeGreaterThan(0)
    expect(specifiers.filter((s) => s.includes('audit-log'))).toEqual([])
  })

  test('agrees with readHead on a rotated store with a torn fragment', async () => {
    await rotatedTornStore()

    expect(segments(auditDir).length).toBeGreaterThanOrEqual(3)
    const acknowledged = segments(auditDir).filter((n) =>
      readFileSync(join(auditDir, n), 'utf8').split('\n')[0]!.includes('"fragment":{'),
    )
    expect(acknowledged).toHaveLength(1)

    const walk = walkChain(auditDir)
    if (!walk.ok) throw new Error(`walk failed at ${walk.at}: ${walk.why}`)
    expect(walk.torn).toBe(false)
    const head = await readHead(statePath)
    expect({ seq: walk.head.seq, head: walk.head.hex }).toEqual(head)
    expect(walk.lines).toBe(head.seq)
  })

  test('fails on one byte changed inside the data of a middle line, naming its file', async () => {
    await rotatedTornStore()
    const copy = join(tmp, 'copy')
    cpSync(auditDir, copy, { recursive: true })
    expect(walkChain(copy).ok).toBe(true)

    const middle = segments(copy)[1] as string
    const path = join(copy, middle)
    const bytes = readFileSync(path)
    const text = bytes.toString('utf8')
    const lineStarts = [0, ...[...text.matchAll(/\n/g)].map((m) => m.index! + 1)].slice(0, -1)
    // A record that is not the file's last line, so the line after it sits in the same file.
    const target = lineStarts.slice(0, -1).find((s) => {
      const field = text.indexOf('"plugin":"p', s)
      return field !== -1 && field < text.indexOf('\n', s)
    })
    expect(target).toBeDefined()
    const at = text.indexOf('"plugin":"p', target!) + '"plugin":"'.length
    expect(bytes[at]).toBe('p'.charCodeAt(0))
    bytes[at] = 'q'.charCodeAt(0)
    writeFileSync(path, bytes)

    const walk = walkChain(copy)
    expect(walk.ok).toBe(false)
    if (!walk.ok) expect(walk.at.startsWith(`${middle}:`)).toBe(true)
  })

  test('two processes appending 40 records each leave seq 1..81 contiguous, both writers present', async () => {
    const script = join(tmp, 'writer.ts')
    const go = join(tmp, 'go')
    writeFileSync(
      script,
      [
        `import { existsSync, writeFileSync } from 'node:fs'`,
        `import { appendAudit } from ${JSON.stringify(STORE)}`,
        `const [statePath, go, name] = process.argv.slice(2) as [string, string, string]`,
        `writeFileSync(go + '.' + name, '')`,
        `while (!existsSync(go)) await Bun.sleep(5)`,
        `for (let i = 0; i < 40; i++) await appendAudit(statePath, 'denial.lifted', { plugin: name, fingerprint: null })`,
        '',
      ].join('\n'),
    )
    const run = (name: string) =>
      new Promise<{ code: number | null; stderr: string }>((resolve) => {
        const child = spawn(process.execPath, [script, statePath, go, name], { env: { ...process.env } })
        let stderr = ''
        child.stderr.on('data', (d) => (stderr += d))
        child.on('close', (code) => resolve({ code, stderr }))
      })
    const a = run('alpha')
    const b = run('beta')
    while (!existsSync(`${go}.alpha`) || !existsSync(`${go}.beta`)) await Bun.sleep(5)
    writeFileSync(go, '')
    const results = await Promise.all([a, b])
    expect(results).toEqual([
      { code: 0, stderr: '' },
      { code: 0, stderr: '' },
    ])

    const walk = walkChain(auditDir)
    if (!walk.ok) throw new Error(`walk failed at ${walk.at}: ${walk.why}`)
    expect(walk.lines).toBe(81)
    expect(walk.head.seq).toBe(81)

    const records = segments(auditDir).flatMap((n) =>
      readFileSync(join(auditDir, n), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { warplineseq: number; type: string; data: { plugin?: string } }),
    )
    expect(records.map((r) => r.warplineseq)).toEqual(Array.from({ length: 81 }, (_, i) => i + 1))
    const per = (name: string) =>
      records.filter((r) => r.type === 'warpline.audit.denial.lifted' && r.data.plugin === name).length
    expect([per('alpha'), per('beta')]).toEqual([40, 40])
    expect(existsSync(join(auditDir, '.lock'))).toBe(false)
  })
})
