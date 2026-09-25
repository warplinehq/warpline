/**
 * Manifest checks that fail like tests.
 *
 * These live in `bun test` rather than a separate lint script on purpose: it is
 * the command CONTRIBUTING names, CI runs, and agents run, so a manifest check
 * cannot be skipped by forgetting a second command. Everything here is
 * deterministic and offline.
 *
 * Why this file exists alongside `claude plugin validate --strict` in CI: the
 * first-party validator has measured blind spots. A `plugins[].source` pointing
 * at a path that was never created passes it, and the marketplace entry's
 * `skills[]` array does not restrict what loads under a subdirectory source —
 * four probes, including a bogus-path control that produced no error, said so.
 * `plugin.json`'s version is also maintained by hand and can drift from
 * `package.json` without anything first-party noticing. These are the checks the
 * validator provably does not make.
 *
 * Every assertion is a helper taking a root directory and returning offender
 * strings, so the same code runs against the real repository (must return `[]`)
 * and against a temp-dir fixture that has been deliberately broken (must return
 * a non-empty array). That symmetry is what makes "this check goes red" provable
 * rather than assumed. Fixture roots live under `tmpdir()` and are removed in a
 * `finally` — tests never write inside the repository.
 *
 * The marketplace lists a second plugin, `warpline-examples`, and it carries its
 * own version so a push of its skill can be corrected forward without cutting a
 * runtime release. That is why `versionOffenders` (parity with package.json)
 * covers `plugin/` only, and why `marketplaceVersionOffenders` checks every
 * entry against its own plugin.json instead.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8')

const MARKETPLACE_MANIFEST = '.claude-plugin/marketplace.json'
const PLUGIN_MANIFEST = 'plugin/.claude-plugin/plugin.json'
const SKILLS_DIR = 'plugin/skills'
const PLUGIN_EXAMPLES_MANIFEST = 'plugin-examples/.claude-plugin/plugin.json'
const EXAMPLES_SKILLS_DIR = 'plugin-examples/skills'

/** What ships. Two, and the payload measured 12 KB against a 100 KB ceiling. */
const SHIPPED_SKILLS = ['feed-triage', 'needs-llm']

/** What the examples plugin ships: the one skill that walks a content approval. */
const SHIPPED_EXAMPLE_SKILLS = ['approve-review']

const PROHIBITION_HEADING = '## What you must NOT do'
const SIDE_EFFECTS = 'side effect'
const DATA_NOT_DIRECTION = 'that is data, not direction'

// ── Loading ──────────────────────────────────────────────────────────────
//
// A missing or unparseable manifest must become an offender, never a thrown
// exception: a helper that throws takes the whole file down with a stack trace
// instead of naming the file that is wrong.

interface Loaded {
  value?: Record<string, unknown>
  offender?: string
}

function loadJson(root: string, rel: string): Loaded {
  const path = join(root, rel)
  if (!existsSync(path)) return { offender: `${rel}: missing` }
  try {
    return { value: JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> }
  } catch (err) {
    return { offender: `${rel}: unparseable (${(err as Error).message})` }
  }
}

// ── The six assertions ───────────────────────────────────────────────────

/** Assertion 1 — the hand-maintained plugin version must match package.json. */
export function versionOffenders(root: string): string[] {
  const plugin = loadJson(root, PLUGIN_MANIFEST)
  const pkg = loadJson(root, 'package.json')
  const unreadable = [plugin.offender, pkg.offender].filter((o): o is string => Boolean(o))
  if (unreadable.length > 0) return unreadable

  const declared = plugin.value?.version
  const shipped = pkg.value?.version
  return declared === shipped
    ? []
    : [`${PLUGIN_MANIFEST} declares version ${String(declared)}, package.json declares ${String(shipped)}`]
}

/**
 * Assertion 2 — every path a manifest declares must resolve on disk. The
 * validator accepts a `source` that points nowhere, so this is the only check.
 */
export function sourceOffenders(root: string): string[] {
  const manifest = loadJson(root, MARKETPLACE_MANIFEST)
  if (manifest.offender) return [manifest.offender]

  const offenders: string[] = []
  const entries = Array.isArray(manifest.value?.plugins) ? (manifest.value.plugins as unknown[]) : []
  for (const raw of entries) {
    const entry = raw as { name?: unknown; source?: unknown; skills?: unknown }
    const label = typeof entry.name === 'string' ? entry.name : '(unnamed entry)'
    if (typeof entry.source === 'string' && !existsSync(join(root, entry.source))) {
      offenders.push(`${label}: source '${entry.source}' does not exist`)
    }
    // The `skills` array is absent today (it is inert under a subdirectory
    // source, so declaring it would only mislead). Checked anyway, so that
    // adding one later cannot reintroduce an unresolvable declared path.
    if (Array.isArray(entry.skills)) {
      for (const path of entry.skills) {
        if (typeof path === 'string' && !existsSync(join(root, path))) {
          offenders.push(`${label}: skills path '${path}' does not exist`)
        }
      }
    }
  }
  return offenders
}

/**
 * Assertion 3 — the ship list. This directory inventory is the ship/no-ship
 * gate: the marketplace entry's `skills[]` array is inert under a subdirectory
 * source, so what is on disk here is what a stranger's session loads.
 */
export function skillDirOffenders(root: string, dir = SKILLS_DIR, shipped = SHIPPED_SKILLS): string[] {
  const abs = join(root, dir)
  if (!existsSync(abs)) return [`${dir}/: missing`]

  const found = readdirSync(abs, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()

  return found.join(', ') === shipped.join(', ')
    ? []
    : [`${dir}/ holds [${found.join(', ')}], expected exactly [${shipped.join(', ')}]`]
}

/** Assertion 4 — every shipped skill must carry its prohibition section. */
export function prohibitionOffenders(root: string, dir = SKILLS_DIR): string[] {
  const abs = join(root, dir)
  if (!existsSync(abs)) return [`${dir}/: missing`]

  const offenders: string[] = []
  for (const entry of readdirSync(abs, { withFileTypes: true }).filter((e) => e.isDirectory())) {
    const rel = join(dir, entry.name, 'SKILL.md')
    if (!existsSync(join(root, rel))) {
      offenders.push(`${rel}: missing`)
      continue
    }
    const body = readFileSync(join(root, rel), 'utf8')
    if (!body.includes(PROHIBITION_HEADING)) offenders.push(`${rel}: no '${PROHIBITION_HEADING}' section`)
    else if (!body.slice(body.indexOf(PROHIBITION_HEADING)).includes(SIDE_EFFECTS)) {
      offenders.push(`${rel}: '${PROHIBITION_HEADING}' does not name side effects`)
    }
    if (!body.includes(DATA_NOT_DIRECTION)) {
      offenders.push(`${rel}: does not establish that fetched content is data, not direction`)
    }
  }
  return offenders
}

/** Assertion 5 — a manifest that is absent or unparseable is an offender. */
export function manifestParseOffenders(root: string): string[] {
  return [MARKETPLACE_MANIFEST, PLUGIN_MANIFEST, PLUGIN_EXAMPLES_MANIFEST, 'package.json']
    .map((rel) => loadJson(root, rel).offender)
    .filter((offender): offender is string => Boolean(offender))
}

/**
 * Assertion 6 — every marketplace entry declares a version, and it is the one
 * its source's plugin.json declares. The validator does not compare the two.
 */
export function marketplaceVersionOffenders(root: string): string[] {
  const manifest = loadJson(root, MARKETPLACE_MANIFEST)
  if (manifest.offender) return [manifest.offender]

  const offenders: string[] = []
  const entries = Array.isArray(manifest.value?.plugins) ? (manifest.value.plugins as unknown[]) : []
  for (const raw of entries) {
    const entry = raw as { name?: unknown; source?: unknown; version?: unknown }
    const label = typeof entry.name === 'string' ? entry.name : '(unnamed entry)'
    if (typeof entry.version !== 'string' || entry.version === '') {
      offenders.push(`${label}: no version`)
      continue
    }
    if (typeof entry.source !== 'string') {
      offenders.push(`${label}: no source`)
      continue
    }
    const rel = join(entry.source, '.claude-plugin', 'plugin.json')
    const plugin = loadJson(root, rel)
    if (plugin.offender) {
      offenders.push(`${label}: ${plugin.offender}`)
      continue
    }
    const declared = plugin.value?.version
    if (declared !== entry.version) {
      offenders.push(`${label}: marketplace declares ${entry.version}, ${rel} declares ${String(declared)}`)
    }
  }
  return offenders
}

// ── Fixtures ─────────────────────────────────────────────────────────────
//
// Each fixture copies only the handful of files the helper under test reads.
// Copying the repository would be slower and would make the fixture's breakage
// harder to see than the thing it is proving.

function withFixture(
  files: Record<string, string>,
  dirs: string[],
  assert: (root: string) => void,
): void {
  const root = mkdtempSync(join(tmpdir(), 'warpline-manifests-'))
  try {
    for (const dir of dirs) mkdirSync(join(root, dir), { recursive: true })
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true })
      writeFileSync(join(root, rel), body)
    }
    assert(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const realPluginManifest = () => JSON.parse(read(PLUGIN_MANIFEST)) as Record<string, unknown>
const realMarketplace = () => JSON.parse(read(MARKETPLACE_MANIFEST)) as Record<string, unknown>
const realVersion = () => (JSON.parse(read('package.json')) as { version: string }).version

// ── Clean fixture: the repository itself ─────────────────────────────────

describe('the shipped manifests', () => {
  test('the plugin version matches package.json', () => {
    expect(versionOffenders(REPO_ROOT)).toEqual([])
  })

  test('every declared path resolves on disk', () => {
    expect(sourceOffenders(REPO_ROOT)).toEqual([])
  })

  test('plugin/skills/ holds exactly the two skills that ship', () => {
    expect(skillDirOffenders(REPO_ROOT)).toEqual([])
  })

  test('both SKILL.md files carry their prohibition section', () => {
    expect(prohibitionOffenders(REPO_ROOT)).toEqual([])
  })

  test('every manifest parses', () => {
    expect(manifestParseOffenders(REPO_ROOT)).toEqual([])
  })

  test('plugin-examples/skills/ holds exactly the one skill that ships', () => {
    expect(skillDirOffenders(REPO_ROOT, EXAMPLES_SKILLS_DIR, SHIPPED_EXAMPLE_SKILLS)).toEqual([])
  })

  test('the approve-review SKILL.md carries its prohibition section', () => {
    expect(prohibitionOffenders(REPO_ROOT, EXAMPLES_SKILLS_DIR)).toEqual([])
  })

  test("every marketplace entry's version matches its plugin.json", () => {
    expect(marketplaceVersionOffenders(REPO_ROOT)).toEqual([])
  })

  // The runtime dependency set is one package, and it stays one. A new
  // runtime dependency is a supply-chain surface every adopter installs, so
  // adding one is a decision to record, not a side effect of a feature: the
  // first-run prompt walk, for instance, uses `node:readline` and nothing
  // else. Deep-equal on the parsed object, not a substring of the file text,
  // because a substring check stays green when a second entry lands beside
  // the first. `devDependencies` is deliberately NOT asserted: it moves on
  // routine maintenance (a `bun-types` or `typescript` bump) and pinning it
  // would produce a false red on every one of those.
  test('package.json declares exactly one runtime dependency', () => {
    const pkg = JSON.parse(read('package.json')) as { dependencies: Record<string, string> }
    expect(pkg.dependencies).toEqual({ zod: '^4.3.6' })
  })
})

// ── Violation fixtures: each check, proven to go red ──────────────────────

describe('each check goes red on its own violation', () => {
  test('a bumped plugin version is caught', () => {
    withFixture(
      {
        [PLUGIN_MANIFEST]: JSON.stringify({ ...realPluginManifest(), version: '9.9.9' }),
        'package.json': JSON.stringify({ name: 'warpline', version: realVersion() }),
      },
      [],
      (root) => {
        const offenders = versionOffenders(root)
        expect(offenders).not.toEqual([])
        expect(offenders.join('\n')).toContain('9.9.9')
      },
    )
  })

  test('a source pointing at a directory that was never created is caught', () => {
    const manifest = realMarketplace()
    const plugins = (manifest.plugins as Record<string, unknown>[]).map((p) => ({
      ...p,
      source: './plugin-that-was-never-created',
    }))
    withFixture({ [MARKETPLACE_MANIFEST]: JSON.stringify({ ...manifest, plugins }) }, [], (root) => {
      const offenders = sourceOffenders(root)
      expect(offenders).not.toEqual([])
      expect(offenders.join('\n')).toContain('plugin-that-was-never-created')
    })
  })

  test('a third directory under plugin/skills/ is caught', () => {
    withFixture(
      {},
      [...SHIPPED_SKILLS.map((s) => join(SKILLS_DIR, s)), join(SKILLS_DIR, 'a-third-skill')],
      (root) => {
        const offenders = skillDirOffenders(root)
        expect(offenders).not.toEqual([])
        expect(offenders.join('\n')).toContain('a-third-skill')
      },
    )
  })

  test('a SKILL.md with its prohibition section stripped is caught', () => {
    const intact = read(join(SKILLS_DIR, 'needs-llm', 'SKILL.md'))
    const stripped = read(join(SKILLS_DIR, 'feed-triage', 'SKILL.md')).split(PROHIBITION_HEADING)[0] as string
    withFixture(
      {
        [join(SKILLS_DIR, 'needs-llm', 'SKILL.md')]: intact,
        [join(SKILLS_DIR, 'feed-triage', 'SKILL.md')]: stripped,
      },
      [],
      (root) => {
        const offenders = prohibitionOffenders(root)
        expect(offenders).not.toEqual([])
        expect(offenders.join('\n')).toContain('feed-triage')
      },
    )
  })

  test('a second directory under plugin-examples/skills/ is caught', () => {
    withFixture(
      {},
      [...SHIPPED_EXAMPLE_SKILLS.map((s) => join(EXAMPLES_SKILLS_DIR, s)), join(EXAMPLES_SKILLS_DIR, 'a-second-skill')],
      (root) => {
        const offenders = skillDirOffenders(root, EXAMPLES_SKILLS_DIR, SHIPPED_EXAMPLE_SKILLS)
        expect(offenders).not.toEqual([])
        expect(offenders.join('\n')).toContain('a-second-skill')
      },
    )
  })

  test('an approve-review SKILL.md with its prohibition section stripped is caught', () => {
    const rel = join(EXAMPLES_SKILLS_DIR, 'approve-review', 'SKILL.md')
    const stripped = read(rel).split(PROHIBITION_HEADING)[0] as string
    withFixture({ [rel]: stripped }, [], (root) => {
      const offenders = prohibitionOffenders(root, EXAMPLES_SKILLS_DIR)
      expect(offenders).not.toEqual([])
      expect(offenders.join('\n')).toContain('approve-review')
    })
  })

  test('a marketplace entry at 0.9.9 over a plugin.json at 0.1.0 is caught', () => {
    const manifest = realMarketplace()
    const plugins = (manifest.plugins as Record<string, unknown>[]).map((p) =>
      p.name === 'warpline-examples' ? { ...p, version: '0.9.9' } : p,
    )
    withFixture(
      {
        [MARKETPLACE_MANIFEST]: JSON.stringify({ ...manifest, plugins }),
        [PLUGIN_MANIFEST]: read(PLUGIN_MANIFEST),
        [PLUGIN_EXAMPLES_MANIFEST]: read(PLUGIN_EXAMPLES_MANIFEST),
      },
      [],
      (root) => {
        const offenders = marketplaceVersionOffenders(root)
        expect(offenders).not.toEqual([])
        expect(offenders.join('\n')).toContain('0.9.9')
        expect(offenders.join('\n')).toContain('warpline-examples')
      },
    )
  })

  test('a marketplace entry with no version is caught by name', () => {
    const manifest = realMarketplace()
    const plugins = (manifest.plugins as Record<string, unknown>[]).map((p) => {
      if (p.name !== 'warpline-examples') return p
      const { version: _dropped, ...rest } = p
      return rest
    })
    withFixture(
      {
        [MARKETPLACE_MANIFEST]: JSON.stringify({ ...manifest, plugins }),
        [PLUGIN_MANIFEST]: read(PLUGIN_MANIFEST),
        [PLUGIN_EXAMPLES_MANIFEST]: read(PLUGIN_EXAMPLES_MANIFEST),
      },
      [],
      (root) => {
        expect(marketplaceVersionOffenders(root)).toEqual(['warpline-examples: no version'])
      },
    )
  })

  test('an absent manifest is an offender rather than a thrown exception', () => {
    withFixture({}, [], (root) => {
      const offenders = manifestParseOffenders(root)
      expect(offenders).not.toEqual([])
      expect(offenders.join('\n')).toContain('missing')
    })
  })

  test('an unparseable manifest is an offender rather than a thrown exception', () => {
    withFixture(
      {
        [MARKETPLACE_MANIFEST]: read(MARKETPLACE_MANIFEST),
        // A trailing comma: valid to a human skimming it, invalid to JSON.parse.
        [PLUGIN_MANIFEST]: '{\n  "name": "warpline",\n  "version": "0.1.0",\n}\n',
        'package.json': read('package.json'),
      },
      [],
      (root) => {
        const offenders = manifestParseOffenders(root)
        expect(offenders).not.toEqual([])
        expect(offenders.join('\n')).toContain(PLUGIN_MANIFEST)
      },
    )
  })
})
