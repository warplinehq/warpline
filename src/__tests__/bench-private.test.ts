/**
 * The private-scale harness, exercised on synthetic data only.
 *
 * No fleet name, path or variable appears here, and every fixture is invented.
 * A private run grades its homes by opaque check ids whose mapping to plugins
 * lives outside this repository, so what is pinned here is the machinery: the
 * one record schema both runs share, and the data-driven grader a private
 * configuration drives without ever naming what it is grading.
 */
import { describe, expect, test } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  GradeCheckSchema,
  GradePredicateSchema,
  gradeWithChecks,
  resolvePointer,
  type GradeCheck,
} from '../../bench/grade.js'
import { ARM_ORDER, assertControlHome, CanaryError, runWarplineArm, type Provenance } from '../../bench/arms.js'
import {
  assertEngineUnchanged,
  assertFleetInstall,
  assertPackageVersion,
  assertPluginsPresent,
  assertPrivatePreconditions,
  assertPrivateSeam,
  assertSnapshotDigest,
  commitment,
  COMMITMENTS_FILE,
  ENGINE_BASE_SHA,
  flipAutonomy,
  loadPrivateConfig,
  materializeCopyMap,
  parseCommitments,
  PrivateConfigSchema,
  privatePluginsDir,
  privateWarplineHome,
  readPreregCommitment,
  scrubEnv,
  seedPrivateControl,
  seedPrivateHome,
  takeSnapshot,
  treeDigest,
  type PrivateConfig,
} from '../../bench/private.js'
import { BenchRunRecordSchema, GRADED_KEYS, parseRecord } from '../../bench/record.js'
import {
  makePrivateRunner,
  runIteration,
  runPrivateSet,
  runPrivateShakedown,
  runPrivateWarmup,
  summarisePrivate,
  summariseSet,
  type ArmRunner,
  type ArmRunOutcome,
  type PrivateIterationHooks,
} from '../../bench/run.js'
import { withFakeClaude } from '../../test-utils/fake-claude.js'
import { RunLogSchema } from 'warpline/schemas/run-log'
import { assertHomeSeam, ControlSeedError } from '../../bench/seed.js'

const REPO_ROOT = join(import.meta.dir, '..', '..')

/** A record with every field the schema requires, so a test can vary one thing. */
function sampleRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    arm: 'warpline',
    iteration: 1,
    arm_order_index: 0,
    cold: true,
    disposition: 'passed',
    truncation_subtype: null,
    tokens: { input: 0, output: 0, cache_creation: 0, cache_read: 0 },
    wall_clock_ms: 1.5,
    runtime_ms: 1.5,
    consumer_ms: null,
    parked_handoffs: 2,
    graded: {
      'announce-fanout': false,
      'daily-digest': true,
      'draft-writer': false,
      'metrics-rollup': true,
    },
    git_sha: 'abcdef0',
    package_version: '0.0.0',
    claude_cli_version: 'none',
    model_id: 'none',
    ...overrides,
  }
}

/** Run `fn` against a fresh temp home, removed afterwards whatever happens. */
function withHome<T>(files: Record<string, string>, fn: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), 'bench-private-'))
  try {
    for (const [rel, body] of Object.entries(files)) {
      const path = join(home, rel)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, body)
    }
    return fn(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

describe('graded map', () => {
  test('a synthetic home flows through the check grader into a record the one schema accepts', () => {
    withHome(
      { 'graded/check-1.json': '{"items":[1,2]}', 'graded/check-2.json': '{"n":3}' },
      (home) => {
        const checks: GradeCheck[] = [
          { id: 'check-1', path: 'graded/check-1.json', pointer: '/items', predicate: { kind: 'non_empty_array' } },
          { id: 'check-2', path: 'graded/check-2.json', pointer: '/n', predicate: { kind: 'integer_gte', n: 2 } },
        ]
        const result = gradeWithChecks(home, checks)
        expect(result).toEqual({ paths: { 'check-1': true, 'check-2': true }, passed: true })

        const stamped = {
          snapshot_sha256: 'a'.repeat(64),
          prereg_commitment: 'b'.repeat(64),
          outbound_blocked: 0,
        }
        const record = parseRecord(sampleRecord({ graded: result.paths, ...stamped }), home)
        expect(record.graded).toEqual({ 'check-1': true, 'check-2': true })
        expect(record.snapshot_sha256).toBe(stamped.snapshot_sha256)
        expect(record.prereg_commitment).toBe(stamped.prereg_commitment)
        expect(record.outbound_blocked).toBe(0)
      },
    )
  })

  test('every tracked public record still parses, with exactly the four public keys and no new field', () => {
    const listed = execFileSync('git', ['ls-files', '--', 'bench/results/'], { cwd: REPO_ROOT, encoding: 'utf8' })
      .split('\n')
      .filter((line) => line.trim() !== '')
    // A roster sentinel: an empty listing would make every assertion below vacuous.
    expect(listed.length).toBeGreaterThan(0)
    for (const file of listed) {
      const record = BenchRunRecordSchema.parse(JSON.parse(readFileSync(join(REPO_ROOT, file), 'utf8')))
      expect(Object.keys(record.graded).sort()).toEqual([...GRADED_KEYS].sort())
      expect(record.snapshot_sha256).toBeUndefined()
      expect(record.prereg_commitment).toBeUndefined()
      expect(record.outbound_blocked).toBeUndefined()
    }
  })

  test('a public-shaped record parses without any of the three optional fields', () => {
    expect(BenchRunRecordSchema.safeParse(sampleRecord()).success).toBe(true)
  })

  const PUBLIC_GRADED = {
    'announce-fanout': true,
    'daily-digest': true,
    'draft-writer': true,
    'metrics-rollup': true,
  }
  const withoutPackageVersion = (): Record<string, unknown> => {
    const record = sampleRecord()
    delete record.package_version
    return record
  }
  const REFUSED: [string, () => Record<string, unknown>][] = [
    ['an empty graded map, which graded nothing', () => sampleRecord({ graded: {} })],
    ['a map mixing the public keys with a check id', () => sampleRecord({ graded: { ...PUBLIC_GRADED, 'check-1': true } })],
    ['a check id that is not check-<digits>', () => sampleRecord({ graded: { 'check-x': true } })],
    ['the public keys plus a fifth', () => sampleRecord({ graded: { ...PUBLIC_GRADED, extra: true } })],
    ['a snapshot digest that is not 64 hex', () => sampleRecord({ snapshot_sha256: 'xyz' })],
    ['an uppercase commitment', () => sampleRecord({ prereg_commitment: 'A'.repeat(64) })],
    ['a negative blocked count', () => sampleRecord({ outbound_blocked: -1 })],
    ['a fractional blocked count', () => sampleRecord({ outbound_blocked: 1.5 })],
    ['a record missing a provenance field', withoutPackageVersion],
  ]
  test.each(REFUSED)('the schema refuses %s', (_name, build) => {
    expect(BenchRunRecordSchema.safeParse(build()).success).toBe(false)
  })
})

/** Grade one invented artifact with one check, in a fresh home. `undefined` leaves the file absent. */
function gradeOne(body: string | undefined, pointer: string, predicate: GradeCheck['predicate']): boolean {
  const files: Record<string, string> = body === undefined ? {} : { 'graded/check-1.json': body }
  return withHome(files, (home) => {
    const result = gradeWithChecks(home, [{ id: 'check-1', path: 'graded/check-1.json', pointer, predicate }])
    expect(result.passed).toBe(result.paths['check-1'] === true)
    return result.paths['check-1'] === true
  })
}

/** Each value as the `/v` member of an invented artifact. */
const at = (value: unknown): string => JSON.stringify({ v: value })

describe('check evaluator', () => {
  // Every predicate's wrong artifacts come BEFORE its right one: a grader that
  // passes everything must go red here before anything else is believed.
  test('exists: an absent file fails, a present one passes', () => {
    expect(gradeOne(undefined, '', { kind: 'exists' })).toBe(false)
    expect(gradeOne('not json at all', '', { kind: 'exists' })).toBe(true)
    expect(gradeOne(at(null), '/missing', { kind: 'exists' })).toBe(false)
    expect(gradeOne(at(null), '/v', { kind: 'exists' })).toBe(true)
  })

  test('integer_gte: a smaller, fractional, quoted or null value fails; an equal or larger integer passes', () => {
    for (const wrong of [1, 1.5, '3', null]) expect(gradeOne(at(wrong), '/v', { kind: 'integer_gte', n: 2 })).toBe(false)
    expect(gradeOne(at(2), '/v', { kind: 'integer_gte', n: 2 })).toBe(true)
    expect(gradeOne(at(3), '/v', { kind: 'integer_gte', n: 2 })).toBe(true)
  })

  test('non_empty_array: an empty array, an object or a string fails; a one-element array passes', () => {
    for (const wrong of [[], {}, 'x']) expect(gradeOne(at(wrong), '/v', { kind: 'non_empty_array' })).toBe(false)
    expect(gradeOne(at([0]), '/v', { kind: 'non_empty_array' })).toBe(true)
  })

  test('non_empty_string: an empty or blank string or a number fails; a word passes', () => {
    for (const wrong of ['', '   ', 3]) expect(gradeOne(at(wrong), '/v', { kind: 'non_empty_string' })).toBe(false)
    expect(gradeOne(at('x'), '/v', { kind: 'non_empty_string' })).toBe(true)
  })

  test('keyset_equals: a missing key, an extra key or an array fails; the same keys in any order pass', () => {
    const predicate: GradeCheck['predicate'] = { kind: 'keyset_equals', keys: ['a', 'b'] }
    for (const wrong of [{ a: 1 }, { a: 1, b: 2, c: 3 }, []]) expect(gradeOne(at(wrong), '/v', predicate)).toBe(false)
    expect(gradeOne(at({ b: 1, a: 2 }), '/v', predicate)).toBe(true)
  })

  test('pointers unescape ~1 before ~0', () => {
    const doc = JSON.stringify({ 'a/b': 'slash', 'm~n': 'tilde', '~1': 'literal' })
    expect(gradeOne(doc, '/a/b', { kind: 'non_empty_string' })).toBe(false)
    expect(gradeOne(doc, '/a~1b', { kind: 'non_empty_string' })).toBe(true)
    expect(gradeOne(doc, '/m~0n', { kind: 'non_empty_string' })).toBe(true)
    expect(resolvePointer(JSON.parse(doc), '/~01')).toEqual({ found: true, value: 'literal' })
  })

  test('an array token must be a canonical index inside the array', () => {
    const doc = JSON.stringify({ items: ['first'] })
    for (const wrong of ['/items/5', '/items/01', '/items/-', '/items/1']) {
      expect(gradeOne(doc, wrong, { kind: 'exists' })).toBe(false)
    }
    expect(resolvePointer(JSON.parse(doc), '/items/0')).toEqual({ found: true, value: 'first' })
    expect(gradeOne(doc, '/items/0', { kind: 'non_empty_string' })).toBe(true)
  })

  test("an object token must be an own key, and '' is the whole document", () => {
    expect(gradeOne(at(1), '/constructor', { kind: 'exists' })).toBe(false)
    expect(gradeOne('[1]', '', { kind: 'non_empty_array' })).toBe(true)
    expect(resolvePointer({ a: 1 }, '')).toEqual({ found: true, value: { a: 1 } })
  })

  test('invalid JSON grades false and does not throw', () => {
    expect(gradeOne('{"v": [1,', '/v', { kind: 'non_empty_array' })).toBe(false)
    expect(gradeOne('{"v": [1,', '', { kind: 'non_empty_array' })).toBe(false)
    expect(gradeOne('{"v": [1,', '/v', { kind: 'exists' })).toBe(false)
  })

  test('a graded file that links outside the home grades false', () => {
    const outside = mkdtempSync(join(tmpdir(), 'bench-private-outside-'))
    try {
      writeFileSync(join(outside, 'real.json'), at([1]))
      withHome({}, (home) => {
        mkdirSync(join(home, 'graded'))
        symlinkSync(join(outside, 'real.json'), join(home, 'graded', 'check-1.json'))
        const check: GradeCheck = { id: 'check-1', path: 'graded/check-1.json', pointer: '/v', predicate: { kind: 'non_empty_array' } }
        expect(gradeWithChecks(home, [check]).paths['check-1']).toBe(false)
      })
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test('passed is false when any single check fails', () => {
    withHome({ 'graded/check-1.json': at([1]), 'graded/check-2.json': at([]) }, (home) => {
      const result = gradeWithChecks(home, [
        { id: 'check-1', path: 'graded/check-1.json', pointer: '/v', predicate: { kind: 'non_empty_array' } },
        { id: 'check-2', path: 'graded/check-2.json', pointer: '/v', predicate: { kind: 'non_empty_array' } },
      ])
      expect(result).toEqual({ paths: { 'check-1': true, 'check-2': false }, passed: false })
    })
  })

  const valid: GradeCheck = { id: 'check-1', path: 'graded/check-1.json', pointer: '', predicate: { kind: 'exists' } }
  const refuse = (checks: unknown[], message?: RegExp): void => {
    withHome({}, (home) => {
      const run = (): unknown => gradeWithChecks(home, checks as GradeCheck[])
      if (message === undefined) expect(run).toThrow()
      else expect(run).toThrow(message)
    })
  }

  test('a check path that climbs out, leaves graded/ or is absolute is refused', () => {
    refuse([{ ...valid, path: 'graded/../../x.json' }])
    refuse([{ ...valid, path: 'state/x.json' }])
    refuse([{ ...valid, path: join(tmpdir(), 'graded', 'x.json') }])
    refuse([{ ...valid, path: '/graded/x.json' }])
    expect(GradeCheckSchema.safeParse({ ...valid, path: 'state/x.json' }).success).toBe(false)
  })

  test('a pointer without a leading slash is refused', () => {
    refuse([{ ...valid, pointer: 'items' }])
  })

  test('an empty check list and a duplicate id each throw', () => {
    refuse([], /no checks/)
    refuse([valid, { ...valid }], /twice/)
  })

  test('the closed predicate set cannot express text equality, and integer_gte needs its bound', () => {
    expect(GradeCheckSchema.safeParse({ ...valid, predicate: { kind: 'text_equals', value: 'x' } }).success).toBe(false)
    expect(GradeCheckSchema.safeParse({ ...valid, predicate: { kind: 'integer_gte' } }).success).toBe(false)
    expect(GradeCheckSchema.safeParse({ ...valid, predicate: { kind: 'non_empty_string', min_length: 3 } }).success).toBe(false)
    expect(GradePredicateSchema.options.map((option) => option.shape.kind.value).sort()).toEqual([
      'exists',
      'integer_gte',
      'keyset_equals',
      'non_empty_array',
      'non_empty_string',
    ])
  })
})

/**
 * Every module specifier `source` imports that is not the standard library, a
 * `./` sibling inside the bench, or zod. Static `from`, bare side-effect
 * `import`, dynamic `import()` and `require()` are all read, because a guard
 * blind to one import form is a guard with a door in it.
 */
function graderImportOffenders(source: string): string[] {
  const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(['"`])([^'"`]+)\1/g
  const allowed = (spec: string): boolean => spec.startsWith('node:') || /^\.\/[\w.-]+\.js$/.test(spec) || spec === 'zod'
  return [...source.matchAll(IMPORT)].map((match) => match[2] ?? '').filter((spec) => !allowed(spec))
}

describe('grader imports', () => {
  test('a planted plugin import is reported, and zod is not', () => {
    const planted = "import { handler } from '../examples/plugins/x/handler.js'\nimport { z } from 'zod'"
    expect(graderImportOffenders(planted)).toEqual(['../examples/plugins/x/handler.js'])
    const otherForms = "import '../a.js'\nawait import('../b.js')\nrequire('c')\nexport { d } from './d.js'"
    expect(graderImportOffenders(otherForms)).toEqual(['../a.js', '../b.js', 'c'])
  })

  test('the grader imports nothing outside the bench and the standard library', () => {
    expect(graderImportOffenders(readFileSync(join(REPO_ROOT, 'bench', 'grade.ts'), 'utf8'))).toEqual([])
  })
})

/** Write each file under `root`, creating parents. */
function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    const path = join(root, rel)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, body)
  }
}

/** A synthetic plugin manifest. The docstring mention of the field is there to be left alone. */
const syntheticManifest = (name: string, autonomy: string, extra = ''): string => `import { PluginManifestSchema } from 'warpline/schemas/plugin-manifest'

/**
 * ${name}, a synthetic fleet plugin.
 * autonomy_level: 'manual' is not this plugin's
 */
export const manifest = PluginManifestSchema.parse({
  name: '${name}',
  version: '1.0.0',
  description: 'A synthetic plugin for the private harness tests',
  autonomy_level: '${autonomy}',
  side_effects: [],${extra}
  ttl_hours: 1,
  schedule: 'on_run',
})
`

/**
 * A fleet-shaped repository the harness knows nothing about by name, plus a
 * config describing it: a plugin root with two plugins and a decoy, shared code
 * the handlers import through relative paths, a paths module with an override
 * variable, live state with a stale output already in it, and staged
 * warpline-home files. Every name is invented. The caller removes `root`.
 */
function buildSyntheticFleet(): { root: string; config: PrivateConfig; liveState: string } {
  const root = mkdtempSync(join(tmpdir(), 'bench-private-fleet-'))
  const repo = join(root, 'repo')
  writeTree(repo, {
    '.fleet/plugins/alpha/manifest.ts': syntheticManifest('alpha', 'supervised'),
    '.fleet/plugins/alpha/handler.ts': `import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { skillOk } from 'warpline/unstable-result'
import { STATE_DIR } from '../../scripts/shared/paths.ts'
import { itemsOf } from '../../shared/util.ts'

export const handler = async () => {
  const items = itemsOf(JSON.parse(readFileSync(join(STATE_DIR, 'input.json'), 'utf8')))
  writeFileSync(join(STATE_DIR, 'alpha.json'), JSON.stringify({ items, run: 'fresh' }))
  return skillOk(\`alpha: copied \${items.length} items\`)
}
`,
    '.fleet/plugins/beta/manifest.ts': syntheticManifest('beta', 'manual', '\n  llm_handoff: true,'),
    '.fleet/plugins/beta/handler.ts': `import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { warplineHome } from 'warpline/lib/paths'
import { skillHandoff } from 'warpline/unstable-result'

export const handler = async () => {
  const context = 'state/beta.handoff.json'
  mkdirSync(join(warplineHome(), 'state'), { recursive: true })
  writeFileSync(join(warplineHome(), context), JSON.stringify({ items: ['one'] }))
  return skillHandoff('Summarise one synthetic item', context)
}
`,
    '.fleet/plugins/_shared/decoy.ts': 'export const decoy = true\n',
    '.fleet/shared/util.ts': 'export const itemsOf = (doc: { items?: unknown }): unknown[] => (Array.isArray(doc.items) ? doc.items : [])\n',
    '.fleet/scripts/shared/paths.ts': `import { homedir } from 'node:os'
import { join } from 'node:path'

export const STATE_DIR = process.env.FLEET_STATE_DIR ?? join(import.meta.dir, '..', '..', '..', '.fleet', 'state')
export const warplineHomeDir = (): string => process.env.WARPLINE_HOME ?? homedir()
export const runsDir = (): string => join(warplineHomeDir(), 'runs')
`,
    '.fleet/state/input.json': '{"items":[1,2]}',
    '.fleet/state/alpha.json': '{"items":[],"run":"stale"}',
    '.fleet/node_modules/warpline/package.json': '{"version":"0.5.0"}',
  })
  symlinkSync(join(REPO_ROOT, 'node_modules', 'zod'), join(repo, '.fleet', 'node_modules', 'zod'), 'dir')
  writeTree(root, {
    'staging/wh/preferences.json': '{"review_gate":false}',
    'staging/wh/config/beta.json': '{}',
    'prompts/agent.md': 'a synthetic agent prompt\n',
    'prompts/consumer.md': 'a synthetic consumer prompt over {{RUN_LOG_PATH}}\n',
    'notes.md': 'synthetic notes\n',
  })
  const fleet = (rel: string): string => join(repo, '.fleet', rel)
  const config: PrivateConfig = {
    plugins: ['alpha', 'beta'],
    fleetDir: '.fleet',
    warplineHomeDir: 'wh',
    snapshot: { dir: join(root, 'snapshot') },
    entries: [
      { from: fleet('plugins/alpha'), to: '.fleet/plugins/alpha', scope: 'warpline' },
      { from: fleet('plugins/beta'), to: '.fleet/plugins/beta', scope: 'warpline' },
      { from: fleet('shared'), to: '.fleet/shared', scope: 'warpline' },
      { from: fleet('scripts/shared'), to: '.fleet/scripts/shared', scope: 'warpline' },
      { from: fleet('state'), to: '.fleet/state', scope: 'every-arm' },
      { from: join(root, 'staging/wh/preferences.json'), to: 'wh/preferences.json', scope: 'warpline' },
      { from: join(root, 'staging/wh/config/beta.json'), to: 'wh/config/beta.json', scope: 'warpline' },
    ],
    links: { from: fleet('node_modules'), packages: ['zod'] },
    pathsSeam: { module: '.fleet/scripts/shared/paths.ts', exports: ['STATE_DIR', 'warplineHomeDir', 'runsDir'] },
    envScrub: ['FLEET_STATE_DIR'],
    fleetInstall: fleet('node_modules/warpline/package.json'),
    prompts: { agent: join(root, 'prompts/agent.md'), consumer: join(root, 'prompts/consumer.md') },
    notes: join(root, 'notes.md'),
    copyMap: [{ plugin: 'alpha', from: '.fleet/state/alpha.json', to: 'graded/check-1.json' }],
    checks: [
      { id: 'check-1', path: 'graded/check-1.json', pointer: '/items', predicate: { kind: 'non_empty_array' } },
      { id: 'check-2', path: 'graded/check-2.json', pointer: '', predicate: { kind: 'exists' } },
    ],
    resultsDir: join(root, 'results'),
  }
  return { root, config, liveState: join(repo, '.fleet', 'state') }
}

/** Put an environment variable back the way it was, absent included. */
function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

/**
 * Run `fn` over a fresh synthetic fleet, with the two variables the private
 * mode touches restored and the whole tree removed afterwards.
 */
async function withFleet(fn: (fleet: ReturnType<typeof buildSyntheticFleet>) => Promise<void>): Promise<void> {
  const fleet = buildSyntheticFleet()
  const prior = { home: process.env.WARPLINE_HOME, state: process.env.FLEET_STATE_DIR }
  try {
    await fn(fleet)
  } finally {
    restoreEnv('WARPLINE_HOME', prior.home)
    restoreEnv('FLEET_STATE_DIR', prior.state)
    rmSync(fleet.root, { recursive: true, force: true })
  }
}

describe('private warpline arm, end to end', () => {
  test('a config-described fleet runs through the real engine in a mirrored home, graded by check id, and live state is untouched', async () => {
    await withFleet(async ({ root, config, liveState }) => {
      const liveBefore = treeDigest(liveState)
      expect(await takeSnapshot(config)).toMatch(/^[0-9a-f]{64}$/)

      process.env.FLEET_STATE_DIR = join(root, 'decoy-state')
      scrubEnv(config.envScrub)
      expect(process.env.FLEET_STATE_DIR).toBeUndefined()

      const home = mkdtempSync(join(root, 'home-'))
      const wh = await seedPrivateHome(home, config)
      expect(wh).toBe(join(home, 'wh'))
      process.env.WARPLINE_HOME = wh
      assertHomeSeam(wh)
      await assertPrivateSeam(home, config)

      const arm = await runWarplineArm(home, privatePluginsDir(home, config), (h, a) => materializeCopyMap(h, a, config.copyMap))

      expect(arm.parked_handoffs).toBe(1)
      expect(existsSync(join(home, 'graded/check-1.json'))).toBe(true)
      const graded = JSON.parse(readFileSync(join(home, 'graded/check-1.json'), 'utf8')) as { items: unknown[]; run: string }
      expect(graded.run).toBe('fresh')
      expect(graded.items.length).toBeGreaterThan(0)
      expect(gradeWithChecks(home, config.checks).paths).toEqual({ 'check-1': true, 'check-2': false })
      expect(treeDigest(liveState)).toBe(liveBefore)
      expect(JSON.parse(readFileSync(join(home, '.fleet/state/alpha.json'), 'utf8')).run).toBe('fresh')
    })
  })

  test('a handler that skips itself is never graded on the stale output the snapshot carries, though the run log says completed', async () => {
    await withFleet(async ({ root, config }) => {
      // The handler returns `skipped` without writing anything, the way a plugin
      // behind its own gate does. The stale output it leaves behind would pass
      // its check, so only the copy decision can fail it.
      writeTree(join(root, 'repo'), {
        '.fleet/plugins/alpha/handler.ts': `import { skillOk } from 'warpline/unstable-result'

export const handler = async () => ({ ...skillOk('alpha: skipped, gated off'), status: 'skipped' as const })
`,
        '.fleet/state/alpha.json': '{"items":[1],"run":"stale"}',
      })
      await takeSnapshot(config)
      scrubEnv(config.envScrub)
      const home = mkdtempSync(join(root, 'home-'))
      process.env.WARPLINE_HOME = await seedPrivateHome(home, config)
      await assertPrivateSeam(home, config)

      const arm = await runWarplineArm(home, privatePluginsDir(home, config), (h, a) => materializeCopyMap(h, a, config.copyMap))

      const log = RunLogSchema.parse(JSON.parse(readFileSync(arm.advance.run_log_path, 'utf8')))
      expect(log.plugin_entries.find((entry) => entry.plugin === 'alpha')?.status).toBe('completed')
      expect(existsSync(join(home, 'graded/check-1.json'))).toBe(false)
      expect(gradeWithChecks(home, config.checks).paths['check-1']).toBe(false)
    })
  })

  test('a success the engine recorded for a different run is not this advance’s, so nothing is graded', async () => {
    await withFleet(async ({ root, config }) => {
      await takeSnapshot(config)
      scrubEnv(config.envScrub)
      const home = mkdtempSync(join(root, 'home-'))
      process.env.WARPLINE_HOME = await seedPrivateHome(home, config)
      await assertPrivateSeam(home, config)

      const arm = await runWarplineArm(home, privatePluginsDir(home, config), () => {})
      expect(existsSync(join(home, '.fleet/state/alpha.json'))).toBe(true)

      materializeCopyMap(home, { ...arm.advance, run_id: 'a-different-run' }, config.copyMap)
      expect(existsSync(join(home, 'graded/check-1.json'))).toBe(false)
      materializeCopyMap(home, arm.advance, config.copyMap)
      expect(existsSync(join(home, 'graded/check-1.json'))).toBe(true)
    })
  })
})

/** Indices of the lines that differ between two texts of the same line count. */
function differingLines(a: string, b: string): number[] {
  const left = a.split('\n')
  const right = b.split('\n')
  expect(right.length).toBe(left.length)
  return left.flatMap((line, i) => (line === right[i] ? [] : [i]))
}

describe('private snapshot', () => {
  const CODE_LINE = "  autonomy_level: 'supervised',"

  test('the flip rewrites the one code line and leaves the docstring mention alone', () => {
    const text = syntheticManifest('alpha', 'supervised')
    const flipped = flipAutonomy(text)
    const [changed, ...rest] = differingLines(text, flipped)
    expect(rest).toEqual([])
    expect(text.split('\n')[changed!]).toBe(CODE_LINE)
    expect(flipped.split('\n')[changed!]).toBe("  autonomy_level: 'autonomous',")
    expect(flipped).toContain(" * autonomy_level: 'manual' is not this plugin's")
  })

  test('a manifest with two autonomy lines is refused', () => {
    const text = syntheticManifest('alpha', 'supervised').replace(CODE_LINE, `${CODE_LINE}\n${CODE_LINE}`)
    expect(() => flipAutonomy(text)).toThrow(/found 2/)
  })

  test('a manifest with no autonomy line is refused', () => {
    const text = syntheticManifest('alpha', 'supervised').replace(`${CODE_LINE}\n`, '')
    expect(() => flipAutonomy(text)).toThrow(/found 0/)
  })

  test('an already-autonomous manifest comes back byte-identical', () => {
    const text = syntheticManifest('alpha', 'autonomous')
    expect(flipAutonomy(text)).toBe(text)
  })

  test('each snapshot manifest differs from its live manifest in the autonomy line only, and the live one is untouched', async () => {
    await withFleet(async ({ root, config }) => {
      const livePath = (name: string): string => join(root, 'repo', '.fleet', 'plugins', name, 'manifest.ts')
      const before = config.plugins.map((name) => readFileSync(livePath(name)))
      await takeSnapshot(config)
      config.plugins.forEach((name, i) => {
        const live = readFileSync(livePath(name), 'utf8')
        const snapshot = readFileSync(join(config.snapshot.dir, '.fleet/plugins', name, 'manifest.ts'), 'utf8')
        expect(snapshot).toContain("  autonomy_level: 'autonomous',")
        expect(differingLines(live, snapshot)).toHaveLength(1)
        expect(Buffer.compare(readFileSync(livePath(name)), before[i]!)).toBe(0)
      })
    })
  })

  test('the digest binds the snapshot tree, and one edited byte changes it', async () => {
    await withFleet(async ({ config }) => {
      const digest = await takeSnapshot(config)
      expect(digest).toBe(treeDigest(config.snapshot.dir))
      const file = join(config.snapshot.dir, '.fleet/state/input.json')
      const bytes = readFileSync(file)
      bytes[0] = bytes[0]! ^ 1
      writeFileSync(file, bytes)
      expect(treeDigest(config.snapshot.dir)).not.toBe(digest)
    })
  })

  test('a second snapshot into the same dir is refused', async () => {
    await withFleet(async ({ config }) => {
      await takeSnapshot(config)
      await expect(takeSnapshot(config)).rejects.toThrow(/taken once/)
    })
  })

  test('a configured plugin no entry copies is refused by name', async () => {
    await withFleet(async ({ config }) => {
      config.entries = config.entries.filter((entry) => entry.to !== '.fleet/plugins/beta')
      await expect(takeSnapshot(config)).rejects.toThrow(/configured plugin 'beta' is absent from the snapshot/)
    })
  })

  test('two homes seeded from one snapshot carry byte-identical entries', async () => {
    await withFleet(async ({ root, config }) => {
      await takeSnapshot(config)
      const homes = [mkdtempSync(join(root, 'home-a-')), mkdtempSync(join(root, 'home-b-'))]
      for (const home of homes) await seedPrivateHome(home, config)
      for (const { to } of config.entries) {
        const [a, b] = homes.map((home) => join(home!, to))
        const source = join(config.snapshot.dir, to)
        if (statSync(source).isDirectory()) {
          expect(treeDigest(a!)).toBe(treeDigest(source))
          expect(treeDigest(b!)).toBe(treeDigest(source))
        } else {
          expect(Buffer.compare(readFileSync(a!), readFileSync(source))).toBe(0)
          expect(Buffer.compare(readFileSync(b!), readFileSync(source))).toBe(0)
        }
      }
    })
  })
})

/** A snapshot taken and one home seeded from it, with the env scrubbed and the warpline home exported. */
async function seededHome(root: string, config: PrivateConfig): Promise<{ home: string; wh: string }> {
  await takeSnapshot(config)
  scrubEnv(config.envScrub)
  const home = mkdtempSync(join(root, 'home-'))
  const wh = await seedPrivateHome(home, config)
  process.env.WARPLINE_HOME = wh
  return { home, wh }
}

describe('private config and seeding refusals', () => {
  // Paths only: the tree behind them is removed at once, so each case clones
  // a config nothing on disk answers to.
  const base = ((): PrivateConfig => {
    const fleet = buildSyntheticFleet()
    rmSync(fleet.root, { recursive: true, force: true })
    return fleet.config
  })()

  test('the synthetic config parses, so each refusal below is refused for its own reason', () => {
    expect(PrivateConfigSchema.safeParse(base).success).toBe(true)
  })

  const refusals: [string, (config: PrivateConfig) => void][] = [
    ['a relative snapshot dir', (c) => (c.snapshot.dir = 'snapshot')],
    ["an entry target holding '..'", (c) => (c.entries[0]!.to = '.fleet/../escape')],
    ['an absolute entry target', (c) => (c.entries[0]!.to = '/abs/target')],
    ['a check path outside graded/', (c) => (c.checks[0]!.path = 'state/x.json')],
    ['a copy map naming an unconfigured plugin', (c) => (c.copyMap[0]!.plugin = 'gamma')],
    ['duplicate check ids', (c) => (c.checks[1]!.id = 'check-1')],
    ["'warpline' among the linked packages", (c) => c.links.packages.push('warpline')],
    ['the fleet dir and the warpline home dir the same', (c) => (c.warplineHomeDir = c.fleetDir)],
    ['an every-arm entry under the plugin root', (c) => c.entries.push({ from: '/x', to: '.fleet/plugins/data', scope: 'every-arm' })],
    ['an every-arm entry above the plugin root', (c) => (c.entries[4]!.to = '.fleet')],
    ['an every-arm entry under the warpline home', (c) => c.entries.push({ from: '/x', to: 'wh/data.json', scope: 'every-arm' })],
    ['an every-arm entry at the notes path', (c) => c.entries.push({ from: '/x', to: 'notes.md', scope: 'every-arm' })],
    ['an entry under graded/', (c) => c.entries.push({ from: '/x', to: 'graded/check-1.json', scope: 'warpline' })],
    ['two overlapping entries', (c) => c.entries.push({ from: '/x', to: '.fleet/plugins/alpha/extra.ts', scope: 'warpline' })],
    ['an unknown top-level key', (c) => Object.assign(c, { extra: true })],
  ]
  for (const [name, mutate] of refusals) {
    test(`the config refuses ${name}`, () => {
      const config = structuredClone(base)
      mutate(config)
      expect(PrivateConfigSchema.safeParse(config).success).toBe(false)
    })
  }

  test('the config loader refuses a relative path and round-trips an absolute one', () => {
    expect(() => loadPrivateConfig('relative.json')).toThrow(/absolute/)
    const dir = mkdtempSync(join(tmpdir(), 'bench-private-config-'))
    try {
      writeFileSync(join(dir, 'private.json'), JSON.stringify(base))
      expect(loadPrivateConfig(join(dir, 'private.json'))).toEqual(base)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('an extra directory in the plugin root refuses the seed, naming the loaded and configured sets', async () => {
    await withFleet(async ({ root, config }) => {
      config.entries.push({ from: join(root, 'repo/.fleet/plugins/_shared'), to: '.fleet/plugins/_shared', scope: 'warpline' })
      await expect(seededHome(root, config)).rejects.toThrow(/loaded \[alpha, beta\] and failed \[_shared\] where \[alpha, beta\] are configured/)
    })
  })

  test('a configured plugin missing from a seeded home is refused by name', async () => {
    await withFleet(async ({ root, config }) => {
      const { home } = await seededHome(root, config)
      rmSync(join(home, '.fleet/plugins/beta'), { recursive: true })
      expect(() => assertPluginsPresent(home, config)).toThrow(/'beta' is absent from the plugin root/)
    })
  })

  test('an unscrubbed state override outside the home fails the seam', async () => {
    await withFleet(async ({ root, config }) => {
      const { home } = await seededHome(root, config)
      process.env.FLEET_STATE_DIR = mkdtempSync(join(root, 'outside-'))
      await expect(assertPrivateSeam(home, config)).rejects.toThrow(/export 'STATE_DIR'/)
    })
  })

  test('an unset warpline home fails the seam, because the fleet falls back to the user home', async () => {
    await withFleet(async ({ root, config }) => {
      const { home } = await seededHome(root, config)
      delete process.env.WARPLINE_HOME
      await expect(assertPrivateSeam(home, config)).rejects.toThrow(/export 'warplineHomeDir'/)
    })
  })

  test('a configured export the paths module lacks fails the seam', async () => {
    await withFleet(async ({ root, config }) => {
      const { home } = await seededHome(root, config)
      config.pathsSeam.exports.push('cacheDir')
      await expect(assertPrivateSeam(home, config)).rejects.toThrow(/no export 'cacheDir'/)
    })
  })

  test('engine state seeded into the warpline home is refused by name', async () => {
    await withFleet(async ({ root, config }) => {
      writeFileSync(join(root, 'engine-state.json'), '{}')
      config.entries.push({ from: join(root, 'engine-state.json'), to: 'wh/state/engine-state.json', scope: 'warpline' })
      await expect(seededHome(root, config)).rejects.toThrow(/holds \[state\]/)
    })
  })

  test('a plugin that failed this run is not graded on the stale output the snapshot carried', async () => {
    await withFleet(async ({ root, config }) => {
      const { home } = await seededHome(root, config)
      rmSync(join(home, '.fleet/state/input.json'))
      const arm = await runWarplineArm(home, privatePluginsDir(home, config), (h, a) => materializeCopyMap(h, a, config.copyMap))
      const log = RunLogSchema.parse(JSON.parse(readFileSync(arm.advance.run_log_path, 'utf8')))
      expect(log.plugin_entries.find((entry) => entry.plugin === 'alpha')?.status).toBe('failed')
      expect(existsSync(join(home, 'graded/check-1.json'))).toBe(false)
      expect(JSON.parse(readFileSync(join(home, '.fleet/state/alpha.json'), 'utf8')).run).toBe('stale')
    })
  })

  test('a from-scratch control home holds the data and an empty graded dir, and nothing that reveals the implementation', async () => {
    await withFleet(async ({ root, config }) => {
      await takeSnapshot(config)
      const home = mkdtempSync(join(root, 'control-'))
      await seedPrivateControl(home, 'agent-from-scratch', config)
      expect(existsSync(join(home, '.fleet/state/input.json'))).toBe(true)
      expect(readdirSync(join(home, 'graded'))).toEqual([])
      for (const absent of ['.fleet/plugins', '.fleet/shared', '.fleet/scripts', '.fleet/node_modules', 'node_modules', 'wh', 'notes.md']) {
        expect(existsSync(join(home, absent))).toBe(false)
      }
      expect(() => assertControlHome('agent-from-scratch', home)).not.toThrow()
    })
  })

  test('a with-state control home also holds a byte copy of the notes, not a link', async () => {
    await withFleet(async ({ root, config }) => {
      await takeSnapshot(config)
      const home = mkdtempSync(join(root, 'control-'))
      await seedPrivateControl(home, 'agent-with-state', config)
      const notes = join(home, 'notes.md')
      expect(existsSync(notes)).toBe(true)
      expect(lstatSync(notes).isFile()).toBe(true)
      expect(Buffer.compare(readFileSync(notes), readFileSync(config.notes))).toBe(0)
      expect(existsSync(join(home, '.fleet/plugins'))).toBe(false)
      expect(existsSync(join(home, 'wh'))).toBe(false)
      expect(() => assertControlHome('agent-with-state', home)).not.toThrow()
    })
  })

  test('a with-state control home with no notes is refused before anything is written', async () => {
    await withFleet(async ({ root, config }) => {
      await takeSnapshot(config)
      rmSync(config.notes)
      const home = mkdtempSync(join(root, 'control-'))
      await expect(seedPrivateControl(home, 'agent-with-state', config)).rejects.toBeInstanceOf(ControlSeedError)
      expect(readdirSync(home)).toEqual([])
    })
  })

  test('the warpline arm is refused the control recipe', async () => {
    await withFleet(async ({ root, config }) => {
      await takeSnapshot(config)
      const home = mkdtempSync(join(root, 'control-'))
      await expect(seedPrivateControl(home, 'warpline' as never, config)).rejects.toBeInstanceOf(ControlSeedError)
    })
  })
})

/** Provenance without a spawn: the real reader runs git and the tool itself. */
const testProvenance = (modelId: string): Provenance => ({
  git_sha: 'abcdef0',
  package_version: '0.5.0',
  claude_cli_version: '0.0.0 (test)',
  model_id: modelId,
})

/** What an injected runner reports, whatever the arm: fixed tokens, the pinned model, two blocked attempts. */
const privateOutcome = (grade: ArmRunOutcome['grade']): ArmRunOutcome => ({
  tokens: { input: 1, output: 2, cache_creation: 3, cache_read: 4 },
  wall_clock_ms: 1,
  runtime_ms: null,
  consumer_ms: null,
  parked_handoffs: 0,
  subtype: 'success',
  model_id: 'claude-opus-5',
  grade,
  outbound_blocked: 2,
})

/** The sixteen keys a public record has always carried, arm through model_id. */
const PUBLIC_RECORD_KEYS = [
  'arm',
  'iteration',
  'arm_order_index',
  'cold',
  'disposition',
  'truncation_subtype',
  'tokens',
  'wall_clock_ms',
  'runtime_ms',
  'consumer_ms',
  'parked_handoffs',
  'graded',
  'git_sha',
  'package_version',
  'claude_cli_version',
  'model_id',
]

describe('private iteration', () => {
  test('two private iterations over the synthetic fleet write stamped, check-keyed records through the real driver', async () => {
    await withFleet(async ({ root, config }) => {
      const digest = await takeSnapshot(config)
      scrubEnv(config.envScrub)
      const prereg = 'c'.repeat(64)
      const hooks: PrivateIterationHooks = {
        seed: (arm, home) => (arm === 'warpline' ? seedPrivateHome(home, config) : seedPrivateControl(home, arm, config)),
        warplineHomeOf: (home) => privateWarplineHome(home, config),
        stamp: { snapshot_sha256: digest, prereg_commitment: prereg },
      }
      const seams: { expected: string; actual: string | undefined }[] = []
      const runner: ArmRunner = async (arm, home) => {
        if (arm === 'warpline') {
          seams.push({ expected: privateWarplineHome(home, config), actual: process.env.WARPLINE_HOME })
          await assertPrivateSeam(home, config)
          await runWarplineArm(home, privatePluginsDir(home, config), (h, a) => materializeCopyMap(h, a, config.copyMap))
        } else {
          writeFileSync(join(home, 'graded/check-1.json'), '{"items":[1]}')
        }
        // Standing in for the consumer session, which writes the judgment output.
        writeFileSync(join(home, 'graded/check-2.json'), '{}')
        return privateOutcome(gradeWithChecks(home, config.checks))
      }
      const resultsDir = join(root, 'results')
      for (const iteration of [1, 2]) {
        await runIteration({ iteration, runner, resultsDir, notesSource: config.notes, provenance: testProvenance, privateHooks: hooks })
      }

      const files = readdirSync(resultsDir).sort()
      expect(files).toHaveLength(6)
      for (const file of files) {
        const record = BenchRunRecordSchema.parse(JSON.parse(readFileSync(join(resultsDir, file), 'utf8')))
        expect(record.snapshot_sha256).toBe(digest)
        expect(record.prereg_commitment).toBe(prereg)
        expect(record.outbound_blocked).toBe(2)
        expect(Object.keys(record.graded).sort()).toEqual(['check-1', 'check-2'])
      }
      expect(seams).toHaveLength(2)
      for (const { expected, actual } of seams) expect(actual).toBe(expected)

      const summary = await summarisePrivate(resultsDir, prereg)
      for (const arm of ARM_ORDER) {
        const row = summary[arm]
        expect('shortfall' in row ? row.shortfall : null).toEqual({ count: 1, threshold: 10 })
        expect('median' in row).toBe(false)
      }
    })
  })

  test('a public iteration writes exactly the pre-existing keys and none of the three private fields', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'bench-private-public-'))
    try {
      const notesSource = join(scratch, 'notes.md')
      writeFileSync(notesSource, 'public notes\n')
      const grade = { paths: Object.fromEntries(GRADED_KEYS.map((key) => [key, true])), passed: true }
      const runner: ArmRunner = async () => {
        const { outbound_blocked: _dropped, ...outcome } = privateOutcome(grade)
        return outcome
      }
      const resultsDir = join(scratch, 'results')
      await runIteration({ iteration: 1, runner, resultsDir, notesSource, provenance: testProvenance })
      const files = readdirSync(resultsDir)
      expect(files).toHaveLength(3)
      for (const file of files) {
        const raw = JSON.parse(readFileSync(join(resultsDir, file), 'utf8')) as Record<string, unknown>
        expect(Object.keys(raw).sort()).toEqual([...PUBLIC_RECORD_KEYS].sort())
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })
})

/** The published 0.5.0 release commit, tagged v0.5.0: one runtime JSDoc comment behind the pinned base. */
const RELEASE_SHA = '5751a53c45be402535f396e3b8b8a8b0d1f69a42'

/** git in a fixture repository, never reading the operator's own configuration. */
function fixtureGit(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  }).trim()
}

/** Write `files` under `root` and commit them, returning the new HEAD. */
function commitFixture(root: string, files: Record<string, string>, message: string): string {
  writeTree(root, files)
  fixtureGit(root, ['add', '-A'])
  fixtureGit(root, [
    '-c',
    'user.name=fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '-m',
    message,
  ])
  return fixtureGit(root, ['rev-parse', 'HEAD'])
}

/**
 * A repository shaped like this one where it matters to the engine check: a
 * manifest at 0.5.0, a build config, runtime source, a top-level and a nested
 * test dir, and an empty commitments ledger, all committed as `base`. The
 * caller removes `root`.
 */
function engineFixture(): { root: string; base: string } {
  const root = mkdtempSync(join(tmpdir(), 'bench-private-engine-'))
  fixtureGit(root, ['init', '-q'])
  const base = commitFixture(
    root,
    {
      'package.json': '{ "version": "0.5.0" }\n',
      'tsconfig.build.json': '{ "exclude": ["src/**/__tests__/**"] }\n',
      'src/runtime/x.ts': 'export const x = 1\n',
      'src/__tests__/y.test.ts': "test('y', () => {})\n",
      'src/runtime/__tests__/z.test.ts': "test('z', () => {})\n",
      [COMMITMENTS_FILE]: '',
    },
    'the pinned engine',
  )
  return { root, base }
}

/** Run `fn` over a fresh engine fixture, removed afterwards whatever happens. */
function withEngine(fn: (fixture: { root: string; base: string }) => void): void {
  const fixture = engineFixture()
  try {
    fn(fixture)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
}

const PREREG_HEX = 'a'.repeat(64)
const RESULTS_HEX = 'b'.repeat(64)

describe('private preconditions', () => {
  test('a change under either test dir passes the engine check, and a runtime change refuses naming the base', () => {
    withEngine(({ root, base }) => {
      commitFixture(root, { 'src/__tests__/y.test.ts': "test('y', () => { expect(1).toBe(1) })\n" }, 'a top-level test')
      expect(() => assertEngineUnchanged(root, base)).not.toThrow()
      commitFixture(root, { 'src/runtime/__tests__/z.test.ts': "test('z', () => { expect(2).toBe(2) })\n" }, 'a nested test')
      expect(() => assertEngineUnchanged(root, base)).not.toThrow()
      commitFixture(root, { 'src/runtime/x.ts': 'export const x = 2\n' }, 'the engine moves')
      expect(() => assertEngineUnchanged(root, base)).toThrow(new RegExp(`engine under test changed since ${base.slice(0, 7)}`))
    })
  })

  test('a committed package manifest change refuses the engine check', () => {
    withEngine(({ root, base }) => {
      commitFixture(root, { 'package.json': '{ "version": "0.5.0", "main": "x" }\n' }, 'the manifest moves')
      expect(() => assertEngineUnchanged(root, base)).toThrow(/engine under test changed/)
    })
  })

  test('a committed build config change refuses the engine check', () => {
    withEngine(({ root, base }) => {
      commitFixture(root, { 'tsconfig.build.json': '{ "exclude": [] }\n' }, 'the build config moves')
      expect(() => assertEngineUnchanged(root, base)).toThrow(/engine under test changed/)
    })
  })

  test('an unreachable base is red, never clean', () => {
    withEngine(({ root }) => {
      expect(() => assertEngineUnchanged(root, 'f'.repeat(40))).toThrow(/could not compare/)
    })
  })

  /**
   * The one test in this file that reads this repository's own history.
   *
   * The red control comes first: the published release commit is one runtime
   * JSDoc comment behind the pinned base, so the check must refuse from it. That
   * proves the pathspec reaches the real engine source, and that a wrong or
   * unreachable base cannot pass silently.
   *
   * The HEAD check holds only while the measured set is open. Once a results
   * entry is committed the set is closed and the engine may move again, so the
   * HEAD check is skipped: the file's one deliberate vacuous branch. Unscoped, it
   * would be true today and false for good after the first engine commit that
   * follows the set. If it goes red while the set is open, a commit touched the
   * engine under test: that stops the private set, and it is not a test to fix.
   */
  test('the real repository passes the engine check while the private set is open', () => {
    expect(() => assertEngineUnchanged(REPO_ROOT, RELEASE_SHA)).toThrow(/engine under test changed/)
    const entries = parseCommitments(readFileSync(join(REPO_ROOT, COMMITMENTS_FILE), 'utf8'))
    if (entries.some((entry) => entry.kind === 'results')) {
      expect(entries.filter((entry) => entry.kind === 'results')).toHaveLength(1)
      return
    }
    expect(() => assertEngineUnchanged(REPO_ROOT)).not.toThrow()
    expect(ENGINE_BASE_SHA).toMatch(/^3363c0c/)
  })

  test('the package version passes at 0.5.0 and refuses at 0.4.0', () => {
    withEngine(({ root }) => {
      expect(() => assertPackageVersion(root)).not.toThrow()
      writeFileSync(join(root, 'package.json'), '{ "version": "0.4.0" }\n')
      expect(() => assertPackageVersion(root)).toThrow(/0\.4\.0/)
    })
  })

  test('the fleet install refuses 0.4.0 naming both versions, passes 0.5.0, and refuses a missing file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-private-install-'))
    try {
      const path = join(dir, 'package.json')
      writeFileSync(path, '{ "version": "0.4.0" }')
      let message = ''
      try {
        assertFleetInstall(path)
      } catch (error) {
        message = (error as Error).message
      }
      expect(message).toContain('0.4.0')
      expect(message).toContain('0.5.0')
      writeFileSync(path, '{ "version": "0.5.0" }')
      expect(() => assertFleetInstall(path)).not.toThrow()
      expect(() => assertFleetInstall(join(dir, 'absent.json'))).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the prereg commitment is read only from a ledger holding exactly one prereg and no results', () => {
    withEngine(({ root }) => {
      const ledger = (text: string): void => writeFileSync(join(root, COMMITMENTS_FILE), text)
      expect(() => readPreregCommitment(root)).toThrow(/no prereg commitment/)
      ledger(`prereg ${PREREG_HEX}\n`)
      expect(readPreregCommitment(root)).toBe(PREREG_HEX)
      ledger(`prereg ${PREREG_HEX}\nprereg ${'c'.repeat(64)}\n`)
      expect(() => readPreregCommitment(root)).toThrow(/2 prereg/)
      ledger(`prereg ${PREREG_HEX}\nresults ${RESULTS_HEX}\n`)
      expect(() => readPreregCommitment(root)).toThrow(/results commitment already exists/)
      ledger(`prereg ${PREREG_HEX} \n`)
      expect(() => readPreregCommitment(root)).toThrow(/line 1 is not a prereg or results entry/)
    })
  })

  test('the snapshot digest must be frozen in the config and must match the snapshot', async () => {
    await withFleet(async ({ config }) => {
      const digest = await takeSnapshot(config)
      expect(() => assertSnapshotDigest(config)).toThrow(/no frozen snapshot digest/)
      config.snapshot.sha256 = digest
      expect(assertSnapshotDigest(config)).toBe(digest)
      const file = join(config.snapshot.dir, '.fleet/state/input.json')
      const bytes = readFileSync(file)
      bytes[0] = bytes[0]! ^ 1
      writeFileSync(file, bytes)
      const moved = treeDigest(config.snapshot.dir)
      let message = ''
      try {
        assertSnapshotDigest(config)
      } catch (error) {
        message = (error as Error).message
      }
      expect(message).toContain(digest.slice(0, 7))
      expect(message).toContain(moved.slice(0, 7))
    })
  })

  /** A frozen snapshot, a 0.5.0 fleet install and an engine fixture: every precondition met but the ledger. */
  async function validSetup(
    fn: (setup: { config: PrivateConfig; root: string; base: string; digest: string }) => void,
  ): Promise<void> {
    await withFleet(async ({ config }) => {
      const digest = await takeSnapshot(config)
      config.snapshot.sha256 = digest
      withEngine(({ root, base }) => fn({ config, root, base, digest }))
    })
  }

  test('a missing plugin is named first, even when the digest is wrong too', async () => {
    await validSetup(({ config, root, base }) => {
      rmSync(join(config.snapshot.dir, '.fleet/plugins/beta'), { recursive: true })
      config.snapshot.sha256 = 'f'.repeat(64)
      expect(() => assertPrivatePreconditions(config, root, { requirePrereg: true, engineBase: base })).toThrow(/'beta' is absent/)
    })
  })

  test('with every precondition met it returns the digest and the prereg commitment', async () => {
    await validSetup(({ config, root, base, digest }) => {
      commitFixture(root, { [COMMITMENTS_FILE]: `prereg ${PREREG_HEX}\n` }, 'the method is frozen')
      expect(assertPrivatePreconditions(config, root, { requirePrereg: true, engineBase: base })).toEqual({
        snapshot_sha256: digest,
        prereg_commitment: PREREG_HEX,
      })
    })
  })

  test('without a required prereg it returns the digest alone over an empty ledger', async () => {
    await validSetup(({ config, root, base, digest }) => {
      expect(assertPrivatePreconditions(config, root, { requirePrereg: false, engineBase: base })).toEqual({ snapshot_sha256: digest })
    })
  })
})

const SUMMARY_PREREG = 'c'.repeat(64)

/** A bound private record with every field, so a test can vary one thing. */
function privateSample(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    arm: 'warpline',
    iteration: 1,
    arm_order_index: 0,
    cold: true,
    disposition: 'passed',
    truncation_subtype: null,
    tokens: { input: 1, output: 2, cache_creation: 3, cache_read: 4 },
    wall_clock_ms: 10,
    runtime_ms: null,
    consumer_ms: null,
    parked_handoffs: 0,
    graded: { 'check-1': true, 'check-2': true },
    git_sha: 'abcdef0',
    package_version: '0.5.0',
    claude_cli_version: '0.0.0 (test)',
    model_id: 'claude-opus-5',
    snapshot_sha256: 'd'.repeat(64),
    prereg_commitment: SUMMARY_PREREG,
    ...overrides,
  }
}

/** Write each record through the one parse boundary, named as the driver names them. */
function writeRecords(dir: string, records: Record<string, unknown>[]): void {
  for (const raw of records) {
    const record = parseRecord(raw, dir)
    writeFileSync(join(dir, `${record.arm}-${String(record.iteration).padStart(3, '0')}.json`), `${JSON.stringify(record, null, 2)}\n`)
  }
}

/** One cold run then `warm` warm passing runs, for every arm. */
function fullSet(warm: number, overrides: (arm: string, iteration: number) => Record<string, unknown> = () => ({})): Record<string, unknown>[] {
  return ARM_ORDER.flatMap((arm, index) =>
    Array.from({ length: warm + 1 }, (_, i) =>
      privateSample({ arm, arm_order_index: index, iteration: i + 1, cold: i === 0, wall_clock_ms: 10 + i, ...overrides(arm, i + 1) }),
    ),
  )
}

/** Run `fn` over a fresh results dir, removed afterwards whatever happens. */
async function withResults(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'bench-private-summary-'))
  try {
    await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('private summary', () => {
  const withoutField = (field: string): Record<string, unknown> => {
    const record = privateSample({ arm: 'agent-with-state', iteration: 2, cold: false })
    delete record[field]
    return record
  }

  const REFUSED: [string, Record<string, unknown>[], RegExp][] = [
    ['a record lacking the prereg commitment', [privateSample(), withoutField('prereg_commitment')], /agent-with-state-2 carries no prereg commitment/],
    ['a record under another commitment', [privateSample(), privateSample({ iteration: 2, cold: false, prereg_commitment: 'e'.repeat(64) })], /prereg/],
    ['a record lacking the snapshot digest', [privateSample(), withoutField('snapshot_sha256')], /snapshot/],
    ['two snapshot digests', [privateSample(), privateSample({ iteration: 2, cold: false, snapshot_sha256: 'f'.repeat(64) })], /2 snapshot/],
    ['two package versions', [privateSample(), privateSample({ iteration: 2, cold: false, package_version: '0.5.1' })], /package version/],
    ['every record on another package version', fullSet(1, () => ({ package_version: '0.4.0' })), /0\.5\.0/],
    ['two CLI versions', [privateSample(), privateSample({ iteration: 2, cold: false, claude_cli_version: '9.9.9' })], /claude_cli_version/],
    ['two model ids', [privateSample(), privateSample({ iteration: 2, cold: false, model_id: 'claude-other' })], /model_id/],
    ['two git SHAs', [privateSample(), privateSample({ iteration: 2, cold: false, git_sha: '1234567' })], /git_sha/],
    [
      'a record with the public graded keys',
      [privateSample(), privateSample({ iteration: 2, cold: false, graded: Object.fromEntries(GRADED_KEYS.map((key) => [key, true])) })],
      /public/,
    ],
  ]

  test.each(REFUSED)('refuses %s', async (_name, records, message) => {
    await withResults(async (dir) => {
      writeRecords(dir, records)
      await expect(summarisePrivate(dir, SUMMARY_PREREG)).rejects.toThrow(message)
    })
  })

  test('refuses an empty results dir', async () => {
    await withResults(async (dir) => {
      await expect(summarisePrivate(dir, SUMMARY_PREREG)).rejects.toThrow(/no record/)
    })
  })

  test('a bound set of ten warm passing runs per arm is summarised by the public implementation, medians and all', async () => {
    await withResults(async (dir) => {
      writeRecords(dir, fullSet(10))
      const summary = await summarisePrivate(dir, SUMMARY_PREREG)
      expect(summary).toEqual(await summariseSet(dir))
      for (const arm of ARM_ORDER) expect('median' in summary[arm]).toBe(true)
    })
  })

  test('nine warm passing runs per arm is a shortfall with no median', async () => {
    await withResults(async (dir) => {
      writeRecords(dir, fullSet(9))
      const summary = await summarisePrivate(dir, SUMMARY_PREREG)
      for (const arm of ARM_ORDER) {
        const row = summary[arm]
        expect('shortfall' in row ? row.shortfall : null).toEqual({ count: 9, threshold: 10 })
        expect('median' in row).toBe(false)
      }
    })
  })
})

/** One JSON line per event, the way an isolated session prints them. */
const jsonl = (...events: unknown[]): string => `${events.map((event) => JSON.stringify(event)).join('\n')}\n`

/**
 * What the fake command-line tool prints for every session of a private set,
 * the canary included: no removed tool, one shell call, one sandbox-blocked
 * result, and a result line on the pinned model.
 */
const FAKE_SESSION = jsonl(
  { type: 'system', subtype: 'init', tools: ['Bash', 'Read'], mcp_servers: [] },
  {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'curl -sS https://example.com' } }] },
    parent_tool_use_id: null,
  },
  {
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu1',
          content: 'curl: (56) CONNECT tunnel failed, response 403 <sandbox_violations>deny network-outbound example.com:443</sandbox_violations>',
        },
      ],
    },
  },
  {
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 5,
    num_turns: 2,
    usage: {
      input_tokens: 1,
      output_tokens: 2,
      cache_creation_input_tokens: 3,
      cache_read_input_tokens: 4,
      server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    },
    modelUsage: { 'claude-opus-5': {} },
  },
)

/**
 * What the fake does in the home it runs in, standing in for a session's
 * deliverables: the first check's file only when the advance did not already
 * put it there, and the second check's file always.
 */
const FAKE_DELIVERABLES = [
  'mkdir -p graded',
  `[ -f graded/check-1.json ] || printf '{"items":[1]}' > graded/check-1.json`,
  `printf '{}' > graded/check-2.json`,
].join('\n')

/** Provenance without git or the tool: pinned to the private set's package version. */
const setProvenance = (model: string): Provenance => ({
  git_sha: 'f'.repeat(40),
  package_version: '0.5.0',
  claude_cli_version: '0.0.0 (fake)',
  model_id: model,
})

describe('private set, end to end', () => {
  /**
   * The whole measured-set path over the synthetic fleet. Seeding is real, the
   * engine is real, and every session, the canary included, is a real spawn of
   * the fake tool through the isolated argv and the transcript audit. Only the
   * preconditions, which read this checkout's ledger, and the provenance, which
   * runs git and the tool, are injected.
   */
  test(
    'eleven iterations end in stamped records, a median per arm and a mechanical verdict',
    async () => {
      await withFleet(async ({ config }) => {
        const digest = await takeSnapshot(config)
        config.snapshot.sha256 = digest
        const prereg = 'c'.repeat(64)
        process.env.FLEET_STATE_DIR = '/nowhere/a-decoy-fleet-state'

        const consumerHomes: { expected: string; actual: string; argv: string[] }[] = []
        const real = makePrivateRunner(config)
        const runner: ArmRunner = async (arm, home, iteration) => {
          const outcome = await real(arm, home, iteration)
          if (arm === 'warpline') {
            consumerHomes.push({
              expected: privateWarplineHome(home, config),
              actual: readFileSync(join(home, 'warpline-home.txt'), 'utf8'),
              argv: readFileSync(join(home, 'argv.txt'), 'utf8').split('\n'),
            })
          }
          return outcome
        }

        const { summary, agreement } = await withFakeClaude({ stdout: FAKE_SESSION, before: FAKE_DELIVERABLES }, () =>
          runPrivateSet(config, {
            preconditions: () => ({ snapshot_sha256: digest, prereg_commitment: prereg }),
            provenance: setProvenance,
            runner,
          }),
        )

        expect(process.env.FLEET_STATE_DIR).toBeUndefined()

        const files = readdirSync(config.resultsDir).sort()
        expect(files).toHaveLength(33)
        for (const file of files) {
          const text = readFileSync(join(config.resultsDir, file), 'utf8')
          const record = BenchRunRecordSchema.parse(JSON.parse(text))
          expect(record.snapshot_sha256).toBe(digest)
          expect(record.prereg_commitment).toBe(prereg)
          expect(record.outbound_blocked).toBe(1)
          expect(text).not.toContain('alpha')
          expect(text).not.toContain('beta')
        }

        for (const arm of ARM_ORDER) expect('median' in summary[arm]).toBe(true)

        // Warpline's output is the consumer's 2 plus the advance's 0, over a
        // control's 2: exactly 1, which is on neither side, so disagreement.
        expect(agreement.verdict).toBe('diverge')
        expect(agreement.diverged).toContain('output:agent-with-state')
        expect(agreement.diverged).toContain('output:agent-from-scratch')

        expect(consumerHomes).toHaveLength(11)
        for (const { expected, actual, argv } of consumerHomes) {
          expect(actual).toBe(expected)
          expect(argv).toContain('--disallowedTools')
        }
      })
    },
    60_000,
  )
})

/** Every check passing, keyed as the synthetic config keys them. */
const PASSING_CHECKS = { paths: { 'check-1': true, 'check-2': true }, passed: true }

/**
 * Spies for the three things a private entry point does before and while it
 * spends, recording one shared call order. Either of the first two can be told
 * to throw, and the runner reports a passing, blocked-once outcome.
 */
function orderSpies(digest: string, fail: { preconditions?: Error; canary?: Error } = {}) {
  const calls: string[] = []
  const requirePrereg: boolean[] = []
  return {
    calls,
    requirePrereg,
    deps: {
      preconditions: (options: { requirePrereg: boolean }) => {
        calls.push('preconditions')
        requirePrereg.push(options.requirePrereg)
        if (fail.preconditions) throw fail.preconditions
        return options.requirePrereg ? { snapshot_sha256: digest, prereg_commitment: SUMMARY_PREREG } : { snapshot_sha256: digest }
      },
      canary: async () => {
        calls.push('canary')
        if (fail.canary) throw fail.canary
        return 1
      },
      runner: (async (arm, home) => {
        calls.push(`runner:${arm}`)
        writeFileSync(join(home, 'notes.md'), 'notes a warm-up session wrote\n')
        return privateOutcome(PASSING_CHECKS)
      }) as ArmRunner,
      provenance: testProvenance,
    },
  }
}

/** A synthetic fleet with its snapshot taken and frozen into the config. */
async function withFrozenFleet(fn: (fleet: ReturnType<typeof buildSyntheticFleet> & { digest: string }) => Promise<void>): Promise<void> {
  await withFleet(async (fleet) => {
    const digest = await takeSnapshot(fleet.config)
    fleet.config.snapshot.sha256 = digest
    await fn({ ...fleet, digest })
  })
}

/** The results dir holds no record: absent, or empty. */
const noRecords = (dir: string): boolean => !existsSync(dir) || readdirSync(dir).length === 0

describe('private set ordering', () => {
  const ENTRY_POINTS: [string, (config: PrivateConfig, deps: ReturnType<typeof orderSpies>['deps'], root: string) => Promise<unknown>][] = [
    ['the measured set', (config, deps) => runPrivateSet(config, deps)],
    ['the shakedown', (config, deps, root) => runPrivateShakedown(config, join(root, 'scratch'), deps)],
    ['the warm-up', (config, deps) => runPrivateWarmup(config, deps)],
  ]

  test.each(ENTRY_POINTS)('%s: a failed precondition runs no canary and no arm, and writes nothing', async (_name, run) => {
    await withFrozenFleet(async ({ root, config, digest }) => {
      const refused = new Error('a configured plugin is absent')
      const { calls, deps } = orderSpies(digest, { preconditions: refused })
      await expect(run(config, deps, root)).rejects.toBe(refused)
      expect(calls).toEqual(['preconditions'])
      expect(noRecords(config.resultsDir)).toBe(true)
      expect(noRecords(join(root, 'scratch'))).toBe(true)
    })
  })

  test.each(ENTRY_POINTS)('%s: a failed canary runs no arm and writes nothing', async (_name, run) => {
    await withFrozenFleet(async ({ root, config, digest }) => {
      const { calls, deps } = orderSpies(digest, { canary: new CanaryError(0) })
      await expect(run(config, deps, root)).rejects.toBeInstanceOf(CanaryError)
      expect(calls).toEqual(['preconditions', 'canary'])
      expect(noRecords(config.resultsDir)).toBe(true)
      expect(noRecords(join(root, 'scratch'))).toBe(true)
    })
  })

  test('a measured set checks the preconditions with the prereg required, then the canary, then runs the arms', async () => {
    await withFrozenFleet(async ({ config, digest }) => {
      const { calls, requirePrereg, deps } = orderSpies(digest)
      await runPrivateSet(config, deps)
      expect(calls.slice(0, 3)).toEqual(['preconditions', 'canary', 'runner:warpline'])
      expect(calls.filter((call) => !call.startsWith('runner:'))).toEqual(['preconditions', 'canary'])
      expect(requirePrereg).toEqual([true])
      expect(readdirSync(config.resultsDir)).toHaveLength(33)
    })
  })

  test('a shakedown writes one unbound iteration to its scratch dir, and the private summary refuses it', async () => {
    await withFrozenFleet(async ({ root, config, digest }) => {
      const scratch = join(root, 'scratch')
      const { calls, requirePrereg, deps } = orderSpies(digest)
      const records = await runPrivateShakedown(config, scratch, deps)
      expect(calls).toEqual(['preconditions', 'canary', 'runner:warpline', 'runner:agent-with-state', 'runner:agent-from-scratch'])
      expect(requirePrereg).toEqual([false])
      expect(records).toHaveLength(3)
      expect(readdirSync(scratch)).toHaveLength(3)
      for (const file of readdirSync(scratch)) {
        const record = BenchRunRecordSchema.parse(JSON.parse(readFileSync(join(scratch, file), 'utf8')))
        expect(record.prereg_commitment).toBeUndefined()
        expect(record.snapshot_sha256).toBe(digest)
      }
      expect(noRecords(config.resultsDir)).toBe(true)
      await expect(summarisePrivate(scratch, SUMMARY_PREREG)).rejects.toThrow(/carries no prereg commitment/)
    })
  })

  test('a shakedown pointed at the measured results dir is refused before anything runs', async () => {
    await withFrozenFleet(async ({ config, digest }) => {
      const { calls, deps } = orderSpies(digest)
      await expect(runPrivateShakedown(config, `${config.resultsDir}/`, deps)).rejects.toThrow(/scratch/)
      expect(calls).toEqual([])
      expect(noRecords(config.resultsDir)).toBe(true)
    })
  })

  test('the warm-up runs the from-scratch arm once in a private control home and copies its notes out of it', async () => {
    await withFrozenFleet(async ({ config, digest }) => {
      const { calls, requirePrereg, deps } = orderSpies(digest)
      const homes: { home: string; state: boolean; plugins: boolean }[] = []
      const spied = deps.runner
      deps.runner = async (arm, home, iteration) => {
        homes.push({ home, state: existsSync(join(home, '.fleet/state')), plugins: existsSync(join(home, '.fleet/plugins')) })
        return spied(arm, home, iteration)
      }
      const produced = await runPrivateWarmup(config, deps)
      try {
        expect(calls).toEqual(['preconditions', 'canary', 'runner:agent-from-scratch'])
        expect(requirePrereg).toEqual([false])
        expect(homes).toHaveLength(1)
        expect(homes[0]!.state).toBe(true)
        expect(homes[0]!.plugins).toBe(false)
        expect(produced.startsWith(homes[0]!.home)).toBe(false)
        expect(readFileSync(produced, 'utf8')).toBe('notes a warm-up session wrote\n')
        expect(noRecords(config.resultsDir)).toBe(true)
      } finally {
        rmSync(dirname(produced), { recursive: true, force: true })
      }
    })
  })

  test('the warm-up refuses once a record exists', async () => {
    await withFrozenFleet(async ({ config, digest }) => {
      mkdirSync(config.resultsDir, { recursive: true })
      writeRecords(config.resultsDir, [privateSample()])
      const { deps } = orderSpies(digest)
      await expect(runPrivateWarmup(config, deps)).rejects.toThrow(/belongs BEFORE the measured set/)
    })
  })
})

/**
 * The harness's own entry point, as an operator runs it, in a subprocess from
 * the checkout root. PATH is inherited untouched, so no case below may reach a
 * session: each one must finish or refuse before anything is spent.
 */
function bench(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('bun', ['bench/run.ts', ...args], { cwd: REPO_ROOT, encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/** Write the config where the operator keeps it: a file outside this repository. */
function writeConfig(root: string, config: PrivateConfig): string {
  const path = join(root, 'private.json')
  writeFileSync(path, JSON.stringify(config))
  return path
}

/** Run `fn` over a fresh temp dir outside the checkout, removed afterwards whatever happens. */
async function withScratch(fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'bench-private-cli-'))
  try {
    await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const HEX64 = /[0-9a-f]{64}/g

describe('private command line', () => {
  test('a configured plugin absent from the snapshot is named, and nothing runs or is written', async () => {
    await withFrozenFleet(async ({ root, config }) => {
      config.plugins.push('gamma')
      const run = bench('private', writeConfig(root, config))
      expect(run.status).not.toBe(0)
      expect(run.stderr).toContain('gamma')
      expect(run.stderr).toContain('absent')
      expect(existsSync(config.resultsDir)).toBe(false)
    })
  })

  test('a relative config path is refused', () => {
    const run = bench('private', 'relative.json')
    expect(run.status).not.toBe(0)
    expect(run.stderr).toMatch(/absolute/)
  })

  test('a relative shakedown scratch dir is refused', async () => {
    await withFrozenFleet(async ({ root, config }) => {
      const run = bench('private-shakedown', writeConfig(root, config), 'scratch')
      expect(run.status).not.toBe(0)
      expect(run.stderr).toMatch(/absolute/)
      expect(existsSync(join(REPO_ROOT, 'scratch'))).toBe(false)
    })
  })

  test('an unknown mode is refused rather than falling through to the public set', () => {
    const run = bench('privat', '/nowhere/private.json')
    expect(run.status).not.toBe(0)
    expect(run.stderr).toMatch(/unknown mode 'privat'/)
  })

  test('snapshot prints the digest of the snapshot it took, and no other digest', async () => {
    await withFleet(async ({ root, config }) => {
      const run = bench('snapshot', writeConfig(root, config))
      expect(run.status).toBe(0)
      const digests = run.stdout.match(HEX64) ?? []
      expect(digests).toEqual([treeDigest(config.snapshot.dir)])
    })
  })

  test('salt writes 32 bytes readable by the owner alone, and prints none of them', async () => {
    await withScratch((dir) => {
      const path = join(dir, 's.bin')
      const run = bench('salt', path)
      expect(run.status).toBe(0)
      expect(readFileSync(path)).toHaveLength(32)
      expect(statSync(path).mode & 0o777).toBe(0o600)
      expect(run.stdout.match(HEX64)).toBeNull()
      expect(run.stdout).not.toContain(readFileSync(path).toString('hex').slice(0, 16))
    })
  })

  test('salt never replaces an existing salt', async () => {
    await withScratch((dir) => {
      const path = join(dir, 's.bin')
      expect(bench('salt', path).status).toBe(0)
      const first = readFileSync(path)
      expect(bench('salt', path).status).not.toBe(0)
      expect(Buffer.compare(readFileSync(path), first)).toBe(0)
    })
  })

  test('salt refuses a path inside this repository, directly or through a link to it', async () => {
    // Names no operator file could carry, removed whatever happens, so a
    // regression here cannot leave a salt in the checkout.
    const name = `salt-probe-${process.pid}.bin`
    const inside = join(REPO_ROOT, '.bench-private', name)
    const atRoot = join(REPO_ROOT, name)
    try {
      const run = bench('salt', inside)
      expect(run.status).not.toBe(0)
      expect(run.stderr).toMatch(/inside this repository/)
      expect(existsSync(inside)).toBe(false)

      await withScratch((dir) => {
        symlinkSync(REPO_ROOT, join(dir, 'checkout'), 'dir')
        const linked = bench('salt', join(dir, 'checkout', name))
        expect(linked.status).not.toBe(0)
        expect(linked.stderr).toMatch(/inside this repository/)
        expect(existsSync(atRoot)).toBe(false)
      })
    } finally {
      rmSync(inside, { force: true })
      rmSync(atRoot, { force: true })
    }
  })

  test('commit prints exactly the salted digest of a file, and nothing else', async () => {
    await withScratch((dir) => {
      const salt = join(dir, 's.bin')
      const doc = join(dir, 'prereg.md')
      writeFileSync(doc, 'a synthetic pre-registration\n')
      expect(bench('salt', salt).status).toBe(0)
      const run = bench('commit', salt, doc)
      expect(run.status).toBe(0)
      expect(run.stdout).toBe(`${commitment(readFileSync(salt), readFileSync(doc))}\n`)
    })
  })

  test('commit over a directory salts its tree digest', async () => {
    await withScratch((dir) => {
      const salt = join(dir, 's.bin')
      const doc = join(dir, 'results')
      writeTree(doc, { 'a.json': '{}', 'b/c.json': '[]' })
      expect(bench('salt', salt).status).toBe(0)
      const run = bench('commit', salt, doc)
      expect(run.status).toBe(0)
      expect(run.stdout).toBe(`${commitment(readFileSync(salt), Buffer.from(treeDigest(doc)))}\n`)
    })
  })

  test('commit refuses a salt inside this repository', async () => {
    await withScratch((dir) => {
      const doc = join(dir, 'prereg.md')
      writeFileSync(doc, 'a synthetic pre-registration\n')
      const run = bench('commit', join(REPO_ROOT, '.bench-private', `salt-probe-${process.pid}.bin`), doc)
      expect(run.status).not.toBe(0)
      expect(run.stderr).toMatch(/inside this repository/)
      expect(run.stdout).toBe('')
    })
  })
})
