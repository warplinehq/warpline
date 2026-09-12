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
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
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
