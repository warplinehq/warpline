#!/usr/bin/env bun
/**
 * Single-plugin invocation, as a library function plus a process-level tail.
 *
 * The board SPAWNS THIS FILE and parses its stdout as JSON:
 *
 *   Board (Node/tsx) -> spawn('bun', ['run', 'src/cli/run-plugin.ts', plugin, action])
 *   -> reads the JSON result from stdout
 *
 * That spawn is the contract (grep: zero in-repo importers besides the
 * dispatcher). Hence two things that look like oversights and are not:
 *
 *   1. The bun shebang on line 1 stays. Only `src/bin/warpline.ts` carries the
 *      node shebang, deliberately. Do not "harmonize" them — repointing the
 *      board is out of scope, and changing a working spawn contract inside a
 *      publish phase is gratuitous risk (D-17).
 *   2. The SIGINT handler and its 130 exit live in the tail below, not in
 *      `runPlugin`, because they install a process-level listener.
 *
 * `runPlugin(argv, signal)` returns `{ payload, code }` rather than printing
 * and exiting, so every branch is testable in-process (D-27). The payload keeps
 * the same six keys in the same order it has always had; it is built once and
 * both the machine and human renderings read from that one object, so they
 * cannot drift.
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

const USAGE = 'Usage: warpline run <plugin-name> <action-key> [--retries=N]'
const RETRIES_ERROR = 'Invalid --retries value; expected integer in [0, 10]'

/**
 * The stdout contract. Key ORDER is part of it (T-02-23), so build this only
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
  /**
   * Set when argument parsing failed. It belongs on stderr and stdout must stay
   * empty — the board parses stdout and a usage message there would poison it.
   */
  usageError?: string
}

/** Reject before any invocation: message to stderr, nothing on stdout. */
function usage(message: string): RunPluginOutcome {
  return { payload: { ok: false, error: message }, code: 1, usageError: message }
}

export async function runPlugin(
  argv: string[],
  signal?: AbortSignal,
): Promise<RunPluginOutcome> {
  let values: { retries?: string }
  let positionals: string[]
  try {
    const parsed = util.parseArgs({
      args: argv,
      options: { retries: { type: 'string' } },
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
    return {
      payload: {
        ok,
        error: ok
          ? undefined
          : invocation.result.errors?.[0]?.message ?? 'Plugin execution failed',
        duration_ms: invocation.duration_ms,
        attempt_count: invocation.attempt_count,
        cancelled: invocation.cancelled,
        timed_out: invocation.timed_out,
      },
      code: 0,
    }
  } catch (err) {
    return {
      payload: { ok: false, error: err instanceof Error ? err.message : String(err) },
      code: 1,
    }
  }
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
  const line = outcome.usageError ?? JSON.stringify(outcome.payload)
  // Await the flush: stdout is a pipe when the board spawns us, and writes to a
  // pipe are async — process.exit() without this can truncate the payload.
  await new Promise<void>(resolve => {
    stream.write(`${line}\n`, () => resolve())
  })
  // Terminate here rather than returning an exit code: the dispatcher's `run`
  // arm cannot forward one (it is closed for modification), so falling through
  // would make every `warpline run` exit 1.
  process.exit(outcome.code)
}
