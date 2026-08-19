import { describe, it, expect } from 'bun:test'
import {
  computeTier,
  isEligibleForTier,
  formatIdleDuration,
  TIER_THRESHOLDS_MS,
  TIER_ORDER,
  type TierName,
} from '../tier'

// ── Helpers ──────────────────────────────────────────────────────────

const BASE = Date.parse('2026-04-16T12:00:00Z')
const hours = (h: number) => new Date(BASE - h * 3_600_000).toISOString()
const days = (d: number) => hours(d * 24)

// ── computeTier ─────────────────────────────────────────────────────

describe('computeTier', () => {
  it('returns normal for null input (fresh install)', () => {
    expect(computeTier(null, BASE)).toBe('normal')
  })

  it('returns normal for undefined input (fresh install)', () => {
    expect(computeTier(undefined, BASE)).toBe('normal')
  })

  it('returns normal for empty string (T-109-02 NaN guard)', () => {
    expect(computeTier('', BASE)).toBe('normal')
  })

  it('returns normal for invalid date string (T-109-02 NaN guard)', () => {
    expect(computeTier('not-a-date', BASE)).toBe('normal')
  })

  it('returns normal for 1 hour ago', () => {
    expect(computeTier(hours(1), BASE)).toBe('normal')
  })

  it('returns normal for 47 hours ago (just under 2d boundary)', () => {
    expect(computeTier(hours(47), BASE)).toBe('normal')
  })

  it('returns degraded for exactly 48 hours ago (2d boundary)', () => {
    expect(computeTier(hours(48), BASE)).toBe('degraded')
  })

  it('returns degraded for 5 days ago', () => {
    expect(computeTier(days(5), BASE)).toBe('degraded')
  })

  it('returns degraded for 6 days 23 hours ago (just under 7d boundary)', () => {
    expect(computeTier(hours(6 * 24 + 23), BASE)).toBe('degraded')
  })

  it('returns extended for exactly 7 days ago (7d boundary)', () => {
    expect(computeTier(days(7), BASE)).toBe('extended')
  })

  it('returns extended for 10 days ago', () => {
    expect(computeTier(days(10), BASE)).toBe('extended')
  })

  it('returns extended for 13 days 23 hours ago (just under 14d boundary)', () => {
    expect(computeTier(hours(13 * 24 + 23), BASE)).toBe('extended')
  })

  it('returns suspended for exactly 14 days ago (14d boundary)', () => {
    expect(computeTier(days(14), BASE)).toBe('suspended')
  })

  it('returns suspended for 30 days ago', () => {
    expect(computeTier(days(30), BASE)).toBe('suspended')
  })
})

// ── isEligibleForTier ───────────────────────────────────────────────

describe('isEligibleForTier', () => {
  const tiers: TierName[] = ['normal', 'degraded', 'extended', 'suspended']

  describe('min_tier: suspended (always runs — health checks)', () => {
    for (const tier of tiers) {
      it(`eligible in ${tier}`, () => {
        expect(isEligibleForTier('suspended', tier)).toBe(true)
      })
    }
  })

  describe('min_tier: extended (runs in normal, degraded, extended)', () => {
    it('eligible in normal', () => {
      expect(isEligibleForTier('extended', 'normal')).toBe(true)
    })
    it('eligible in degraded', () => {
      expect(isEligibleForTier('extended', 'degraded')).toBe(true)
    })
    it('eligible in extended', () => {
      expect(isEligibleForTier('extended', 'extended')).toBe(true)
    })
    it('not eligible in suspended', () => {
      expect(isEligibleForTier('extended', 'suspended')).toBe(false)
    })
  })

  describe('min_tier: degraded (runs in normal, degraded)', () => {
    it('eligible in normal', () => {
      expect(isEligibleForTier('degraded', 'normal')).toBe(true)
    })
    it('eligible in degraded', () => {
      expect(isEligibleForTier('degraded', 'degraded')).toBe(true)
    })
    it('not eligible in extended', () => {
      expect(isEligibleForTier('degraded', 'extended')).toBe(false)
    })
    it('not eligible in suspended', () => {
      expect(isEligibleForTier('degraded', 'suspended')).toBe(false)
    })
  })

  describe('min_tier: normal (most restrictive — only in normal)', () => {
    it('eligible in normal', () => {
      expect(isEligibleForTier('normal', 'normal')).toBe(true)
    })
    it('not eligible in degraded', () => {
      expect(isEligibleForTier('normal', 'degraded')).toBe(false)
    })
    it('not eligible in extended', () => {
      expect(isEligibleForTier('normal', 'extended')).toBe(false)
    })
    it('not eligible in suspended', () => {
      expect(isEligibleForTier('normal', 'suspended')).toBe(false)
    })
  })

  // Named plugin patterns from plan
  it('anomaly-watch pattern (min_tier: suspended) runs in all tiers', () => {
    for (const tier of tiers) {
      expect(isEligibleForTier('suspended', tier)).toBe(true)
    }
  })

  it('supervised-sender pattern (min_tier: normal) only runs in normal', () => {
    expect(isEligibleForTier('normal', 'normal')).toBe(true)
    expect(isEligibleForTier('normal', 'degraded')).toBe(false)
  })
})

// ── formatIdleDuration ──────────────────────────────────────────────

describe('formatIdleDuration', () => {
  it('0ms returns "just now"', () => {
    expect(formatIdleDuration(0)).toBe('just now')
  })

  it('30s returns "just now"', () => {
    expect(formatIdleDuration(30_000)).toBe('just now')
  })

  it('5 minutes returns "5m ago"', () => {
    expect(formatIdleDuration(5 * 60_000)).toBe('5m ago')
  })

  it('1 hour returns "1h ago"', () => {
    expect(formatIdleDuration(3_600_000)).toBe('1h ago')
  })

  it('25 hours returns "1d ago"', () => {
    expect(formatIdleDuration(90_000_000)).toBe('1d ago')
  })

  it('3 days returns "3d ago"', () => {
    expect(formatIdleDuration(259_200_000)).toBe('3d ago')
  })
})

// ── Constants sanity checks ─────────────────────────────────────────

describe('constants', () => {
  it('TIER_THRESHOLDS_MS has correct values', () => {
    expect(TIER_THRESHOLDS_MS.degraded).toBe(2 * 24 * 60 * 60 * 1000)
    expect(TIER_THRESHOLDS_MS.extended).toBe(7 * 24 * 60 * 60 * 1000)
    expect(TIER_THRESHOLDS_MS.suspended).toBe(14 * 24 * 60 * 60 * 1000)
  })

  it('TIER_ORDER has correct ordering', () => {
    expect(TIER_ORDER.normal).toBeLessThan(TIER_ORDER.degraded)
    expect(TIER_ORDER.degraded).toBeLessThan(TIER_ORDER.extended)
    expect(TIER_ORDER.extended).toBeLessThan(TIER_ORDER.suspended)
  })
})
