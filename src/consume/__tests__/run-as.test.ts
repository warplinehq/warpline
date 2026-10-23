/**
 * The tool opt-in, pinned: a plugin gets tools only when `consume.tools` lists
 * them, and a tool-enabled try runs only as a second OS user that the kernel
 * keeps out of the home.
 *
 * Real `sudo` is never run here. The probe takes its runner as an argument, and
 * the pass-level cases replace the probe and the renderer through `spyOn` on
 * their module namespaces, which checks the pass's wiring only. The sudo spawn
 * itself runs for real in one case, against a recording fake sudo: a
 * pass-through spy on `buildSudoArgv` keeps the real result and swaps only its
 * first element, the sudo binary, for the fake's path. Everything else in that
 * branch runs as shipped.
 *
 * No case reaches a real provider. Every case hands the code under test an
 * explicit parent env and never `process.env`.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { withFakeClaude } from '../../../test-utils/fake-claude.js'
import { withOpenAiStub } from '../../../test-utils/openai-stub.js'
import { auditRecords, restoreSpies } from '../../cli/__tests__/helpers/verb-home.js'
import { writeHandoff, type HandoffInput } from '../../lib/handoffs.js'
import { isProcessAlive } from '../../lib/host-identity.js'
import { withHome } from '../../lib/paths.js'
// The modules this file pins before they exist, read through the namespace so
// each export is named where it is used, and so a spy replaces the binding
// the code under test sees.
import * as cc from '../claude-code.js'
import * as pass from '../pass.js'
import * as runAs from '../run-as.js'

const ID = 'run-1.prod'
const OUTPUT = 'judgments/prod.judgment.md'
const TEXT = 'the judgment'
const MODEL = 'claude-opus-5'
const FLOOR_VERSION = '2.1.305 (Claude Code)'
const JUDGE = 'sentinel-judge'

const NO_RUN_AS = 'consume.tools is set for this plugin and consume.run_as is not'
const NEEDS_CLAUDE_CODE = 'consume.tools needs the claude-code renderer'
const CAN_ENTER = 'the run_as user can enter the home'
const CAN_READ = 'the run_as user can read the home'
const UNCHECKED = 'whether the run_as user can reach the home could not be checked'
const OS_CAN_ENTER = "the run_as user can enter the operator's OS home"
const OS_CAN_READ = "the run_as user can read the operator's OS home"
const OS_UNCHECKED = "whether the run_as user can reach the operator's OS home could not be checked"

type Env = Record<string, string | undefined>

const temps: string[] = []
const spies: Array<{ mockRestore: () => void }> = []
/** Every pid a deadline case read, killed after it whatever the case did. */
const pids: number[] = []

afterEach(() => {
  restoreSpies()
  for (const s of spies.splice(0)) s.mockRestore()
  for (const p of pids.splice(0)) {
    try {
      process.kill(p, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true })
})

const temp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix))
  temps.push(d)
  return d
}

/** A temp home holding one open Handoff per plugin named, and the given preferences. */
async function makeHome(prefs: unknown, plugins: readonly string[] = ['prod'], input: Partial<HandoffInput> = {}): Promise<string> {
  const home = temp('warpline-run-as-')
  for (const plugin of plugins) {
    await writeHandoff(join(home, 'handoffs'), {
      run_id: 'run-1',
      plugin,
      task: 'Judge it',
      context_path: null,
      output_path: `judgments/${plugin}.judgment.md`,
      ...input,
    })
  }
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

/** The fake `claude` first on PATH for `fn`, with a count of the renderer calls (a `--version` probe is not one). */
async function withClaude<T>(fn: (env: Env, calls: () => number) => Promise<T>): Promise<T> {
  const dump = temp('warpline-run-as-dump-')
  return withFakeClaude({ stdout: claudeResult(TEXT, 0.0123), version: FLOOR_VERSION, dumpDir: dump }, () => {
    const calls = () => {
      const p = join(dump, 'calls.txt')
      return existsSync(p) ? readFileSync(p, 'utf-8').split('\n').filter(Boolean).length : 0
    }
    return fn({ PATH: process.env.PATH }, calls)
  })
}

function run(home: string, parentEnv: Env): Promise<pass.PassResult> {
  return withHome(home, () => pass.consumePass({ plugins: null, parentEnv }))
}

const reserved = (home: string) => auditRecords(home, 'handoff.reserved')
const recordText = (home: string, id = ID) => readFileSync(join(home, 'handoffs', `${id}.json`), 'utf-8')

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

/** Whether `seq` appears in `argv` as consecutive elements. */
const hasRun = (argv: readonly string[], seq: readonly string[]): boolean =>
  argv.some((_, i) => seq.every((s, j) => argv[i + j] === s))

describe('the opt-in is refused by name before any claim', () => {
  test('tracer: a plugin opted in to Read with no run_as is refused by name, with no call and no reservation', async () => {
    const home = await makeHome({ consume: { model: MODEL, tools: { prod: ['Read'] } } })
    await withClaude(async (env, calls) => {
      const r = await run(home, env)
      expect(r).toEqual({ ...EMPTY, refused: [{ id: ID, reason: NO_RUN_AS }] })
      expect(pass.exitCodeFor(r)).toBe(1)
      expect(calls()).toBe(0)
    })
    expect(reserved(home)).toEqual([])
  })

  test('a tool opt-in under the openai-compatible renderer is refused by name, with no stub call', async () => {
    await withOpenAiStub([{ status: 200, body: { model: 'gpt-test', choices: [{ message: { role: 'assistant', content: TEXT } }] } }], async (stub) => {
      const home = await makeHome({
        consume: { renderer: 'openai-compatible', endpoint: stub.url, model: 'gpt-test', tools: { prod: ['Read'] }, run_as: JUDGE },
      })
      const r = await run(home, {})
      expect(r).toEqual({ ...EMPTY, refused: [{ id: ID, reason: NEEDS_CLAUDE_CODE }] })
      expect(stub.calls()).toBe(0)
      expect(reserved(home)).toEqual([])
    })
  })
})

describe('the reachability probe', () => {
  /** A runner answering each probe by its flag, recording every argv it is handed. */
  function stub(codes: Partial<Record<'-d' | '-x' | '-r', number | null>>) {
    const seen: string[][] = []
    const runner: runAs.ProbeRunner = async (argv) => {
      seen.push(argv)
      const code = codes[argv[5] as '-d' | '-x' | '-r']
      return code === undefined ? null : code
    }
    return { runner, seen }
  }
  const HOME = '/srv/warpline-home'
  const OS_HOME = '/Users/sentinel-operator'
  const osHome = async () => OS_HOME
  const probe = (flag: string, path: string) => [runAs.SUDO_BIN, '-n', '-u', JUDGE, runAs.TEST_BIN, flag, path]

  test('the control passes and every home probe says false: ok, after the control, both probes on the home, then both on the OS home', async () => {
    const s = stub({ '-d': 0, '-x': 1, '-r': 1 })
    expect(await runAs.judgeCannotEnterHome(JUDGE, HOME, s.runner, osHome)).toEqual({ ok: true })
    expect(s.seen).toEqual([probe('-d', '/'), probe('-x', HOME), probe('-r', HOME), probe('-x', OS_HOME), probe('-r', OS_HOME)])
  })

  /** A runner answering a probe by its flag and path; anything not listed is a passing control or a false test. */
  function byPath(codes: Record<string, number | null> = {}) {
    const seen: string[][] = []
    const runner: runAs.ProbeRunner = async (argv) => {
      seen.push(argv)
      const key = `${argv[5]} ${argv[6]}`
      if (key in codes) return codes[key] ?? null
      return argv[5] === '-d' ? 0 : 1
    }
    return { runner, seen }
  }

  test.each([
    ['an enterable OS home', { [`-x ${OS_HOME}`]: 0 }, OS_CAN_ENTER],
    ['a readable OS home', { [`-r ${OS_HOME}`]: 0 }, OS_CAN_READ],
    ['an OS home -x that exits 2', { [`-x ${OS_HOME}`]: 2 }, OS_UNCHECKED],
    ['an OS home -r that exits 2', { [`-r ${OS_HOME}`]: 2 }, OS_UNCHECKED],
    ['an OS home probe that could not run', { [`-x ${OS_HOME}`]: null }, OS_UNCHECKED],
  ] as const)('%s is refused by name, naming neither the path nor the user', async (_, codes, reason) => {
    const s = byPath(codes)
    const r = await runAs.judgeCannotEnterHome(JUDGE, HOME, s.runner, osHome)
    expect(r).toEqual({ ok: false, reason })
    expect(s.seen.slice(0, 3)).toEqual([probe('-d', '/'), probe('-x', HOME), probe('-r', HOME)])
    for (const leak of [JUDGE, OS_HOME, 'sentinel-operator']) expect(JSON.stringify(r).includes(leak)).toBe(false)
  })

  test('a home inside the OS home still has both homes probed', async () => {
    const inside = `${OS_HOME}/.warpline`
    const s = byPath()
    expect(await runAs.judgeCannotEnterHome(JUDGE, inside, s.runner, osHome)).toEqual({ ok: true })
    expect(s.seen).toEqual([probe('-d', '/'), probe('-x', inside), probe('-r', inside), probe('-x', OS_HOME), probe('-r', OS_HOME)])
  })

  test('an OS home whose real path cannot be found is could-not-be-checked, never cannot-reach, and probes nothing there', async () => {
    const s = byPath()
    const r = await runAs.judgeCannotEnterHome(JUDGE, HOME, s.runner, async () => {
      throw new Error(`ENOENT: ${OS_HOME}`)
    })
    expect(r).toEqual({ ok: false, reason: OS_UNCHECKED })
    expect(JSON.stringify(r).includes('sentinel-operator')).toBe(false)
    expect(s.seen).toEqual([probe('-d', '/'), probe('-x', HOME), probe('-r', HOME)])
  })

  test('with no OS home given, the OS home probed is the real path of os.homedir()', async () => {
    const s = byPath()
    expect(await runAs.judgeCannotEnterHome(JUDGE, HOME, s.runner)).toEqual({ ok: true })
    const real = realpathSync(homedir())
    expect(s.seen.slice(3)).toEqual([probe('-x', real), probe('-r', real)])
  })

  test.each([
    ['empty', ''],
    ['relative', 'relative'],
  ])('an OS home that is %s is never resolved against the cwd: could-not-be-checked', async (_, dir) => {
    expect(typeof runAs.realOsHome).toBe('function')
    const s = byPath()
    expect(await runAs.judgeCannotEnterHome(JUDGE, HOME, s.runner, () => runAs.realOsHome(dir))).toEqual({ ok: false, reason: OS_UNCHECKED })
    expect(s.seen).toHaveLength(3)
  })

  test('a failed control is could-not-be-checked, never cannot-reach: a refused sudo exits 1 like a false test', async () => {
    const s = stub({ '-d': 1, '-x': 1, '-r': 1 })
    expect(await runAs.judgeCannotEnterHome(JUDGE, HOME, s.runner)).toEqual({ ok: false, reason: UNCHECKED })
    expect(s.seen).toEqual([probe('-d', '/')])
  })

  test.each([
    ['-x exits 0', { '-d': 0, '-x': 0, '-r': 1 }, CAN_ENTER],
    ['-r exits 0', { '-d': 0, '-x': 1, '-r': 0 }, CAN_READ],
    ['-x exits 2', { '-d': 0, '-x': 2, '-r': 1 }, UNCHECKED],
    ['-r exits 2', { '-d': 0, '-x': 1, '-r': 2 }, UNCHECKED],
    ['the runner could not spawn', { '-d': null }, UNCHECKED],
    ['the control exits 2', { '-d': 2 }, UNCHECKED],
  ] as const)('%s is refused by name', async (_, codes, reason) => {
    const r = await runAs.judgeCannotEnterHome(JUDGE, HOME, stub(codes).runner)
    expect(r).toEqual({ ok: false, reason })
    expect(JSON.stringify(r).includes(JUDGE)).toBe(false)
  })

  test('TEST_BIN is /bin/test on darwin and /usr/bin/test elsewhere', () => {
    expect(runAs.TEST_BIN).toBe(process.platform === 'darwin' ? '/bin/test' : '/usr/bin/test')
    expect(runAs.SUDO_BIN).toBe('/usr/bin/sudo')
  })
})

describe('the probe deadline', () => {
  /** Whether `pid` is gone within `ms`; a killed child can sit unreaped for a moment. */
  async function goneWithin(pid: number, ms: number): Promise<boolean> {
    for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(25)) {
      try {
        process.kill(pid, 0)
      } catch {
        return true
      }
    }
    return false
  }

  test('a probe still running at its deadline is killed and reads as could not run, so the Handoff is refused by name', async () => {
    expect(typeof runAs.runProbe).toBe('function')
    const dir = temp('warpline-run-as-hang-')
    const hang = join(dir, 'hang')
    writeFileSync(hang, ['#!/bin/sh', 'echo $$ > "$1"', 'exec sleep 30', ''].join('\n'))
    chmodSync(hang, 0o755)

    const pidFile = join(dir, 'pid')
    const started = Date.now()
    expect(await runAs.runProbe([hang, pidFile], 300)).toBeNull()
    expect(Date.now() - started).toBeLessThan(3000)
    expect(await goneWithin(Number(readFileSync(pidFile, 'utf-8')), 2000)).toBe(true)

    // Through the probe: the control hangs, and the refusal is the fixed could-not-be-checked one.
    const controlPid = join(dir, 'control-pid')
    const r = await runAs.judgeCannotEnterHome(JUDGE, '/srv/warpline-home', () => runAs.runProbe([hang, controlPid], 300), async () => '/x')
    expect(r).toEqual({ ok: false, reason: UNCHECKED })
    expect(await goneWithin(Number(readFileSync(controlPid, 'utf-8')), 2000)).toBe(true)
  }, 10_000)
})

describe('the argv', () => {
  test('buildSudoArgv passes env names through --preserve-env, never a value and never an env program', () => {
    const argv = runAs.buildSudoArgv('j', ['PATH', 'TERM'], '/abs/claude', ['-p'])
    expect(argv).toEqual(['/usr/bin/sudo', '-n', '-u', 'j', '--preserve-env=PATH,TERM', '/abs/claude', '-p'])
    for (const a of argv) {
      if (a !== '--preserve-env=PATH,TERM') expect([a, a.includes('=')]).toEqual([a, false])
      expect(a).not.toBe('env')
    }
  })

  test('buildToolArgv names the list as both the available and the allowed tools, keeps the isolation, and ends with the removed tools', () => {
    const argv = cc.buildToolArgv('m', null, ['Read', 'Grep'])
    expect(hasRun(argv, ['--tools', 'Read', 'Grep'])).toBe(true)
    expect(hasRun(argv, ['--allowedTools', 'Read', 'Grep'])).toBe(true)
    expect(hasRun(argv, ['--permission-prompts', 'none'])).toBe(true)
    expect(hasRun(argv, ['--settings', JSON.stringify(cc.ISOLATION_SETTINGS)])).toBe(true)
    expect(hasRun(argv, ['--setting-sources', ''])).toBe(true)
    expect(hasRun(argv, ['--model', 'm'])).toBe(true)
    expect(argv).toContain('--bare')
    expect(argv).toContain('--strict-mcp-config')
    expect(argv.slice(-4)).toEqual(['--disallowedTools', 'WebFetch', 'WebSearch', 'RemoteTrigger'])
    for (const banned of ['--permission-mode', 'bypassPermissions', '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions']) {
      expect(argv).not.toContain(banned)
    }
  })
})

describe('the pass wiring', () => {
  const PREFS = { consume: { model: MODEL, tools: { prod: ['Read'] }, run_as: JUDGE } }
  const ANSWERED = { ok: true, text: TEXT, served: MODEL, cost_micro_usd: 1, cost_basis: 'reported', reason: null } as const

  test('a probe that refuses refuses the Handoff with its reason, with no call and no reservation', async () => {
    const home = await makeHome(PREFS)
    const probe = spyOn(runAs, 'judgeCannotEnterHome').mockResolvedValue({ ok: false, reason: CAN_ENTER })
    spies.push(probe)
    await withClaude(async (env, calls) => {
      const r = await run(home, env)
      expect(r).toEqual({ ...EMPTY, refused: [{ id: ID, reason: CAN_ENTER }] })
      expect(calls()).toBe(0)
    })
    expect(probe).toHaveBeenCalledTimes(1)
    expect(reserved(home)).toEqual([])
    expect(existsSync(join(home, 'handoffs', `${ID}.claim`))).toBe(false)
  })

  test('a probe that passes renders with the tools and the run_as user, probing the home by its realpath, and names the user nowhere', async () => {
    const home = await makeHome(PREFS)
    const probe = spyOn(runAs, 'judgeCannotEnterHome').mockResolvedValue({ ok: true })
    const render = spyOn(cc, 'renderClaudeCode').mockResolvedValue(ANSWERED)
    spies.push(probe, render)
    const r = await withClaude((env) => run(home, env))
    expect(r).toEqual({ ...EMPTY, answered: [ID] })
    expect(probe).toHaveBeenCalledTimes(1)
    expect(probe.mock.calls[0]!.slice(0, 2)).toEqual([JUDGE, realpathSync(home)])
    expect(render).toHaveBeenCalledTimes(1)
    expect(render.mock.calls[0]![0]).toMatchObject({ tools: ['Read'], runAs: JUDGE })
    expect(JSON.stringify(r).includes(JUDGE)).toBe(false)
    expect(recordText(home).includes(JUDGE)).toBe(false)
  })

  test('the probe runs before every tool-enabled try: two opted-in Handoffs, two probes', async () => {
    const home = await makeHome({ consume: { model: MODEL, tools: { prod: ['Read'], other: ['Read'] }, run_as: JUDGE } }, ['prod', 'other'])
    const probe = spyOn(runAs, 'judgeCannotEnterHome').mockResolvedValue({ ok: true })
    const render = spyOn(cc, 'renderClaudeCode').mockResolvedValue(ANSWERED)
    spies.push(probe, render)
    await withClaude(async (env) => {
      expect((await run(home, env)).answered.slice().sort()).toEqual(['run-1.other', 'run-1.prod'])
    })
    expect(probe).toHaveBeenCalledTimes(2)
    expect(render).toHaveBeenCalledTimes(2)
  })

  test('a plugin named constructor with no consume.tools entry is answered tool-less with consume.model', async () => {
    const id = 'run-1.constructor'
    const home = await makeHome({ consume: { model: MODEL } }, ['constructor'])
    const probe = spyOn(runAs, 'judgeCannotEnterHome')
    const sudo = spyOn(runAs, 'buildSudoArgv')
    spies.push(probe, sudo)
    const r = await withClaude((env) => run(home, env))
    expect(r).toEqual({ ...EMPTY, answered: [id] })
    expect(JSON.parse(recordText(home, id)).tries.map((t: { requested: string }) => t.requested)).toEqual([MODEL])
    expect(probe).not.toHaveBeenCalled()
    expect(sudo).not.toHaveBeenCalled()
  })
})

describe('the deadline', () => {
  /** The pid written to `file`, once it is there; recorded so `afterEach` kills it. */
  async function readPid(file: string, ms = 3000): Promise<number> {
    for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) {
      const text = existsSync(file) ? readFileSync(file, 'utf-8').trim() : ''
      if (text !== '') {
        const pid = Number(text)
        pids.push(pid)
        return pid
      }
    }
    throw new Error(`no pid was written to ${file}`)
  }

  /** Whether `pid` is gone within `ms`, read every 50 ms. */
  async function goneWithin(pid: number, ms: number): Promise<boolean> {
    for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) {
      if (!isProcessAlive(pid)) return true
    }
    return !isProcessAlive(pid)
  }

  function script(dir: string, name: string, lines: string[]): string {
    const p = join(dir, name)
    writeFileSync(p, [...lines, ''].join('\n'))
    chmodSync(p, 0o755)
    return p
  }

  /** Swap the sudo binary for `fake`, keeping the rest of the real argv. */
  function useFakeSudo(fake: string): void {
    // Read BEFORE `spyOn`: afterwards the namespace property is the mock.
    const real = runAs.buildSudoArgv
    spies.push(
      spyOn(runAs, 'buildSudoArgv').mockImplementation((...args: Parameters<typeof runAs.buildSudoArgv>) => [
        fake,
        ...real(...args).slice(1),
      ]),
    )
  }

  const render = (bin: string, timeoutMs: number, killGraceMs: number) =>
    cc.renderClaudeCode({
      bin,
      model: MODEL,
      prompt: 'p',
      capMicro: null,
      parentEnv: { PATH: '/usr/bin:/bin' },
      tools: ['Read'],
      runAs: JUDGE,
      timeoutMs,
      killGraceMs,
    })

  test('a judge still running at the deadline gets SIGTERM, which sudo relays, and is gone', async () => {
    const dir = temp('warpline-run-as-deadline-')
    const claudePid = join(dir, 'claude.pid')
    const claude = script(dir, 'claude', ['#!/bin/sh', `echo $$ > '${claudePid}'`, 'exec sleep 30'])
    // Relays every SIGTERM, with no process-group test. Real sudo skips only a
    // sender whose process group sudo or the command leads, and the test
    // process is never in such a group (sudo exec_nopty.c signal_cb_nopty).
    const sudo = script(dir, 'sudo', [
      '#!/bin/bash',
      'while [ "$#" -gt 0 ]; do case "$1" in --preserve-env=*) shift; break ;; esac; shift; done',
      '"$@" &',
      'child=$!',
      `trap 'kill -TERM "$child"' TERM`,
      'wait "$child"',
    ])
    useFakeSudo(sudo)

    const r = await render(claude, 500, 5_000)
    expect(r).toMatchObject({ ok: false, reason: 'the renderer did not answer in time' })
    expect(await goneWithin(await readPid(claudePid), 3000)).toBe(true)
  }, 15_000)

  test('a sudo that ignores SIGTERM is killed after the grace, and the try settled at the deadline', async () => {
    const dir = temp('warpline-run-as-grace-')
    const sudoPid = join(dir, 'sudo.pid')
    const sudo = script(dir, 'sudo', ['#!/bin/sh', "trap '' TERM", `echo $$ > '${sudoPid}'`, 'exec sleep 30'])
    useFakeSudo(sudo)

    const started = Date.now()
    const r = await render(join(dir, 'claude'), 300, 1_000)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(r).toMatchObject({ ok: false, reason: 'the renderer did not answer in time' })
    expect(await goneWithin(await readPid(sudoPid), 4000)).toBe(true)
  }, 15_000)
})

describe('the sudo spawn', () => {
  test('the tool-enabled child runs through sudo with names only, no HOME and a 0755 cwd removed afterwards', async () => {
    const claudeDump = temp('warpline-run-as-claude-')
    const sudoDump = temp('warpline-run-as-sudo-')
    const fakeDir = temp('warpline-run-as-fake-sudo-')
    const fakeSudo = join(fakeDir, 'sudo')
    writeFileSync(
      fakeSudo,
      [
        '#!/bin/sh',
        `D='${sudoDump}'`,
        `printf '%s\\n' "$@" > "$D/args.txt"`,
        'pwd > "$D/pwd.txt"',
        'ls -ld . > "$D/ls.txt"',
        'env > "$D/env.txt"',
        'shift 4',
        'exec "$@"',
        '',
      ].join('\n'),
    )
    chmodSync(fakeSudo, 0o755)

    // Read BEFORE `spyOn`: afterwards the namespace property is the mock.
    const real = runAs.buildSudoArgv
    const realResults: string[][] = []
    const spy = spyOn(runAs, 'buildSudoArgv').mockImplementation((...args: Parameters<typeof runAs.buildSudoArgv>) => {
      const argv = real(...args)
      realResults.push(argv)
      return [fakeSudo, ...argv.slice(1)]
    })
    spies.push(spy)

    await withFakeClaude({ version: FLOOR_VERSION, dumpDir: claudeDump, stdout: claudeResult(TEXT, 0.0123) }, async () => {
      const bin = cc.resolveClaudeBin(process.env.PATH)
      if (bin === null) throw new Error('the fake claude was not found on PATH')
      const r = await cc.renderClaudeCode({
        bin,
        model: MODEL,
        prompt: 'p',
        capMicro: null,
        parentEnv: {
          PATH: process.env.PATH,
          ANTHROPIC_API_KEY: 'sentinel-allowed-3b7d',
          WARPLINE_TEST_SECRET: 'sentinel-secret-9f2c',
          HOME: '/home/operator',
        },
        tools: ['Read'],
        runAs: JUDGE,
      })

      // Positive controls: the spy ran, the real command named the real sudo, and the fake recorded.
      expect(spy).toHaveBeenCalledTimes(1)
      expect(realResults[0]![0]).toBe(runAs.SUDO_BIN)
      expect(existsSync(join(sudoDump, 'args.txt'))).toBe(true)

      // Argv: names only, then the real claude and exactly the tool argv.
      const args = readFileSync(join(sudoDump, 'args.txt'), 'utf-8').split('\n').slice(0, -1)
      expect(args.slice(0, 3)).toEqual(['-n', '-u', JUDGE])
      const preserve = args.filter((a) => a.startsWith('--preserve-env='))
      expect(preserve).toHaveLength(1)
      expect(args[3]).toBe(preserve[0])
      expect(args.slice(4)).toEqual([bin, ...cc.buildToolArgv(MODEL, null, ['Read'])])
      for (const a of args) {
        if (a !== preserve[0]) expect([a, a.includes('=')]).toEqual([a, false])
        expect(a.includes('sentinel-allowed-3b7d')).toBe(false)
        expect(a.includes('sentinel-secret-9f2c')).toBe(false)
      }
      const names = preserve[0]!.slice('--preserve-env='.length).split(',')
      expect(names).toContain('PATH')
      expect(names).toContain('ANTHROPIC_API_KEY')
      expect(names).not.toContain('HOME')
      expect(names).not.toContain('WARPLINE_TEST_SECRET')

      // Env: no HOME, no planted secret, and nothing outside the preserve list but the shell's own.
      const envNames = readFileSync(join(sudoDump, 'env.txt'), 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map((l) => l.slice(0, l.indexOf('=')))
      expect(envNames.length).toBeGreaterThan(0)
      expect(envNames).not.toContain('HOME')
      expect(envNames).not.toContain('WARPLINE_TEST_SECRET')
      const allowed = new Set([...names, 'PWD', 'SHLVL', '_'])
      for (const n of envNames) expect([n, allowed.has(n)]).toEqual([n, true])

      // Cwd: a 0755 judge dir under /tmp, gone once the call returned.
      expect(readFileSync(join(sudoDump, 'ls.txt'), 'utf-8').startsWith('drwxr-xr-x')).toBe(true)
      const pwd = readFileSync(join(sudoDump, 'pwd.txt'), 'utf-8').trim()
      expect(pwd).toContain('/tmp/warpline-judge-')
      expect(existsSync(pwd)).toBe(false)

      // Last: the call went through to claude and answered with its text.
      expect(r).toMatchObject({ ok: true, text: TEXT })
      expect(readFileSync(join(claudeDump, 'calls.txt'), 'utf-8').split('\n').filter(Boolean)).toHaveLength(1)
    })
  })
})
