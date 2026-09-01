/**
 * Every published schema field must have a writer and a documented home.
 *
 * This is the **structural** half of a two-guard pair, and it is the half that
 * catches the *next* leak. It knows nothing about vocabulary: it asks only
 * whether a field anyone can reach through `warpline/schemas/*` is ever written
 * by this runtime and ever mentioned in a shipped document. A field that is
 * neither is surface with no owner — nothing produces it, nothing explains it,
 * and it is public API from the release it appeared in. The retrospective half
 * lives in `no-domain-vocabulary.test.ts`, which pins the vocabulary already
 * known to have leaked.
 *
 * **The predicate is a conjunction and must stay one.** A field is an offender
 * only when it has no non-test writer under `src/` AND no mention in any packed
 * markdown file. The doc half alone measures fifty offenders across five schema
 * files — twenty of them in `engine-state.ts`, every one with a real writer in
 * `src/board/state-manager.ts`. The writer half alone is no better. Either half
 * on its own lands red on fields nobody intends to touch, and the pressure that
 * creates is to bolt on an ignore list — at which point the guard is a hand list
 * again and has bought nothing.
 *
 * What ships comes from npm, not from a model of npm. Asking `npm pack` beats
 * reimplementing its `files` semantics: that array supports globs and `!`
 * negation (this package excludes `docs/board-spec.md` that way), and a check
 * that models the rules itself gets the answer wrong precisely when the rules
 * are being used for something interesting. Coverage of `src/` comes from
 * `git ls-files` for the same reason. A hand list reports "clean" when it means
 * "did not look", and the two are indistinguishable from the outside.
 *
 * **Known blind spot, recorded rather than fixed.** Enumeration reads top-level
 * `.shape` keys only, so a field nested inside an anonymous record value is
 * invisible to it. `is_default`, inside the `outputs` record value in
 * `src/schemas/plugin-manifest.ts`, is a genuine orphan this guard cannot see —
 * the same honesty move `docs.test.ts` already makes for the manifest table
 * generator, which stops at the same level. A recursive enumeration is
 * defensible and is not what this check is buying.
 *
 * Every assertion is a helper taking a root directory and returning offender
 * strings, so the identical code runs against the real repository (must return
 * `[]`) and against a temp-dir fixture that has been deliberately broken (must
 * return a non-empty array). That symmetry is what makes "this check goes red"
 * provable rather than assumed. Fixture roots live under `tmpdir()` and are
 * removed in a `finally` — tests never write inside the repository.
 *
 * A second assertion lives here rather than in a file of its own because it
 * asks about the same surface for the same reason: no module under
 * `src/schemas/` may import the Node filesystem or path built-ins. A field with
 * no owner and a `writeFile` behind a specifier named `schemas` are the same
 * failure — a wildcard export turning whatever gets written into public API
 * before anyone looks at it.
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
 * Ratchet, not an ignore list. Empty by default; only ever populated to hold a
 * sweep already in progress, never to admit a new orphan. The companion
 * assertion below fails when an entry here is no longer an offender, so the
 * list cannot outlive its hits and quietly become general-purpose.
 */
const DEFERRED = new Set<string>([
  // v0.3 (the Board). `due_date` and `origin_check` are real orphans, but
  // disposing of them settles board task-model questions, and the phase that
  // added this guard is forbidden to open `board-spec.md`.
  'src/schemas/engine-state.ts: due_date',
  // v0.3 (the Board), same reason: resolution semantics for a task's origin
  // check are a board-model decision, not a schema-hygiene one.
  'src/schemas/engine-state.ts: origin_check',
])

/**
 * Ratchet for the no-filesystem assertion below. Separate from `DEFERRED`
 * because it holds a different predicate; sharing one set would let an entry
 * excused for one guard silence the other. Same rules: an inline citation per
 * entry, and a companion assertion that fails when an entry stops being an
 * offender.
 */
const DEFERRED_FS = new Set<string>([])

/**
 * Node built-ins that make a module a filesystem client, matched on the import
 * specifier.
 *
 * **Four shapes, one pattern**, because the previous one covered two and the
 * other two were reported by nobody: a static `from '...'`, a dynamic
 * `import('...')`, a side-effect `import '...'` with no binding and no `from`,
 * and a CommonJS `require('...')`. Each is caught with or without the `node:`
 * prefix, which the previous pattern demanded on both of its arms.
 *
 * **Two axes, and conflating them is how the gap survived.** The old docstring
 * said a subpath and "the bare form" both hit; "bare" there meant *no subpath*
 * (`node:fs` beside `node:fs/promises`), not *no prefix* (`fs` beside
 * `node:fs`). It read as a claim about the prefix and was a claim about the
 * subpath, so `from 'fs'` looked covered for as long as nobody fixtured it.
 * Both axes are optional now: `(?:node:)?` for the prefix, `(?:\/[^'"]*)?` for
 * the subpath.
 *
 * The built-in name is followed by either a subpath separator or the closing
 * quote, so a package whose name merely starts the same way misses — `fs-extra`
 * and `pathe` both fail that anchor. The specifier is entered through a quote,
 * so `'./path'` misses on its first character. Widening the prefix is what
 * created both risks; `FS-FORM-NEG` below is the other half of the change.
 *
 * **What this still cannot see**, recorded rather than left to be assumed away:
 * a `createRequire` handle bound to a variable and called later, and a fully
 * computed dynamic specifier. Neither carries a literal specifier adjacent to
 * an introducer keyword, so no regex reaches either, and neither has ever
 * appeared in this repository. A guard that says nothing about its edges is
 * read as having none.
 */
const FS_BUILTIN =
  /(?<![.\w])(?:from|import|require)\s*\(?\s*['"](?:node:)?(?:fs|path)(?:\/[^'"]*)?['"]/

/** A term is a literal; `\b` anchors it so a substring of another word misses. */
const bounded = (t: string) => new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)

/** What `npm publish` would actually ship, straight from npm. */
function packedFiles(root: string): string[] {
  let out: string
  try {
    out = execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch (err) {
    // The pack list is an input. Failing to obtain it is "did not look", and
    // reading that as "no docs mention anything" would flood the offender list
    // with noise that looks like a finding.
    throw new Error(`blind: could not enumerate the packed file list under ${root}: ${String(err)}`)
  }
  return (JSON.parse(out)[0].files as { path: string }[]).map((f) => f.path)
}

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
 * Every schema module that imports the Node filesystem or path built-ins.
 *
 * `./schemas/*` is a **wildcard** entry in the `exports` map, so a file placed
 * under `src/schemas/` is public API the moment it is written, with no review
 * step between writing it and shipping it. That is how `warpline/schemas/
 * run-log` came to publish `mkdir`, `writeFile` and `unlink` behind a specifier
 * whose name promises declarative shapes. One assertion does two jobs: it
 * proves the 09-05 split landed, and it stops the next schema module from
 * re-committing the same mistake — which was not hypothetical, since the config
 * schema module added earlier in that phase sits under the same wildcard.
 *
 * `__tests__` is excluded, and the exclusion is the point rather than a
 * loophole: `tsconfig.build.json` excludes `src/**​/__tests__/**`, so no test
 * file is compiled into `dist/` and none is reachable through the wildcard.
 * Including them would force a ratchet entry for every fixture that writes to a
 * tmpdir — a schema test cannot round-trip a document through a real write
 * without importing the filesystem — and a ratchet full of non-offenders is how
 * a ratchet becomes an ignore list.
 *
 * Throws rather than returning `[]` when no schema module can be enumerated:
 * zero files is silently, perfectly green.
 */
function filesystemInSchemas(root: string): string[] {
  const modules = tracked(root, 'src/schemas').filter(
    (f) => f.endsWith('.ts') && !f.includes('__tests__'),
  )
  if (modules.length === 0) {
    throw new Error(`blind: no schema modules enumerated under ${root}`)
  }
  const offenders: string[] = []
  for (const file of modules) {
    let text: string
    try {
      text = readFileSync(join(root, file), 'utf8')
    } catch (err) {
      // `git ls-files` reports the INDEX, so a path mid-rebase has nothing to
      // read. Anything else is a broken input and must not read as clean.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw err
    }
    if (FS_BUILTIN.test(text)) offenders.push(file)
  }
  return offenders.sort()
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/

/**
 * Prose only. A field named inside a fenced block is an example of a payload,
 * not a description of one — a JSON sample can carry a key nobody ever agreed
 * to support, which is exactly the shape this guard exists to catch.
 */
function stripFences(text: string): string {
  const out: string[] = []
  let fence: string | null = null
  for (const line of text.split('\n')) {
    const m = FENCE.exec(line)
    if (fence === null) {
      if (m) {
        fence = m[1]![0]!
        continue
      }
      out.push(line)
    } else if (m && m[1]![0] === fence) {
      fence = null
    }
  }
  return out.join('\n')
}

/**
 * Offenders under `root`, deterministically sorted so assertions are stable.
 *
 * Throws rather than returning `[]` whenever an input cannot be observed. Zero
 * enumerated fields is the dangerous one: it is silently, perfectly green.
 */
async function orphanFields(root: string): Promise<string[]> {
  const docs = packedFiles(root).filter((f) => f.endsWith('.md'))
  if (docs.length === 0) throw new Error(`blind: npm packs no markdown under ${root}`)
  // No try/catch: a packed document that cannot be read is a broken input, not
  // an empty one.
  const prose = docs.map((d) => stripFences(readFileSync(join(root, d), 'utf8'))).join('\n')

  const modules = publishedModules(root)
  const fields: { file: string; field: string }[] = []
  for (const file of modules) {
    const mod = (await import(join(root, file))) as Record<string, unknown>
    for (const value of Object.values(mod)) {
      const shape = (value as { shape?: unknown } | null | undefined)?.shape
      if (!shape || typeof shape !== 'object') continue
      for (const field of Object.keys(shape as object)) fields.push({ file, field })
    }
  }
  if (fields.length === 0) throw new Error(`blind: no schema fields enumerated under ${root}`)

  // Writers are every non-test source file. The declaring module is excluded —
  // a field's own definition is not evidence that anything produces it.
  const writers = new Map<string, string>()
  for (const file of tracked(root, 'src')) {
    if (!file.endsWith('.ts') || file.includes('__tests__') || file.endsWith('.test.ts')) continue
    try {
      writers.set(file, readFileSync(join(root, file), 'utf8'))
    } catch (err) {
      // `git ls-files` reports the INDEX: a path mid-rebase, or one removed
      // with plain `rm`, has nothing to read.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }

  const offenders = new Set<string>()
  for (const { file, field } of fields) {
    const re = bounded(field)
    if (re.test(prose)) continue
    let written = false
    for (const [f, text] of writers) {
      if (f === file) continue
      if (re.test(text)) {
        written = true
        break
      }
    }
    if (!written) offenders.add(`${file}: ${field}`)
  }
  return [...offenders].sort()
}

/** A minimal package whose shape the helper can read, built under `tmpdir()`. */
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'warpline-orphan-'))
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, dirname(rel)), { recursive: true })
    writeFileSync(join(root, rel), body)
  }
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['add', '-A'], { cwd: root })
  return root
}

const PKG = JSON.stringify({
  name: 'orphan-fixture',
  version: '1.0.0',
  files: ['docs', 'src'],
  exports: { './schemas/*': { default: './dist/schemas/*.js' } },
})

/** No zod in a temp tree; the helper duck-types `.shape`, so this is enough. */
const SCHEMA = "export const Thing = { shape: { alpha: 0, beta: 0 } }\n"

describe('every published schema field has a writer and a doc', () => {
  test('the real repository has no orphan fields outside the ratchet', async () => {
    const offenders = (await orphanFields(REPO_ROOT)).filter((o) => !DEFERRED.has(o))
    expect(offenders).toEqual([])
  })

  test('the deferral ratchet has no stale entries', async () => {
    const offenders = new Set(await orphanFields(REPO_ROOT))
    expect([...DEFERRED].filter((e) => !offenders.has(e))).toEqual([])
  })

  test('a field with neither writer nor doc is reported', async () => {
    const root = fixture({
      'package.json': PKG,
      'docs/guide.md': 'This document mentions alpha and nothing else.\n',
      'src/schemas/thing.ts': SCHEMA,
      'src/writer.ts': 'export const w = "alpha"\n',
    })
    try {
      expect(await orphanFields(root)).toEqual(['src/schemas/thing.ts: beta'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a writer alone clears a field, and a doc mention alone clears a field', async () => {
    const root = fixture({
      'package.json': PKG,
      'docs/guide.md': 'This document mentions beta.\n',
      'src/schemas/thing.ts': SCHEMA,
      'src/writer.ts': 'export const w = { alpha: 1 }\n',
    })
    try {
      expect(await orphanFields(root)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('the declaring module is not its own writer', async () => {
    const root = fixture({
      'package.json': PKG,
      'docs/guide.md': 'Nothing relevant here.\n',
      'src/schemas/thing.ts': SCHEMA,
    })
    try {
      expect(await orphanFields(root)).toEqual([
        'src/schemas/thing.ts: alpha',
        'src/schemas/thing.ts: beta',
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  /**
   * The ruling, pinned: a key that appears only inside a fenced block is an
   * example, not documentation. Leaving fences in would let a copy-pasted JSON
   * sample vouch for every key it happens to contain.
   */
  test('a mention inside a fenced code block does not count as documented', async () => {
    const root = fixture({
      'package.json': PKG,
      'docs/guide.md': '# Guide\n\n```json\n{ "alpha": 1, "beta": 2 }\n```\n\nNo prose.\n',
      'src/schemas/thing.ts': SCHEMA,
    })
    try {
      expect(await orphanFields(root)).toEqual([
        'src/schemas/thing.ts: alpha',
        'src/schemas/thing.ts: beta',
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('no published schema module imports the filesystem', () => {
  test('the real repository is clean outside the ratchet', () => {
    expect(filesystemInSchemas(REPO_ROOT).filter((f) => !DEFERRED_FS.has(f))).toEqual([])
  })

  test('the filesystem ratchet has no stale entries', () => {
    const offenders = new Set(filesystemInSchemas(REPO_ROOT))
    expect([...DEFERRED_FS].filter((e) => !offenders.has(e))).toEqual([])
  })

  test('a schema module importing the filesystem is reported', () => {
    const root = fixture({
      'package.json': PKG,
      'src/schemas/thing.ts': "import { existsSync } from 'node:fs'\n" + SCHEMA,
    })
    try {
      expect(filesystemInSchemas(root)).toEqual(['src/schemas/thing.ts'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('the subpath and dynamic forms are caught too', () => {
    const root = fixture({
      'package.json': PKG,
      'src/schemas/a.ts': "import { mkdir } from 'node:fs/promises'\n" + SCHEMA,
      'src/schemas/b.ts': "const { join } = await import('node:path')\n" + SCHEMA,
      'src/schemas/c.ts': SCHEMA,
    })
    try {
      expect(filesystemInSchemas(root)).toEqual(['src/schemas/a.ts', 'src/schemas/b.ts'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  /**
   * The four forms the matcher was blind to, one test each rather than one
   * combined case: a single assertion proves one form red, and the claim being
   * made is per-form. Each pairs its offender with a clean control module, so
   * the assertion discriminates rather than counts. The filesystem built-in and
   * the path built-in are each exercised twice across the four — a fixture set
   * that only ever names one of them proves half the alternation.
   */
  test('FS-FORM-M1: the bare static form, with no node: prefix, is reported', () => {
    const root = fixture({
      'package.json': PKG,
      'src/schemas/m1.ts': "import { existsSync } from 'fs'\n" + SCHEMA,
      'src/schemas/m1-control.ts': SCHEMA,
    })
    try {
      expect(filesystemInSchemas(root)).toEqual(['src/schemas/m1.ts'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('FS-FORM-M2: the side-effect form, with no binding and no from, is reported', () => {
    const root = fixture({
      'package.json': PKG,
      'src/schemas/m2.ts': "import 'node:path'\n" + SCHEMA,
      'src/schemas/m2-control.ts': SCHEMA,
    })
    try {
      expect(filesystemInSchemas(root)).toEqual(['src/schemas/m2.ts'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('FS-FORM-M3: the CommonJS require form is reported', () => {
    const root = fixture({
      'package.json': PKG,
      'src/schemas/m3.ts': "const fs = require('node:fs')\n" + SCHEMA,
      'src/schemas/m3-control.ts': SCHEMA,
    })
    try {
      expect(filesystemInSchemas(root)).toEqual(['src/schemas/m3.ts'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('FS-FORM-M4: the bare dynamic form, with no node: prefix, is reported', () => {
    const root = fixture({
      'package.json': PKG,
      'src/schemas/m4.ts': "const { join } = await import('path')\n" + SCHEMA,
      'src/schemas/m4-control.ts': SCHEMA,
    })
    try {
      expect(filesystemInSchemas(root)).toEqual(['src/schemas/m4.ts'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  /**
   * The other half of the widening. Making the `node:` prefix optional is what
   * enlarged the match surface, so the four shapes now adjacent to a hit are
   * asserted clean in one case: the offender list must be **empty**, not short.
   * `createRequire` is here because research predicted it would fire; it does
   * not, because the substring is `Require` and the alternation is
   * case-sensitive. The case pins that rather than assuming it.
   */
  test('FS-FORM-NEG: four lookalike shapes are none of them reported', () => {
    const root = fixture({
      'package.json': PKG,
      'src/schemas/n1.ts': "import graceful from 'fs-extra'\n" + SCHEMA,
      'src/schemas/n2.ts': "import { join } from 'pathe'\n" + SCHEMA,
      'src/schemas/n3.ts': "import { resolve } from './path'\n" + SCHEMA,
      'src/schemas/n4.ts': "const load = createRequire('node:fs')\n" + SCHEMA,
    })
    try {
      expect(filesystemInSchemas(root)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a test fixture under the schemas directory is not an offender', () => {
    const root = fixture({
      'package.json': PKG,
      'src/schemas/thing.ts': SCHEMA,
      'src/schemas/__tests__/thing.test.ts': "import { mkdir } from 'node:fs/promises'\n",
    })
    try {
      expect(filesystemInSchemas(root)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

/**
 * A guard that cannot observe its inputs must go red, never green. "Looked and
 * found nothing" and "did not look" are indistinguishable from the outside, and
 * that is the one property a guard must not have.
 *
 * Unreadability is exercised as "the surface cannot be enumerated at all"
 * rather than as a permission bit. A `chmod 000` case is uid-dependent — one CI
 * job here runs inside a `node:22` container as root, where the read succeeds
 * and the assertion passes without ever testing anything. A check that is
 * vacuous on the runner that matters is the failure this file exists to refuse.
 */
describe('the guard fails when it cannot see', () => {
  test('a docs surface it cannot enumerate is red, not empty', async () => {
    const root = mkdtempSync(join(tmpdir(), 'warpline-orphan-blind-'))
    try {
      // No package manifest: `npm pack` errors instead of reporting a list.
      await expect(orphanFields(root)).rejects.toThrow(/blind: could not enumerate/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('zero packed markdown is red, not "nothing is documented"', async () => {
    const root = fixture({
      'package.json': JSON.stringify({
        name: 'orphan-fixture',
        version: '1.0.0',
        files: ['src'],
        exports: { './schemas/*': { default: './dist/schemas/*.js' } },
      }),
      'src/schemas/thing.ts': SCHEMA,
    })
    try {
      await expect(orphanFields(root)).rejects.toThrow(/blind: npm packs no markdown/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('zero enumerated schema modules is red, not "nothing imports fs"', () => {
    const root = fixture({ 'package.json': PKG, 'src/other.ts': 'export const x = 1\n' })
    try {
      expect(() => filesystemInSchemas(root)).toThrow(/blind: no schema modules enumerated/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('zero enumerated fields is red, not a clean bill of health', async () => {
    const root = fixture({
      'package.json': PKG,
      'docs/guide.md': 'Prose.\n',
      'src/schemas/thing.ts': 'export const notASchema = 1\n',
    })
    try {
      await expect(orphanFields(root)).rejects.toThrow(/blind: no schema fields enumerated/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
