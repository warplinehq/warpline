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
import { createHash } from 'node:crypto'
import { _setHome, sessionApprovalPath } from '../../lib/paths.js'
import { checkApproval, mergeGrant, MAX_GRANT_WINDOW_MS } from '../../runtime/approval-gate.js'
import { invokePlugin } from '../../runtime/invoke-plugin.js'
import {
  applyPendingGate,
  approvalStanding,
  denialFingerprint,
  evaluatePlugin,
  findPendingGate,
  GATE_MAX_AGE_MS,
  loadPluginManifests,
  proposalFingerprint,
} from '../../runtime/engine.js'
import type { EvalContext } from '../../runtime/engine.js'
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
    secrets: [],
    schedule: 'on_run',
    autonomy_level: 'autonomous',
    approval_class: 'session',
    llm_handoff: false,
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

/**
 * Run a subcommand's `run(argv)` with stdout/stderr captured.
 *
 * `resolve` goes through the dispatcher's `main`, not a module of its own: the
 * arm that routes it is part of what the cases below pin, and a command the
 * dispatcher does not know answers "Unknown command" there.
 */
async function capture(
  mod: 'approve' | 'revoke' | 'resolve',
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
    if (mod === 'resolve') {
      const { main } = await import('../warpline.js')
      const code = await main(['resolve', ...argv])
      return { code, stdout, stderr }
    }
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
      approvals?: Record<string, unknown>
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
        approvals: extra.approvals ?? {},
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
    await invokePlugin('gated-writer', {}, { pluginsDir: join(root, 'plugins') }, { granted: false, reason: 'manual-run' })
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
  async function expireThroughApply(
    plugin: string,
    extra: Parameters<typeof seedGate>[2],
    manifests?: ReadonlyMap<string, PluginManifest>,
  ) {
    const HOUR = 60 * 60 * 1000
    await seedGate(plugin, { startedAgoMs: 26 * HOUR, completedAgoMs: 25 * HOUR }, extra)
    const state = await readEngineState(statePath)
    const gate = findPendingGate(state, plugin)
    expect(gate).toBeDefined()
    const own = gatedManifest(plugin)
    const outcome = await applyPendingGate(
      state,
      gate as NonNullable<typeof gate>,
      own,
      { statePath, manifests: manifests ?? new Map([[plugin, own]]) },
    )
    expect(outcome.outcome).toBe('refused')
    return readState()
  }

  /** The manifest `expireThroughApply` hands the gated plugin, spelled once. */
  const gatedManifest = (plugin: string): PluginManifest => ({
    ...makeManifest(plugin, ['sends_email']),
    ttl_hours: 48,
  })

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

  // ── The live-approval arm of the same carve-out (19-11, R11) ────────────
  //
  // Test 19 holds the denial arm. These hold the arm beside it, on the
  // identical argument: an outstanding answer is BOUND to the bytes in
  // `plugin_runs`, and the discard's delete takes `last_output` with it
  // permanently. For a denial the binding is the plugin's own proposal; for a
  // content approval it is the PRODUCER's Output, which is why the reference
  // these cases exercise runs the other way round — the gated plugin is the
  // producer, and the approval that protects it is keyed by the consumer.

  /** The approved bytes, sitting where the producer's Output lives. */
  const APPROVED_OUTPUT = {
    type: 'brief',
    format: 'markdown' as const,
    path: 'batch.md',
    run_id: 'run-a',
    produced_at: '2026-08-29T10:00:00.000Z',
  }

  const CONSUMER = 'batch-sender'

  /** A content-class consumer whose first declared dependency is the gated plugin. */
  const consumerManifest = (producer: string): PluginManifest => ({
    ...makeManifest(CONSUMER, ['sends_email']),
    approval_class: 'content',
    dependencies: [producer],
  })

  /**
   * A live content approval for {@link CONSUMER}, bound to `producer`'s Output.
   *
   * `not_after` is a naked wall clock far enough out that no test run reaches
   * it — the shape `warpline approve --content` stores — so the standing is
   * decided by the fingerprint rather than by the window.
   */
  const liveApprovalSeed = (producer: string) => ({
    pluginRuns: {
      [producer]: {
        last_run_at: '2026-08-29T10:00:00.000Z',
        status: 'gated',
        last_output: APPROVED_OUTPUT,
      },
    },
    approvals: {
      [CONSUMER]: {
        plugin: CONSUMER,
        producer,
        fingerprint: denialFingerprint(producer, ['sends_email'], [APPROVED_OUTPUT]),
        run_id: 'run-a',
        approved_at: '2026-08-29T11:00:00.000Z',
        not_before: null,
        not_after: '2099-01-01T00:00',
        zone: 'UTC',
        effect_id: null,
        marked_at: null,
        confirmed_at: null,
      },
    },
  })

  const approvalManifests = (producer: string): ReadonlyMap<string, PluginManifest> =>
    new Map([
      [producer, gatedManifest(producer)],
      [CONSUMER, consumerManifest(producer)],
    ])

  test('19c: a discard leaves plugin_runs alone while a live approval is bound to this plugin\'s bytes', async () => {
    const state = await expireThroughApply(
      'gated-writer',
      liveApprovalSeed('gated-writer'),
      approvalManifests('gated-writer'),
    )

    // The entry survives, `last_output` and all. The approval names a RUN and a
    // FINGERPRINT, and the bytes behind both live in this entry — deleting it
    // moves the fingerprint the operator's yes was bound to, and no later
    // gesture can put them back. The operator's answer would become
    // unhonourable, silently, because of a gate belonging to a different
    // question.
    expect(state.plugin_runs['gated-writer']).toBeDefined()
    expect(state.plugin_runs['gated-writer'].last_output).toEqual(APPROVED_OUTPUT)

    // The consequence, stated as the next advance would read it: still live,
    // so the approved batch can still go out.
    const { approvalStanding } = await import('../../runtime/engine.js')
    expect(
      approvalStanding(state as never, CONSUMER, approvalManifests('gated-writer'), Date.now())
        .standing,
    ).toBe('live')

    // The GATE is still discarded — that half is unchanged, exactly as in 19.
    expect(state.pending_gates).toEqual([])
  })

  test('19c2: a discard keeps plugin_runs while a binding holds over erased content, and the gate still refuses it', async () => {
    // 19c's case with the content erased. The binding still holds: the stored
    // hash keeps the fingerprint equal, so the entry is kept. The gate still
    // refuses to fire, because there are no bytes to ship. Deleting the entry
    // here would make the producer read as never having produced.
    const body = 'the batch the operator read, inline this time'
    const bodied = {
      type: 'brief',
      format: 'markdown' as const,
      body,
      run_id: 'run-a',
      produced_at: '2026-08-29T10:00:00.000Z',
    }
    const { body: _dropped, ...rest } = bodied
    const erased = {
      ...rest,
      erased_at: '2026-09-15T00:00:00.000Z',
      body_sha256: createHash('sha256').update(body, 'utf8').digest('hex'),
    }

    const fingerprint = denialFingerprint('gated-writer', ['sends_email'], [bodied])
    // Precondition: erasure did not move the fingerprint, so the binding holds
    // and only the erased arm can refuse.
    expect(denialFingerprint('gated-writer', ['sends_email'], [erased])).toBe(fingerprint)

    const seed = liveApprovalSeed('gated-writer')
    const state = await expireThroughApply(
      'gated-writer',
      {
        pluginRuns: {
          'gated-writer': { ...seed.pluginRuns['gated-writer'], last_output: erased },
        },
        approvals: {
          [CONSUMER]: { ...(seed.approvals[CONSUMER] as object), fingerprint },
        },
      },
      approvalManifests('gated-writer'),
    )

    expect(state.plugin_runs['gated-writer']).toBeDefined()
    expect(state.plugin_runs['gated-writer'].last_output).toEqual(erased)

    const { approvalStanding } = await import('../../runtime/engine.js')
    expect(
      approvalStanding(state as never, CONSUMER, approvalManifests('gated-writer'), Date.now())
        .standing,
    ).toBe('content_moved')

    expect(state.approvals[CONSUMER]).toBeDefined()
    expect(state.pending_gates).toEqual([])
  })

  test('19d: a discard with no answer of either kind still deletes plugin_runs, exactly as before', async () => {
    // Non-vacuity for 19c: same path, same discard, and the only difference is
    // whether anything outstanding references the plugin. With no denial and no
    // approval the delete goes ahead, which is what makes the plugin due again
    // after its inputs moved — the whole point of the refusal.
    const state = await expireThroughApply('gated-writer', {
      pluginRuns: {
        'gated-writer': {
          last_run_at: '2026-08-29T10:00:00.000Z',
          status: 'gated',
          last_output: APPROVED_OUTPUT,
        },
      },
    })

    expect(state.plugin_runs['gated-writer']).toBeUndefined()
  })

  test('19d2: an approval whose window has closed protects nothing', async () => {
    // The second non-vacuity for 19c, and the one that matters more: the record
    // is PRESENT and the reference is real — only the standing differs. An
    // existence test in place of the standing would pass 19c and this case
    // would catch it, because a closed window is precisely when the binding
    // should stop pinning anything.
    const seed = liveApprovalSeed('gated-writer')
    const state = await expireThroughApply(
      'gated-writer',
      {
        ...seed,
        approvals: {
          [CONSUMER]: { ...(seed.approvals[CONSUMER] as object), not_after: '2000-01-02T00:00' },
        },
      },
      approvalManifests('gated-writer'),
    )

    expect(state.plugin_runs['gated-writer']).toBeUndefined()
    // The record itself is left alone — this carve-out reads it and never
    // rewrites it.
    expect(state.approvals[CONSUMER]).toBeDefined()
  })

  test('19e: running the discard twice changes nothing the first run preserved', async () => {
    const seed = liveApprovalSeed('gated-writer')
    const manifests = approvalManifests('gated-writer')
    const first = await expireThroughApply('gated-writer', seed, manifests)
    expect(first.plugin_runs['gated-writer'].last_output).toEqual(APPROVED_OUTPUT)
    expect(first.pending_gates).toEqual([])

    // The second run, against the document the first one left. The gate is
    // already gone, so `applyPendingGate` is handed the same gate object again —
    // the discard is reached by identity and the filter is a no-op. Nothing
    // throws, and nothing the first run preserved is destroyed by the second.
    const state = await readEngineState(statePath)
    const stale = {
      plugin: 'gated-writer',
      run_id: 'run-a',
      created_at: '2026-08-29T10:00:00.000Z',
      payload_summary: RESULT.summary,
      plugin_result: RESULT,
      run_started_at: '2026-08-29T09:00:00.000Z',
      run_completed_at: '2026-08-29T10:00:00.000Z',
      applied_at: null,
    }
    const outcome = await applyPendingGate(state, stale as never, gatedManifest('gated-writer'), {
      statePath,
      manifests,
    })

    expect(outcome.outcome).toBe('refused')
    const second = await readState()
    expect(second.plugin_runs['gated-writer']).toBeDefined()
    expect(second.plugin_runs['gated-writer'].last_output).toEqual(APPROVED_OUTPUT)
    expect(second.pending_gates).toEqual([])
    expect(second.approvals[CONSUMER]).toBeDefined()
  })

  test('19f: the gate-apply branch runs inside the state lock, so a concurrent approval write cannot interleave', async () => {
    // The wedge, not a hoped-for race: the test HOLDS the state document's own
    // lock, starts the command, and only then does the concurrent write. Both
    // orders are imposed. `deny.test.ts` records that an interleave cannot be
    // produced from outside the process for a command too fast to catch — which
    // is why the slow side here is the lock and not a timer.
    await writeGatedPlugin('gated-writer')
    await seedGate('gated-writer', { startedAgoMs: 60_000, completedAgoMs: 30_000 })

    const { pathsForStateFile, withStateLockAt } = await import('../../board/state-manager.js')
    const lockPath = pathsForStateFile(statePath).lockPath

    let pending: ReturnType<typeof capture> | undefined
    let appliedWhileHeld: boolean | undefined

    await withStateLockAt(lockPath, async () => {
      pending = capture('approve', ['gated-writer'])
      // Long enough for the command to reach its apply if nothing stopped it.
      await new Promise((resolve) => setTimeout(resolve, 200))

      // The positive control, read off disk while the wedge is still closed: a
      // command that has already applied would make the merge assertion below
      // green for the wrong reason.
      appliedWhileHeld = (await readState()).pending_gates[0].applied_at !== null

      const doc = await readState()
      doc.approvals = liveApprovalSeed('gated-writer').approvals
      await writeFile(statePath, JSON.stringify(doc))
    })

    const result = await (pending as NonNullable<typeof pending>)

    expect(appliedWhileHeld).toBe(false)
    expect(result.code).toBe(0)

    // Both writes landed and the document is consistent: the apply is recorded
    // AND the approval another attachment wrote is still there. Unlocked, the
    // command read the document before that write and wrote its snapshot back
    // over it.
    const after = await readState()
    expect(after.pending_gates[0].applied_at).not.toBeNull()
    expect(after.approvals[CONSUMER]).toBeDefined()
    expect(after.plugin_runs['gated-writer']).toBeDefined()
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

/**
 * `warpline approve --content` — the third mode, and every way it refuses.
 *
 * The shape of every case here is the same and it is the point: the message
 * names a reason a human can act on, AND `state.approvals` is byte-unchanged on
 * disk afterwards. A refusal that names its reason but leaves a half-written
 * record is the state a gate must never be in — and this branch validates
 * everything inside one lock before it mutates anything, exactly as the named
 * path validates every positional before it writes a grant.
 *
 * `state.approvals` is seeded NON-EMPTY in each case, so "unchanged" is a byte
 * comparison rather than an absence check. The absence check passes on a
 * command that wrote nothing and on one that deleted the record.
 */
describe('warpline approve --content', () => {
  let statePath: string

  const PRODUCER = 'batch-builder'
  const CONSUMER = 'batch-sender'

  /** A pre-existing approval for a third plugin, so "unchanged" has bytes to compare. */
  const BYSTANDER = {
    plugin: 'someone-else',
    producer: 'their-producer',
    fingerprint: 'a'.repeat(64),
    run_id: 'run-theirs',
    approved_at: '2026-09-01T00:00:00.000Z',
    not_before: null,
    not_after: '2099-01-01T00:00',
    zone: 'UTC',
    effect_id: null,
    marked_at: null,
    confirmed_at: null,
  }

  async function writeContentPair(
    overrides: Record<string, unknown> = {},
    producerInstalled = true,
  ): Promise<void> {
    if (producerInstalled) {
      const pdir = join(root, 'plugins', PRODUCER)
      await mkdir(pdir, { recursive: true })
      await writeFile(
        join(pdir, 'manifest.ts'),
        `export const manifest = ${JSON.stringify(makeManifest(PRODUCER, []))}`,
      )
    }
    const cdir = join(root, 'plugins', CONSUMER)
    await mkdir(cdir, { recursive: true })
    await writeFile(
      join(cdir, 'manifest.ts'),
      `export const manifest = ${JSON.stringify({
        ...makeManifest(CONSUMER, ['sends_email']),
        approval_class: 'content',
        dependencies: [PRODUCER],
        ...overrides,
      })}`,
    )
  }

  /** The producer Output every case gets unless it asks for a different one. */
  const DEFAULT_OUTPUT = {
    type: 'brief',
    format: 'json',
    body: '{"batch":"twelve invoices"}',
    run_id: 'run-the-operator-read',
  }

  /** State with the bystander approval and, optionally, a producer Output. */
  async function seedContentState(
    producerRan: boolean,
    lastOutput: Record<string, unknown> = DEFAULT_OUTPUT,
  ): Promise<void> {
    await mkdir(join(root, 'state'), { recursive: true })
    await writeFile(
      statePath,
      JSON.stringify({
        schema_version: 1,
        plugin_runs: producerRan
          ? {
              [PRODUCER]: {
                last_run_at: new Date(Date.now() - 3_600_000).toISOString(),
                status: 'success',
                last_output: lastOutput,
              },
            }
          : {},
        approvals: { 'someone-else': BYSTANDER },
      }),
    )
  }

  /**
   * The bytes as the operator actually sees them, cut out of stdout between the
   * two delimiters the command prints.
   *
   * Cutting rather than substring-matching is what makes "renders whole" a real
   * assertion: a truncating renderer produces a SHORTER slice, and a `toContain`
   * on a prefix would pass on one. The delimiters are plain text and a body may
   * forge them; that costs a confused test parser, never a hidden byte, because
   * every byte between them is printed and every control character in them is
   * escaped.
   */
  const BEGIN = '----- begin approved bytes -----\n'
  const END = '\n----- end approved bytes -----'
  function renderedBody(stdout: string): string {
    const start = stdout.indexOf(BEGIN)
    expect(start).toBeGreaterThanOrEqual(0)
    const end = stdout.indexOf(END, start)
    expect(end).toBeGreaterThan(start)
    return stdout.slice(start + BEGIN.length, end)
  }

  const approveArgs = [CONSUMER, '--content', '--not-after', '2099-01-01T00:00']

  const readState = async (): Promise<{ approvals: Record<string, Record<string, unknown>> }> =>
    JSON.parse(await readFile(statePath, 'utf-8'))

  const approvalsOnDisk = async (): Promise<string> =>
    JSON.stringify((await readState()).approvals)

  beforeEach(() => {
    statePath = join(root, 'state', 'engine-state.json')
  })

  test('C1: the happy path writes one approval and leaves the others alone', async () => {
    await writeContentPair()
    await seedContentState(true)

    const { code, stdout } = await capture('approve', [
      CONSUMER,
      '--content',
      '--not-after',
      '2099-01-01T00:00',
    ])

    expect(code).toBe(0)
    expect(stdout).toContain(CONSUMER)
    expect(stdout).toContain(PRODUCER)
    const state = await readState()
    expect(state.approvals[CONSUMER].producer).toBe(PRODUCER)
    expect(state.approvals[CONSUMER].not_after).toBe('2099-01-01T00:00')
    expect(state.approvals[CONSUMER].run_id).toBe('run-the-operator-read')
    expect(state.approvals[CONSUMER].confirmed_at).toBeNull()
    // No session grant was written. The content branch reaches no symbol in the
    // grant module, and this is that claim as an outcome.
    expect(existsSync(approvalPath)).toBe(false)
    // The bystander is untouched: approving is a per-plugin gesture.
    expect(state.approvals['someone-else']).toEqual(BYSTANDER)
  })

  test('C2: a producer that has never run is refused, and nothing is written', async () => {
    await writeContentPair()
    await seedContentState(false)
    const before = await approvalsOnDisk()

    const { code, stderr } = await capture('approve', [
      CONSUMER,
      '--content',
      '--not-after',
      '2099-01-01T00:00',
    ])

    expect(code).toBe(1)
    expect(stderr).toContain(PRODUCER)
    expect(stderr).toContain('never produced an Output')
    expect(await approvalsOnDisk()).toBe(before)
  })

  test('C3: omitting --not-after is refused, and nothing is written', async () => {
    await writeContentPair()
    await seedContentState(true)
    const before = await approvalsOnDisk()

    const { code, stderr } = await capture('approve', [CONSUMER, '--content'])

    expect(code).toBe(1)
    expect(stderr).toContain('--not-after is required')
    expect(await approvalsOnDisk()).toBe(before)
  })

  test('C4: a zone the host tzdb does not know is refused, and nothing is written', async () => {
    await writeContentPair()
    await seedContentState(true)
    const before = await approvalsOnDisk()

    const { code, stderr } = await capture('approve', [
      CONSUMER,
      '--content',
      '--not-after',
      '2099-01-01T00:00',
      '--zone',
      'Mars/Olympus_Mons',
    ])

    expect(code).toBe(1)
    expect(stderr).toContain('Mars/Olympus_Mons')
    expect(await approvalsOnDisk()).toBe(before)
  })

  test('C4b: a zone LINK the Intl enumeration omits is accepted', async () => {
    // Non-vacuity for C4, and the reason the check resolves rather than testing
    // membership: `US/Eastern` is absent from the Intl zone list and resolves
    // perfectly well. A membership test would refuse it.
    await writeContentPair()
    await seedContentState(true)

    const { code } = await capture('approve', [
      CONSUMER,
      '--content',
      '--not-after',
      '2099-01-01T00:00',
      '--zone',
      'US/Eastern',
    ])

    expect(code).toBe(0)
    expect((await readState()).approvals[CONSUMER].zone).toBe('US/Eastern')
  })

  test('C5: a --not-before at or after --not-after is refused, and nothing is written', async () => {
    await writeContentPair()
    await seedContentState(true)
    const before = await approvalsOnDisk()

    const { code, stderr } = await capture('approve', [
      CONSUMER,
      '--content',
      '--not-after',
      '2099-01-01T00:00',
      '--not-before',
      '2099-06-01T00:00',
    ])

    expect(code).toBe(1)
    expect(stderr).toContain('never open')
    expect(await approvalsOnDisk()).toBe(before)
  })

  test('C6: a plugin not declaring the content class is refused, and nothing is written', async () => {
    await writeContentPair({ approval_class: 'session' })
    await seedContentState(true)
    const before = await approvalsOnDisk()

    const { code, stderr } = await capture('approve', [
      CONSUMER,
      '--content',
      '--not-after',
      '2099-01-01T00:00',
    ])

    expect(code).toBe(1)
    expect(stderr).toContain("approval_class 'session'")
    expect(await approvalsOnDisk()).toBe(before)
  })

  test('C7: an unknown plugin name is refused with a suggestion, and nothing is written', async () => {
    await writeContentPair()
    await seedContentState(true)
    const before = await approvalsOnDisk()

    const { code, stderr } = await capture('approve', [
      'batch-sendr',
      '--content',
      '--not-after',
      '2099-01-01T00:00',
    ])

    expect(code).toBe(1)
    expect(stderr).toContain('batch-sendr')
    expect(stderr).toContain(CONSUMER) // the suggestion names the close match
    expect(await approvalsOnDisk()).toBe(before)
  })

  test('C8: --content mixed with a grant gesture is refused whole', async () => {
    await writeContentPair()
    await seedContentState(true)
    const before = await approvalsOnDisk()

    const withAll = await capture('approve', ['--content', '--all', '--not-after', '2099-01-01T00:00'])
    expect(withAll.code).toBe(1)
    expect(withAll.stderr).toContain('--all')

    const withTtl = await capture('approve', [CONSUMER, '--content', '--ttl', '4h', '--not-after', '2099-01-01T00:00'])
    expect(withTtl.code).toBe(1)
    expect(withTtl.stderr).toContain('--ttl')

    const two = await capture('approve', [CONSUMER, PRODUCER, '--content', '--not-after', '2099-01-01T00:00'])
    expect(two.code).toBe(1)
    expect(two.stderr).toContain('exactly one plugin')

    expect(await approvalsOnDisk()).toBe(before)
    expect(existsSync(approvalPath)).toBe(false)
  })

  // -- What the operator actually reads ------------------------------------
  // The whole guarantee rests on the operator having SEEN the bytes. A renderer
  // that strips escapes hides the evidence an attack was attempted, one that
  // truncates hides the tail where a payload appended after a benign opening
  // would sit, and one that resolves a `path` Output reads a file the runtime
  // was never asked to read.

  test('C9: an ANSI sequence renders visible and no raw ESC byte reaches the terminal', async () => {
    await writeContentPair()
    await seedContentState(true, {
      ...DEFAULT_OUTPUT,
      format: 'text',
      body: 'twelve invoices [31mand one wire transfer[0m',
    })

    const { code, stdout } = await capture('approve', approveArgs)

    expect(code).toBe(0)
    expect(renderedBody(stdout)).toBe('twelve invoices \\x1b[31mand one wire transfer\\x1b[0m')
    // Escaped, never stripped: the literal four characters are present AND the
    // byte that would repaint the screen is absent from the whole of stdout.
    expect(stdout).toContain('\\x1b')
    expect(stdout).not.toContain('')
  })

  test('C10: BEL, NUL, CR and DEL render as visible escapes and none reaches the terminal', async () => {
    await writeContentPair()
    await seedContentState(true, {
      ...DEFAULT_OUTPUT,
      format: 'text',
      body: 'ab c\rde\\f',
    })

    const { code, stdout } = await capture('approve', approveArgs)

    expect(code).toBe(0)
    // The authored backslash is escaped too, so an escape the renderer emitted
    // is tellable apart from one the plugin wrote.
    expect(renderedBody(stdout)).toBe('a\\x07b\\x00c\\x0dd\\x7fe\\\\f')
    for (const raw of ['', ' ', '\r', '']) {
      expect(stdout).not.toContain(raw)
    }
  })

  test('C11: a newline inside the body stays a newline', async () => {
    await writeContentPair()
    await seedContentState(true, {
      ...DEFAULT_OUTPUT,
      format: 'text',
      body: 'to: a@example.com\nto: b@example.com',
    })

    const { code, stdout } = await capture('approve', approveArgs)

    expect(code).toBe(0)
    // Line structure is what the operator is reading. Escaping it would make a
    // multi-line batch unreadable, which defeats the point of showing it.
    expect(renderedBody(stdout)).toBe('to: a@example.com\nto: b@example.com')
    expect(stdout).not.toContain('\\x0a')
  })

  test('C12: a 16 KiB multi-byte body renders whole, with no truncation marker', async () => {
    const body = '日'.repeat(5461) + 'a'
    expect(Buffer.byteLength(body, 'utf8')).toBe(16_384)
    await writeContentPair()
    await seedContentState(true, { ...DEFAULT_OUTPUT, format: 'text', body })

    const { code, stdout } = await capture('approve', approveArgs)

    expect(code).toBe(0)
    // Whole, asserted by equality on the cut slice rather than by a prefix
    // match — a truncating renderer produces a shorter slice and fails here.
    expect(renderedBody(stdout)).toBe(body)
    for (const marker of ['…', '[truncated]', '...']) {
      expect(stdout).not.toContain(marker)
    }
  })

  test('C13: an Output declaring a path is refused, and the path is neither read nor echoed', async () => {
    const secret = join(root, 'not-ours.txt')
    await writeFile(secret, 'bytes the runtime was never asked to read')
    await writeContentPair()
    await seedContentState(true, { type: 'artifact', format: 'text', path: secret, run_id: 'run-p' })
    const before = await approvalsOnDisk()

    const { code, stdout, stderr } = await capture('approve', approveArgs)

    expect(code).toBe(1)
    expect(stderr).toContain(CONSUMER)
    expect(stderr.toLowerCase()).toContain('path')
    expect(stderr).toContain('Nothing was written')
    // The path is refused outright, never resolved — so it is not echoed
    // either: an operator's path is exactly the kind of value that carries a
    // machine's secrets into a shell history.
    expect(stderr).not.toContain(secret)
    expect(stdout).not.toContain('bytes the runtime was never asked to read')
    expect(await approvalsOnDisk()).toBe(before)
  })

  test('C22: an erased Output is refused by name, and nothing is written', async () => {
    const erased = {
      type: 'brief',
      format: 'json',
      run_id: 'run-the-operator-read',
      produced_at: '2026-09-01T00:00:00.000Z',
      erased_at: '2026-09-02T00:00:00.000Z',
      body_sha256: 'b'.repeat(64),
    }
    await writeContentPair()
    await seedContentState(true, erased)
    // Raw bytes, not the parsed approvals: nothing at all may be written.
    const before = await readFile(statePath)

    const { code, stdout, stderr } = await capture('approve', approveArgs)

    expect(code).toBe(1)
    expect(stderr).toContain(CONSUMER)
    expect(stderr).toContain('Nothing was written')
    expect(stderr.toLowerCase()).toContain('erase')
    // The file-pointer refusal's word. Erased content is its own refusal, and
    // it must not read as the file-pointer one.
    expect(stderr.toLowerCase()).not.toContain('path')
    expect(stdout).not.toContain('----- begin approved bytes -----')
    expect(Buffer.compare(await readFile(statePath), before)).toBe(0)
  })

  test('C23: a --not-after that has already passed is refused on a first approval and on a re-approve, and nothing is written', async () => {
    await writeContentPair()
    await seedContentState(true)
    const pastArgs = [CONSUMER, '--content', '--not-after', '2000-01-02T00:00']
    // Raw bytes, not the parsed approvals: nothing at all may be written.
    const before = await readFile(statePath)

    const first = await capture('approve', pastArgs)

    expect(first.code).toBe(1)
    expect(first.stderr).toContain('--not-after')
    expect(first.stderr).toContain('has already passed')
    expect(first.stderr).toContain('Nothing was written')
    // The bounds refusal's words. A closed window is its own refusal.
    expect(first.stderr).not.toContain('never open')
    expect(first.stdout).not.toContain('----- begin approved bytes -----')
    expect(Buffer.compare(await readFile(statePath), before)).toBe(0)

    expect((await capture('approve', approveArgs)).code).toBe(0)
    const approved = await readFile(statePath)

    // A re-approve would withdraw the open record in the same write, and with
    // nothing open left, erase the bytes it was about to print.
    const again = await capture('approve', pastArgs)

    expect(again.code).toBe(1)
    expect(Buffer.compare(await readFile(statePath), approved)).toBe(0)
    const doc = JSON.parse(await readFile(statePath, 'utf-8')) as {
      plugin_runs: Record<string, { last_output: Record<string, unknown> }>
      approvals: Record<string, Record<string, unknown>>
    }
    expect(doc.plugin_runs[PRODUCER]!.last_output.body).toBe(DEFAULT_OUTPUT.body)
    expect(doc.plugin_runs[PRODUCER]!.last_output.erased_at).toBeUndefined()
    expect(doc.approvals[CONSUMER]!.not_after).toBe('2099-01-01T00:00')
  })

  test('C23b: a --not-after that passes while the command waits on the state lock is refused, and nothing is written', async () => {
    const { setSystemTime } = await import('bun:test')
    setSystemTime(new Date('2030-01-01T00:00:57.000Z'))
    try {
      await writeContentPair()
      await seedContentState(true)
      const before = await readFile(statePath)
      const { pathsForStateFile, withStateLockAt } = await import('../../board/state-manager.js')
      const lockPath = pathsForStateFile(statePath).lockPath
      let pending: ReturnType<typeof capture> | undefined
      await withStateLockAt(lockPath, async () => {
        pending = capture('approve', [CONSUMER, '--content', '--not-after', '2030-01-01T00:01', '--zone', 'UTC'])
        await new Promise((resolve) => setTimeout(resolve, 200))
        // Five seconds on: the window has closed, and the lock is neither stale nor timed out.
        setSystemTime(new Date('2030-01-01T00:01:02.000Z'))
        await new Promise((resolve) => setTimeout(resolve, 200))
      })
      const result = await (pending as NonNullable<typeof pending>)
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('has already passed')
      expect(Buffer.compare(await readFile(statePath), before)).toBe(0)
    } finally {
      setSystemTime()
    }
  })

  test('C14: the fingerprint prints whole on its own line and is the one the gate compares', async () => {
    await writeContentPair()
    await seedContentState(true)

    const { code, stdout } = await capture('approve', approveArgs)

    expect(code).toBe(0)
    const state = await readEngineState(statePath)
    const expected = proposalFingerprint(state, PRODUCER, makeManifest(PRODUCER, []))
    // Line equality, not a prefix match: a renderer printing the first eight
    // characters would satisfy `toContain` and leave the operator unable to
    // check the value a later drift refusal cites.
    expect(stdout.split('\n')).toContain(expected)
    expect((await readState()).approvals[CONSUMER].fingerprint).toBe(expected)
  })
  // -- Withdrawal, and the one record that cannot be erased -----------------
  // `revoke` retires a grant and `deny` answers a proposal with a no. Neither
  // is an operator taking back a yes they gave to specific bytes, which is what
  // `--remove` is for. The exception is a record marked and never confirmed:
  // absence would destroy the only evidence that a send may have landed, so
  // that one record refuses both withdrawal and re-approval until the operator
  // resolves it at the sink.

  /** The approval record every case below starts from, before its overrides. */
  const approvalFor = (over: Record<string, unknown> = {}) => ({
    plugin: CONSUMER,
    producer: PRODUCER,
    fingerprint: 'b'.repeat(64),
    run_id: 'run-the-operator-read',
    approved_at: '2026-09-01T00:00:00.000Z',
    not_before: null,
    not_after: '2099-01-01T00:00',
    zone: 'UTC',
    effect_id: null,
    marked_at: null,
    confirmed_at: null,
    ...over,
  })

  /** Put a record on disk for the consumer, leaving the bystander alone. */
  async function putApproval(record: Record<string, unknown>): Promise<void> {
    const raw = JSON.parse(await readFile(statePath, 'utf-8'))
    raw.approvals[CONSUMER] = record
    await writeFile(statePath, JSON.stringify(raw))
  }

  /** The consumer's manifest as the evaluator sees it. */
  const consumerManifest = (): PluginManifest => ({
    ...makeManifest(CONSUMER, ['sends_email']),
    approval_class: 'content',
    dependencies: [PRODUCER],
  })

  const MARKED = {
    effect_id: 'c'.repeat(64),
    marked_at: '2026-09-10T08:30:00.000Z',
  }

  test('C15: --remove withdraws a live record, and the next evaluation is ordinary not-due', async () => {
    await writeContentPair()
    await seedContentState(true)
    expect((await capture('approve', approveArgs)).code).toBe(0)
    expect((await readState()).approvals[CONSUMER]).toBeDefined()

    const { code, stdout } = await capture('approve', [CONSUMER, '--content', '--remove'])

    expect(code).toBe(0)
    expect(stdout).toContain(CONSUMER)
    expect((await readState()).approvals[CONSUMER]).toBeUndefined()
    // The bystander is untouched: withdrawing is a per-plugin gesture too.
    expect((await readState()).approvals['someone-else']).toEqual(BYSTANDER)

    // Ordinary not-due, not a refusal. A withdrawal puts the plugin back where
    // it was before anyone answered, which is unapproved and unremarkable —
    // reporting it as a refusal would tell an operator reading `plan` that
    // something went wrong when they are the one who took the yes back.
    const state = await readEngineState(statePath)
    const manifest = consumerManifest()
    const ctx: EvalContext = {
      currentTier: 'normal',
      force: false,
      state,
      approvalPath,
      manifests: new Map([
        [PRODUCER, makeManifest(PRODUCER, [])],
        [CONSUMER, manifest],
      ]),
    }
    const ev = await evaluatePlugin(CONSUMER, manifest, ctx, Date.now())
    expect(ev.due).toBe(false)
    if (ev.due) throw new Error('unreachable')
    expect(ev.reason).toBe('unapproved')
    expect(ev.detail).toContain('no content approval on file')
  })

  test('C16: --remove with no record on file is refused, and nothing is written', async () => {
    await writeContentPair()
    await seedContentState(true)
    const before = await approvalsOnDisk()

    const { code, stderr } = await capture('approve', [CONSUMER, '--content', '--remove'])

    expect(code).toBe(1)
    expect(stderr).toContain(CONSUMER)
    expect(stderr).toContain('Nothing was removed')
    expect(await approvalsOnDisk()).toBe(before)
  })

  test('C17: approving over a marked-unconfirmed record is refused, and nothing is written', async () => {
    await writeContentPair()
    await seedContentState(true)
    await putApproval(approvalFor(MARKED))
    const before = await approvalsOnDisk()

    const { code, stderr } = await capture('approve', approveArgs)

    expect(code).toBe(1)
    expect(stderr).toContain(CONSUMER)
    expect(stderr).toContain(MARKED.effect_id)
    expect(stderr).toContain(MARKED.marked_at)
    expect(stderr).toContain('Nothing was written')
    expect(await approvalsOnDisk()).toBe(before)
  })

  test('C18: --remove over a marked-unconfirmed record is refused, and nothing is written', async () => {
    await writeContentPair()
    await seedContentState(true)
    await putApproval(approvalFor(MARKED))
    const before = await approvalsOnDisk()

    const { code, stderr } = await capture('approve', [CONSUMER, '--content', '--remove'])

    expect(code).toBe(1)
    expect(stderr).toContain(CONSUMER)
    expect(stderr).toContain(MARKED.effect_id)
    expect(stderr).toContain(MARKED.marked_at)
    expect(await approvalsOnDisk()).toBe(before)
  })

  test('C19: --remove over a confirmed record succeeds — a spent record is a report, not a question', async () => {
    await writeContentPair()
    await seedContentState(true)
    await putApproval(approvalFor({ ...MARKED, confirmed_at: '2026-09-10T08:30:04.000Z' }))

    const { code } = await capture('approve', [CONSUMER, '--content', '--remove'])

    expect(code).toBe(0)
    expect((await readState()).approvals[CONSUMER]).toBeUndefined()
  })

  test('C20: --remove reaches the record of a plugin that is no longer installed', async () => {
    // Validated against `state.approvals` and not against the manifests. Were
    // it the other way round, uninstalling a plugin after approving it would
    // strand its record with no CLI gesture that reaches it.
    await writeContentPair()
    await seedContentState(true)
    await putApproval(approvalFor())
    await rm(join(root, 'plugins', CONSUMER), { recursive: true, force: true })

    const { code } = await capture('approve', [CONSUMER, '--content', '--remove'])

    expect(code).toBe(0)
    expect((await readState()).approvals[CONSUMER]).toBeUndefined()
    expect((await readState()).approvals['someone-else']).toEqual(BYSTANDER)
  })

  test('C21: --remove without --content is refused rather than merging a grant', async () => {
    await writeContentPair()
    await seedContentState(true)
    const before = await approvalsOnDisk()

    const { code, stderr } = await capture('approve', ['render-issue', '--remove'])

    expect(code).toBe(1)
    expect(stderr).toContain('--content')
    expect(stderr).toContain('revoke')
    expect(existsSync(approvalPath)).toBe(false)
    expect(await approvalsOnDisk()).toBe(before)
  })

  // -- Answering the open question ------------------------------------------
  // The two refusals above keep a marked, unconfirmed record exactly as it is.
  // The only thing that moves it is the operator's answer, given after they
  // checked the sink with the effect id: nothing shipped. The answer is bound
  // to that one id, it keeps the mark beside it, and it grants nothing, so a
  // retry still takes a fresh yes over bytes the operator reads again.

  test('C22: resolving with the recorded effect id answers an indeterminate record, which then reads spent', async () => {
    await writeContentPair()
    await seedContentState(true)
    await putApproval(approvalFor(MARKED))

    const { code, stdout } = await capture('resolve', [CONSUMER, '--not-shipped', MARKED.effect_id])

    expect(code).toBe(0)
    expect(stdout).toContain(MARKED.effect_id)
    expect(stdout).toContain('not shipped')
    expect(stdout).toContain('approve them again')
    const record = (await readState()).approvals[CONSUMER]!
    expect(record.not_shipped_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/)
    // The evidence that a fire began stays. The answer sits beside it.
    expect(record.marked_at).toBe(MARKED.marked_at)
    expect(record.effect_id).toBe(MARKED.effect_id)
    // Confirmation is the advance's word about a fire it saw finish. The
    // operator's answer is a different fact, and it never borrows that field.
    expect(record.confirmed_at).toBeNull()

    const { manifests } = await loadPluginManifests(join(root, 'plugins'))
    const state = await readEngineState(statePath)
    expect(approvalStanding(state, CONSUMER, manifests, Date.now()).standing).toBe('spent')
  })

  test('C23: resolving with another effect id is refused, and nothing is written', async () => {
    await writeContentPair()
    await seedContentState(true)
    await putApproval(approvalFor(MARKED))
    const before = await approvalsOnDisk()
    const typed = 'f'.repeat(64)

    const { code, stderr } = await capture('resolve', [CONSUMER, '--not-shipped', typed])

    expect(code).toBe(1)
    // The recorded id, so the operator can go and look for the right fire.
    expect(stderr).toContain(MARKED.effect_id)
    expect(stderr).toContain('does not match')
    expect(stderr).toContain('Nothing was written')
    // Never the typed one: it is operator text, compared and never echoed.
    expect(stderr).not.toContain(typed)
    expect(await approvalsOnDisk()).toBe(before)
  })

  test('C24: resolving a record that is not indeterminate is refused, and nothing is written', async () => {
    await writeContentPair()
    await seedContentState(true)

    // No record at all.
    const none = await approvalsOnDisk()
    const missing = await capture('resolve', [CONSUMER, '--not-shipped', MARKED.effect_id])
    expect(missing.code).toBe(1)
    expect(missing.stderr).toContain('no fire to resolve')
    expect(await approvalsOnDisk()).toBe(none)

    // A record that never fired.
    await putApproval(approvalFor())
    const unmarked = await approvalsOnDisk()
    const fresh = await capture('resolve', [CONSUMER, '--not-shipped', MARKED.effect_id])
    expect(fresh.code).toBe(1)
    expect(fresh.stderr).toContain('no fire waiting on an answer')
    expect(await approvalsOnDisk()).toBe(unmarked)

    // A fire the advance saw finish. There is no question left to answer, and
    // an answer here would contradict the runtime's own record.
    await putApproval(approvalFor({ ...MARKED, confirmed_at: '2026-09-10T08:30:04.000Z' }))
    const confirmed = await approvalsOnDisk()
    const shipped = await capture('resolve', [CONSUMER, '--not-shipped', MARKED.effect_id])
    expect(shipped.code).toBe(1)
    expect(shipped.stderr).toContain('no fire waiting on an answer')
    expect(await approvalsOnDisk()).toBe(confirmed)
  })

  test('C25: resolving with no effect id, more than one plugin, or another flag is refused, and nothing is written', async () => {
    await writeContentPair()
    await seedContentState(true)
    await putApproval(approvalFor(MARKED))
    const before = await approvalsOnDisk()

    const bare = await capture('resolve', [CONSUMER])
    expect(bare.code).toBe(1)
    expect(bare.stderr).toContain('--not-shipped <effect-id>')
    expect(await approvalsOnDisk()).toBe(before)

    const two = await capture('resolve', [CONSUMER, 'other-plugin', '--not-shipped', MARKED.effect_id])
    expect(two.code).toBe(1)
    expect(two.stderr).toContain('exactly one plugin')
    expect(await approvalsOnDisk()).toBe(before)

    const extra = await capture('resolve', [CONSUMER, '--not-shipped', MARKED.effect_id, '--remove'])
    expect(extra.code).toBe(1)
    expect(extra.stderr).toContain("'--remove'")
    expect(await approvalsOnDisk()).toBe(before)
  })

  test('C26: a resolved record can be re-approved, and can be removed', async () => {
    await writeContentPair()
    await seedContentState(true)
    await putApproval(approvalFor(MARKED))
    expect((await capture('resolve', [CONSUMER, '--not-shipped', MARKED.effect_id])).code).toBe(0)

    // The retry is a second yes over bytes the operator reads again. It
    // replaces the answered record whole, as it replaces a spent one.
    const again = await capture('approve', approveArgs)
    expect(again.code).toBe(0)
    const record = (await readState()).approvals[CONSUMER]!
    expect(record.marked_at).toBeNull()
    expect(record.effect_id).toBeNull()
    expect(record.confirmed_at).toBeNull()
    expect(Object.hasOwn(record, 'not_shipped_at')).toBe(false)

    // An answered record is a report, not a question, so it can be withdrawn.
    await putApproval(approvalFor({ ...MARKED, not_shipped_at: '2026-09-26T10:00:00.000Z' }))
    const removed = await capture('approve', [CONSUMER, '--content', '--remove'])
    expect(removed.code).toBe(0)
    expect(Object.hasOwn((await readState()).approvals, CONSUMER)).toBe(false)
  })
})
