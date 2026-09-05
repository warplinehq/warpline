/**
 * A read seam over `last_output`, and the three ways it could stop being one.
 *
 * The field already exists, is written on both engine arms, and is read today
 * by one fingerprint helper. The risk in surfacing it to plugins is not that
 * the read is hard — it is that the reader grows into a second store, a second
 * answer to "has anything changed upstream", or a second thing that touches
 * disk. The cases below are written against those three, not against the happy
 * path, which is one line.
 *
 * Every fixture goes through `EngineStateSchema.parse`, so a literal here
 * cannot drift from the shape the engine actually persists.
 */
import { describe, test, expect } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { readDependencyOutput } from '../outputs.js'
import { EngineStateSchema } from '../../schemas/engine-state.js'
import type { PluginManifest } from '../../schemas/plugin-manifest.js'

const MANIFEST: PluginManifest = {
  name: 'downstream',
  version: '1.0.0',
  description: 'Declares one dependency',
  inputs: {},
  outputs: {},
  capabilities: [],
  schedule: 'on_run',
  autonomy_level: 'autonomous',
  side_effects: [],
  ttl_hours: 24,
  dependencies: ['dep-a', 'dep-b'],
  timeout_ms: 5000,
  max_parallelism: 1,
  min_tier: 'normal',
  max_retries: 0,
  retry_delay_ms: 1,
}

const stateWith = (runs: Record<string, unknown>) =>
  EngineStateSchema.parse({ schema_version: 1, plugin_runs: runs })

describe('readDependencyOutput', () => {
  test('returns the declared dependency Output the engine recorded', () => {
    const state = stateWith({
      'dep-a': {
        last_run_at: '2026-09-05T10:00:00.000Z',
        status: 'success',
        last_output: {
          type: 'brief',
          format: 'markdown',
          body: 'three things happened',
          run_id: 'run-1',
          produced_at: '2026-09-05T10:00:00.000Z',
        },
      },
    })

    expect(readDependencyOutput(state, MANIFEST, 'dep-a')).toEqual({
      type: 'brief',
      format: 'markdown',
      body: 'three things happened',
      run_id: 'run-1',
      produced_at: '2026-09-05T10:00:00.000Z',
    })
  })

  test('a declared dependency that has run but produced nothing reads null', () => {
    const state = stateWith({
      'dep-a': { last_run_at: '2026-09-05T10:00:00.000Z', status: 'success' },
    })

    expect(readDependencyOutput(state, MANIFEST, 'dep-a')).toBeNull()
  })

  test('a declared dependency that has never run reads null too', () => {
    // Same answer as above on purpose. "Produced no Output" is one state from
    // a reader's side, and splitting it would make the caller branch on a
    // difference it cannot act on.
    expect(readDependencyOutput(stateWith({}), MANIFEST, 'dep-b')).toBeNull()
  })

  test('an undeclared dependency is refused BY NAME, not answered with null', () => {
    // The case the null return would swallow. A typo in `dependencies` and a
    // dependency that has not run are different problems with different fixes,
    // and a reader returning null for both makes the first one invisible.
    const state = stateWith({
      'dep-typo': { last_run_at: '2026-09-05T10:00:00.000Z', status: 'success' },
    })

    expect(() => readDependencyOutput(state, MANIFEST, 'dep-typo')).toThrow(/dep-typo/)
    expect(() => readDependencyOutput(state, MANIFEST, 'dep-typo')).toThrow(/dependencies/)
  })

  test('an undeclared dependency is refused even when the state HAS its Output', () => {
    // The refusal is about the declaration, not about availability. A plugin
    // must not read an Output its manifest does not declare a dependency on,
    // and "it happened to be there" is exactly the argument that would erode
    // that into nothing.
    const state = stateWith({
      other: {
        last_run_at: '2026-09-05T10:00:00.000Z',
        status: 'success',
        last_output: { type: 'brief', format: 'markdown', body: 'not yours' },
      },
    })

    expect(() => readDependencyOutput(state, MANIFEST, 'other')).toThrow(/other/)
  })

  test('a manifest declaring no dependencies can read nothing', () => {
    const solo: PluginManifest = { ...MANIFEST, dependencies: [] }
    const state = stateWith({
      'dep-a': { last_run_at: '2026-09-05T10:00:00.000Z', status: 'success' },
    })

    expect(() => readDependencyOutput(state, solo, 'dep-a')).toThrow(/dep-a/)
  })

  test('the module gives no second answer about upstream change, and touches no disk', async () => {
    // Asserted on the source rather than on behaviour, because both failures
    // are additions nothing here would call — they would be green under every
    // case above. `src/runtime/staleness.ts` already answers "has anything
    // changed upstream" from `plugin_runs[dep].last_run_at`, and a second
    // answer that could disagree with it is the whole thing being refused.
    const source = await readFile(fileURLToPath(new URL('../outputs.ts', import.meta.url)), 'utf8')

    expect(source).not.toMatch(/from 'node:(fs|path)/)
    expect(source).not.toContain('staleness')
  })
})
