/**
 * Nothing a run reaches writes the standing grants file.
 *
 * A standing grant is authority a human issued for a machine principal. If code
 * a run reaches could write the file that holds it, a run could grant itself
 * the authority it is checked against. So every module reachable from
 * `warpline advance` and `warpline run` is scanned for a call to any standing
 * writer, or to the accessor that names the file. The gate module that defines
 * the writers is skipped: being reachable is not the defect, being called is,
 * and the byte pin holds that module still. The accessor's own declaration in
 * the paths module is skipped for the same reason.
 *
 * **Why a file graph and not the AST walker.** The AST walk in
 * `no-approval-gate-from-content.test.ts` follows static imports only. The
 * advance closure reaches `board/engine-events.ts` only through the dynamic
 * import in `runtime/engine-state-store.ts`, so a writer hidden there would be
 * invisible to it. This walker follows `from '…'` and `import('…')` edges both,
 * the way test 14 in `src/cli/__tests__/deny.test.ts` does.
 *
 * A second scan is a plain line scan: no non-test source file but the paths
 * module spells the file's name, so a module cannot reach the file by building
 * the path itself.
 *
 * Every enumeration throws or asserts a size rather than returning empty.
 * "Could not look" is not "looked and it was fine". The scanners are pure over
 * a root, so the same code runs against the real tree and against temp
 * fixtures built to fail.
 */
import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import * as paths from '../lib/paths.js'
import * as gate from '../runtime/approval-gate.js'

const SRC = join(import.meta.dir, '..')
const REPO_ROOT = join(SRC, '..')
const FIND = '/usr/bin/find'

const ROOTS = ['cli/advance.ts', 'cli/run-plugin.ts']
const FORBIDDEN = ['issueStanding', 'renewStanding', 'revokeStanding', 'writeStandingStore', 'standingGrantsPath']
const DEFINER = join('runtime', 'approval-gate.ts')
const PATHS_MODULE = join('lib', 'paths.ts')
const DECLARATION = /function standingGrantsPath\s*\(/
const LITERAL = 'standing-grants'
const COMMENT = /^\s*(\*|\/\/)/

// Both edge shapes: `from '…'` and `import('…')`, the latter covering the bare
// side-effect `import '…'` too.
const RELATIVE_EDGE = /(?:from|import)\s*\(?\s*'(\.[^']+)'/g

/** Every file reachable from `entry` by relative import, with its source. */
async function walk(entry: string): Promise<Map<string, string>> {
  const seen = new Map<string, string>()
  async function visit(file: string): Promise<void> {
    if (seen.has(file)) return
    const source = await readFile(file, 'utf-8')
    seen.set(file, source)
    for (const m of source.matchAll(RELATIVE_EDGE)) {
      await visit(resolve(dirname(file), (m[1] as string).replace(/\.js$/, '.ts')))
    }
  }
  await visit(entry)
  return seen
}

const codeLines = (source: string): Array<[number, string]> =>
  source
    .split('\n')
    .map((text, i): [number, string] => [i + 1, text])
    .filter(([, text]) => !COMMENT.test(text))

const CALLS = FORBIDDEN.map((name) => new RegExp(`\\b${name}\\s*\\(`))

/** `<path>:<line>: <text>` for every code line in the closure that calls a forbidden name. */
function offenders(closure: ReadonlyMap<string, string>, root: string): string[] {
  const out: string[] = []
  for (const [file, source] of closure) {
    if (file.endsWith(DEFINER)) continue
    for (const [n, text] of codeLines(source)) {
      if (file.endsWith(PATHS_MODULE) && DECLARATION.test(text)) continue
      if (CALLS.some((re) => re.test(text))) out.push(`${relative(root, file)}:${n}: ${text.trim()}`)
    }
  }
  return out
}

/** `<path>:<line>: <text>` for every code line naming the store file outside `src/lib/paths.ts`. */
function literalOffenders(files: string[], root: string): string[] {
  const out: string[] = []
  for (const file of files) {
    const rel = relative(root, file)
    if (rel === join('src', 'lib', 'paths.ts')) continue
    for (const [n, text] of codeLines(readFileSync(file, 'utf8'))) {
      if (text.includes(LITERAL)) out.push(`${rel}:${n}: ${text.trim()}`)
    }
  }
  return out
}

/** Every non-test `.ts` file under `src/`; empty throws. */
function sourceFiles(): string[] {
  const out = execFileSync(
    FIND,
    [SRC, '-name', '*.ts', '-not', '-path', '*__tests__*', '-not', '-name', '*.test.ts'],
    { encoding: 'utf8' },
  )
  const files = out.split('\n').filter(Boolean)
  if (files.length === 0) throw new Error('blind: no non-test source file enumerated under src')
  return files
}

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'warpline-standing-guard-'))
  for (const [name, body] of Object.entries(files)) {
    const p = join(dir, name)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, body)
  }
  return dir
}

describe('nothing a run reaches writes the standing grants file', () => {
  test('the advance and run closures call no standing writer', async () => {
    for (const root of ROOTS) {
      const closure = await walk(join(SRC, root))
      expect(closure.size).toBeGreaterThan(5)
      expect(offenders(closure, SRC)).toEqual([])
    }

    // Positive controls on the advance root: the walk reaches the engine, the
    // state store, and the board events module behind the dynamic import, and
    // it reaches the definer and the paths module it skips.
    const advance = [...(await walk(join(SRC, 'cli/advance.ts'))).keys()]
    for (const tail of [
      join('runtime', 'engine.ts'),
      join('runtime', 'engine-state-store.ts'),
      join('board', 'engine-events.ts'),
      DEFINER,
      PATHS_MODULE,
    ]) {
      expect(advance.some((f) => f.endsWith(tail))).toBe(true)
    }
  })

  test('every forbidden name is a live export', () => {
    const lookup = (name: string): unknown =>
      name === 'standingGrantsPath'
        ? (paths as Record<string, unknown>)[name]
        : (gate as Record<string, unknown>)[name]
    expect(FORBIDDEN.filter((name) => typeof lookup(name) !== 'function')).toEqual([])
  })

  test('only the paths module names the store file', () => {
    expect(literalOffenders(sourceFiles(), REPO_ROOT)).toEqual([])
  })
})

describe('the scanners report what they are built to catch', () => {
  test('the scanner reports a writer two modules deep and one behind a dynamic import', async () => {
    const dir = fixture({
      'root.ts': [
        "import { a } from './a.js'",
        "import { d } from './d.js'",
        'export async function root(): Promise<void> {',
        "  await import('./c.js')",
        '  a(); d()',
        '}',
        '',
      ].join('\n'),
      'a.ts': "import { b } from './b.js'\nexport const a = () => b()\n",
      'b.ts': 'export const b = () => writeStandingStore(x)\n',
      'c.ts': 'export const c = standingGrantsPath()\n',
      'd.ts': '// writeStandingStore( is named here in a comment only\nexport const d = () => 1\n',
    })
    try {
      const found = offenders(await walk(join(dir, 'root.ts')), dir)
      expect(found.map((line) => line.split(':')[0])).toEqual(['b.ts', 'c.ts'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the declaration exemption covers only the paths module', async () => {
    const dir = fixture({
      'root.ts': "import { p } from './lib/paths.js'\nimport { o } from './lib/other.js'\n",
      'lib/paths.ts': 'export function standingGrantsPath(): string {\n  return p\n}\n',
      'lib/other.ts': 'export function standingGrantsPath(): string {\n  return o\n}\n',
    })
    try {
      const found = offenders(await walk(join(dir, 'root.ts')), dir)
      expect(found).toEqual([`${join('lib', 'other.ts')}:1: export function standingGrantsPath(): string {`])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the literal scan reports a file naming the store', () => {
    const dir = fixture({
      'names.ts': "const f = 'standing-grants.json'\n",
      'mentions.ts': '// the standing-grants.json file is named in a comment only\nexport const m = 1\n',
    })
    try {
      const found = literalOffenders([join(dir, 'names.ts'), join(dir, 'mentions.ts')], dir)
      expect(found).toEqual(["names.ts:1: const f = 'standing-grants.json'"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
