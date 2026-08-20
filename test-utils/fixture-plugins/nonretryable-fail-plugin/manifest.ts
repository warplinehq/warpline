import { PluginManifestSchema } from '../../../src/schemas/plugin-manifest.js'

export const manifest = PluginManifestSchema.parse({
  name: 'nonretryable-fail-plugin',
  version: '1.0.0',
  description: 'Fixture: returns a retryable:false failure.',
  autonomy_level: 'autonomous',
  ttl_hours: 1,
  timeout_ms: 5_000,
  max_retries: 3,
  retry_delay_ms: 10,
})
