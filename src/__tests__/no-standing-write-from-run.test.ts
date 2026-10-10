/**
 * Nothing a run reaches writes the standing grants file.
 *
 * A standing grant is authority a human issued for a machine principal. If code
 * a run reaches could write the file that holds it, a run could grant itself
 * the authority it is checked against. So every module reachable from
 * `warpline advance` and `warpline run` is scanned for any mention of a standing
 * writer, or of the accessor that names the file: a call, an aliased import, a
 * destructure, a held reference or a quoted bracket key. The gate module that defines
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
 * module spells the file's name. A name built from pieces at run time, such as
 * `'standing-' + 'grants.json'` or a computed key, is beyond a static scan; the
 * backstop below, a store byte- and mtime-identical across a real advance, is
 * what covers it.
 *
 * Every enumeration throws or asserts a size rather than returning empty.
 * "Could not look" is not "looked and it was fine". The scanners are pure over
 * a root, so the same code runs against the real tree and against temp
 * fixtures built to fail.
 */
import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import * as paths from '../lib/paths.js'
import * as gate from '../runtime/approval-gate.js'
import { runAdvance } from '../runtime/engine.js'
import { loadRegistry } from '../lib/principals.js'

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
// side-effect `import '…'` too, under any of the three quotes. A template
// specifier with an interpolation resolves to no file, so the walk throws on it
// rather than skipping a subtree.
const RELATIVE_EDGE = /(?:from|import)\s*\(?\s*(['"`])(\.[^'"`]+)\1/g

/** Every file reachable from `entry` by relative import, with its source. */
async function walk(entry: string): Promise<Map<string, string>> {
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

const codeLines = (source: string): Array<[number, string]> =>
  source
    .split('\n')
    .map((text, i): [number, string] => [i + 1, text])
    .filter(([, text]) => !COMMENT.test(text))

// Any mention, not only a call: an aliased import, a destructure, a reference
// held for later and a quoted bracket key all spell the name somewhere.
const MENTIONS = FORBIDDEN.map((name) => new RegExp(`\\b${name}\\b`))

/** `<path>:<line>: <text>` for every code line in the closure that names a forbidden export. */
function offenders(closure: ReadonlyMap<string, string>, root: string): string[] {
  const out: string[] = []
  for (const [file, source] of closure) {
    if (file.endsWith(DEFINER)) continue
    for (const [n, text] of codeLines(source)) {
      if (file.endsWith(PATHS_MODULE) && DECLARATION.test(text)) continue
      if (MENTIONS.some((re) => re.test(text))) out.push(`${relative(root, file)}:${n}: ${text.trim()}`)
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

  // Each shape reaches a writer without spelling `writeStandingStore(` on one
  // line, or hides its module behind an import the single-quote walk skipped.
  test('the scanner reports an aliased import, a reference, a bracket access, and modules behind double-quoted and template imports', async () => {
    const dir = fixture({
      'root.ts': [
        "import { a } from './alias.js'",
        "import { r } from './ref.js'",
        "import { k } from './bracket.js'",
        "import { s } from './destructure.js'",
        'import { q } from "./double.js"',
        'export async function root(): Promise<void> {',
        '  await import(`./template.js`)',
        '  a(); r(); k(); s(); q()',
        '}',
        '',
      ].join('\n'),
      'alias.ts': "import { writeStandingStore as persist } from './gate.js'\nexport const a = () => persist(x)\n",
      'ref.ts': "import * as g from './gate.js'\nconst w = g.writeStandingStore\nexport const r = () => w(x)\n",
      'bracket.ts': "import * as g from './gate.js'\nexport const k = () => g['writeStandingStore'](x)\n",
      'destructure.ts': "import * as g from './gate.js'\nconst { writeStandingStore: w } = g\nexport const s = () => w(x)\n",
      'double.ts': 'export const q = () => writeStandingStore(x)\n',
      'template.ts': 'export const t = standingGrantsPath()\n',
      'gate.ts': 'export const nothing = 1\n',
    })
    try {
      const found = offenders(await walk(join(dir, 'root.ts')), dir)
      expect([...new Set(found.map((line) => line.split(':')[0]))].sort()).toEqual(
        ['alias.ts', 'bracket.ts', 'destructure.ts', 'double.ts', 'ref.ts', 'template.ts'],
      )
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

describe('backstop', () => {
  test('a full advance that fires under a standing grant leaves the store byte- and mtime-identical', async () => {
    const home = mkdtempSync(join(tmpdir(), 'warpline-standing-backstop-'))
    paths._setHome(home)
    try {
      const stateDir = join(home, 'state')
      const runsDir = join(home, 'runs')
      mkdirSync(stateDir, { recursive: true })
      mkdirSync(runsDir, { recursive: true })
      const manifest = {
        name: 'p',
        version: '1.0.0',
        description: 'p fixture plugin',
        inputs: {},
        outputs: {},
        capabilities: [],
        secrets: [],
        schedule: 'on_run',
        autonomy_level: 'autonomous',
        approval_class: 'session',
        llm_handoff: false,
        side_effects: ['sends_email'],
        ttl_hours: 24,
        dependencies: [],
        timeout_ms: 5000,
        max_parallelism: 1,
        min_tier: 'normal',
        max_retries: 1,
        retry_delay_ms: 2000,
      }
      const pluginDir = join(home, 'plugins', 'p')
      mkdirSync(pluginDir, { recursive: true })
      writeFileSync(join(pluginDir, 'manifest.ts'), `export const manifest = ${JSON.stringify(manifest)}`)
      writeFileSync(
        join(pluginDir, 'handler.ts'),
        "export async function handler() {\n  return { status: 'success', phases_completed: [], phases_failed: [], " +
          "errors: [], data_freshness: {}, summary: 'fixture ok', artifacts_produced: [], schema_version: 1 }\n}\n",
      )
      writeFileSync(join(stateDir, 'preferences.json'), JSON.stringify({ review_gate: false }))
      writeFileSync(
        join(home, 'principals.json'),
        JSON.stringify({
          principals: [
            { id: 'ops', type: 'human', status: 'active' },
            { id: 'ci', type: 'machine', status: 'active' },
          ],
        }),
      )
      await loadRegistry(join(stateDir, 'engine-state.json'))

      const now = Date.now()
      const issued = gate.issueStanding(
        { min_reader_version: gate.STANDING_READER_VERSION, grants: [] },
        { id: gate.newStandingId(), holder: 'ci', issuer: 'ops', scopes: ['p'], hardMaxMs: 30 * 24 * 60 * 60 * 1000 },
        now - 60 * 60 * 1000,
      )
      if ('refused' in issued) throw new Error(`issue refused: ${issued.refused.code}`)
      await gate.writeStandingStore(issued.store)
      const storePath = join(home, 'standing-grants.json')
      const before = readFileSync(storePath)
      const beforeMtime = statSync(storePath).mtimeMs

      const result = await runAdvance({
        pluginsDir: join(home, 'plugins'),
        stateDir: join(stateDir, 'engine-state.json'),
        runsDir,
        eventsPath: join(runsDir, 'events.jsonl'),
        preferencesPath: join(stateDir, 'preferences.json'),
        now,
      })

      // The grant actually fired the plugin, or the identity below is vacuous.
      expect(result.plugin_states.get('p')).toBe('completed')
      expect(readFileSync(storePath).equals(before)).toBe(true)
      expect(statSync(storePath).mtimeMs).toBe(beforeMtime)
    } finally {
      paths._setHome(null)
      rmSync(home, { recursive: true, force: true })
    }
  })
})
