#!/usr/bin/env node
/**
 * Single-plugin invocation, as a library function plus a process-level tail.
 *
 * The board SPAWNS THIS FILE and parses its stdout as JSON:
 *
 *   Board (Node/tsx) -> spawn('bun', ['run', 'src/cli/run-plugin.ts',
 *                              plugin, action, '--json'])
 *   -> reads the JSON result from stdout
 *
 * That spawn is the contract (grep: zero in-repo importers besides the
 * dispatcher, and zero in-repo spawners). `--json` reproduces the pre-02-08
 * bytes exactly — same keys, same order, same omission of `error` on success —
 * so a machine consumer adds the flag and sees nothing else change. Without it
 * the output is prose, because `run` is a subcommand `--help` advertises and a
 * human has to be able to read it.
 *
 * Hence two things that look like oversights and are not:
 *
 *   1. The bun shebang on line 1 stays. Only `src/bin/warpline.ts` carries the
 *      node shebang, deliberately. Do not "harmonize" them — repointing the
 *      board is out of scope, and changing a working spawn contract inside a
 *      publish phase is gratuitous risk.
 *   2. The SIGINT handler and its 130 exit live in the tail below, not in
 *      `runPlugin`, because they install a process-level listener.
 *
 * `runPlugin(argv, signal)` returns `{ payload, code, stdout }` rather than
 * printing and exiting, so every branch is testable in-process. The
 * payload keeps the same six keys in the same order it has always had; it is
 * built once and both renderings read from that one object, so they cannot
 * drift. Duration rounding in the prose is cosmetic and is deliberately not
 * mirrored into the payload, which carries the raw millisecond value.
 *
 * Exit codes:
 *   0   — the invocation ran (check `ok` for the logical outcome; a handler
 *         that throws is converted to a failed SkillResult upstream and still
 *         exits 0, which is what the board expects)
 *   1   — usage error, or the invoker itself threw
 *   130 — SIGINT received (conventional bash exit code)
 */
import * as util from 'node:util'
import { invokePlugin } from '../runtime/invoke-plugin.js'

const USAGE =
  'Usage: warpline run <plugin-name> <action-key> [--retries=N] [--json]'
const RETRIES_ERROR = 'Invalid --retries value; expected integer in [0, 10]'

/**
 * The stdout contract. Key ORDER is part of it, so build this only
 * as a single object literal. `error` is `undefined` rather than `null` on
 * success so that `JSON.stringify` omits it, exactly as it always has.
 */
export interface RunPayload {
  ok: boolean
  error?: string
  duration_ms?: number
  attempt_count?: number
  cancelled?: boolean
  timed_out?: boolean
}

export interface RunPluginOutcome {
  payload: RunPayload
  code: number
  /** Exactly what belongs on stdout: the serialized payload, or the prose. */
  stdout: string
  /**
   * Set when argument parsing failed. It belongs on stderr and stdout must stay
   * empty — the board parses stdout and a usage message there would poison it.
   */
  usageError?: string
}

/** Reject before any invocation: message to stderr, nothing on stdout. */
function usage(message: string): RunPluginOutcome {
  return {
    payload: { ok: false, error: message },
    code: 1,
    stdout: '',
    usageError: message,
  }
}

/** Milliseconds are unreadable past a second or two; the payload keeps the raw value. */
function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
}

/**
 * Operator-facing rendering of the same payload the machine path serializes.
 * Plain text: no ANSI, no padded columns.
 *
 * Deliberately says "interrupted" and "timed out" rather than echoing the
 * invoker's own message for those two cases — those messages repeat the raw
 * payload key names, and the status word already carries the information.
 */
function renderHuman(payload: RunPayload): string {
  const status = payload.cancelled
    ? 'interrupted'
    : payload.timed_out
      ? 'timed out'
      : payload.ok
        ? 'succeeded'
        : 'failed'

  const line = [status]
  if (payload.duration_ms !== undefined) {
    line.push(`in ${formatDuration(payload.duration_ms)}`)
  }
  if (payload.attempt_count !== undefined) {
    const n = payload.attempt_count
    line.push(`(${n} attempt${n === 1 ? '' : 's'})`)
  }

  const plainFailure = !payload.ok && !payload.cancelled && !payload.timed_out
  const detail = plainFailure && payload.error ? `\n${payload.error}` : ''
  return line.join(' ') + detail
}

export async function runPlugin(
  argv: string[],
  signal?: AbortSignal,
): Promise<RunPluginOutcome> {
  let values: { retries?: string; json?: boolean }
  let positionals: string[]
  try {
    const parsed = util.parseArgs({
      args: argv,
      options: { retries: { type: 'string' }, json: { type: 'boolean' } },
      allowPositionals: true,
      strict: true,
    })
    values = parsed.values
    positionals = parsed.positionals
  } catch (err) {
    return usage(err instanceof Error ? err.message : String(err))
  }

  let retriesOverride: number | undefined
  if (values.retries !== undefined) {
    const retries = Number.parseInt(values.retries, 10)
    if (!Number.isInteger(retries) || retries < 0 || retries > 10) {
      return usage(RETRIES_ERROR)
    }
    retriesOverride = retries
  }

  const [plugin, action] = positionals
  if (!plugin || !action) return usage(USAGE)

  try {
    const invocation = await invokePlugin(
      plugin,
      { action },
      {
        signal,
        maxRetriesOverride: retriesOverride,
        persistArtifact: true,
        userInitiated: true,
      },
    )
    const ok = invocation.result.status !== 'failed'
    const payload: RunPayload = {
      ok,
      error: ok
        ? undefined
        : invocation.result.errors?.[0]?.message ?? 'Plugin execution failed',
      duration_ms: invocation.duration_ms,
      attempt_count: invocation.attempt_count,
      cancelled: invocation.cancelled,
      timed_out: invocation.timed_out,
    }
    return { payload, code: 0, stdout: render(payload, values.json) }
  } catch (err) {
    const payload: RunPayload = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
    return { payload, code: 1, stdout: render(payload, values.json) }
  }
}

/** One payload, two renderings — they cannot drift because there is one source. */
function render(payload: RunPayload, json: boolean | undefined): string {
  return json ? JSON.stringify(payload) : renderHuman(payload)
}

// ---------------------------------------------------------------------------
// Process-level tail
// ---------------------------------------------------------------------------
// Runs when this file is the process entry (the board's spawn) AND when the
// `warpline` dispatcher side-effect-imports it, which is how its frozen `run`
// arm invokes this command. It must NOT run under `bun test`, where the test
// runner's own argv would be parsed as a plugin invocation — hence the
// NODE_ENV guard, which bun test sets for the whole suite.
if (import.meta.main || process.env.NODE_ENV !== 'test') {
  const controller = new AbortController()
  const onSigint = () => {
    controller.abort(new Error('SIGINT'))
    // Give the handler a tick to observe the abort before exiting.
    setTimeout(() => process.exit(130), 50)
  }
  process.on('SIGINT', onSigint)

  const outcome = await runPlugin(process.argv.slice(2), controller.signal)
  const stream = outcome.usageError ? process.stderr : process.stdout
  const line = outcome.usageError ?? outcome.stdout
  // Await the flush: stdout is a pipe when the board spawns us, and writes to a
  // pipe are async — process.exit() without this can truncate the payload.
  await new Promise<void>(resolve => {
    stream.write(`${line}\n`, () => resolve())
  })
  // Terminate here rather than returning an exit code: the dispatcher's `run`
  // arm cannot forward one (it is closed for modification), so falling through
  // would make every `warpline run` exit 1.
  //
  // A cancelled invocation exits 130 regardless of which finishes first. The
  // timer above cannot be relied on: an abort-aware handler returns the moment
  // it sees the signal, so the invocation can resolve, render and flush inside
  // the 50 ms — and `outcome.code` for a completed invocation is 0. Reading the
  // signal makes the interrupt contract independent of that race.
  process.exit(controller.signal.aborted ? 130 : outcome.code)
}
