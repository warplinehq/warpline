/**
 * A chain walker held out from the writer on purpose.
 *
 * It shares no code with the store's module and imports nothing from it, so a
 * bug in how the writer builds a line cannot also hide in how this checks one.
 * Everything here is recomputed from the bytes on disk: the sequence, every
 * `warplineprev` across segment files, each segment's name, and each torn
 * fragment a later segment acknowledges. Its independence is asserted on its
 * own source by the test that uses it, so an import added here turns red.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const NAME = /^\d{16}\.jsonl$/
const ZEROS = '0'.repeat(64)

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

export type ChainWalk =
  | { ok: true; head: { seq: number; hex: string }; lines: number; torn: boolean }
  | { ok: false; at: string; why: string }

/**
 * Walk every segment in `dir`, oldest first. A partial last line in a
 * segment that has a successor must be acknowledged, by length and digest, in
 * the successor's first line. A partial last line in the final segment is
 * reported as `torn`.
 */
export function walkChain(dir: string): ChainWalk {
  const names = readdirSync(dir).filter((n) => NAME.test(n)).sort()
  let seq = 0
  let prev = ZEROS
  let lines = 0
  let pending: { bytes: number; sha256: string } | null = null
  let torn = false

  for (const [fi, name] of names.entries()) {
    const buf = readFileSync(join(dir, name))
    let start = 0
    let n = 0
    for (let nl = buf.indexOf(0x0a); nl !== -1; nl = buf.indexOf(0x0a, start)) {
      const line = buf.subarray(start, nl)
      start = nl + 1
      n += 1
      const at = `${name}:${n}`
      let rec: { warplineseq?: unknown; warplineprev?: unknown; data?: { fragment?: unknown } }
      try {
        rec = JSON.parse(line.toString('utf-8'))
      } catch {
        return { ok: false, at, why: 'not JSON' }
      }
      if (rec.warplineseq !== seq + 1) return { ok: false, at, why: `seq ${String(rec.warplineseq)}, expected ${seq + 1}` }
      if (rec.warplineprev !== prev) return { ok: false, at, why: 'warplineprev is not the hash of the previous line' }
      if (n === 1) {
        if (name !== `${String(seq + 1).padStart(16, '0')}.jsonl`) {
          return { ok: false, at, why: 'file name is not its first seq' }
        }
        const fragment = (rec.data?.fragment ?? null) as { bytes?: unknown; sha256?: unknown } | null
        const matches =
          pending === null
            ? fragment === null
            : fragment !== null && fragment.bytes === pending.bytes && fragment.sha256 === pending.sha256
        if (!matches) {
          return { ok: false, at, why: 'fragment acknowledgement does not match the previous segment' }
        }
        pending = null
      }
      seq += 1
      prev = sha256(line)
      lines += 1
    }
    if (n === 0) return { ok: false, at: `${name}:1`, why: 'segment holds no complete line' }
    const rest = buf.subarray(start)
    if (rest.length > 0) {
      if (fi === names.length - 1) torn = true
      else pending = { bytes: rest.length, sha256: sha256(rest) }
    }
  }
  return { ok: true, head: { seq, hex: prev }, lines, torn }
}
