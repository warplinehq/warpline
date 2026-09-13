/**
 * `warpline advance`'s SIGINT->130 contract — one of the two process-launching
 * test files in this repository, and the reason this one exists is not the
 * reason the other one does.
 *
 * Every other exit code this command can report is proven in process, through
 * the dispatcher entry, in `advance.test.ts`: `0`, `1` and `75` are all values
 * `run` RETURNS, and returning is observable by calling it. `130` is not one of
 * those. It is a signal disposition plus a `process.exit`, and there is no
 * in-process seam for either half — a test that sent itself SIGINT would be
 * testing the test runner, and one that called the handler directly would exit
 * the runner.
 *
 * Two launches, one per signal, one exit-code assertion each. The budget was
 * one until SIGTERM became a published fact in § 11: a second SIGNAL is a
 * second disposition, and a disposition is exactly the thing no in-process
 * test can observe. It is not a second assertion about the same mechanism.
 * Launching a process is where this repository's documented ~3% timeout flake
 * concentrates, so the budget does not widen past that. Any further interrupt
 * behaviour — the handler being removed again, for instance — belongs in
 * `advance.test.ts`, which can observe it without spending a launch.
 */
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { testFixturesDir } from '../../../test-utils/fixtures.js'

/** The bin entry, not the plugin-run module: this is the path a scheduler runs. */
const ENTRY = testFixturesDir(import.meta.url, '../../bin/warpline.ts')

/**
 * Long enough that the child is unambiguously mid-invocation when the signal
 * lands, and well inside the manifest timeout above it so the engine's own
 * cancellation never competes for the exit code.
 */
const HANDLER_SLEEP_MS = 60_000

let home: string

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'warpline-advance-sigint-'))
  // No `state/` here on purpose. `acquireLock` creates the directory its lock
  // goes in, so this fixture is the shape a fresh `warpline init` leaves —
  // which is the shape the first tick of a new scheduler install actually has.
  const plugin = join(home, 'plugins', 'slow')
  mkdirSync(plugin, { recursive: true })

  // Home-level, not `state/preferences.json`: `advance` passes no state
  // override, so the engine resolves preferences through the home default.
  // Without this the shipped default applies, `review_gate` is true, the plugin
  // gates instead of running, and the child exits before it can be signalled.
  writeFileSync(join(home, 'preferences.json'), JSON.stringify({ review_gate: false }))

  // Every field spelled out: the loader casts rather than parses, so an omitted
  // field arrives as undefined instead of picking up a schema default.
  writeFileSync(
    join(plugin, 'manifest.ts'),
    `export const manifest = ${JSON.stringify({
      name: 'slow',
      version: '1.0.0',
      description: 'sleeps until interrupted',
      inputs: {},
      outputs: {},
      capabilities: [],
      secrets: [],
      schedule: 'on_run',
      autonomy_level: 'autonomous',
      side_effects: [],
      ttl_hours: 0.001,
      dependencies: [],
      timeout_ms: 120_000,
      max_parallelism: 1,
      max_retries: 0,
      retry_delay_ms: 10,
      min_tier: 'normal',
    })}\n`,
  )
  writeFileSync(
    join(plugin, 'handler.ts'),
    `export async function handler() {
  await new Promise(resolve => setTimeout(resolve, ${HANDLER_SLEEP_MS}))
  return {
    status: 'success',
    phases_completed: ['slow'],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: 'slow completed',
    artifacts_produced: [],
    schema_version: 1,
  }
}\n`,
  )
})

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
})

/**
 * One launch, signalled once the advance is unambiguously mid-invocation.
 *
 * The run lock is the readiness marker, and it is a cheap one: the engine takes
 * it after the entry function has installed the handler, so the file existing
 * proves the handler is up. That is the only thing the wait is for. Signalling
 * before the handler exists hits the default disposition, which reports a
 * signal and a null code rather than 130 — which is also why both assertions
 * below check the signal as well as the code.
 */
async function advanceKilledWith(
  signal: 'SIGINT' | 'SIGTERM',
): Promise<{ code: number | null; signal: string | null }> {
  // An interrupted advance exits before its release, so the previous case left
  // its lock behind — and the lock is what this function waits on. Without this
  // the second launch reads the FIRST launch's lock as its own readiness marker
  // and signals before the child has installed anything.
  const lock = join(home, 'state', '.lock')
  rmSync(lock, { force: true })

  const child = spawn(process.execPath, [ENTRY, 'advance'], {
    env: { ...process.env, WARPLINE_HOME: home },
    stdio: 'ignore',
  })
  const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => {
    child.on('exit', (code, sig) => resolve({ code, signal: sig }))
  })

  const deadline = Date.now() + 15_000
  while (!existsSync(lock)) {
    if (Date.now() > deadline) throw new Error('the advance never took its run lock')
    await new Promise<void>(resolve => setTimeout(resolve, 20))
  }

  child.kill(signal)
  return await exited
}

test('SIGINT during an advance exits 130', async () => {
  const { code, signal } = await advanceKilledWith('SIGINT')

  // Exactly 130, not merely non-zero: the handler exited deliberately rather
  // than the default disposition killing the process (which reports a signal
  // and a null code instead).
  expect(signal).toBeNull()
  expect(code).toBe(130)
})

/**
 * The signal a scheduler actually sends. `systemctl stop`, a launchd `bootout`
 * and a container stop are all SIGTERM, and until this handler existed they
 * took the default disposition: no flush, no code, and a `--json` document that
 * could be cut in half — the failure the SIGINT handler was added to prevent,
 * reached by the route an operator is far more likely to take.
 *
 * The `signal` assertion is the load-bearing half here. A default-disposition
 * SIGTERM reports `signal: 'SIGTERM'` and `code: null`, so asserting only the
 * code would pass against a build with no handler at all.
 */
test('SIGTERM during an advance exits 130, the same as SIGINT', async () => {
  const { code, signal } = await advanceKilledWith('SIGTERM')

  expect(signal).toBeNull()
  expect(code).toBe(130)
})
