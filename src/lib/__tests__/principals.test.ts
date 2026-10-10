/**
 * principals — the one registry module, and the one check of who may act.
 *
 * Every verb that takes `--principal` or `--holder` asks `requirePrincipal`
 * under a rule: any active principal, an active human, an active machine, or
 * any registered principal at all. This file pins that table cell by cell,
 * the empty id, the byte-exact match, and the rule that no principal ever
 * comes from the environment or the account running the command.
 *
 * It also pins the two reads. `loadRegistry` records a hand edit before it
 * resolves and rejects when that record cannot be written. `readRegistry`
 * writes nothing at all.
 *
 * Every case gets its own home through `_setHome`, and everything this file
 * writes goes under temp dirs (AGENTS.md Rule 2).
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as audit from '../audit-log.js'
import { _setHome } from '../paths.js'
import * as principals from '../principals.js'

const SOURCE = join(import.meta.dir, '..', 'principals.ts')
const OBSERVED = 'warpline.audit.principal_registry.observed'
/** A key value. It may sit in principals.json and in no phrase or view. */
const KEY = 'WARPLINE_KEY_SENTINEL_7f3a'
/** principal.test.ts's OS-user pattern, unchanged. */
const OS_USER = /process\.env\.(USER|LOGNAME|USERNAME)|userInfo\(|os\.userInfo/

const RULES = ['active', 'active-human', 'active-machine', 'registered'] as const

const SEED = {
  principals: [
    { id: 'ops', type: 'human', status: 'active', key: KEY },
    { id: 'alice', type: 'human', status: 'disabled' },
    { id: 'ci', type: 'machine', status: 'active' },
    { id: 'bot', type: 'machine', status: 'disabled' },
  ],
}

let home: string
let statePath: string
let installed: ReturnType<typeof spyOn>[] = []
let temps: string[] = []

const file = (): string => join(home, 'principals.json')
const storeDir = (): string => join(home, 'audit')

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'warpline-principals-'))
  _setHome(home)
  statePath = join(home, 'state', 'engine-state.json')
})

afterEach(() => {
  for (const spy of installed) spy.mockRestore()
  installed = []
  _setHome(null)
  rmSync(home, { recursive: true, force: true })
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
  temps = []
})

/** Every stored line under `<home>/audit/` of `type`, segments in name order. */
function ofType(type: string): unknown[] {
  if (!existsSync(storeDir())) return []
  return readdirSync(storeDir())
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .flatMap((f) =>
      readFileSync(join(storeDir(), f), 'utf-8')
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as { type: string }),
    )
    .filter((l) => l.type === type)
}

/** Write the registry by hand, then let the store see it once (P10). */
async function seed(registry: unknown = SEED): Promise<void> {
  writeFileSync(file(), JSON.stringify(registry))
  await principals.loadRegistry(statePath)
}

/** The code lines of a source file, comment lines dropped, that match `re`. */
function offending(path: string, re: RegExp): string[] {
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((text) => !/^\s*(\*|\/\/|\/\*)/.test(text))
    .filter((text) => re.test(text))
}

/** Make the observe throw an `AuditAppendError` once. Returns the trip count. */
function failObserve(): () => number {
  let trips = 0
  installed.push(
    spyOn(audit, 'observeAuthorityFile').mockImplementationOnce(async () => {
      trips += 1
      throw new audit.AuditAppendError('principal_registry.observed', 'write failed')
    }),
  )
  return () => trips
}

type Refusal = { refused: string; cause: string }

describe('requirePrincipal', () => {
  test('each rule accepts and refuses exactly the entries its row names, with a fixed phrase per cause', async () => {
    await seed()
    const table: Record<(typeof RULES)[number], Record<string, string>> = {
      active: { ops: 'accept', ci: 'accept', alice: 'disabled', bot: 'disabled', nobody: 'unknown' },
      'active-human': { ops: 'accept', ci: 'not human', alice: 'disabled', bot: 'not human', nobody: 'unknown' },
      'active-machine': { ci: 'accept', ops: 'not machine', bot: 'disabled', alice: 'not machine', nobody: 'unknown' },
      registered: { ops: 'accept', alice: 'accept', ci: 'accept', bot: 'accept', nobody: 'unknown' },
    }
    const phrase: Record<string, string> = {
      unknown: 'no principal has that id',
      disabled: 'that principal is disabled',
      'not human': 'that principal is not a human',
      'not machine': 'that principal is not a machine',
    }
    const phrases: string[] = []

    for (const rule of RULES) {
      for (const [id, want] of Object.entries(table[rule])) {
        const got = await principals.requirePrincipal(id, rule, statePath)
        if (want === 'accept') {
          expect({ rule, id, got }).toEqual({ rule, id, got: { id } })
        } else {
          expect<unknown>({ rule, id, got }).toEqual({ rule, id, got: { refused: phrase[want]!, cause: want } })
          phrases.push((got as Refusal).refused)
        }
      }
    }

    expect(phrases.length).toBeGreaterThan(0)
    for (const p of phrases) expect(p).not.toContain(KEY)
  })

  test('an empty id is refused under every rule without reading the registry', async () => {
    // Hand-written and never observed: a read would record it and create the store.
    writeFileSync(file(), JSON.stringify(SEED))

    for (const rule of RULES) {
      expect(await principals.requirePrincipal('', rule, statePath)).toEqual({
        refused: 'an empty id names no principal',
        cause: 'empty',
      })
    }

    expect(existsSync(storeDir())).toBe(false)
  })

  test("ids match byte for byte, so 'Ops' does not name ops", async () => {
    await seed()

    expect(await principals.requirePrincipal('Ops', 'active', statePath)).toEqual({
      refused: 'no principal has that id',
      cause: 'unknown',
    })
  })

  test('with no principals.json every id is unknown, and the plain read is an empty registry', async () => {
    for (const id of ['ops', 'alice', 'ci', 'bot']) {
      expect(await principals.requirePrincipal(id, 'registered', statePath)).toEqual({
        refused: 'no principal has that id',
        cause: 'unknown',
      })
    }

    expect(await principals.readRegistry()).toEqual({ bytes: null, registry: { principals: [] } })
  })

  test('no principal comes from WARPLINE_PRINCIPAL, $USER or the OS account', async () => {
    writeFileSync(file(), JSON.stringify(SEED))
    const saved = { WARPLINE_PRINCIPAL: process.env.WARPLINE_PRINCIPAL, USER: process.env.USER }
    process.env.WARPLINE_PRINCIPAL = 'ops'
    process.env.USER = 'ops'
    try {
      expect(await principals.requirePrincipal(undefined, 'active', statePath)).toEqual({ id: null })
      expect(existsSync(storeDir())).toBe(false)
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }

    expect(offending(SOURCE, OS_USER)).toEqual([])
    // The same scan, shown red on a planted offender.
    const dir = mkdtempSync(join(tmpdir(), 'warpline-principals-fixture-'))
    temps.push(dir)
    const planted = join(dir, 'principals.ts')
    writeFileSync(planted, `/**\n * A planted offender.\n */\nconst id = process.env.USER ?? 'me'\n`)
    expect(offending(planted, OS_USER)).toEqual(["const id = process.env.USER ?? 'me'"])
  })

  test('a principals.json that is not JSON is refused with cause registry, naming the file', async () => {
    writeFileSync(file(), `{"principals": [ ${KEY}`)

    const got = (await principals.requirePrincipal('ops', 'active', statePath)) as Refusal

    expect(got.cause).toBe('registry')
    expect(got.refused).toContain('principals.json')
    expect(got.refused).not.toContain(KEY)
  })

  test('a schema failure names key paths and issue codes, never a value from the file', async () => {
    writeFileSync(
      file(),
      JSON.stringify({ principals: [{ id: 'ops', type: 'wizard', status: 'active', key: KEY }] }),
    )

    const got = (await principals.requirePrincipal('ops', 'active', statePath)) as Refusal

    expect(got.cause).toBe('registry')
    expect(got.refused).toStartWith('principals.json is not a usable registry: ')
    expect(got.refused).toContain('principals.0.type')
    expect(got.refused).not.toContain('wizard')
    expect(got.refused).not.toContain(KEY)
    expect(got.refused).not.toContain('Nothing was written')
  })

  test('a failed observe is refused with cause audit, naming the store reason', async () => {
    await seed()
    const trips = failObserve()

    const got = await principals.requirePrincipal('ops', 'active', statePath)

    expect(trips()).toBe(1)
    expect(got).toEqual({
      refused: 'the audit store could not record a change to principals.json: write failed',
      cause: 'audit',
    })
  })
})

describe('loadRegistry and readRegistry', () => {
  test('the observed load records a hand edit before it resolves; the plain read appends nothing', async () => {
    writeFileSync(file(), JSON.stringify(SEED))

    const loaded = await principals.loadRegistry(statePath)

    expect('registry' in loaded).toBe(true)
    expect(ofType(OBSERVED)).toHaveLength(1)

    const edited = structuredClone(SEED)
    edited.principals[2]!.status = 'disabled'
    writeFileSync(file(), JSON.stringify(edited))

    const read = await principals.readRegistry()

    expect<unknown>(read).toEqual({ bytes: readFileSync(file()), registry: edited })
    expect(ofType(OBSERVED)).toHaveLength(1)
  })

  test('the plain read never creates the audit directory', async () => {
    writeFileSync(file(), JSON.stringify(SEED))

    expect('registry' in (await principals.readRegistry())).toBe(true)

    expect(existsSync(storeDir())).toBe(false)
  })

  test('the observed load rejects with the store error when the observe append fails', async () => {
    await seed()
    const trips = failObserve()

    await expect(principals.loadRegistry(statePath)).rejects.toBeInstanceOf(audit.AuditAppendError)
    expect(trips()).toBe(1)
  })
})

describe('registryView', () => {
  test('maps each id to its type and status only, and never carries a key', async () => {
    await seed()
    const loaded = await principals.loadRegistry(statePath)
    if (!('registry' in loaded)) throw new Error(`unexpected refusal: ${loaded.refused}`)

    const view = principals.registryView(loaded.registry)

    expect([...view]).toEqual([
      ['ops', { type: 'human', status: 'active' }],
      ['alice', { type: 'human', status: 'disabled' }],
      ['ci', { type: 'machine', status: 'active' }],
      ['bot', { type: 'machine', status: 'disabled' }],
    ])
    expect(JSON.stringify([...view])).not.toContain(KEY)
  })
})
