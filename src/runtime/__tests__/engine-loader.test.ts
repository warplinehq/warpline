/**
 * loadPluginManifests failure reporting (D-22).
 *
 * The loader used to swallow every manifest import error in a bare `catch {}`,
 * so a broken plugin vanished from the due-set with nothing to show for it.
 * It now returns `{ manifests, failures }` with `failures` sorted by directory
 * name inside the loader, so ordering is a property of the data rather than of
 * whichever surface renders it.
 *
 * Fixtures use the zero-import `export const manifest = {…}` form so a fixture
 * never depends on module resolution from a temp directory.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadPluginManifests } from '../engine.js'
import type { PluginManifest } from '../../schemas/plugin-manifest.js'

function makeManifest(name: string, overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    name,
    version: '1.0.0',
    description: `${name} fixture plugin`,
    inputs: {},
    outputs: {},
    capabilities: [],
    schedule: 'on_run',
    autonomy_level: 'autonomous',
    side_effects: [],
    ttl_hours: 24,
    dependencies: [],
    timeout_ms: 5000,
    max_parallelism: 1,
    min_tier: 'normal',
    max_retries: 1,
    retry_delay_ms: 2000,
    ...overrides,
  }
}

let pluginsDir: string
let root: string

async function writeValidPlugin(name: string): Promise<void> {
  const dir = join(pluginsDir, name)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'manifest.ts'),
    `export const manifest = ${JSON.stringify(makeManifest(name))}`,
  )
}

/** A manifest that throws on import — unterminated object literal. */
async function writeBrokenPlugin(name: string): Promise<void> {
  const dir = join(pluginsDir, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'manifest.ts'), `export const manifest = { name: '${name}',`)
}

beforeEach(async () => {
  root = join(tmpdir(), `warpline-loader-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  pluginsDir = join(root, 'plugins')
  await mkdir(pluginsDir, { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('loadPluginManifests — per-plugin load failures (D-22)', () => {
  test('Test 1: a broken manifest is reported in failures with a non-empty error', async () => {
    await writeValidPlugin('fx-good')
    await writeBrokenPlugin('fx-broken')

    const { manifests, failures } = await loadPluginManifests(pluginsDir)

    expect(manifests.has('fx-good')).toBe(true)
    expect(failures).toHaveLength(1)
    expect(failures[0]!.plugin).toBe('fx-broken')
    expect(failures[0]!.error.length).toBeGreaterThan(0)
  })

  test('Test 2: the broken directory is absent from manifests', async () => {
    await writeValidPlugin('fx-good')
    await writeBrokenPlugin('fx-broken')

    const { manifests } = await loadPluginManifests(pluginsDir)

    expect(manifests.has('fx-broken')).toBe(false)
    expect(Array.from(manifests.keys())).toEqual(['fx-good'])
  })

  test('Test 3: failures come back sorted by directory name regardless of creation order', async () => {
    await writeBrokenPlugin('zeta-broken')
    await writeBrokenPlugin('alpha-broken')
    await writeBrokenPlugin('mid-broken')

    const { failures } = await loadPluginManifests(pluginsDir)

    expect(failures.map((f) => f.plugin)).toEqual(['alpha-broken', 'mid-broken', 'zeta-broken'])
  })

  test('Test 4: an all-valid directory returns an empty failures array, not undefined', async () => {
    await writeValidPlugin('fx-a')
    await writeValidPlugin('fx-b')

    const { manifests, failures } = await loadPluginManifests(pluginsDir)

    expect(manifests.size).toBe(2)
    expect(Array.isArray(failures)).toBe(true)
    expect(failures).toEqual([])
  })

  test('Test 5: a missing plugins directory returns empty manifests and empty failures without throwing', async () => {
    const { manifests, failures } = await loadPluginManifests(join(root, 'does-not-exist'))

    expect(manifests.size).toBe(0)
    expect(failures).toEqual([])
  })
})
