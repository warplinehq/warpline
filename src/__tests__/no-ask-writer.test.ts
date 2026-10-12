/**
 * Ask raise and delivery code reaches no writer of a grant, an approval or the
 * state document.
 *
 * An Ask asks a human. If the code that raises or delivers one could write the
 * session approval file, the standing grants file, a content approval or the
 * state document, it could grant the very thing it asks about. So every module
 * reachable from the Ask store and from the `notify` runner is scanned for any
 * mention of those writers or of the accessors that name their files: a call,
 * an aliased import, a destructure, a held reference or a quoted bracket key.
 * Unlike the standing-grant census this one exempts nothing. The Ask modules
 * take every path they need as an argument, so they reach neither the gate
 * module nor the paths module, and no file under `src/runtime/` or
 * `src/board/` may appear in either closure at all.
 *
 * **Reach.** This census sees the Ask modules only. The engine glue that calls
 * them legitimately names the state writer, so it cannot be a root here. The
 * behavioural case in `src/runtime/__tests__/asks-advance.test.ts` covers it:
 * across raise, reminder, expiry and supersede advances, every grant and
 * approval file stays byte-identical.
 *
 * The walker is the one in `test-utils/import-walk.ts`, with its comment rule:
 * a line is skipped only when all of it is comment. Every enumeration asserts a
 * size or a positive control rather than returning empty. "Could not look" is
 * not "looked and it was fine". The scanners are pure over a root, so the same
 * code runs against the real tree and against temp fixtures built to fail.
 */
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import * as paths from '../lib/paths.js'
import * as gate from '../runtime/approval-gate.js'
import * as stateStore from '../runtime/engine-state-store.js'
import * as engine from '../runtime/engine.js'
import { codeLines, walkImports as walk } from '../../test-utils/import-walk.js'

const SRC = join(import.meta.dir, '..')

const ROOTS = ['lib/asks.ts', 'lib/notify.ts']
const FORBIDDEN = [
  'mergeGrant',
  'grantApproval',
  'revokeApproval',
  'sessionApprovalPath',
  'issueStanding',
  'renewStanding',
  'revokeStanding',
  'writeStandingStore',
  'standingGrantsPath',
  'writeEngineState',
  'applyPendingGate',
]
const LAYERS = ['runtime', 'board']

// Any mention, not only a call: an aliased import, a destructure, a reference
// held for later and a quoted bracket key all spell the name somewhere.
const MENTIONS = FORBIDDEN.map((name) => new RegExp(`\\b${name}\\b`))

/** `<path>:<line>: <text>` for every code line in the closure that names a forbidden export. */
function offenders(closure: ReadonlyMap<string, string>, root: string): string[] {
  const out: string[] = []
  for (const [file, source] of closure) {
    for (const [n, text] of codeLines(source)) {
      if (MENTIONS.some((re) => re.test(text))) out.push(`${relative(root, file)}:${n}: ${text.trim()}`)
    }
  }
  return out
}

/** Every closure file, relative to `root`, that sits under a `runtime/` or `board/` directory. */
function layerOffenders(closure: ReadonlyMap<string, string>, root: string): string[] {
  return [...closure.keys()]
    .map((file) => relative(root, file))
    .filter((rel) => rel.split(sep).slice(0, -1).some((part) => LAYERS.includes(part)))
}

const has = (closure: ReadonlyMap<string, string>, tail: string): boolean =>
  [...closure.keys()].some((f) => f.endsWith(join(SRC, tail)))

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'warpline-ask-writer-guard-'))
  for (const [name, body] of Object.entries(files)) {
    const p = join(dir, name)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, body)
  }
  return dir
}

describe('Ask raise and delivery code reaches no authority writer', () => {
  test('the Ask modules reach no writer of a grant, an approval or the state document', async () => {
    for (const root of ROOTS) {
      const closure = await walk(join(SRC, root))
      expect(offenders(closure, SRC)).toEqual([])
      expect(layerOffenders(closure, SRC)).toEqual([])
    }

    // Positive controls: the store module reaches the audit store and the
    // atomic writer it is built on. The runner imports no relative module
    // today, so its closure is itself and a size floor above one would be wrong.
    const asks = await walk(join(SRC, 'lib/asks.ts'))
    expect(asks.size).toBeGreaterThan(3)
    expect(has(asks, 'lib/audit-log.ts')).toBe(true)
    expect(has(asks, 'lib/fs-atomic.ts')).toBe(true)
    const notify = await walk(join(SRC, 'lib/notify.ts'))
    expect(has(notify, 'lib/notify.ts')).toBe(true)
  })

  test('every forbidden name is a live export', () => {
    const modules: Record<string, Record<string, unknown>> = {
      sessionApprovalPath: paths,
      standingGrantsPath: paths,
      writeEngineState: stateStore,
      applyPendingGate: engine,
    }
    const lookup = (name: string): unknown => (modules[name] ?? (gate as Record<string, unknown>))[name]
    expect(FORBIDDEN).toHaveLength(11)
    expect(FORBIDDEN.filter((name) => typeof lookup(name) !== 'function')).toEqual([])
  })

  test('the Ask module never reaches the notify runner', async () => {
    const asks = await walk(join(SRC, 'lib/asks.ts'))
    expect(has(asks, 'lib/audit-log.ts')).toBe(true)
    expect(has(asks, 'lib/notify.ts')).toBe(false)
  })

  test('warpline run reaches neither Ask module', async () => {
    const run = await walk(join(SRC, 'cli/run-plugin.ts'))
    expect(has(run, 'lib/preferences.ts')).toBe(true)
    expect(has(run, 'lib/asks.ts')).toBe(false)
    expect(has(run, 'lib/notify.ts')).toBe(false)
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
      'b.ts': 'export const b = () => mergeGrant(s)\n',
      'c.ts': 'export const c = () => writeEngineState(s, p)\n',
      'd.ts': '// writeEngineState( is named here in a comment only\nexport const d = () => 1\n',
    })
    try {
      const found = offenders(await walk(join(dir, 'root.ts')), dir)
      expect(found.map((line) => line.split(':')[0])).toEqual(['b.ts', 'c.ts'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Each shape reaches a writer without spelling its call on one line.
  test('the scanner reports an aliased import, a bracket access, a destructure and code after a block comment', async () => {
    const dir = fixture({
      'root.ts': [
        "import { a } from './alias.js'",
        "import { k } from './bracket.js'",
        "import { s } from './destructure.js'",
        "import { b } from './block.js'",
        'export function root(): void {',
        '  a(); k(); s(); b()',
        '}',
        '',
      ].join('\n'),
      'alias.ts': "import { applyPendingGate as settle } from './engine.js'\nexport const a = () => settle(x)\n",
      'bracket.ts': "import * as p from './paths.js'\nexport const k = () => p['sessionApprovalPath']()\n",
      'destructure.ts': "import * as g from './gate.js'\nconst { writeStandingStore: w } = g\nexport const s = () => w(x)\n",
      'block.ts': '/* note */ export const b = () => grantApproval(x)\n/* revokeApproval( in a comment only */\n',
      'engine.ts': 'export const nothing = 1\n',
      'paths.ts': 'export const nothing = 1\n',
      'gate.ts': 'export const nothing = 1\n',
    })
    try {
      const found = offenders(await walk(join(dir, 'root.ts')), dir)
      expect(found.filter((line) => line.startsWith('block.ts:'))).toEqual(['block.ts:1: export const b = () => grantApproval(x)'])
      expect([...new Set(found.map((line) => line.split(':')[0]))].sort()).toEqual(
        ['alias.ts', 'block.ts', 'bracket.ts', 'destructure.ts'],
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the layer scan reports a file under a runtime directory, and nothing else', async () => {
    const dir = fixture({
      'lib/root.ts': "import { r } from '../runtime/quiet.js'\nimport { o } from './other.js'\n",
      'runtime/quiet.ts': 'export const r = 1\n',
      'lib/other.ts': 'export const o = 1\n',
    })
    try {
      const closure = await walk(join(dir, 'lib/root.ts'))
      expect(offenders(closure, dir)).toEqual([])
      expect(layerOffenders(closure, dir)).toEqual([join('runtime', 'quiet.ts')])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
