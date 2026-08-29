/**
 * `warpline approve` / `warpline revoke` — in-process CLI tests.
 *
 * Both subcommands resolve their paths through `src/lib/paths.ts` accessors,
 * so `_setHome()` is the whole injection story: no argument plumbing, no
 * subprocess. The fixture `manifest.ts` files are written as a bare
 * `export const manifest = {…}` with ZERO imports, which keeps them out of the
 * `warpline/schemas/*` resolution path entirely.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, readdir, rm, stat, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { _setHome, sessionApprovalPath } from '../../lib/paths.js'
import { checkApproval, mergeGrant } from '../../runtime/approval-gate.js'
import { invokePlugin } from '../../runtime/invoke-plugin.js'
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

/**
 * `warpline approve` when a parked gate is waiting.
 *
 * The verb now answers two different gates with one word, and the whole risk
 * lives in which one it picks. Merging a Grant when the operator meant "apply
 * that parked result" leaves the plugin due, so it runs again and re-fires side
 * effects that already fired — the handler runs BEFORE the supervision gate
 * sees the result, so approval can never be permission to re-run. The reverse
 * mistake leaves no Grant and records a skip on the next advance: annoying, not
 * dangerous. Hence gate-first.
 *
 * The grant file is the other half. An outcome review must not mint or extend
 * side-effect authority, so the gate-apply branch reaches no symbol in
 * `approval-gate.ts` at all — the snapshot cases below are a backstop on a
 * property the structure already guarantees, not the guarantee itself.
 */
describe('warpline approve — parked gates', () => {
  let statePath: string
  let eventsPath: string
  let marker: string

  /**
   * Every file under `dir`, recursively, as `path|bytes|sha256|mtimeMs`.
   *
   * Copied from `plan-prohibition.test.ts` rather than exported from it: that
   * file's walker is deliberately local, and a shared one invites an exclusion
   * list, which is the moment a prohibition test stops proving anything.
   */
  async function snapshotHome(dir: string): Promise<string[]> {
    const out: string[] = []
    async function walk(current: string, prefix: string): Promise<void> {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const child = join(current, entry.name)
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          await walk(child, rel)
          continue
        }
        const [bytes, info] = await Promise.all([readFile(child), stat(child)])
        out.push(
          `${rel}|${bytes.byteLength}|${createHash('sha256').update(bytes).digest('hex')}|${info.mtimeMs}`,
        )
      }
    }
    await walk(dir, '')
    return out.sort()
  }

  /** A supervised plugin whose handler records, on disk, that it ran. */
  async function writeGatedPlugin(
    name: string,
    overrides: Record<string, unknown> = {},
  ): Promise<void> {
    const dir = join(root, 'plugins', name)
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'manifest.ts'),
      `export const manifest = ${JSON.stringify({
        ...makeManifest(name, ['sends_email']),
        autonomy_level: 'supervised',
        ...overrides,
      })}`,
    )
    await writeFile(
      join(dir, 'handler.ts'),
      `
import { appendFileSync } from 'node:fs'
export async function handler() {
  appendFileSync(${JSON.stringify(marker)}, 'ran\\n')
  return {
    status: 'success',
    phases_completed: ['${name}'],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: '${name} did the thing',
    artifacts_produced: [],
    schema_version: 2,
  }
}
`,
    )
  }

  const RESULT = {
    status: 'success' as const,
    phases_completed: ['gated-writer'],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: 'sent the weekly digest',
    artifacts_produced: [
      {
        type: 'brief',
        format: 'markdown' as const,
        path: 'digest.md',
        run_id: 'run-a',
        produced_at: '2026-08-29T10:00:00.000Z',
      },
    ],
    schema_version: 2,
  }

  /** Seed a state document holding one parked gate, with the clocks the caller wants. */
  async function seedGate(
    plugin: string,
    clocks: { startedAgoMs: number; completedAgoMs: number },
    extra: { pluginRuns?: Record<string, unknown>; appliedAt?: string | null } = {},
  ): Promise<{ startedAt: string; completedAt: string }> {
    const startedAt = new Date(Date.now() - clocks.startedAgoMs).toISOString()
    const completedAt = new Date(Date.now() - clocks.completedAgoMs).toISOString()
    await mkdir(join(root, 'state'), { recursive: true })
    await writeFile(
      statePath,
      JSON.stringify({
        schema_version: 1,
        plugin_runs: {
          [plugin]: { last_run_at: completedAt, status: 'gated' },
          ...extra.pluginRuns,
        },
        pending_gates: [
          {
            plugin,
            run_id: 'run-a',
            created_at: completedAt,
            payload_summary: RESULT.summary,
            plugin_result: RESULT,
            run_started_at: startedAt,
            run_completed_at: completedAt,
            applied_at: extra.appliedAt ?? null,
          },
        ],
      }),
    )
    return { startedAt, completedAt }
  }

  const readState = async () => JSON.parse(await readFile(statePath, 'utf-8'))
  const readEvents = async () =>
    (await readFile(eventsPath, 'utf-8')).split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l))

  beforeEach(async () => {
    statePath = join(root, 'state', 'engine-state.json')
    eventsPath = join(root, 'state', 'events.jsonl')
    marker = join(root, 'invocations.log')
  })

  test('11: applying a parked gate does not invoke the plugin handler', async () => {
    await writeGatedPlugin('gated-writer')
    await seedGate('gated-writer', { startedAgoMs: 60_000, completedAgoMs: 30_000 })

    const { code, stdout } = await capture('approve', ['gated-writer'])

    expect(code).toBe(0)
    expect(stdout.toLowerCase()).toContain('parked result')
    expect(existsSync(marker)).toBe(false)

    // Non-vacuity: the handler EXISTS and the marker mechanism works. Without
    // this, "the marker is absent" would also pass for a fixture that could
    // never have written one.
    await invokePlugin('gated-writer', {}, { pluginsDir: join(root, 'plugins') })
    expect(existsSync(marker)).toBe(true)
  })

  test('12: after an apply, plugin_runs is anchored at the gated run, not at approval time', async () => {
    await writeGatedPlugin('gated-writer')
    const { completedAt } = await seedGate('gated-writer', {
      startedAgoMs: 60_000,
      completedAgoMs: 30_000,
    })

    const { code } = await capture('approve', ['gated-writer'])
    expect(code).toBe(0)

    const entry = (await readState()).plugin_runs['gated-writer']
    expect(entry.last_run_at).toBe(completedAt)
    expect(new Date(entry.last_run_at).getTime()).toBeLessThan(Date.now() - 20_000)
    // The gated entry is overwritten IN PLACE: same anchor, real terminal
    // status, and the Output pointer the run already carried.
    expect(entry.status).toBe('success')
    expect(entry.last_output.path).toBe('digest.md')
  })

  test('13: the second apply of the same gate is refused and mutates nothing', async () => {
    await writeGatedPlugin('gated-writer')
    await seedGate('gated-writer', { startedAgoMs: 60_000, completedAgoMs: 30_000 })

    expect((await capture('approve', ['gated-writer'])).code).toBe(0)
    const after = await readFile(statePath, 'utf-8')

    const { code, stdout, stderr } = await capture('approve', ['gated-writer'])

    expect(code).toBe(1)
    expect(stdout).toBe('')
    expect(stderr.toLowerCase()).toContain('already')
    expect(await readFile(statePath, 'utf-8')).toBe(after)
    expect(existsSync(approvalPath)).toBe(false)
  })

  test('14: a gate whose dependency re-ran since the gated run started is refused and discarded', async () => {
    await writeGatedPlugin('gated-writer', { dependencies: ['render-issue'] })
    await seedGate(
      'gated-writer',
      { startedAgoMs: 60_000, completedAgoMs: 30_000 },
      // The dependency ran AFTER the gated run began: the parked result was
      // computed against inputs that have since moved.
      { pluginRuns: { 'render-issue': { last_run_at: new Date(Date.now() - 10_000).toISOString(), status: 'success' } } },
    )

    const { code, stderr } = await capture('approve', ['gated-writer'])

    expect(code).toBe(1)
    expect(stderr.toLowerCase()).toContain('dependency')

    const state = await readState()
    expect(state.pending_gates).toEqual([])
    // Due again on the next advance: the parked result was never accepted, so
    // there is no accepted run to hold the plugin back.
    expect(state.plugin_runs['gated-writer']).toBeUndefined()

    const events = await readEvents()
    const discard = events.find((e) => JSON.parse(e.metadata_json ?? '{}').event === 'gate_invalidated')
    expect(discard).toBeDefined()
    expect(discard.summary).toContain('gated-writer')
    expect(existsSync(approvalPath)).toBe(false)
  })

  test('15: a gate older than min(ttl_hours, 24h) is expired and refused, on seeded clocks', async () => {
    const HOUR = 60 * 60 * 1000
    // ttl_hours 48 so the 24h ceiling — not the TTL — is what expires it.
    await writeGatedPlugin('gated-writer', { ttl_hours: 48 })
    await seedGate('gated-writer', { startedAgoMs: 26 * HOUR, completedAgoMs: 25 * HOUR })

    const { code, stderr } = await capture('approve', ['gated-writer'])

    expect(code).toBe(1)
    expect(stderr.toLowerCase()).toContain('expired')

    const state = await readState()
    expect(state.pending_gates).toEqual([])
    expect(state.plugin_runs['gated-writer']).toBeUndefined()

    const events = await readEvents()
    expect(events.some((e) => JSON.parse(e.metadata_json ?? '{}').event === 'gate_expired')).toBe(true)
    expect(existsSync(approvalPath)).toBe(false)
  })

  test('16: applying a gate creates no grant file, and touches none that already exists', async () => {
    await writeGatedPlugin('gated-writer')

    // Variant A — no grant file beforehand.
    await seedGate('gated-writer', { startedAgoMs: 60_000, completedAgoMs: 30_000 })
    const beforeA = await snapshotHome(root)
    expect((await capture('approve', ['gated-writer'])).code).toBe(0)
    const afterA = await snapshotHome(root)

    expect(existsSync(approvalPath)).toBe(false)
    const changedA = afterA.filter((l) => !beforeA.includes(l)).concat(
      beforeA.filter((l) => !afterA.includes(l)),
    )
    expect(changedA.some((l) => l.startsWith('.session-approval'))).toBe(false)
    // Non-vacuity: the apply DID write something, so "no grant line changed"
    // is not the trivially-true statement of a command that did nothing.
    expect(changedA.length).toBeGreaterThan(0)

    // Variant B — a live grant file already exists and must be byte-identical
    // afterwards, mtime included.
    await mergeGrant('db-writer', {}, approvalPath)
    await seedGate('gated-writer', { startedAgoMs: 60_000, completedAgoMs: 30_000 })
    const beforeB = await snapshotHome(root)
    const grantBefore = beforeB.find((l) => l.startsWith('.session-approval'))
    expect(grantBefore).toBeDefined()

    expect((await capture('approve', ['gated-writer'])).code).toBe(0)

    const afterB = await snapshotHome(root)
    expect(afterB.find((l) => l.startsWith('.session-approval'))).toBe(grantBefore as string)
  })

  test('17: with no parked gate the command merges a Grant exactly as it always did', async () => {
    const { code, stdout, stderr } = await capture('approve', ['render-issue'])

    expect(code).toBe(0)
    expect(stderr).toBe('')
    expect(stdout.toLowerCase()).toContain('grant')
    expect((await readGrant()).scopes).toEqual(['render-issue'])
    expect(await checkApproval('render-issue', approvalPath)).toBe(true)
  })
})
