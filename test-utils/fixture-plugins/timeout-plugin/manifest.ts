import { PluginManifestSchema } from '../../../src/schemas/plugin-manifest.js'

export const manifest = PluginManifestSchema.parse({
  name: 'timeout-plugin',
  version: '1.0.0',
  description: 'Fixture: sleeps 10s so that a 100ms manifest timeout always trips.',
  autonomy_level: 'autonomous',
  ttl_hours: 1,
  timeout_ms: 100,
  max_retries: 2,
  retry_delay_ms: 10,
})
