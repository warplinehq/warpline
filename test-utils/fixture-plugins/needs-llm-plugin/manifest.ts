import { PluginManifestSchema } from '../../../src/schemas/plugin-manifest.js'

export const manifest = PluginManifestSchema.parse({
  name: 'needs-llm-plugin',
  version: '1.0.0',
  description: 'Fixture: hands off to an LLM skill and carries a non-fatal error.',
  autonomy_level: 'autonomous',
  ttl_hours: 1,
  timeout_ms: 5_000,
  max_retries: 2,
  retry_delay_ms: 10,
})
