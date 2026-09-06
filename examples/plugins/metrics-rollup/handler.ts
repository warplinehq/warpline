import { join } from 'node:path'
import { warplineHome } from 'warpline/lib/paths'
import type { CapabilityHandlerFn } from 'warpline/unstable-capabilities'
import { atomicWriteJson, readJsonOrNull } from 'warpline/unstable-fs'
import { skillFailure, skillOk } from 'warpline/unstable-result'

/**
 * Input: the same metrics file anomaly-watch reads. Only `name` and `latest`
 * are used here.
 * {
 *   "series": [
 *     { "name": "signup_rate", "latest": 3, "threshold": 5, "direction": "below" }
 *   ]
 * }
 *
 * Retained state, `<home>/state/metrics-rollup.json`:
 * {
 *   "rows":    [ { "date": "2026-08-27", "name": "signup_rate", "value": 3 } ],
 *   "rollups": [ { "week": "2026-05-25", "name": "signup_rate",
 *                  "count": 7, "sum": 21, "mean": 3, "min": 2, "max": 4 } ]
 * }
 * Rows are keyed by (date × name); rollups by (ISO-week Monday × name).
 */
export interface Row {
  date: string
  name: string
  value: number
}

export interface Rollup {
  week: string
  name: string
  count: number
  sum: number
  mean: number
  min: number
  max: number
}

export interface Series {
  name: string
  latest: number
}

interface State {
  rows: Row[]
  rollups: Rollup[]
}

/**
 * Shape guards for the two things that arrive as JSON.
 *
 * Not optional politeness: `rollupWeekly` does `sum += row.value`, so one
 * `latest: "3"` or one missing field turns a rollup into a string
 * concatenation or `NaN` — and `retire` has already deleted the rows it was
 * computed from, so the (week, name) entry is wrong permanently. `weekStart`
 * throws `RangeError` on a malformed date, which fails the whole run.
 */
export function isRow(r: unknown): r is Row {
  const v = r as Row
  return !!v && typeof v.name === 'string' && Number.isFinite(v.value)
    && typeof v.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.date)
}

export function isSeries(s: unknown): s is Series {
  const v = s as Series
  return !!v && typeof v.name === 'string' && Number.isFinite(v.latest)
}

/** One row per series for `today`, unless (today, name) is already present. */
export function appendRows(rows: Row[], series: Series[], today: string): Row[] {
  const seen = new Set(rows.filter(r => r.date === today).map(r => r.name))
  const fresh = series
    .filter(s => !seen.has(s.name))
    .map(s => ({ date: today, name: s.name, value: s.latest }))
  return [...rows, ...fresh]
}

/** Rows dated strictly before `cutoff` are retired; a row ON the cutoff is kept. */
export function retire(rows: Row[], cutoff: string): { kept: Row[]; retired: Row[] } {
  // YYYY-MM-DD compares correctly as a string — that is the point of the format.
  const retired = rows.filter(r => r.date < cutoff)
  const kept = rows.filter(r => r.date >= cutoff)
  return { kept, retired }
}

/** `today − days` as YYYY-MM-DD, computed in UTC. */
export function cutoffDate(today: string, days: number): string {
  const d = new Date(`${today}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString().slice(0, 10)
}

/** ISO-week Monday for a YYYY-MM-DD string, computed in UTC. */
export function weekStart(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  const back = (d.getUTCDay() + 6) % 7 // Mon=0 … Sun=6
  d.setUTCDate(d.getUTCDate() - back)
  return d.toISOString().slice(0, 10)
}

/** Fold retired rows into rollups keyed by (week, name); merges into existing entries. */
export function rollupWeekly(retired: Row[], existing: Rollup[]): Rollup[] {
  const byKey = new Map(existing.map(r => [`${r.week}\0${r.name}`, { ...r }]))
  for (const row of retired) {
    const week = weekStart(row.date)
    const key = `${week}\0${row.name}`
    const cur = byKey.get(key)
    if (cur) {
      cur.count += 1
      cur.sum += row.value
      cur.min = Math.min(cur.min, row.value)
      cur.max = Math.max(cur.max, row.value)
      cur.mean = cur.sum / cur.count // always sum/count — never an average of means
    } else {
      byKey.set(key, { week, name: row.name, count: 1, sum: row.value, mean: row.value, min: row.value, max: row.value })
    }
  }
  return [...byKey.values()]
}

// `_signal` is accepted, unused — local file I/O has nothing to cancel.
export const handler: CapabilityHandlerFn = async (manifest, args, _signal, _capabilities) => {
  const metricsPath = typeof args.metrics_path === 'string'
    ? args.metrics_path
    : join(warplineHome(), 'state', 'metrics.json')
  const retentionDays = args.retention_days === undefined ? 90 : args.retention_days
  // Names the key and the shape expected of it, never the value it was handed:
  // this message lands in a run log, and the value can arrive from the
  // operator's config file.
  if (typeof retentionDays !== 'number' || !(retentionDays > 0)) {
    return skillFailure('parse_error', "input 'retention_days' must be a positive number", {
      phases_failed: [manifest.name],
      impact: 'HIGH',
      retryable: false,
    })
  }

  // `metrics_path` is operator-configured and this result lands in the run
  // log, so neither arm names it. A file that exists but is corrupt is not
  // "no data yet": left green, it is an appended-nothing day that looks fine,
  // every day.
  let rawMetrics: { series?: unknown } | null
  try {
    rawMetrics = await readJsonOrNull<{ series?: unknown }>(metricsPath)
  } catch {
    return skillFailure('parse_error', "the file named by input 'metrics_path' is unreadable", {
      phases_failed: [manifest.name],
      impact: 'HIGH',
      retryable: false,
    })
  }
  if (rawMetrics === null) {
    // NOT a bare `skipped`: deriveRunStatus persists a prefix-less `skipped`
    // as `failed`, and "no data yet" must not paint a red run.
    return skillOk(`${manifest.name}: no metrics file at the configured path — nothing to roll up`, {
      phases_completed: [manifest.name],
    })
  }
  const rawSeries: unknown[] = Array.isArray(rawMetrics.series) ? rawMetrics.series : []
  const series = rawSeries.filter(isSeries)
  const droppedSeries = rawSeries.length - series.length

  // `readJsonOrNull` is null for ENOENT — a first run — and rethrows every
  // other error, which is the rule this site needs and must not soften: a
  // transient EMFILE, a file truncated by an unrelated crash, a hand-edit typo
  // must not start empty, because the write below would then rename that
  // emptiness over up to retention_days of rows and every rollup ever folded.
  // So the catch refuses rather than proceeds, and says so without the path
  // or the parser's words, both of which would land in the run log.
  const statePath = join(warplineHome(), 'state', `${manifest.name}.json`)
  let state: State = { rows: [], rollups: [] }
  let droppedRows = 0
  try {
    const raw = await readJsonOrNull<{ rows?: unknown; rollups?: unknown }>(statePath)
    if (raw !== null) {
      const rawRows: unknown[] = Array.isArray(raw.rows) ? raw.rows : []
      state = { rows: rawRows.filter(isRow), rollups: Array.isArray(raw.rollups) ? (raw.rollups as Rollup[]) : [] }
      droppedRows = rawRows.length - state.rows.length
    }
  } catch {
    return skillFailure('parse_error', `${manifest.name}: retained state unreadable — refusing to overwrite it`, {
      phases_failed: [manifest.name],
      impact: 'HIGH',
      retryable: false,
    })
  }

  const today = new Date().toISOString().slice(0, 10)
  const rows = appendRows(state.rows, series, today)
  const appended = rows.length - state.rows.length
  const { kept, retired } = retire(rows, cutoffDate(today, retentionDays))
  const rollups = rollupWeekly(retired, state.rollups)

  // A half-written retained store is data loss; the atomic writer creates the
  // parent and renames a temp file over the target.
  await atomicWriteJson<State>(statePath, { rows: kept, rollups })

  return skillOk(
    `appended ${appended} rows, retired ${retired.length} into ${rollups.length} weekly rollups (${kept.length} rows retained)`
      + (droppedSeries || droppedRows ? `; dropped ${droppedSeries} malformed series and ${droppedRows} malformed retained rows` : ''),
    { phases_completed: [manifest.name], data_freshness: { metrics: new Date().toISOString() } },
  )
}
