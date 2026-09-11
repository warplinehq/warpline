/**
 * One arm home, seeded: the plugin root, the fixture bodies, the per-plugin
 * configuration, and the session grant.
 *
 * Everything an arm can see lives under a `mkdtemp` directory that is created
 * for one run and removed after it. The isolation mechanism is COPIED from
 * `src/__tests__/shape-coverage.test.ts` rather than reinvented: the home is
 * swapped through the `WARPLINE_HOME` environment variable, because that is
 * the seam the built copy of the path resolver actually reads. The in-process
 * override seam mutates a different module instance and was measured not to
 * reach a handler.
 *
 * `assertHomeSeam` below is what turns "isolated" from an assumption into a
 * measurement. It is one comparison and it is the only reason this file can
 * claim the run wrote nowhere else.
 */
import { existsSync } from 'node:fs'
import { chmod, cp, copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { warplineHome } from 'warpline/lib/paths'
import { loadPluginManifests } from 'warpline/unstable-runtime'
import { GRADED_KEYS, type GradedKey } from './record.js'

/** The repository root, which is also the package root the arms self-reference. */
const REPO_ROOT = resolve(import.meta.dir, '..')
const EXAMPLE_ROOT = join(REPO_ROOT, 'examples', 'plugins')
const FIXTURE_ROOT = join(REPO_ROOT, 'bench', 'fixtures')

/**
 * The four plugins whose artifacts are graded, in fixed order.
 *
 * The same four names the record schema keys its `graded` map by — imported,
 * not restated, so the pin exists in exactly one place.
 */
export const PINNED_GRADED = GRADED_KEYS

/**
 * The fifth plugin: a producer that runs and is NOT graded.
 *
 * `daily-digest` folds what its declared producers last returned. With no
 * producer present it takes its no-data arm and deliberately withholds its
 * Output, so there is no digest for anyone to grade — the graded artifact
 * would not exist at all. This producer reads a plain JSON file under the
 * home, declares no side effect and makes no network call, so every arm can
 * reach the same source data by its own means.
 *
 * The consequence is stated rather than left for a reader to find: five
 * plugins RUN, four are GRADED, and the warpline arm carries one extra
 * plugin's runtime work that the control arms do not pay.
 */
export const PINNED_PRODUCER = 'anomaly-watch'

/** Every plugin copied into an arm's plugin root: the graded four plus the producer. */
export const PINNED_PLUGINS = [...PINNED_GRADED, PINNED_PRODUCER] as const

/**
 * Where each graded artifact lives, relative to an arm's home. Identical for
 * every arm — the grader cannot know which arm wrote the file it is reading,
 * and that is the point.
 */
export const GRADED_PATHS = {
  'announce-fanout': 'graded/announce-fanout.json',
  'daily-digest': 'graded/daily-digest.json',
  'draft-writer': 'graded/draft-writer.md',
  'metrics-rollup': 'graded/metrics-rollup.json',
} as const satisfies Record<GradedKey, string>

// Pairwise distinct, asserted at module load and before any seeding: two keys
// pointing at one file would make one arm's artifact overwrite another's, and
// the grader would read a pass that nothing produced.
{
  const byPath = new Map<string, string>()
  for (const [key, rel] of Object.entries(GRADED_PATHS)) {
    const prior = byPath.get(rel)
    if (prior !== undefined) {
      throw new Error(`graded path collision: '${prior}' and '${key}' both resolve to '${rel}'`)
    }
    byPath.set(rel, key)
  }
}

/**
 * Refuse unless every arm home is a distinct absolute path.
 *
 * Two arms sharing a home would let one arm read the other's state and grade
 * the other's artifacts, and every number after that is meaningless. A
 * relative path is refused for the neighbouring reason: it resolves against
 * whatever the working directory happens to be at the moment it is used.
 */
export function assertHomesDistinct(homes: readonly string[]): void {
  const seen = new Set<string>()
  for (const home of homes) {
    if (!isAbsolute(home)) throw new Error(`arm home is not an absolute path: '${home}'`)
    if (seen.has(home)) throw new Error(`arm home collision: '${home}' was assigned to more than one arm`)
    seen.add(home)
  }
}

/**
 * The measured seam.
 *
 * Called immediately after the environment variable is assigned and before
 * anything else runs. A mismatch means the run is about to write into the
 * operator's live home, so it throws rather than warns.
 */
export function assertHomeSeam(home: string): void {
  const resolved = warplineHome()
  const expected = resolve(home)
  if (resolved !== expected) {
    throw new Error(`home seam broken: the resolver returned '${resolved}' where the arm home is '${expected}'`)
  }
}

/**
 * A fresh home for one run, exported through the environment for the duration
 * of `fn` and removed afterwards whatever happens.
 *
 * Fresh per run, never warm and accumulating: a second run in a first run's
 * home reads state the first one wrote, and the freshness predicates alone
 * would make the second run a no-op. The thing that is legitimately warm
 * across iterations is the provider's prompt cache, which lives nowhere near
 * this directory.
 *
 * A home that cannot be created throws. There is deliberately no fallback to
 * the ambient home — a fallback here writes the operator's live state.
 */
export async function withArmHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'warpline-bench-'))
  const prior = process.env.WARPLINE_HOME
  process.env.WARPLINE_HOME = home
  try {
    assertHomeSeam(home)
    return await fn(home)
  } finally {
    if (prior === undefined) delete process.env.WARPLINE_HOME
    else process.env.WARPLINE_HOME = prior
    await rm(home, { recursive: true, force: true })
  }
}

/**
 * The plugin root: five real directories plus the one symlink that lets them
 * resolve the package they import.
 *
 * Both halves are load-bearing. A plain copy outside the repository cannot
 * resolve the `warpline/...` specifiers every example manifest and handler
 * imports, so `node_modules/warpline` is pointed back at the package root. A
 * copy rather than a symlink farm because the arm's world should be a real
 * directory tree an agent arm could also have been handed — self-contained,
 * with nothing reaching back into the repository except that one resolution
 * link.
 *
 * A pinned example that is absent refuses the run and the refusal NAMES the
 * missing directory and its full path. A count would tell an operator that
 * something is wrong and nothing about what.
 */
export async function buildPluginRoot(home: string): Promise<void> {
  for (const name of PINNED_PLUGINS) {
    const source = join(EXAMPLE_ROOT, name)
    if (!existsSync(source)) {
      throw new Error(`pinned example '${name}' is absent from the example root — expected a directory at ${source}`)
    }
  }
  const root = join(home, 'plugins')
  await mkdir(root, { recursive: true })
  for (const name of PINNED_PLUGINS) {
    await cp(join(EXAMPLE_ROOT, name), join(root, name), { recursive: true })
  }
  await mkdir(join(home, 'node_modules'), { recursive: true })
  await symlink(REPO_ROOT, join(home, 'node_modules', 'warpline'), 'dir')
}

/** Copy one fixture body to a home-relative destination, creating the parent. */
async function place(home: string, fixture: string, relative: string): Promise<void> {
  const destination = join(home, relative)
  await mkdir(dirname(destination), { recursive: true })
  await copyFile(join(FIXTURE_ROOT, fixture), destination)
}

/** How long a seeded grant lives. The same four hours the runtime's own default uses. */
export const GRANT_TTL_MS = 4 * 60 * 60 * 1000

/** Owner read/write only. A grant is an authority token and is not group-readable. */
export const GRANT_FILE_MODE = 0o600

/**
 * Write the session grant, by hand, at the home-derived path.
 *
 * By hand because no writer for it is reachable through the package's
 * published surface — the accessor for this path is excluded from the public
 * path subpath by name, and the writer appears in neither the root barrel nor
 * the unstable runtime barrel. So the payload is written in the exact
 * four-field shape the real gate reads, which is also the shape specified in
 * the runtime specification document.
 *
 * NOT load-bearing for this scenario, and a reader must not infer otherwise
 * from its presence: all five pinned manifests declare an empty side-effect
 * array, and the gate consults a grant only for a plugin whose side-effect
 * array is non-empty. It is written anyway because it costs four fields and
 * covers the day one of those manifests gains a side effect — and the drift
 * test in the harness suite turns red on exactly that day, so the claim in
 * this docstring cannot go quietly stale.
 *
 * Fresh inside each run's home, never once for a whole session: a grant that
 * outlived its home would be an authority nobody scoped.
 */
export async function writeSessionGrant(home: string): Promise<string> {
  const path = join(home, '.session-approval')
  const now = Date.now()
  const payload = {
    granted_at: new Date(now).toISOString(),
    first_granted_at: new Date(now).toISOString(),
    expires_at: new Date(now + GRANT_TTL_MS).toISOString(),
    scopes: '*',
  }
  await writeFile(path, JSON.stringify(payload, null, 2), { mode: GRANT_FILE_MODE })
  await chmod(path, GRANT_FILE_MODE)
  return path
}

/**
 * Seed one arm home, whole.
 *
 * ORDER MATTERS and nothing will report it if it is wrong. The plugin root is
 * built FIRST, because copying a plugin directory brings that plugin's own
 * shipped placeholder reference files along with it, at exactly the paths the
 * fixtures below target. Seeding first and copying second would leave every
 * arm running against the shipped placeholders, and the run would be green.
 *
 * Fixture destinations are read off each plugin's own manifest default,
 * through the same loader the engine uses, rather than hardcoded. A manifest
 * that retargets one of its inputs moves the fixture with it.
 */
export async function seedArmHome(home: string): Promise<void> {
  await buildPluginRoot(home)

  const { manifests } = await loadPluginManifests(join(home, 'plugins'))
  if (manifests.size !== PINNED_PLUGINS.length) {
    const loaded = [...manifests.keys()].sort().join(', ')
    throw new Error(
      `the seeded plugin root loaded ${manifests.size} manifests where ${PINNED_PLUGINS.length} are pinned — loaded: [${loaded}]`,
    )
  }

  const defaultOf = (plugin: string, key: string): string => {
    const value = manifests.get(plugin)?.inputs?.[key]?.default
    if (typeof value !== 'string') {
      throw new Error(`'${plugin}' declares no string default for input '${key}' — the fixture has no destination`)
    }
    return value
  }

  // The writer's three reference files, at the defaults a scaffolded copy
  // lands them on. Bare, that plugin reports a missing file by input key and
  // hands nothing off.
  await place(home, 'voice-rules.md', defaultOf('draft-writer', 'voice_rules_path'))
  await place(home, 'blocklist.json', defaultOf('draft-writer', 'blocklist_path'))
  await place(home, 'frontmatter-schema.json', defaultOf('draft-writer', 'frontmatter_schema_path'))

  // The draft the fan-out fans out, at that plugin's own default path.
  await place(home, 'announce-draft.json', defaultOf('announce-fanout', 'draft_path'))

  // The shared source data. Both deterministic plugins read this one file, and
  // it is a plain JSON document any arm can read by its own means. The path is
  // a literal because the input that names it is optional and undefaulted —
  // the handlers derive it from the home themselves.
  await place(home, 'metrics.json', 'state/metrics.json')

  // The rollup plugin's RETAINED state, carrying one row dated well outside
  // any retention window. Without it the retention fold has nothing to retire,
  // the rollup count is zero, and the graded artifact records a run in which
  // the interesting deterministic work did not happen. A fixed date in the
  // distant past keeps that true regardless of when the benchmark is run.
  await place(home, 'metrics-rollup.json', 'state/metrics-rollup.json')

  // The operator guardrail preferences, which are load-bearing in a way that
  // is invisible until the run is read: the shipped default holds EVERY
  // autonomous plugin's result for human review, so a bare home parks all five
  // and the aggregate plugin never runs at all — its producer never reaches
  // the completed state it folds from. The benchmark measures an unattended
  // run, so the review hold is off and every arm is handed the same file. The
  // quiet-hours window is pinned to absent for the neighbouring reason: left
  // to a default it would make the scenario depend on the hour it was run.
  await place(home, 'preferences.json', 'preferences.json')

  // The two configuration files, which ARE load-bearing. Both handoff plugins
  // ship empty defaults for the inputs that decide whether they have anything
  // to hand off — no topics, no channels — so bare they take a prefix-less
  // skip and the run parks nothing at all.
  await place(home, join('config', 'draft-writer.json'), 'config/draft-writer.json')
  await place(home, join('config', 'announce-fanout.json'), 'config/announce-fanout.json')

  await writeSessionGrant(home)
}
