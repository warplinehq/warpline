/**
 * line-diff — the line diff `warpline approvals show` prints between the last
 * approved content still on disk and the content an Ask is about.
 *
 * In-repo, with no dependency and nothing spawned: the common prefix and
 * suffix are trimmed, and greedy Myers runs over the lines left between them.
 * An empty string is zero lines, so a trailing newline is one more, empty,
 * line.
 */

export interface DiffLine {
  /** ` ` for a line both sides hold, `-` for one only before holds, `+` for one only after holds. */
  op: ' ' | '-' | '+'
  line: string
}

const linesOf = (s: string): string[] => (s === '' ? [] : s.split('\n'))

/** The edit script from `before` to `after`, in order. Where a line is replaced, the `-` comes first. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = linesOf(before)
  const b = linesOf(after)
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
  const same = (line: string): DiffLine => ({ op: ' ', line })
  return [
    ...a.slice(0, pre).map(same),
    ...myers(a.slice(pre, a.length - suf), b.slice(pre, b.length - suf)),
    ...a.slice(a.length - suf).map(same),
  ]
}

/**
 * Greedy Myers: the furthest-reaching x on each diagonal k, one round per edit
 * count d, then a walk back through the saved rounds.
 *
 * shortcut: greedy Myers keeps its trace, which is O((N+M)·D) memory; switch
 * to linear-space Myers if a very large path Output ever matters.
 */
function myers(a: string[], b: string[]): DiffLine[] {
  const n = a.length
  const m = b.length
  const max = n + m
  if (max === 0) return []
  const at = (k: number): number => k + max
  const v = new Array<number>(2 * max + 2).fill(0)
  const trace: number[][] = []
  // Step from diagonal k+1 (an insertion, moving down) or k-1 (a deletion, moving right).
  const fromAbove = (row: number[], k: number, d: number): boolean =>
    k === -d || (k !== d && row[at(k - 1)]! < row[at(k + 1)]!)

  search: for (let d = 0; d <= max; d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x = fromAbove(v, k, d) ? v[at(k + 1)]! : v[at(k - 1)]! + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[at(k)] = x
      if (x >= n && y >= m) break search
    }
  }

  const out: DiffLine[] = []
  let x = n
  let y = m
  for (let d = trace.length - 1; d >= 0; d--) {
    const row = trace[d]!
    const k = x - y
    const prevK = fromAbove(row, k, d) ? k + 1 : k - 1
    const prevX = row[at(prevK)]!
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      out.push({ op: ' ', line: a[x - 1]! })
      x--
      y--
    }
    if (d > 0) out.push(x === prevX ? { op: '+', line: b[y - 1]! } : { op: '-', line: a[x - 1]! })
    x = prevX
    y = prevY
  }
  return out.reverse()
}
