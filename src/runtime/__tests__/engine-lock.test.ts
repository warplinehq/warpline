/**
 * The run lock, inside the advance.
 *
 * Everything here drives `runAdvance` DIRECTLY rather than through
 * `main(['advance'])`. The claim the lock is wired for is about programmatic
 * hosts — the benchmark harness calls the advance with no options at all — and
 * a suite that only goes through the CLI would prove the CLI path and leave
 * that claim unpinned. The CLI's own contention behaviour has its own file.
 *
 * Two of the cases below are the release mirror: after a successful advance,
 * and after a quiet-hours advance, no lock survives. They were written first
 * and watched fail with the `finally` body commented out, because nothing else
 * in the tree pins the release and a suite that was green before and after
 * would have proven nothing about it. A leaked lock is the expensive silent
 * defect here: it is unhealable for two hours, which under a fifteen-minute
 * tick is eight consecutive advances reporting "retry later".
 *
 * `existsSync` AFTER the advance cannot tell a released lock from a lock that
 * was never taken, so the success case also observes the lock mid-run through
 * `onPluginStart`. Without that, every assertion in this file is satisfied by
 * an engine with no lock in it at all — the out-of-reach-guard shape this
 * project has recorded six times.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTestHome, type TestHome } from './helpers/create-test-home.js'
import { _setHome, lockPath } from '../../lib/paths.js'
import type { AdvanceOptions } from '../engine.js'

let ctx: TestHome

/** The options every case shares: the temp home, nothing live. */
function advanceOptions(overrides: Partial<AdvanceOptions> = {}): AdvanceOptions {
  return {
    pluginsDir: ctx.pluginsDir,
    stateDir: join(ctx.stateDir, 'engine-state.json'),
    runsDir: ctx.runsDir,
    logsDir: join(ctx.root, 'logs'),
    eventsPath: join(ctx.runsDir, 'events.jsonl'),
    ...overrides,
  }
}

/** A due autonomous plugin whose handler succeeds. */
async function writePlugin(name: string): Promise<void> {
  const dir = join(ctx.pluginsDir, name)
  await mkdir(dir, { recursive: true })
  const manifest = {
    name,
    version: '1.0.0',
    description: `${name} fixture`,
    inputs: {},
    outputs: {},
    capabilities: [],
    secrets: [],
    schedule: 'on_run',
    autonomy_level: 'autonomous',
    side_effects: [],
    ttl_hours: 0.001,
    dependencies: [],
    timeout_ms: 5000,
    max_parallelism: 1,
    max_retries: 1,
    retry_delay_ms: 2000,
    min_tier: 'normal',
  }
  await writeFile(join(dir, 'manifest.ts'), `export const manifest = ${JSON.stringify(manifest)}`)
  await writeFile(
    join(dir, 'handler.ts'),
    `
export async function handler() {
  return {
    status: 'success',
    phases_completed: ['${name}'],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: '${name} completed',
    artifacts_produced: [],
    schema_version: 1,
  }
}
`,
  )
}

/**
 * A quiet-hours window that contains right now, whatever "now" is.
 *
 * Derived rather than hardcoded: `isQuietHours` reads the LOCAL clock, so a
 * fixed `22:00`-`07:00` window asserts one branch on a developer's machine at
 * noon and the other in a CI job that happens to run at midnight. A window one
 * hour either side of now is active in every zone and at every hour, including
 * across the midnight wrap, which the overnight branch already handles.
 */
function quietHoursAroundNow(): { start: string; end: string } {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const at = (offsetMs: number): string => {
    const d = new Date(Date.now() + offsetMs)
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
  return { start: at(-60 * 60 * 1000), end: at(60 * 60 * 1000) }
}

/** Overwrite the helper's preferences fixture, keeping the gating opt-out. */
async function writePreferences(extra: Record<string, unknown>): Promise<void> {
  await writeFile(
    join(ctx.stateDir, 'preferences.json'),
    JSON.stringify({ review_gate: false, ...extra }),
  )
}

/**
 * A lock file on disk with a live holder: this process, right now.
 *
 * Both halves matter. A PID that is alive makes the liveness check true by
 * construction, and a fresh timestamp keeps it inside the two-hour window, so
 * the heal branch cannot fire and the acquire has to refuse.
 */
async function writeLiveLock(path: string): Promise<void> {
  await writeFile(
    path,
    JSON.stringify({
      acquired_at: new Date().toISOString(),
      run_id: 'held-by-someone-else',
      mode: 'advance',
      pid: process.pid,
    }),
  )
}

beforeEach(async () => {
  ctx = await createTestHome()
  _setHome(ctx.root)
})

afterEach(async () => {
  _setHome(null)
  await ctx.cleanup()
})

describe('runAdvance takes the run lock and gives it back', () => {
  test('a normal advance holds the lock while a plugin runs, and leaves none behind', async () => {
    const { runAdvance } = await import('../engine.js')
    await writePlugin('alpha')

    // The load-bearing assertion of this file. `existsSync` afterwards is
    // equally false against an engine that never took a lock at all; this is
    // the one observation that says the lock was actually held.
    const seen = { observed: false, held: false }
    const result = await runAdvance(
      advanceOptions({
        onPluginStart: () => {
          seen.observed = true
          seen.held = existsSync(lockPath())
        },
      }),
    )

    expect(result.status).toBe('complete')
    expect(seen).toEqual({ observed: true, held: true })
    expect(existsSync(lockPath())).toBe(false)
  })

  test('a quiet-hours advance returns early and still leaves no lock', async () => {
    const { runAdvance } = await import('../engine.js')
    await writePlugin('alpha')
    await writePreferences({ quiet_hours: quietHoursAroundNow() })

    const result = await runAdvance(advanceOptions())

    // The early return actually happened — otherwise this case is the success
    // case again under a different name, and the arm that leaks is untested.
    //
    // The empty run-log path is what says it, and `alpha` being `skipped`
    // rather than `completed` is the second half. This used to assert an empty
    // states map, which was an assertion on a bug: the arm returned a fresh
    // empty map whatever the root held, and an empty map is the zero-manifest
    // signature the exit code reads. The proof of the early return was never
    // the map's size.
    expect(result.plugin_states.get('alpha')).toBe('skipped')
    expect(result.run_log_path).toBe('')
    expect(existsSync(lockPath())).toBe(false)
  })

  test('an advance that throws from inside the locked span still releases', async () => {
    const { runAdvance } = await import('../engine.js')
    await writePlugin('alpha')
    // Corrupt state: the read is the first thing inside the span, so this
    // throws below the acquire and above every other write.
    await writeFile(join(ctx.stateDir, 'engine-state.json'), '{"schema_version": 1, "plugin_runs":')

    await expect(runAdvance(advanceOptions())).rejects.toThrow()

    expect(existsSync(lockPath())).toBe(false)
  })

  test('a plugin root that cannot be read is refused before any lock is created', async () => {
    const { runAdvance } = await import('../engine.js')
    const absent = join(ctx.root, 'no-such-plugin-root')

    await expect(runAdvance(advanceOptions({ pluginsDir: absent }))).rejects.toThrow(/ENOENT/)

    expect(existsSync(lockPath())).toBe(false)
  })

  test('two sequential advances both succeed with no cleanup between them', async () => {
    const { runAdvance } = await import('../engine.js')
    await writePlugin('alpha')

    const first = await runAdvance(advanceOptions())
    expect(first.status).toBe('complete')
    expect(existsSync(lockPath())).toBe(false)

    // Nothing is unlinked here on purpose. A `finally` scoped to the wrong span
    // makes this second call the one that fails, and a test that swept the lock
    // in its own teardown would hide exactly that.
    const second = await runAdvance(advanceOptions())
    expect(second.status).toBe('complete')
    expect(existsSync(lockPath())).toBe(false)
  })

  /**
   * The order in the `finally`, read off the source. A heartbeat refresh still
   * in flight at the release would write the lock back, held by a run that has
   * ended, and every later advance would be refused for two hours. That the
   * stop waits for a refresh in flight is pinned in `lock.test.ts`. This pins
   * that the release waits for the stop, which no advance in a test lives long
   * enough to reach by timing.
   */
  test('the heartbeat is stopped and awaited before the lock is released', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'engine.ts'), 'utf-8')
    const stop = 'await stopHeartbeat()'
    const release = 'await releaseLock(resolvedLockPath, heldLock.run_id)'
    expect(source.split(stop).length - 1).toBe(1)
    expect(source.split(release).length - 1).toBe(1)
    expect(source.indexOf(stop)).toBeLessThan(source.indexOf(release))
  })
})

describe('runAdvance against a lock somebody else holds', () => {
  test('a live holder refuses the advance by name and keeps its own lock', async () => {
    const { runAdvance } = await import('../engine.js')
    await writePlugin('alpha')
    await writeLiveLock(lockPath())
    const before = await readFile(lockPath(), 'utf-8')

    await expect(runAdvance(advanceOptions())).rejects.toThrow(/held by PID/)

    // The refusal must not break the lock it refused: the holder is still
    // running and its lock is byte-identical.
    expect(existsSync(lockPath())).toBe(true)
    expect(await readFile(lockPath(), 'utf-8')).toBe(before)
  })

  test('a stale lock heals and the advance runs', async () => {
    const { runAdvance } = await import('../engine.js')
    await writePlugin('alpha')
    await writeFile(
      lockPath(),
      JSON.stringify({
        acquired_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
        run_id: 'abandoned',
        mode: 'advance',
        pid: process.pid,
      }),
    )

    const result = await runAdvance(advanceOptions())

    expect(result.status).toBe('complete')
    expect(existsSync(lockPath())).toBe(false)
  })
})

describe('the lock follows a relocated state file', () => {
  test('a state override puts the lock beside it and never under the live home', async () => {
    const { runAdvance } = await import('../engine.js')
    await writePlugin('alpha')

    const elsewhere = join(ctx.root, 'elsewhere')
    await mkdir(elsewhere, { recursive: true })
    await writeFile(join(elsewhere, 'preferences.json'), JSON.stringify({ review_gate: false }))
    const relocated = join(elsewhere, '.lock')
    // Nothing may pre-exist at either path, or "it appeared" and "it was
    // already there" are the same observation.
    await rm(lockPath(), { force: true })

    // `observed` is in the record for the same reason the mid-run check exists:
    // a hook that never fired would leave the other two fields at their
    // initial values, which is exactly what a correct run must not look like.
    const lockedAt = { observed: false, relocated: false, home: false }
    const result = await runAdvance(
      advanceOptions({
        stateDir: join(elsewhere, 'engine-state.json'),
        onPluginStart: () => {
          lockedAt.observed = true
          lockedAt.relocated = existsSync(relocated)
          lockedAt.home = existsSync(lockPath())
        },
      }),
    )

    expect(result.status).toBe('complete')
    // Mid-run: the lock is in the override's own directory, and the live home's
    // lock path was never touched. This is the whole of the claim — asserting
    // only the absence afterwards is satisfied by an engine that locked the
    // wrong file and tidied up after itself.
    expect(lockedAt).toEqual({ observed: true, relocated: true, home: false })
    expect(existsSync(relocated)).toBe(false)
    expect(existsSync(lockPath())).toBe(false)
  })
})
