/**
 * A chain walker held out from the writer on purpose.
 *
 * It shares no code with the store's module and imports nothing from it, so a
 * bug in how the writer builds a line cannot also hide in how this checks one.
 * Everything here is recomputed from the bytes on disk: the sequence, every
 * `warplineprev` across segment files, each segment's name, and each torn
 * fragment a later segment acknowledges. Its independence is asserted on its
 * own source by the test that uses it, so an import added here turns red.
 *
 * `forge` lives here for the same reason. It keeps a forgery self-consistent
 * on purpose: after an edit, a swap or an insert it renumbers every seq and
 * re-links every `warplineprev`, so a link-only walker accepts the result and
 * only an anchor kept off the box can catch it. It covers one segment, because
 * links across a file boundary are already held by the walker's agreement test
 * and by the two-segment verify cases.
 */
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
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

/** Lines are 1-based seqs. `tear` appends its text with no newline. */
export type ForgeOp = { edit: number } | { swap: number } | { insert: number } | { truncate: number } | { tear: string }

const FIRST = '0000000000000001.jsonl'

/**
 * Rewrite the one segment in `dir` in place under its unchanged name. Throws
 * on any other store, so it is never handed a store whose re-linking it does
 * not cover. `truncate` and `tear` leave the remaining links as they are.
 */
export function forge(dir: string, op: ForgeOp): void {
  const names = readdirSync(dir).filter((n) => NAME.test(n))
  if (names.length !== 1 || names[0] !== FIRST) {
    throw new Error(`forge: a single-segment store only, holding ${FIRST}; found ${names.length} segment files`)
  }
  const path = join(dir, FIRST)
  if ('tear' in op) {
    appendFileSync(path, op.tear)
    return
  }
  const text = readFileSync(path, 'utf8')
  const lines = text.slice(0, text.lastIndexOf('\n') + 1).split('\n').slice(0, -1)
  const k = Object.values(op)[0] as number
  if (!Number.isInteger(k) || k < 1 || k > lines.length) throw new Error(`forge: line ${k} is not in the segment`)

  if ('truncate' in op) {
    writeFileSync(path, lines.slice(0, lines.length - k).map((l) => `${l}\n`).join(''))
    return
  }
  const recs = lines.map((l) => JSON.parse(l) as Record<string, unknown> & { data: Record<string, unknown> })
  if ('edit' in op) {
    const data = recs[k - 1]!.data
    const key = Object.keys(data).find((name) => typeof data[name] === 'string')
    if (key === undefined) throw new Error(`forge: line ${k} has no string value in its data to edit`)
    data[key] = `${data[key] as string}x`
  } else if ('swap' in op) {
    if (k === lines.length) throw new Error(`forge: line ${k} has no line after it to swap with`)
    ;[recs[k - 1], recs[k]] = [recs[k]!, recs[k - 1]!]
  } else {
    recs.splice(k, 0, structuredClone(recs[k - 1]!))
  }
  let prev = ZEROS
  const out = recs.map((rec, i) => {
    rec.id = String(i + 1)
    rec.warplineseq = i + 1
    rec.warplineprev = prev
    const line = JSON.stringify(rec)
    prev = sha256(Buffer.from(line))
    return `${line}\n`
  })
  writeFileSync(path, out.join(''))
}
