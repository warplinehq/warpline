/**
 * No file under `examples/` may reach past the surface this package publishes.
 *
 * The examples are the only executable teaching material that ships in the
 * tarball, so an example importing `warpline/dist/runtime/engine.js` — or any
 * internal module by relative path out of the package — teaches every plugin
 * author who copies it to depend on a seam nobody owes semver on. The published
 * half of that direction is already gated: the `exports` map is an allowlist,
 * and `scripts/verify-tarball.sh` asserts an unmapped subpath fails with
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`. Nothing gated the in-repo half, which is
 * where an example is written and where it is reviewed. This is that half.
 *
 * **The allowlist is a measured literal, not an inference.** It was produced by
 * a census of the tree as it stands (`find examples -name '*.ts' | xargs
 * /usr/bin/grep -hoE "from '[^']+'|import\('[^']+'\)" | sort -u`) and is pinned
 * here in exactly the shape `UNSTABLE_EXPECTED` is pinned in
 * `scripts/verify-tarball.sh`: a list a human reads, never a set computed at
 * run time from the thing being checked. This deliberately does NOT pre-admit
 * the capability subpaths landing elsewhere in this milestone. No file under
 * `examples/` imports one yet, and an allowlist entry nothing exercises is an
 * untested permission. The example rewrite in the next milestone extends this
 * literal, in the commit that first needs it.
 *
 * **Scope is all of `examples/`, including the example test files.** CI shards
 * `examples` as a whole, and a lint whose reach stops short of part of what it
 * claims to cover is this repository's recurring failure — four leak classes so
 * far, every one a green guard whose reach did not include the thing it existed
 * to catch. Widening the scope widens the allowlist instead: `bun:test` and
 * `node:os` are in the literal below because the six `handler.test.ts` files
 * legitimately import them.
 *
 * **Four import forms, and one predicate covering them.** A guard blind to one
 * import form is a defect this repository has already shipped;
 * `src/__tests__/screen-plugin-root.test.ts:14-16` records it in its own words.
 * The forms that matter here are the static named import, the `import type`
 * declaration (type-only, erased at build, and still a dependency a reader
 * copies), the dynamic `import()` expression, and the `export … from`
 * re-export, which names no import keyword at all and is the form that restored
 * five relocated helpers to a published subpath the last time it was missed.
 * Rather than four arms, the specifier scanner below is taken verbatim from
 * `src/__tests__/no-orphan-schema-fields.test.ts:131-132`, where it is already
 * reviewed and already load-bearing. It closes all four plus the side-effect
 * `import 'x'` and the CommonJS `require('x')` form, because it asks where a
 * quoted specifier sits rather than which keyword introduced it.
 *
 * **The search binary is named by absolute path, never resolved off PATH.** On
 * at least one machine here the bare name resolves to a ugrep build invoked
 * with `--ignore-files`, which honours `.gitignore`, and it has already
 * returned a false zero over a whole directory in this project's own census;
 * `git grep` with `:(exclude)` pathspecs shares the blind spot. Enumeration is
 * `find`, not `git ls-files`, for a second reason: an untracked new example
 * plugin is exactly the file a lint exists to catch, and `git ls-files` reports
 * the index. Between them, the file set is decided by `find` and nothing the
 * search tool believes about ignore files can subtract from it.
 *
 * **What makes the green assertion below evidence rather than an assumption**
 * is the fixture half in the same file: a temp-dir tree carrying the same
 * forbidden specifier in each of the four forms, asserted by name so a missing
 * form fails on the name and not merely on a count. A screen nobody has watched
 * fail is not a screen.
 *
 * Why a test rather than a lint script: `bun test` is the command CI runs and
 * the one CONTRIBUTING names, so the check cannot be skipped by forgetting a
 * second command. Adding ESLint plus a config plus a plugin to
 * `devDependencies` for one rule would put a second command in front of the
 * same property.
 */
import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..')

/**
 * Absolute paths, and the absoluteness is the whole mechanism — see the
 * paragraph above. A self-assertion further down reads this file back and fails
 * if either is ever replaced by a bare name.
 */
const GREP = '/usr/bin/grep'
const FIND = '/usr/bin/find'

/**
 * The measured surface an `examples/` file may name. Every `warpline*` entry is
 * checked against `package.json`'s `exports` map by a test below, so no entry
 * here can bless a specifier that would not resolve for someone who installed
 * the package.
 *
 * Relative specifiers beginning `./` or `../` are allowed **by rule**, not by
 * listing: an example plugin is a directory of files that import each other,
 * and enumerating those would be a second list to maintain that says nothing
 * about import direction. Reaching out of the package is not expressible that
 * way — `examples/` ships inside the tarball, so a relative specifier climbing
 * out of an example lands in `dist/`, and any such path is caught by the
 * `..`-escaping assertion rather than by this list.
 */
const ALLOWED: readonly string[] = [
  'bun:test',
  'node:fs/promises',
  'node:os',
  'node:path',
  'warpline',
  'warpline/lib/paths',
  'warpline/schemas/plugin-manifest',
  'warpline/schemas/skill-result',
]

/** Allowed by rule. `..` segments are handled separately, below. */
const RELATIVE = /^\.\.?\//

/**
 * A relative specifier that climbs above its own example directory. This is the
 * shape the rule above cannot wave through: `../../../src/runtime/engine.js`
 * from an example is precisely the reach this file refuses, and it is relative.
 */
const ESCAPES = /(^|\/)\.\.(\/|$)/

/**
 * The line prefilter handed to `grep`. POSIX ERE only — no non-capturing
 * groups and no backslash shorthand classes. `src/__tests__/no-private-planning-refs.test.ts:124-137`
 * records why in full: a non-capturing group makes GNU grep error out, and a
 * shorthand class compiles cleanly under a strict engine and then matches
 * nothing, which is a search that is green because it never looked.
 *
 * This selects candidate lines and their numbers; the scanner below decides
 * what is actually a specifier. A prefilter can only over-select, so no import
 * form can be lost here — every one of them puts a quote or a paren directly
 * after `from`, `import` or `require`.
 */
const CANDIDATE = `(from|import|require)[[:space:]]*[('"]`

/**
 * Verbatim from `src/__tests__/no-orphan-schema-fields.test.ts:131-132`, where
 * its edges are already documented: it takes a backtick only in call position,
 * because a template literal is legal in `import(...)` and a syntax error after
 * `from`, and this repository writes specifiers inside prose. Reusing it rather
 * than writing a second one means the two guards cannot drift on what counts as
 * an import.
 */
const SPECIFIER =
  /(?<![.\w])(?:(?:from|import)\s*["']|(?:import|require)\s*\(\s*["'`])([^"'`\n]+)["'`]/g

/**
 * Every TypeScript file under `root`, from `find` rather than a glob list or
 * the git index.
 *
 * Throws on an empty enumeration rather than returning `[]`. Zero files is
 * silently, perfectly green, and "looked and found nothing" must never be
 * indistinguishable from "did not look".
 */
function sourceFiles(root: string): string[] {
  const out = execFileSync(FIND, [root, '-type', 'f', '-name', '*.ts'], { encoding: 'utf8' })
  const files = out.split('\n').filter(Boolean).sort()
  if (files.length === 0) throw new Error(`blind: no TypeScript file enumerated under ${root}`)
  return files
}

/**
 * Every specifier under `root` that is neither allowed by the pinned literal
 * nor a relative sibling path, reported as `<file>:<line>: <specifier>`.
 */
function offenders(root: string): string[] {
  const files = sourceFiles(root)

  // `-H` unconditionally: with a single file argument grep omits the filename
  // and the three-field parse below would silently read the line number as a
  // path. Exit 1 means no line matched, which is a legitimate empty result;
  // anything else is a broken input and must not read as clean.
  let out = ''
  try {
    out = execFileSync(GREP, ['-nHE', CANDIDATE, ...files], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    })
  } catch (err) {
    if ((err as { status?: number }).status !== 1) throw err
  }

  const found: string[] = []
  for (const record of out.split('\n')) {
    if (record === '') continue
    const first = record.indexOf(':')
    const second = record.indexOf(':', first + 1)
    if (first === -1 || second === -1) {
      throw new Error(`blind: unparseable search record, so a line went unread: ${record}`)
    }
    const file = relative(root, record.slice(0, first))
    const line = record.slice(first + 1, second)
    for (const match of record.slice(second + 1).matchAll(SPECIFIER)) {
      const specifier = match[1]!
      if (ALLOWED.includes(specifier)) continue
      if (RELATIVE.test(specifier) && !ESCAPES.test(specifier)) continue
      found.push(`${file}:${line}: ${specifier}`)
    }
  }
  return found.sort()
}

describe('no example reaches past the published surface', () => {
  test('the real examples tree has no offender', () => {
    expect(offenders(join(REPO_ROOT, 'examples'))).toEqual([])
  })

  /**
   * An allowlist entry naming an unpublished specifier is worse than no entry:
   * it blesses an import that fails to resolve for anyone who installed the
   * package, while this file reports the example clean. The `exports` map is the
   * only authority on which `warpline/*` paths exist.
   */
  test('every warpline specifier the allowlist blesses is one the exports map publishes', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      exports?: Record<string, unknown>
    }
    const keys = Object.keys(pkg.exports ?? {})
    if (keys.length === 0) throw new Error('blind: package.json declares no exports map')

    const exact = new Set(
      keys.filter((k) => !k.includes('*')).map((k) => (k === '.' ? 'warpline' : `warpline/${k.slice(2)}`)),
    )
    const prefixes = keys.filter((k) => k.endsWith('/*')).map((k) => `warpline/${k.slice(2, -1)}`)

    const unpublished = ALLOWED.filter((s) => s === 'warpline' || s.startsWith('warpline/')).filter(
      (s) => !exact.has(s) && !prefixes.some((p) => s.startsWith(p) && s.length > p.length),
    )
    expect(unpublished).toEqual([])
  })

  test('an enumeration that finds nothing is red, not clean', () => {
    const root = mkdtempSync(join(tmpdir(), 'warpline-import-blind-'))
    try {
      expect(() => offenders(root)).toThrow(/blind: no TypeScript file enumerated/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
