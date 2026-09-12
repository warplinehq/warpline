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
import { join } from 'node:path'
import { createTestHome } from '../../runtime/__tests__/helpers/create-test-home.js'
import type { TestHome } from '../../runtime/__tests__/helpers/create-test-home.js'
import { _setHome } from '../../lib/paths.js'
import { _getPaths, _setPaths, pathsForStateFile } from '../../board/state-manager.js'
import { main } from '../warpline.js'

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
