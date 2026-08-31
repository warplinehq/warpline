import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { PluginManifest } from 'warpline/schemas/plugin-manifest'
import { makeSkillError, type SkillResult } from 'warpline/schemas/skill-result'
import { warplineHome } from 'warpline/lib/paths'

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

export async function handler(
  _manifest: PluginManifest,
  args: Record<string, unknown>,
  _signal: AbortSignal, // accepted, unused — local file I/O has nothing to cancel
): Promise<SkillResult> {
  const metricsPath = typeof args.metrics_path === 'string'
    ? args.metrics_path
    : join(warplineHome(), 'state', 'metrics.json')
  const retentionDays = args.retention_days === undefined ? 90 : args.retention_days
  // Names the key and the shape expected of it, never the value it was handed:
  // this message lands in a run log, and the value can arrive from the
  // operator's config file.
  if (typeof retentionDays !== 'number' || !(retentionDays > 0)) {
    return {
      status: 'failed',
      phases_completed: [],
      phases_failed: ['metrics-rollup'],
      errors: [makeSkillError('parse_error', "input 'retention_days' must be a positive number", { impact: 'HIGH', retryable: false })],
      data_freshness: {},
      summary: 'metrics-rollup: invalid retention_days input',
      artifacts_produced: [],
      schema_version: 1,
    }
  }

  let series: Series[]
  let droppedSeries = 0
  try {
    const raw = JSON.parse(await readFile(metricsPath, 'utf-8'))
    const rawSeries: unknown[] = Array.isArray(raw.series) ? raw.series : []
    series = rawSeries.filter(isSeries)
    droppedSeries = rawSeries.length - series.length
  } catch (err) {
    // A file that exists but is corrupt is not "no data yet". Left green, it
    // is an appended-nothing day that looks fine, every day.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return {
        status: 'failed',
        phases_completed: [],
        phases_failed: ['metrics-rollup'],
        errors: [makeSkillError('parse_error', `cannot read ${metricsPath}: ${err instanceof Error ? err.message : String(err)}`, { impact: 'HIGH', retryable: false })],
        data_freshness: {},
        summary: `metrics-rollup: ${metricsPath} is unreadable`,
        artifacts_produced: [],
        schema_version: 1,
      }
    }
    // NOT a bare `skipped`: deriveRunStatus persists a prefix-less `skipped`
    // as `failed`, and "no data yet" must not paint a red run.
    return {
      status: 'success',
      phases_completed: ['metrics-rollup'],
      phases_failed: [],
      errors: [],
      data_freshness: {},
      summary: `no metrics file at ${metricsPath} — nothing to roll up`,
      artifacts_produced: [],
      schema_version: 1,
    }
  }

  const statePath = join(warplineHome(), 'state', 'metrics-rollup.json')
  let state: State = { rows: [], rollups: [] }
  let droppedRows = 0
  try {
    const raw = JSON.parse(await readFile(statePath, 'utf-8'))
    const rawRows: unknown[] = Array.isArray(raw.rows) ? raw.rows : []
    state = { rows: rawRows.filter(isRow), rollups: Array.isArray(raw.rollups) ? raw.rollups : [] }
    droppedRows = rawRows.length - state.rows.length
  } catch (err) {
    // ENOENT is a first run. Anything else — a transient EMFILE, a file
    // truncated by an unrelated crash, a hand-edit typo — must not start
    // empty: the write below would then rename that over up to
    // retention_days of rows and every rollup ever folded.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return {
        status: 'failed',
        phases_completed: [],
        phases_failed: ['metrics-rollup'],
        errors: [makeSkillError('parse_error', `cannot read ${statePath}: ${err instanceof Error ? err.message : String(err)}`, { impact: 'HIGH', retryable: false })],
        data_freshness: {},
        summary: 'metrics-rollup: retained state unreadable — refusing to overwrite it',
        artifacts_produced: [],
        schema_version: 1,
      }
    }
  }

  const today = new Date().toISOString().slice(0, 10)
  const rows = appendRows(state.rows, series, today)
  const appended = rows.length - state.rows.length
  const { kept, retired } = retire(rows, cutoffDate(today, retentionDays))
  const rollups = rollupWeekly(retired, state.rollups)

  // A half-written retained store is data loss; write-then-rename is one line.
  await mkdir(dirname(statePath), { recursive: true })
  await writeFile(`${statePath}.tmp`, JSON.stringify({ rows: kept, rollups }, null, 2))
  await rename(`${statePath}.tmp`, statePath)

  return {
    status: 'success',
    phases_completed: ['metrics-rollup'],
    phases_failed: [],
    errors: [],
    data_freshness: { metrics: new Date().toISOString() },
    summary: `appended ${appended} rows, retired ${retired.length} into ${rollups.length} weekly rollups (${kept.length} rows retained)`
      + (droppedSeries || droppedRows ? `; dropped ${droppedSeries} malformed series and ${droppedRows} malformed retained rows` : ''),
    artifacts_produced: [],
    schema_version: 1,
  }
}
