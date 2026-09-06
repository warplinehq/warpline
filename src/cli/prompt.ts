/**
 * The prompting primitive under `warpline configure`.
 *
 * This file exists because the obvious primitive loses input. Measured on
 * node v24.19.0 and bun 1.3.11, identically: a sequential walk over the
 * promises API's `question()` gets every line of a fast pipe during the FIRST
 * question's turn, so the second question registers after its line has gone
 * by and never resolves (or rejects, once the interface has closed on EOF).
 * Feeding lines slowly passes, which is exactly why a naive test misses it.
 *
 * Pulling from ONE async iterator over the callback interface does not lose
 * anything: each `next()` takes the next buffered line, and it reports `done`
 * past EOF instead of hanging. That pull is the whole reason for the file.
 *
 * The streams are PARAMETERS. Nothing here reaches for the process streams,
 * which is what lets a test drive a whole walk in-process from a
 * `Readable.from([...])` and read the prompts back from a collecting writable.
 * Spawning a process and piping answers to it is the path measured unreliable.
 */
import * as readline from 'node:readline'

export interface LineReader {
  /**
   * Write `prompt` to the output stream and return the next line, or `null`
   * once the input has ended. An empty line is `''`, which a caller can tell
   * from `null`: "no answer" and "empty answer" are different things.
   */
  ask(prompt: string): Promise<string | null>
  close(): void
}

/**
 * One reader per walk. It takes a single async iterator from the interface and
 * holds it for its lifetime; creating a new interface or a new iterator per
 * question is the failure described above under a different spelling.
 */
export function lineReader(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): LineReader {
  // No `output` on the interface: it would echo under a terminal, and the
  // prompt is written by hand below so the two streams stay independent.
  const rl = readline.createInterface({ input, terminal: false })
  const lines = rl[Symbol.asyncIterator]()
  return {
    async ask(prompt) {
      output.write(prompt)
      const { value, done } = await lines.next()
      return done ? null : value
    },
    close: () => rl.close(),
  }
}

/**
 * Whether `input` is a terminal the walk may prompt on.
 *
 * A truthiness check on purpose. A piped stdin reports `isTTY` as `undefined`
 * on both runtimes, not `false`, so a strict comparison against `false` calls
 * a pipe interactive in exactly the case that matters.
 */
export function isInteractive(input: { isTTY?: boolean }): boolean {
  return !!input.isTTY
}
