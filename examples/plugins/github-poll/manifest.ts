import { PluginManifestSchema } from '../../../src/schemas/plugin-manifest'

/**
 * github-poll — example plugin.
 *
 * Deterministic fetch: lists open issues on a GitHub repo and summarises the
 * count by label. Declares `external_api` — so even though it is
 * `autonomous`, the engine gates it behind session approval. That is the
 * side-effect rule working as designed, on the mildest possible side effect.
 */
export const manifest = PluginManifestSchema.parse({
  name: 'github-poll',
  version: '1.0.0',
  description: 'Poll open GitHub issues for a repo and summarise by label',
  autonomy_level: 'autonomous',
  side_effects: ['external_api'],
  ttl_hours: 12,
  schedule: 'daily',
  timeout_ms: 30_000,
  inputs: {
    repo: { type: 'string', required: true, description: 'owner/name, e.g. oven-sh/bun' },
  },
  outputs: {
    open_count: { type: 'number', description: 'Open issue count' },
  },
})
