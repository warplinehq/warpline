import { PluginManifestSchema } from 'warpline/schemas/plugin-manifest'

/**
 * draft-writer — example plugin.
 *
 * The config-heavy writer: everything an adopter would decide about their
 * drafts is a declared input here, and the plugin itself carries NONE of it.
 * No voice rule, no audience, no house style, no forbidden word and no
 * frontmatter shape appears in this directory as content. The three files an
 * author keeps that knowledge in are named by three path inputs, resolved
 * under the warpline home, and the plugin refuses a path that would resolve
 * anywhere else — the same in-home rule the `[needs-llm]` contract applies to
 * a handoff payload.
 *
 * What the plugin does with them is deliberately little: it checks they are
 * there, writes a payload under the home that NAMES them, and hands the
 * drafting off through `[needs-llm]`. Drafting prose under a style guide is
 * judgment, not code, and the doctrine is that code does not do judgment. The
 * shipped `needs-llm` scanner picks the handoff up; there is no dedicated
 * consumer skill for this plugin in the marketplace plugin, and the payload
 * says so by naming the files rather than restating them.
 *
 * The three reference files under `reference/` are placeholders an adopter
 * REPLACES. Their defaults below resolve where `warpline scaffold --from
 * draft-writer` lands a copy — `<home>/plugins/draft-writer/reference/` —
 * which is why they start with `plugins/draft-writer/`. A copy made under a
 * different name, or an author who keeps the files elsewhere, retargets all
 * three through `warpline configure draft-writer`; until then the missing
 * file is reported by input key and nothing is handed off.
 */
export const manifest = PluginManifestSchema.parse({
  name: 'draft-writer',
  version: '1.0.0',
  description: 'Hand off drafting under the voice rules, blocklist and frontmatter schema an adopter keeps in three configured files',
  autonomy_level: 'autonomous',
  side_effects: [],
  ttl_hours: 24,
  schedule: 'daily',
  inputs: {
    // Required AND defaulted: a relative path is a placeholder by
    // construction, and the default is where a `scaffold --from` copy puts
    // the shipped placeholder file.
    voice_rules_path: {
      type: 'string',
      required: true,
      default: 'plugins/draft-writer/reference/voice-rules.example.md',
      description: 'Your voice and style rules, as a text file; a relative path resolves under the warpline home and nothing outside it is accepted',
    },
    blocklist_path: {
      type: 'string',
      required: true,
      default: 'plugins/draft-writer/reference/blocklist.example.json',
      description: 'Terms a draft may never use, as { "terms": ["..."] }; relative to the warpline home',
    },
    frontmatter_schema_path: {
      type: 'string',
      required: true,
      default: 'plugins/draft-writer/reference/frontmatter-schema.example.json',
      description: 'The frontmatter every draft must carry, as a JSON object describing its fields; relative to the warpline home',
    },
    // An `array` input. Its value cannot arrive from the command line — the
    // invocation flag passes strings and does not convert — so it comes from
    // the config file `warpline configure draft-writer` writes, or from this
    // default. Empty by default on purpose: the plugin has nothing of its own
    // to say, and a run with no topics hands nothing off.
    topics: {
      type: 'array',
      required: true,
      default: [],
      description: 'What to draft this run, one entry per piece; empty means nothing is handed off',
    },
    draft_length_words: {
      type: 'number',
      required: true,
      default: 800,
      description: 'Target length of each draft, in words',
    },
    // Optional and undefaulted: when absent the handler derives
    // drafts/draft-writer under the home. A supplied value must stay under
    // the home, or the handler refuses it before anything is written.
    output_dir: {
      type: 'string',
      required: false,
      description: 'Directory under the warpline home the finished drafts are written into; when absent, drafts/draft-writer',
    },
  },
  outputs: {
    handoff: { type: 'object', description: 'The drafting request handed off: topics, target length, destination, and the three reference files by path' },
  },
})
