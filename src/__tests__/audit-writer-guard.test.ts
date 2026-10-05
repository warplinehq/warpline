/**
 * Only the store's own module names the audit directory, and that module
 * reaches nothing in the runtime or the board.
 *
 * The audit store has one writer, `src/lib/audit-log.ts`. It keeps the
 * directory name private and takes the state file path from its callers, so
 * no other module ever needs to spell `audit` as a path. A module that does is
 * a second writer in the making, and this reddens on it.
 *
 * **What a path to the store looks like.** A `join(` or `resolve(` call with a
 * quoted `audit` anywhere after it on the line, or a quoted path that runs through
 * `/audit/` or ends in `/audit`. The dispatcher's `case 'audit':` and its
 * `import('./audit.js')` name the verb, not the directory, and stay green.
 * Lines whose text starts with `*` or `//` are dropped first.
 *
 * **What the store may import.** `node:*`, `zod` and `../schemas/run-log.js`,
 * nothing else. The approval gate lives in the runtime, and a store that could
 * reach it would make this a graph walk instead of a line scan. The specifier
 * regex is the one the schema-module guard uses, so all four import forms are
 * seen: static, type-only, dynamic and re-export. The store also never names
 * the home accessor, since its callers hand it the path.
 */
import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const FIND = '/usr/bin/find'
const STORE = 'src/lib/audit-log.ts'

const COMMENT = /^\s*(\*|\/\/)/
// The rest of the line, not `[^)]*`: an argument that is itself a call, like
// `warplineHome()` or `dirname(dirname(p))`, closes a paren before `'audit'`.
const JOINS_AUDIT = /\b(join|resolve)\(.*['"`]audit['"`]/
const AUDIT_PATH = /['"`][^'"`]*\/audit(\/[^'"`]*)?['"`]/
const SPECIFIER =
  /(?<![.\w])(?:(?:from|import)\s*["']|(?:import|require)\s*\(\s*["'`])([^"'`\n]+)["'`]/g
const ALLOWED_SPECIFIER = /^(node:[a-z/_]+|zod|\.\.\/schemas\/run-log\.js)$/

/** Every non-test `.ts` file under `src/` and `examples/`; empty throws. */
function sourceFiles(): string[] {
  const out = execFileSync(
    FIND,
    [
      join(REPO_ROOT, 'src'),
      join(REPO_ROOT, 'examples'),
      '-name',
      '*.ts',
      '-not',
      '-path',
      '*__tests__*',
      '-not',
      '-name',
      '*.test.ts',
    ],
    { encoding: 'utf8' },
  )
  const files = out.split('\n').filter(Boolean)
  if (files.length === 0) throw new Error('blind: no non-test source file enumerated under src or examples')
  return files
}

const codeLines = (source: string): Array<[number, string]> =>
  source
    .split('\n')
    .map((text, i): [number, string] => [i + 1, text])
    .filter(([, text]) => !COMMENT.test(text))

/** `<file>:<line>: <text>` for every code line outside the store that names the store's directory. */
function writerOffenders(files: string[], root: string): string[] {
  const out: string[] = []
  for (const file of files) {
    const rel = file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file
    if (rel === STORE) continue
    for (const [n, text] of codeLines(readFileSync(file, 'utf8'))) {
      if (JOINS_AUDIT.test(text) || AUDIT_PATH.test(text)) out.push(`${rel}:${n}: ${text.trim()}`)
    }
  }
  return out
}

/** Every import specifier in `source` the store may not use. */
function importOffenders(source: string): string[] {
  return [...source.matchAll(SPECIFIER)].map((m) => m[1] as string).filter((s) => !ALLOWED_SPECIFIER.test(s))
}

/** Code lines in `source` that name the home accessor. */
function accessorLines(source: string): string[] {
  return codeLines(source)
    .filter(([, text]) => /\bwarplineHome\b/.test(text))
    .map(([n, text]) => `${n}: ${text.trim()}`)
}

function fixture(files: Record<string, string>): { dir: string; paths: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'warpline-audit-writer-'))
  const paths = Object.entries(files).map(([name, body]) => {
    const p = join(dir, name)
    writeFileSync(p, body)
    return p
  })
  return { dir, paths }
}

describe('only the store writes the store', () => {
  test('no shipped file but the store names the audit directory', () => {
    expect(writerOffenders(sourceFiles(), REPO_ROOT)).toEqual([])
  })

  test('the enumeration reaches the store, the dispatcher and the examples', () => {
    const enumerated = sourceFiles().map((f) => f.slice(REPO_ROOT.length + 1))
    expect(enumerated).toContain(STORE)
    expect(enumerated).toContain('src/cli/warpline.ts')
    expect(enumerated.some((f) => f.startsWith('examples/'))).toBe(true)
  })

  test('a join to the directory and a quoted path through it are each reported', () => {
    const { dir, paths } = fixture({
      'joins.ts': "const d = join(home, 'audit')\n",
      'nested.ts': "const a = join(warplineHome(), 'audit')\nconst b = resolve(dirname(dirname(p)), 'audit')\n",
      'quoted.ts': 'await writeFile(`${home}/audit/x`, \'\')\n',
    })
    try {
      expect(writerOffenders(paths, dir)).toEqual([
        "joins.ts:1: const d = join(home, 'audit')",
        "nested.ts:1: const a = join(warplineHome(), 'audit')",
        "nested.ts:2: const b = resolve(dirname(dirname(p)), 'audit')",
        "quoted.ts:1: await writeFile(`${home}/audit/x`, '')",
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("the dispatcher's verb arm is not a path to the store", () => {
    const { dir, paths } = fixture({
      'dispatch.ts': "switch (verb) {\n  case 'audit': {\n    const { run } = await import('./audit.js')\n  }\n}\n",
    })
    try {
      expect(writerOffenders(paths, dir)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the store reaches nothing in the runtime or the board', () => {
  test('the real store imports only node, zod and the run-log schema, and never names the home accessor', () => {
    const source = readFileSync(join(REPO_ROOT, STORE), 'utf8')
    expect(importOffenders(source)).toEqual([])
    expect(accessorLines(source)).toEqual([])
  })

  test('the approval gate named in each of the four import forms is caught four times', () => {
    const source = [
      "import { checkApproval } from '../runtime/approval-gate.js'",
      "import type { X } from '../runtime/approval-gate.js'",
      "const g = await import('../runtime/approval-gate.js')",
      "export { y } from '../runtime/approval-gate.js'",
    ].join('\n')
    expect(importOffenders(source)).toEqual(Array(4).fill('../runtime/approval-gate.js'))
  })

  test('a code line naming the home accessor is reported, a comment naming it is not', () => {
    expect(accessorLines("// warplineHome is not read here\nconst h = warplineHome()\n")).toEqual([
      '2: const h = warplineHome()',
    ])
  })
})
