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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

/**
 * Plainly outside the allowlist, unambiguously not a relative path, and the
 * one built-in that hands an example arbitrary disk and process access — so a
 * fixture importing it is a specifier nobody would argue about.
 */
const FORBIDDEN = 'node:child_process'

/**
 * One file per import form, each naming the same forbidden specifier. Keyed by
 * file name so the assertions can name what they expect instead of counting:
 * four offenders is also what you get when one form is found twice and another
 * not at all, and that is precisely the state this fixture exists to detect.
 */
const FORMS: Record<string, string> = {
  'static-named.ts': `import { execFileSync } from '${FORBIDDEN}'\n`,
  'type-only.ts': `import type { ChildProcess } from '${FORBIDDEN}'\n`,
  'dynamic.ts': `const child = await import('${FORBIDDEN}')\n`,
  're-export.ts': `export { spawn } from '${FORBIDDEN}'\n`,
}

const EXPECTED = Object.keys(FORMS)
  .map((name) => `${name}:1: ${FORBIDDEN}`)
  .sort()

/** Under `mkdtemp` and nowhere else — tests never write inside the repository. */
function fixture(extra: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'warpline-import-forms-'))
  for (const [name, body] of Object.entries({ ...FORMS, ...extra })) {
    writeFileSync(join(root, name), body)
  }
  return root
}

/**
 * Matches an invocation of the search or enumeration binary by bare name. Its
 * own source is not a match: after `exec` comes `|spawn)`, so the alternation
 * never lines up against the text of the pattern itself.
 */
const BARE_NAME = /(?:exec|spawn)(?:File)?(?:Sync)?\(\s*['"](?:grep|find)['"]/

describe('the lint has been watched finding things', () => {
  test('all four import forms are reported, by name and not by count', () => {
    const root = fixture()
    try {
      expect(offenders(root)).toEqual(EXPECTED)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  /**
   * A file an ignore-file-honouring search would drop is still found.
   *
   * **What this proves, measured rather than assumed.** A ugrep build invoked
   * with `--ignore-files` drops a `.gitignore`d file only when it walks a
   * directory itself. Handed explicit file arguments — which is what the helper
   * above does, because `find` decides the file set — it reads every path it is
   * given, and so does every other search binary. That was probed on this
   * machine this session rather than recalled, and it means this assertion does
   * NOT catch someone replacing the absolute path with a bare name while the
   * arguments stay explicit. The self-assertion below is the tripwire for that;
   * these two are separate claims and neither substitutes for the other.
   *
   * What this assertion does catch is the rewrite that actually happened in
   * this project's own census: a search told to walk a directory, under a
   * binary that honours ignore files, reporting a false zero over a whole tree.
   * Rewriting the helper to recurse reddens here, on the file the fixture's own
   * `.gitignore` names.
   */
  test('a file a .gitignore would hide is still reported', () => {
    const root = fixture({ '.gitignore': 'dynamic.ts\n' })
    try {
      expect(offenders(root)).toEqual(EXPECTED)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  /**
   * The half the fixture above cannot reach. Swapping the absolute path for a
   * bare name is invisible to every behavioural assertion in this file — on the
   * machines that matter the bare name resolves to the same binary, so the
   * behaviour is identical right up until it runs somewhere it is not. Reading
   * this file back is the only mechanised way to hold the rule that made the
   * ignore-file trap harmless in the first place.
   */
  test('this file names its binaries by absolute path and never by bare name', () => {
    const self = readFileSync(join(import.meta.dir, 'import-direction.test.ts'), 'utf8')
    expect(self).toContain(GREP)
    expect(self).toContain(FIND)
    expect(BARE_NAME.test(self)).toBe(false)
  })
})
