import { PluginManifestSchema } from 'warpline/schemas/plugin-manifest'

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
    // Required AND defaulted, which is not a contradiction: the default
    // satisfies the requirement at the lowest precedence tier. `warpline init`
    // seeds a different example, so a copy of this one has no config file
    // until `warpline configure github-poll` writes one, and until then the
    // declared default is the only value the plugin has — without one a copied
    // quickstart fails on every advance, forever. The repository it polls is
    // the one this package ships from, so the example demonstrates the config
    // channel instead of demanding it.
    repo: {
      type: 'string',
      required: true,
      default: 'warplinehq/warpline',
      description: 'owner/name, e.g. oven-sh/bun',
    },
  },
  outputs: {
    open_count: { type: 'number', description: 'Open issue count' },
  },
})
