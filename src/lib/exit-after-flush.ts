/**
 * exit-after-flush — the one drain-then-exit step every exit of this process
 * goes through: the bin after a verb returns, and `advance`'s interrupt
 * handler.
 *
 * One implementation, not a barrier written at each exit: under a pipe,
 * writes to stdout and stderr are asynchronous, and a process that exits
 * while bytes are still queued in it cuts them off. A `--json` document of
 * 70 KB arrives at a reader that wasn't keeping up as its first 65,536 bytes,
 * on bun and on node alike. A barrier copied into each exit is one more place
 * for that to be forgotten.
 *
 * Zero dependencies by construction: `stream.end(cb)` is the barrier. On bun
 * from 1.4.2, and on node, its callback runs after every queued byte has
 * reached the descriptor. A zero-length `write('', cb)` looks like the same
 * thing and isn't: on bun its callback fires before the queue drains.
 *
 * Semantics:
 *   1. Never call this in process. Ending a stream can't be undone, so a test
 *      that reached it would silence every file after its own. Its only
 *      callers are the bin and the signal handler, which no in-process test
 *      reaches. `drained` takes any stream so it can be tested on a fake one.
 *   2. The 'error' listener goes on before `end()`. Without it node, the
 *      runtime the published bin runs on, prints an unhandled 'error' stack
 *      and exits 1 when the reader has gone away (`| head`). bun is silent
 *      either way.
 *   3. `end`'s callback carries the write error, and `settle` reads it. EPIPE
 *      (the reader left) and ERR_STREAM_WRITE_AFTER_END (a plugin still
 *      printing after the end) settle quietly, so the command keeps its own
 *      exit code. Anything else rejects, and the exit becomes a crash rather
 *      than a clean code over lost output. A callback that ignored its
 *      argument would resolve on EIO.
 *   4. No ceiling. A reader that stops reading blocks this like any Unix
 *      writer. The signal handler owns its own two-second ceiling.
 *   5. A second call, as when a second signal arrives, is harmless. The first
 *      code to reach `process.exit` wins.
 */

const QUIET = new Set(['EPIPE', 'ERR_STREAM_WRITE_AFTER_END'])

/** Resolves once `stream` has flushed and finished. Rejects on any error but the two quiet ones. */
export function drained(stream: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    const settle = (err?: NodeJS.ErrnoException | null): void => {
      if (err && !QUIET.has(err.code ?? '')) reject(err)
      else resolve()
    }
    stream.on('error', settle)
    stream.end(settle)
  })
}

/** Drains stdout and stderr, then exits with `code`. */
export async function exitAfterFlush(code: number): Promise<never> {
  await Promise.all([drained(process.stdout), drained(process.stderr)])
  process.exit(code)
}
