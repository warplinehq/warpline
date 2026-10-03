/**
 * exit-after-flush — the one drain-then-exit step every exit of this process
 * goes through: the bin after a verb returns, `run`'s process tail, and
 * `advance`'s interrupt handler.
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
 *   1. Never call the exit in process. Ending a stream can't be undone, so a
 *      test that reached it would silence every file after its own. Its only
 *      callers are the bin, `run`'s process tail and the signal handler, which
 *      no in-process test reaches. `drained` and `guardStream` take any stream
 *      so they can be tested on a fake one.
 *   2. The error policy is on the stream before anything can fail. Without a
 *      listener node, the runtime the published bin runs on, prints an
 *      unhandled 'error' stack and exits 1 when the reader has gone away
 *      (`| head`). The drain puts its listener on before `end()`, but that is
 *      too late for a verb that writes and then awaits real I/O, such as the
 *      state lock's release: the EPIPE arrives before any drain exists. So the
 *      bin puts `guardStream` on both streams before any verb runs.
 *   3. `end`'s callback carries the write error, and `settle` reads it. EPIPE
 *      (the reader left) and ERR_STREAM_WRITE_AFTER_END (a plugin still
 *      printing after the end) settle quietly, so the command keeps its own
 *      exit code. Anything else rejects, and the exit becomes a crash rather
 *      than a clean code over lost output. A callback that ignored its
 *      argument would resolve on EIO. A non-quiet error raised before the
 *      drain is kept by the guard and becomes the drain's rejection.
 *   4. No ceiling. A reader that stops reading blocks this like any Unix
 *      writer. The signal handler owns its own two-second ceiling.
 *   5. There is one drain per stream. A second call, as when a second signal
 *      arrives, gets the first one's outcome, and the first code to reach
 *      `process.exit` wins.
 *
 * The memory of an earlier error or drain is the map below, never the
 * stream's own `destroyed` or `writableFinished` flags. Node's
 * `process.stdout` resets its state after an error or a finish, so a drain
 * that read those flags never settled, and node exited 13 on an unsettled
 * top-level await. On bun a second `end` rejects with
 * ERR_STREAM_ALREADY_FINISHED.
 */

const QUIET = new Set(['EPIPE', 'ERR_STREAM_WRITE_AFTER_END'])

/** One drain per stream: an outcome the guard recorded, or the drain itself. */
const drains = new WeakMap<NodeJS.WritableStream, Promise<void>>()

/** Resolves once `stream` has flushed and finished. Rejects on any error but the two quiet ones. */
export function drained(stream: NodeJS.WritableStream): Promise<void> {
  const existing = drains.get(stream)
  if (existing) return existing
  const drain = new Promise<void>((resolve, reject) => {
    const settle = (err?: NodeJS.ErrnoException | null): void => {
      if (err && !QUIET.has(err.code ?? '')) reject(err)
      else resolve()
    }
    stream.on('error', settle)
    stream.end(settle)
  })
  drains.set(stream, drain)
  return drain
}

/**
 * Puts the drain's error policy on `stream` before any drain exists. An error
 * raised first becomes the stream's drain: quiet for the two quiet codes, a
 * rejection for anything else.
 */
export function guardStream(stream: NodeJS.WritableStream): void {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    // A drain already listens and settles itself.
    if (drains.has(stream)) return
    if (QUIET.has(err.code ?? '')) {
      drains.set(stream, Promise.resolve())
      return
    }
    const failed = Promise.reject(err)
    // Rejects only once `drained` hands it on, never reported unhandled early.
    failed.catch(() => {})
    drains.set(stream, failed)
  })
}

/** Drains stdout and stderr, then exits with `code`. */
export async function exitAfterFlush(code: number): Promise<never> {
  await Promise.all([drained(process.stdout), drained(process.stderr)])
  process.exit(code)
}
