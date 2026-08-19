import { PluginManifestSchema } from '../../../src/schemas/plugin-manifest'

export const manifest = PluginManifestSchema.parse({
  name: 'abort-unaware-plugin',
  version: '1.0.0',
  description: 'Fixture: ignores signal, sleeps 5s; used to prove timeout trips even on signal-blind handlers (Phase 121 Plan 01 tests).',
  autonomy_level: 'autonomous',
  ttl_hours: 1,
  timeout_ms: 200,
  max_retries: 0,
  retry_delay_ms: 10,
})
