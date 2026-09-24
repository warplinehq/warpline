/**
 * wall-clock tests.
 *
 * Covers: resolveWallClock. Pure unit — no filesystem, no temp home, no engine
 * fixtures. Every expectation is a `Date.parse('<ISO>Z')` literal, never an
 * offset recomputed by the same arithmetic the implementation uses: an
 * expectation derived that way asserts the implementation against itself.
 * One case replaces `Intl.DateTimeFormat` for one synchronous call pair and
 * restores it in `finally`.
 */
import { describe, it, expect } from 'bun:test'

import { resolveWallClock } from '../wall-clock.js'

describe('resolveWallClock — ordinary instants', () => {
  it('resolves a summer wall clock in America/New_York (EDT, UTC-4)', () => {
    expect(resolveWallClock('2026-06-15T09:00', 'America/New_York')).toBe(
      Date.parse('2026-06-15T13:00:00Z'),
    )
  })

  it('resolves a wall clock in UTC to the same fields', () => {
    expect(resolveWallClock('2026-06-15T09:00', 'UTC')).toBe(Date.parse('2026-06-15T09:00:00Z'))
  })

  it('accepts an optional seconds field', () => {
    expect(resolveWallClock('2026-06-15T09:00:30', 'UTC')).toBe(Date.parse('2026-06-15T09:00:30Z'))
  })
})

describe('resolveWallClock — DST gap, America/New_York 2026-03-08', () => {
  it('resolves 02:30 on 2026-03-08 (a wall clock that does not exist) to the gap end 07:00Z', () => {
    // 02:30 local is unreachable on 2026-03-08: the zone jumps 01:59:59 EST to
    // 03:00:00 EDT. The answer is the first instant at or after the requested
    // wall clock, which is the transition instant itself — not the
    // post-transition probe at 07:30Z.
    expect(resolveWallClock('2026-03-08T02:30', 'America/New_York')).toBe(
      Date.parse('2026-03-08T07:00:00Z'),
    )
  })

  it('resolves 01:30 on 2026-03-08, the reachable neighbour below the gap', () => {
    expect(resolveWallClock('2026-03-08T01:30', 'America/New_York')).toBe(
      Date.parse('2026-03-08T06:30:00Z'),
    )
  })

  it('resolves 03:30 on 2026-03-08, the reachable neighbour above the gap', () => {
    expect(resolveWallClock('2026-03-08T03:30', 'America/New_York')).toBe(
      Date.parse('2026-03-08T07:30:00Z'),
    )
  })
})

describe('resolveWallClock — DST overlap, first occurrence (RFC 5545)', () => {
  it('resolves 01:30 on 2026-11-01 in America/New_York to the EDT occurrence at 05:30Z', () => {
    expect(resolveWallClock('2026-11-01T01:30', 'America/New_York')).toBe(
      Date.parse('2026-11-01T05:30:00Z'),
    )
  })

  it('does not resolve 01:30 on 2026-11-01 to the later EST occurrence at 06:30Z', () => {
    // Both instants format as 01:30 local. An implementation that takes the
    // later offset would pass the equality above only by coincidence, so the
    // negative case is asserted separately.
    expect(resolveWallClock('2026-11-01T01:30', 'America/New_York')).not.toBe(
      Date.parse('2026-11-01T06:30:00Z'),
    )
  })

  it('resolves 02:30 on 2026-10-25 in Europe/Berlin to the CEST occurrence at 00:30Z, not the CET one at 01:30Z', () => {
    // A positive-offset zone on fall-back. Both 00:30Z and 01:30Z format as
    // 02:30 local; the naive two-probe candidate set only ever produces the
    // later one, so this case is what keeps the first-occurrence rule true
    // outside the Americas.
    expect(resolveWallClock('2026-10-25T02:30', 'Europe/Berlin')).toBe(
      Date.parse('2026-10-25T00:30:00Z'),
    )
    expect(resolveWallClock('2026-10-25T02:30', 'Europe/Berlin')).not.toBe(
      Date.parse('2026-10-25T01:30:00Z'),
    )
  })
})

describe('resolveWallClock — zone validation', () => {
  it('throws for a zone the host tz database does not know, naming the zone', () => {
    expect(() => resolveWallClock('2026-06-15T09:00', 'Mars/Olympus_Mons')).toThrow(
      /Mars\/Olympus_Mons/,
    )
  })

  it('accepts a zone link the host resolves, US/Eastern', () => {
    // US/Eastern is a link to America/New_York. It is absent from the Intl
    // enumeration helper while the formatter constructor accepts it, so a
    // membership test against that helper would refuse a zone the host
    // resolves perfectly well.
    expect(() => resolveWallClock('2026-06-15T09:00', 'US/Eastern')).not.toThrow()
    expect(resolveWallClock('2026-06-15T09:00', 'US/Eastern')).toBe(
      Date.parse('2026-06-15T13:00:00Z'),
    )
  })
})

describe('resolveWallClock — wall string validation', () => {
  it('throws for a string carrying a trailing Z', () => {
    expect(() => resolveWallClock('2026-06-15T09:00Z', 'UTC')).toThrow(/2026-06-15T09:00Z/)
  })

  it('throws for a string carrying a numeric offset', () => {
    expect(() => resolveWallClock('2026-06-15T09:00+05:00', 'UTC')).toThrow(/\+05:00/)
  })

  it('throws for a non-date shape', () => {
    expect(() => resolveWallClock('tomorrow at nine', 'UTC')).toThrow(/tomorrow at nine/)
  })

  it('throws for a date-only string with no time', () => {
    expect(() => resolveWallClock('2026-06-15', 'UTC')).toThrow(/2026-06-15/)
  })

  it('throws for an out-of-range calendar field', () => {
    expect(() => resolveWallClock('2026-02-30T09:00', 'UTC')).toThrow(/2026-02-30T09:00/)
    expect(() => resolveWallClock('2026-13-01T09:00', 'UTC')).toThrow(/2026-13-01T09:00/)
    expect(() => resolveWallClock('2026-06-15T24:00', 'UTC')).toThrow(/2026-06-15T24:00/)
  })
})

describe('resolveWallClock — purity', () => {
  it('returns the identical number for the same (wall, zone) pair', () => {
    const first = resolveWallClock('2026-11-01T01:30', 'America/New_York')
    const second = resolveWallClock('2026-11-01T01:30', 'America/New_York')
    expect(second).toBe(first)
  })
})

/**
 * The in-process stand-in for a tz database update between approval and fire.
 *
 * The resolver must see the rules the host has at call time, so this case
 * swaps one zone's rules between two calls: after the flip, America/New_York
 * resolves with America/Chicago's rules. A resolver that kept a snapshot of the
 * zone, such as a per-zone formatter memo, would hand back the old rules and
 * the instant would not move. The real half, a tzdata package upgrade between
 * two runs of the same binary, can't be scheduled in-process, and this case
 * doesn't claim it.
 */
describe('resolveWallClock — zone rules are read at call time', () => {
  it('the resolved instant follows the zone rules at call time, no snapshot', () => {
    const Original = Intl.DateTimeFormat
    let swapped = false
    let rewrites = 0
    // A `function`, not an arrow: the resolver calls it with `new`, and an
    // arrow function is not constructible.
    const wrapper = function (locales?: string | string[], options?: Intl.DateTimeFormatOptions) {
      if (swapped && options?.timeZone === 'America/New_York') {
        rewrites += 1
        return new Original(locales, { ...options, timeZone: 'America/Chicago' })
      }
      return new Original(locales, options)
    }
    // A non-writable property makes this return false instead of throwing, and
    // a silent no-op install is a case that cannot fail.
    expect(Reflect.set(Intl, 'DateTimeFormat', wrapper)).toBe(true)

    let before: number
    let after: number
    try {
      before = resolveWallClock('2026-10-01T09:00', 'America/New_York')
      swapped = true
      after = resolveWallClock('2026-10-01T09:00', 'America/New_York')
    } finally {
      Reflect.set(Intl, 'DateTimeFormat', Original)
    }

    // EDT, UTC-4.
    expect(before).toBe(Date.parse('2026-10-01T13:00:00Z'))
    // CDT, UTC-5. The one a snapshot of the zone turns red.
    expect(after).toBe(Date.parse('2026-10-01T14:00:00Z'))
    expect(after - before).toBe(3_600_000)
    // In reach: the swap was really consulted after the flip.
    expect(rewrites).toBeGreaterThan(0)
    expect(Intl.DateTimeFormat).toBe(Original)
  })
})
