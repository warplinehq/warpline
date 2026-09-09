import { PluginManifestSchema } from 'warpline/schemas/plugin-manifest'

/**
 * derived-summary — example plugin.
 *
 * Derive, don't store. This plugin reads a source it already has under the
 * home, computes a summary of it, returns the summary, and writes NOTHING.
 * Not a cache, not a last observation, not a memo. Zero writes is the whole
 * demonstration; every other example in the tree leaves something behind.
 *
 * What `ttl_hours` buys: the runtime's freshness predicate decides whether
 * recomputing is worth it, so the plugin does not have to keep yesterday's
 * answer around to know whether today's is needed. Inside the window the
 * engine skips the run; past it, the answer is derived fresh from the source.
 * "Is it worth recomputing" is answered from two timestamps the engine
 * already writes, and nothing here ever has to be migrated, evicted or read
 * back. The argument in full is docs/derive-dont-store.md, and this is the
 * example that page points at.
 */
export const manifest = PluginManifestSchema.parse({
  name: 'derived-summary',
  version: '1.0.0',
  description: 'Summarise a metrics file under the home without storing anything; see docs/derive-dont-store.md',
  autonomy_level: 'autonomous',
  side_effects: [],
  ttl_hours: 6,
  schedule: 'on_run',
  inputs: {
    // Required AND defaulted: the default satisfies the requirement at the
    // lowest precedence tier, so a clean install runs with no config file.
    // A relative path resolves under the home, which is why a placeholder
    // can live here at all; an operator points it elsewhere through
    // `warpline configure derived-summary`.
    source_path: {
      type: 'string',
      required: true,
      default: 'state/metrics.json',
      description: 'The metrics JSON file to summarise; a relative path resolves under the warpline home',
    },
  },
  outputs: {
    summary: { type: 'object', description: 'Count, breached count and the range of latest values, derived on every run' },
  },
})
