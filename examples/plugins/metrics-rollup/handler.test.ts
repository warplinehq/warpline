import { describe, test, expect } from 'bun:test'
import { appendRows, retire, weekStart, rollupWeekly, cutoffDate } from './handler.js'

describe('metrics-rollup appendRows', () => {
  test('adds one row per series for today; a second call the same day adds nothing', () => {
    const series = [{ name: 'errors', latest: 4 }, { name: 'signups', latest: 9 }]
    const once = appendRows([], series, '2026-08-27')
    expect(once).toEqual([
      { date: '2026-08-27', name: 'errors', value: 4 },
      { date: '2026-08-27', name: 'signups', value: 9 },
    ])
    expect(appendRows(once, series, '2026-08-27')).toEqual(once)
  })
})

describe('metrics-rollup retire', () => {
  test('retires rows strictly before the cutoff and keeps the cutoff day', () => {
    const rows = [
      { date: '2026-05-28', name: 'a', value: 1 },
      { date: '2026-05-29', name: 'a', value: 2 },
      { date: '2026-08-27', name: 'a', value: 3 },
    ]
    const { kept, retired } = retire(rows, '2026-05-29')
    expect(retired.map(r => r.date)).toEqual(['2026-05-28'])
    expect(kept.map(r => r.date)).toEqual(['2026-05-29', '2026-08-27'])
  })
})

describe('metrics-rollup weekStart', () => {
  test('returns the ISO-week Monday in UTC', () => {
    expect(weekStart('2026-08-27')).toBe('2026-08-24') // Thursday
    expect(weekStart('2026-08-24')).toBe('2026-08-24') // Monday
    expect(weekStart('2026-08-23')).toBe('2026-08-17') // Sunday
  })
})

describe('metrics-rollup rollupWeekly', () => {
  test('aggregates count, sum, mean, min, max per (week, name)', () => {
    const out = rollupWeekly([
      { date: '2026-08-24', name: 'a', value: 2 },
      { date: '2026-08-25', name: 'a', value: 4 },
      { date: '2026-08-26', name: 'a', value: 9 },
    ], [])
    expect(out).toEqual([{ week: '2026-08-24', name: 'a', count: 3, sum: 15, mean: 5, min: 2, max: 9 }])
  })

  test('merges into an existing rollup instead of duplicating it', () => {
    const existing = [{ week: '2026-08-24', name: 'a', count: 3, sum: 15, mean: 5, min: 2, max: 9 }]
    const out = rollupWeekly([{ date: '2026-08-27', name: 'a', value: 1 }], existing)
    expect(out).toEqual([{ week: '2026-08-24', name: 'a', count: 4, sum: 16, mean: 4, min: 1, max: 9 }])
  })
})

describe('metrics-rollup cutoffDate', () => {
  test('subtracts retention days in UTC', () => {
    expect(cutoffDate('2026-08-27', 90)).toBe('2026-05-29')
  })
})
