/**
 * `warpline advance` through the real bin: the SIGINT/SIGTERM->130 contract,
 * and the drain that keeps queued output whole when the process exits.
 *
 * Every other exit code this command can report is proven in process, through
 * the dispatcher entry, in `advance.test.ts`: `0`, `1` and `75` are all values
 * `run` RETURNS, and returning is observable by calling it. `130` is not one of
 * those. It is a signal disposition plus a `process.exit`, and there is no
 * in-process seam for either half — a test that sent itself SIGINT would be
 * testing the test runner, and one that called the handler directly would exit
 * the runner. The drain has no in-process seam either: what it guards is what
 * happens to bytes still queued when the process ends.
 *
 * So this file launches the real bin six times. Two are the exit-code cases,
 * one per signal, because a second signal is a second disposition. Four are
 * the drain cases. Any further interrupt behaviour — the handler being removed
 * again, for instance — belongs in `advance.test.ts`, which can observe it
 * without a launch.
 *
 * The normal-exit drain guard pipes a document larger than the pipe buffer
 * into a reader that waits before it reads. Against a bin that exits without
 * draining, it goes red on bun and on node alike: the reader gets the first
 * 65,536 bytes and nothing parses.
 *
 * The signal drain guard reads stderr, not stdout. `advance` writes its
 * document and removes its handler in one synchronous stretch, so a signal
 * never finds the document queued. What is queued is plugin output, which the
 * runtime redirects to stderr while a handler runs.
 *
 * The keep-printing case is the one § 11 means when it says an interrupted
 * plugin may run to completion. Its plugin goes on printing after the signal,
 * so every line it prints then is a write to a stream the drain has ended.
 * Both runtimes cut the queue the same way there, so that case runs node on
 * the built bin as well as bun on the source entry. `bun run test` builds
 * first. A bare `bun test` runs whatever dist holds.
 *
 * The handler's two-second ceiling exits 130 even when the drain never
 * settles, so this file can't see a drain that hangs. The run case in
 * closed-reader.test.ts has no ceiling, and that one can.
 */
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { testFixturesDir } from '../../../test-utils/fixtures.js'

/** The bin entry, not the plugin-run module: this is the path a scheduler runs. */
const ENTRY = testFixturesDir(import.meta.url, '../../bin/warpline.ts')

/** The built bin, the path a real consumer runs under node. */
const BIN = testFixturesDir(import.meta.url, '../../../dist/bin/warpline.js')

/** Not `process.execPath`: under `bun test` that is bun. */
const NODE = process.env.NODE ?? 'node'

/**
 * Long enough that the child is unambiguously mid-invocation when the signal
 * lands, and well inside the manifest timeout above it so the engine's own
 * cancellation never competes for the exit code.
 */
const HANDLER_SLEEP_MS = 60_000

/** How many 499-character lines the `slow` plugin prints: 200,000 bytes, over a 64 KiB pipe buffer. */
const CHATTY_LINES = 400

/**
 * Every field spelled out. The loader validates manifests (`safeParse`), and
 * naming each one keeps the fixtures off the schema defaults, so a default
 * changing can't change what these launches exercise.
 */
const MANIFEST = {
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
}

let home: string
/** A home whose `slow` plugin goes on printing after its lines, through the signal. */
let ticking: string
/** A home of 300 manifest-only plugins, whose `advance --json` document is larger than a pipe buffer. */
let fleet: string

/**
 * Writes the `slow` plugin into `dir`. With `tick`, the handler keeps printing
 * every 20 ms after its lines. While the handler runs, its console.log goes to
 * `process.stderr.write`, so every tick after the signal is a write to a
 * stream the drain has ended.
 */
function slowPlugin(dir: string, tick: boolean): void {
  // No `state/` here on purpose. `acquireLock` creates the directory its lock
  // goes in, so this fixture is the shape a fresh `warpline init` leaves —
  // which is the shape the first tick of a new scheduler install actually has.
  const plugin = join(dir, 'plugins', 'slow')
  mkdirSync(plugin, { recursive: true })

  // Home-level, not `state/preferences.json`: `advance` passes no state
  // override, so the engine resolves preferences through the home default.
  // Without this the shipped default applies, `review_gate` is true, the plugin
  // gates instead of running, and the child exits before it can be signalled.
  writeFileSync(join(dir, 'preferences.json'), JSON.stringify({ review_gate: false }))

  writeFileSync(
    join(plugin, 'manifest.ts'),
    `export const manifest = ${JSON.stringify({ name: 'slow', ...MANIFEST })}\n`,
  )
  // The output before the sleep is what the signal drain cases read. While a
  // handler runs, the runtime sends its `console.log` lines to stderr, and a
  // pipe reader that hasn't started leaves them queued in this process. The
  // pid file is those cases' readiness marker: written after the last line, so
  // all of them are queued by the time the signal is sent.
  writeFileSync(
    join(plugin, 'handler.ts'),
    `import { writeFileSync } from 'node:fs'
export async function handler() {
  for (let i = 0; i < ${CHATTY_LINES}; i++) console.log('z'.repeat(499))
${tick ? "  setInterval(() => console.log('tick'), 20)\n" : ''}  writeFileSync(${JSON.stringify(join(dir, 'pid'))}, String(process.pid))
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
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'warpline-advance-sigint-'))
  slowPlugin(home, false)
  ticking = mkdtempSync(join(tmpdir(), 'warpline-advance-ticking-'))
  slowPlugin(ticking, true)

  // Long directory names make a large document from few plugins: each name
  // appears in it once, so 300 of them give about 70 KB. `manual` means none
  // of them is due, and the advance only reports them.
  fleet = mkdtempSync(join(tmpdir(), 'warpline-advance-drain-'))
  writeFileSync(join(fleet, 'preferences.json'), JSON.stringify({ review_gate: false }))
  for (let i = 0; i < 300; i++) {
    const name = `p${String(i).padStart(4, '0')}-${'0'.repeat(195)}`
    const dir = join(fleet, 'plugins', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'manifest.ts'),
      `export const manifest = ${JSON.stringify({ name, ...MANIFEST, schedule: 'manual' })}\n`,
    )
  }
})

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(ticking, { recursive: true, force: true })
  rmSync(fleet, { recursive: true, force: true })
})

/**
 * Runs `cmd` under `sh -c` with `home` as the warpline home, and collects what
 * reaches the pipeline's stdout. A shell pipeline is the only reader that can
 * hold bytes back the way a real consumer does: a delayed reader in this
 * process, or a paused `child.stdout`, still lets the child's writes complete,
 * so a test built on either can't go red.
 *
 * The env is passed explicitly. A bun child spawned with the default env sees
 * the env as it was when this process started, not as it is now.
 */
function sh(cmd: string, home: string): Promise<{ out: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', cmd], {
      env: { ...process.env, WARPLINE_HOME: home },
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      out += chunk
    })
    child.on('error', reject)
    child.on('close', code => resolve({ out, code }))
  })
}

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

test('advance --json through a slow pipe reader is one whole document', async () => {
  // The control first: the same command into a file, which a process exit
  // can't cut. It must be larger than a pipe buffer, or the case below would
  // pass with no drain at all.
  const control = join(fleet, 'control.json')
  await sh(`"${process.execPath}" "${ENTRY}" advance --json > "${control}"`, fleet)
  expect(readFileSync(control, 'utf8').length).toBeGreaterThan(65_536)

  // The reader sleeps before it reads, so the pipe fills and the rest of the
  // document is still queued in the process when the command returns. Not
  // compared byte for byte with the control: counters can differ between runs.
  const { out } = await sh(`"${process.execPath}" "${ENTRY}" advance --json | (sleep 1; cat)`, fleet)
  const doc = JSON.parse(out)
  expect(doc.plugins).toHaveLength(300)
})

/**
 * One SIGTERM'd advance in `dir`, with its stderr into a reader that starts
 * 0.3 s after the signal. Returns the bin's exit code and what the reader got.
 *
 * The reader is gated on a file written after the kill, not on a timer. A
 * timed reader races the signal. This one proves the plugin's lines were
 * still queued when the signal landed. `rc` is the bin's own exit code, taken
 * by the shell inside the pipeline.
 */
async function sigtermDrain(dir: string, runtime: string, entry: string): Promise<{ rc: string; out: string }> {
  const pidFile = join(dir, 'pid')
  const signalled = join(dir, 'signalled')
  const rc = join(dir, 'rc')
  // The earlier cases leave their lock and pid behind, for the same reason
  // `advanceKilledWith` clears the lock.
  for (const stale of [join(dir, 'state', '.lock'), pidFile, signalled, rc]) {
    rmSync(stale, { force: true })
  }

  const result = sh(
    `{ "${runtime}" "${entry}" advance 2>&1 >/dev/null; echo $? > "${rc}"; } | (while [ ! -e "${signalled}" ]; do sleep 0.05; done; sleep 0.3; cat)`,
    dir,
  )

  const deadline = Date.now() + 15_000
  let pid = ''
  while ((pid = existsSync(pidFile) ? readFileSync(pidFile, 'utf8') : '') === '') {
    if (Date.now() > deadline) {
      writeFileSync(signalled, '') // release the reader so the pipeline can end
      throw new Error('the slow plugin never wrote its pid')
    }
    await new Promise<void>(resolve => setTimeout(resolve, 20))
  }

  process.kill(Number(pid), 'SIGTERM')
  writeFileSync(signalled, '')
  const { out } = await result
  return { rc: readFileSync(rc, 'utf8').trim(), out }
}

test('SIGTERM drains the plugin output still queued on stderr before exiting 130', async () => {
  const { rc, out } = await sigtermDrain(home, process.execPath, ENTRY)

  expect(rc).toBe('130')
  expect(out.split('\n').filter(line => line === 'z'.repeat(499))).toHaveLength(CHATTY_LINES)
})

for (const [name, runtime, entry] of [
  ['node', NODE, BIN],
  ['bun', process.execPath, ENTRY],
] as const) {
  test(`SIGTERM keeps the queued plugin output whole while the plugin is still printing (${name})`, async () => {
    const { rc, out } = await sigtermDrain(ticking, runtime, entry)

    expect(rc).toBe('130')
    expect(out.split('\n').filter(line => line === 'z'.repeat(499))).toHaveLength(CHATTY_LINES)
  }, 30_000)
}
