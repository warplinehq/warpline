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
 * a model; the one thing it writes is the handoff payload, under the warpline
 * home. See docs/needs-llm-contract.md.
 *
 * What `dependencies: ['feed-monitor']` buys: level ordering (this plugin runs
 * at level 1, after feed-monitor), a re-run whenever feed-monitor ran more
 * recently than this plugin did — even inside the TTL window — AND the read
 * itself. The declaration is what the `dependencies` capability member keys
 * off: `capabilities.dependencies.lastOutput(caller, 'feed-monitor')` returns
 * the Output that plugin last produced, and a name this list does not carry
 * throws rather than reading as a dependency that has not run.
 *
 * The feed state used to arrive through a declared input naming a path this
 * handler computed a default for. Nothing produced that file when the input
 * was written; `feed-monitor` does now, so the coupling stopped being invented
 * and became declared, and the input went with the code that read it.
 */
export const manifest = PluginManifestSchema.parse({
  name: 'feed-triage',
  version: '1.0.0',
  description: 'Hand off new feed entries to an LLM skill for per-entry triage judgment',
  autonomy_level: 'autonomous',
  side_effects: [],
  ttl_hours: 6,
  schedule: 'on_run',
  dependencies: ['feed-monitor'],
  outputs: {
    triage: { type: 'array', description: 'Entries handed off for judgment' },
  },
})
