/**
 * The one import walker and the one comment rule the source guards share.
 *
 * Two guards carried their own copy of the walker, and their comment rules had
 * already drifted: one skipped every line that starts with `/*`, so
 * `/* note *\/ mergeGrant(s)` passed it. A fix to a copy is a fix to one guard,
 * so there is one copy, here.
 *
 * The walker follows relative edges in every shape that names a module:
 * `from '…'`, `import('…')`, the bare side-effect `import '…'`, and
 * `require('…')`, under any of the three quotes. A template specifier with an
 * interpolation resolves to no file, so the walk throws on it rather than
 * skipping a subtree. "Could not look" never reads as "looked and it was fine".
 */
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

/** A relative module edge: the quote, then the specifier. */
export const RELATIVE_EDGE = /(?:from|import|require)\s*\(?\s*(['"`])(\.[^'"`]+)\1/g

/** Every file reachable from `entry` by relative import, with its source. A `.js` specifier is read as its `.ts`. */
export async function walkImports(entry: string): Promise<Map<string, string>> {
  const seen = new Map<string, string>()
  async function visit(file: string): Promise<void> {
    if (seen.has(file)) return
    const source = await readFile(file, 'utf-8')
    seen.set(file, source)
    for (const m of source.matchAll(RELATIVE_EDGE)) {
      await visit(resolve(dirname(file), (m[2] as string).replace(/\.js$/, '.ts')))
    }
  }
  await visit(entry)
  return seen
}

/**
 * The code a line carries once the comments it starts with are taken off, or
 * '' when it is all comment. A line starting with `//` is all comment. One
 * starting with `/*`, or with the `*` of a doc comment, is comment up to its
 * `*\/`, and whatever follows that is code and is scanned. A trailing comment
 * after code is kept: it can only make a scan stricter.
 */
export function codeOf(line: string): string {
  let rest = line.trimStart()
  for (;;) {
    if (rest.startsWith('//')) return ''
    if (!rest.startsWith('*') && !rest.startsWith('/*')) return rest
    const end = rest.indexOf('*/', rest.startsWith('/*') ? 2 : 0)
    if (end === -1) return ''
    rest = rest.slice(end + 2).trimStart()
  }
}

/** Each line that carries code, as its 1-based number and that code. */
export function codeLines(source: string): Array<[number, string]> {
  const out: Array<[number, string]> = []
  source.split('\n').forEach((text, i) => {
    const code = codeOf(text)
    if (code !== '') out.push([i + 1, code])
  })
  return out
}
