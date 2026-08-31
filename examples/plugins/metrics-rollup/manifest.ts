import { PluginManifestSchema } from 'warpline/schemas/plugin-manifest'

/**
 * metrics-rollup — example plugin.
 *
 * Demonstrates a `daily` cadence and retained, rolled-up state. Each run
 * appends one row per metric for today, retires rows older than
 * `retention_days` into per-ISO-week rollups (count, sum, mean, min, max),
 * and keeps the result in ONE file, `<home>/state/metrics-rollup.json`.
 *
 * That write is not a declared side effect. A file under the warpline home
 * is "a file, not a side effect" (docs/needs-llm-contract.md) — the gate
 * covers what leaves the machine, and nothing here does.
 *
 * `ttl_hours` is 20, not 24: rows are keyed by (date × metric), so a second
 * run on the same day appends nothing anyway. The TTL just spares the no-op
 * while leaving room for a daily job that drifts a few hours.
 */
export const manifest = PluginManifestSchema.parse({
  name: 'metrics-rollup',
  version: '1.0.0',
  description: 'Append one row per metric per day, retire rows past a retention window into weekly rollups',
  autonomy_level: 'autonomous',
  side_effects: [],
  ttl_hours: 20,
  schedule: 'daily',
  inputs: {
    metrics_path: {
      type: 'string',
      required: false,
      description: 'Path to a metrics JSON file; when absent, the handler computes it from the warpline home, as state/metrics.json',
    },
    retention_days: {
      type: 'number',
      required: false,
      default: 90,
      description: 'Rows older than this many days are retired into weekly rollups',
    },
  },
  outputs: {
    rows_appended: { type: 'number', description: 'Rows added this run' },
    rows_retired: { type: 'number', description: 'Rows folded into weekly rollups this run' },
    weekly_rollups: { type: 'number', description: 'Rollup entries held after this run' },
  },
})
