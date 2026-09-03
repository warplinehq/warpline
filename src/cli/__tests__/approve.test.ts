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
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { _setHome, sessionApprovalPath } from '../../lib/paths.js'
import { checkApproval, mergeGrant, MAX_GRANT_WINDOW_MS } from '../../runtime/approval-gate.js'
import { invokePlugin } from '../../runtime/invoke-plugin.js'
import { applyPendingGate, denialFingerprint, findPendingGate, GATE_MAX_AGE_MS } from '../../runtime/engine.js'
import { readEngineState } from '../../runtime/engine-state-store.js'
import { snapshotHome } from '../../runtime/__tests__/helpers/snapshot-home.js'
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
    // Derived, not typed: a literal here passed for the wrong reason the day
    // the constant moved, and this assertion is the one that decides the cap.
    expect(expiresAt).toBe(firstGrantedAt + MAX_GRANT_WINDOW_MS)
    expect(stdout.toLowerCase()).toContain('capped')
  })

  test('6b: --ttl 30d with --long is permitted and the extension is printed', async () => {
    await capture('approve', ['render-issue', '--ttl', '1h'])

    const { code, stdout } = await capture('approve', ['render-issue', '--ttl', '30d', '--long'])

    expect(code).toBe(0)
    expect(stdout.toLowerCase()).toContain('beyond')
    const raw = await readGrant()
    const ceiling = new Date(raw.first_granted_at).getTime() + MAX_GRANT_WINDOW_MS
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
    extra: {
      pluginRuns?: Record<string, unknown>
      appliedAt?: string | null
      denials?: Record<string, unknown>
    } = {},
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
        denials: extra.denials ?? {},
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

  /**
   * Driven through `approve.run()`, deliberately, and not through
   * `applyPendingGate`. The regression this pins was invisible for exactly that
   * reason: the two guards it crosses were each tested at the function, and the
   * seam where they meet the verb was not. `applied_at` is seeded rather than
   * produced by an advance because the advance-survival half is Test 43's job
   * (`engine.test.ts`) — a spent marker on file is the state that advance
   * leaves, and this is what the verb must do when it finds one.
   */
  test('13: a spent marker refuses a second apply without blocking a Grant', async () => {
    await writeGatedPlugin('gated-writer')
    await seedGate('gated-writer', { startedAgoMs: 60_000, completedAgoMs: 30_000 })

    expect((await capture('approve', ['gated-writer'])).code).toBe(0)
    const applied = (await readState()).plugin_runs['gated-writer']
    const stamp = (await readState()).pending_gates[0].applied_at
    expect(stamp).not.toBeNull()

    // The same words a second time. Before this fix the verb refused with exit
    // 1 and wrote nothing, so an operator whose Grant expired after an apply
    // could not renew it by name for as long as the gate ceiling ran.
    const { code, stdout, stderr } = await capture('approve', ['gated-writer'])

    expect(code).toBe(0)
    expect(stderr).toBe('')
    // Narrated, not silent: the operator typed an unchanged gesture and is
    // getting a different answer, so the note names the run it is not redoing.
    expect(stdout).toContain('already applied')
    expect(stdout).toContain('run-a')
    expect(stdout.toLowerCase()).toContain('does not re-record')

    // The Grant the operator was locked out of.
    expect((await readGrant()).scopes).toEqual(['gated-writer'])
    expect(await checkApproval('gated-writer', approvalPath)).toBe(true)

    // …and the double-record protection is untouched. The result was recorded
    // once, the marker still carries its original stamp, and nothing re-entered
    // the apply path.
    const state = await readState()
    expect(state.plugin_runs['gated-writer']).toEqual(applied)
    expect(state.pending_gates[0].applied_at).toBe(stamp)
  })

  test('13b: a repeated name applies once and does not report itself already applied', async () => {
    // `approve foo foo` applied the gate, re-found it with `applied_at` set,
    // and reported "already applied" — exiting 1 on a successful apply.
    await writeGatedPlugin('gated-writer')
    await seedGate('gated-writer', { startedAgoMs: 60_000, completedAgoMs: 30_000 })

    const { code, stdout, stderr } = await capture('approve', ['gated-writer', 'gated-writer'])

    expect(code).toBe(0)
    expect(stderr).toBe('')
    // Once, not twice: the name is de-duplicated before anything is written.
    expect(stdout.match(/Applied the parked result/g)).toHaveLength(1)
    expect((await readState()).pending_gates).toHaveLength(1)
  })

  test('13c: a mixed batch says what was applied as well as what was refused', async () => {
    // `applyPendingGate` writes state per call, so a later refusal cannot undo
    // an earlier apply. A bare failure latch exited 1 while printing nothing to
    // say anything had succeeded, which reads as "nothing happened".
    await writeGatedPlugin('gated-writer')
    await writeGatedPlugin('db-writer', { ttl_hours: 48 })
    const HOUR = 60 * 60 * 1000
    await seedGate('gated-writer', { startedAgoMs: 60_000, completedAgoMs: 30_000 })
    const good = JSON.parse(await readFile(statePath, 'utf-8'))
    await seedGate('db-writer', { startedAgoMs: 26 * HOUR, completedAgoMs: 25 * HOUR })
    const stale = JSON.parse(await readFile(statePath, 'utf-8'))
    await writeFile(
      statePath,
      JSON.stringify({
        ...stale,
        plugin_runs: { ...good.plugin_runs, ...stale.plugin_runs },
        pending_gates: [...good.pending_gates, ...stale.pending_gates],
      }),
    )

    const { code, stdout, stderr } = await capture('approve', ['gated-writer', 'db-writer'])

    expect(code).toBe(1)
    expect(stdout).toContain('Applied the parked result for gated-writer')
    expect(stderr).toContain('expired')
    // The half the operator could not otherwise see from an exit code of 1.
    expect(stderr).toContain('gated-writer')
    expect(stderr).toContain('does not undo them')
    expect((await readState()).plugin_runs['gated-writer'].status).toBe('success')
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

  test('15: a gate older than min(ttl_hours, the gate ceiling) is expired and refused, on seeded clocks', async () => {
    const HOUR = 60 * 60 * 1000
    // ttl_hours 48 so the gate ceiling — not the TTL — is what expires it, and
    // the seed is measured FROM that ceiling so this keeps testing the ceiling
    // if it ever moves. A fixed 25h seed would have gone on passing against a
    // 12h ceiling while no longer pinning the boundary it names.
    await writeGatedPlugin('gated-writer', { ttl_hours: 48 })
    await seedGate('gated-writer', {
      startedAgoMs: GATE_MAX_AGE_MS + 2 * HOUR,
      completedAgoMs: GATE_MAX_AGE_MS + HOUR,
    })

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

  /**
   * The state a denied-and-parked plugin is actually in: `plugin_runs` carries
   * the gated run's Output, and the denial's fingerprint is the one the deny
   * verb would have computed against it.
   *
   * Built from the exported `denialFingerprint` rather than a literal, because
   * a literal would pin today's hash and go red on any change to the hashed
   * shape — which is not what these two cases are about.
   */
  const deniedGateSeed = (plugin: string, sideEffects: string[] = ['sends_email']) => ({
    pluginRuns: {
      [plugin]: {
        last_run_at: new Date(Date.now() - 30_000).toISOString(),
        status: 'gated',
        last_output: RESULT.artifacts_produced[0],
      },
    },
    denials: {
      [plugin]: {
        plugin,
        reason: 'the operator declined the parked result from run run-a',
        denied_at: '2026-08-29T11:00:00.000Z',
        note: null,
        fingerprint: denialFingerprint(plugin, sideEffects, [RESULT.artifacts_produced[0]]),
      },
    },
  })

  test('18: a live denial refuses the apply, and no grant is written either', async () => {
    await writeGatedPlugin('gated-writer')
    await seedGate(
      'gated-writer',
      { startedAgoMs: 60_000, completedAgoMs: 30_000 },
      deniedGateSeed('gated-writer'),
    )
    const before = await readState()

    const { code, stdout, stderr } = await capture('approve', ['gated-writer'])

    expect(code).toBe(1)
    expect(stderr).toContain('was denied at')
    expect(stderr).toContain('warpline deny --remove gated-writer')
    // Not the other gate either: a refused apply must not fall through to the
    // Grant path, which is the wrong-gesture outcome gate-first exists to stop.
    expect(stdout).toBe('')
    expect(existsSync(approvalPath)).toBe(false)

    // Nothing applied: the gate is still live and the run record is untouched.
    const after = await readState()
    expect(after.pending_gates[0].applied_at).toBeNull()
    expect(after.plugin_runs).toEqual(before.plugin_runs)
    expect(existsSync(marker)).toBe(false)
  })

  test('18b: a superseded denial does not block the apply', async () => {
    await writeGatedPlugin('gated-writer')
    const seed = deniedGateSeed('gated-writer')
    // The proposal moved since the denial was recorded — the manifest declares
    // 'sends_email', the denial answered a proposal that declared 'writes_db'.
    // Non-vacuity for 18: the ONLY difference is the fingerprint.
    await seedGate('gated-writer', { startedAgoMs: 60_000, completedAgoMs: 30_000 }, {
      ...seed,
      denials: {
        'gated-writer': {
          ...(seed.denials['gated-writer'] as Record<string, unknown>),
          fingerprint: denialFingerprint('gated-writer', ['writes_db'], [
            RESULT.artifacts_produced[0],
          ]),
        },
      },
    })

    const { code, stdout } = await capture('approve', ['gated-writer'])

    expect(code).toBe(0)
    expect(stdout.toLowerCase()).toContain('parked result')
    expect((await readState()).pending_gates[0].applied_at).not.toBeNull()
  })

  /**
   * Drive a refusal through `applyPendingGate` itself rather than through the
   * verb. Test 18 is why: the verb now refuses a live denial before it ever
   * reaches the apply, so the CLI cannot reach the discard while a denial is
   * live. The invariant belongs to the exported function, which any caller can
   * reach, so that is where it is held.
   */
  async function expireThroughApply(plugin: string, extra: Parameters<typeof seedGate>[2]) {
    const HOUR = 60 * 60 * 1000
    await seedGate(plugin, { startedAgoMs: 26 * HOUR, completedAgoMs: 25 * HOUR }, extra)
    const state = await readEngineState(statePath)
    const gate = findPendingGate(state, plugin)
    expect(gate).toBeDefined()
    const outcome = await applyPendingGate(
      state,
      gate as NonNullable<typeof gate>,
      { ...makeManifest(plugin, ['sends_email']), ttl_hours: 48 },
      { statePath },
    )
    expect(outcome.outcome).toBe('refused')
    return readState()
  }

  /**
   * Driven through `applyPendingGate` directly, and that is the point rather
   * than a shortcut. `approve` refuses on a live denial before it ever reaches
   * this call, so no CLI gesture can arrive here with one standing — which is
   * exactly why the protection has to live in the function and not in its
   * caller. What is asserted is a property of `applyPendingGate` for whoever
   * calls it next.
   */
  test('19: a discard leaves plugin_runs alone while a denial is live, so the answer stays bound to the real proposal', async () => {
    const state = await expireThroughApply('gated-writer', deniedGateSeed('gated-writer'))

    // The entry survives. Deleting it is what moves the fingerprint the denial
    // is bound to — the answer would stop matching, the plugin would be due on
    // the next advance, and the side effects the operator refused would fire
    // again, silently under a live Grant. The delete exists to make a plugin
    // due again after its inputs moved, which is meaningless for one that
    // cannot run.
    expect(state.plugin_runs['gated-writer']).toBeDefined()
    expect(state.plugin_runs['gated-writer'].last_output).toEqual(RESULT.artifacts_produced[0])

    // Untouched, all of it. Nothing was re-bound, so there is nothing to
    // re-narrate: the denial still answers the proposal it was given for.
    const denial = state.denials['gated-writer']
    expect(denial.fingerprint).toBe(
      denialFingerprint('gated-writer', ['sends_email'], [RESULT.artifacts_produced[0]]),
    )
    expect(denial.denied_at).toBe('2026-08-29T11:00:00.000Z')
    expect(denial.reason).toBe('the operator declined the parked result from run run-a')

    // The consequence, stated as the evaluator sees it: still suppressed.
    const { denialStanding } = await import('../../runtime/engine.js')
    const standing = denialStanding(
      state as never,
      'gated-writer',
      { ...makeManifest('gated-writer', ['sends_email']), ttl_hours: 48 },
    )
    expect(standing.standing).toBe('live')

    // Still permanent-free: because the binding holds, a genuine re-run with a
    // different Output lapses the denial on its own, which a name-bound one
    // could never do.
    const moved = { ...state, plugin_runs: { 'gated-writer': {
      ...state.plugin_runs['gated-writer'],
      last_output: { type: 'brief', format: 'markdown', path: 'moved.md' },
    } } }
    expect(
      denialStanding(moved as never, 'gated-writer', {
        ...makeManifest('gated-writer', ['sends_email']),
        ttl_hours: 48,
      }).standing,
    ).toBe('superseded')

    // The GATE is still discarded — that half is unchanged.
    expect(state.pending_gates).toEqual([])
  })

  test('19b: a denial that was already stale is left exactly as it was', async () => {
    const seed = deniedGateSeed('gated-writer')
    const stale = denialFingerprint('gated-writer', ['writes_db'], [])
    const state = await expireThroughApply('gated-writer', {
      ...seed,
      denials: {
        'gated-writer': {
          ...(seed.denials['gated-writer'] as Record<string, unknown>),
          fingerprint: stale,
        },
      },
    })

    // Non-vacuity for 19: same path, same discard, and the only difference is
    // whether the answer still matched. A stale denial protects nothing — it is
    // already superseded, so the plugin becoming due again is the correct
    // outcome and the delete goes ahead.
    expect(state.plugin_runs['gated-writer']).toBeUndefined()
    // And it is left exactly as it was. Re-stamping it would revive an answer
    // to a proposal that no longer exists.
    expect(state.denials['gated-writer'].fingerprint).toBe(stale)
  })

  test('20: a live denial refuses the grant, and nothing is written', async () => {
    // No parked gate, so this falls straight through to the Grant path — the
    // arm the denial guard inside the gated branch does not cover.
    await mkdir(join(root, 'state'), { recursive: true })
    await writeFile(
      statePath,
      JSON.stringify({
        schema_version: 1,
        plugin_runs: {},
        pending_gates: [],
        denials: {
          'db-writer': {
            plugin: 'db-writer',
            reason: 'the operator declined this proposal',
            denied_at: '2026-08-29T11:00:00.000Z',
            note: null,
            fingerprint: denialFingerprint('db-writer', ['writes_db'], []),
          },
        },
      }),
    )

    const { code, stderr } = await capture('approve', ['db-writer'])

    // Refused, and nothing written. A grant here buys the operator nothing —
    // the denial check sits before the approval gate, so the plugin is skipped
    // as `denied` on the next advance either way — and reporting exit 0 and
    // "Approved 1 scope" for a plugin that will not run is the gate claiming a
    // success it did not achieve. The apply arm already refuses on this exact
    // standing; answering the same fact two ways depending on which arm the
    // operator landed in was the defect.
    expect(code).toBe(1)
    expect(stderr).toContain('denied at 2026-08-29T11:00:00.000Z')
    expect(stderr).toContain('would not make it run')
    expect(stderr).toContain('Nothing was granted')
    // The escape is named, so this is a refusal with a way out and not the
    // lockout CR-01 was.
    expect(stderr).toContain('warpline deny --remove db-writer')
    // Nothing on disk: the refusal runs before any write, like name validation.
    await expect(readGrant()).rejects.toThrow()
  })

  test('20c: every denied name is reported before the command refuses', async () => {
    // One refusal naming both, rather than sending the operator round again for
    // the second. Same property the unknown-name path has.
    await mkdir(join(root, 'state'), { recursive: true })
    await writeFile(
      statePath,
      JSON.stringify({
        schema_version: 1,
        plugin_runs: {},
        pending_gates: [],
        denials: {
          'db-writer': {
            plugin: 'db-writer',
            reason: 'the operator declined this proposal',
            denied_at: '2026-08-29T11:00:00.000Z',
            note: null,
            fingerprint: denialFingerprint('db-writer', ['writes_db'], []),
          },
          'digest-sender': {
            plugin: 'digest-sender',
            reason: 'the operator declined this proposal',
            denied_at: '2026-08-29T11:30:00.000Z',
            note: null,
            fingerprint: denialFingerprint('digest-sender', ['sends_email', 'external_api'], []),
          },
        },
      }),
    )

    const { code, stderr } = await capture('approve', ['db-writer', 'digest-sender'])

    expect(code).toBe(1)
    expect(stderr).toContain('db-writer was denied')
    expect(stderr).toContain('digest-sender was denied')
    expect(stderr).toContain('warpline deny --remove db-writer digest-sender')
    await expect(readGrant()).rejects.toThrow()
  })

  test('20b: a superseded denial is not narrated, because it no longer answers anything', async () => {
    // Non-vacuity for 20: same path, same record, and the only difference is
    // whether the fingerprint still matches the live proposal. A stale denial
    // is stale everywhere else, and warning on it would send the operator to
    // undo an answer they had already outgrown.
    await mkdir(join(root, 'state'), { recursive: true })
    await writeFile(
      statePath,
      JSON.stringify({
        schema_version: 1,
        plugin_runs: {},
        pending_gates: [],
        denials: {
          'db-writer': {
            plugin: 'db-writer',
            reason: 'the operator declined this proposal',
            denied_at: '2026-08-29T11:00:00.000Z',
            note: null,
            fingerprint: denialFingerprint('db-writer', ['sends_email'], []),
          },
        },
      }),
    )

    const { code, stdout } = await capture('approve', ['db-writer'])

    // Non-vacuity for 20: same path, same record, and the only difference is
    // whether the answer still matches. A stale denial must not refuse — that
    // would strand the operator behind a question that no longer exists.
    expect(code).toBe(0)
    expect(stdout).not.toContain('denied at')
    expect((await readGrant()).scopes).toEqual(['db-writer'])
  })

  test('21: --all narrates a denied plugin and grants the rest', async () => {
    await mkdir(join(root, 'state'), { recursive: true })
    await writeFile(
      statePath,
      JSON.stringify({
        schema_version: 1,
        plugin_runs: {},
        pending_gates: [],
        denials: {
          'db-writer': {
            plugin: 'db-writer',
            reason: 'the operator declined this proposal',
            denied_at: '2026-08-29T11:00:00.000Z',
            note: null,
            fingerprint: denialFingerprint('db-writer', ['writes_db'], []),
          },
        },
      }),
    )

    const { code, stdout } = await capture('approve', ['--all'])

    // Granted, not refused: --all is a breadth gesture and the operator did not
    // name the denied plugin, so refusing the whole command answers a question
    // they did not ask.
    expect(code).toBe(0)
    expect((await readGrant()).scopes).toBe('*')
    expect(stdout).toContain('stays denied')
    expect(stdout).toContain('warpline deny --remove db-writer')
    // The count is what can actually run. render-issue + digest-sender remain
    // of the three side-effecting fixtures; db-writer is suppressed.
    expect(stdout).toContain('Blanket approval: 2 plugins')
  })

  test('21b: --all with no denials counts every side-effecting plugin', async () => {
    // Non-vacuity for 21: same command, same fixtures, no denial record.
    const { code, stdout } = await capture('approve', ['--all'])

    expect(code).toBe(0)
    expect(stdout).toContain('Blanket approval: 3 plugins')
    expect(stdout).not.toContain('stays denied')
  })

  test('21c: --all still grants when the state document is unreadable', async () => {
    // The note is advisory, so a failed read costs a sentence and not the
    // command. --all cannot park a result, so an unreadable document is not
    // the wrong-gesture hazard it is on the named path.
    await mkdir(join(root, 'state'), { recursive: true })
    await writeFile(statePath, '{ this is not json')

    const { code, stdout } = await capture('approve', ['--all'])

    expect(code).toBe(0)
    expect((await readGrant()).scopes).toBe('*')
    expect(stdout).not.toContain('stays denied')
  })

  test('22: grant-clock flags are reported as ignored when a parked result is applied', async () => {
    await writeGatedPlugin('gated-writer')
    await seedGate('gated-writer', { startedAgoMs: 60_000, completedAgoMs: 30_000 })

    const { code, stderr } = await capture('approve', ['gated-writer', '--ttl', '2h', '--long'])

    expect(code).toBe(0)
    // Named individually: the operator typed specific flags and should see
    // those flags, not a generic "some options were ignored".
    expect(stderr).toContain('--ttl')
    expect(stderr).toContain('--long')
    expect(stderr).not.toContain('--replace')
    expect(stderr).toContain('no grant clock to set')
    // Still no grant file — the note describes what happened, it does not change it.
    expect(existsSync(approvalPath)).toBe(false)
  })

  test('22b: an apply with no grant flags says nothing about them', async () => {
    // Non-vacuity for 22: same path, same apply, no flags typed.
    await writeGatedPlugin('gated-writer')
    await seedGate('gated-writer', { startedAgoMs: 60_000, completedAgoMs: 30_000 })

    const { code, stderr } = await capture('approve', ['gated-writer'])

    expect(code).toBe(0)
    expect(stderr).not.toContain('ignored')
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
