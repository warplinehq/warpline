/**
 * Shared test helper: creates a standard warpline temp directory structure
 * with all required fixture files.
 *
 * Use this in any test that needs a warpline-like home directory (engine, plugins, etc.)
 * instead of manually creating dirs and writing fixtures — ensures no required
 * file is accidentally omitted.
 *
 * Usage:
 *   const ctx = await createTestHome()
 *   // ... run tests using ctx.root, ctx.pluginsDir, ctx.stateDir, ctx.runsDir
 *   await ctx.cleanup()
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export interface TestHome {
  /** Root temp directory (equivalent to .warpline/) */
  root: string
  pluginsDir: string
  stateDir: string
  runsDir: string
  /** Remove the entire temp directory */
  cleanup: () => Promise<void>
}

/**
 * Create a temp warpline home with all standard fixtures.
 *
 * @param overrides - Override default preferences values
 */
export async function createTestHome(
  overrides?: {
    preferences?: Record<string, unknown>
  },
): Promise<TestHome> {
  const root = join(tmpdir(), `warpline-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  const pluginsDir = join(root, 'plugins')
  const stateDir = join(root, 'state')
  const runsDir = join(root, 'runs')

  await mkdir(pluginsDir, { recursive: true })
  await mkdir(stateDir, { recursive: true })
  await mkdir(runsDir, { recursive: true })

  // preferences.json — review_gate defaults to false for tests
  // (production default is true, but tests should opt-in to gating, not trip over it)
  const preferences = {
    review_gate: false,
    ...overrides?.preferences,
  }
  await writeFile(
    join(stateDir, 'preferences.json'),
    JSON.stringify(preferences),
  )

  return {
    root,
    pluginsDir,
    stateDir,
    runsDir,
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}
