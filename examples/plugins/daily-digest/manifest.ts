import { PluginManifestSchema } from 'warpline/schemas/plugin-manifest'

/**
 * daily-digest — example plugin.
 *
 * The aggregate shape: declare several dependencies, let the engine order
 * them, and fold what they produced into one digest. This plugin declares two
 * producers, `anomaly-watch` and `github-poll`, and returns one Output.
 *
 * What `dependencies` buys: level ordering. Both producers run at level 0 and
 * this plugin runs at level 1, after them, on every advance where it is due —
 * and a re-run whenever either producer ran more recently than this plugin
 * did, even inside the TTL window. That is the half of the aggregate act the
 * runtime performs today.
 *
 * Where the upstream data comes from, and why it is a convention: each
 * producer returns its data as an Output on its result, and the engine keeps
 * the most recent one per plugin. A handler is not yet handed a way to read
 * that record, so this plugin reads two files under the home that a chaining
 * host drops there — the same convention `anomaly-issue` uses, and the same
 * finding recorded in the same words in both handlers. When the runtime hands
 * a plugin a reader for its dependencies' Outputs, both inputs below go and
 * the file reads with them.
 *
 * `ttl_hours: 24` with `schedule: 'daily'`: a digest is a day's answer, and
 * the freshness predicate keeps it from recomputing inside that window.
 */
export const manifest = PluginManifestSchema.parse({
  name: 'daily-digest',
  version: '1.0.0',
  description: 'Fold what anomaly-watch and github-poll last produced into one daily digest',
  autonomy_level: 'autonomous',
  side_effects: [],
  ttl_hours: 24,
  schedule: 'daily',
  dependencies: ['anomaly-watch', 'github-poll'],
  inputs: {
    // Required AND defaulted, like derived-summary's source: the default
    // satisfies the requirement at the lowest precedence tier, a relative
    // path resolves under the home, and an operator retargets either one
    // through `warpline configure daily-digest`.
    anomalies_path: {
      type: 'string',
      required: true,
      default: 'state/anomalies.json',
      description: 'Where a chaining host drops anomaly-watch\'s anomalies, as { "anomalies": [...] }; relative paths resolve under the warpline home',
    },
    issues_path: {
      type: 'string',
      required: true,
      default: 'state/github-issues.json',
      description: 'Where a chaining host drops github-poll\'s Output body, as { "open_count": n, "newest_number": n }; relative paths resolve under the warpline home',
    },
  },
  outputs: {
    digest: { type: 'object', description: 'One record naming what each producer last reported, or that it reported nothing' },
  },
})
