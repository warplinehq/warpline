import { join } from 'node:path'
import { warplineHome } from 'warpline/lib/paths'
import type { CapabilityHandlerFn } from 'warpline/unstable-capabilities'
import { atomicWriteJson, readJsonOrNull } from 'warpline/unstable-fs'
import { skillFailure, skillOk } from 'warpline/unstable-result'

/**
 * Expected metrics file shape:
 * {
 *   "series": [
 *     { "name": "signup_rate", "latest": 3, "threshold": 5, "direction": "below" },
 *     { "name": "error_count", "latest": 42, "threshold": 10, "direction": "above" }
 *   ]
 * }
 */
interface Series {
  name: string
  latest: number
  threshold: number
  direction: 'above' | 'below'
}

/**
 * What one run leaves behind for the next: when it looked, and which series
 * were breached. One record, overwritten every run. Not a history and not a
 * retention window — a plugin that needs either is a different shape, and
 * the runtime-spec's "derive, don't store" note says why this one does not.
 */
interface Observation {
  observed_at: string
  breached: string[]
}

export function findAnomalies(series: Series[]): Series[] {
  return series.filter(s =>
    s.direction === 'above' ? s.latest > s.threshold : s.latest < s.threshold,
  )
}

function describe(breached: string[], total: number): string {
  return breached.length === 0
    ? `all ${total} series within thresholds`
    : `${breached.length} of ${total} series breached: ${breached.join(', ')}`
}

/** The difference between two breached sets, in the words an operator reads. */
function delta(prior: string[], now: string[]): string {
  const fresh = now.filter(n => !prior.includes(n))
  const cleared = prior.filter(p => !now.includes(p))
  if (fresh.length === 0 && cleared.length === 0) return 'no change'
  return [
    fresh.length > 0 ? `new: ${fresh.join(', ')}` : '',
    cleared.length > 0 ? `cleared: ${cleared.join(', ')}` : '',
  ].filter(Boolean).join('; ')
}

export const handler: CapabilityHandlerFn = async (manifest, args, _signal, _capabilities) => {
  const metricsPath = typeof args.metrics_path === 'string'
    ? args.metrics_path
    : join(warplineHome(), 'state', 'metrics.json')

  // `metrics_path` is an operator-configured value and this result lands in
  // the run log, so no arm below names it. ENOENT is "nothing to check";
  // anything else is a failure that says which input key, never which path.
  let raw: { series?: unknown } | null
  try {
    raw = await readJsonOrNull<{ series?: unknown }>(metricsPath)
  } catch {
    return skillFailure(
      'parse_error',
      `${manifest.name}: metrics_path is unreadable or not JSON`,
      { phases_failed: [manifest.name], impact: 'HIGH', retryable: false },
    )
  }
  if (raw === null) {
    return skillOk(`${manifest.name}: no metrics file at the configured path — nothing to check`)
  }
  const series: Series[] = Array.isArray(raw.series) ? raw.series : []

  // The observation this plugin wrote last time, if it has run in this home
  // before. The path is derived from the manifest name, never from `args`.
  // Not caught: a null is a first run, and any other failure is a real one —
  // swallowing it would report "no data yet" over a file that cannot be read.
  const observationPath = join(warplineHome(), 'state', `${manifest.name}.last.json`)
  const prior = await readJsonOrNull<Observation>(observationPath)

  const anomalies = findAnomalies(series)
  const breached = anomalies.map(a => a.name)
  const observedAt = new Date().toISOString()
  await atomicWriteJson<Observation>(observationPath, { observed_at: observedAt, breached })

  const summary = prior === null
    ? `first observation: ${describe(breached, series.length)}`
    : `since ${prior.observed_at}: ${delta(prior.breached, breached)}; now ${describe(breached, series.length)}`

  return skillOk(summary, {
    phases_completed: [manifest.name],
    data_freshness: { metrics: observedAt },
    // One Output, inline. The body cap is 16 KiB of UTF-8, which holds a few
    // hundred breached series; a metrics file larger than that wants `path`
    // plus an atomicWriteJson under the home instead, never both.
    artifacts_produced: [
      { type: 'anomalies', format: 'json', body: JSON.stringify({ observed_at: observedAt, breached: anomalies }) },
    ],
  })
}
