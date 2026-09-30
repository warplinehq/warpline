import { PluginManifestSchema } from '../../../src/schemas/plugin-manifest.js'

export const manifest = PluginManifestSchema.parse({
  name: 'late-timer-plugin',
  version: '1.0.0',
  description: 'Fixture: blocks the event loop past its timeout, so the timeout timer fires late, as it does after a sleep.',
  autonomy_level: 'autonomous',
  ttl_hours: 1,
  timeout_ms: 100,
  max_retries: 0,
  retry_delay_ms: 10,
})
