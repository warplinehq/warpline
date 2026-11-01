/**
 * `warpline consume` through the real dispatcher: its flags, its one document
 * and the exit codes a scheduler alerts on (runtime-spec § 17, SPEC R12).
 *
 * Every case gets its own temp home (AGENTS.md Rule 2). No case reaches a
 * real provider: the fake `claude` is first on PATH, and the verb hands
 * `process.env` to the pass, whose allowlisted child env carries that PATH.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withFakeClaude } from '../../../test-utils/fake-claude.js'
import { readHandoff, writeHandoff } from '../../lib/handoffs.js'
import { capture, makeVerbHome, type VerbHome } from './helpers/verb-home.js'

const MODEL = 'claude-opus-5'
const FLOOR = '2.1.305 (Claude Code)'
const TEXT = 'JUDGMENT_TEXT_SENTINEL the judgment'

const homes: VerbHome[] = []
const dumps: string[] = []

afterEach(() => {
  for (const h of homes.splice(0)) h.cleanup()
  for (const d of dumps.splice(0)) rmSync(d, { recursive: true, force: true })
})

function home(): VerbHome {
  const h = makeVerbHome()
  homes.push(h)
  return h
}

/** Rewrite `preferences.json`, keeping the review gate off. */
function prefs(h: VerbHome, consume: Record<string, unknown>): void {
  writeFileSync(join(h.home, 'preferences.json'), JSON.stringify({ review_gate: false, consume }))
}

/** One open Handoff, `<run>.<plugin>`, with an output path. */
function handoff(h: VerbHome, run: string, plugin: string): Promise<unknown> {
  return writeHandoff(join(h.home, 'handoffs'), {
    run_id: run,
    plugin,
    task: 'Judge it',
    context_path: null,
    output_path: `judgments/${run}.${plugin}.judgment.md`,
  })
}

function result(usd: number): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: TEXT,
    total_cost_usd: usd,
    modelUsage: { [MODEL]: {} },
  })
}

/** The fake `claude` on PATH for `fn`, with a count of renderer calls (a `--version` probe is not one). */
async function withClaude<T>(o: { version?: string; usd?: number }, fn: (calls: () => number) => Promise<T>): Promise<T> {
  const dump = mkdtempSync(join(tmpdir(), 'warpline-consume-dump-'))
  dumps.push(dump)
  return withFakeClaude({ stdout: result(o.usd ?? 0.0123), version: o.version ?? FLOOR, dumpDir: dump }, () =>
    fn(() => {
      const p = join(dump, 'calls.txt')
      return existsSync(p) ? readFileSync(p, 'utf-8').split('\n').filter(Boolean).length : 0
    }),
  )
}

type Doc = {
  answered: string[]
  failed: { id: string; reason: string }[]
  refused: { id: string; reason: string }[]
  skipped: { id: string; reason: string }[]
  discarded: string[]
  held: string[]
  unreadable: string[]
  refusal: string | null
}

/** stdout under `--json`: exactly one newline-terminated line, parsed. */
function oneDocument(stdout: string): Doc {
  expect(stdout.endsWith('\n')).toBe(true)
  expect(stdout.slice(0, -1).includes('\n')).toBe(false)
  return JSON.parse(stdout) as Doc
}

describe('warpline consume', () => {
  test('--json answers one open Handoff, prints one document naming it, and exits 0', async () => {
    const h = home()
    prefs(h, { model: MODEL })
    await handoff(h, 'run-1', 'prod')
    await withClaude({}, async (calls) => {
      const r = await capture(['consume', '--json'])
      expect(r.stderr).toBe('')
      expect(r.code).toBe(0)
      const doc = oneDocument(r.stdout)
      expect(doc.answered).toEqual(['run-1.prod'])
      expect(doc.refusal).toBeNull()
      expect(calls()).toBe(1)
    })
    expect((await readHandoff(join(h.home, 'handoffs'), 'run-1', 'prod'))?.state).toBe('answered')
  })

  test('the human summary names the answered id and carries no Judgment text', async () => {
    const h = home()
    prefs(h, { model: MODEL })
    await handoff(h, 'run-1', 'prod')
    await withClaude({}, async () => {
      const r = await capture(['consume'])
      expect(r.code).toBe(0)
      expect(r.stdout).toContain('answered run-1.prod')
      expect(r.stdout).not.toContain('JUDGMENT_TEXT_SENTINEL')
      expect(r.stdout).not.toContain(MODEL)
    })
  })

  test('with no handoffs directory it exits 0 and calls no model', async () => {
    const h = home()
    prefs(h, { model: MODEL })
    expect(existsSync(join(h.home, 'handoffs'))).toBe(false)
    await withClaude({}, async (calls) => {
      const r = await capture(['consume'])
      expect(r.code).toBe(0)
      expect(r.stderr).toBe('')
      expect(r.stdout).toBe('Nothing to do.\n')
      expect(calls()).toBe(0)
    })
  })

  test('an unknown flag (--yes) exits 2 with the usage on stderr and nothing on stdout', async () => {
    home()
    const r = await capture(['consume', '--yes'])
    expect(r.code).toBe(2)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('--yes')
    expect(r.stderr).toContain('Usage: warpline consume')
  })

  test('a positional exits 2', async () => {
    home()
    const r = await capture(['consume', 'foo'])
    expect(r.code).toBe(2)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('Usage: warpline consume')
  })

  test('a --plugin value that is not a plugin name exits 2, and stderr does not echo it', async () => {
    home()
    const r = await capture(['consume', '--plugin', 'Bad!'])
    expect(r.code).toBe(2)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('--plugin takes a plugin name')
    expect(r.stderr).not.toContain('Bad!')
  })

  test('one answered and one left open by a spent window cap exits 1, naming consume.max_usd_per_window', async () => {
    const h = home()
    prefs(h, { model: MODEL, max_usd_per_call: 0.01, max_usd_per_window: 0.01 })
    // Two plugins: a second Handoff for the same plugin would supersede the first.
    await handoff(h, 'run-1', 'prod')
    await handoff(h, 'run-2', 'other')
    await withClaude({ usd: 0.01 }, async () => {
      const r = await capture(['consume', '--json'])
      expect(r.code).toBe(1)
      const doc = oneDocument(r.stdout)
      expect(doc.answered).toHaveLength(1)
      expect(doc.refused).toHaveLength(1)
      expect(doc.refused[0]?.reason).toContain('consume.max_usd_per_window')
      const [refusedRun, refusedPlugin] = (doc.refused[0]?.id ?? '').split('.') as [string, string]
      expect((await readHandoff(join(h.home, 'handoffs'), refusedRun, refusedPlugin))?.state).toBe('open')
      // P6: the summary carries ids, fixed reasons and counts, never a configured value.
      expect(r.stdout).not.toContain(MODEL)
      expect(r.stdout).not.toContain('JUDGMENT_TEXT_SENTINEL')
    })
  })

  test('a pass that cannot run writes nothing on stdout under --json, exits 1 and names the floor on stderr', async () => {
    const h = home()
    prefs(h, { model: MODEL })
    await handoff(h, 'run-1', 'prod')
    await withClaude({ version: '2.1.304 (Claude Code)' }, async (calls) => {
      const r = await capture(['consume', '--json'])
      expect(r.code).toBe(1)
      expect(r.stdout).toBe('')
      expect(r.stderr).toContain('2.1.305')
      expect(calls()).toBe(0)
    })
  })

  test('a repeated --plugin narrows the pass to those plugins', async () => {
    const h = home()
    prefs(h, { model: MODEL })
    await handoff(h, 'run-1', 'prod')
    await handoff(h, 'run-2', 'other')
    await handoff(h, 'run-3', 'third')
    await withClaude({}, async (calls) => {
      const r = await capture(['consume', '--plugin', 'prod', '--plugin', 'other', '--json'])
      expect(r.code).toBe(0)
      expect(oneDocument(r.stdout).answered.sort()).toEqual(['run-1.prod', 'run-2.other'])
      expect(calls()).toBe(2)
    })
    expect((await readHandoff(join(h.home, 'handoffs'), 'run-3', 'third'))?.state).toBe('open')
  })

  test('an unreadable record exits 1 under --plugin too, whatever plugin its name suggests', async () => {
    const h = home()
    prefs(h, { model: MODEL })
    await handoff(h, 'run-1', 'prod')
    mkdirSync(join(h.home, 'handoffs'), { recursive: true })
    writeFileSync(join(h.home, 'handoffs', 'run-9.other.json'), '{not json')
    await withClaude({}, async () => {
      const r = await capture(['consume', '--plugin', 'prod', '--json'])
      expect(r.code).toBe(1)
      const doc = oneDocument(r.stdout)
      expect(doc.answered).toEqual(['run-1.prod'])
      expect(doc.unreadable).toEqual(['run-9.other.json'])
    })
  })
})
