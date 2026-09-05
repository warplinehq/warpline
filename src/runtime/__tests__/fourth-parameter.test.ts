/**
 * Both handler arities run through one path.
 *
 * The runtime now calls a handler with four arguments, and the fourth is the
 * capability context minted for that invocation. The property this file exists
 * to pin is that adding it took nothing away: a handler declared with three
 * parameters — which is every handler written before the fourth existed — runs
 * unchanged, through the same `executeHandler`, with no compatibility branch
 * beside it.
 *
 * That is arity WIDENING, not a shim. A three-parameter function type is
 * assignable to a four-parameter one, so the compatibility is structural. The
 * `satisfies` pair at the bottom is what makes that claim checkable: it goes
 * red under `bun run typecheck` rather than under `bun test`, because a
 * type-level regression has no run-time symptom on this side — JavaScript
 * ignores an extra argument either way, which is exactly why the compile-time
 * half needs its own assertion.
 *
 * **What the fourth-argument assertion discriminates.** The comparison below is
 * against `mintContext`'s own output for the same inputs, computed here rather
 * than written as a literal. While the registry carried no members, that pinned
 * the shape and the provenance of the call, but it could not tell "the mint
 * produced this" apart from "an empty object was passed" — both sides were
 * `[]`. The first registered member ended that, and ended it without an edit to
 * this file, because the expectation is derived from the registry rather than
 * restated: the two sides now read `['caller', 'secrets']`, and handing the
 * handler a bare `{}` instead of the minted context reddens this test by name.
 * That red was watched. The other half of the proof is
 * `src/__tests__/mint-call-sites.test.ts`, which asserts that the mint is named
 * by exactly two non-test source files, one of which is the module under test
 * here.
 *
 * The four-parameter fixture reports what it received by encoding it into its
 * own `summary`. Fixture handlers are written into a temp directory and are not
 * part of any TypeScript program, so a shared mutable is not available to them
 * — the result they return is the only channel out.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { invokePlugin } from '../invoke-plugin.js'
import type { CapabilityHandlerFn, HandlerFn } from '../invoke-plugin.js'
import { mintContext } from '../capabilities.js'
import type { PluginManifest } from '../../schemas/plugin-manifest.js'

let tmpDir: string

const MANIFEST: PluginManifest = {
  name: 'arity-fixture',
  version: '1.0.0',
  description: 'Arity fixture',
  inputs: {},
  outputs: {},
  capabilities: [],
  secrets: [],
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
}

async function writePlugin(name: string, handlerCode: string): Promise<void> {
  const pluginDir = join(tmpDir, name)
  await mkdir(pluginDir, { recursive: true })
  await writeFile(
    join(pluginDir, 'manifest.ts'),
    `export const manifest = ${JSON.stringify({ ...MANIFEST, name })}`,
  )
  await writeFile(join(pluginDir, 'handler.ts'), handlerCode)
}

beforeEach(async () => {
  tmpDir = join(tmpdir(), `warpline-arity-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  await mkdir(tmpDir, { recursive: true })

  // Declared with three parameters — the shape every handler written before
  // the fourth argument existed still has.
  await writePlugin('three-param', `
    export async function handler(manifest, args, signal) {
      return {
        status: 'success',
        phases_completed: ['three-param'],
        phases_failed: [],
        errors: [],
        data_freshness: {},
        summary: 'three-param ran with ' + typeof signal,
        artifacts_produced: [],
        schema_version: 1,
      }
    }
  `)

  // Declared with four. It reports what it was handed, because the result is
  // the only channel out of a fixture living in a temp directory.
  await writePlugin('four-param', `
    export async function handler(manifest, args, signal, capabilities) {
      return {
        status: 'success',
        phases_completed: ['four-param'],
        phases_failed: [],
        errors: [],
        data_freshness: {},
        summary: JSON.stringify({
          received: capabilities !== undefined,
          isNull: capabilities === null,
          type: typeof capabilities,
          keys: Object.keys(capabilities === undefined || capabilities === null ? {} : capabilities).sort(),
        }),
        artifacts_produced: [],
        schema_version: 1,
      }
    }
  `)
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('one path carries both handler arities', () => {
  test('a three-parameter handler runs and returns its result unchanged', async () => {
    const invocation = await invokePlugin('three-param', {}, { pluginsDir: tmpDir }, { granted: false, reason: 'manual-run' })

    expect(invocation.result.status).toBe('success')
    expect(invocation.result.summary).toBe('three-param ran with object')
    expect(invocation.result.phases_completed).toEqual(['three-param'])
    expect(invocation.final_error).toBeNull()
  })

  test('a four-parameter handler receives a defined fourth argument', async () => {
    const invocation = await invokePlugin('four-param', {}, { pluginsDir: tmpDir }, { granted: false, reason: 'manual-run' })

    expect(invocation.result.status).toBe('success')
    const seen = JSON.parse(invocation.result.summary) as {
      received: boolean
      isNull: boolean
      type: string
      keys: string[]
    }

    expect(seen.received).toBe(true)
    expect(seen.isNull).toBe(false)
    expect(seen.type).toBe('object')
  })

  test('the fourth argument is what the mint produces for that manifest and witness', async () => {
    const invocation = await invokePlugin('four-param', {}, { pluginsDir: tmpDir }, { granted: false, reason: 'manual-run' })
    const seen = JSON.parse(invocation.result.summary) as { keys: string[] }

    // Derived from the registry rather than written as a literal, so the first
    // production member widens this expectation without an edit here.
    const minted = mintContext(
      { manifest: { ...MANIFEST, name: 'four-param' }, caller: { plugin: 'four-param' } },
      { granted: false, reason: 'manual-run' },
    )

    expect(seen.keys).toEqual(Object.keys(minted.context).sort())
  })
})

// ── The compile-time half ─────────────────────────────────────────────────
//
// These go red under `bun run typecheck`, never under `bun test`. The first is
// the assignability the widening rests on; the second is that the fourth
// parameter is typed rather than implicitly `any`. Removing the widening from
// `executeHandler` reddens the call site there, and the `satisfies` below is
// what says the widening was not achieved by loosening the type to `Function`.

const threeParam: HandlerFn = async (_manifest, _args, _signal) => ({
  status: 'success',
  phases_completed: [],
  phases_failed: [],
  data_freshness: {},
  summary: 'narrower',
  artifacts_produced: [],
})

// A three-parameter handler IS a four-parameter one. This line is the ROADMAP's
// "every existing three-parameter handler keeps working unchanged", stated where
// a compiler can read it.
const widened: CapabilityHandlerFn = threeParam

const fourParam = (async (_manifest, _args, _signal, capabilities) => ({
  status: 'success',
  phases_completed: [],
  phases_failed: [],
  data_freshness: {},
  summary: `saw ${Object.keys(capabilities).length} members`,
  artifacts_produced: [],
})) satisfies CapabilityHandlerFn

describe('the assignability the widening rests on', () => {
  test('both typed forms are callable values', () => {
    expect(typeof widened).toBe('function')
    expect(typeof fourParam).toBe('function')
  })
})
