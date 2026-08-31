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
    // satisfies the requirement at the lowest precedence tier. There is no
    // first-run setup verb, so a clean install has no config file, and a
    // declared default is the only place the value can come from — without one
    // the bundled quickstart fails on every advance, forever. An operator
    // retargets it by writing the plugin's own file under the home's `config`
    // directory. The repository it polls is the one this package ships from,
    // so the example demonstrates the config channel instead of demanding it.
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
