/**
 * Runs the operator's `notify` command once.
 *
 * The command is spawned from its argv with no shell, so an entry such as
 * `$(…)` arrives as text. The message goes to its stdin. stdout and stderr are
 * discarded: only the exit code, or `timeout`, is kept. At the timeout the
 * command's whole process group is killed, a grandchild included, and so is a
 * group still live when this process exits. The environment is built from an
 * allowlist, so a plugin secret in this process's environment never reaches it.
 *
 * Imports only `node:child_process`, nothing from the runtime or the board.
 */
import { spawn } from 'node:child_process'

/**
 * The only variables the command is handed. The proxy names come in both cases
 * because curl, Go and Python each read a different one.
 */
export const NOTIFY_ENV_KEYS = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'TZ',
  'TMPDIR',
  'http_proxy',
  'https_proxy',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'all_proxy',
  'ALL_PROXY',
  'no_proxy',
  'NO_PROXY',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
] as const

/** The allowlisted variables of `env` that are set. This module's only read of the environment. */
export function notifyEnv(
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of NOTIFY_ENV_KEYS) {
    const value = env[key]
    if (value !== undefined) out[key] = value
  }
  return out
}

/**
 * How many times one advance runs `notify` for one message, and the waits
 * between those tries. Constants, never settings: the long tail of a broken
 * `notify` is the next advance, which sends every undelivered entry again.
 */
export const NOTIFY_TRIES = 3
export const NOTIFY_BACKOFF_MS = [500, 2000] as const

export type NotifyOutcome = { outcome: 'delivered' | 'failed' | 'timeout'; exit_code: number | null }

/**
 * Spawn `argv` with `payload` on stdin and settle once: `delivered` on exit 0,
 * `failed` with the code on any other exit (`null` for a signal or a command
 * that could not start), `timeout` when the timer killed the group. `env` is
 * the child's whole environment, passed explicitly: build it with `notifyEnv`.
 */
export function runNotify(
  argv: readonly string[],
  payload: string,
  timeoutMs: number,
  env: Record<string, string>,
): Promise<NotifyOutcome> {
  return new Promise((resolve) => {
    const child = spawn(argv[0] as string, argv.slice(1), {
      shell: false,
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],
      env,
    })
    // pid is undefined when the spawn failed, and a kill of group 0 would
    // signal this process's own group.
    const killGroup = (): void => {
      if (typeof child.pid === 'number' && child.pid > 0) {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          // The group has already gone.
        }
      }
    }
    let settled = false
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killGroup()
    }, timeoutMs)
    // A detached group outlives this process unless something kills it.
    process.once('exit', killGroup)
    const settle = (result: NotifyOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      process.off('exit', killGroup)
      resolve(result)
    }

    // EPIPE when the command exits without reading its stdin.
    child.stdin?.on('error', () => {})
    // ENOENT or EACCES: no 'exit' follows.
    child.on('error', () => settle({ outcome: 'failed', exit_code: null }))
    child.on('exit', (code) => {
      if (timedOut) settle({ outcome: 'timeout', exit_code: null })
      else if (code === 0) settle({ outcome: 'delivered', exit_code: 0 })
      else settle({ outcome: 'failed', exit_code: code })
    })
    child.stdin?.end(payload)
  })
}
