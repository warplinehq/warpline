/**
 * The ONE process-launching test file in the repository (D-27).
 *
 * `warpline run`'s SIGINT->130 contract cannot be observed in-process: it is a
 * signal disposition plus a `process.exit`, and there is no in-process seam for
 * either. Everything else about `run` is covered by `run-plugin.test.ts`
 * without leaving the test process.
 *
 * Keep this file at one launch, one signal, one exit-code assertion. Launching
 * a process is where CLAUDE.md's documented ~3% timeout flake concentrates,
 * which is why the budget for this phase is exactly one such file. If you are
 * about to add a second scenario here, it belongs in `run-plugin.test.ts`.
 */
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { testFixturesDir } from '../../../test-utils/fixtures.js'

const ENTRY = testFixturesDir(import.meta.url, '../run-plugin.ts')
const FIXTURES = testFixturesDir(
  import.meta.url,
  '../../../test-utils/fixture-plugins',
)

/**
 * Retryable failures emit one `attempt_failed` notice each, so the event log
 * doubles as a progress marker. Waiting for the seventh puts the child inside
 * the ~1280 ms backoff before attempt 8 — far longer than the 50 ms the SIGINT
 * handler waits before exiting, so the 130 is not racing the invocation's own
 * completion. Signalling earlier than the first notice would hit the default
 * signal disposition, before the handler is installed.
 */
const NOTICES_BEFORE_SIGNAL = 7

let home: string

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'warpline-run-sigint-'))
  symlinkSync(FIXTURES, join(home, 'plugins'))
})

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
})

test('SIGINT during an invocation exits 130', async () => {
  const child = spawn(
    process.execPath,
    [ENTRY, 'retryable-fail-plugin', 'run', '--retries=10'],
    { env: { ...process.env, WARPLINE_HOME: home }, stdio: 'ignore' },
  )
  const exited = new Promise<{ code: number | null; signal: string | null }>(
    resolve => {
      child.on('exit', (code, signal) => resolve({ code, signal }))
    },
  )

  const events = join(home, 'state', 'events.jsonl')
  const deadline = Date.now() + 15_000
  for (;;) {
    const notices = existsSync(events)
      ? readFileSync(events, 'utf8').trimEnd().split('\n').length
      : 0
    if (notices >= NOTICES_BEFORE_SIGNAL) break
    if (Date.now() > deadline) throw new Error('invocation never got underway')
    await new Promise<void>(r => setTimeout(r, 20))
  }

  child.kill('SIGINT')
  const { code, signal } = await exited

  // Exactly 130, not merely non-zero: the handler exited deliberately rather
  // than the default disposition killing the process (which reports a signal
  // and a null code instead).
  expect(signal).toBeNull()
  expect(code).toBe(130)
}, 20_000)
