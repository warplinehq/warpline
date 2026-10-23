/**
 * A consumer that stops, pinned through real kills (D-05, SPEC R7).
 *
 * A consumer killed between its Judgment write and its mark leaves the file,
 * its `handoff.tried` and its claim. The next consumer breaks the claim,
 * finds the reservation no try on the record names, and when the file's
 * sha256 is the recorded one it marks the record `answered` with a
 * `recovered` try: no call, no new reservation. A file edited since is not
 * taken as the paid one. A consumer killed mid-call leaves its reservation
 * open, and the window counts it at the full per-call amount; the next pass
 * records the dead try as `failed`, and it counts against `max_tries`.
 *
 * Consumers in one process share a pid, so every kill here is of a separate
 * process, spawned with an explicit env holding only the home, a PATH and the
 * fixture's mode (AGENTS.md Rule 2). Each child leads its own process group,
 * so a kill reaches the fake `claude` it spawned too.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withFakeClaude } from '../../../test-utils/fake-claude.js'
import { auditRecords } from '../../cli/__tests__/helpers/verb-home.js'
import { readHandoff, writeHandoff } from '../../lib/handoffs.js'
import { engineStatePath, withHome } from '../../lib/paths.js'
import * as pass from '../pass.js'
import * as spend from '../spend.js'

const MODEL = 'claude-opus-5'
const FLOOR_VERSION = '2.1.305 (Claude Code)'
const TEXT = 'the judgment'
const ID = 'run-1.prod'
const OUTPUT = 'state/prod.judgment.md'
const CHILD = join(import.meta.dir, 'fixtures', 'consume-child.ts')
const STOPPED = 'the consumer holding the claim stopped'

type Env = Record<string, string | undefined>

const homes: string[] = []
const children: number[] = []

afterEach(() => {
  // A case that failed before its kill leaves no process behind.
  for (const pid of children.splice(0)) {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {}
  }
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true })
})

const temp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix))
  homes.push(d)
  return d
}

async function makeHome(consume: Record<string, unknown>): Promise<string> {
  const home = temp('warpline-reconcile-')
  await writeHandoff(join(home, 'handoffs'), { run_id: 'run-1', plugin: 'prod', task: 'Judge it', context_path: null, output_path: OUTPUT })
  writeFileSync(join(home, 'preferences.json'), JSON.stringify({ consume: { model: MODEL, ...consume } }))
  return home
}

const claudeResult = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: TEXT,
  total_cost_usd: 0.0123,
  modelUsage: { [MODEL]: {} },
})

/** The fake `claude` for `fn`, with its bin dir and a count of renderer calls (a `--version` probe is not one). */
async function withClaude<T>(sleepMs: number, fn: (env: Env, calls: () => number, binDir: string) => Promise<T>): Promise<T> {
  const dump = temp('warpline-reconcile-dump-')
  return withFakeClaude({ stdout: claudeResult, version: FLOOR_VERSION, dumpDir: dump, sleepMs }, (binDir) => {
    const calls = () => {
      const p = join(dump, 'calls.txt')
      return existsSync(p) ? readFileSync(p, 'utf-8').split('\n').filter(Boolean).length : 0
    }
    return fn({ PATH: process.env.PATH }, calls, binDir)
  })
}

const run = (home: string, parentEnv: Env) => withHome(home, () => pass.consumePass({ plugins: null, parentEnv }))

/** One consumer process over `home`, leading its own process group. */
function startChild(home: string, binDir: string, mode: 'plain' | 'kill-after-write') {
  const child = spawn(process.execPath, [CHILD], {
    env: { WARPLINE_HOME: home, PATH: `${binDir}:/usr/bin:/bin`, CONSUME_CHILD_MODE: mode },
    stdio: ['ignore', 'ignore', 'inherit'],
    detached: true,
  })
  children.push(child.pid!)
  const end = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code, signal) => resolve({ code, signal }))
  })
  return { pid: child.pid!, end }
}

const record = (home: string) => readHandoff(join(home, 'handoffs'), 'run-1', 'prod')
const reserved = (home: string) => auditRecords(home, 'handoff.reserved').filter((d) => d.handoff === ID)
const tried = (home: string) => auditRecords(home, 'handoff.tried').filter((d) => d.handoff === ID)
const claimText = (home: string) => JSON.parse(readlinkSync(join(home, 'handoffs', `${ID}.claim`), 'utf8')) as { pid: number }

/** A `kill-after-write` child over `home`: it writes the Judgment and dies before the mark. Returns its pid. */
async function killAfterWrite(home: string, calls: () => number, binDir: string): Promise<number> {
  const child = startChild(home, binDir, 'kill-after-write')
  expect((await child.end).signal).toBe('SIGKILL')
  expect(calls()).toBe(1)
  return child.pid
}

/** A plain child over `home` whose fake sleeps 5 s, killed with its group once the call has started. */
async function killMidCall(home: string): Promise<void> {
  await withClaude(5000, async (_env, calls, binDir) => {
    const child = startChild(home, binDir, 'plain')
    const deadline = Date.now() + 15_000
    while (calls() === 0) {
      if (Date.now() > deadline) throw new Error('the child made no call')
      await Bun.sleep(20)
    }
    process.kill(-child.pid, 'SIGKILL')
    expect((await child.end).signal).toBe('SIGKILL')
  })
}

describe('a consumer killed after its Judgment write', () => {
  test('a consumer killed after its Judgment write is recovered by sha256 with no second call', async () => {
    const home = await makeHome({})
    await withClaude(0, async (env, calls, binDir) => {
      const pid = await killAfterWrite(home, calls, binDir)

      // What the dead consumer left: the file, an open record, its claim, and its answered try on the audit record.
      expect(readFileSync(join(home, OUTPUT), 'utf-8')).toBe(TEXT)
      expect(await record(home)).toMatchObject({ state: 'open', tries: [] })
      expect(claimText(home).pid).toBe(pid)
      expect(tried(home).map((d) => d.outcome)).toEqual(['answered'])
      const deadReservation = reserved(home)[0]!.reservation_id

      const r = await run(home, env)
      expect(r.answered).toEqual([ID])
      expect(calls()).toBe(1)
      const rec = await record(home)
      expect(rec?.state).toBe('answered')
      expect(rec?.tries).toHaveLength(1)
      expect(rec?.tries?.[0]).toMatchObject({ outcome: 'recovered', reservation_id: deadReservation, requested: MODEL, served: MODEL, reason: null })
      expect(reserved(home)).toHaveLength(1)
      expect(tried(home)).toHaveLength(1)
      expect(pass.exitCodeFor(r)).toBe(0)
    })
  })

  test('a Judgment edited after the crash is not taken as the paid one', async () => {
    const home = await makeHome({})
    await withClaude(0, async (env, calls, binDir) => {
      await killAfterWrite(home, calls, binDir)
      const deadReservation = reserved(home)[0]!.reservation_id
      writeFileSync(join(home, OUTPUT), 'edited after the crash')

      const r = await run(home, env)
      expect(r.answered).toEqual([ID])
      expect(calls()).toBe(2)
      const rec = await record(home)
      expect(rec?.tries?.map((t) => t.outcome)).toEqual(['failed', 'answered'])
      expect(rec?.tries?.[0]).toMatchObject({ reservation_id: deadReservation, reason: STOPPED })
      expect(rec?.state).toBe('answered')
      expect(readFileSync(join(home, OUTPUT), 'utf-8')).toBe(TEXT)
    })
  })
})

describe('a consumer killed mid-call', () => {
  test('a consumer killed mid-call keeps its full reservation in the window', async () => {
    const home = await makeHome({ max_usd_per_call: 0.05 })
    await killMidCall(home)
    expect(tried(home)).toEqual([])
    expect(reserved(home).map((d) => d.amount_micro_usd)).toEqual([50_000])
    const statePath = await withHome(home, async () => engineStatePath())
    expect(await spend.windowSpend(statePath, Date.now(), 86_400)).toBe(50_000)
  })

  test('the pass after a mid-call kill records the dead try and answers', async () => {
    const home = await makeHome({})
    await killMidCall(home)
    const deadReservation = reserved(home)[0]!.reservation_id
    await withClaude(0, async (env, calls) => {
      const r = await run(home, env)
      expect(r.answered).toEqual([ID])
      expect(calls()).toBe(1)
    })
    const lines = tried(home)
    expect(lines.map((d) => d.outcome)).toEqual(['failed', 'answered'])
    expect(lines[0]).toMatchObject({ reservation_id: deadReservation, cost_micro_usd: null, cost_basis: 'unknown', sha256: null })
    const rec = await record(home)
    expect(rec?.tries?.map((t) => t.outcome)).toEqual(['failed', 'answered'])
    expect(rec?.tries?.[0]).toMatchObject({ reservation_id: deadReservation, reason: STOPPED, cost_micro_usd: null })

    // With max_tries 1 the dead try is the one try, and no call follows.
    const capped = await makeHome({ max_tries: 1 })
    await killMidCall(capped)
    await withClaude(0, async (env, calls) => {
      const r = await run(capped, env)
      expect(r.skipped).toEqual([{ id: ID, reason: 'the Handoff has used consume.max_tries tries' }])
      expect(calls()).toBe(0)
    })
    const cappedRec = await record(capped)
    expect({ state: cappedRec?.state, tries: cappedRec?.tries?.map((t) => t.outcome) }).toEqual({ state: 'open', tries: ['failed'] })
    expect(tried(capped).map((d) => d.outcome)).toEqual(['failed'])
  })
})
