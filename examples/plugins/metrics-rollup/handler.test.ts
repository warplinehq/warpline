import { describe, test, expect } from 'bun:test'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginManifest } from 'warpline/schemas/plugin-manifest'
import { appendRows, retire, weekStart, rollupWeekly, cutoffDate, handler, isRow, isSeries } from './handler.js'

/**
 * Runs `handler` against a throwaway home. `warpline/lib/paths` exports only
 * `warplineHome`, which resolves `WARPLINE_HOME` per call — the seam a plugin
 * author has.
 */
async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'metrics-rollup-'))
  const real = process.env.WARPLINE_HOME
  process.env.WARPLINE_HOME = home
  try {
    return await fn(home)
  } finally {
    if (real === undefined) delete process.env.WARPLINE_HOME
    else process.env.WARPLINE_HOME = real
  }
}

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

describe('metrics-rollup handler retained state', () => {
  test('refuses to overwrite a retained store it could not parse', async () => {
    await withHome(async home => {
      const metricsPath = join(home, 'metrics.json')
      await writeFile(metricsPath, JSON.stringify({ series: [{ name: 'errors', latest: 4 }] }))
      const statePath = join(home, 'state', 'metrics-rollup.json')
      await mkdir(join(home, 'state'), { recursive: true })
      await writeFile(statePath, '{"rows": [{"date": "2026-01-0')

      const result = await handler({} as PluginManifest, { metrics_path: metricsPath }, new AbortController().signal)

      expect(result.status).toBe('failed')
      expect(result.errors[0]?.code).toBe('parse_error')
      // The corrupt file is still there — untouched, recoverable by hand.
      expect(await readFile(statePath, 'utf-8')).toBe('{"rows": [{"date": "2026-01-0')
    })
  })

  test('starts empty when the retained store does not exist yet', async () => {
    await withHome(async home => {
      const metricsPath = join(home, 'metrics.json')
      await writeFile(metricsPath, JSON.stringify({ series: [{ name: 'errors', latest: 4 }] }))

      const result = await handler({} as PluginManifest, { metrics_path: metricsPath }, new AbortController().signal)

      expect(result.status).toBe('success')
      const state = JSON.parse(await readFile(join(home, 'state', 'metrics-rollup.json'), 'utf-8'))
      expect(state.rows).toHaveLength(1)
    })
  })
})

describe('metrics-rollup handler input file', () => {
  test('a corrupt metrics file fails rather than reporting "no metrics file"', async () => {
    await withHome(async home => {
      const metricsPath = join(home, 'metrics.json')
      await writeFile(metricsPath, '{"series": [')
      const result = await handler({} as PluginManifest, { metrics_path: metricsPath }, new AbortController().signal)
      expect(result.status).toBe('failed')
      expect(result.errors[0]?.code).toBe('parse_error')
    })
  })

  test('a missing metrics file is still a green "nothing to roll up"', async () => {
    await withHome(async home => {
      const metricsPath = join(home, 'absent.json')
      const result = await handler({} as PluginManifest, { metrics_path: metricsPath }, new AbortController().signal)
      expect(result.status).toBe('success')
      expect(result.summary).toContain('nothing to roll up')
    })
  })
})

describe('metrics-rollup shape guards', () => {
  test('isSeries rejects a non-numeric or missing latest', () => {
    expect(isSeries({ name: 'a', latest: 3 })).toBe(true)
    expect(isSeries({ name: 'a', latest: '3' })).toBe(false)
    expect(isSeries({ name: 'a' })).toBe(false)
    expect(isSeries(null)).toBe(false)
  })

  test('isRow rejects a malformed date or value', () => {
    expect(isRow({ date: '2026-08-27', name: 'a', value: 3 })).toBe(true)
    expect(isRow({ date: 'not-a-date', name: 'a', value: 3 })).toBe(false)
    expect(isRow({ date: '2026-08-27', name: 'a', value: null })).toBe(false)
  })

  test('malformed series and retained rows are dropped and counted, not folded in', async () => {
    await withHome(async home => {
      const metricsPath = join(home, 'metrics.json')
      await writeFile(metricsPath, JSON.stringify({
        series: [{ name: 'errors', latest: 4 }, { name: 'bad', latest: '9' }],
      }))
      await mkdir(join(home, 'state'), { recursive: true })
      await writeFile(join(home, 'state', 'metrics-rollup.json'), JSON.stringify({
        rows: [{ date: '2026-08-27', name: 'ok', value: 1 }, { date: 'nope', name: 'bad', value: 1 }],
        rollups: [],
      }))

      const result = await handler({} as PluginManifest, { metrics_path: metricsPath }, new AbortController().signal)

      expect(result.status).toBe('success')
      expect(result.summary).toContain('dropped 1 malformed series and 1 malformed retained rows')
      const state = JSON.parse(await readFile(join(home, 'state', 'metrics-rollup.json'), 'utf-8'))
      expect(state.rows.every((r: { value: unknown }) => Number.isFinite(r.value))).toBe(true)
      expect(state.rows.map((r: { name: string }) => r.name)).not.toContain('bad')
    })
  })
})

/**
 * Same reasoning as github-poll's input guard: `retention_days` can arrive
 * from `<home>/config/metrics-rollup.json`, and whatever this handler puts in
 * a SkillResult is written to a run log. The guard names the key and the shape
 * it wanted and says nothing about what it got.
 */
describe('metrics-rollup handler input guard', () => {
  test('an invalid retention_days is rejected without the value appearing anywhere in the result', async () => {
    const sentinel = 'sk-do-not-echo-me-71c4be'
    const result = await handler(
      {} as PluginManifest,
      { retention_days: sentinel },
      new AbortController().signal,
    )

    expect(result.status).toBe('failed')
    expect(result.errors[0]?.code).toBe('parse_error')
    expect(JSON.stringify(result)).not.toContain(sentinel)
    expect(result.errors[0]?.message).toContain('retention_days')
    expect(result.errors[0]?.message).toContain('positive number')
  })
})

/**
 * `metrics_path` arrives from the same config file as `retention_days` above,
 * and both fs arms below quote it back — one directly, one via a Node fs error
 * message, which embeds the full path. Both reach the run log through
 * `result_summary`, so both are the same disclosure the block above closes for
 * the input guard.
 *
 * A path-shaped sentinel reaches two arms at once: one that does not exist
 * reaches ENOENT, and one that names a real directory reaches the fs-error arm.
 */
describe('metrics-rollup config value disclosure', () => {
  const SENTINEL = 'do-not-echo-3c4d5e'

  test('a missing metrics file reports nothing to roll up without naming the path', async () => {
    await withHome(async () => {
      const result = await handler(
        {} as PluginManifest,
        { metrics_path: join(tmpdir(), SENTINEL, 'metrics.json') },
        new AbortController().signal,
      )

      expect(result.status).toBe('success')
      expect(result.summary).toContain('nothing to roll up')
      expect(JSON.stringify(result)).not.toContain(SENTINEL)
    })
  })

  test('an unreadable metrics file names the input key, not the path or the OS error', async () => {
    await withHome(async () => {
      const dir = await mkdtemp(join(tmpdir(), `${SENTINEL}-`))
      const result = await handler(
        {} as PluginManifest,
        { metrics_path: dir },
        new AbortController().signal,
      )

      expect(result.status).toBe('failed')
      expect(result.errors[0]?.code).toBe('parse_error')
      expect(JSON.stringify(result)).not.toContain(SENTINEL)
      expect(result.errors[0]?.message).toContain('metrics_path')
    })
  })
})
