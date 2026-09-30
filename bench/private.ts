/**
 * The name-free pieces of the private-scale benchmark mode.
 *
 * Every private value reaches this mode through a gitignored config, and
 * nothing in this module names a fleet plugin, a fleet path or a fleet
 * variable. What IS public is the commitments ledger: an append-only file of
 * salted digests that lets anyone check, from git history alone, that the
 * private method was fixed before its results existed, without learning what
 * either says.
 *
 * The ledger's line format is a one-way door. Once a `prereg` line is
 * committed, the freeze test forbids removing it, so the format can never be
 * changed after that without the history saying so.
 */
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The tracked ledger, relative to the repository root. */
export const COMMITMENTS_FILE = 'bench/private-commitments'

/**
 * The only legal ledger line. Lowercase hex and nothing around it: a trailing
 * space or a carriage return is a malformed line, never a tolerated one, since
 * a tolerant parser is how two different files come to read as the same list.
 */
export const COMMITMENT_LINE = /^(prereg|results) ([0-9a-f]{64})$/

export type CommitmentKind = 'prereg' | 'results'

export interface CommitmentLine {
  kind: CommitmentKind
  hex: string
}

/**
 * Every line of the ledger, in file order.
 *
 * A single trailing newline is allowed, and nothing else is skipped: a blank
 * line in the middle is malformed. The error names the 1-based line number and
 * never the line itself, because this runs in public CI logs.
 */
export function parseCommitments(text: string): CommitmentLine[] {
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.map((line, i) => {
    const m = COMMITMENT_LINE.exec(line)
    if (!m) throw new Error(`commitments: line ${i + 1} is not a prereg or results entry of 64 lowercase hex`)
    return { kind: m[1] as CommitmentKind, hex: m[2]! }
  })
}

/**
 * The public digest of a private document: sha256 over the salt, then the
 * document. The salt is what stops a short or guessable document from being
 * recovered by hashing candidates, so anything but 32 bytes of it is refused.
 */
export function commitment(salt: Uint8Array, doc: Uint8Array): string {
  if (salt.length !== 32) throw new Error(`commitment: the salt must be 32 bytes, got ${salt.length}`)
  return createHash('sha256').update(salt).update(doc).digest('hex')
}

const sha256hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/**
 * One digest for a whole directory: sha256 over one `relpath\0sha256(bytes)\n`
 * line per regular file, sorted. Names and bytes only, never an archive, whose
 * timestamps and modes would make the same tree hash two ways.
 *
 * A symlink throws rather than being followed or skipped: followed, the digest
 * binds whatever the link points at today; skipped, it binds less than the
 * tree. An empty tree throws, because a digest over nothing binds nothing.
 * Empty directories contribute no line, so they are not bound.
 */
export function treeDigest(root: string): string {
  const files: string[] = []
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      const child = rel === '' ? entry.name : `${rel}/${entry.name}`
      const stat = lstatSync(join(root, child))
      if (stat.isDirectory()) walk(child)
      else if (stat.isFile()) files.push(child)
      else throw new Error(`treeDigest: '${child}' is not a regular file — a digest cannot bind what a link points at`)
    }
  }
  walk('')
  if (files.length === 0) {
    throw new Error(`treeDigest: no regular file under '${root}' — a digest over nothing binds nothing`)
  }
  // Default sort, by UTF-16 code unit, never localeCompare: the engine's
  // plugin loader makes the same choice so its ordering cannot vary by locale,
  // and a digest that did would not be a digest.
  files.sort()
  return sha256hex(Buffer.from(files.map((rel) => `${rel}\0${sha256hex(readFileSync(join(root, rel)))}\n`).join('')))
}
