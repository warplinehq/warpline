/**
 * A served model that differs from the requested one, pinned (SPEC R6).
 *
 * A mismatch is exact string inequality between the requested model and the
 * served one, and a null served model counts as one. It raises one board
 * `notice`, severity `warning`, whose `metadata_json` is
 * `{ event: 'model_mismatch', handoff, requested, served }`. Under
 * `model_mismatch: record` (the default) the Judgment is written. Under
 * `refuse` nothing is written, the try is `refused`, and the Handoff stays
 * open. A notice that cannot be written is reported as `unannounced`, and
 * that exits 1.
 *
 * Every case gets its own temp home, and the board log is
 * `<home>/state/events.jsonl`. No case reaches a real provider: the fake
 * `claude` or the local stub answers, and the pass is handed an explicit
 * parent env.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withFakeClaude } from '../../../test-utils/fake-claude.js'
import { withOpenAiStub } from '../../../test-utils/openai-stub.js'
import { auditRecords } from '../../cli/__tests__/helpers/verb-home.js'
import { readHandoff, settleTry, writeHandoff } from '../../lib/handoffs.js'
import { withHome } from '../../lib/paths.js'
import * as pass from '../pass.js'

const ID = 'run-1.prod'
const OUTPUT = 'state/prod.judgment.md'
const TEXT = 'the judgment, word for word'
const FLOOR_VERSION = '2.1.305 (Claude Code)'
const REFUSED_REASON = 'the served model differs from the requested one'

type Env = Record<string, string | undefined>

const dirs: string[] = []

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const temp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

/** A temp home holding one open Handoff and the given preferences. */
async function makeHome(prefs: unknown): Promise<string> {
  const home = temp('warpline-mismatch-')
  await writeHandoff(join(home, 'handoffs'), {
    run_id: 'run-1',
    plugin: 'prod',
    task: 'Judge it',
    context_path: null,
    output_path: OUTPUT,
  })
  writeFileSync(join(home, 'preferences.json'), JSON.stringify(prefs))
  return home
}

/** The fake `claude` for `fn`, reporting `served` as its one modelUsage key, with a count of renderer calls. */
async function withClaude<T>(served: string, fn: (env: Env, calls: () => number) => Promise<T>): Promise<T> {
  const dump = temp('warpline-mismatch-dump-')
  const stdout = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: TEXT,
    total_cost_usd: 0.0123,
    modelUsage: { [served]: {} },
  })
  return withFakeClaude({ stdout, version: FLOOR_VERSION, dumpDir: dump }, () => {
    const calls = () => {
      const p = join(dump, 'calls.txt')
      return existsSync(p) ? readFileSync(p, 'utf-8').split('\n').filter(Boolean).length : 0
    }
    return fn({ PATH: process.env.PATH }, calls)
  })
}

const run = (home: string, parentEnv: Env): Promise<pass.PassResult> =>
  withHome(home, () => pass.consumePass({ plugins: null, parentEnv }))

const record = (home: string) => readHandoff(join(home, 'handoffs'), 'run-1', 'prod')
const tried = (home: string) => auditRecords(home, 'handoff.tried').filter((d) => d.handoff === ID)
const judgmentPath = (home: string) => join(home, OUTPUT)
const eventsPath = (home: string) => join(home, 'state', 'events.jsonl')

/** The raw lines of the board log, or none when it was never written. */
function eventLines(home: string): string[] {
  const p = eventsPath(home)
  return existsSync(p) ? readFileSync(p, 'utf-8').split('\n').filter(Boolean) : []
}

/** Every board event whose `metadata_json.event` is `model_mismatch`. */
function mismatchNotices(home: string): Array<Record<string, unknown>> {
  return eventLines(home)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((e) => typeof e.metadata_json === 'string' && (JSON.parse(e.metadata_json) as { event?: unknown }).event === 'model_mismatch')
}

const EMPTY: pass.PassResult = {
  answered: [],
  failed: [],
  refused: [],
  skipped: [],
  discarded: [],
  held: [],
  unreadable: [],
  unannounced: [],
  refusal: null,
}

describe('a served model that differs from the requested one is on the board', () => {
  test('tracer: a served x-20261001 for a requested x writes the Judgment and raises one model_mismatch notice', async () => {
    const home = await makeHome({ consume: { model: 'x' } })
    const r = await withClaude('x-20261001', (env) => run(home, env))
    expect(r.answered).toEqual([ID])
    expect(readFileSync(judgmentPath(home), 'utf-8')).toBe(TEXT)
    expect((await record(home))?.tries?.[0]).toMatchObject({ outcome: 'answered', requested: 'x', served: 'x-20261001' })
    const notices = mismatchNotices(home)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ type: 'notice', severity: 'warning' })
    expect(JSON.parse(notices[0]!.metadata_json as string)).toEqual({
      event: 'model_mismatch',
      handoff: ID,
      requested: 'x',
      served: 'x-20261001',
    })
    // Last, so a missing notice is the first failure: the whole result, and a notice written is not a reason to exit 1.
    expect(r).toEqual({ ...EMPTY, answered: [ID] })
    expect(pass.exitCodeFor(r)).toBe(0)
  })

  test('the notice line carries no Judgment text', async () => {
    const home = await makeHome({ consume: { model: 'x' } })
    await withClaude('x-20261001', async (env) => {
      expect((await run(home, env)).answered).toEqual([ID])
    })
    const lines = eventLines(home)
    expect(mismatchNotices(home)).toHaveLength(1)
    for (const line of lines) expect(line).not.toContain(TEXT)
  })

  test('a served model equal to the requested one raises no notice', async () => {
    const home = await makeHome({ consume: { model: 'x-20261001' } })
    await withClaude('x-20261001', async (env) => {
      expect((await run(home, env)).answered).toEqual([ID])
    })
    expect(mismatchNotices(home)).toEqual([])
  })

  test('a 200 naming no model is a null served model, and the notice carries served: null', async () => {
    await withOpenAiStub(
      [{ status: 200, body: { choices: [{ message: { role: 'assistant', content: TEXT } }] } }],
      async (stub) => {
        const home = await makeHome({ consume: { renderer: 'openai-compatible', endpoint: stub.url, model: 'gpt-test' } })
        expect((await run(home, {})).answered).toEqual([ID])
        expect((await record(home))?.tries?.[0]).toMatchObject({ served: null })
        const notices = mismatchNotices(home)
        expect(notices).toHaveLength(1)
        expect(JSON.parse(notices[0]!.metadata_json as string)).toEqual({
          event: 'model_mismatch',
          handoff: ID,
          requested: 'gpt-test',
          served: null,
        })
      },
    )
  })

  test('a call that failed served no answer: no notice, and the try stays failed under refuse', async () => {
    await withOpenAiStub([{ status: 400 }], async (stub) => {
      const home = await makeHome({
        consume: { renderer: 'openai-compatible', endpoint: stub.url, model: 'gpt-test', model_mismatch: 'refuse' },
      })
      const r = await run(home, {})
      expect(r.failed.map((e) => e.id)).toEqual([ID])
      expect(r.refused).toEqual([])
      expect((await record(home))?.tries?.[0]).toMatchObject({ outcome: 'failed' })
      expect(mismatchNotices(home)).toEqual([])
    })
  })
})

describe("model_mismatch: 'refuse' keeps the Handoff open", () => {
  test("under 'refuse' a served x-20261001 writes no Judgment, records a refused try, and still raises one notice", async () => {
    const home = await makeHome({ consume: { model: 'x', model_mismatch: 'refuse' } })
    const r = await withClaude('x-20261001', (env) => run(home, env))
    expect(existsSync(judgmentPath(home))).toBe(false)
    const h = await record(home)
    expect(h?.state).toBe('open')
    expect(h?.tries).toHaveLength(1)
    expect(h?.tries?.[0]).toMatchObject({ outcome: 'refused', requested: 'x', served: 'x-20261001', reason: REFUSED_REASON })
    const t = tried(home)
    expect(t).toHaveLength(1)
    expect(t[0]).toMatchObject({ outcome: 'refused', requested: 'x', served: 'x-20261001' })
    expect(t[0]!.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(mismatchNotices(home)).toHaveLength(1)
    expect(r).toEqual({ ...EMPTY, refused: [{ id: ID, reason: REFUSED_REASON }] })
    expect(pass.exitCodeFor(r)).toBe(1)
  })

  test("a refused try counts against consume.max_tries: max_tries 1 with one prior refused try is skipped with no call", async () => {
    const home = await makeHome({ consume: { model: 'x', model_mismatch: 'refuse', max_tries: 1 } })
    const t = {
      at: new Date().toISOString(),
      reservation_id: 'urn:uuid:00000000-0000-4000-8000-000000000001',
      requested: 'x',
      served: 'x-20261001',
      cost_micro_usd: null,
      cost_basis: 'unknown' as const,
      outcome: 'refused' as const,
      reason: REFUSED_REASON,
    }
    await settleTry(join(home, 'handoffs'), ID, async () => ({ try: t, close: false }), async () => t)
    await withClaude('x-20261001', async (env, calls) => {
      const r = await run(home, env)
      expect(r.skipped).toEqual([{ id: ID, reason: 'the Handoff has used consume.max_tries tries' }])
      expect(r.answered).toEqual([])
      expect(calls()).toBe(0)
    })
  })
})

describe('a mismatch notice that cannot be written is reported', () => {
  test('with events.jsonl a directory the try is answered, the Handoff is unannounced, and the pass exits 1', async () => {
    const home = await makeHome({ consume: { model: 'x' } })
    mkdirSync(eventsPath(home), { recursive: true })
    await withClaude('x-20261001', async (env) => {
      const r = await run(home, env)
      expect(r).toEqual({ ...EMPTY, answered: [ID], unannounced: [ID] })
      expect(pass.exitCodeFor(r)).toBe(1)
    })
    expect(readFileSync(judgmentPath(home), 'utf-8')).toBe(TEXT)
    expect((await record(home))?.state).toBe('answered')
  })
})
