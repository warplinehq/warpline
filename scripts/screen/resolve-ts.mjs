/**
 * Resolve hook: let Node load bun-style extensionless relative imports.
 *
 * A plugin manifest written for bun says `from '../../schemas/plugin-manifest'`.
 * Node ESM requires the extension, so without this hook Node cannot load 22 of
 * the 25 manifests in the roster this screen exists to check — and a screen
 * that cannot load its subject is not a screen.
 *
 * Node matters because `node --permission` is the only fs trap in either
 * runtime that lives BELOW JavaScript. A monkeypatch can be missed by an import
 * form the patch did not anticipate; the permission model cannot, because the
 * check is in the runtime rather than in a function the manifest could bypass.
 *
 * Deliberately narrow: it appends `.ts` (then `/index.ts`) ONLY after normal
 * resolution has already failed with ERR_MODULE_NOT_FOUND. It never shadows a
 * specifier Node could resolve on its own, so it cannot change which module a
 * manifest gets — only whether it gets one at all.
 */
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (err) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err
    // Only relative/absolute specifiers. A bare specifier that failed is a
    // genuinely missing package, and appending `.ts` to it would invent one.
    if (!specifier.startsWith('.') && !specifier.startsWith('/')) throw err
    for (const suffix of ['.ts', '/index.ts', '.mts']) {
      try {
        return await nextResolve(specifier + suffix, context)
      } catch {
        // try the next shape
      }
    }
    throw err
  }
}
