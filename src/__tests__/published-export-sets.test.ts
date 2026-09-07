/**
 * The two unstable barrels export exactly what they say they do, checked on
 * every push rather than only at release.
 *
 * Both barrels rest their promise on the exact-set assertions in
 * `scripts/verify-tarball.sh`, and that script is invoked from exactly one
 * place: `.github/workflows/release.yml`, on a PUBLISHED GitHub Release. CI
 * never reads either export set. So the guard sat off the landing path, which
 * is this repository's recurring failure mode — a check that ran green because
 * the thing it catches was outside its reach.
 *
 * For `unstable-capabilities` the hole was total. Every example handler imports
 * that specifier with `import type` and nothing else, so the import is erased
 * and no job ever performs a runtime import of `dist/unstable-capabilities.js`;
 * `tsc --noEmit` cannot see a value leak either. Adding
 * `export { mintContext }` to a barrel whose entire promise is that it carries
 * no runtime value would type-check, pass the suite, merge, and first redden
 * partway through a release job that has already cut the tag — where rule 4
 * makes the correction an `npm deprecate` plus a patch version, because a
 * published version number is permanent.
 *
 * Bare specifiers deliberately: these resolve through `package.json`'s
 * `exports` map into `dist/`, which is the path a stranger with the tarball
 * takes. Importing `../unstable-result.js` would check the source module and
 * prove nothing about what the map publishes.
 *
 * The release script's copies stay. A second assertion on the landing path is
 * the entire point, and these two are edited together with it.
 */
import { expect, test } from 'bun:test'

const EXPECTED: ReadonlyArray<readonly [string, string]> = [
  ['warpline/unstable-result', 'skillFailure,skillHandoff,skillOk'],
  // Type-only: an EMPTY set is the assertion. Types leave no trace in a
  // `dist/*.js` file, so anything this import can see is by definition a value
  // that should not be there.
  ['warpline/unstable-capabilities', ''],
]

for (const [specifier, expected] of EXPECTED) {
  test(`${specifier} exports exactly [${expected}]`, async () => {
    const ns: Record<string, unknown> = await import(specifier)
    const names = Object.keys(ns)
      .filter((k) => k !== 'default')
      .sort()
      .join(',')
    expect(names).toBe(expected)
  })
}
