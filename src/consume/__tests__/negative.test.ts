/**
 * No Judgment text and no operator value reaches a surface a pass writes.
 *
 * A pass writes the audit store, the board log, the Handoff records, a human
 * summary or a `--json` document, and stderr. None of them may carry the
 * Judgment's text: only its byte count and sha256 appear, on the
 * `handoff.tried` line. None of them may carry a configured value: the
 * endpoint, the credential, a price-table number or the `run_as` name. A cost
 * worked out from the price table is recorded as `computed`, never as
 * `reported`.
 *
 * `consume.renderer` is one global key, so each renderer gets its own home,
 * and each runs once per output mode through the real verb. The claude-code
 * home answers `a` under a mismatch notice and refuses `b` with the reason the
 * real run_as probe builds: the probe runs as shipped, handed a stub runner
 * that answers yes to every `test`, so no sudo is run. The openai home answers
 * `c` under a per-call cap at a price-table cost, under a mismatch notice.
 *
 * Every scan is preceded by positive controls, so no scan passes over a
 * surface that was never written. The Judgment file and `preferences.json`
 * hold these values by design and are not surfaces. No case reaches a real
 * provider: the fake `claude` or the local stub answers.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { withFakeClaude } from '../../../test-utils/fake-claude.js'
import { withOpenAiStub } from '../../../test-utils/openai-stub.js'
import { auditRecords, capture, makeVerbHome, type VerbHome } from '../../cli/__tests__/helpers/verb-home.js'
import { writeHandoff } from '../../lib/handoffs.js'
import { eventsJsonlPath } from '../../lib/paths.js'
import * as runAs from '../run-as.js'

const TEXT = 'JUDGMENT-SENTINEL-5c1e'
const RUN_AS = 'sentinelrunas'
const API_KEY = 'sentinel-key-77aa'
const PRICE_IN = 7.654321
const PRICE_OUT = 8.765432
const SERVED = 'x-20261001'
const FLOOR_VERSION = '2.1.305 (Claude Code)'
const KEY_ENV = 'WARPLINE_CONSUME_API_KEY'

const homes: VerbHome[] = []
const spies: Array<{ mockRestore: () => void }> = []

afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore()
  for (const h of homes.splice(0)) h.cleanup()
  delete process.env[KEY_ENV]
})

/** A fresh verb home holding one open Handoff per plugin, with `consume` added to its preferences. */
async function makeHome(plugins: string[], consume: Record<string, unknown>): Promise<VerbHome> {
  const h = makeVerbHome()
  homes.push(h)
  for (const plugin of plugins) {
    await writeHandoff(join(h.home, 'handoffs'), {
      run_id: 'run-1',
      plugin,
      task: `Judge ${plugin}`,
      context_path: null,
      output_path: `state/${plugin}.judgment.md`,
    })
  }
  writeFileSync(join(h.home, 'preferences.json'), JSON.stringify({ review_gate: false, consume }))
  return h
}

/** Every Handoff record file under the home. */
const recordFiles = (home: string): string[] =>
  readdirSync(join(home, 'handoffs'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => join(home, 'handoffs', f))

/** Every audit segment under the home. */
const auditSegments = (home: string): string[] =>
  readdirSync(join(home, 'audit'))
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => join(home, 'audit', f))

const mismatchNotices = (): unknown[] =>
  readFileSync(eventsJsonlPath(), 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { metadata_json?: unknown })
    .filter((e) => typeof e.metadata_json === 'string' && (JSON.parse(e.metadata_json) as { event?: unknown }).event === 'model_mismatch')

/** The named surfaces a pass wrote, each as raw text. */
function surfaces(home: string, out: { stdout: string; stderr: string }): Array<[string, string]> {
  return [
    ...auditSegments(home).map((p): [string, string] => [p, readFileSync(p, 'utf-8')]),
    [eventsJsonlPath(), readFileSync(eventsJsonlPath(), 'utf-8')],
    ...recordFiles(home).map((p): [string, string] => [p, readFileSync(p, 'utf-8')]),
    ['stdout', out.stdout],
    ['stderr', out.stderr],
  ]
}

/** Each `[surface, sentinel]` pair where the surface carries the sentinel. */
const leaks = (all: Array<[string, string]>, sentinels: readonly string[]): string[] =>
  all.flatMap(([name, text]) => sentinels.filter((s) => text.includes(s)).map((s) => `${name} carries ${s}`))

/** P1: every answered `handoff.tried` line carries the text's byte count and sha256. */
function expectHashedOnly(home: string, ids: string[]): void {
  const bytes = Buffer.from(TEXT, 'utf-8')
  const answered = auditRecords(home, 'handoff.tried').filter((d) => d.outcome === 'answered')
  expect(answered.map((d) => d.handoff).sort()).toEqual(ids)
  for (const d of answered) {
    expect(d.bytes).toBe(bytes.length)
    expect(d.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
  }
}

describe('a claude-code pass that answers, mismatches and refuses leaks no text and no run_as name', () => {
  test.each([['the human summary', false], ['--json', true]] as const)('through %s', async (_mode, json) => {
    const h = await makeHome(['a', 'b'], { model: 'x', tools: { b: ['Read'] }, run_as: RUN_AS })

    // The real probe body, handed a runner that records each argv and answers 0 to every `test`.
    const argvs: string[][] = []
    const real = runAs.judgeCannotEnterHome
    const spy = spyOn(runAs, 'judgeCannotEnterHome').mockImplementation((user: string, home: string) =>
      real(user, home, async (argv) => {
        argvs.push(argv)
        return 0
      }),
    )
    spies.push(spy)

    const dump = join(h.home, 'fake-claude-dump')
    mkdirSync(dump)
    const stdout = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: TEXT,
      total_cost_usd: 0.0123,
      modelUsage: { [SERVED]: {} },
    })
    const out = await withFakeClaude({ stdout, version: FLOOR_VERSION, dumpDir: dump }, () =>
      capture(json ? ['consume', '--json'] : ['consume']),
    )

    // Positive controls, before any scan.
    expect(out.code).toBe(1)
    let refusedB: string | undefined
    if (json) {
      const doc = JSON.parse(out.stdout) as { answered: string[]; refused: Array<{ id: string; reason: string }> }
      expect(doc.answered).toEqual(['run-1.a'])
      refusedB = doc.refused.find((e) => e.id === 'run-1.b')?.reason
    } else {
      expect(out.stdout.split('\n')).toContain('answered run-1.a')
      refusedB = out.stdout.split('\n').find((l) => l.startsWith('refused run-1.b: '))?.slice('refused run-1.b: '.length)
    }
    expect(refusedB).toContain('can enter the home')
    expect(readFileSync(join(h.home, 'state', 'a.judgment.md'), 'utf-8')).toBe(TEXT)
    expect(argvs.length).toBeGreaterThan(0)
    for (const argv of argvs) expect(argv[3]).toBe(RUN_AS)
    expect(readFileSync(join(dump, 'calls.txt'), 'utf-8').split('\n').filter(Boolean)).toHaveLength(1)
    expect(mismatchNotices()).toHaveLength(1)
    expect(auditSegments(h.home).length).toBeGreaterThan(0)
    expect(recordFiles(h.home)).toHaveLength(2)
    expect(out.stdout.length).toBeGreaterThan(0)

    // P1 and P6.
    expect(leaks(surfaces(h.home, out), [TEXT, RUN_AS])).toEqual([])
    expectHashedOnly(h.home, ['run-1.a'])
  })
})

describe('an openai-compatible pass under a per-call cap leaks no text and no configured value, and its cost is computed', () => {
  test.each([['the human summary', false], ['--json', true]] as const)('through %s', async (_mode, json) => {
    process.env[KEY_ENV] = API_KEY
    const reply = {
      status: 200,
      body: {
        model: SERVED,
        choices: [{ message: { content: TEXT } }],
        usage: { prompt_tokens: 1000, completion_tokens: 1000 },
      },
    }
    await withOpenAiStub([reply], async (stub) => {
      const h = await makeHome(['c'], {
        renderer: 'openai-compatible',
        model: 'x',
        endpoint: stub.url,
        max_usd_per_call: 0.5,
        prices: { x: { usd_per_mtok_in: PRICE_IN, usd_per_mtok_out: PRICE_OUT } },
      })
      const out = await capture(json ? ['consume', '--json'] : ['consume'])

      // Positive controls, before any scan.
      expect(out.code).toBe(0)
      if (json) expect((JSON.parse(out.stdout) as { answered: string[] }).answered).toEqual(['run-1.c'])
      else expect(out.stdout.split('\n')).toContain('answered run-1.c')
      expect(readFileSync(join(h.home, 'state', 'c.judgment.md'), 'utf-8')).toBe(TEXT)
      expect(stub.calls()).toBe(1)
      expect(stub.auth()).toEqual([`Bearer ${API_KEY}`])
      expect(mismatchNotices()).toHaveLength(1)
      expect(auditSegments(h.home).length).toBeGreaterThan(0)
      expect(recordFiles(h.home)).toHaveLength(1)
      expect(out.stdout.length).toBeGreaterThan(0)

      // P1 and P6.
      const host = new URL(stub.url).host
      expect(leaks(surfaces(h.home, out), [TEXT, host, API_KEY, String(PRICE_IN), String(PRICE_OUT)])).toEqual([])
      expectHashedOnly(h.home, ['run-1.c'])

      // P2: the price-table cost is computed, under the cap that was in force.
      const record = JSON.parse(readFileSync(recordFiles(h.home)[0]!, 'utf-8')) as { tries: Array<Record<string, unknown>> }
      const tried = auditRecords(h.home, 'handoff.tried')
      expect(record.tries).toHaveLength(1)
      expect(tried).toHaveLength(1)
      for (const t of [record.tries[0]!, tried[0]!]) {
        expect(t.cost_micro_usd).toBe(16420)
        expect(t.cost_basis).toBe('computed')
      }
      expect(auditRecords(h.home, 'handoff.reserved').map((d) => d.amount_micro_usd)).toEqual([500000])
      expect([...record.tries, ...tried].filter((t) => t.cost_basis === 'reported')).toEqual([])
    })
  })
})
