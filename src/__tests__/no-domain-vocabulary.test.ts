/**
 * No published identifier carries the source runtime's domain vocabulary.
 *
 * This is the **retrospective** half of a two-guard pair. It pins the
 * vocabulary already known to have leaked and stops it coming back; it cannot
 * protect against vocabulary nobody has written down yet, and it never will,
 * because closing that gap would mean committing the words. The structural half
 * lives in `no-orphan-schema-fields.test.ts` — every published field must have a
 * writer and a doc — and that is the one that catches the *next* leak.
 *
 * The two are complementary and neither subsumes the other. The structural
 * guard enumerates fields, so a sibling exported schema is invisible to it. A
 * word-boundary match on a field name does not reach a type whose name merely
 * starts with the same letters. That is why the vocabulary list below carries
 * both the field name and the type names beside it: the types were removed by
 * hand, and this list is what prevents their return.
 *
 * **Identifiers only — never prose, never comments.** A text scan for the bare
 * word `mode` returns sixty-five innocent hits across the runtime, the approval
 * gate, the lock module and the doctrine document. A guard that fires
 * sixty-five false reds on its first day gets an ignore comment bolted to it
 * and stops being obeyed, which `docs.test.ts` already names as a failure mode
 * in its own comments. So the surface here is exactly three things, all of them
 * reachable by a consumer through the `exports` map: schema shape keys,
 * manifest field names (a schema shape, so the same enumeration reaches them),
 * and exported symbol names.
 *
 * **The term list is committed here, in this file.** The sibling
 * confidentiality guard reads a gitignored local-only list and degrades to an
 * empty one when it is absent, which is a deliberate trade there and the wrong
 * trade here: a check CI is required to run cannot depend on a file CI does not
 * have, or it is green on the runner that matters. Every term below is already
 * public on the currently published version, so writing them down leaks nothing
 * new, and none of them names the company or the deployment.
 *
 * Every assertion is a helper taking a root directory and returning offender
 * strings, so the identical code runs against the real repository (must return
 * `[]`) and against a temp-dir fixture that has been deliberately broken (must
 * return a non-empty array). That symmetry is what makes "this check goes red"
 * provable rather than assumed. Fixture roots live under `tmpdir()` and are
 * removed in a `finally` — tests never write inside the repository.
 *
 * Why a test rather than a lint script: `bun test` is the command CI runs and
 * the one CONTRIBUTING names, so the check cannot be skipped by forgetting a
 * second command.
 */
import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..')

/**
 * Vocabulary belonging to the runtime this project was extracted from.
 *
 * `mode` and `ModeRun` are here deliberately and are not redundant with
 * `modes_run`: removing the field stranded the schemas and inferred types that
 * existed only to describe it, and no mechanical check could have flagged them.
 * They came out by hand, and these two terms are what stops them coming back.
 */
const TERMS = [
  'modes_run',
  'mode',
  'ModeRun',
  'demo_booked',
  'conversion_rate',
  'response_rates',
  'time_saved',
  'trial',
  'converted',
]

/**
 * A term is a LITERAL, not a pattern. Escaping first stops a stray character
 * from either throwing at construction or binding looser than the boundaries;
 * anchoring is what keeps `mode` out of `model` and `moderate`. Case-insensitive
 * so a renamed casing is not a way through.
 */
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const vocabulary = (terms: string[]) =>
  new RegExp(`\\b(?:${terms.map(esc).join('|')})\\b`, 'i')

/** Every tracked file matching a pathspec, from git rather than a glob list. */
function tracked(root: string, pathspec: string): string[] {
  return execFileSync('git', ['ls-files', '-z', pathspec], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
}

/**
 * The source modules the `exports` map makes reachable, resolved back from the
 * `dist/` targets it names. A `*` subpath expands through `git ls-files`, so a
 * schema module added tomorrow is covered without anyone remembering.
 */
function publishedModules(root: string): string[] {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    exports?: Record<string, unknown>
  }
  const targets: string[] = []
  const collect = (v: unknown): void => {
    if (typeof v === 'string') targets.push(v)
    else if (v && typeof v === 'object') Object.values(v).forEach(collect)
  }
  collect(pkg.exports ?? {})

  const modules = new Set<string>()
  for (const target of targets) {
    if (!target.startsWith('./dist/') || !target.endsWith('.js')) continue
    const src = `src/${target.slice('./dist/'.length, -'.js'.length)}.ts`
    if (!src.includes('*')) {
      modules.add(src)
      continue
    }
    for (const f of tracked(root, dirname(src))) {
      if (f.endsWith('.ts') && !f.includes('__tests__')) modules.add(f)
    }
  }
  return [...modules].sort()
}

/**
 * Names a consumer can import but a runtime `import *` cannot see. Types are
 * erased before the module object exists, so the only way to enumerate them is
 * to read the export statements — and a type alias is exactly how the stranded
 * vocabulary stayed public last time.
 */
const TYPE_DECL = /^export\s+(?:type|interface)\s+(\w+)/gm
const TYPE_BLOCK = /^export\s+type\s*\{([^}]*)\}/gms

function exportedTypeNames(source: string): string[] {
  const names: string[] = []
  for (const m of source.matchAll(TYPE_DECL)) names.push(m[1]!)
  for (const m of source.matchAll(TYPE_BLOCK)) {
    for (const raw of m[1]!.split(',')) {
      const name = raw.trim().split(/\s+as\s+/).pop()?.trim()
      if (name) names.push(name)
    }
  }
  return names
}

/**
 * Offenders under `root`, deterministically sorted so assertions are stable.
 *
 * Throws rather than returning `[]` whenever an input cannot be observed. An
 * empty term list and a surface with no identifiers are both silently, perfectly
 * green, which is the one thing a guard must never be.
 */
async function domainVocabulary(root: string, terms: string[] = TERMS): Promise<string[]> {
  if (terms.length === 0) throw new Error('blind: the vocabulary term list is empty')
  const re = vocabulary(terms)

  const identifiers: { file: string; name: string }[] = []
  for (const file of publishedModules(root)) {
    const mod = (await import(join(root, file))) as Record<string, unknown>
    for (const [name, value] of Object.entries(mod)) {
      identifiers.push({ file, name })
      const shape = (value as { shape?: unknown } | null | undefined)?.shape
      if (!shape || typeof shape !== 'object') continue
      for (const key of Object.keys(shape as object)) identifiers.push({ file, name: key })
    }
    for (const name of exportedTypeNames(readFileSync(join(root, file), 'utf8'))) {
      identifiers.push({ file, name })
    }
  }
  if (identifiers.length === 0) throw new Error(`blind: no published identifiers enumerated under ${root}`)

  const offenders = new Set<string>()
  for (const { file, name } of identifiers) {
    if (re.test(name)) offenders.add(`${file}: ${name}`)
  }
  return [...offenders].sort()
}

/** A minimal package whose shape the helper can read, built under `tmpdir()`. */
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'warpline-vocab-'))
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, dirname(rel)), { recursive: true })
    writeFileSync(join(root, rel), body)
  }
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['add', '-A'], { cwd: root })
  return root
}

const PKG = JSON.stringify({
  name: 'vocab-fixture',
  version: '1.0.0',
  files: ['src'],
  exports: { './schemas/*': { default: './dist/schemas/*.js' } },
})

describe('no published identifier carries the source runtime vocabulary', () => {
  test('the real repository is clean', async () => {
    expect(await domainVocabulary(REPO_ROOT)).toEqual([])
  })

  test('a shape key, an exported value and an exported type are each reported', async () => {
    const root = fixture({
      'package.json': PKG,
      'src/schemas/thing.ts':
        'export const Thing = { shape: { modes_run: 0, plugin: 0 } }\n' +
        'export const ModeRun = 1\n' +
        'export type SomethingElse = string\n',
      'src/schemas/other.ts': 'export type ModeRun = { mode: string }\n',
    })
    try {
      expect(await domainVocabulary(root)).toEqual([
        'src/schemas/other.ts: ModeRun',
        'src/schemas/thing.ts: ModeRun',
        'src/schemas/thing.ts: modes_run',
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a clean published surface reports nothing', async () => {
    const root = fixture({
      'package.json': PKG,
      'src/schemas/thing.ts':
        'export const Thing = { shape: { plugin: 0, status: 0 } }\n' +
        'export type Model = string\n',
    })
    try {
      expect(await domainVocabulary(root)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  /**
   * The scan is only as good as its pattern, and a pattern that matched nothing
   * would pass this file vacuously forever. Identifiers that must hit, ordinary
   * words that must not — `mode` is a substring of every miss, which is
   * precisely the over-match that would make this guard unobeyable.
   *
   * `ModeRunSchema` and `trial_ends_at` are here because both were measured
   * false against the word-boundary regex this file shipped with. `_` is a word
   * character in JavaScript regex, so `\b` never falls between `trial` and
   * `ends`, and it never falls between `Run` and `Schema` either. The first one
   * is self-proving: `ModeRunSchema` was a live export of
   * `src/schemas/run-log.ts` at commit `2d15f58` — the very commit where this
   * guard was watched failing — and the transcript names only `ModeRun`,
   * `mode`, `modes_run`. The guard looked straight at `ModeRunSchema` and
   * called the tree clean, while its own docstring claims those terms are what
   * stops the stranded types coming back.
   *
   * `Model` joins the must-miss side because the widening that fixes the miss
   * is case-folded, so the over-match it risks is case-folded too. Both halves
   * share one assertion on purpose: neither can be satisfied by weakening the
   * other.
   */
  test('the pattern matches identifiers and not the words that contain them', () => {
    const re = vocabulary(TERMS)
    const misses = ['modes_run', 'demo_booked', 'ModeRunSchema', 'trial_ends_at'].filter(
      (s) => !re.test(s),
    )
    const overMatches = ['model', 'moderation', 'Model'].filter((s) => re.test(s))
    expect([...misses, ...overMatches]).toEqual([])
  })

  test('matching is case-insensitive', () => {
    expect(vocabulary(TERMS).test('MODES_RUN')).toBe(true)
  })
})

/**
 * A guard that cannot observe its inputs must go red, never green. "Looked and
 * found nothing" and "did not look" are indistinguishable from the outside, and
 * that is the one property a guard must not have.
 */
describe('the guard fails when it cannot see', () => {
  test('an empty term list is red, not a skip', async () => {
    await expect(domainVocabulary(REPO_ROOT, [])).rejects.toThrow(/blind: the vocabulary term list is empty/)
  })

  test('a surface with no identifiers is red, not a clean bill of health', async () => {
    const root = fixture({
      'package.json': PKG,
      'src/schemas/thing.ts': '// nothing exported\n',
    })
    try {
      await expect(domainVocabulary(root)).rejects.toThrow(/blind: no published identifiers/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
