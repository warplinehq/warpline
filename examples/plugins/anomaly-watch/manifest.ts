import { PluginManifestSchema } from '../../../src/schemas/plugin-manifest'

/**
 * anomaly-watch — example plugin.
 *
 * Pure deterministic check: reads a metrics JSON file and flags any series
 * whose latest value breaches its declared threshold. No side effects, no
 * LLM — the canonical "if you can write if/else for it" plugin.
 */
export const manifest = PluginManifestSchema.parse({
  name: 'anomaly-watch',
  version: '1.0.0',
  description: 'Flag metric series whose latest value breaches a declared threshold',
  autonomy_level: 'autonomous',
  side_effects: [],
  ttl_hours: 6,
  schedule: 'on_run',
  inputs: {
    metrics_path: {
      type: 'string',
      required: false,
      description: 'Path to a metrics JSON file (default: <home>/state/metrics.json)',
    },
  },
  outputs: {
    anomalies: { type: 'array', description: 'Breached series with values and thresholds' },
  },
})
