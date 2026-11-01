/**
 * The engine reaches no model, and the consumer reaches no authority.
 *
 * `warpline advance` and `warpline run` must never call a model, a renderer or
 * the consumer: a Judgment is written by `warpline consume`, outside the
 * engine. So every module the two verbs reach is scanned for four routes:
 * a file under `src/consume/` or `src/cli/consume.ts`, a spawn or exec call
 * whose first argument is a literal naming `claude` (bare or as a path), a
 * spawn or exec line carrying a `consume` literal, and any `fetch(` call.
 *
 * The consumer, in turn, must not approve, deny, apply or grant. The closure
 * of `src/cli/consume.ts` is scanned for the gate, engine, state-store and
 * ask modules and the approve and deny verbs, and for any code line naming
 * a writer of authority outside the module that defines it. A third scan
 * holds that no consumer code line names the gate list, `pending_gates`.
 *
 * **Why a file graph.** The engine reaches the board events module only
 * through a dynamic import, so a walker that follows static imports alone
 * would miss a route hidden there. `test-utils/import-walk.ts` follows
 * `from`, `import(…)`, `require(…)` and the bare side-effect import, under
 * any quote, with the one comment rule every source guard shares.
 *
 * **What a static scan cannot see.** A name or a command built at run time:
 * `spawn(cmd)` where `cmd` holds `'claude'`, `Bun.spawn({ cmd: [...] })`,
 * `Bun.$` with an interpolated command, or `globalThis['fe' + 'tch']`. The
 * operator's own `notify` argv is spawned this way on purpose, so a
 * non-literal first argument is not an offender. The behaviour tests of the
 * consumer are the backstop for those shapes.
 *
 * Every enumeration asserts a size, since "could not look" is not "looked and
 * it was fine". The scanners are pure over a root, so the same code runs
 * against the real tree and against temp fixtures built to fail.
 */
import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import * as gate from '../runtime/approval-gate.js'
import * as engine from '../runtime/engine.js'
import * as stateStore from '../runtime/engine-state-store.js'
import * as asks from '../lib/asks.js'
import * as handoffs from '../lib/handoffs.js'
import { codeLines, walkImports as walk } from '../../test-utils/import-walk.js'

const SRC = join(import.meta.dir, '..')
const FIND = '/usr/bin/find'

const ENGINE_ROOTS = ['cli/advance.ts', 'cli/run-plugin.ts']
const CONSUME_ROOT = 'cli/consume.ts'

// A spawn or exec call, then its first argument (or the head of an argv array) as a literal naming claude.
const SPAWN_CALL = /\b(?:Bun\.spawn(?:Sync)?|spawn(?:Sync)?|execFile(?:Sync)?|execSync|exec)\s*\(/
const CLAUDE_LITERAL = new RegExp(`${SPAWN_CALL.source}\\s*\\[?\\s*(['"\`])(?:[^'"\`]*/)?claude\\1`)
const CONSUME_LITERAL = /(['"`])consume\1/
const FETCH = /\bfetch\s*\(/

/** True for a file the engine must never reach. */
const isConsumer = (rel: string): boolean => rel.startsWith('consume/') || rel === CONSUME_ROOT

/** One line per route: `<path>: reached` for a consumer file, `<path>:<line>: <code>` for a line rule. */
function engineOffenders(closure: ReadonlyMap<string, string>, srcRoot: string): string[] {
  const out: string[] = []
  for (const [file, source] of closure) {
    const rel = relative(srcRoot, file)
    if (isConsumer(rel)) {
      out.push(`${rel}: reached`)
      continue
    }
    for (const [n, text] of codeLines(source)) {
      const spawnsConsume = SPAWN_CALL.test(text) && CONSUME_LITERAL.test(text)
      if (CLAUDE_LITERAL.test(text) || spawnsConsume || FETCH.test(text)) out.push(`${rel}:${n}: ${text.trim()}`)
    }
  }
  return out
}

/** The modules a consumer must not reach: each holds or applies authority. */
const AUTHORITY_FILES = [
  'runtime/approval-gate.ts',
  'runtime/engine.ts',
  'runtime/engine-state-store.ts',
  'lib/asks.ts',
  'cli/approve.ts',
  'cli/deny.ts',
]

/** Each writer of authority, and the one module that defines it. */
const WRITERS: Record<string, string> = {
  grantApproval: 'runtime/approval-gate.ts',
  mergeGrant: 'runtime/approval-gate.ts',
  revokeApproval: 'runtime/approval-gate.ts',
  issueStanding: 'runtime/approval-gate.ts',
  renewStanding: 'runtime/approval-gate.ts',
  revokeStanding: 'runtime/approval-gate.ts',
  writeStandingStore: 'runtime/approval-gate.ts',
  applyPendingGate: 'runtime/engine.ts',
  writeEngineState: 'runtime/engine-state-store.ts',
  recordAnswer: 'lib/asks.ts',
  writeAsks: 'lib/asks.ts',
  withdrawHandoff: 'lib/handoffs.ts',
}

// Any mention, not only a call: an aliased import, a destructure or a held reference all spell the name.
const MENTIONS = Object.keys(WRITERS).map((name) => [name, new RegExp(`\\b${name}\\b`)] as const)

/** `<path>: reached` for an authority module, `<path>:<line>: <code>` for a writer named outside its definer. */
function authorityOffenders(closure: ReadonlyMap<string, string>, srcRoot: string): string[] {
  const out: string[] = []
  for (const [file, source] of closure) {
    const rel = relative(srcRoot, file)
    if (AUTHORITY_FILES.includes(rel)) out.push(`${rel}: reached`)
    for (const [n, text] of codeLines(source)) {
      if (MENTIONS.some(([name, re]) => re.test(text) && WRITERS[name] !== rel)) out.push(`${rel}:${n}: ${text.trim()}`)
    }
  }
  return out
}

/** `<path>:<line>: <code>` for every code line naming the gate list. */
function gateListOffenders(files: readonly string[], root: string): string[] {
  const out: string[] = []
  for (const file of files) {
    for (const [n, text] of codeLines(readFileSync(file, 'utf8'))) {
      if (text.includes('pending_gates')) out.push(`${relative(root, file)}:${n}: ${text.trim()}`)
    }
  }
  return out
}

/** Every non-test `.ts` file under `src/consume/`, plus the verb; too few throws. */
function consumerFiles(): string[] {
  const out = execFileSync(
    FIND,
    [join(SRC, 'consume'), '-name', '*.ts', '-not', '-path', '*__tests__*', '-not', '-name', '*.test.ts'],
    { encoding: 'utf8' },
  )
  const files = out.split('\n').filter(Boolean)
  if (files.length < 5) throw new Error(`blind: ${files.length} consumer source files enumerated under src/consume`)
  return [...files, join(SRC, CONSUME_ROOT)]
}

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'warpline-no-model-guard-'))
  for (const [name, body] of Object.entries(files)) {
    const p = join(dir, name)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, body)
  }
  return dir
}

/** The offenders of a temp tree holding `root.ts` with `body` and a benign `consume/pass.ts`. */
async function plantedEngine(body: string): Promise<string[]> {
  const dir = fixture({ 'root.ts': body, 'consume/pass.ts': 'export const pass = 1\n' })
  try {
    return engineOffenders(await walk(join(dir, 'root.ts')), dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('the engine reaches no model, renderer or consumer', () => {
  test('the advance and run closures carry no route', async () => {
    for (const root of ENGINE_ROOTS) {
      const closure = await walk(join(SRC, root))
      expect(closure.size).toBeGreaterThan(5)
      expect(engineOffenders(closure, SRC)).toEqual([])
    }
    // Positive controls: the walk reaches the engine, the board events behind
    // its dynamic import, and the operator-argv spawn that must stay green.
    const advance = [...(await walk(join(SRC, 'cli/advance.ts'))).keys()].map((f) => relative(SRC, f))
    for (const rel of ['runtime/engine.ts', 'board/engine-events.ts', 'lib/notify.ts']) {
      expect(advance).toContain(rel)
    }
  })

  test.each([
    ['a static import', "import { pass } from './consume/pass.js'\nexport const r = pass\n", ['consume/pass.ts: reached']],
    ['a dynamic import', "export async function r() {\n  await import('./consume/pass.js')\n}\n", ['consume/pass.ts: reached']],
    ['a require', "const p = require('./consume/pass.js')\nexport const r = p\n", ['consume/pass.ts: reached']],
    ['Bun.spawn of claude', "export const r = () => Bun.spawn(['claude', '-p'])\n", ["root.ts:1: export const r = () => Bun.spawn(['claude', '-p'])"]],
    [
      'node:child_process spawn of a claude path',
      "import { spawn } from 'node:child_process'\nexport const r = () => spawn('/usr/local/bin/claude', [])\n",
      ["root.ts:2: export const r = () => spawn('/usr/local/bin/claude', [])"],
    ],
    [
      'a spawn carrying a consume argv',
      "import { execFileSync } from 'node:child_process'\nexport const r = () => execFileSync('warpline', ['consume'])\n",
      ["root.ts:2: export const r = () => execFileSync('warpline', ['consume'])"],
    ],
    ['a fetch', "export const r = () => fetch('https://example.invalid')\n", ["root.ts:1: export const r = () => fetch('https://example.invalid')"]],
  ])('the scanner reports %s exactly once', async (_name, body, want) => {
    expect(await plantedEngine(body)).toEqual(want)
  })

  test('an operator argv spawn, a comment naming claude and a consume literal off a spawn line are not offenders', async () => {
    const body = [
      "import { spawn } from 'node:child_process'",
      'export function r(argv: string[]) {',
      '  // spawn(\'claude\', []) is named here in a comment only',
      "  const verb = 'consume'",
      '  return spawn(argv[0] as string, argv.slice(1))',
      '}',
      '',
    ].join('\n')
    expect(await plantedEngine(body)).toEqual([])
  })
})

describe('the consumer reaches no authority writer and never reads the gate list', () => {
  test('the consume closure reaches no authority module and names no writer outside its definer', async () => {
    const closure = await walk(join(SRC, CONSUME_ROOT))
    expect(closure.size).toBeGreaterThan(5)
    expect(authorityOffenders(closure, SRC)).toEqual([])
    // Positive control: the closure reaches the definer it skips, so the skip is exercised.
    const rels = [...closure.keys()].map((f) => relative(SRC, f))
    for (const rel of ['consume/pass.ts', 'consume/run-as.ts', 'lib/handoffs.ts']) expect(rels).toContain(rel)
  })

  test('every writer is a live export of the module named as its definer', () => {
    const modules: Record<string, Record<string, unknown>> = {
      'runtime/approval-gate.ts': gate,
      'runtime/engine.ts': engine,
      'runtime/engine-state-store.ts': stateStore,
      'lib/asks.ts': asks,
      'lib/handoffs.ts': handoffs,
    }
    const dead = Object.entries(WRITERS).filter(([name, definer]) => typeof modules[definer]?.[name] !== 'function')
    expect(dead).toEqual([])
  })

  test('the scanner reports a planted gate import, the gate it reaches, and a writer named outside its definer', async () => {
    const dir = fixture({
      'root.ts': [
        "import { issueStanding } from './runtime/approval-gate.js'",
        "import { w } from './other.js'",
        "import { h } from './lib/handoffs.js'",
        'export const r = () => [issueStanding, w, h]',
        '',
      ].join('\n'),
      'runtime/approval-gate.ts': 'export function issueStanding() {}\n',
      'other.ts': "import * as hs from './lib/handoffs.js'\nexport const w = () => hs.withdrawHandoff(x)\n",
      'lib/handoffs.ts': 'export async function withdrawHandoff() {}\nexport const h = 1\n',
    })
    try {
      expect(authorityOffenders(await walk(join(dir, 'root.ts')), dir).sort()).toEqual([
        "other.ts:2: export const w = () => hs.withdrawHandoff(x)",
        "root.ts:1: import { issueStanding } from './runtime/approval-gate.js'",
        'root.ts:4: export const r = () => [issueStanding, w, h]',
        'runtime/approval-gate.ts: reached',
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('no consumer code line names pending_gates', () => {
    expect(gateListOffenders(consumerFiles(), SRC)).toEqual([])
  })

  test('the gate-list scan reports a planted line and skips a comment', () => {
    const dir = fixture({
      'names.ts': 'export const g = (s: { pending_gates: string[] }) => s.pending_gates\n',
      'mentions.ts': '// pending_gates is named here in a comment only\nexport const m = 1\n',
    })
    try {
      expect(gateListOffenders([join(dir, 'names.ts'), join(dir, 'mentions.ts')], dir)).toEqual([
        'names.ts:1: export const g = (s: { pending_gates: string[] }) => s.pending_gates',
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
