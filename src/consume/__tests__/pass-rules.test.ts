/**
 * What a try sends, where its Judgment may go, and when trying stops.
 *
 * The context rules (SPEC R3): the prompt is the task alone, or the task, a
 * blank line and the context file's text. The file must realpath inside the
 * home, be at most 8 MiB and be UTF-8, or the Handoff is refused with no call.
 *
 * The output rule (Pitfall 9): the Judgment's directory must realpath inside
 * the home before it is made, after it is made, and again at write time.
 *
 * The answer rules (SPEC R9): a successful try's text is non-empty after
 * trimming and at most `consume.max_output_bytes` UTF-8 bytes, and a Handoff
 * stops being tried after `consume.max_tries` counted tries.
 *
 * Every case gets its own temp home, and a target outside the home is its own
 * temp dir. No case reaches a real provider: the fake `claude` answers, and
 * the pass is handed an explicit parent env.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withFakeClaude } from '../../../test-utils/fake-claude.js'
import { auditRecords } from '../../cli/__tests__/helpers/verb-home.js'
import { readHandoff, settleTry, writeHandoff, type HandoffInput, type TryOutcome } from '../../lib/handoffs.js'
import { withHome } from '../../lib/paths.js'
import * as claim from '../claim.js'
import * as pass from '../pass.js'

const ID = 'run-1.prod'
const OUTPUT = 'state/prod.judgment.md'
const MODEL = 'claude-opus-5'
const FLOOR_VERSION = '2.1.305 (Claude Code)'

type Env = Record<string, string | undefined>

const dirs: string[] = []
const spies: Array<{ mockRestore: () => void }> = []

afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const temp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

/** A temp home holding one open Handoff and the given preferences. */
async function makeHome(prefs: unknown, input: Partial<HandoffInput> = {}): Promise<string> {
  const home = temp('warpline-rules-')
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

function claudeResult(text: string, usd = 0.0123): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: text,
    total_cost_usd: usd,
    modelUsage: { [MODEL]: {} },
  })
}

/** The fake `claude` for `fn`, with a parent env carrying its PATH, a count of renderer calls, and the stdin it got. */
async function withClaude<T>(
  o: { text?: string; before?: string },
  fn: (env: Env, calls: () => number, stdin: () => string) => Promise<T>,
): Promise<T> {
  const dump = temp('warpline-rules-dump-')
  return withFakeClaude(
    { stdout: claudeResult(o.text ?? 'the judgment'), version: FLOOR_VERSION, dumpDir: dump, before: o.before },
    () => {
      const calls = () => {
        const p = join(dump, 'calls.txt')
        return existsSync(p) ? readFileSync(p, 'utf-8').split('\n').filter(Boolean).length : 0
      }
      return fn({ PATH: process.env.PATH }, calls, () => readFileSync(join(dump, 'stdin.txt'), 'utf-8'))
    },
  )
}

const run = (home: string, parentEnv: Env): Promise<pass.PassResult> =>
  withHome(home, () => pass.consumePass({ plugins: null, parentEnv }))

const record = (home: string) => readHandoff(join(home, 'handoffs'), 'run-1', 'prod')
const reserved = (home: string) => auditRecords(home, 'handoff.reserved').filter((d) => d.handoff === ID)
const tried = (home: string) => auditRecords(home, 'handoff.tried').filter((d) => d.handoff === ID)
/** Presence through lstat: a claim is a link whose text names no file, so `existsSync` reads it as gone. */
const present = (p: string) => lstatSync(p, { throwIfNoEntry: false }) !== undefined
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex')

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

/** Append one prior try with `outcome` to the open record, through the record's own settle. */
async function priorTry(home: string, outcome: TryOutcome): Promise<void> {
  const t = {
    at: new Date().toISOString(),
    reservation_id: `urn:uuid:00000000-0000-4000-8000-00000000000${outcome.length % 10}`,
    requested: MODEL,
    served: null,
    cost_micro_usd: null,
    cost_basis: 'unknown' as const,
    outcome,
    reason: outcome === 'answered' ? null : 'a prior try',
  }
  await settleTry(
    join(home, 'handoffs'),
    ID,
    async () => ({ try: t, close: false }),
    async () => t,
  )
}

describe('what a try sends', () => {
  test('tracer: with context_path null the renderer stdin is the task alone, byte for byte, and the Handoff is answered', async () => {
    const home = await makeHome({ consume: { model: MODEL } })
    await withClaude({}, async (env, calls, stdin) => {
      expect(await run(home, env)).toEqual({ ...EMPTY, answered: [ID] })
      expect(calls()).toBe(1)
      expect(stdin()).toBe('Judge it')
    })
    expect((await record(home))?.state).toBe('answered')
  })

  test('a relative context_path joins the home: stdin is the task, a blank line, then the file text', async () => {
    const home = await makeHome({ consume: { model: MODEL } }, { context_path: 'state/ctx.txt' })
    mkdirSync(join(home, 'state'), { recursive: true })
    writeFileSync(join(home, 'state', 'ctx.txt'), 'abc')
    await withClaude({}, async (env, _calls, stdin) => {
      expect((await run(home, env)).answered).toEqual([ID])
      expect(stdin()).toBe('Judge it\n\nabc')
    })
  })

  test('an absolute context_path inside the home is used as written', async () => {
    const home = temp('warpline-rules-abs-')
    mkdirSync(join(home, 'state'), { recursive: true })
    writeFileSync(join(home, 'state', 'ctx.txt'), 'abc')
    await writeHandoff(join(home, 'handoffs'), {
      run_id: 'run-1',
      plugin: 'prod',
      task: 'Judge it',
      context_path: join(home, 'state', 'ctx.txt'),
      output_path: OUTPUT,
    })
    writeFileSync(join(home, 'preferences.json'), JSON.stringify({ consume: { model: MODEL } }))
    await withClaude({}, async (env, _calls, stdin) => {
      expect((await run(home, env)).answered).toEqual([ID])
      expect(stdin()).toBe('Judge it\n\nabc')
    })
  })
})

describe('a context file the pass will not send is refused, with no reservation and no call', () => {
  /** Run one refusal case: the Handoff is refused with `reason`, nothing is reserved or called, and the record is untouched. */
  async function refusedWith(home: string, reason: string): Promise<void> {
    await withClaude({}, async (env, calls) => {
      const r = await run(home, env)
      expect(r).toEqual({ ...EMPTY, refused: [{ id: ID, reason }] })
      expect(pass.exitCodeFor(r)).toBe(1)
      expect(calls()).toBe(0)
    })
    expect(reserved(home)).toEqual([])
    expect(await record(home)).toMatchObject({ state: 'open', tries: [] })
  }

  test('an absolute context path outside the home: the context path resolves outside the home', async () => {
    const outside = temp('warpline-rules-outside-')
    writeFileSync(join(outside, 'secret.txt'), 'not yours')
    const home = await makeHome({ consume: { model: MODEL } }, { context_path: join(outside, 'secret.txt') })
    await refusedWith(home, 'the context path resolves outside the home')
  })

  test('/etc/hosts: the context path resolves outside the home', async () => {
    const home = await makeHome({ consume: { model: MODEL } }, { context_path: '/etc/hosts' })
    await refusedWith(home, 'the context path resolves outside the home')
  })

  test('an in-home symlink to a file outside: the context path resolves outside the home', async () => {
    const outside = temp('warpline-rules-outside-')
    writeFileSync(join(outside, 'secret.txt'), 'not yours')
    const home = await makeHome({ consume: { model: MODEL } }, { context_path: 'state/ctx.txt' })
    mkdirSync(join(home, 'state'), { recursive: true })
    symlinkSync(join(outside, 'secret.txt'), join(home, 'state', 'ctx.txt'))
    await refusedWith(home, 'the context path resolves outside the home')
  })

  test('a missing file: the context file is missing', async () => {
    const home = await makeHome({ consume: { model: MODEL } }, { context_path: 'state/none.txt' })
    await refusedWith(home, 'the context file is missing')
  })

  test('bytes ff fe 41: the context file is not UTF-8', async () => {
    const home = await makeHome({ consume: { model: MODEL } }, { context_path: 'state/ctx.bin' })
    mkdirSync(join(home, 'state'), { recursive: true })
    writeFileSync(join(home, 'state', 'ctx.bin'), Buffer.from([0xff, 0xfe, 0x41]))
    await refusedWith(home, 'the context file is not UTF-8')
  })

  test('8 MiB and one byte: the context file is over 8 MiB', async () => {
    expect(pass.CONTEXT_MAX_BYTES).toBe(8 * 1024 * 1024)
    const home = await makeHome({ consume: { model: MODEL } }, { context_path: 'state/big.txt' })
    mkdirSync(join(home, 'state'), { recursive: true })
    writeFileSync(join(home, 'state', 'big.txt'), Buffer.alloc(8 * 1024 * 1024 + 1, 0x61))
    await refusedWith(home, 'the context file is over 8 MiB')
  })
})

describe('the Judgment is written only inside the home', () => {
  for (const output of ['state/out/j.md', 'state/out/sub/j.md']) {
    test(`output_path ${output} under a symlink to a dir outside: output_path resolves outside the home, and nothing is made there`, async () => {
      const outside = temp('warpline-rules-outside-')
      const home = await makeHome({ consume: { model: MODEL } }, { output_path: output })
      mkdirSync(join(home, 'state'), { recursive: true })
      symlinkSync(outside, join(home, 'state', 'out'))
      await withClaude({}, async (env, calls) => {
        const r = await run(home, env)
        expect(r).toEqual({ ...EMPTY, refused: [{ id: ID, reason: 'output_path resolves outside the home' }] })
        expect(calls()).toBe(0)
      })
      expect(readdirSync(outside)).toEqual([])
      expect(reserved(home)).toEqual([])
      expect(await record(home)).toMatchObject({ state: 'open', tries: [] })
    })
  }

  test('an output_path that climbs out of the home with ..: output_path resolves outside the home', async () => {
    const escaped = `warpline-rules-escaped-${process.pid}-${Date.now()}`
    dirs.push(join(tmpdir(), escaped))
    const home = await makeHome({ consume: { model: MODEL } }, { output_path: `../${escaped}/j.md` })
    await withClaude({}, async (env, calls) => {
      const r = await run(home, env)
      expect(r.refused).toEqual([{ id: ID, reason: 'output_path resolves outside the home' }])
      expect(calls()).toBe(0)
    })
    expect(existsSync(join(tmpdir(), escaped))).toBe(false)
  })

  test('a parent swapped for a symlink out during the renderer call: the try fails with output_path resolves outside the home, and nothing lands outside', async () => {
    const outside = temp('warpline-rules-outside-')
    const home = await makeHome({ consume: { model: MODEL } }, { output_path: 'state/out/j.md' })
    const parent = join(home, 'state', 'out')
    // The fake runs this before it answers: the parent the pass checked becomes a link out of the home.
    const before = `rm -rf '${parent}' && ln -s '${outside}' '${parent}'`
    await withClaude({ before }, async (env, calls) => {
      const r = await run(home, env)
      expect(r).toEqual({ ...EMPTY, failed: [{ id: ID, reason: 'output_path resolves outside the home' }] })
      expect(calls()).toBe(1)
    })
    expect(readdirSync(outside)).toEqual([])
    const rec = await record(home)
    expect(rec?.state).toBe('open')
    expect(rec?.tries?.[0]).toMatchObject({ outcome: 'failed', reason: 'output_path resolves outside the home' })
    expect(tried(home)[0]).toMatchObject({ outcome: 'failed' })
  })
})

describe('what counts as an answer: consume.max_output_bytes and empty text', () => {
  test('text of exactly consume.max_output_bytes UTF-8 bytes is answered', async () => {
    const text = 'abcdefghé' // 10 UTF-8 bytes, 9 UTF-16 units
    const home = await makeHome({ consume: { model: MODEL, max_output_bytes: 10 } })
    await withClaude({ text }, async (env) => {
      expect(await run(home, env)).toEqual({ ...EMPTY, answered: [ID] })
    })
    expect(readFileSync(join(home, OUTPUT))).toEqual(Buffer.from(text, 'utf-8'))
  })

  test('one UTF-8 byte over consume.max_output_bytes is a failed try naming the key, with nothing written', async () => {
    const text = 'abcdefghié' // 11 UTF-8 bytes, 10 UTF-16 units
    const home = await makeHome({ consume: { model: MODEL, max_output_bytes: 10 } })
    await withClaude({ text }, async (env) => {
      const r = await run(home, env)
      expect(r.answered).toEqual([])
      expect(r.failed).toHaveLength(1)
      expect(r.failed[0]!.reason).toContain('consume.max_output_bytes')
    })
    expect(existsSync(join(home, OUTPUT))).toBe(false)
    const rec = await record(home)
    expect(rec?.state).toBe('open')
    expect(rec?.tries?.[0]?.outcome).toBe('failed')
    expect(rec?.tries?.[0]?.reason).toContain('consume.max_output_bytes')
    const bytes = Buffer.from(text, 'utf-8')
    expect(tried(home)[0]).toMatchObject({ outcome: 'failed', bytes: 11, sha256: sha256(bytes) })
  })

  test('whitespace-only text is a failed try: the text was empty', async () => {
    const text = '  \n\t '
    const home = await makeHome({ consume: { model: MODEL } })
    await withClaude({ text }, async (env) => {
      expect(await run(home, env)).toEqual({ ...EMPTY, failed: [{ id: ID, reason: 'the text was empty' }] })
    })
    expect(existsSync(join(home, OUTPUT))).toBe(false)
    expect(tried(home)[0]).toMatchObject({
      outcome: 'failed',
      bytes: Buffer.byteLength(text, 'utf-8'),
      sha256: sha256(Buffer.from(text, 'utf-8')),
    })
  })

  test('backstop: CRLF, accented and four-byte characters land as the text UTF-8 bytes', async () => {
    const text = 'a\r\nb é 😀'
    const home = await makeHome({ consume: { model: MODEL } })
    await withClaude({ text }, async (env) => {
      expect((await run(home, env)).answered).toEqual([ID])
    })
    expect(readFileSync(join(home, OUTPUT))).toEqual(Buffer.from(text, 'utf-8'))
  })
})

describe('trying stops after consume.max_tries counted tries', () => {
  test('with 2 failed tries on the record the 3rd runs, and is appended', async () => {
    const home = await makeHome({ consume: { model: MODEL } })
    await priorTry(home, 'failed')
    await priorTry(home, 'failed')
    await withClaude({}, async (env, calls) => {
      expect((await run(home, env)).answered).toEqual([ID])
      expect(calls()).toBe(1)
    })
    expect((await record(home))?.tries?.map((t) => t.outcome)).toEqual(['failed', 'failed', 'answered'])
  })

  test('with 3 failed tries the Handoff is skipped naming consume.max_tries, with no call, and stays open', async () => {
    const home = await makeHome({ consume: { model: MODEL } })
    for (let i = 0; i < 3; i++) await priorTry(home, 'failed')
    await withClaude({}, async (env, calls) => {
      const r = await run(home, env)
      expect(r).toEqual({ ...EMPTY, skipped: [{ id: ID, reason: 'the Handoff has used consume.max_tries tries' }] })
      expect(pass.exitCodeFor(r)).toBe(1)
      expect(calls()).toBe(0)
    })
    expect(reserved(home)).toEqual([])
    const rec = await record(home)
    expect(rec?.state).toBe('open')
    expect(rec?.tries).toHaveLength(3)
  })

  test('a discarded try is not counted: one discarded and two failed still runs', async () => {
    const home = await makeHome({ consume: { model: MODEL } })
    await priorTry(home, 'discarded')
    await priorTry(home, 'failed')
    await priorTry(home, 'failed')
    await withClaude({}, async (env, calls) => {
      expect((await run(home, env)).answered).toEqual([ID])
      expect(calls()).toBe(1)
    })
  })

  test('a Handoff that has used consume.max_tries is skipped before it is claimed', async () => {
    const home = await makeHome({ consume: { model: MODEL } })
    for (let i = 0; i < 3; i++) await priorTry(home, 'failed')
    const claims = spyOn(claim, 'claimHandoff')
    spies.push(claims)
    await withClaude({}, async (env) => {
      expect((await run(home, env)).skipped).toEqual([{ id: ID, reason: 'the Handoff has used consume.max_tries tries' }])
    })
    expect(claims).not.toHaveBeenCalled()
  })

  test('the count is read again under the claim: a try that used the last one after the listing skips the Handoff with no call', async () => {
    const home = await makeHome({ consume: { model: MODEL } })
    await priorTry(home, 'failed')
    await priorTry(home, 'failed')
    // Another consumer's failed try lands between the listing and this pass's claim.
    const real = claim.claimHandoff
    const spy = spyOn(claim, 'claimHandoff').mockImplementation((dir: string, id: string) => {
      const p = join(dir, `${id}.json`)
      const rec = JSON.parse(readFileSync(p, 'utf-8')) as { tries: unknown[] }
      writeFileSync(p, JSON.stringify({ ...rec, tries: [...rec.tries, rec.tries[0]] }))
      return real(dir, id)
    })
    spies.push(spy)
    await withClaude({}, async (env, calls) => {
      const r = await run(home, env)
      expect(r).toEqual({ ...EMPTY, skipped: [{ id: ID, reason: 'the Handoff has used consume.max_tries tries' }] })
      expect(calls()).toBe(0)
    })
    expect(reserved(home)).toEqual([])
    expect(present(join(home, 'handoffs', `${ID}.claim`))).toBe(false)
  })

  test('consume.max_tries is read from the settings: max_tries 1 skips after one failed try', async () => {
    const home = await makeHome({ consume: { model: MODEL, max_tries: 1 } })
    await priorTry(home, 'failed')
    await withClaude({}, async (env, calls) => {
      expect((await run(home, env)).skipped).toEqual([{ id: ID, reason: 'the Handoff has used consume.max_tries tries' }])
      expect(calls()).toBe(0)
    })
  })
})
