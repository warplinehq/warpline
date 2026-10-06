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
 * So this file launches the real bin ten times. Two are the exit-code cases,
 * one per signal, because a second signal is a second disposition. Six are
 * the drain cases. Two are the audit lock case, an interrupted advance and the
 * one after it. Any further interrupt behaviour — the handler being removed
 * again, for instance — belongs in `advance.test.ts`, which can observe it
 * without a launch.
 *
 * The audit lock case is about what an interrupt leaves behind. An advance
 * signalled while it holds `audit/.lock` exits through `process.exit(130)`, so
 * the hold's own release never runs. The store's exit hook removes the lock on
 * the way out, and the next advance must run at once rather than fail every
 * append until the lock is 30 seconds old.
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
 * The load-print case is the one stdout drain case. A manifest that printed at
 * module scope used to queue its lines on stdout, and the plugin's return put
 * the stream's real write back over the drain's. The next write then cut the
 * queue at 131 of 400 lines, on node and on bun. Either half of the fix keeps
 * this case green alone: the load redirect leaves stdout nothing queued, and
 * the release leaves the drain's write in place. So it goes red only when both
 * are gone. advance.test.ts pins the load redirect, and invoke-plugin.test.ts
 * pins the release.
 *
 * The handler's two-second ceiling exits 130 even when the drain never
 * settles. So the keep-printing and load-print cases also time the exit from
 * the signal, and one that ends after 1.5 s is the ceiling, not the drain. The
 * run case in closed-reader.test.ts has no ceiling and still guards a drain
 * that never settles on that path.
 */
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
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

/**
 * Writes the `loud` plugin into `dir`. Its manifest prints CHATTY_LINES lines
 * to stdout at module scope, and its handler returns 100 ms after the signal.
 *
 * A manifest that prints at module scope is the one input that queues bytes on
 * advance's stdout before a signal: the engine imports the manifest before any
 * handler runs. The handler returns during the drain because its return is what
 * took the plugin redirect off stdout, and the drain's own write with it. The
 * next stdout write then reached an ended stream, and the drain settled before
 * the queue had flushed.
 */
function loudPlugin(dir: string): void {
  const plugin = join(dir, 'plugins', 'loud')
  mkdirSync(plugin, { recursive: true })
  writeFileSync(join(dir, 'preferences.json'), JSON.stringify({ review_gate: false }))

  writeFileSync(
    join(plugin, 'manifest.ts'),
    `for (let i = 0; i < ${CHATTY_LINES}; i++) process.stdout.write('m'.repeat(499) + '\\n')
export const manifest = ${JSON.stringify({ name: 'loud', ...MANIFEST })}\n`,
  )
  writeFileSync(
    join(plugin, 'handler.ts'),
    `import { existsSync, writeFileSync } from 'node:fs'
export async function handler() {
  writeFileSync(${JSON.stringify(join(dir, 'pid'))}, String(process.pid))
  while (!existsSync(${JSON.stringify(join(dir, 'signalled'))})) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  await new Promise(resolve => setTimeout(resolve, 100))
  return {
    status: 'success',
    phases_completed: ['loud'],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: 'loud completed',
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
 * One SIGTERM'd advance in `dir`, with one of its streams into a reader that
 * starts 0.3 s after the signal. The reader gets stderr by default, and
 * `streams` can send stdout there instead. Returns the bin's exit code, what
 * the reader got, and `elapsed`.
 *
 * The reader is gated on a file written after the kill, not on a timer. A
 * timed reader races the signal. This one proves the plugin's lines were
 * still queued when the signal landed. `rc` is the bin's own exit code, taken
 * by the shell inside the pipeline.
 *
 * `elapsed` runs from the signal to the pipeline's end, so it includes the
 * reader's 0.3 s wait. An exit by the two-second ceiling can't come in under
 * 1.5 s.
 */
async function sigtermDrain(
  dir: string,
  runtime: string,
  entry: string,
  streams = '2>&1 >/dev/null',
): Promise<{ rc: string; out: string; elapsed: number }> {
  const pidFile = join(dir, 'pid')
  const signalled = join(dir, 'signalled')
  const rc = join(dir, 'rc')
  // The earlier cases leave their lock and pid behind, for the same reason
  // `advanceKilledWith` clears the lock.
  for (const stale of [join(dir, 'state', '.lock'), pidFile, signalled, rc]) {
    rmSync(stale, { force: true })
  }

  const result = sh(
    `{ "${runtime}" "${entry}" advance ${streams}; echo $? > "${rc}"; } | (while [ ! -e "${signalled}" ]; do sleep 0.05; done; sleep 0.3; cat)`,
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
  const killedAt = Date.now()
  writeFileSync(signalled, '')
  const { out } = await result
  return { rc: readFileSync(rc, 'utf8').trim(), out, elapsed: Date.now() - killedAt }
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
    const { rc, out, elapsed } = await sigtermDrain(ticking, runtime, entry)

    expect(rc).toBe('130')
    expect(out.split('\n').filter(line => line === 'z'.repeat(499))).toHaveLength(CHATTY_LINES)
    // The ceiling exits 130 at two seconds with the queue already flushed, so
    // only the clock tells the drain from it.
    expect(elapsed).toBeLessThan(1_500)
  }, 30_000)

  test(`SIGTERM keeps what the manifest printed at load whole when the plugin returns during the drain (${name})`, async () => {
    // A fresh home per run, because this plugin completes, unlike the slow and
    // ticking ones. A completed run stays fresh for `ttl_hours: 0.001` (3.6 s),
    // so the second runtime would find nothing due and never write its pid.
    const dir = mkdtempSync(join(tmpdir(), 'warpline-advance-loud-'))
    try {
      loudPlugin(dir)
      const stderrFile = join(dir, 'stderr')
      const { rc, out, elapsed } = await sigtermDrain(dir, runtime, entry, `2> "${stderrFile}"`)

      // Both streams are counted. Where the lines land is advance.test.ts's
      // question, and this case asks only that none is lost. Once the load is
      // redirected they are on stderr. The newline between keeps a line cut at
      // the pipe buffer from fusing with the first line of the other stream.
      const both = `${readFileSync(stderrFile, 'utf8')}\n${out}`
      expect(rc).toBe('130')
      expect(both.split('\n').filter(line => line === 'm'.repeat(499))).toHaveLength(CHATTY_LINES)
      expect(elapsed).toBeLessThan(1_500)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
}

/**
 * The hold is kept open by a FIFO in place of the first segment. The store
 * reads the segment under the audit lock before it appends, and a read of a
 * FIFO with no writer blocks, so the advance sits inside its hold until the
 * signal lands. The audit lock existing is the readiness marker.
 *
 * Bun only. Measured when this case was written: under node 24 the blocked
 * FIFO read keeps the process from exiting after the handler and the exit
 * listener run. Under bun 1.4.2 the process exits 130.
 */
test('an advance interrupted while it holds the audit lock leaves no lock, and the next advance runs at once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'warpline-advance-audit-lock-'))
  let first: ChildProcess | undefined
  try {
    writeFileSync(join(dir, 'preferences.json'), JSON.stringify({ review_gate: false }))
    const plugin = join(dir, 'plugins', 'quick')
    mkdirSync(plugin, { recursive: true })
    writeFileSync(join(plugin, 'manifest.ts'), `export const manifest = ${JSON.stringify({ name: 'quick', ...MANIFEST })}\n`)
    writeFileSync(
      join(plugin, 'handler.ts'),
      `export async function handler() {
  return {
    status: 'success',
    phases_completed: ['quick'],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: 'quick completed',
    artifacts_produced: [],
    schema_version: 1,
  }
}\n`,
    )
    const auditDir = join(dir, 'audit')
    mkdirSync(auditDir)
    const segment = join(auditDir, '0000000000000001.jsonl')
    execFileSync('/usr/bin/mkfifo', [segment])
    const auditLock = join(auditDir, '.lock')

    const env = { ...process.env, WARPLINE_HOME: dir }
    first = spawn(process.execPath, [ENTRY, 'advance'], { env, stdio: 'ignore' })
    const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => {
      first?.on('exit', (code, sig) => resolve({ code, signal: sig }))
    })
    const deadline = Date.now() + 15_000
    while (!existsSync(auditLock)) {
      if (Date.now() > deadline) throw new Error('the advance never took the audit lock')
      await new Promise<void>(resolve => setTimeout(resolve, 20))
    }
    first.kill('SIGTERM')
    const firstExit = await exited
    const lockLeft = existsSync(auditLock)

    // The run lock is left too, because the run lock's own release never ran
    // either. Healing a dead holder's run lock belongs to § 12 and is pinned in
    // lock.test.ts. This case is about the audit lock, so it removes the run
    // lock by hand, as `advanceKilledWith` does, with the FIFO.
    rmSync(segment, { force: true })
    rmSync(join(dir, 'state', '.lock'), { force: true })
    const started = Date.now()
    const second = spawnSync(process.execPath, [ENTRY, 'advance'], { env, encoding: 'utf8', timeout: 20_000 })
    const elapsed = Date.now() - started

    expect(firstExit).toEqual({ code: 130, signal: null })
    expect(second.status).toBe(0)
    expect(elapsed).toBeLessThan(8_000)
    expect(second.stderr).not.toContain('audit lock not acquired')
    const types = readFileSync(segment, 'utf8')
      .split('\n')
      .filter(line => line !== '')
      .map(line => (JSON.parse(line) as { type: string }).type)
    expect(types).toContain('warpline.audit.preferences.observed')
    // Last, so a failure here shows the second advance ran all the same.
    expect(lockLeft).toBe(false)
  } finally {
    if (first !== undefined && first.exitCode === null && first.signalCode === null) first.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  }
}, 30_000)
