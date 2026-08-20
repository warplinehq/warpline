/**
 * `warpline plan` — the two failure states and the dependency-cycle state.
 *
 * The subject here is not the rendering (plan 02-05 unit-tested all six output
 * states against hand-built models) but the *exit contract*: a preview whose
 * due-set is known to be incomplete must not exit 0, because an exit 0 is the
 * one signal a script reads. That is the whole point — an incomplete due-set
 * presented as complete is a repudiation risk, not a cosmetic one.
 *
 * Everything runs in-process through `run(argv)` with the streams captured
 *; no subprocess, no build step.
 *
 * The broken fixtures are files of deliberately unparseable TypeScript. The
 * assertions name the plugin *directory* and the section headers, never bun's
 * error prose — "4 errors building …" is transpiler-version-dependent text and
 * pinning it would make a bun upgrade look like a warpline regression.
 */
import { describe, test, expect, beforeEach, afterEach, afterAll } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTestHome } from '../../runtime/__tests__/helpers/create-test-home.js'
import type { TestHome } from '../../runtime/__tests__/helpers/create-test-home.js'
import { _setHome } from '../../lib/paths.js'
import { _getPaths, _setPaths } from '../../board/state-manager.js'
import { run } from '../plan.js'

const REAL_PATHS = _getPaths()

/** A stack frame in either engine's format: `    at fn (file:line)`. */
const STACK_FRAME = /^\s+at\s/m

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

/** A loadable plugin: zero-import `export const manifest = {…}`, every field spelled out. */
async function writePlugin(
  home: TestHome,
  name: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const manifest = {
    name,
    version: '1.0.0',
    description: `fixture ${name}`,
    inputs: {},
    outputs: {},
    capabilities: [],
    schedule: 'on_run',
    autonomy_level: 'autonomous',
    side_effects: [],
    ttl_hours: 24,
    dependencies: [],
    timeout_ms: 5000,
    max_retries: 1,
    retry_delay_ms: 2000,
    max_parallelism: 1,
    min_tier: 'normal',
    ...overrides,
  }
  const dir = join(home.pluginsDir, name)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'manifest.ts'),
    `export const manifest = ${JSON.stringify(manifest, null, 2)}\n`,
  )
}

/**
 * A plugin directory whose `manifest.ts` cannot be transpiled at all.
 *
 * Deliberately a *syntax* error rather than a missing export: a file that parses
 * but exports nothing is silently ignored by the loader (no `mod.manifest`), so
 * it would produce no failure and prove nothing about this exit contract.
 */
async function writeBrokenPlugin(home: TestHome, name: string): Promise<void> {
  const dir = join(home.pluginsDir, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'manifest.ts'), 'export const manifest = {{{ not typescript\n')
}

let home: TestHome

beforeEach(async () => {
  home = await createTestHome()
  _setHome(home.root)
})

afterEach(async () => {
  _setHome(null)
  await home.cleanup()
})

afterAll(() => {
  _setPaths(REAL_PATHS)
})

describe('load failures', () => {
  test('Test 1: a partial failure prints the plan, the failures and an incompleteness warning, and exits 1', async () => {
    await writePlugin(home, 'alpha')
    await writeBrokenPlugin(home, 'broken-one')

    const { code, stdout } = await capture(() => run([]))

    // The exit code is the contract: the plan printed below is not the whole plan.
    expect(code).toBe(1)

    // The plan that COULD be computed is still shown — a partial failure is not
    // a reason to withhold the half of the answer that is trustworthy.
    expect(stdout).toContain('Due (1):')
    expect(stdout).toContain('  alpha (level 0)')
    expect(stdout).toContain('Not due: none — every plugin passed the filter chain.')

    // …alongside the failure and an explicit statement of what is missing.
    expect(stdout).toContain('Load failures (1):')
    expect(stdout).toContain('  broken-one: ')
    expect(stdout).toContain('⚠ The due-set below is incomplete — 1 plugin directory could not be loaded.')

    // Warnings before the due-set, never after it (02-05's section order).
    expect(stdout.indexOf('Load failures (1):')).toBeLessThan(stdout.indexOf('Due (1):'))
  })

  test('Test 2: a total failure prints only the failures and neither empty-state message, and exits 1', async () => {
    await writeBrokenPlugin(home, 'broken-one')
    await writeBrokenPlugin(home, 'broken-two')

    const { code, stdout } = await capture(() => run([]))

    expect(code).toBe(1)
    expect(stdout).toContain('Load failures (2):')
    expect(stdout).toContain('No plan could be computed — every plugin directory failed to load.')

    // The two claims a total failure must NOT make. Both would be false: two
    // plugins ARE installed, and whether any is due is exactly unknown. This is
    // asserted as an absence, because the bug shape is a *present* false claim.
    expect(stdout).not.toContain('No plugins installed.')
    expect(stdout).not.toContain('Nothing is due')

    // No plan means no plan sections at all, not empty ones.
    expect(stdout).not.toContain('Due (')
    expect(stdout).not.toContain('Not due')
  })

  test('Test 3: failures list alphabetically by directory name, whatever order they were created in', async () => {
    // Created zulu → alpha → mike; readdir order is filesystem-dependent and
    // the loader resolves them concurrently, so any ordering seen here is the
    // loader's sort rather than an accident of creation or scheduling.
    await writeBrokenPlugin(home, 'zulu-broken')
    await writeBrokenPlugin(home, 'alpha-broken')
    await writeBrokenPlugin(home, 'mike-broken')

    const { code, stdout } = await capture(() => run([]))

    expect(code).toBe(1)
    expect(stdout).toContain('Load failures (3):')
    expect(stdout.indexOf('alpha-broken')).toBeLessThan(stdout.indexOf('mike-broken'))
    expect(stdout.indexOf('mike-broken')).toBeLessThan(stdout.indexOf('zulu-broken'))
  })
})

describe('dependency cycle', () => {
  test('Test 4: a two-plugin cycle names both plugins and exits 1', async () => {
    await writePlugin(home, 'ping', { dependencies: ['pong'] })
    await writePlugin(home, 'pong', { dependencies: ['ping'] })

    const { code, stdout, stderr } = await capture(() => run([]))

    expect(code).toBe(1)
    // A cycle is a failure to produce output, so the report is on stderr and
    // stdout stays empty — a caller piping stdout gets nothing rather than a
    // plan-shaped document describing no plan.
    expect(stdout).toBe('')
    expect(stderr).toContain('Dependency cycle — no plan could be computed:')
    expect(stderr).toContain('ping')
    expect(stderr).toContain('pong')
    // No plan was computed, so no plan sections are printed.
    expect(stderr).not.toContain('Due (')
  })

  test('Test 5: the cycle is reported as a message, with no stack frame on stderr', async () => {
    await writePlugin(home, 'ping', { dependencies: ['pong'] })
    await writePlugin(home, 'pong', { dependencies: ['ping'] })

    const { code, stderr } = await capture(() => run([]))

    expect(code).toBe(1)
    expect(stderr).not.toBe('')
    // A cycle is an operator-fixable configuration state, not an internal
    // fault: a trace here would tell the operator to file a bug instead of
    // editing their manifest.
    expect(STACK_FRAME.test(stderr)).toBe(false)
    expect(stderr).not.toContain('at file:')
    // topoSort's thrown prefix is parsed, not echoed — the rendered report
    // replaces it, so the raw Error message must not leak through.
    expect(stderr).not.toContain('Dependency cycle detected:')
  })
})

describe('the no-failure case still exits 0', () => {
  test('Test 6: a home with no load failures prints no failures heading and exits 0', async () => {
    await writePlugin(home, 'alpha')
    await writePlugin(home, 'bravo')

    const { code, stdout } = await capture(() => run([]))

    expect(code).toBe(0)
    expect(stdout).not.toContain('Load failures')
    expect(stdout).not.toContain('incomplete')
    expect(stdout).toContain('Due (2):')
  })
})
