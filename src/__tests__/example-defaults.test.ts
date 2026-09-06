/**
 * A `default:` in a bundled example manifest ships to every adopter, so it
 * has to be a placeholder — never a value that was once someone's real
 * configuration. This guard checks provenance, which nothing else does: the
 * config-channel tests assert that a resolved config PARSES, and they are
 * green over a leaked default because a leaked default parses fine.
 *
 * Same shape as `manifests.test.ts`: one helper taking a root directory and
 * returning offender strings, run against the real repository (must be empty)
 * and against a temp-dir fixture holding a planted non-placeholder default
 * (must name it). The symmetry is what makes the guard provably non-vacuous.
 *
 * "Placeholder" is a concrete predicate, written out below, not a reviewer's
 * impression. Everything a non-empty string default can be that the predicate
 * does not recognise is an offender, and the only way past it is the
 * allowlist, where every entry carries a written reason.
 *
 * Offender strings name the plugin directory and the input key and NEVER the
 * value. This file's own failure output lands in a public CI log.
 *
 * Manifests are loaded by importing them, the way the runtime does, rather
 * than by parsing the source: a `default:` can be an object or an array, and
 * a regex over the text would have a second parser to keep in step with the
 * first. A fixture root gets a `node_modules/warpline` link to the checkout,
 * the same link `warpline scaffold` creates under a home, because a manifest
 * opens with a `warpline/...` self-reference that cannot resolve from
 * `tmpdir()` on its own.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const EXAMPLES = join('examples', 'plugins')

// ── The allowlist ────────────────────────────────────────────────────────

interface AllowlistEntry {
  readonly plugin: string
  readonly key: string
  /** The exact default admitted; a different value under the same key is not. */
  readonly value: unknown
  /** One line saying why this value is not a leak from anywhere. Required. */
  readonly reason: string
}

const ALLOWLIST: readonly AllowlistEntry[] = [
  {
    plugin: 'github-poll',
    key: 'repo',
    value: 'warplinehq/warpline',
    reason: 'a real repository, and the one this package ships from — the quickstart polls itself, so the value is public by construction',
  },
]

// ── The term lists ───────────────────────────────────────────────────────
//
// Loaded the way `no-private-planning-refs.test.ts` loads them, so the two
// guards cannot disagree about what a private term is. The tracked list is
// regex fragments and an empty list throws; the local list is literals and an
// absent file is an empty list — a real coverage hole on CI, and the same
// deliberate trade that file records: the terms cannot be published to close
// it, so whoever holds the file is the one who runs the check.

const PATTERN_FILE = join('.github', 'private-names.txt')

const PRIVATE_NAME_PATTERNS: string[] = readFileSync(join(REPO_ROOT, PATTERN_FILE), 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l !== '' && !l.startsWith('#'))
if (PRIVATE_NAME_PATTERNS.length === 0) {
  throw new Error(`${PATTERN_FILE} yielded no patterns; an empty list is a guard that cannot fail`)
}
const PRIVATE_NAME = new RegExp(PRIVATE_NAME_PATTERNS.map((p) => `\\b${p}\\b`).join('|'), 'i')

const LOCAL_TERMS: string[] = (() => {
  try {
    return readFileSync(join(REPO_ROOT, '.private-terms'), 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('#'))
  } catch {
    return []
  }
})()

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const bounded = (t: string) => `${/^\w/.test(t) ? '\\b' : ''}${esc(t)}${/\w$/.test(t) ? '\\b' : ''}`
const LOCAL_NAME = LOCAL_TERMS.length ? new RegExp(LOCAL_TERMS.map(bounded).join('|'), 'i') : null

/** True when a default, whatever its type, carries a term from either list. */
function carriesPrivateTerm(value: unknown): boolean {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return PRIVATE_NAME.test(text) || (LOCAL_NAME?.test(text) ?? false)
}

// ── The placeholder predicate ────────────────────────────────────────────

/** Hosts nobody owns: the RFC 2606 reserved names and the `.invalid` TLD. */
const RESERVED_HOST = /(^|\.)(example\.(com|org|net)|invalid)$/i

/** The hostname of a URL, a bare hostname as itself, anything else null. */
function hostOf(value: string): string | null {
  try {
    return new URL(value).hostname
  } catch {
    return /^[a-z0-9.-]+$/i.test(value) ? value : null
  }
}

/**
 * A path under the adopter's own home is a placeholder by construction:
 * no leading separator, no drive letter, no `..` segment. It also has to look
 * like a path — at least one separator and an extension on the last segment
 * — or `owner/repo` and `some-team/some-project` would slip through as paths,
 * which is precisely what the allowlist exists to decide. ponytail: a
 * directory-shaped default (`state/cache`) is refused here and needs an
 * allowlist entry; widen this clause if one ever ships.
 */
function isRelativePath(value: string): boolean {
  if (/^[\\/]/.test(value) || /^[A-Za-z]:/.test(value)) return false
  const segments = value.split(/[\\/]/)
  if (segments.length < 2 || segments.includes('..')) return false
  return /\.[A-Za-z0-9]+$/.test(segments[segments.length - 1] ?? '')
}

/** A default is a placeholder when any clause holds. Everything else is an offender. */
function isPlaceholder(value: unknown): boolean {
  // Numbers and booleans carry no provenance; a value that is empty carries nothing.
  if (typeof value === 'boolean' || typeof value === 'number') return true
  if (value === '' || (Array.isArray(value) && value.length === 0)) return true
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) return true
  if (typeof value !== 'string') return false
  // The conventional spellings of "replace me".
  if (value.includes('example') || value.startsWith('your-') || /^<.*>$/.test(value) || value === 'changeme') return true
  // A hostname or URL nobody can own.
  const host = hostOf(value)
  if (host !== null && RESERVED_HOST.test(host)) return true
  return isRelativePath(value)
}

// ── The helper ───────────────────────────────────────────────────────────

interface DeclaredInput {
  default?: unknown
}

interface Scan {
  offenders: string[]
  /** How many manifests were actually loaded; below three the guard is vacuous. */
  scanned: number
}

/**
 * Every `default:` under `<root>/examples/plugins/<name>/manifest.ts`, checked in
 * this order: a private term is an offender no matter what it looks like;
 * then an allowlisted (plugin, key, value) triple is admitted; then the
 * placeholder predicate decides.
 */
export async function defaultOffenders(root: string, allowlist: readonly AllowlistEntry[] = ALLOWLIST): Promise<Scan> {
  const dir = join(root, EXAMPLES)
  if (!existsSync(dir)) return { offenders: [`${EXAMPLES}/: missing`], scanned: 0 }

  const offenders: string[] = []
  let scanned = 0
  const plugins = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()

  for (const plugin of plugins) {
    const path = join(dir, plugin, 'manifest.ts')
    if (!existsSync(path)) {
      offenders.push(`${plugin}: manifest.ts missing`)
      continue
    }
    let inputs: Record<string, DeclaredInput>
    try {
      const mod = (await import(path)) as { manifest?: { inputs?: Record<string, DeclaredInput> } }
      inputs = mod.manifest?.inputs ?? {}
    } catch {
      offenders.push(`${plugin}: manifest.ts failed to load`)
      continue
    }
    scanned += 1

    for (const [key, input] of Object.entries(inputs)) {
      if (!Object.hasOwn(input, 'default')) continue
      const value = input.default
      if (carriesPrivateTerm(value)) {
        offenders.push(`${plugin}: input '${key}' default carries a private term`)
        continue
      }
      const admitted = allowlist.some((a) => a.plugin === plugin && a.key === key && a.value === value)
      if (admitted) continue
      if (!isPlaceholder(value)) offenders.push(`${plugin}: input '${key}' default is not a recognisable placeholder`)
    }
  }
  return { offenders, scanned }
}

// ── Fixtures ─────────────────────────────────────────────────────────────

/** A minimal manifest source whose inputs are the given literal. */
function manifestSource(name: string, inputs: Record<string, unknown>): string {
  return [
    "import { PluginManifestSchema } from 'warpline/schemas/plugin-manifest'",
    '',
    'export const manifest = PluginManifestSchema.parse({',
    `  name: '${name}',`,
    "  version: '1.0.0',",
    "  description: 'fixture',",
    "  autonomy_level: 'autonomous',",
    '  ttl_hours: 1,',
    `  inputs: ${JSON.stringify(inputs)},`,
    '})',
    '',
  ].join('\n')
}

/**
 * A temp root holding the given plugins, linked to this checkout so their
 * `warpline/...` imports resolve, removed in a `finally`. Tests never write
 * inside the repository.
 */
async function withFixture(
  plugins: Record<string, Record<string, unknown>>,
  assert: (root: string) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'warpline-defaults-'))
  try {
    mkdirSync(join(root, 'node_modules'), { recursive: true })
    symlinkSync(REPO_ROOT, join(root, 'node_modules', 'warpline'), 'dir')
    for (const [name, inputs] of Object.entries(plugins)) {
      const path = join(root, EXAMPLES, name, 'manifest.ts')
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, manifestSource(name, inputs))
    }
    await assert(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** Three plugins whose defaults are all placeholders, so a fixture is never vacuous by itself. */
const CLEAN_TRIO = {
  'fixture-one': { target: { type: 'string', required: true, default: 'example' } },
  'fixture-two': { feed_url: { type: 'string', required: true, default: 'https://feeds.example.test/feed.xml' } },
  'fixture-three': { retention_days: { type: 'number', required: false, default: 90 } },
}

/**
 * Realistic and on no term list: the red it produces has to come from the
 * predicate, not from the name lists, and the test below checks that at run
 * time rather than trusting the author.
 */
const PLANTED = 'https://metrics.acme-internal.net/v1/series'

// ── The repository ───────────────────────────────────────────────────────

describe('example manifest defaults are placeholders', () => {
  test('no shipped example carries a default that is not a recognisable placeholder', async () => {
    expect((await defaultOffenders(REPO_ROOT)).offenders).toEqual([])
  })

  test('at least three example manifests were scanned, so the check above is not vacuous', async () => {
    expect((await defaultOffenders(REPO_ROOT)).scanned).toBeGreaterThanOrEqual(3)
  })

  test('the allowlist is load-bearing: without it the shipped github-poll default is an offender', async () => {
    const { offenders } = await defaultOffenders(REPO_ROOT, [])
    expect(offenders).toEqual(["github-poll: input 'repo' default is not a recognisable placeholder"])
    // Every entry admits exactly one value and says why.
    for (const entry of ALLOWLIST) expect(entry.reason.length).toBeGreaterThan(20)
  })
})

// ── The guard, watched going red ─────────────────────────────────────────

describe('the guard goes red on a planted default', () => {
  test('a realistic non-placeholder default names the plugin and the key, never the value', async () => {
    expect(carriesPrivateTerm(PLANTED)).toBe(false)
    await withFixture(
      { ...CLEAN_TRIO, 'fixture-planted': { metrics_url: { type: 'string', required: true, default: PLANTED } } },
      async (root) => {
        const { offenders, scanned } = await defaultOffenders(root)
        expect(scanned).toBe(4)
        expect(offenders).toEqual(["fixture-planted: input 'metrics_url' default is not a recognisable placeholder"])
        expect(offenders.join('\n')).not.toContain(PLANTED)
      },
    )
  })

  test('a default carrying a private term is an offender even when it looks like a placeholder', async () => {
    // Built at run time from the tracked list, so the term is never written
    // in this file: the first pattern that is a plain literal.
    const tracked = PRIVATE_NAME_PATTERNS.find((p) => !/[()[\]|*+?\\^$]/.test(p))
    expect(tracked).toBeDefined()
    const plugins: Record<string, Record<string, unknown>> = {
      ...CLEAN_TRIO,
      'fixture-tracked': { feed_url: { type: 'string', required: true, default: `https://example.com/${tracked}/feed` } },
    }
    // The local half only when the holder's file is present; absent, this
    // is the coverage hole named at the top and it is not papered over.
    if (LOCAL_TERMS.length > 0) {
      plugins['fixture-local'] = { target: { type: 'string', required: true, default: `your-${LOCAL_TERMS[0]}` } }
    }
    await withFixture(plugins, async (root) => {
      const { offenders } = await defaultOffenders(root)
      const expected = ["fixture-tracked: input 'feed_url' default carries a private term"]
      if (LOCAL_TERMS.length > 0) expected.unshift("fixture-local: input 'target' default carries a private term")
      expect(offenders).toEqual(expected)
      expect(offenders.join('\n')).not.toContain(tracked as string)
    })
  })

  test('each clause of the predicate admits its case, and the two non-cases are offenders', async () => {
    const input = (value: unknown) => ({ type: 'string', required: false, default: value })
    await withFixture(
      {
        ...CLEAN_TRIO,
        'fixture-clauses': {
          flag: input(true),
          empty_string: input(''),
          empty_list: input([]),
          empty_map: input({}),
          your_prefix: input('your-org'),
          angle_wrapped: input('<owner/repo>'),
          change_me: input('changeme'),
          reserved_host: input('metrics.example.org'),
          invalid_tld: input('https://api.acme.invalid/v1'),
          home_relative: input('state/metrics.json'),
          absolute_path: input('/srv/acme/metrics/prod.json'),
          bare_pair: input('acme-corp/widgets'),
        },
      },
      async (root) => {
        expect((await defaultOffenders(root)).offenders).toEqual([
          "fixture-clauses: input 'absolute_path' default is not a recognisable placeholder",
          "fixture-clauses: input 'bare_pair' default is not a recognisable placeholder",
        ])
      },
    )
  })

  test('an absent examples tree is an offender rather than a thrown exception', async () => {
    await withFixture({}, async (root) => {
      const { offenders } = await defaultOffenders(root)
      expect(offenders).toEqual(['examples/plugins/: missing'])
    })
  })
})
