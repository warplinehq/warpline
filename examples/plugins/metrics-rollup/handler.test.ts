import { describe, test, expect } from 'bun:test'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CapabilityContext } from 'warpline/unstable-capabilities'
import { appendRows, retire, weekStart, rollupWeekly, cutoffDate, handler, isRollup, isRow, isSeries } from './handler.js'
import { manifest } from './manifest.js'

/** The handler is four-parameter; a test hands it a context it never reads. */
const CONTEXT = {} as CapabilityContext

function invoke(args: Record<string, unknown>) {
  return handler(manifest, args, new AbortController().signal, CONTEXT)
}

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
  test('starts empty when the retained store does not exist yet, through the result builder', async () => {
    await withHome(async home => {
      const metricsPath = join(home, 'metrics.json')
      await writeFile(metricsPath, JSON.stringify({ series: [{ name: 'errors', latest: 4 }] }))

      const result = await invoke({ metrics_path: metricsPath })

      expect(result.status).toBe('success')
      // The builder leaves schema_version to the schema's own default; a
      // hand-written literal would carry one.
      expect(result.schema_version).toBeUndefined()
      expect(handler.length).toBe(4)
      const state = JSON.parse(await readFile(join(home, 'state', 'metrics-rollup.json'), 'utf-8'))
      expect(state.rows).toHaveLength(1)
    })
  })

  test('refuses to overwrite a retained store it could not parse, without naming the file or the OS error', async () => {
    await withHome(async home => {
      const metricsPath = join(home, 'metrics.json')
      await writeFile(metricsPath, JSON.stringify({ series: [{ name: 'errors', latest: 4 }] }))
      const statePath = join(home, 'state', 'metrics-rollup.json')
      await mkdir(join(home, 'state'), { recursive: true })
      await writeFile(statePath, '{"rows": [{"date": "2026-01-0')

      const result = await invoke({ metrics_path: metricsPath })

      expect(result.status).toBe('failed')
      expect(result.errors?.[0]?.code).toBe('parse_error')
      // The path and the parser's message both land in a run log otherwise.
      expect(JSON.stringify(result)).not.toContain(home)
      expect(JSON.stringify(result)).not.toContain('JSON')
      // The corrupt file is still there — untouched, recoverable by hand.
      expect(await readFile(statePath, 'utf-8')).toBe('{"rows": [{"date": "2026-01-0')
    })
  })

  test('the retention window still bounds the rows across runs, and the rollups keep their shape', async () => {
    await withHome(async home => {
      const metricsPath = join(home, 'metrics.json')
      await writeFile(metricsPath, JSON.stringify({ series: [{ name: 'errors', latest: 4 }] }))
      const statePath = join(home, 'state', 'metrics-rollup.json')
      const today = new Date().toISOString().slice(0, 10)
      const stale = cutoffDate(today, 30)
      await mkdir(join(home, 'state'), { recursive: true })
      await writeFile(statePath, JSON.stringify({
        rows: [
          { date: stale, name: 'errors', value: 1 },
          { date: cutoffDate(today, 29), name: 'errors', value: 3 },
        ],
        rollups: [],
      }))

      const first = await invoke({ metrics_path: metricsPath, retention_days: 7 })
      expect(first.status).toBe('success')
      expect(first.summary).toContain('retired 2')

      const after = JSON.parse(await readFile(statePath, 'utf-8'))
      const cutoff = cutoffDate(today, 7)
      expect(after.rows.every((r: { date: string }) => r.date >= cutoff)).toBe(true)
      expect(after.rows).toHaveLength(1)
      expect(after.rollups.length).toBeGreaterThan(0)
      for (const r of after.rollups) {
        expect(Object.keys(r).sort()).toEqual(['count', 'max', 'mean', 'min', 'name', 'sum', 'week'])
      }

      // A second run the same day appends nothing and retires nothing: the
      // window is a bound, not a growth curve.
      const second = await invoke({ metrics_path: metricsPath, retention_days: 7 })
      expect(second.status).toBe('success')
      const again = JSON.parse(await readFile(statePath, 'utf-8'))
      expect(again.rows).toEqual(after.rows)
      expect(again.rollups).toEqual(after.rollups)
    })
  })
})

describe('metrics-rollup handler input file', () => {
  test('a corrupt metrics file fails rather than reporting "no metrics file"', async () => {
    await withHome(async home => {
      const metricsPath = join(home, 'metrics.json')
      await writeFile(metricsPath, '{"series": [')
      const result = await invoke({ metrics_path: metricsPath })
      expect(result.status).toBe('failed')
      expect(result.errors?.[0]?.code).toBe('parse_error')
    })
  })

  test('a missing metrics file is still a green "nothing to roll up"', async () => {
    await withHome(async home => {
      const metricsPath = join(home, 'absent.json')
      const result = await invoke({ metrics_path: metricsPath })
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

  test('isRollup rejects a string sum, a malformed week, or a missing field', () => {
    const good = { week: '2026-08-24', name: 'a', count: 3, sum: 15, mean: 5, min: 2, max: 9 }
    expect(isRollup(good)).toBe(true)
    expect(isRollup({ ...good, sum: '15' })).toBe(false)
    expect(isRollup({ ...good, week: 'w34' })).toBe(false)
    expect(isRollup({ ...good, max: undefined })).toBe(false)
    expect(isRollup({ ...good, name: 7 })).toBe(false)
    expect(isRollup(null)).toBe(false)
  })

  test('a retained rollup in the wrong shape refuses the run and leaves the store as it is, rather than folding a number into a string', async () => {
    await withHome(async home => {
      const metricsPath = join(home, 'metrics.json')
      await writeFile(metricsPath, JSON.stringify({ series: [{ name: 'errors', latest: 4 }] }))
      const statePath = join(home, 'state', 'metrics-rollup.json')
      const today = new Date().toISOString().slice(0, 10)
      const stale = cutoffDate(today, 30)
      // The row about to be retired folds into this rollup's week, and the
      // rollup's sum is the string "15": `"15" + 1` is `"151"`, and the
      // atomic write would make it permanent while `retire` has already
      // discarded the row it came from.
      const store = JSON.stringify({
        rows: [{ date: stale, name: 'errors', value: 1 }],
        rollups: [{ week: weekStart(stale), name: 'errors', count: 3, sum: '15', mean: 5, min: 2, max: 9 }],
      })
      await mkdir(join(home, 'state'), { recursive: true })
      await writeFile(statePath, store)

      const result = await invoke({ metrics_path: metricsPath, retention_days: 7 })

      expect(result.status).toBe('failed')
      expect(result.errors?.[0]?.code).toBe('parse_error')
      expect(JSON.stringify(result)).not.toContain(home)
      expect(await readFile(statePath, 'utf-8')).toBe(store)
    })
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

      const result = await invoke({ metrics_path: metricsPath })

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
    const result = await invoke({ retention_days: sentinel })

    expect(result.status).toBe('failed')
    expect(result.errors?.[0]?.code).toBe('parse_error')
    expect(JSON.stringify(result)).not.toContain(sentinel)
    expect(result.errors?.[0]?.message).toContain('retention_days')
    expect(result.errors?.[0]?.message).toContain('positive number')
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
      const result = await invoke({ metrics_path: join(tmpdir(), SENTINEL, 'metrics.json') })

      expect(result.status).toBe('success')
      expect(result.summary).toContain('nothing to roll up')
      expect(JSON.stringify(result)).not.toContain(SENTINEL)
    })
  })

  test('an unreadable metrics file names the input key, not the path or the OS error', async () => {
    await withHome(async () => {
      const dir = await mkdtemp(join(tmpdir(), `${SENTINEL}-`))
      const result = await invoke({ metrics_path: dir })

      expect(result.status).toBe('failed')
      expect(result.errors?.[0]?.code).toBe('parse_error')
      expect(JSON.stringify(result)).not.toContain(SENTINEL)
      expect(result.errors?.[0]?.message).toContain('metrics_path')
    })
  })
})
