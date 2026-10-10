/**
 * FREEZE-10, as amended 2026-10-09 for standing grants. This header is the canonical text. The planning requirements carry a pointer to it, never a copy.
 *
 *   1. `src/runtime/approval-gate.ts` stays byte-identical to
 *      `APPROVAL_GATE_SHA256` for the rest of the v0.4 milestone. Guarded by
 *      this file.
 *   2. The `PendingGateSchema` declaration in `src/schemas/engine-state.ts`
 *      stays byte-identical to `PENDING_GATE_BLOCK_SHA256`. Guarded by this
 *      file.
 *   3. No content-approval path reaches any export of the gate,
 *      `applyPendingGate` or `PendingGateSchema`. Guarded by
 *      `src/__tests__/no-approval-gate-from-content.test.ts`, whose forbidden
 *      set is enumerated from the gate's exports, so a new export joins it
 *      without anyone extending a list.
 *   4. Nothing reachable from `warpline advance` or `warpline run` writes the
 *      standing grants file. Guarded by
 *      `src/__tests__/no-standing-write-from-run.test.ts`.
 *   5. The capability layer never reads a grant of either kind. Guarded by
 *      `src/__tests__/no-grant-recheck.test.ts`.
 *   6. `warpline deny` calls no grant writer. Guarded by test 14 in
 *      `src/cli/__tests__/deny.test.ts`, whose hand-kept writer list is
 *      checked against the gate's live exports.
 *   7. A run leaves the session grant file byte- and mtime-identical. Guarded
 *      by test 8 in `src/runtime/__tests__/approval-gate.test.ts`.
 *
 * Clauses 1 and 2 are the BYTE half and live here; the rest are the reach and
 * write half and live in the guards each names. `CLAUSE_GUARDS` below asserts
 * every guard file cited above still exists, so a clause cannot outlive the
 * test that holds it.
 *
 * `applyPendingGate` is deliberately absent from the byte half. It gained a required
 * `opts.manifests` and an approval carve-out on purpose, so that a pending-gate
 * discard cannot destroy the `last_output` a live approval's fingerprint is
 * bound to. Pinning it would assert something the milestone knowingly
 * falsified; its half of the guarantee is reachability, which the sibling guard
 * carries.
 *
 * **Why one pin is a whole file and the other is a slice.**
 * `approval-gate.ts` had zero commits from `v0.2` until the #27 amendment, and
 * every change since is one FREEZE-10 names, so a file-level digest is exactly
 * the claim. `engine-state.ts` has had four in the same span, none
 * of them touching `PendingGateSchema` — a file-level digest there would go red
 * on the next unrelated schema field, and a pin that reddens for reasons its
 * contract never claimed gets deleted rather than read. So the second pin is
 * scoped to the declaration, sliced between two structural anchors rather than
 * by line numbers, which move.
 *
 * **Provenance.** The file digest was the `v0.2` content's until FREEZE-10 was
 * amended on 2026-09-30 for #27, and the per-scope-window gate's until it was
 * amended on 2026-10-09 for standing grants; it now pins the gate with both
 * grant kinds. The block digest was the `v0.2`
 * content's too until FREEZE-10 was amended on 2026-09-23. It now pins the
 * amended declaration, whose one changed line is `plugin_result`. Reproduce:
 *
 *   git show v0.2:src/runtime/approval-gate.ts | shasum -a 256
 *   shasum -a 256 src/runtime/approval-gate.ts
 *   awk '/^export const PendingGateSchema = z\.object\(\{$/,/^export type PendingGate = /' \
 *     src/schemas/engine-state.ts | shasum -a 256
 *
 * **When one of these is legitimately changed.** Amend the clause list above
 * FIRST, in the same commit as the constant, with the reason, so the written
 * guarantee stops claiming a byte identity that no longer holds. Updating the
 * constant alone re-creates the exact defect this pin closes: a requirement
 * marked complete against a sentence the code falsifies. Deleting the test is
 * the same defect with the evidence removed.
 *
 * **Every enumeration throws rather than returning empty**, the discipline
 * `no-approval-gate-from-content.test.ts:34-40` states in its own words. A slice
 * whose anchor vanished must fail closed: "could not look" is not "looked and it
 * was fine".
 *
 * Both helpers are PURE and take source TEXT, so the identical code runs against
 * the real tree and against doctored in-memory copies. Nothing touches disk and
 * no directory is left behind.
 */
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const APPROVAL_GATE = join(REPO_ROOT, 'src', 'runtime', 'approval-gate.ts')
const ENGINE_STATE = join(REPO_ROOT, 'src', 'schemas', 'engine-state.ts')

/**
 * Re-pinned when FREEZE-10 was amended on 2026-10-09 for standing grants: the
 * standing grants file, its own reader version, lapse derived on read, the
 * covering list naming each grant that authorises a scope and its issuer, and
 * the session window's issuer. The #27 digest, pinned when FREEZE-10 was
 * amended on 2026-09-30 for per-scope windows, was
 * `b3918f0dd76abf3dd783c42b30738246293d246c0da02c70b2229a6fd87ed766`, and the
 * `v0.2` digest `d286a53f2b55b19ddbabeae64ce3bc0423912d376860cd5d73c23e6d48ffb72d`.
 */
const APPROVAL_GATE_SHA256 = 'c374cd307d29b666c62007af6a6f265ffc15ba9d1b307db0092a4d8a114180a5'

/** The guard file each clause in the header cites, repo-relative. */
const CLAUSE_GUARDS = [
  'src/__tests__/no-approval-gate-from-content.test.ts',
  'src/__tests__/no-standing-write-from-run.test.ts',
  'src/__tests__/no-grant-recheck.test.ts',
  'src/cli/__tests__/deny.test.ts',
  'src/runtime/__tests__/approval-gate.test.ts',
]
/**
 * Re-pinned when FREEZE-10 was amended on 2026-09-23. `plugin_result` takes
 * `StoredSkillResultSchema`, so an applied gate can hold an erased Output: once
 * erasure releases the content the gate recorded, its copy is erased in the same
 * write and the fail-closed read must still accept the gate. Every other line of
 * the declaration is the `v0.2` one. The `v0.2` digest was
 * `37141140c4d83cc8807f44d630d4d0620104469f7486e859cbd51927403c5815`.
 */
const PENDING_GATE_BLOCK_SHA256 =
  '5fcadf77f9e2dd0fa25ca0085b4e02f7cd933b399d7d3a4d5b30c0a24cc888d3'

const BLOCK_START = 'export const PendingGateSchema = z.object({'
const BLOCK_END = 'export type PendingGate = '

function digest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * The `PendingGateSchema` declaration, from its opening line through the type
 * alias that closes it, inclusive.
 *
 * Both anchors must occur EXACTLY once and in order. A duplicated start would
 * make the slice depend on which one won; a missing either end would silently
 * shorten it, and a shorter slice still hashes to something.
 */
function pendingGateBlock(text: string): string {
  const lines = text.split('\n')
  const at = (pred: (l: string) => boolean, what: string): number => {
    const hits = lines.flatMap((l, i) => (pred(l) ? [i] : []))
    if (hits.length !== 1) {
      throw new Error(`blind: expected exactly one ${what} anchor, found ${hits.length}`)
    }
    return hits[0] as number
  }
  const start = at((l) => l === BLOCK_START, `\`${BLOCK_START}\``)
  const end = at((l) => l.startsWith(BLOCK_END), `\`${BLOCK_END}\``)
  if (end <= start) {
    throw new Error(`blind: ${BLOCK_END} anchor precedes ${BLOCK_START} — the slice would be empty`)
  }
  return `${lines.slice(start, end + 1).join('\n')}\n`
}

const REAL_GATE = readFileSync(APPROVAL_GATE, 'utf8')
const REAL_STATE = readFileSync(ENGINE_STATE, 'utf8')

describe('the two artifacts FREEZE-10 holds byte-identical still are', () => {
  test('src/runtime/approval-gate.ts is byte-unchanged', () => {
    expect(digest(REAL_GATE)).toBe(APPROVAL_GATE_SHA256)
  })

  test('the PendingGateSchema declaration is byte-unchanged', () => {
    expect(digest(pendingGateBlock(REAL_STATE))).toBe(PENDING_GATE_BLOCK_SHA256)
  })

  test('every guard a FREEZE-10 clause cites exists', () => {
    if (CLAUSE_GUARDS.length === 0) throw new Error('blind: no clause guard listed')
    for (const path of CLAUSE_GUARDS) expect(existsSync(join(REPO_ROOT, path))).toBe(true)
  })

  /**
   * Positive control. A slice that quietly collapsed to a line or two would
   * hash to something, and a wrong digest reads the same as a real edit.
   */
  test('the slice really is the declaration and not a fragment of it', () => {
    const block = pendingGateBlock(REAL_STATE)
    expect(block.startsWith(BLOCK_START)).toBe(true)
    expect(block.trimEnd().endsWith('>')).toBe(true)
    expect(block.split('\n').length).toBeGreaterThan(20)
  })
})

/**
 * The paired red-proof.
 *
 * The assertions above pass over a tree that is clean today, and this is what
 * stops them being trusted on that basis: the SAME helpers, handed a copy with
 * one byte moved, must disagree with the pin.
 */
describe('the same helpers report a copy that is not byte-identical', () => {
  test('one flipped byte in approval-gate.ts breaks the file pin', () => {
    const doctored = REAL_GATE.replace('import', 'Import')
    expect(doctored).not.toBe(REAL_GATE) // vacuity: the fixture really is doctored
    expect(digest(doctored)).not.toBe(APPROVAL_GATE_SHA256)
  })

  /**
   * Doctored AT the start anchor, so the added line is inside the slice by
   * construction. An earlier draft doctored `plugin: z.string(),` and this test
   * reported red: that text occurs in an EARLIER schema too, so `replace` moved
   * a byte outside the declaration and the block pin — correctly — did not
   * notice. That miss is the case below, and the reason the second pin is a
   * slice.
   */
  test('one added line inside the declaration breaks the block pin', () => {
    const doctored = REAL_STATE.replace(BLOCK_START, `${BLOCK_START}\n  added: z.string(),`)
    expect(doctored).not.toBe(REAL_STATE)
    expect(digest(pendingGateBlock(doctored))).not.toBe(PENDING_GATE_BLOCK_SHA256)
  })

  /**
   * A byte moved OUTSIDE the declaration must NOT break the block pin — this is
   * the whole reason the second pin is a slice rather than a file digest.
   */
  test('an unrelated edit elsewhere in engine-state.ts leaves the block pin green', () => {
    const doctored = `${REAL_STATE}\nexport const UnrelatedLater = z.string()\n`
    expect(doctored).not.toBe(REAL_STATE)
    expect(digest(pendingGateBlock(doctored))).toBe(PENDING_GATE_BLOCK_SHA256)
  })

  test('a vanished end anchor fails closed rather than hashing a short slice', () => {
    const doctored = REAL_STATE.replace(BLOCK_END, 'type PendingGateRenamed = ')
    expect(doctored).not.toBe(REAL_STATE)
    expect(() => pendingGateBlock(doctored)).toThrow(/^blind:/)
  })

  test('a duplicated start anchor fails closed rather than picking one', () => {
    const doctored = `${REAL_STATE}\n${BLOCK_START}\n})\n`
    expect(() => pendingGateBlock(doctored)).toThrow(/^blind:/)
  })
})
