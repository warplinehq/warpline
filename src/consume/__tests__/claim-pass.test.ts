/**
 * Exactly once under real concurrency, pinned through the pass.
 *
 * Eight consumers in one process, and four in four processes, answer five
 * open Handoffs once each. A claim this host cannot judge is refused by name
 * and never broken, and a dead same-host holder's claim is broken once. A
 * deny or a supersede that lands while the model call is in flight wins: the
 * claim does not stop the withdraw, the settle re-reads the record under its
 * lock, and no Judgment is written.
 *
 * Nothing the pass runs is spied in this file: claim, reserve, render, settle
 * and withdraw all run as shipped. The claude-code cases run the fake
 * `claude`, the openai-compatible cases the local stub. Children get an
 * explicit env holding only the home, a PATH and the fixture's mode, so they
 * write only inside the case's temp home (AGENTS.md Rule 2).
 *
 * The five Handoffs belong to five plugins, because a second Handoff of one
 * plugin supersedes the first.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withFakeClaude } from '../../../test-utils/fake-claude.js'
import { withOpenAiStub, type StubReply } from '../../../test-utils/openai-stub.js'
import { auditRecords } from '../../cli/__tests__/helpers/verb-home.js'
import { HANDOFFS_READER_VERSION, readHandoff, withdrawHandoff, writeHandoff } from '../../lib/handoffs.js'
import { withHome } from '../../lib/paths.js'
import { ourHost } from '../../lib/pid-lock.js'
import * as pass from '../pass.js'

const MODEL = 'claude-opus-5'
const FLOOR_VERSION = '2.1.305 (Claude Code)'
const OPENAI_MODEL = 'gpt-test'
const TEXT = 'the judgment'
const PLUGINS = ['alpha', 'bravo', 'charlie', 'delta', 'echo'] as const
const ID = 'run-1.prod'
const OUTPUT = 'state/prod.judgment.md'
const CHILD = join(import.meta.dir, 'fixtures', 'consume-child.ts')

type Env = Record<string, string | undefined>

const homes: string[] = []

afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true })
})

const temp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix))
  homes.push(d)
  return d
}

const outputOf = (plugin: string) => `state/${plugin}.judgment.md`

/** A temp home holding one open Handoff per plugin, `run-1`, and the given preferences. */
async function makeHome(prefs: unknown, plugins: readonly string[] = PLUGINS): Promise<string> {
  const home = temp('warpline-claim-pass-')
  for (const plugin of plugins) {
    await writeHandoff(join(home, 'handoffs'), { run_id: 'run-1', plugin, task: 'Judge it', context_path: null, output_path: outputOf(plugin) })
  }
  writeFileSync(join(home, 'preferences.json'), JSON.stringify(prefs))
  return home
}

function claudeResult(text: string): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: text,
    total_cost_usd: 0.0123,
    modelUsage: { [MODEL]: {} },
  })
}

/** The fake `claude` for `fn`, with its bin dir and a count of renderer calls (a `--version` probe is not one). */
async function withClaude<T>(sleepMs: number, fn: (env: Env, calls: () => number, binDir: string) => Promise<T>): Promise<T> {
  const dump = temp('warpline-claim-pass-dump-')
  return withFakeClaude({ stdout: claudeResult(TEXT), version: FLOOR_VERSION, dumpDir: dump, sleepMs }, (binDir) => {
    const calls = () => {
      const p = join(dump, 'calls.txt')
      return existsSync(p) ? readFileSync(p, 'utf-8').split('\n').filter(Boolean).length : 0
    }
    return fn({ PATH: process.env.PATH }, calls, binDir)
  })
}

const run = (home: string, parentEnv: Env) => withHome(home, () => pass.consumePass({ plugins: null, parentEnv }))

type ChildEnd = { code: number | null; signal: NodeJS.Signals | null; stdout: string }

/** One consumer process over `home`, with the fake's dir first on its PATH. */
function runChild(home: string, binDir: string, mode: 'plain' | 'kill-after-write'): Promise<ChildEnd> {
  const child = spawn(process.execPath, [CHILD], {
    env: { WARPLINE_HOME: home, PATH: `${binDir}:/usr/bin:/bin`, CONSUME_CHILD_MODE: mode },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  let stdout = ''
  child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf-8')))
  return new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code, signal) => resolve({ code, signal, stdout }))
  })
}

/** A pid that ran here and has exited. */
function deadPid(): number {
  const { pid } = spawnSync('/usr/bin/true', [], { env: {} })
  try {
    process.kill(pid!, 0)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return pid!
  }
  throw new Error(`pid ${pid} is still running`)
}

/** Presence through lstat: a claim is a link whose text names no file, so `existsSync` reads it as gone. */
const present = (p: string) => lstatSync(p, { throwIfNoEntry: false }) !== undefined

const record = (home: string, plugin: string, runId = 'run-1') => readHandoff(join(home, 'handoffs'), runId, plugin)
const triedFor = (home: string, id: string) => auditRecords(home, 'handoff.tried').filter((d) => d.handoff === id)

describe('several consumers answer each Handoff exactly once', () => {
  test('eight consumers over five Handoffs answer each exactly once', async () => {
    const home = await makeHome({ consume: { model: MODEL } })
    const ids = PLUGINS.map((p) => `run-1.${p}`)
    await withClaude(200, async (env, calls) => {
      const results = await Promise.all(Array.from({ length: 8 }, () => run(home, env)))

      // (a) every record has exactly one answered try
      for (const plugin of PLUGINS) {
        const rec = await record(home, plugin)
        expect({ plugin, answered: (rec?.tries ?? []).filter((t) => t.outcome === 'answered').length }).toEqual({ plugin, answered: 1 })
      }
      // (b) one handoff.tried answered per Handoff
      for (const id of ids) {
        expect({ id, answered: triedFor(home, id).filter((d) => d.outcome === 'answered').length }).toEqual({ id, answered: 1 })
      }
      // (c) the union of answered across the eight results holds each id once
      expect(results.flatMap((r) => r.answered).sort()).toEqual([...ids].sort())
      // (d) five Judgment files
      expect(PLUGINS.filter((p) => existsSync(join(home, outputOf(p))))).toEqual([...PLUGINS])
      // (e) five renderer calls
      expect(calls()).toBe(5)
      // (f) no discarded try
      for (const plugin of PLUGINS) {
        expect((await record(home, plugin))?.tries?.filter((t) => t.outcome === 'discarded')).toEqual([])
      }
    })
  })

  test('four consumer processes over five Handoffs make five calls and answer five records', async () => {
    const home = await makeHome({ consume: { model: MODEL } })
    await withClaude(200, async (_env, calls, binDir) => {
      const ends = await Promise.all(Array.from({ length: 4 }, () => runChild(home, binDir, 'plain')))
      expect(calls()).toBe(5)
      for (const plugin of PLUGINS) {
        const rec = await record(home, plugin)
        expect({ plugin, state: rec?.state, tries: rec?.tries?.map((t) => t.outcome) }).toEqual({ plugin, state: 'answered', tries: ['answered'] })
      }
      expect(ends.map((e) => e.code)).toEqual([0, 0, 0, 0])
    })
  })
})

describe('a claim already there', () => {
  test('a claim from another host or pid namespace with a dead pid is refused by name and never broken, and no call is made', async () => {
    const home = await makeHome({ consume: { model: MODEL } }, ['prod'])
    const claim = join(home, 'handoffs', `${ID}.claim`)
    const text = JSON.stringify({ token: 'far', pid: deadPid(), host: 'elsewhere:4026531836:boot', at: Date.now() })
    symlinkSync(text, claim)
    await withClaude(0, async (env, calls) => {
      const r = await run(home, env)
      expect(calls()).toBe(0)
      expect(r.refused).toEqual([{ id: ID, reason: 'claimed by a consumer this host cannot judge' }])
      expect(r.answered).toEqual([])
    })
    expect(readlinkSync(claim, 'utf8')).toBe(text)
    expect((await record(home, 'prod'))?.state).toBe('open')
  })

  test.skipIf(ourHost() === null)("a dead same-host holder's claim is broken and the Handoff answered with one call", async () => {
    const home = await makeHome({ consume: { model: MODEL } }, ['prod'])
    symlinkSync(JSON.stringify({ token: 'gone', pid: deadPid(), host: ourHost(), at: Date.now() }), join(home, 'handoffs', `${ID}.claim`))
    await withClaude(0, async (env, calls) => {
      expect((await run(home, env)).answered).toEqual([ID])
      expect(calls()).toBe(1)
    })
    expect((await record(home, 'prod'))?.state).toBe('answered')
    expect(present(join(home, 'handoffs', `${ID}.claim`))).toBe(false)
  })

  test.skipIf(ourHost() === null)("two consumer processes breaking the same dead holder's claim make one call", async () => {
    const home = await makeHome({ consume: { model: MODEL } }, ['prod'])
    symlinkSync(JSON.stringify({ token: 'gone', pid: deadPid(), host: ourHost(), at: Date.now() }), join(home, 'handoffs', `${ID}.claim`))
    await withClaude(200, async (_env, calls, binDir) => {
      await Promise.all([runChild(home, binDir, 'plain'), runChild(home, binDir, 'plain')])
      expect(calls()).toBe(1)
    })
    const rec = await record(home, 'prod')
    expect({ state: rec?.state, tries: rec?.tries?.map((t) => t.outcome) }).toEqual({ state: 'answered', tries: ['answered'] })
  })
})

/** The stub's 200: one choice, the model it served, and the cost in the gateway header. */
const ok200: StubReply = {
  status: 200,
  body: { model: OPENAI_MODEL, choices: [{ message: { role: 'assistant', content: TEXT } }] },
  headers: { 'x-litellm-response-cost': '0.000123' },
}

describe('a deny or a supersede that lands mid-call wins', () => {
  test('a deny that lands mid-call wins and no Judgment is written', async () => {
    const at = '2026-10-23T09:00:00.000Z'
    let home = ''
    let sawClaim = false
    let withdrew = false
    await withOpenAiStub(
      [ok200],
      async (stub) => {
        home = await makeHome({ consume: { renderer: 'openai-compatible', endpoint: stub.url, model: OPENAI_MODEL } }, ['prod'])
        const r = await run(home, { WARPLINE_CONSUME_API_KEY: 'test-key' })
        expect(stub.calls()).toBe(1)
        // Positive controls: the hook ran while the claim was held, and the withdraw took.
        expect(sawClaim).toBe(true)
        expect(withdrew).toBe(true)
        expect(existsSync(join(home, OUTPUT))).toBe(false)
        expect(r.discarded).toEqual([ID])
        const rec = await record(home, 'prod')
        expect({ state: rec?.state, closed_at: rec?.closed_at }).toEqual({ state: 'withdrawn', closed_at: at })
        expect(rec?.tries?.map((t) => t.outcome)).toEqual(['discarded'])
        expect(triedFor(home, ID).map((d) => d.outcome)).toEqual(['discarded'])
        expect(pass.exitCodeFor(r)).toBe(1)
      },
      {
        beforeReply: async () => {
          const dir = join(home, 'handoffs')
          sawClaim = present(join(dir, `${ID}.claim`))
          withdrew = await withdrawHandoff(dir, 'run-1', 'prod', at)
        },
      },
    )
  })

  test('a supersede that lands mid-call wins and no Judgment is written', async () => {
    const output2 = 'state/prod-2.judgment.md'
    let home = ''
    let sawClaim = false
    await withOpenAiStub(
      [ok200],
      async (stub) => {
        home = await makeHome({ consume: { renderer: 'openai-compatible', endpoint: stub.url, model: OPENAI_MODEL } }, ['prod'])
        const r = await run(home, { WARPLINE_CONSUME_API_KEY: 'test-key' })
        // Positive controls: the hook ran while the claim was held, and the newer record is there.
        expect(sawClaim).toBe(true)
        expect(existsSync(join(home, 'handoffs', 'run-2.prod.json'))).toBe(true)
        expect(existsSync(join(home, OUTPUT))).toBe(false)
        const first = await record(home, 'prod')
        expect({ state: first?.state, tries: first?.tries?.map((t) => t.outcome) }).toEqual({ state: 'superseded', tries: ['discarded'] })
        const second = await record(home, 'prod', 'run-2')
        expect({ state: second?.state, tries: second?.tries }).toEqual({ state: 'open', tries: [] })
        expect(r.discarded).toEqual([ID])
      },
      {
        beforeReply: async () => {
          const dir = join(home, 'handoffs')
          sawClaim = present(join(dir, `${ID}.claim`))
          await writeHandoff(dir, { run_id: 'run-2', plugin: 'prod', task: 'Judge it again', context_path: null, output_path: output2 })
        },
      },
    )
  })
})

describe('the claim adds no reader-visible state', () => {
  test('HANDOFFS_READER_VERSION is still 1, and a claimed and settled record holds only its documented keys', async () => {
    expect(HANDOFFS_READER_VERSION).toBe(1)
    const home = await makeHome({ consume: { model: MODEL } }, ['prod'])
    await withClaude(0, async (env) => {
      expect((await run(home, env)).answered).toEqual([ID])
    })
    const raw = JSON.parse(readFileSync(join(home, 'handoffs', `${ID}.json`), 'utf-8')) as Record<string, unknown>
    expect(Object.keys(raw).sort()).toEqual(
      ['min_reader_version', 'id', 'run_id', 'plugin', 'task', 'context_path', 'output_path', 'tries', 'created_at', 'state', 'closed_at'].sort(),
    )
    expect(raw.min_reader_version).toBe(1)
  })
})
