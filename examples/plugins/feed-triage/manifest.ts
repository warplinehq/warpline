import { PluginManifestSchema } from 'warpline/schemas/plugin-manifest'

/**
 * feed-triage — example plugin.
 *
 * The judgment-handoff half of the feed chain. `feed-monitor`'s own manifest
 * docstring names this plugin: "a host that wants triage chains a
 * `[needs-llm]` plugin after this one instead of teaching this one to think."
 * This is that plugin — it reads the deterministic feed state, resolves
 * everything computable (the count, the payload path, the freshness stamp) and
 * hands the per-entry judgment off via a `[needs-llm]` summary. It never calls
 * a model and it writes nothing. See docs/needs-llm-contract.md.
 */
export const manifest = PluginManifestSchema.parse({
  name: 'feed-triage',
  version: '1.0.0',
  description: 'Hand off new feed entries to an LLM skill for per-entry triage judgment',
  autonomy_level: 'autonomous',
  side_effects: [],
  ttl_hours: 6,
  schedule: 'on_run',
  inputs: {
    entries_path: {
      type: 'string',
      required: false,
      description: 'Path to a feed-entries JSON file; when absent, the handler computes it from the warpline home, as state/feed-entries.json',
    },
  },
  outputs: {
    triage: { type: 'array', description: 'Entries handed off for judgment' },
  },
})
