/**
 * The tool opt-in on a real kernel. A tool-enabled try must run as a second OS
 * user, and that user must fail to write into the home and fail to list it.
 * The unit cases prove the wiring against fakes. This file proves the kernel
 * half, with real accounts and real sudo, and only the CI step that creates
 * them runs it: it lives outside `src/`, so the sharded loop never reaches it.
 *
 * It runs as `warpop`, a third account holding only the two narrow sudoers
 * rules an operator would install. GitHub's `runner` holds blanket sudo, so a
 * pass as `runner` would prove nothing about the narrow rules.
 *
 * On Linux CI it fails instead of skipping when the step's variables are
 * unset: a deleted or half-edited step must go red, never quietly green.
 *
 * The allowed env names are a starting set. When the first pushed run shows a
 * name that this sudo or PAM adds (for example from `pam_env`) outside it, the
 * case fails, and the set grows by that exact name in a fix commit quoting the
 * run's log line. Never by a prefix or a wildcard, and never by a name that
 * carries a secret.
 */
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { auditRecords } from '../src/cli/__tests__/helpers/verb-home.js'
import { buildConsumeEnv, CLAUDE_ENV_PASSTHROUGH, renderClaudeCode } from '../src/consume/claude-code.js'
import { consumePass } from '../src/consume/pass.js'
import { writeHandoff } from '../src/lib/handoffs.js'
import { isProcessAlive } from '../src/lib/host-identity.js'
import { withHome } from '../src/lib/paths.js'

type Env = Readonly<Record<string, string | undefined>>

/** Whether this process runs the real cases, skips them, or fails for want of the step's variables. */
export function ciGuard(platform: string, env: Env): 'run' | 'skip' | 'fail' {
  if (platform !== 'linux' || env.CI !== 'true') return 'skip'
  return env.WARPLINE_CI_RUN_AS && env.WARPLINE_CI_OPERATOR ? 'run' : 'fail'
}

/** The two commands the operator may run as the judge, and nothing else. */
const NARROW = ['/opt/warpline-ci/bin/claude', '/usr/bin/test']

/**
 * The command column of a `sudo -l` listing, parsed, never substring-searched:
 * a runas group like `(ALL : ALL)` or a Defaults line can carry the word ALL.
 */
function sudoCommands(listing: string): string[] {
  const lines = listing.split('\n')
  const start = lines.findIndex((l) => l.includes('may run the following commands'))
  if (start < 0) return []
  const out: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') continue
    for (const item of line.trim().replace(/^\([^)]*\)\s*/, '').split(',')) {
      // Tags such as NOPASSWD: and SETENV:, and a runas group sudo repeats per command.
      const cmd = item.trim().replace(/^\([^)]*\)\s*/, '').replace(/^(?:[A-Z_]+:\s*)+/, '').trim()
      if (cmd !== '') out.push(cmd)
    }
  }
  return out
}

/** Names the judge may see: the consumer's own and passed-through, sudo's fixed set, and the shell's own. */
const consumerNames = new Set<string>([...Object.keys(buildConsumeEnv({}, '/x', '/x')), ...CLAUDE_ENV_PASSTHROUGH])
const SUDO_NAMES = new Set(['TERM', 'PATH', 'HOME', 'MAIL', 'SHELL', 'LOGNAME', 'USER', 'USERNAME'])
const SHELL_NAMES = new Set(['PWD', 'SHLVL', '_', 'OLDPWD'])
const allowedName = (n: string): boolean =>
  consumerNames.has(n) || SUDO_NAMES.has(n) || n.startsWith('SUDO_') || SHELL_NAMES.has(n)

describe('the guard', () => {
  test('Linux CI with neither variable fails instead of skipping', () => {
    expect(ciGuard('linux', { CI: 'true' })).toBe('fail')
    expect(ciGuard('linux', { CI: 'true', WARPLINE_CI_RUN_AS: 'warpline-judge' })).toBe('fail')
    expect(ciGuard('linux', { CI: 'true', WARPLINE_CI_OPERATOR: 'warpop' })).toBe('fail')
  })
  test('Linux CI with both variables runs', () => {
    expect(ciGuard('linux', { CI: 'true', WARPLINE_CI_RUN_AS: 'warpline-judge', WARPLINE_CI_OPERATOR: 'warpop' })).toBe('run')
  })
  test('off Linux, or off CI, it skips', () => {
    expect(ciGuard('darwin', { CI: 'true' })).toBe('skip')
    expect(ciGuard('linux', {})).toBe('skip')
  })
})

describe('the sudo -l parse', () => {
  const head = 'Matching Defaults entries for warpop on h:\n    env_reset, secure_path=/usr/bin\n\nUser warpop may run the following commands on h:\n'
  test('the two narrow rules parse to exactly their binaries', () => {
    const l = `${head}    (warpline-judge) NOPASSWD: SETENV: /opt/warpline-ci/bin/claude\n    (warpline-judge) NOPASSWD: /usr/bin/test\n`
    expect(sudoCommands(l).sort()).toEqual(NARROW)
  })
  test('a blanket rule parses to ALL, and an ALL runas group is not read as a command', () => {
    expect(sudoCommands(`${head}    (ALL : ALL) ALL\n`)).toEqual(['ALL'])
    expect(sudoCommands(`${head}    (ALL) NOPASSWD: /usr/bin/test, /bin/sh\n`)).toEqual(['/usr/bin/test', '/bin/sh'])
  })
  test('a listing with no command section parses to nothing', () => {
    expect(sudoCommands('Sorry, user warpop may not run sudo on h.\n')).toEqual([])
  })
})

const guard = ciGuard(process.platform, process.env)
const REASON = 'the real-user test did not run: WARPLINE_CI_RUN_AS or WARPLINE_CI_OPERATOR is unset on Linux CI'

if (guard === 'fail') {
  test('the real-user cases', () => {
    throw new Error(REASON)
  })
} else if (guard === 'skip') {
  test.skip(`the real-user cases (${REASON}; skipped off Linux CI)`, () => {})
} else {
  const judge = process.env.WARPLINE_CI_RUN_AS!
  const operator = process.env.WARPLINE_CI_OPERATOR!
  const PREFS = { consume: { model: 'claude-opus-5', tools: { prod: ['Read'] }, run_as: judge } }
  const ID = 'run-1.prod'
  const OUTPUT = 'judgments/prod.judgment.md'
  const SECRET = 'WARPLINE_TEST_SECRET'

  /** A 0700 home under /tmp, which the judge can reach, holding one opted-in Handoff. */
  async function makeHome(): Promise<string> {
    const home = mkdtempSync('/tmp/warpline-r5-')
    await writeHandoff(join(home, 'handoffs'), {
      run_id: 'run-1',
      plugin: 'prod',
      task: `PROBE:${home}`,
      context_path: null,
      output_path: OUTPUT,
    })
    writeFileSync(join(home, 'preferences.json'), JSON.stringify(PREFS))
    return home
  }

  const run = (home: string) =>
    withHome(home, () =>
      consumePass({ plugins: null, parentEnv: { PATH: '/opt/warpline-ci/bin:/usr/bin:/bin', [SECRET]: 'sentinel-secret-5e1a' } }),
    )

  describe('the real second user', () => {
    test('this runs as the operator account, which holds only the two narrow rules', () => {
      expect(userInfo().username).toBe(operator)
      const l = spawnSync('/usr/bin/sudo', ['-n', '-l'], { encoding: 'utf-8' })
      const commands = sudoCommands(l.stdout ?? '')
      // Could not look is never clean: no parsed command fails here too.
      expect(commands.length).toBeGreaterThan(0)
      expect([...commands].sort()).toEqual(NARROW)
    })

    test('the judge answers, and could neither write into the home nor list it, and saw only allowed env names', async () => {
      const home = await makeHome()
      try {
        const r = await run(home)
        expect(r.refusal).toBeNull()
        expect(r.refused).toEqual([])
        expect(r.answered).toEqual([ID])
        const text = readFileSync(join(home, OUTPUT), 'utf-8')
        const m = /^user=([^;]*);write=([^;]*);read=([^;]*);env=(.*)$/.exec(text.trim())
        expect(m).not.toBeNull()
        expect(m!.slice(1, 4)).toEqual([judge, 'denied', 'denied'])
        const names = m![4]!.split(',').filter(Boolean)
        expect(names.length).toBeGreaterThan(0)
        expect(names).not.toContain(SECRET)
        expect(names.filter((n) => !allowedName(n))).toEqual([])
        expect(existsSync(join(home, 'judge-was-here'))).toBe(false)
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    })

    test('a home the judge can enter is refused by name, with no call', async () => {
      const home = await makeHome()
      try {
        chmodSync(home, 0o711)
        const r = await run(home)
        expect(r.refusal).toBeNull()
        expect(r.answered).toEqual([])
        expect(r.refused).toEqual([{ id: ID, reason: 'the run_as user can enter the home' }])
        // The probe runs before the reservation, so no reservation means no call.
        expect(auditRecords(home, 'handoff.reserved')).toEqual([])
        expect(existsSync(join(home, OUTPUT))).toBe(false)
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    })

    test('a judge still running at the deadline is gone after the grace', async () => {
      const pidFile = `/tmp/warpline-r5-judge-${process.pid}-${Date.now()}.pid`
      const ps = (args: string[]): number[] =>
        (spawnSync('ps', args, { encoding: 'utf-8', env: { PATH: '/usr/bin:/bin' } }).stdout ?? '').trim().split(/\s+/).map(Number)
      try {
        // Not awaited: the judge is read while it is still alive.
        const rendering = renderClaudeCode({
          bin: '/opt/warpline-ci/bin/claude',
          model: 'claude-opus-5',
          prompt: `SLEEP:${pidFile}`,
          capMicro: null,
          parentEnv: { PATH: '/opt/warpline-ci/bin:/usr/bin:/bin' },
          tools: ['Read'],
          runAs: judge,
          timeoutMs: 3_000,
          killGraceMs: 2_000,
        })
        // Inside the 3 s deadline. A judge that never started proves nothing.
        let judgePid = 0
        for (const end = Date.now() + 2_500; judgePid === 0 && Date.now() < end; await Bun.sleep(50)) {
          const text = existsSync(pidFile) ? readFileSync(pidFile, 'utf-8').trim() : ''
          if (text !== '') judgePid = Number(text)
        }
        expect(judgePid).toBeGreaterThan(0)

        // The relay's preconditions (sudo exec_nopty.c signal_cb_nopty): sudo stayed
        // between this process and the judge, and this process's group is led by
        // neither sudo nor the judge, so sudo passes the SIGTERM on.
        const [ppid] = ps(['-o', 'ppid=,pgid=', '-p', String(judgePid)])
        const [testPgid] = ps(['-o', 'pgid=', '-p', String(process.pid)])
        expect(Number.isInteger(ppid) && ppid > 0).toBe(true)
        expect(ppid).not.toBe(process.pid)
        expect(testPgid).not.toBe(ppid)
        expect(testPgid).not.toBe(judgePid)

        expect(await rendering).toMatchObject({ ok: false, reason: 'the renderer did not answer in time' })
        expect(existsSync(pidFile)).toBe(true)
        // An EPERM from another user's live process reads as alive.
        let gone = false
        for (const end = Date.now() + 10_000; !gone && Date.now() < end; await Bun.sleep(50)) gone = !isProcessAlive(judgePid)
        expect(gone).toBe(true)
      } finally {
        try {
          // The judge owns it, so this may be refused in sticky /tmp.
          rmSync(pidFile, { force: true })
        } catch {
          // Left for the runner's teardown.
        }
      }
    }, 30_000)
  })
}
