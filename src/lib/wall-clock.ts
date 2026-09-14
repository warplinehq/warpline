/**
 * wall-clock — the one resolver from an operator's naked wall clock plus an
 * IANA zone to an epoch-millisecond instant.
 *
 * One implementation, not a helper re-derived at each call site that needs a
 * fire window: a variant that inverts the zone offset with a single probe is
 * indistinguishable from this one for 363 days a year and silently wrong on
 * the other two, which is a send outside the approved window.
 *
 * Zero dependency by construction — `Intl.DateTimeFormat` is the only tz
 * database this runtime has. The newer standard date/time proposal is
 * `undefined` on both bun and the floor node this package declares in
 * `engines`, so it is not reached for.
 *
 * Resolution semantics:
 *   1. Parse `wall` with an anchored `YYYY-MM-DDTHH:mm[:ss]` regexp and reject
 *      anything else. A trailing `Z` or a numeric offset such as `+05:00` is a
 *      hard error: a wall clock is naked by definition, and quietly accepting
 *      an offset-bearing string resolves to an instant the operator did not
 *      ask for. Calendar fields are range-checked by round-tripping them
 *      through `Date.UTC`, which rejects `2026-02-30` without a per-month table.
 *   2. Reject an unknown zone by constructing an `Intl.DateTimeFormat` for it
 *      and rethrowing the `RangeError` as an `Error` naming the zone. A
 *      membership test against the `Intl` zone enumeration is NOT used: it
 *      omits zone links, so `US/Eastern` is absent from it while the formatter
 *      constructor accepts it, and the test would refuse zones the host tz
 *      database resolves perfectly well.
 *   3. Read the zone's fields for an instant via `formatToParts`, never by
 *      string-splitting a formatted date. `zoneFieldsAsUtc(t)` reassembles
 *      those fields through `Date.UTC`; `offsetAt(t)` is their difference from
 *      `t`.
 *   4. `guess` is the requested wall clock read as if it were UTC. Candidates
 *      are `guess - o` for each distinct offset `o` observed at `guess`, at the
 *      first candidate, and at `guess` plus and minus one day. The day either
 *      side is what makes the candidate set complete: probing only `guess` and
 *      the first candidate yields a SINGLE candidate whenever `guess` already
 *      lands on the post-transition side of a fall-back — which is every
 *      positive-offset zone, since `guess` sits one offset *earlier* than the
 *      instant it stands for. The smallest-survivor rule in step 5 would then
 *      pick the only occurrence it was handed, the later one, and quietly
 *      return second-occurrence for Europe/Berlin and Australia/Sydney while
 *      looking correct for America/New_York.
 *   5. Keep the candidates whose `zoneFieldsAsUtc` round-trips back to `guess`
 *      and return the SMALLEST. That single rule settles a DST overlap as
 *      first occurrence (RFC 5545). A single-probe inversion, which returns
 *      the first candidate unconditionally, is off by the DST shift within one
 *      transition of the target and yields an instant *before* the requested
 *      wall clock on fall-back — a window that opens an hour early.
 *   6. No survivor means the requested wall clock lies in a DST gap: it does
 *      not exist in this zone, and a probe never reports a gap time. Binary
 *      search the closed interval between the smallest and largest candidate
 *      to millisecond precision for the least instant carrying the largest
 *      candidate's offset, and return it. Exactly one transition lies in that
 *      interval, so the predicate is a single false-to-true step. The instant
 *      returned is the gap's end, which is the first instant at or after the
 *      requested wall clock — the same rule as step 5, not a second one.
 *
 * The host tz database is read at call time and no snapshot is pinned, so a
 * tzdb update between approval and fire changes the resolved instant. That is
 * deliberate: pinning would make warpline wrong about the world.
 */

const WALL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/
const DAY_MS = 86_400_000

/**
 * Resolve a naked wall clock in an IANA zone to epoch milliseconds.
 *
 * @param wall - `YYYY-MM-DDTHH:mm` with an optional `:ss`. No `Z`, no offset.
 * @param zone - an IANA zone name or link, e.g. `America/New_York`, `US/Eastern`.
 * @throws if `wall` is not a naked wall clock, or `zone` is unknown to the host.
 */
export function resolveWallClock(wall: string, zone: string): number {
  const match = WALL_PATTERN.exec(wall)
  if (match === null) {
    throw new Error(
      `wall clock ${JSON.stringify(wall)} is not a naked YYYY-MM-DDTHH:mm[:ss] string ` +
        `(a trailing Z or a numeric offset means a different instant than the operator read)`,
    )
  }

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = match[6] === undefined ? 0 : Number(match[6])

  const guess = Date.UTC(year, month - 1, day, hour, minute, second)
  const probe = new Date(guess)
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day ||
    probe.getUTCHours() !== hour ||
    probe.getUTCMinutes() !== minute ||
    probe.getUTCSeconds() !== second
  ) {
    throw new Error(`wall clock ${JSON.stringify(wall)} is not a real calendar date and time`)
  }

  let formatter: Intl.DateTimeFormat
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    throw new Error(`time zone ${JSON.stringify(zone)} is unknown to this host's tz database`)
  }

  const zoneFieldsAsUtc = (instant: number): number => {
    const fields: Record<string, number> = {}
    for (const part of formatter.formatToParts(instant)) {
      if (part.type !== 'literal') fields[part.type] = Number(part.value)
    }
    return Date.UTC(
      fields.year ?? 0,
      (fields.month ?? 1) - 1,
      fields.day ?? 1,
      fields.hour ?? 0,
      fields.minute ?? 0,
      fields.second ?? 0,
    )
  }
  const offsetAt = (instant: number): number => zoneFieldsAsUtc(instant) - instant

  const firstCandidate = guess - offsetAt(guess)
  const offsets = new Set([
    offsetAt(guess),
    offsetAt(firstCandidate),
    offsetAt(guess - DAY_MS),
    offsetAt(guess + DAY_MS),
  ])
  const candidates = [...new Set([...offsets].map((offset) => guess - offset))].sort((a, b) => a - b)

  const survivors = candidates.filter((candidate) => zoneFieldsAsUtc(candidate) === guess)
  if (survivors.length > 0) return survivors[0] as number

  // DST gap: no instant carries these wall-clock fields in this zone.
  let low = candidates[0] as number
  let high = candidates[candidates.length - 1] as number
  const afterOffset = offsetAt(high)
  while (low < high) {
    const mid = low + Math.floor((high - low) / 2)
    if (offsetAt(mid) === afterOffset) high = mid
    else low = mid + 1
  }
  return low
}
