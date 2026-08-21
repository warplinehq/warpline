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

/** What ships. Two, and the payload measured 12 KB against a 100 KB ceiling. */
const SHIPPED_SKILLS = ['feed-triage', 'needs-llm']

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

// ── The five assertions ──────────────────────────────────────────────────

/** Assertion 1 — the hand-maintained plugin version must match package.json. */
export function versionOffenders(root: string): string[] {
  void root
  return []
}

/**
 * Assertion 2 — every path a manifest declares must resolve on disk. The
 * validator accepts a `source` that points nowhere, so this is the only check.
 */
export function sourceOffenders(root: string): string[] {
  void root
  return []
}

/**
 * Assertion 3 — the ship list. This directory inventory is the ship/no-ship
 * gate: the marketplace entry's `skills[]` array is inert under a subdirectory
 * source, so what is on disk here is what a stranger's session loads.
 */
export function skillDirOffenders(root: string): string[] {
  void root
  return []
}

/** Assertion 4 — both shipped skills must carry their prohibition section. */
export function prohibitionOffenders(root: string): string[] {
  void root
  return []
}

/** Assertion 5 — a manifest that is absent or unparseable is an offender. */
export function manifestParseOffenders(root: string): string[] {
  void root
  return []
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
