/**
 * run-as — the second OS user a tool-enabled try runs as.
 *
 * The judge runs as a second OS user, stepped down to through sudo, and never
 * as root. The kernel user is the boundary: a model with tools reads untrusted
 * context, and only the kernel's permission check keeps it out of the home.
 * Claude's own sandbox is defense in depth on top of that.
 *
 * Before every tool-enabled try the probe asks the kernel, through `test`'s
 * `access()` run as that user, whether the user can enter or read the home.
 * Both must say no. Could not look never reads as cannot reach: a refused
 * sudo exits 1, the same code `test` uses for false, so a control probe that
 * must succeed runs first.
 */
import { spawn } from 'node:child_process'

/** The sudo the command runs through, by absolute path. */
export const SUDO_BIN = '/usr/bin/sudo'

/** `test` by absolute path. darwin has no `/usr/bin/test`. */
export const TEST_BIN = process.platform === 'darwin' ? '/bin/test' : '/usr/bin/test'

/** Run one probe argv; its exit code, or null when it could not run or was killed. */
export type ProbeRunner = (argv: string[]) => Promise<number | null>

const runProbe: ProbeRunner = (argv) =>
  new Promise((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), { env: { PATH: '/usr/bin:/bin' }, stdio: 'ignore' })
    child.on('error', () => resolve(null))
    child.on('close', (code) => resolve(code))
  })

const UNCHECKED = 'whether the run_as user can reach the home could not be checked'

/**
 * `{ ok: true }` only when the control probe exits 0 and both home probes exit
 * 1. Stops at the first refusal. No reason names the user.
 */
export async function judgeCannotEnterHome(
  runAs: string,
  home: string,
  run: ProbeRunner = runProbe,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const probe = (...args: string[]) => run([SUDO_BIN, '-n', '-u', runAs, TEST_BIN, ...args])
  if ((await probe('-d', '/')) !== 0) return { ok: false, reason: UNCHECKED }
  for (const [flag, can] of [
    ['-x', 'the run_as user can enter the home'],
    ['-r', 'the run_as user can read the home'],
  ] as const) {
    const code = await probe(flag, home)
    if (code === 0) return { ok: false, reason: can }
    if (code !== 1) return { ok: false, reason: UNCHECKED }
  }
  return { ok: true }
}

/**
 * The sudo command for one tool-enabled child. The env goes by name only: its
 * values stay in the spawn's env, off the process table, and no `env` program
 * is run.
 */
export function buildSudoArgv(runAs: string, envNames: readonly string[], bin: string, argv: readonly string[]): string[] {
  return [SUDO_BIN, '-n', '-u', runAs, `--preserve-env=${envNames.join(',')}`, bin, ...argv]
}
