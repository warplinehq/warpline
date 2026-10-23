/**
 * A try that ended without settling, pinned through the real pass.
 *
 * A try's `handoff.reserved` line is its write-ahead anchor. A reservation
 * for a Handoff that no try on its record names is a try that ended without
 * settling, however it ended: a kill, a Judgment or record write that failed,
 * a renderer that rejected. On every claim, before any new try, the pass
 * settles each such reservation onto the record, oldest first. When its
 * `handoff.tried` says `answered` and the file under `judgments/` has that
 * sha256, the paid answer is marked `recovered`: no call, no new reservation.
 * A file edited since is not taken as the paid one. Anything else is a
 * `failed` try, and it counts against `max_tries`. A consumer killed mid-call
 * leaves its reservation open, and the window counts it at the full per-call
 * amount until then.
 *
 * Consumers in one process share a pid, so every kill here is of a separate
 * process, spawned with an explicit env holding only the home, a PATH and the
 * fixture's mode (AGENTS.md Rule 2). Each child leads its own process group,
 * so a kill reaches the fake `claude` it spawned too. Every spy is restored
 * after its case.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withFakeClaude } from '../../../test-utils/fake-claude.js'
import { auditRecords } from '../../cli/__tests__/helpers/verb-home.js'
import { appendAudit } from '../../lib/audit-log.js'
import * as fsAtomic from '../../lib/fs-atomic.js'
import { readHandoff, writeHandoff } from '../../lib/handoffs.js'
import { engineStatePath, withHome } from '../../lib/paths.js'
import * as cc from '../claude-code.js'
import * as pass from '../pass.js'
import * as spend from '../spend.js'

const MODEL = 'claude-opus-5'
const FLOOR_VERSION = '2.1.305 (Claude Code)'
const TEXT = 'the judgment'
const ID = 'run-1.prod'
const OUTPUT = 'judgments/prod.judgment.md'
const CHILD = join(import.meta.dir, 'fixtures', 'consume-child.ts')
const UNSETTLED = 'the try ended without being settled'

type Env = Record<string, string | undefined>

const homes: string[] = []
const children: number[] = []
const spies: ReturnType<typeof spyOn>[] = []

afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore()
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

async function makeHome(consume: Record<string, unknown>, outputPath = OUTPUT): Promise<string> {
  const home = temp('warpline-reconcile-')
  await writeHandoff(join(home, 'handoffs'), { run_id: 'run-1', plugin: 'prod', task: 'Judge it', context_path: null, output_path: outputPath })
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
      expect(rec?.tries?.[0]).toMatchObject({ reservation_id: deadReservation, reason: UNSETTLED })
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
    expect(rec?.tries?.[0]).toMatchObject({ reservation_id: deadReservation, reason: UNSETTLED, cost_micro_usd: null })

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

const MAX_TRIES_USED = 'the Handoff has used consume.max_tries tries'

/** Reservations `ids` for the Handoff, appended in order through the store, and a `failed` try for each id in `failed`. */
async function appendReservations(home: string, ids: string[], failed: string[]): Promise<void> {
  await withHome(home, async () => {
    const statePath = engineStatePath()
    for (const id of ids) await appendAudit(statePath, 'handoff.reserved', { reservation_id: id, handoff: ID, amount_micro_usd: 0 })
    for (const id of failed) {
      await appendAudit(statePath, 'handoff.tried', {
        reservation_id: id,
        handoff: ID,
        outcome: 'failed',
        requested: MODEL,
        served: null,
        cost_micro_usd: null,
        cost_basis: 'unknown',
        bytes: null,
        sha256: null,
      })
    }
  })
}

describe('a try that ended without settling', () => {
  test('an output path that names a directory stops at consume.max_tries with exactly max_tries renderer calls', async () => {
    const home = await makeHome({ max_tries: 2 }, 'judgments/dir.md')
    mkdirSync(join(home, 'judgments', 'dir.md'), { recursive: true })
    await withClaude(0, async (env, calls) => {
      for (let i = 0; i < 2; i++) {
        const r = await run(home, env)
        expect(r.failed.map((e) => e.id)).toEqual([ID])
        expect(r.failed[0]!.reason.startsWith('the try could not be settled (')).toBe(true)
      }
      const r = await run(home, env)
      expect(r.failed).toEqual([])
      expect(r.skipped).toEqual([{ id: ID, reason: MAX_TRIES_USED }])
      expect(calls()).toBe(2)
    })
    const rec = await record(home)
    expect(rec?.state).toBe('open')
    expect(rec?.tries?.map((t) => t.outcome)).toEqual(['failed', 'failed'])
    expect(rec?.tries?.map((t) => t.reason)).toEqual([UNSETTLED, UNSETTLED])
    const ids = reserved(home).map((d) => d.reservation_id as string)
    expect(ids).toHaveLength(2)
    expect(rec?.tries?.map((t) => t.reservation_id)).toEqual(ids)
  })

  test('a claim taken with no break settles every reservation the record does not name, oldest first', async () => {
    // No claim file is planted: the claim is taken by exclusive create, the shape a racing consumer gets.
    const r1 = `urn:uuid:${randomUUID()}`
    const r2 = `urn:uuid:${randomUUID()}`
    const home = await makeHome({})
    await appendReservations(home, [r1, r2], [r2])
    await withClaude(0, async (env, calls) => {
      const r = await run(home, env)
      expect(r.answered).toEqual([ID])
      expect(calls()).toBe(1)
    })
    const rec = await record(home)
    expect(rec?.tries?.map((t) => t.outcome)).toEqual(['failed', 'failed', 'answered'])
    expect(rec?.tries?.[0]).toMatchObject({ reservation_id: r1, reason: UNSETTLED })
    expect(rec?.tries?.[1]).toMatchObject({ reservation_id: r2, reason: UNSETTLED })
    expect(tried(home).filter((d) => d.reservation_id === r1).map((d) => d.outcome)).toEqual(['failed'])

    // With max_tries 2 the two unsettled tries are the two tries, and no call follows.
    const capped = await makeHome({ max_tries: 2 })
    await appendReservations(capped, [r1, r2], [r2])
    await withClaude(0, async (env, calls) => {
      const r = await run(capped, env)
      expect(r.skipped).toEqual([{ id: ID, reason: MAX_TRIES_USED }])
      expect(calls()).toBe(0)
    })
  })

  test('a renderer that cannot run is a failed try, and the next Handoff in the pass is still answered', async () => {
    const home = temp('warpline-reconcile-')
    for (const plugin of ['alpha', 'beta']) {
      await writeHandoff(join(home, 'handoffs'), { run_id: 'run-1', plugin, task: 'Judge it', context_path: null, output_path: `judgments/${plugin}.md` })
    }
    writeFileSync(join(home, 'preferences.json'), JSON.stringify({ consume: { model: MODEL } }))
    // Read BEFORE `spyOn`: afterwards the namespace property is the mock.
    const real = cc.renderClaudeCode
    let first = true
    spies.push(
      spyOn(cc, 'renderClaudeCode').mockImplementation((...args: Parameters<typeof cc.renderClaudeCode>) => {
        if (!first) return real(...args)
        first = false
        return Promise.reject(Object.assign(new Error('spawn refused'), { code: 'EACCES' }))
      }),
    )
    await withClaude(0, async (env, calls) => {
      const r = await run(home, env)
      expect(r.failed).toEqual([{ id: 'run-1.alpha', reason: 'the renderer could not run (EACCES)' }])
      expect(r.answered).toEqual(['run-1.beta'])
      expect(calls()).toBe(1)
    })
    const alpha = await readHandoff(join(home, 'handoffs'), 'run-1', 'alpha')
    expect(alpha?.tries).toHaveLength(1)
    expect(alpha?.tries?.[0]).toMatchObject({ outcome: 'failed', cost_micro_usd: null, cost_basis: 'unknown' })
    expect(auditRecords(home, 'handoff.tried').filter((d) => d.handoff === 'run-1.alpha')).toHaveLength(1)
  })

  test('a record write that fails after the Judgment landed is recovered on the next pass with no second call', async () => {
    const home = await makeHome({})
    // Read BEFORE `spyOn`: afterwards the namespace property is the mock.
    const real = fsAtomic.atomicWriteJson
    let armed = true
    const spy = spyOn(fsAtomic, 'atomicWriteJson').mockImplementation(async (path: string, value: unknown, opts?: { mode?: number }) => {
      if (armed && path.endsWith(join('handoffs', `${ID}.json`))) {
        armed = false
        throw Object.assign(new Error('write refused'), { code: 'EACCES' })
      }
      return real(path, value, opts)
    })
    spies.push(spy)
    await withClaude(0, async (env, calls) => {
      const first = await run(home, env)
      expect(first.failed).toEqual([{ id: ID, reason: 'the try could not be settled (EACCES)' }])
      expect(readFileSync(join(home, OUTPUT), 'utf-8')).toBe(TEXT)
      expect((await record(home))?.tries).toEqual([])
      const deadReservation = reserved(home)[0]!.reservation_id
      spy.mockRestore()

      const second = await run(home, env)
      expect(second.answered).toEqual([ID])
      expect(calls()).toBe(1)
      const rec = await record(home)
      expect(rec?.state).toBe('answered')
      expect(rec?.tries).toHaveLength(1)
      expect(rec?.tries?.[0]).toMatchObject({ outcome: 'recovered', reservation_id: deadReservation })
      expect(reserved(home)).toHaveLength(1)
    })
  })
})

describe('the audit store could not be read', () => {
  test('a line that is not a record in a sealed segment refuses the claim before any call', async () => {
    const home = await makeHome({})
    // The reservations name another Handoff, so the unreadable line is the only reason left to refuse.
    await withHome(home, async () => {
      const statePath = engineStatePath()
      const data = () => ({ reservation_id: `urn:uuid:${randomUUID()}`, handoff: 'run-9.other', amount_micro_usd: 0 })
      await appendAudit(statePath, 'handoff.reserved', data())
      await appendAudit(statePath, 'handoff.reserved', data(), { maxSegmentBytes: 1 })
    })
    const segments = readdirSync(join(home, 'audit'))
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
    expect(segments).toHaveLength(2)
    // A sealed segment: a line in the active one stops every append, and the pass refuses before any claim.
    appendFileSync(join(home, 'audit', segments[0]!), 'not a record\n')
    await withClaude(0, async (env, calls) => {
      const r = await run(home, env)
      expect(r.refusal).toBeNull()
      expect(r.refused).toEqual([{ id: ID, reason: 'the audit store could not be read for the unsettled tries' }])
      expect(r.answered).toEqual([])
      expect(calls()).toBe(0)
    })
    expect((await record(home))?.state).toBe('open')
  })
})
