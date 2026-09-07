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
 *   member to deliver. `feed-triage`, `derived-summary` and `metrics-rollup`
 *   read such files, and they resemble the first case only in mechanism. Asking
 *   the member for them would throw, because they declare no dependencies at
 *   all; making them not throw would mean inventing declarations that change
 *   level ordering for three more examples.
 *
 * "The manifest declares a non-empty `dependencies` array" is what mechanizes
 * that distinction, and it is stated here so a later reader does not widen the
 * predicate and take those three examples with it. A general "no home-relative
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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * `<plugin>/handler.ts: <literal>` for every JSON path literal in a handler
 * whose manifest declares at least one dependency and which does not name the
 * plugin's own directory.
 */
export function offenders(_root: string): string[] {
  return []
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
})
