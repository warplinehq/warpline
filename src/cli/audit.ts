/**
 * `warpline audit` — read the audit store.
 *
 * `head` prints the last record's seq and the sha256 of its bytes, or `0` and
 * 64 zeros before the first record. Keeping that line somewhere off this box is
 * what a later check of the store is measured against. It takes no lock and
 * writes nothing, so it creates no store on a home that has none.
 *
 * Never terminates the process — it returns a code to the dispatcher.
 */
import { parseArgs } from 'node:util'
import { readHead } from '../lib/audit-log.js'
import { engineStatePath } from '../lib/paths.js'

export const USAGE = `Usage: warpline audit head

Prints the head of the audit record as "<seq> <hash>" on one line: the last
record's seq and the sha256 of its bytes. Keep it somewhere off this box.
`

export async function run(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv
  if (sub !== 'head') {
    process.stderr.write(USAGE)
    return 1
  }
  try {
    parseArgs({ args: rest, options: {}, allowPositionals: false, strict: true })
  } catch (err) {
    process.stderr.write(`warpline audit head: ${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`)
    return 1
  }
  const { seq, head } = await readHead(engineStatePath())
  process.stdout.write(`${seq} ${head}\n`)
  return 0
}
