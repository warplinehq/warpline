/**
 * A citation of code in the docs names a symbol that exists, never a line.
 *
 * `docs/why-the-gate-holds.md` once cited `approval-gate.ts:261` as "the loop
 * that finds it". A gate amendment added thirteen lines above it, the number
 * pointed into another function's parameter list, and every test stayed green:
 * the voice test checks the register, and the claim sat outside its reach.
 *
 * So the docs cite code as `` `symbol` in `file.ts` `` and this file holds both
 * halves:
 * - no `file.ts:NN` or `file.md:NN` in `docs/*.md`, nor in a non-test source
 *   file under `src/`, the frozen gate included;
 * - every `` `symbol` in `file.ts` `` resolves to one file that declares that
 *   symbol. A file named by its base name must be the only one of that name.
 *
 * The fixture half shows each check red.
 */
import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative } from 'node:path'

const FIND = '/usr/bin/find'
const REPO_ROOT = join(import.meta.dir, '..', '..')
const LINE_CITATION = /\b[\w.-]+\.(?:ts|md):\d+/g
// `\s+`, not a space: a citation wrapped across a line break is still a citation.
const SYMBOL_CITATION = /`([A-Za-z_$][\w$]*)`\s+in\s+`([\w./-]+\.ts)`/g

function find(args: string[]): string[] {
  const files = execFileSync(FIND, args, { encoding: 'utf8' }).split('\n').filter(Boolean).sort()
  if (files.length === 0) throw new Error(`blind: find ${args.join(' ')} enumerated nothing`)
  return files
}

/** Every TypeScript file a citation can name: the tracked code roots, never a private snapshot or a build. */
const codeFiles = (roots: string[]): string[] =>
  find([...roots, '-name', '*.ts', '-not', '-path', '*/node_modules/*', '-not', '-path', '*/dist/*'])
const CODE_ROOTS = ['src', 'test-utils', 'examples', 'bench', 'scripts']
  .map((d) => join(REPO_ROOT, d))
  .filter((d) => existsSync(d))

/** `<file>: <citation>` for every line-number citation in `files`. */
function lineCitations(files: string[], root: string): string[] {
  return files.flatMap((file) =>
    [...readFileSync(file, 'utf-8').matchAll(LINE_CITATION)].map((m) => `${relative(root, file)}: ${m[0]}`),
  )
}

const declares = (source: string, symbol: string): boolean =>
  new RegExp(`(?:function\\*?\\s+|\\b(?:const|let|var|class|interface|type|enum)\\s+)${symbol.replace(/\$/g, '\\$')}\\b`).test(
    source,
  )

/** `<doc>: \`symbol\` in \`file\`: why` for every symbol citation that does not resolve. */
function unresolved(docs: string[], candidates: string[], root: string): string[] {
  const out: string[] = []
  for (const doc of docs) {
    for (const m of readFileSync(doc, 'utf-8').matchAll(SYMBOL_CITATION)) {
      const [, symbol, cited] = m as unknown as [string, string, string]
      const where = `${relative(root, doc)}: \`${symbol}\` in \`${cited}\``
      const matches = cited.includes('/')
        ? [join(root, cited)].filter((f) => existsSync(f))
        : candidates.filter((f) => basename(f) === cited)
      if (matches.length !== 1) out.push(`${where}: ${matches.length} files match`)
      else if (!declares(readFileSync(matches[0]!, 'utf-8'), symbol)) out.push(`${where}: no such declaration`)
    }
  }
  return out
}

const docs = (): string[] => find([join(REPO_ROOT, 'docs'), '-maxdepth', '1', '-name', '*.md'])

describe('docs cite code by symbol', () => {
  test('no line-number citation in docs or in non-test source', () => {
    const source = find([join(REPO_ROOT, 'src'), '-name', '*.ts', '-not', '-path', '*__tests__*', '-not', '-name', '*.test.ts'])
    expect([...lineCitations(docs(), REPO_ROOT), ...lineCitations(source, REPO_ROOT)]).toEqual([])
  })

  test('every `symbol` in `file.ts` citation names a file that declares it', () => {
    const cited = docs().flatMap((d) => [...readFileSync(d, 'utf-8').matchAll(SYMBOL_CITATION)])
    // The gate essay alone cites a dozen: a scan that matched none would prove nothing.
    expect(cited.length).toBeGreaterThan(10)
    expect(unresolved(docs(), codeFiles(CODE_ROOTS), REPO_ROOT)).toEqual([])
  })

  test('the checks report a line citation, a missing symbol, a missing file and an ambiguous name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'warpline-doc-citations-'))
    try {
      writeFileSync(join(dir, 'real.ts'), 'export function present() {}\nconst other = 1\n')
      writeFileSync(join(dir, 'twin.ts'), 'export const a = 1\n')
      execFileSync('mkdir', [join(dir, 'sub')])
      writeFileSync(join(dir, 'sub', 'twin.ts'), 'export const a = 1\n')
      const doc = join(dir, 'doc.md')
      writeFileSync(
        doc,
        [
          'See `present` in `real.ts` and `other` in\n`real.ts`.',
          'The loop is at approval-gate.ts:261, and the spec at runtime-spec.md:1355.',
          'Gone: `absent` in\n`real.ts`. Nowhere: `x` in `missing.ts`. Twice: `a` in `twin.ts`.',
        ].join('\n'),
      )
      expect(lineCitations([doc], dir)).toEqual(['doc.md: approval-gate.ts:261', 'doc.md: runtime-spec.md:1355'])
      expect(unresolved([doc], codeFiles([dir]), dir)).toEqual([
        'doc.md: `absent` in `real.ts`: no such declaration',
        'doc.md: `x` in `missing.ts`: 0 files match',
        'doc.md: `a` in `twin.ts`: 2 files match',
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
