import { PluginManifestSchema } from '../../../src/schemas/plugin-manifest.js'

export const manifest = PluginManifestSchema.parse({
  name: 'abort-aware-plugin',
  version: '1.0.0',
  description: 'Fixture: polls signal.aborted and exits early on cancellation.',
  autonomy_level: 'autonomous',
  ttl_hours: 1,
  timeout_ms: 500,
  max_retries: 0,
  retry_delay_ms: 10,
})
