/**
 * No bundled example computes a path to a file another plugin produced.
 *
 * The invariant has one name and covers two different things, and this guard
 * polices only the narrower one:
 *
 *   IN SCOPE — a hand-computed path to a *declared dependency's* Output. That
 *   is a seam the runtime owes a plugin author, and the runtime now pays it:
 *   `capabilities.dependencies.lastOutput(caller, name)` hands over the record
 *   the named producer last returned. A handler that reaches past the member
 *   and reads a file instead succeeds whether or not the producer ever ran,
 *   which is the failure this guard exists to catch. `anomaly-issue` and
 *   `daily-digest` are the two examples that used to do it.
 *
 *   OUT OF SCOPE — a path to an operator-configured or host-dropped INPUT file,
 *   where there is no producer plugin, no declared edge and nothing for a
 *   member to deliver. `derived-summary` and `metrics-rollup` read such files,
 *   and they resemble the first case only in mechanism. Asking the member for
 *   them would throw, because they declare no dependencies at all; making them
 *   not throw would mean inventing declarations that change level ordering for
 *   two more examples.
 *
 * `feed-triage` was a third name on that list. It is off the list now, and it
 * left with an argument rather than by deletion, because the OUT OF SCOPE
 * reasoning was never a property of the plugin — it was a fact about the tree.
 * The reasoning holds while nothing produces the file the plugin reads: no
 * producer, so no edge to declare, so nothing a member could be asked for
 * without inventing the declaration first. That fact is what this phase
 * changes, and it changes for exactly one of the three. `feed-monitor` gains a
 * real Output, published the way `anomaly-watch` publishes one, and
 * `feed-triage` declares the edge to it. The edge stops being invented and
 * becomes declared, which withdraws the OUT OF SCOPE reasoning in full — for
 * one plugin, on a fact that moved, not on a preference.
 *
 * The guard is NOT widened to let it through, and that is the point of writing
 * this down. Once the handler reads through
 * `capabilities.dependencies.lastOutput` the path literal is gone from the
 * handler, so there is nothing left for `offenders` to find and the guard goes
 * green by the offence disappearing. That is the move `anomaly-issue` and
 * `daily-digest` already made — the two examples the IN SCOPE paragraph above
 * names as having used to compute the path, and the precedent this admission
 * follows. `derived-summary` and `metrics-rollup` stay policed on the unchanged
 * ground: either is flagged the moment it declares a dependency while keeping a
 * foreign path read.
 *
 * "The manifest declares a non-empty `dependencies` array" is what mechanizes
 * that distinction, and it is stated here so a later reader does not widen the
 * predicate and take those two examples with it. A general "no home-relative
 * JSON path in any handler" rule is a different, larger claim and this file
 * does not make it.
 *
 * The own-name exemption is not a loophole either: `docs/plugin-authoring.md`
 * documents reading a plugin's OWN prior state under a path derived from its
 * manifest name as the sanctioned pattern, which is what
 * `anomaly-issue/handler.ts`'s filed-issues ledger does.
 *
 * Same shape as `example-test-hygiene.test.ts` and `example-defaults.test.ts`:
 * one helper taking a root and returning offender strings, run against a
 * planted fixture (must name it) and against the real tree (must be empty), so
 * the guard is provably non-vacuous. Structural rather than runtime for the
 * reason those files give: a runtime check would have to intercept filesystem
 * calls inside handlers this file does not control.
 */
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const EXAMPLES = join(REPO_ROOT, 'examples', 'plugins')

/**
 * Block comments only, and deliberately not line comments: a `//` rule would
 * truncate any line holding a `https://` inside a string literal, which every
 * handler that talks to an API has. Stripping the block comments is what stops
 * a manifest docstring quoting its own declaration from standing in for the
 * declaration.
 */
const stripBlockComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '')

/** An array with at least one quoted entry. `dependencies: []` does not match. */
const DECLARES_DEPENDENCY = /\bdependencies\s*:\s*\[\s*['"]/

/**
 * Quoted string literals ending in `.json`.
 *
 * Template literals are out of reach by construction and that is the ceiling:
 * a handler building `` `${manifest.name}.last.json` `` is invisible here. It
 * is the own-state form, which is exempt anyway, so the miss is on the side
 * that costs nothing; a foreign path would have to be interpolated to hide,
 * and no example does that. Widen to backticks if one ever does.
 */
const JSON_LITERAL = /(['"])([^'"\n]*\.json)\1/g

/**
 * `<plugin>/handler.ts: <literal>` for every JSON path literal in a handler
 * whose manifest declares at least one dependency and which does not name the
 * plugin's own directory. A directory missing either file is skipped, not an
 * offender.
 */
export function offenders(root: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    let manifest: string
    let handler: string
    try {
      manifest = readFileSync(join(root, entry.name, 'manifest.ts'), 'utf8')
      handler = readFileSync(join(root, entry.name, 'handler.ts'), 'utf8')
    } catch {
      continue
    }
    if (!DECLARES_DEPENDENCY.test(stripBlockComments(manifest))) continue
    let match: RegExpExecArray | null
    const re = new RegExp(JSON_LITERAL)
    while ((match = re.exec(handler)) !== null) {
      const literal = match[2]!
      // The own-name exemption: a path derived from the plugin's own manifest
      // name is its own prior state, which the authoring guide sanctions.
      if (!literal.includes(entry.name)) out.push(`${entry.name}/handler.ts: ${literal}`)
    }
  }
  return out.sort()
}

describe('no example reaches past the dependency member for a path', () => {
  test('the guard names a planted handler that computes a path to a dependency Output', () => {
    const root = mkdtempSync(join(tmpdir(), 'warpline-deppath-'))
    try {
      // Declares a dependency AND computes a path to something that is not its
      // own: the exact pattern this phase tore out of two real examples.
      mkdirSync(join(root, 'planted'))
      writeFileSync(join(root, 'planted', 'manifest.ts'), "export const manifest = { dependencies: ['upstream'] }\n")
      writeFileSync(join(root, 'planted', 'handler.ts'), "const p = resolve(home, 'anomalies.json')\n")

      // Declares nothing, so it is not policed even with the identical literal:
      // an operator-configured input file has no producer to ask.
      mkdirSync(join(root, 'no-deps'))
      writeFileSync(join(root, 'no-deps', 'manifest.ts'), 'export const manifest = { dependencies: [] }\n')
      writeFileSync(join(root, 'no-deps', 'handler.ts'), "const p = resolve(home, 'anomalies.json')\n")

      // Declares a dependency and reads its OWN prior state, which the
      // authoring guide documents as the sanctioned pattern.
      mkdirSync(join(root, 'own-state'))
      writeFileSync(join(root, 'own-state', 'manifest.ts'), "export const manifest = { dependencies: ['upstream'] }\n")
      writeFileSync(join(root, 'own-state', 'handler.ts'), "const p = join(home, 'own-state.last.json')\n")

      mkdirSync(join(root, 'no-handler'))

      expect(offenders(root)).toEqual(['planted/handler.ts: anomalies.json'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('the real examples tree has no offender', () => {
    // Guarded against a wrong path: fewer directories than the tree is known
    // to hold is a mistaken root, not a shorter roster.
    expect(readdirSync(EXAMPLES).length).toBeGreaterThanOrEqual(12)
    expect(offenders(EXAMPLES)).toEqual([])
  })
})
