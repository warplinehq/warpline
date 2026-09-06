/**
 * RED stub: the naive prompting primitive, a sequential question() walk on the
 * promises API. Kept only long enough to watch the fast-pipe test fail.
 */
import * as readline from 'node:readline/promises'

export interface LineReader {
  ask(prompt: string): Promise<string | null>
  close(): void
}

export function lineReader(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): LineReader {
  const rl = readline.createInterface({ input, terminal: false })
  return {
    async ask(prompt) {
      output.write(prompt)
      return rl.question('')
    },
    close: () => rl.close(),
  }
}

export function isInteractive(input: { isTTY?: boolean }): boolean {
  return input.isTTY === false ? false : true
}
