/**
 * `warpline audit`, in process, through the dispatcher.
 *
 * Each case sets its own home. The preload's home is shared by every
 * in-process CLI test in a `bun test` run, and a head read off a store other
 * files also append to would depend on file order.
 *
 * The expected head is read off disk and hashed here with `node:crypto`, so the
 * check never borrows the writer's own hashing.
 *
 * Everything this file writes goes under temp dirs (AGENTS.md Rule 2).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _setHome } from '../../lib/paths.js'
import { main } from '../warpline.js'

/** Run main(argv) with stdout/stderr captured, always restoring the originals. */
async function capture(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const realOut = process.stdout.write
  const realErr = process.stderr.write
  let stdout = ''
  let stderr = ''
  process.stdout.write = ((chunk: string) => {
    stdout += chunk
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string) => {
    stderr += chunk
    return true
  }) as typeof process.stderr.write
  try {
    const code = await main(argv)
    return { code, stdout, stderr }
  } finally {
    process.stdout.write = realOut
    process.stderr.write = realErr
  }
}

/** Every field spelled out, so the fixture never leans on a schema default. */
const MANIFEST = {
  name: 'p',
  version: '1.0.0',
  description: 'p fixture plugin',
  inputs: {},
  outputs: {},
  capabilities: [],
  secrets: [],
  schedule: 'on_run',
  autonomy_level: 'supervised',
  approval_class: 'session',
  llm_handoff: false,
  side_effects: ['creates_issue'],
  ttl_hours: 24,
  dependencies: [],
  timeout_ms: 5000,
  max_parallelism: 1,
  min_tier: 'normal',
  max_retries: 1,
  retry_delay_ms: 2000,
}

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'warpline-audit-cli-'))
  mkdirSync(join(home, 'plugins', 'p'), { recursive: true })
  writeFileSync(join(home, 'plugins', 'p', 'manifest.ts'), `export const manifest = ${JSON.stringify(MANIFEST)}`)
  mkdirSync(join(home, 'state'), { recursive: true })
  _setHome(home)
})

afterEach(() => {
  _setHome(null)
  rmSync(home, { recursive: true, force: true })
})

/** The last stored line of the last segment, as written. */
function lastLine(): string {
  const dir = join(home, 'audit')
  const segments = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()
  const text = readFileSync(join(dir, segments.at(-1)!), 'utf-8')
  return text.slice(0, -1).split('\n').at(-1)!
}

describe('warpline audit', () => {
  test('audit head on an empty home prints 0 and 64 zeros and creates no store', async () => {
    const { code, stdout, stderr } = await capture(['audit', 'head'])

    expect(code).toBe(0)
    expect(stdout).toBe(`0 ${'0'.repeat(64)}\n`)
    expect(stderr).toBe('')
    expect(existsSync(join(home, 'audit'))).toBe(false)
  })

  test("audit head after a deny prints the last line's seq and the hash of its bytes", async () => {
    const denied = await capture(['deny', 'p'])
    expect(denied.code).toBe(0)

    const { code, stdout, stderr } = await capture(['audit', 'head'])

    const line = lastLine()
    const seq = (JSON.parse(line) as { warplineseq: number }).warplineseq
    expect(code).toBe(0)
    expect(stderr).toBe('')
    expect(stdout).toBe(`${seq} ${createHash('sha256').update(line).digest('hex')}\n`)
  })

  test('audit with no sub-verb exits 1 with usage on stderr and nothing on stdout', async () => {
    const { code, stdout, stderr } = await capture(['audit'])

    expect(code).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toContain('warpline audit head')
  })

  test('audit with an unknown sub-verb exits 1 with usage on stderr and nothing on stdout', async () => {
    const { code, stdout, stderr } = await capture(['audit', 'bogus'])

    expect(code).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toContain('warpline audit head')
  })
})
