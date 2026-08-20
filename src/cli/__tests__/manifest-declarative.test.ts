/**
 * Manifest declarative lint — every shipped manifest is imports plus the
 * manifest export, and nothing else.
 *
 * Why this is a test and not a sentence in a doc: the engine reads a manifest
 * by importing it, so a manifest's top level RUNS — during `warpline plan`,
 * before any approval gate is consulted. "Manifests are declarative" is
 * therefore a property of the shipped examples (they are the template users
 * copy) and of the scaffold template, not a style preference.
 * docs/plugin-authoring.md § Runtime constraints §3 states it; this file
 * enforces it.
 *
 * Scope: `examples/plugins/<name>/manifest.ts` and the text `scaffoldPlugin`
 * generates. Plan 02-06's `plan-prohibition.test.ts` keeps a manifest-sentinel
 * fixture that DELIBERATELY violates this rule — it exists to prove `plan`
 * does not invoke handlers, and it lives in its own temp directory, outside
 * this lint's scope. Do not merge the two tests: each would falsify the other.
 *
 * The two violation fixtures below are written to a temp directory, never to
 * `examples/` — `examples/` is inside the `files` whitelist and ships.
 */
import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scaffoldPlugin } from '../scaffold.js'
import { _setHome, pluginsDir } from '../../lib/paths.js'

const EXAMPLES_DIR = join(import.meta.dirname, '..', '..', '..', 'examples', 'plugins')

const temps: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'warpline-manifest-lint-'))
  temps.push(dir)
  return dir
}

afterEach(async () => {
  _setHome(null)
  for (const dir of temps.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

/** Write a fixture manifest to a temp dir and read it back off disk. */
async function fixture(name: string, source: string): Promise<string> {
  const path = join(tempDir(), `${name}.ts`)
  writeFileSync(path, source)
  return readFile(path, 'utf8')
}

// ---------------------------------------------------------------------------
// The lint
// ---------------------------------------------------------------------------

/** Lines that are neither an import nor the manifest export. */
function declarativeViolations(_source: string): string[] {
  throw new Error('declarativeViolations: unimplemented')
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Violation: a top-level statement that mutates process state on import. */
const SIDE_EFFECT_MANIFEST = `import { PluginManifestSchema } from 'warpline/schemas/plugin-manifest'

process.env.WARPLINE_LINT_FIXTURE = 'loaded'

export const manifest = PluginManifestSchema.parse({
  name: 'side-effect',
  version: '1.0.0',
  description: 'Mutates the environment at import time',
  inputs: {},
  outputs: {},
})
`

/** Violation: a bare top-level call whose result goes nowhere. */
const BARE_CALL_MANIFEST = `import { PluginManifestSchema } from 'warpline/schemas/plugin-manifest'
import { register } from './register.ts'

register()

export const manifest = PluginManifestSchema.parse({
  name: 'bare-call',
  version: '1.0.0',
  description: 'Calls into a sibling module at import time',
  inputs: {},
  outputs: {},
})
`

/** Clean: several imports (value and type) plus the export, nothing else. */
const CLEAN_MANIFEST = `import { PluginManifestSchema } from 'warpline/schemas/plugin-manifest'
import type { PluginManifest } from 'warpline/schemas/plugin-manifest'

/**
 * A comment, a blank line and a multi-line export expression are all fine.
 */
export const manifest: PluginManifest = PluginManifestSchema.parse({
  name: 'clean',
  version: '1.0.0',
  description: 'Only imports and the manifest export (see docs/doctrine.md)',
  inputs: {
    path: { type: 'string', required: false, description: 'A path (default: <home>/x.json)' },
  },
  outputs: {},
})
`

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('shipped manifests are declarative', () => {
  test('every examples/plugins manifest carries only imports and the manifest export', async () => {
    const plugins = readdirSync(EXAMPLES_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)

    // Guard the guard: an empty glob would make this test vacuously green.
    expect(plugins.length).toBeGreaterThanOrEqual(3)

    for (const name of plugins) {
      const source = await readFile(join(EXAMPLES_DIR, name, 'manifest.ts'), 'utf8')
      expect(declarativeViolations(source)).toEqual([])
    }
  })

  test('the manifest scaffoldPlugin generates carries only imports and the export', async () => {
    _setHome(tempDir())
    const result = await scaffoldPlugin('lint-subject')
    expect(result.created).toBe(true)

    const source = await readFile(join(pluginsDir(), 'lint-subject', 'manifest.ts'), 'utf8')
    expect(declarativeViolations(source)).toEqual([])
  })
})

describe('the lint has teeth', () => {
  test('a top-level statement with a side effect is reported', async () => {
    const violations = declarativeViolations(await fixture('side-effect', SIDE_EFFECT_MANIFEST))
    expect(violations).toEqual(["process.env.WARPLINE_LINT_FIXTURE = 'loaded'"])
  })

  test('a bare top-level call is reported', async () => {
    const violations = declarativeViolations(await fixture('bare-call', BARE_CALL_MANIFEST))
    expect(violations).toEqual(['register()'])
  })

  test('imports are permitted — imports plus the export alone pass', async () => {
    expect(declarativeViolations(await fixture('clean', CLEAN_MANIFEST))).toEqual([])
  })
})
