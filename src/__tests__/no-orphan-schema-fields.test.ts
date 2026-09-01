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
 * **An allowlist, and the inversion is the point.** This used to enumerate the
 * built-ins that make a module a filesystem client — `(?:node:)?(?:fs|path)`
 * with an optional subpath, across four import forms. Enumerating what is
 * forbidden is a losing position, and it lost four ways at once: a backtick
 * dynamic specifier is a literal no denylist arm quoted; `export * from
 * '../runtime/engine-state-store.js'` restores every relocated helper to
 * `warpline/schemas/engine-state` while naming no built-in at all;
 * `node:child_process` is arbitrary disk access through a name the alternation
 * never listed; `node:os` hands out `tmpdir()`. Each would have needed its own
 * arm, and the next one would have needed the arm after that.
 *
 * A schema module has exactly two legitimate specifiers — `zod`, and a sibling
 * schema module by relative path — so the predicate asserts *that* instead.
 * One rule closes all four, and every built-in nobody has thought of yet.
 *
 * The function below still carries the filesystem name, because keeping disk
 * I/O out of `warpline/schemas/*` is the invariant. The predicate is broader
 * than the name by construction: a schema module importing `lodash` is
 * reported too, and that is correct — the subpath ships shapes.
 *
 * **The specifier scanner takes backticks only in call position.** A template
 * literal is legal in `import(...)` / `require(...)` and a syntax error after
 * `from`, and this repository writes prose like ``derives it from
 * `plugin_entries` `` inside docstrings. Accepting a backtick after `from`
 * would report two real schema modules on the strength of their comments.
 *
 * **What this still cannot see**, recorded rather than left to be assumed away:
 * a `createRequire` handle bound to a variable and called later; a fully
 * computed specifier, which carries no literal for any regex to reach; and an
 * indirect global, `globalThis['Bun'].write(...)`, which the `BUN_GLOBAL` scan
 * below catches only in its written form. None has ever appeared here. A guard
 * that says nothing about its edges is read as having none.
 *
 * **Deliberately reported, not a false positive to be fixed:** a specifier
 * quoted in prose (`` * was `import { mkdir } from 'node:fs/promises'` ``) and
 * a type-only `import type { PathLike } from 'node:fs'`. The first is loud
 * rather than silent, and the second names the filesystem in a module whose
 * subpath promises shapes. Both are cheap to phrase around; neither is worth a
 * comment stripper that could swallow a real import inside a string.
 */
const ALLOWED_SPECIFIER = /^(?:zod|\.\/[\w.-]+\.js)$/
const SPECIFIER =
  /(?<![.\w])(?:(?:from|import)\s*["']|(?:import|require)\s*\(\s*["'`])([^"'`\n]+)["'`]/g

/**
 * The no-import case. `Bun.file(p).text()` and `Bun.write(p, s)` are a live
 * idiom in this repository (`src/runtime/__tests__/approval-gate.test.ts`), and
 * a global needs no specifier, so a schema module could do disk I/O with an
 * empty import list and satisfy the allowlist completely.
 */
const BUN_GLOBAL = /\bBun\s*\.\s*(?:file|write)\s*\(/

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
 * Every schema module that names a specifier outside the allowlist, or reaches
 * the filesystem through the `Bun` global without naming one at all.
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
    const specifiers = [...text.matchAll(SPECIFIER)].map((m) => m[1]!)
    if (specifiers.some((s) => !ALLOWED_SPECIFIER.test(s)) || BUN_GLOBAL.test(text)) {
      offenders.push(file)
    }
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
   * The four forms the denylist could not see, closed by one predicate rather
   * than four new arms. Combined into one case on the precedent of "the subpath
   * and dynamic forms are caught too": the allowlist does not have a per-form
   * branch to prove, so a per-form test would be four copies of one assertion.
   * The clean control is what makes the list discriminate.
   *
   * The re-export bridge is first because it is the one that matters here: that
   * single line inside `src/schemas/engine-state.ts` restores all five
   * relocated helpers to the published subpath, and the old matcher stayed
   * green on it.
   */
  test('FS-FORM-M5: the four forms a built-in denylist could not see are reported', () => {
    const root = fixture({
      'package.json': PKG,
      'src/schemas/m5-bridge.ts': "export * from '../runtime/engine-state-store.js'\n" + SCHEMA,
      'src/schemas/m5-backtick.ts': 'const fs = await import(`node:fs`)\n' + SCHEMA,
      'src/schemas/m5-exec.ts': "import { execFileSync } from 'node:child_process'\n" + SCHEMA,
      'src/schemas/m5-os.ts': "import { tmpdir } from 'node:os'\n" + SCHEMA,
      'src/schemas/m5-control.ts': SCHEMA,
    })
    try {
      expect(filesystemInSchemas(root)).toEqual([
        'src/schemas/m5-backtick.ts',
        'src/schemas/m5-bridge.ts',
        'src/schemas/m5-exec.ts',
        'src/schemas/m5-os.ts',
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  /**
   * The no-import case, which no specifier rule of any width can reach: `Bun`
   * is a global, so this module's import list is empty and every specifier in
   * it is allowed. The control is a module that names `Bun` without calling
   * into the filesystem through it, so the scan discriminates on the call
   * rather than on the identifier.
   */
  test('FS-FORM-M6: filesystem access through the Bun global is reported', () => {
    const root = fixture({
      'package.json': PKG,
      'src/schemas/m6.ts': 'const raw = await Bun.file(p).text()\n' + SCHEMA,
      'src/schemas/m6-write.ts': 'await Bun.write(p, s)\n' + SCHEMA,
      'src/schemas/m6-control.ts': 'const v = Bun.version\n' + SCHEMA,
    })
    try {
      expect(filesystemInSchemas(root)).toEqual(['src/schemas/m6-write.ts', 'src/schemas/m6.ts'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  /**
   * Rewritten with the inversion, and the ruling it re-pins is the opposite of
   * the one it used to. Under a built-in denylist these three were lookalikes
   * asserted clean: `fs-extra` and `pathe` failed the built-in anchor and
   * `'./path'` failed on its first character. Under the allowlist all three are
   * offenders — `fs-extra` because a schema module importing a filesystem
   * wrapper *is* a filesystem client, `pathe` on the same reasoning, and
   * `'./path'` because a relative specifier with no `.js` suffix is not a
   * sibling ES module in this build. That is the allowlist working rather than
   * a fixture that survived the change.
   *
   * `createRequire` is the one that stays clean, and for the reason it always
   * did: the substring is `Require`, the scanner is case-sensitive, and a
   * handle called later carries no literal. It is a recorded blind spot, not a
   * pass. The two-line control is what stops "everything is an offender now"
   * from reading as success.
   */
  test('FS-FORM-NEG: the allowlist rules on lookalikes, and pins what it still cannot see', () => {
    const root = fixture({
      'package.json': PKG,
      'src/schemas/n1.ts': "import graceful from 'fs-extra'\n" + SCHEMA,
      'src/schemas/n2.ts': "import { join } from 'pathe'\n" + SCHEMA,
      'src/schemas/n3.ts': "import { resolve } from './path'\n" + SCHEMA,
      'src/schemas/n4.ts': "const load = createRequire('node:fs')\n" + SCHEMA,
      'src/schemas/n5.ts':
        "import { z } from 'zod'\nimport type { X } from './other.js'\n" + SCHEMA,
    })
    try {
      expect(filesystemInSchemas(root)).toEqual([
        'src/schemas/n1.ts',
        'src/schemas/n2.ts',
        'src/schemas/n3.ts',
      ])
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
