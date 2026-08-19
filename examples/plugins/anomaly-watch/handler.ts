import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PluginManifest } from '../../../src/schemas/plugin-manifest'
import type { SkillResult } from '../../../src/schemas/skill-result'
import { warplineHome } from '../../../src/lib/paths'

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

export function findAnomalies(series: Series[]): Series[] {
  return series.filter(s =>
    s.direction === 'above' ? s.latest > s.threshold : s.latest < s.threshold,
  )
}

export async function handler(
  _manifest: PluginManifest,
  args: Record<string, unknown>,
): Promise<SkillResult> {
  const path = typeof args.metrics_path === 'string'
    ? args.metrics_path
    : join(warplineHome(), 'state', 'metrics.json')

  let series: Series[]
  try {
    const raw = JSON.parse(await readFile(path, 'utf-8'))
    series = Array.isArray(raw.series) ? raw.series : []
  } catch {
    return {
      status: 'skipped',
      phases_completed: [],
      phases_failed: [],
      errors: [],
      data_freshness: {},
      summary: `no metrics file at ${path} — nothing to check`,
      artifacts_produced: [],
      schema_version: 1,
    }
  }

  const anomalies = findAnomalies(series)
  return {
    status: 'success',
    phases_completed: ['anomaly-watch'],
    phases_failed: [],
    errors: [],
    data_freshness: { metrics: new Date().toISOString() },
    summary: anomalies.length === 0
      ? `all ${series.length} series within thresholds`
      : `${anomalies.length} of ${series.length} series breached: ${anomalies.map(a => a.name).join(', ')}`,
    artifacts_produced: [],
    schema_version: 1,
  }
}
