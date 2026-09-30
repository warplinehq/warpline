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
