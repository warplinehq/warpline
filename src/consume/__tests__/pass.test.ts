/**
 * One consume pass, pinned end to end.
 *
 * A pass lists the open Handoff records, reads and audits the preferences,
 * then for each Handoff: the refusals that need no claim, the claim, the
 * reservation, the renderer call, and the settle under the record lock, where
 * the `handoff.tried` line is appended before the Judgment is written. The
 * claim is released however the try ends.
 *
 * Every case gets its own temp home. No case reaches a real provider: the
 * claude-code arm runs the fake `claude`, the openai-compatible arm runs the
 * local stub, and the pass is handed an explicit parent env, never
 * `process.env`.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withFakeClaude } from '../../../test-utils/fake-claude.js'
import { withOpenAiStub, type StubReply } from '../../../test-utils/openai-stub.js'
import { auditRecords, failAppendOnce, recordedBefore, restoreSpies } from '../../cli/__tests__/helpers/verb-home.js'
import * as fsAtomic from '../../lib/fs-atomic.js'
import { readHandoff, writeHandoff, type HandoffInput } from '../../lib/handoffs.js'
import { withHome } from '../../lib/paths.js'
import * as claim from '../claim.js'
// The module this file pins before it exists, read through the namespace so
// each export is named where it is used.
import * as pass from '../pass.js'

const ID = 'run-1.prod'
const OUTPUT = 'judgments/prod.judgment.md'
const TEXT = 'the judgment\r\nline two é'
const MODEL = 'claude-opus-5'
const FLOOR_VERSION = '2.1.305 (Claude Code)'
const OPENAI_MODEL = 'gpt-test'

type Env = Record<string, string | undefined>

const homes: string[] = []
const spies: Array<{ mockRestore: () => void }> = []

afterEach(() => {
  restoreSpies()
  for (const s of spies.splice(0)) s.mockRestore()
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true })
})

/** A temp home holding one open Handoff and the given preferences. */
async function makeHome(prefs: unknown, input: Partial<HandoffInput> = {}): Promise<string> {
  const home = mkdtempSync(join(tmpdir(), 'warpline-pass-'))
  homes.push(home)
  await writeHandoff(join(home, 'handoffs'), {
    run_id: 'run-1',
    plugin: 'prod',
    task: 'Judge it',
    context_path: null,
    output_path: OUTPUT,
    ...input,
  })
  writeFileSync(join(home, 'preferences.json'), JSON.stringify(prefs))
  return home
}

function claudeResult(text: string, usd: number, model = MODEL): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: text,
    total_cost_usd: usd,
    modelUsage: { [model]: {} },
  })
}

/**
 * The fake `claude` first on PATH for `fn`, which gets a parent env carrying
 * that PATH and a count of the renderer calls (a `--version` probe is not one).
 */
async function withClaude<T>(
  o: { stdout?: string; version?: string },
  fn: (env: Env, calls: () => number, dump: string) => Promise<T>,
): Promise<T> {
  const dump = mkdtempSync(join(tmpdir(), 'warpline-pass-dump-'))
  homes.push(dump)
  return withFakeClaude(
    { stdout: o.stdout ?? claudeResult(TEXT, 0.0123), version: o.version ?? FLOOR_VERSION, dumpDir: dump },
    () => {
      const calls = () => {
        const p = join(dump, 'calls.txt')
        return existsSync(p) ? readFileSync(p, 'utf-8').split('\n').filter(Boolean).length : 0
      }
      return fn({ PATH: process.env.PATH }, calls, dump)
    },
  )
}

function run(home: string, parentEnv: Env, plugins: readonly string[] | null = null): Promise<pass.PassResult> {
  return withHome(home, () => pass.consumePass({ plugins, parentEnv }))
}

const record = (home: string) => readHandoff(join(home, 'handoffs'), 'run-1', 'prod')
const reserved = (home: string) => auditRecords(home, 'handoff.reserved').filter((d) => d.handoff === ID)
const tried = (home: string) => auditRecords(home, 'handoff.tried').filter((d) => d.handoff === ID)
/** Presence through lstat: a claim or lock is a link whose text names no file, so `existsSync` reads it as gone. */
const present = (p: string) => lstatSync(p, { throwIfNoEntry: false }) !== undefined
const judgmentPath = (home: string) => join(home, OUTPUT)
const sha256 = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf-8')).digest('hex')

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

/** The stub's 200: one choice, the model it served, and the cost in the gateway header. */
const ok200 = (content: string, served = OPENAI_MODEL, cost = '0.000123'): StubReply => ({
  status: 200,
  body: { model: served, choices: [{ message: { role: 'assistant', content } }] },
  headers: { 'x-litellm-response-cost': cost },
})

describe('one open Handoff answered end to end', () => {
  test('through the fake claude: the Judgment is the text byte for byte, the record is answered, and the try is on the audit record', async () => {
    const home = await makeHome({ consume: { model: MODEL } })
    await withClaude({}, async (env, calls) => {
      const r = await run(home, env)
      expect(r).toEqual({ ...EMPTY, answered: [ID] })
      expect(pass.exitCodeFor(r)).toBe(0)
      expect(calls()).toBe(1)
    })

    expect(readFileSync(judgmentPath(home))).toEqual(Buffer.from(TEXT, 'utf-8'))

    const rec = await record(home)
    expect(rec?.state).toBe('answered')
    expect(rec?.closed_at).not.toBeNull()
    expect(rec?.tries).toHaveLength(1)
    expect(rec?.tries?.[0]).toMatchObject({
      outcome: 'answered',
      requested: MODEL,
      served: MODEL,
      cost_micro_usd: 12300,
      cost_basis: 'reported',
      reason: null,
    })

    const lines = auditRecords(home).filter((l) => l.type.startsWith('warpline.audit.handoff.'))
    expect(lines.map((l) => l.type)).toEqual(['warpline.audit.handoff.reserved', 'warpline.audit.handoff.tried'])
    expect(lines[0]!.data).toMatchObject({ handoff: ID, amount_micro_usd: 0 })
    expect(lines[1]!.data).toMatchObject({
      handoff: ID,
      outcome: 'answered',
      requested: MODEL,
      served: MODEL,
      cost_micro_usd: 12300,
      cost_basis: 'reported',
      bytes: Buffer.byteLength(TEXT, 'utf-8'),
      sha256: sha256(TEXT),
    })
    expect(lines[1]!.data.reservation_id).toBe(lines[0]!.data.reservation_id)
    expect(rec?.tries?.[0]?.reservation_id).toBe(lines[0]!.data.reservation_id as string)

    // No claim, record lock or consume lock is left behind.
    expect(readdirSync(join(home, 'handoffs'))).toEqual([`${ID}.json`])
  })

  test('write-ahead: the handoff.tried line is stored before the Judgment is written', async () => {
    const home = await makeHome({ consume: { model: MODEL } })
    const seen = recordedBefore(fsAtomic as unknown as Record<string, unknown>, 'atomicWriteText', home, 'handoff.tried')
    await withClaude({}, async (env) => {
      expect((await run(home, env)).answered).toEqual([ID])
    })
    expect(seen()).toBe(true)
  })

  test('consume.models names the model for its plugin over consume.model', async () => {
    const home = await makeHome({ consume: { model: MODEL, models: { prod: 'claude-sonnet-5' } } })
    await withClaude({ stdout: claudeResult(TEXT, 0.0123, 'claude-sonnet-5') }, async (env, calls, dump) => {
      expect((await run(home, env)).answered).toEqual([ID])
      expect(calls()).toBe(1)
      const argv = readFileSync(join(dump, 'argv.txt'), 'utf-8').split('\n')
      expect(argv[argv.indexOf('--model') + 1]).toBe('claude-sonnet-5')
    })
    expect((await record(home))?.tries?.[0]).toMatchObject({ requested: 'claude-sonnet-5', served: 'claude-sonnet-5' })
  })

  test('through the openai-compatible stub: a 503 then a 200 is two calls under one reservation and one try', async () => {
    await withOpenAiStub([{ status: 503 }, ok200(TEXT)], async (stub) => {
      const home = await makeHome({ consume: { renderer: 'openai-compatible', endpoint: stub.url, model: OPENAI_MODEL } })
      const r = await run(home, { WARPLINE_CONSUME_API_KEY: 'test-key' })
      expect(r).toEqual({ ...EMPTY, answered: [ID] })
      expect(stub.calls()).toBe(2)
      expect(stub.auth()).toEqual(['Bearer test-key', 'Bearer test-key'])

      expect(readFileSync(judgmentPath(home))).toEqual(Buffer.from(TEXT, 'utf-8'))
      expect((await record(home))?.tries?.[0]).toMatchObject({
        outcome: 'answered',
        requested: OPENAI_MODEL,
        served: OPENAI_MODEL,
        cost_micro_usd: 123,
        cost_basis: 'reported',
      })
      const res = reserved(home)
      const tri = tried(home)
      expect(res).toHaveLength(1)
      expect(tri).toHaveLength(1)
      expect(tri[0]!.reservation_id).toBe(res[0]!.reservation_id)
    })
  })

  test('a served model outside the model-id shape is recorded as null, in the try and in handoff.tried', async () => {
    await withOpenAiStub([ok200(TEXT, 'bad model')], async (stub) => {
      const home = await makeHome({ consume: { renderer: 'openai-compatible', endpoint: stub.url, model: OPENAI_MODEL } })
      expect((await run(home, {})).answered).toEqual([ID])
      expect((await record(home))?.tries?.[0]).toMatchObject({ served: null })
      expect(tried(home)[0]).toMatchObject({ served: null })
    })
  })
})

describe('refusals that need no claim add no try', () => {
  test('a Handoff with no output_path is refused by name, with no reservation and no call', async () => {
    const home = await makeHome({ consume: { model: MODEL } }, { output_path: null })
    await withClaude({}, async (env, calls) => {
      const r = await run(home, env)
      expect(r).toEqual({ ...EMPTY, refused: [{ id: ID, reason: 'the Handoff names no output_path' }] })
      expect(pass.exitCodeFor(r)).toBe(1)
      expect(calls()).toBe(0)
    })
    expect(reserved(home)).toEqual([])
    expect(await record(home)).toMatchObject({ state: 'open', tries: [] })
  })

  test('an unset model is refused by name with no call', async () => {
    const home = await makeHome({})
    await withClaude({}, async (env, calls) => {
      const r = await run(home, env)
      expect(r.refused).toEqual([{ id: ID, reason: 'consume.model is not set' }])
      expect(pass.exitCodeFor(r)).toBe(1)
      expect(calls()).toBe(0)
    })
    expect(reserved(home)).toEqual([])
  })

  for (const [name, prices] of [
    ['no consume.prices', undefined],
    ['consume.prices without the requested model', { 'other-model': { usd_per_mtok_in: 1, usd_per_mtok_out: 2 } }],
  ] as const) {
    test(`with a spend cap set and ${name}, the openai-compatible Handoff is refused before any reservation or call`, async () => {
      await withOpenAiStub([ok200(TEXT)], async (stub) => {
        const home = await makeHome({
          consume: {
            renderer: 'openai-compatible',
            endpoint: stub.url,
            model: OPENAI_MODEL,
            max_usd_per_call: 0.01,
            ...(prices === undefined ? {} : { prices }),
          },
        })
        const r = await run(home, {})
        expect(r).toEqual({
          ...EMPTY,
          refused: [{ id: ID, reason: 'no cost basis under a spend cap: the model has no consume.prices entry' }],
        })
        expect(pass.exitCodeFor(r)).toBe(1)
        expect(stub.calls()).toBe(0)
        expect(reserved(home)).toEqual([])
        expect(await record(home)).toMatchObject({ state: 'open', tries: [] })
      })
    })
  }
})

describe('a pass with nothing to do', () => {
  test('no handoffs directory is an empty result with no call', async () => {
    const home = mkdtempSync(join(tmpdir(), 'warpline-pass-'))
    homes.push(home)
    writeFileSync(join(home, 'preferences.json'), JSON.stringify({ consume: { model: MODEL } }))
    await withClaude({}, async (env, calls) => {
      const r = await run(home, env)
      expect(r).toEqual(EMPTY)
      expect(pass.exitCodeFor(r)).toBe(0)
      expect(calls()).toBe(0)
    })
  })

  test('a plugin filter that names no open Handoff processes nothing', async () => {
    const home = await makeHome({ consume: { model: MODEL } })
    await withClaude({}, async (env, calls) => {
      const r = await run(home, env, ['other'])
      expect(r).toEqual(EMPTY)
      expect(pass.exitCodeFor(r)).toBe(0)
      expect(calls()).toBe(0)
    })
    expect(await record(home)).toMatchObject({ state: 'open', tries: [] })
  })
})

describe('the claude-code renderer must be there and new enough', () => {
  test('a claude below the floor refuses the pass, naming both versions, with no call', async () => {
    const home = await makeHome({ consume: { model: MODEL } })
    await withClaude({ version: '2.1.304 (Claude Code)' }, async (env, calls) => {
      const r = await run(home, env)
      expect(r.refusal).toContain('2.1.304')
      expect(r.refusal).toContain('2.1.305')
      expect(r.answered).toEqual([])
      expect(pass.exitCodeFor(r)).toBe(1)
      expect(calls()).toBe(0)
    })
    expect(await record(home)).toMatchObject({ state: 'open', tries: [] })
    expect(reserved(home)).toEqual([])
  })

  test('no claude on PATH refuses the pass by name', async () => {
    const home = await makeHome({ consume: { model: MODEL } })
    const empty = mkdtempSync(join(tmpdir(), 'warpline-pass-path-'))
    homes.push(empty)
    const r = await run(home, { PATH: empty })
    expect(r.refusal).toBe('claude was not found on PATH')
    expect(pass.exitCodeFor(r)).toBe(1)
  })
})

describe('a try that cannot be recorded, or fails', () => {
  test('a refused handoff.tried append writes no Judgment and no try, and leaves the reservation open', async () => {
    const home = await makeHome({ consume: { model: MODEL } })
    const fail = failAppendOnce('handoff.tried')
    await withClaude({}, async (env, calls) => {
      const r = await run(home, env)
      expect(r).toEqual({ ...EMPTY, refused: [{ id: ID, reason: 'the audit store could not record the try' }] })
      expect(pass.exitCodeFor(r)).toBe(1)
      expect(calls()).toBe(1)
    })
    expect(fail.trips()).toBe(1)
    expect(existsSync(judgmentPath(home))).toBe(false)
    expect(await record(home)).toMatchObject({ state: 'open', tries: [] })
    expect(reserved(home)).toHaveLength(1)
    expect(tried(home)).toEqual([])
    expect(present(join(home, 'handoffs', `${ID}.claim`))).toBe(false)
  })

  test('a renderer api_error is a failed try on the record and on the audit store, with no Judgment', async () => {
    const home = await makeHome({ consume: { model: MODEL } })
    const stdout = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: true,
      terminal_reason: 'api_error',
      result: 'API Error',
      total_cost_usd: 0,
      modelUsage: {},
    })
    await withClaude({ stdout }, async (env) => {
      const r = await run(home, env)
      expect(r).toEqual({ ...EMPTY, failed: [{ id: ID, reason: 'the provider was not reachable' }] })
      expect(pass.exitCodeFor(r)).toBe(1)
    })
    expect(existsSync(judgmentPath(home))).toBe(false)
    const rec = await record(home)
    expect(rec?.state).toBe('open')
    expect(rec?.tries).toHaveLength(1)
    expect(rec?.tries?.[0]).toMatchObject({ outcome: 'failed', reason: 'the provider was not reachable' })
    expect(tried(home)).toHaveLength(1)
    expect(tried(home)[0]).toMatchObject({ outcome: 'failed', bytes: null, sha256: null })
  })
})

describe('a Handoff another consumer has, or that closed after the listing', () => {
  test('a claim another live consumer holds is held, with no call and no change to the exit code', async () => {
    const home = await makeHome({ consume: { model: MODEL } })
    const dir = join(home, 'handoffs')
    const mine = claim.claimHandoff(dir, ID)
    if (!mine.claimed) throw new Error('fixture: the planted claim was not taken')
    try {
      await withClaude({}, async (env, calls) => {
        const r = await run(home, env)
        expect(r).toEqual({ ...EMPTY, held: [ID] })
        expect(pass.exitCodeFor(r)).toBe(0)
        expect(calls()).toBe(0)
      })
    } finally {
      claim.releaseClaim(dir, ID, mine.token)
    }
    expect(reserved(home)).toEqual([])
  })

  /** Rewrite the record as `state` just before the pass claims it, then claim for real. */
  function closeAtClaim(state: string): void {
    const real = claim.claimHandoff
    spies.push(
      spyOn(claim, 'claimHandoff').mockImplementation((dir: string, id: string) => {
        const p = join(dir, `${id}.json`)
        const rec = JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>
        writeFileSync(p, JSON.stringify({ ...rec, state, closed_at: new Date().toISOString() }))
        return real(dir, id)
      }),
    )
  }

  test('a record withdrawn between the listing and the re-read is skipped as no longer open, never held', async () => {
    const home = await makeHome({ consume: { model: MODEL } })
    closeAtClaim('withdrawn')
    await withClaude({}, async (env, calls) => {
      const r = await run(home, env)
      expect(r).toEqual({ ...EMPTY, skipped: [{ id: ID, reason: 'the Handoff is no longer open' }] })
      expect(r.held).toEqual([])
      expect(pass.exitCodeFor(r)).toBe(1)
      expect(calls()).toBe(0)
    })
    expect(reserved(home)).toEqual([])
    expect(await record(home)).toMatchObject({ state: 'withdrawn', tries: [] })
    expect(present(join(home, 'handoffs', `${ID}.claim`))).toBe(false)
  })

  test('a record another consumer answered after the listing gets no entry and leaves the exit code at 0', async () => {
    const home = await makeHome({ consume: { model: MODEL } })
    closeAtClaim('answered')
    await withClaude({}, async (env, calls) => {
      const r = await run(home, env)
      expect(r).toEqual(EMPTY)
      expect(pass.exitCodeFor(r)).toBe(0)
      expect(calls()).toBe(0)
    })
    expect(reserved(home)).toEqual([])
    expect(present(join(home, 'handoffs', `${ID}.claim`))).toBe(false)
  })
})

describe('exitCodeFor', () => {
  test('is 0 only with no pass refusal and no failed, refused, skipped, discarded or unreadable entry', () => {
    expect(pass.exitCodeFor(EMPTY)).toBe(0)
    expect(pass.exitCodeFor({ ...EMPTY, answered: [ID], held: ['x.prod'] })).toBe(0)
    const one = { id: ID, reason: 'r' }
    for (const r of [
      { ...EMPTY, refusal: 'r' },
      { ...EMPTY, failed: [one] },
      { ...EMPTY, refused: [one] },
      { ...EMPTY, skipped: [one] },
      { ...EMPTY, discarded: [ID] },
      { ...EMPTY, unreadable: [`${ID}.json`] },
    ]) {
      expect(pass.exitCodeFor(r)).toBe(1)
    }
  })
})

