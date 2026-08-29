/**
 * "Did you mean …?" for a mistyped plugin name.
 *
 * Extracted from `approve.ts` when `deny.ts` needed the same behaviour. A
 * second copy would drift: the threshold below is a judgement call, and two
 * verbs disagreeing about when a name is close enough would make the CLI feel
 * arbitrary. Importing it from `approve.ts` was the smaller diff and the wrong
 * one — that would give `deny.ts` an import path to `mergeGrant`, and a denial
 * must have no route to the grant file at all.
 */

/** Levenshtein distance — only ever called on a typo, so the O(nm) is free. */
function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
    prev = row
  }
  return prev[b.length]
}

/**
 * The closest known name, or null when nothing is close enough to suggest.
 *
 * The threshold scales with the typed name's length: two edits on a short name,
 * a third of it on a long one. A fixed threshold either refuses to help with
 * long names or suggests nonsense for short ones.
 */
export function suggest(name: string, known: string[]): string | null {
  let best: string | null = null
  let bestScore = Infinity
  for (const candidate of known) {
    const d = distance(name, candidate)
    if (d < bestScore) {
      bestScore = d
      best = candidate
    }
  }
  return best !== null && bestScore <= Math.max(2, Math.floor(name.length / 3)) ? best : null
}
