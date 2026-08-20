import { PluginManifestSchema } from '../../../src/schemas/plugin-manifest.js'

export const manifest = PluginManifestSchema.parse({
  name: 'retry-then-succeed-plugin',
  version: '1.0.0',
  description: 'Fixture: fails retryably on attempt 1, succeeds on attempt 2.',
  autonomy_level: 'autonomous',
  ttl_hours: 1,
  timeout_ms: 5_000,
  max_retries: 2,
  retry_delay_ms: 10,
})
