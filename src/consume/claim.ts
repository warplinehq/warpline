/**
 * claim — one consumer answering one Handoff.
 *
 * A claim is `<dir>/<id>.claim`, made by exclusive create: a symbolic link
 * whose text names its holder, as the audit lock is made. It is never waited
 * on, and it is never what serialises record writers: the record lock in
 * `handoffs.ts` does that, which is why `deny` can still withdraw a claimed
 * record.
 *
 * The identity rule is `pid-lock.ts`'s, so a claim from a container or host
 * this one cannot judge is never broken, only reported. Breaking a claim
 * across hosts is out of scope.
 */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { breakStale, holderOf, releaseHeld, takeHeld } from '../lib/pid-lock.js'

/**
 * `broke` is true when a dead holder's claim was removed to take this one, so
 * the pass can reconcile what that holder left. `held` is a live holder on this
 * host, or a break already under way; `foreign` is a holder this host cannot judge.
 */
export type ClaimOutcome = { claimed: true; token: string; broke: boolean } | { claimed: false; why: 'held' | 'foreign' }

const HELD: ClaimOutcome = { claimed: false, why: 'held' }
const FOREIGN: ClaimOutcome = { claimed: false, why: 'foreign' }

const claimPath = (dir: string, id: string) => join(dir, `${id}.claim`)

/** Claim Handoff `id` in `dir`, or say why not. One retry at most, never a wait. */
export function claimHandoff(dir: string, id: string): ClaimOutcome {
  const path = claimPath(dir, id)
  const token = randomUUID()
  if (takeHeld(path, token)) return { claimed: true, token, broke: false }
  const seen = holderOf(path)
  if (seen === null) return takeHeld(path, token) ? { claimed: true, token, broke: false } : HELD
  if (seen.gone && seen.token !== null) {
    const broken = breakStale(`${path}.break`, path, seen.token)
    if ((broken === 'removed' || broken === 'changed') && takeHeld(path, token)) {
      return { claimed: true, token, broke: broken === 'removed' }
    }
    return HELD
  }
  return seen.here && seen.pid !== null ? HELD : FOREIGN
}

/** Release the claim on `id` if it still holds `token`. */
export function releaseClaim(dir: string, id: string, token: string): void {
  releaseHeld(claimPath(dir, id), token)
}
