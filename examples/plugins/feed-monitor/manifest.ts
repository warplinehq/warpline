import { PluginManifestSchema } from 'warpline/schemas/plugin-manifest'

/**
 * feed-monitor — example plugin.
 *
 * Fetches an RSS/Atom feed and reports entries newer than the last run.
 * Deterministic fetch + parse; what a NEW entry MEANS is judgment, so a host
 * that wants triage chains a `[needs-llm]` plugin after this one instead of
 * teaching this one to think (see docs/needs-llm-contract.md).
 */
export const manifest = PluginManifestSchema.parse({
  name: 'feed-monitor',
  version: '1.0.0',
  description: 'Report new entries on an RSS/Atom feed since the last run',
  autonomy_level: 'autonomous',
  side_effects: ['external_api'],
  ttl_hours: 6,
  schedule: 'daily',
  timeout_ms: 30_000,
  inputs: {
    feed_url: { type: 'string', required: true, description: 'RSS or Atom feed URL' },
    since: { type: 'string', required: false, description: 'ISO datetime; entries newer than this are "new"' },
  },
  outputs: {
    new_entries: { type: 'array', description: 'Entries newer than `since`' },
  },
})
