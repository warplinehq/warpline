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
 * Where the upstream data comes from: each producer returns its data as an
 * Output on its result, the engine keeps the most recent one per plugin, and
 * the handler asks for each by name through the `dependencies` capability
 * member. That is why this plugin declares no inputs at all — there is no path
 * for an operator to configure and no file for a chaining host to drop.
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
  // Empty on purpose: everything this plugin reads arrives through the
  // declared dependencies above, so there is nothing left to configure.
  inputs: {},
  outputs: {
    digest: { type: 'object', description: 'One record naming what each producer last reported, or that it reported nothing' },
  },
})
