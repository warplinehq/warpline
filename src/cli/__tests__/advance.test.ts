/**
 * `warpline advance` entry-point tests — fixture homes, in process.
 *
 * The shape is `plan.test.ts`'s, deliberately: `createTestHome` re-rooted with
 * `_setHome`, and the state-manager paths global snapshotted once and restored
 * in `afterAll`. bun's module state is process-global, so a leaked temp path
 * breaks sibling files in the same shard.
 *
 * The paths global is also set per test rather than only restored at the end.
 * `advance` passes no overrides to `runAdvance`, so the engine's task-lock read
 * goes through that global — and a sibling file that set it and did not restore
 * would have this file comparing against a directory that no longer exists.
 *
 * Everything goes through `main([...])` rather than `run([...])`. The dispatcher
 * arm forwarding a code is half of what this command is, and a test that skips
 * it proves the other half twice.
 */
import { describe, test, expect, beforeEach, afterEach, afterAll } from 'bun:test'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { grantApproval } from '../../runtime/approval-gate.js'
import { createTestHome } from '../../runtime/__tests__/helpers/create-test-home.js'
import type { TestHome } from '../../runtime/__tests__/helpers/create-test-home.js'
import { _setHome } from '../../lib/paths.js'
import { _getPaths, _setPaths, pathsForStateFile } from '../../board/state-manager.js'
import { main } from '../warpline.js'
import { run } from '../advance.js'

const REAL_PATHS = _getPaths()

/** Run an async fn with stdout/stderr captured, always restoring the originals. */
async function capture(
  fn: () => Promise<number>,
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
    return { code: await fn(), stdout, stderr }
  } finally {
    process.stdout.write = realOut
    process.stderr.write = realErr
  }
}

/**
 * A due autonomous plugin: a zero-import manifest with every field spelled out,
 * and a handler that succeeds.
 *
 * `loadPluginManifests` casts rather than parses, so no schema default is
 * applied and an omitted field would arrive as undefined.
 */
async function writePlugin(
  home: TestHome,
  name: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const dir = join(home.pluginsDir, name)
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
    ...overrides,
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

let home: TestHome

beforeEach(async () => {
  home = await createTestHome()
  _setHome(home.root)
  // `<home>/preferences.json`, NOT the `<home>/state/preferences.json` that
  // `createTestHome` writes. `advance` passes no `stateDir` to `runAdvance`, so
  // the engine resolves preferences through the home default — which is one
  // level shallower than the helper's fixture. Without this the shipped
  // production default applies, `review_gate` is true, and every plugin gates:
  // a fixture that looks like it opted out of gating while the run gates
  // anyway.
  await writeFile(join(home.root, 'preferences.json'), JSON.stringify({ review_gate: false }))
  _setPaths(
    pathsForStateFile(join(home.stateDir, 'engine-state.json'), {
      eventsPath: join(home.runsDir, 'events.jsonl'),
    }),
  )
})

afterEach(async () => {
  _setHome(null)
  await home.cleanup()
})

afterAll(() => {
  _setPaths(REAL_PATHS)
})

describe('main([advance]) end to end', () => {
  test('one due plugin: exit 0, empty stderr, and the rendering names the plugin', async () => {
    await writePlugin(home, 'alpha')

    const { code, stdout, stderr } = await capture(() => main(['advance']))

    expect(stderr).toBe('')
    expect(code).toBe(0)
    expect(stdout).toContain('alpha: completed')
    expect(stdout).toContain('Gated: 0  Failed: 0  Exit: 0')
  })

  /**
   * `--force` is refused by `parseArgs` in strict mode, not by a check of ours.
   * That is the whole point: unattended operation must not acquire a consent
   * path by somebody adding a plausible-looking flag, and a parser that refuses
   * every unregistered name cannot be forgotten in review.
   */
  test('an unregistered flag exits 1 and the message names it, with the usage text', async () => {
    await writePlugin(home, 'alpha')

    const { code, stdout, stderr } = await capture(() => main(['advance', '--force']))

    expect(code).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toContain("--force")
    expect(stderr).toContain('Usage: warpline advance')
  })

  test('--yes is refused the same way, by the parser and not by a check of ours', async () => {
    await writePlugin(home, 'alpha')

    const { code, stderr } = await capture(() => main(['advance', '--yes']))

    expect(code).toBe(1)
    expect(stderr).toContain('--yes')
  })

  /**
   * The `75` arm, end to end. A plugin root that cannot be read makes
   * `runAdvance` throw before it writes anything, and "could not look" must not
   * report as "looked and it was fine".
   *
   * The stack assertion is not decoration: a stack under a scheduler lands in
   * the operator's mail carrying absolute paths, and none of it is actionable.
   */
  test('an unreadable plugin root exits 75 with a message and no stack', async () => {
    await rm(home.pluginsDir, { recursive: true, force: true })

    const { code, stdout, stderr } = await capture(() => main(['advance']))

    expect(code).toBe(75)
    expect(stdout).toBe('')
    expect(stderr).toContain('cannot read plugin root')
    expect(stderr).not.toContain('    at ')
  })
})

/**
 * The refusal to CREATE a home without a terminal.
 *
 * These cases call `run(argv, io)` directly rather than `main([...])`, which is
 * the only way either branch is reachable: `main` cannot inject stdin, and the
 * ambient `process.stdin.isTTY` is whatever the runner happens to have. A test
 * keyed on the ambient value asserts one branch on a developer's machine and the
 * other in CI, which is not a test.
 *
 * The discriminator is the MESSAGE, not the code. Against a home that does not
 * exist the plugin root does not exist either, so `runAdvance` throws and the
 * command already reports `75` — a case asserting only the number is green
 * against code that has no refusal in it at all, which is the out-of-reach-guard
 * shape this project has recorded six times.
 *
 * The narrowing, restated because widening it would defeat the phase: this
 * refuses to CREATE a home, never to RUN headless. An existing home plus a
 * non-terminal stdin is the case the whole phase exists for and it has a case
 * of its own below.
 */
describe('run(): no home and no terminal', () => {
  /** A path under the test home that nothing has created. */
  const absentHome = (): string => join(home.root, 'never-created')

  test('refuses with 75, names WARPLINE_HOME and the path, and creates nothing', async () => {
    const missing = absentHome()
    _setHome(missing)

    const first = await capture(() => run([], { stdin: {} }))

    expect(first.code).toBe(75)
    expect(first.stderr).toContain('refusing to create')
    expect(first.stderr).toContain('WARPLINE_HOME')
    expect(first.stderr).toContain(missing)
    expect(first.stdout).toBe('')
    expect(existsSync(missing)).toBe(false)

    // Idempotency: a second refusal is a second no-op. Nothing accumulates,
    // and the home is still absent afterwards.
    const second = await capture(() => run([], { stdin: {} }))

    expect(second.code).toBe(75)
    expect(second.stderr).toContain('refusing to create')
    expect(existsSync(missing)).toBe(false)
  })

  /**
   * A terminal means a human is there to see a home appear, so the check does
   * not fire. The assertion is the ABSENCE of the refusal rather than a code: a
   * nonexistent home is also a nonexistent plugin root, which the engine refuses
   * on its own path, so the code is not the discriminator here.
   */
  test('a terminal on stdin means the check does not fire', async () => {
    const missing = absentHome()
    _setHome(missing)

    const { stderr } = await capture(() => run([], { stdin: { isTTY: true } }))

    expect(stderr).not.toContain('refusing to create')
    expect(stderr).toContain('cannot read plugin root')
  })

  /**
   * The case the phase exists for, asserted explicitly rather than assumed. A
   * check widened to "refuse to run headless" would turn this red, which is the
   * point of writing it.
   */
  test('an existing home plus a non-terminal stdin runs normally', async () => {
    await writePlugin(home, 'alpha')

    const { code, stdout, stderr } = await capture(() => run([], { stdin: {} }))

    expect(code).toBe(0)
    expect(stderr).toBe('')
    expect(stdout).toContain('alpha: completed')
  })
})

/**
 * One stderr line when the preferences file exists and cannot be used.
 *
 * `readPreferences` keeps its three silent fallbacks; this is a second, reporting
 * read beside it. A silent default here is how an operator who set a long
 * retention window and fat-fingered the JSON gets the 30-day rule instead, and
 * the evidence they were preserving deleted, with exit code 0.
 */
describe('run(): the preferences report', () => {
  /** Every stderr line that mentions the preferences file. */
  const prefLines = (stderr: string): string[] =>
    stderr.split('\n').filter((line) => line.includes('preferences.json'))

  test('an absent preferences file says nothing', async () => {
    await writePlugin(home, 'alpha')
    await rm(join(home.root, 'preferences.json'), { force: true })

    const { stderr } = await capture(() => run([], { stdin: {} }))

    expect(prefLines(stderr)).toEqual([])
  })

  test('a valid preferences file says nothing', async () => {
    await writePlugin(home, 'alpha')

    const { code, stderr } = await capture(() => run([], { stdin: {} }))

    expect(prefLines(stderr)).toEqual([])
    expect(code).toBe(0)
  })

  test('a truncated preferences file is exactly one line, and the advance still runs', async () => {
    await writePlugin(home, 'alpha')
    await writeFile(join(home.root, 'preferences.json'), '{"review_gate": fal')

    const { code, stdout, stderr } = await capture(() => run([], { stdin: {} }))

    expect(prefLines(stderr)).toHaveLength(1)
    expect(prefLines(stderr)[0]).toContain(join(home.root, 'preferences.json'))
    // Reported, not raised: the run is unaffected and still renders.
    expect(stdout).toContain('Advance ')
    expect(code).not.toBe(75)
  })

  test('valid JSON with the wrong type for a known key is the same one line', async () => {
    await writePlugin(home, 'alpha')
    await writeFile(join(home.root, 'preferences.json'), JSON.stringify({ review_gate: 'yes' }))

    const { stderr } = await capture(() => run([], { stdin: {} }))

    expect(prefLines(stderr)).toHaveLength(1)
  })

  /**
   * The limit of the report, pinned so it is documented rather than discovered.
   * Zod strips unknown keys instead of failing, so a misspelled retention key
   * parses clean and this read has nothing to say about it. The pruned count in
   * the machine-readable output is the only confirmation a retention setting
   * took effect; this line is not that, and must not be read as if it were.
   */
  test('an unknown key inside the retention block says nothing — Zod strips it', async () => {
    await writePlugin(home, 'alpha')
    await writeFile(
      join(home.root, 'preferences.json'),
      JSON.stringify({ review_gate: false, retention: { dayz: 5 } }),
    )

    const { stderr } = await capture(() => run([], { stdin: {} }))

    expect(prefLines(stderr)).toEqual([])
  })
})

/**
 * A plugin whose manifest cannot be imported at all.
 *
 * The engine adds it to `plugin_states` as `failed`, which is the shape that
 * distinguishes "a plugin failed" (a non-empty map holding a failure) from "the
 * root held nothing importable" (an empty map). Both are `1`, and a mapper that
 * conflated them would report the wrong cause to whoever is reading the code.
 */
async function writeUnloadablePlugin(dir: string, name: string): Promise<void> {
  const pluginDir = join(dir, name)
  await mkdir(pluginDir, { recursive: true })
  await writeFile(join(pluginDir, 'manifest.ts'), `throw new Error('${name} manifest is broken')`)
}

/** A state document with the given plugin run records and nothing else. */
async function writeState(pluginRuns: Record<string, unknown>): Promise<void> {
  await writeFile(
    join(home.stateDir, 'engine-state.json'),
    JSON.stringify({
      schema_version: 1,
      last_run_id: null,
      last_run_at: null,
      last_interaction_at: null,
      plugin_runs: pluginRuns,
      deferrals: [],
      task_aging: [],
      completed_tasks: [],
      pending_gates: [],
      extensions: {},
    }),
  )
}

/**
 * A two-plugin fleet whose first level parks at the supervision gate.
 *
 * Supervised with a declared side effect and a live grant: the approval gate
 * passes and the supervision gate holds it, which is the shape the exit code
 * has to report as `0`. The dependent plugin is left in a later level, still
 * `pending` when the advance returns — the state a mapper written as "every
 * plugin reached a terminal state" would wrongly call a failure.
 */
async function writeGatedFleet(): Promise<void> {
  await writePlugin(home, 'producer', {
    autonomy_level: 'supervised',
    side_effects: ['sends_email'],
  })
  await writePlugin(home, 'consumer', { dependencies: ['producer'] })
  await grantApproval('producer', 4 * 60 * 60 * 1000, join(home.root, '.session-approval'))
}

/**
 * The whole in-process exit-code matrix, one case per arm.
 *
 * Everything here goes through `main(argv)` or `run(argv, io)`. The one proof in
 * this phase that costs a process launch is the signal case, and it belongs to
 * its own plan and its own file; a launch that crept in here would spend that
 * budget on cases that do not need it. The grep in this plan's verification is
 * what holds that, not this comment.
 */
describe('the advance exit-code matrix, in process', () => {
  test('a complete advance where nothing failed is 0', async () => {
    await writePlugin(home, 'alpha')
    await writePlugin(home, 'bravo')

    const { code, stdout, stderr } = await capture(() => main(['advance']))

    expect(code).toBe(0)
    expect(stderr).toBe('')
    expect(stdout).toContain('alpha: completed')
    expect(stdout).toContain('bravo: completed')
  })

  /**
   * Nothing due is not nothing installed. The plugin is inside its TTL, so the
   * filter chain skips it — and a skip is the runtime working, not a fault.
   */
  test('a fleet where nothing is due is 0', async () => {
    await writePlugin(home, 'alpha', { ttl_hours: 24 })
    await writeState({
      alpha: { last_run_at: new Date(Date.now() - 60_000).toISOString(), status: 'success' },
    })

    const { code, stdout } = await capture(() => main(['advance']))

    expect(code).toBe(0)
    // The rendering, not only the number: every assertion available here that
    // is about the code alone is also satisfied by a run in which `alpha`
    // executed, so a broken due-filter would pass. This is the one word that
    // says the filter chain held.
    expect(stdout).toContain('alpha: skipped')
    expect(stdout).toContain('Failed: 0')
  })

  /**
   * The gated arm, both ways round on one fixture.
   *
   * The state document is removed between the two runs on purpose: the first
   * advance parks the gate IN that document, so a second advance over it would
   * be answering a question already asked. Both halves assert the plugin is
   * actually gated, so a run that silently stopped gating cannot pass this by
   * returning the right number for the wrong reason.
   */
  test('a gated advance is 0, and the same fixture with --strict is 1', async () => {
    await writeGatedFleet()

    const lenient = await capture(() => main(['advance']))

    expect(lenient.stdout).toContain('producer: gated')
    expect(lenient.stdout).toContain('consumer: pending')
    expect(lenient.code).toBe(0)

    await rm(join(home.stateDir, 'engine-state.json'), { force: true })

    const strict = await capture(() => main(['advance', '--strict']))

    expect(strict.stdout).toContain('producer: gated')
    expect(strict.code).toBe(1)
  })

  /**
   * A failed load is `1`, and `--strict` moves nothing.
   *
   * Two test bodies rather than two advances in one body, and the reason is
   * worth writing down: a broken manifest is only broken ONCE per process.
   * `loadPluginManifests` reaches the manifest through `await import`, so the
   * second import of the same file URL is served from the runtime's module
   * cache, resolves without throwing, and carries no `manifest` export — the
   * plugin then lands in neither the loaded map nor the failure list and the
   * advance reports `0`. Each test gets its own temp home from `beforeEach`, so
   * each run imports a URL nothing has seen. The fixture is one helper so the
   * two halves cannot drift into testing different things.
   */
  const writeBrokenFleet = async (): Promise<void> => {
    await writePlugin(home, 'healthy')
    await writeUnloadablePlugin(home.pluginsDir, 'broken')
  }

  test('a plugin that failed to load is 1', async () => {
    await writeBrokenFleet()

    const { code, stdout } = await capture(() => main(['advance']))

    expect(stdout).toContain('broken: failed')
    expect(code).toBe(1)
  })

  test('a plugin that failed to load is still 1 under --strict', async () => {
    await writeBrokenFleet()

    const { code, stdout } = await capture(() => main(['advance', '--strict']))

    expect(stdout).toContain('broken: failed')
    expect(code).toBe(1)
  })

  /**
   * An empty plugin root is a DIRECTORY THAT EXISTS and holds nothing
   * importable, which is a different thing from a root that cannot be read —
   * that one is `75` and has its own case above. An operator whose deployment
   * dropped the plugins would otherwise get a clean `0` from a run that did
   * nothing at all.
   */
  test('a plugin root that loaded no manifests is 1, with and without --strict', async () => {
    const lenient = await capture(() => main(['advance']))

    expect(lenient.stdout).toContain('no plugin manifests loaded')
    expect(lenient.code).toBe(1)

    const strict = await capture(() => main(['advance', '--strict']))

    expect(strict.code).toBe(1)
  })

  /**
   * The asymmetry, both halves in one body because the asymmetry IS the claim.
   *
   * An unreadable state document is `75` for this command — nothing ran and
   * nothing was written, so "could not look" must not report as "looked and it
   * was fine". Every other verb keeps the `1` the dispatcher published for it,
   * and it keeps it because this command intercepts the error before the
   * dispatcher's catch can see it, rather than by editing that catch.
   *
   * The paired half is `deny` and not `plan`: `plan` reads through the tolerant
   * accessor precisely so a preview cannot fail, so it would answer `0` here and
   * prove nothing.
   *
   * The bytes are compared before and after both calls. "Nothing was written" is
   * half of what `75` promises, and a command that healed the document on its
   * way past would satisfy the code assertion while breaking the promise.
   */
  test('a corrupt state document is 75 for advance and still 1 for deny', async () => {
    await writePlugin(home, 'alpha')
    const statePath = join(home.stateDir, 'engine-state.json')
    await writeFile(statePath, '{"schema_version": 1, "plugin_runs":')
    const before = await readFile(statePath, 'utf-8')

    const advanced = await capture(() => main(['advance']))

    expect(advanced.code).toBe(75)
    expect(advanced.stdout).toBe('')

    const denied = await capture(() => main(['deny', '--list']))

    expect(denied.code).toBe(1)
    expect(denied.stderr).toContain('Cannot read engine state')

    expect(await readFile(statePath, 'utf-8')).toBe(before)
  })

  /**
   * The flag refusal, and the half that matters more than the number: nothing
   * ran. An unattended runtime must not acquire a consent path, and the cheapest
   * true enforcement of that is that the flag does not exist — the message comes
   * from the parser, not from a check of ours.
   */
  test('an unregistered flag runs nothing at all — no run log under the home', async () => {
    await writePlugin(home, 'alpha')

    const { code, stdout } = await capture(() => main(['advance', '--force']))

    expect(code).toBe(1)
    expect(stdout).toBe('')
    expect(await readdir(home.runsDir)).toEqual([])
  })

  /** The home refusal, re-asserted here so the table has one home. */
  test('a missing home with no terminal on stdin is 75', async () => {
    _setHome(join(home.root, 'never-created'))

    const { code, stderr } = await capture(() => run([], { stdin: {} }))

    expect(code).toBe(75)
    expect(stderr).toContain('refusing to create')
  })
})

/**
 * The third `75` cause: somebody else is already advancing this home.
 *
 * The single catch already reported `75` for any throw out of the advance, so
 * the number was never the work here — the MESSAGE was. A scheduler's mail
 * saying only "held by PID 4213" leaves the operator to work out whether
 * anything ran, whether the next tick will fix it, and whether the lock will
 * ever clear on its own. All three go in the line.
 *
 * Three assertions per contention case, not one. A case asserting only the code
 * is green against a command with no lock arm in it at all, because a refusal
 * anywhere inside the advance already produces that code.
 *
 * The fixtures are written here rather than imported from the lock suite: they
 * are four literal fields, and the live-holder one is only correct because both
 * of its halves are — this process's own id, so the liveness check is true by
 * construction, and a fresh timestamp, so the two-hour heal cannot fire.
 */
describe('a lock somebody else holds', () => {
  /** Where `advance` looks: it passes no overrides, so the home default. */
  const lock = (): string => join(home.stateDir, '.lock')

  const writeLock = async (fields: Record<string, unknown>): Promise<void> => {
    await writeFile(
      lock(),
      JSON.stringify({
        acquired_at: new Date().toISOString(),
        run_id: 'held-by-someone-else',
        mode: 'advance',
        ...fields,
      }),
    )
  }

  test('a live holder is 75, names the holding process, and runs nothing', async () => {
    await writePlugin(home, 'alpha')
    await writeLock({ pid: process.pid })

    const { code, stdout, stderr } = await capture(() => main(['advance']))

    expect(code).toBe(75)
    expect(stdout).toBe('')
    expect(stderr).toContain(String(process.pid))
    expect(stderr).toContain('Nothing ran and nothing was written')
    // The refusal left the home as it found it: the holder's lock is untouched
    // and no run appeared under it.
    expect(existsSync(lock())).toBe(true)
    expect(await readdir(home.runsDir)).toEqual([])
  })

  test('an orchestrator-held lock is 75 and never prints the word for an absent value', async () => {
    await writePlugin(home, 'alpha')
    await writeLock({ pid: null })

    const { code, stdout, stderr } = await capture(() => main(['advance']))

    expect(code).toBe(75)
    expect(stdout).toBe('')
    expect(stderr).toContain('orchestrator')
    // `held by PID null` would satisfy a grep for the holder and tell an
    // operator nothing.
    expect(stderr).not.toContain('null')
    expect(stderr).toContain('Nothing ran and nothing was written')
    expect(existsSync(lock())).toBe(true)
    expect(await readdir(home.runsDir)).toEqual([])
  })

  test('a lock older than two hours heals and the advance runs', async () => {
    await writePlugin(home, 'alpha')
    await writeLock({
      pid: process.pid,
      acquired_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    })

    const { code, stdout } = await capture(() => main(['advance']))

    expect(code).not.toBe(75)
    expect(stdout).toContain('alpha: completed')
    expect(existsSync(lock())).toBe(false)
  })
})
