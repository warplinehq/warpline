import { PluginManifestSchema } from '../../../src/schemas/plugin-manifest'

export const manifest = PluginManifestSchema.parse({
  name: 'abort-aware-plugin',
  version: '1.0.0',
  description: 'Fixture: polls signal.aborted and exits early on cancellation (Phase 121 Plan 01 tests).',
  autonomy_level: 'autonomous',
  ttl_hours: 1,
  timeout_ms: 500,
  max_retries: 0,
  retry_delay_ms: 10,
})
