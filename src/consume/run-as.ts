/**
 * run-as — the second OS user a tool-enabled try runs as.
 *
 * The judge runs as a second OS user, stepped down to through sudo, and never
 * as root. The kernel user is the boundary: a model with tools reads untrusted
 * context, and only the kernel's permission check keeps it out of the home.
 * Claude's own sandbox is defense in depth on top of that.
 *
 * Before every tool-enabled try the probe asks the kernel, through `test`'s
 * `access()` run as that user, whether the user can enter or read the home,
 * then the operator's OS home. Every answer must be no. Could not look never
 * reads as cannot reach: a refused sudo exits 1, the same code `test` uses for
 * false, so a control probe that must succeed runs first.
 */
import { spawn } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute } from 'node:path'

/** The sudo the command runs through, by absolute path. */
export const SUDO_BIN = '/usr/bin/sudo'

/** `test` by absolute path. darwin has no `/usr/bin/test`. */
export const TEST_BIN = process.platform === 'darwin' ? '/bin/test' : '/usr/bin/test'

/** Run one probe argv; its exit code, or null when it could not run or was killed. */
export type ProbeRunner = (argv: string[]) => Promise<number | null>

/** A probe is one `test` through sudo; this long only if a user lookup (NSS, PAM) hangs. */
export const PROBE_DEADLINE_MS = 10_000

/** The default runner: killed at the deadline and read as could not run. */
export const runProbe = (argv: string[], deadlineMs = PROBE_DEADLINE_MS): Promise<number | null> =>
  new Promise((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), { env: { PATH: '/usr/bin:/bin' }, stdio: 'ignore' })
    // SIGKILL, since sudo relays SIGTERM to its child and waits on it. Resolve now, not on close: a child stuck in the kernel may never close.
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve(null)
    }, deadlineMs)
    child.on('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })

type Probed = { ok: true } | { ok: false; reason: string }

const HOME = 'the home'
const OS_HOME = "the operator's OS home"
const unchecked = (name: string): Probed => ({ ok: false, reason: `whether the run_as user can reach ${name} could not be checked` })

/** The real path of the operator's OS home. A relative one is refused: `realpath('')` is the cwd. */
export async function realOsHome(dir = homedir()): Promise<string> {
  if (!isAbsolute(dir)) throw new Error('the OS home is not an absolute path')
  return realpath(dir)
}

/**
 * `{ ok: true }` only when the control probe exits 0 and both probes on the
 * home, then both on the operator's OS home, exit 1. Stops at the first
 * refusal. No reason names the user or a path.
 */
export async function judgeCannotEnterHome(
  runAs: string,
  home: string,
  run: ProbeRunner = runProbe,
  osHome: () => Promise<string> = realOsHome,
): Promise<Probed> {
  const probe = (...args: string[]) => run([SUDO_BIN, '-n', '-u', runAs, TEST_BIN, ...args])
  const unreachable = async (dir: string, name: string): Promise<Probed> => {
    for (const [flag, verb] of [['-x', 'enter'], ['-r', 'read']] as const) {
      const code = await probe(flag, dir)
      if (code === 0) return { ok: false, reason: `the run_as user can ${verb} ${name}` }
      if (code !== 1) return unchecked(name)
    }
    return { ok: true }
  }
  if ((await probe('-d', '/')) !== 0) return unchecked(HOME)
  const inHome = await unreachable(home, HOME)
  if (!inHome.ok) return inHome
  let osDir: string
  try {
    osDir = await osHome()
  } catch {
    return unchecked(OS_HOME)
  }
  return unreachable(osDir, OS_HOME)
}

/**
 * The sudo command for one tool-enabled child. The env goes by name only: its
 * values stay in the spawn's env, off the process table, and no `env` program
 * is run.
 */
export function buildSudoArgv(runAs: string, envNames: readonly string[], bin: string, argv: readonly string[]): string[] {
  return [SUDO_BIN, '-n', '-u', runAs, `--preserve-env=${envNames.join(',')}`, bin, ...argv]
}
