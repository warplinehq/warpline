import { PluginManifestSchema } from '../../../src/schemas/plugin-manifest.js'

export const manifest = PluginManifestSchema.parse({
  name: 'slept-through-plugin',
  version: '1.0.0',
  description: 'Fixture: runs 600ms of wall time against a 200ms timeout; a test slows the awake clock to model a sleep.',
  autonomy_level: 'autonomous',
  ttl_hours: 1,
  timeout_ms: 200,
  max_retries: 0,
  retry_delay_ms: 10,
})
