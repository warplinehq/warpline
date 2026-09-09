import { PluginManifestSchema } from 'warpline/schemas/plugin-manifest'

/**
 * anomaly-issue — example plugin.
 *
 * The side-effect half of the anomaly chain: one GitHub issue per anomaly
 * `anomaly-watch` reports, never the same anomaly twice.
 *
 * What `dependencies: ['anomaly-watch']` buys: level ordering (this plugin
 * runs at level 1, after anomaly-watch), a re-run whenever anomaly-watch ran
 * more recently than this plugin did — even inside the TTL window — AND the
 * read itself. The declaration is what the `dependencies` capability member
 * keys off: `capabilities.dependencies.lastOutput(caller, 'anomaly-watch')`
 * returns the Output that plugin last produced, and a name this list does not
 * carry throws rather than reading as a dependency that has not run.
 *
 * The order of the gates, plainly: the declared side effects gate execution
 * BEFORE the handler runs — unapproved, the plugin is skipped and the run
 * continues. If approved, the handler runs and the issues ARE filed;
 * `supervised` then records the plugin `gated` for human review and stops
 * further levels. The declaration is what stops the issue; `supervised` is
 * what surfaces it afterwards. It does not stop the side effect.
 *
 * Because a filed issue cannot be un-filed, the result carries
 * `reversible: false` and an `undo_instruction` naming every issue URL; the
 * engine copies both into the gated entry verbatim.
 *
 * A real run needs `GITHUB_TOKEN` in the environment (issues:write). The
 * tests inject `fetch` and need none.
 */
export const manifest = PluginManifestSchema.parse({
  name: 'anomaly-issue',
  version: '1.0.0',
  description: 'File one GitHub issue per new anomaly reported by anomaly-watch',
  autonomy_level: 'supervised',
  side_effects: ['creates_issue', 'external_api'],
  ttl_hours: 6,
  schedule: 'on_run',
  timeout_ms: 30_000,
  dependencies: ['anomaly-watch'],
  inputs: {
    repo: { type: 'string', required: true, description: 'owner/name, e.g. oven-sh/bun' },
  },
  outputs: {
    issues_created: { type: 'number', description: 'Issues filed this run' },
  },
})
