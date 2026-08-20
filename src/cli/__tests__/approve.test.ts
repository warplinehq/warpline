/**
 * `warpline approve` / `warpline revoke` — in-process CLI tests (D-27).
 *
 * Both subcommands resolve their paths through `src/lib/paths.ts` accessors,
 * so `_setHome()` is the whole injection story: no argument plumbing, no
 * subprocess. The fixture `manifest.ts` files are written as a bare
 * `export const manifest = {…}` with ZERO imports, which keeps them out of the
 * `warpline/schemas/*` resolution path entirely.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { _setHome, sessionApprovalPath } from '../../lib/paths.js'
import { checkApproval, mergeGrant } from '../../runtime/approval-gate.js'
import type { PluginManifest } from '../../schemas/plugin-manifest.js'

let root: string
let approvalPath: string

function makeManifest(name: string, sideEffects: string[]): PluginManifest {
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

/**
 * Three plugins declaring four side effects in total, so Test 4's two printed
 * integers are distinguishable from each other.
 */
const FIXTURES = [
  makeManifest('render-issue', ['creates_issue']),
  makeManifest('digest-sender', ['sends_email', 'external_api']),
  makeManifest('quiet-plugin', []),
  makeManifest('db-writer', ['writes_db']),
]

/** Run a subcommand's `run(argv)` with stdout/stderr captured. */
async function capture(
  mod: 'approve' | 'revoke',
  argv: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
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
    const { run } = mod === 'approve' ? await import('../approve.js') : await import('../revoke.js')
    const code = await run(argv)
    return { code, stdout, stderr }
  } finally {
    process.stdout.write = realOut
    process.stderr.write = realErr
  }
}

const readGrant = async () => JSON.parse(await readFile(approvalPath, 'utf-8'))

beforeEach(async () => {
  root = join(tmpdir(), `warpline-approve-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  const pluginsDir = join(root, 'plugins')
  await mkdir(pluginsDir, { recursive: true })
  for (const m of FIXTURES) {
    const dir = join(pluginsDir, m.name)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'manifest.ts'), `export const manifest = ${JSON.stringify(m)}`)
  }
  _setHome(root)
  approvalPath = sessionApprovalPath()
})

afterEach(async () => {
  _setHome(null)
  await rm(root, { recursive: true, force: true })
})

describe('warpline approve', () => {
  test('1: `approve <name>` writes exactly that scope and returns 0', async () => {
    const { code, stderr } = await capture('approve', ['render-issue'])

    expect(code).toBe(0)
    expect(stderr).toBe('')
    expect((await readGrant()).scopes).toEqual(['render-issue'])
    expect(await checkApproval('render-issue', approvalPath)).toBe(true)
    expect(await checkApproval('digest-sender', approvalPath)).toBe(false)
  })

  test('2: one unknown name aborts the whole command and writes nothing', async () => {
    // Pre-existing grant, so "wrote nothing" is a byte comparison rather than
    // an absence check — the stronger of the two.
    await mergeGrant('db-writer', {}, approvalPath)
    const before = await readFile(approvalPath, 'utf-8')

    const { code, stdout, stderr } = await capture('approve', ['render-issue', 'render-isue'])

    expect(code).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toContain('render-isue')
    expect(stderr).toContain('render-issue') // the suggestion names a close match
    expect(await readFile(approvalPath, 'utf-8')).toBe(before)
  })

  test('3: no names and no --all prints usage and returns 1', async () => {
    const { code, stdout, stderr } = await capture('approve', [])

    expect(code).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toContain('Usage')
    expect(existsSync(approvalPath)).toBe(false)
  })

  test('4: --all grants the blanket scope and states its coverage counts', async () => {
    const { code, stdout } = await capture('approve', ['--all'])

    expect(code).toBe(0)
    expect((await readGrant()).scopes).toBe('*')

    // Two distinct integers: 3 side-effecting plugins, 4 declared side effects.
    const warning = stdout.split('\n').find((l) => /\d/.test(l) && /plugin/i.test(l)) ?? ''
    const ints = (warning.match(/\d+/g) ?? []).map(Number)
    expect(ints).toContain(3)
    expect(ints).toContain(4)
    expect(stdout.toLowerCase()).toContain('blanket')
  })

  test('5: --ttl 0, a negative TTL and garbage all return 1 and write nothing', async () => {
    for (const ttl of ['0', '0m', '-1h', 'garbage', '4', '4y']) {
      const { code, stdout, stderr } = await capture('approve', ['render-issue', '--ttl', ttl])
      expect(code).toBe(1)
      expect(stdout).toBe('')
      expect(stderr).toContain('--ttl')
      expect(existsSync(approvalPath)).toBe(false)
    }
  })

  test('6: --ttl 30d without --long is capped at the first-grant ceiling', async () => {
    await capture('approve', ['render-issue', '--ttl', '1h'])
    const firstGrantedAt = new Date((await readGrant()).first_granted_at).getTime()

    const { code, stdout } = await capture('approve', ['render-issue', '--ttl', '30d'])

    expect(code).toBe(0)
    const expiresAt = new Date((await readGrant()).expires_at).getTime()
    expect(expiresAt).toBe(firstGrantedAt + 24 * 60 * 60 * 1000)
    expect(stdout.toLowerCase()).toContain('capped')
  })

  test('6b: --ttl 30d with --long is permitted and the extension is printed', async () => {
    await capture('approve', ['render-issue', '--ttl', '1h'])

    const { code, stdout } = await capture('approve', ['render-issue', '--ttl', '30d', '--long'])

    expect(code).toBe(0)
    expect(stdout.toLowerCase()).toContain('beyond')
    const raw = await readGrant()
    const ceiling = new Date(raw.first_granted_at).getTime() + 24 * 60 * 60 * 1000
    expect(new Date(raw.expires_at).getTime()).toBeGreaterThan(ceiling)
  })

  test('7: --replace overwrites the scope list rather than unioning it', async () => {
    await capture('approve', ['render-issue'])
    await capture('approve', ['db-writer'])
    expect((await readGrant()).scopes).toEqual(['db-writer', 'render-issue'])

    const { code } = await capture('approve', ['quiet-plugin', '--replace'])

    expect(code).toBe(0)
    expect((await readGrant()).scopes).toEqual(['quiet-plugin'])
  })

  test('8: an unknown flag is rejected by strict parsing with return 1', async () => {
    const { code, stdout, stderr } = await capture('approve', ['render-issue', '--yolo'])

    expect(code).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toContain('yolo')
    expect(existsSync(approvalPath)).toBe(false)
  })

  test('scopes are printed and stored in sorted order', async () => {
    await capture('approve', ['render-issue'])
    const { stdout } = await capture('approve', ['db-writer'])

    expect((await readGrant()).scopes).toEqual(['db-writer', 'render-issue'])
    expect(stdout.indexOf('db-writer')).toBeLessThan(stdout.indexOf('render-issue'))
  })

  test('10: printed remaining time is rounded down to whole minutes', async () => {
    const { stdout } = await capture('approve', ['render-issue', '--ttl', '90m'])

    expect(stdout).toMatch(/\b90m\b/)
    expect(stdout).not.toMatch(/\d+\.\d+m/)
  })
})

describe('warpline revoke', () => {
  test('9: revoke deletes the grant and checkApproval reports false afterwards', async () => {
    await capture('approve', ['render-issue'])
    expect(await checkApproval('render-issue', approvalPath)).toBe(true)

    const { code, stdout, stderr } = await capture('revoke', [])

    expect(code).toBe(0)
    expect(stderr).toBe('')
    expect(stdout.length).toBeGreaterThan(0)
    expect(existsSync(approvalPath)).toBe(false)
    expect(await checkApproval('render-issue', approvalPath)).toBe(false)
  })

  test('9b: revoke with no grant present returns 0 and does not throw', async () => {
    const { code } = await capture('revoke', [])
    expect(code).toBe(0)
    expect(existsSync(approvalPath)).toBe(false)
  })
})
