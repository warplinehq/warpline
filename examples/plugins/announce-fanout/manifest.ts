import { PluginManifestSchema } from 'warpline/schemas/plugin-manifest'

/**
 * announce-fanout — example plugin.
 *
 * Takes one draft and fans it out to several channels, each with its own
 * call to action, no more often than a cadence allows. This is the example a
 * real deployment would be most tempted to copy its own configuration into,
 * so the rule is applied without exception: EVERY channel, every call to
 * action and the cadence are `manifest.inputs` entries below, each with a
 * description and a placeholder default, and nothing in this directory says
 * what any adopter's channels are. A reader of the handler cannot tell.
 *
 * The teaching content of this manifest is the input types. `channels` is an
 * `array` and `calls_to_action` is an `object`. Values of those two types
 * cannot be populated from the command line: the invocation flag passes
 * strings and does not convert them, so a channel list typed at a prompt
 * would arrive as one string and be refused by the resolver. They come from
 * the config file `warpline configure announce-fanout` writes — the walk
 * asks for each as JSON — or from the manifest default. The defaults are
 * empty on purpose: fanning out to nobody is not a fan-out, so a run with
 * the shipped defaults is a prefixed skip that says which input to configure.
 *
 * What the plugin does is compute, not decide. It resolves which channels
 * are due (configured with a call to action, and outside the cadence window
 * since they were last handed off), writes a payload under the home naming
 * the draft and each due channel's call to action, and hands the per-channel
 * adaptation off through `[needs-llm]`. Rewriting one draft for several
 * audiences is judgment; posting it anywhere is a side effect that belongs
 * to a side-effect-declaring plugin behind the approval gate, which is why
 * this one declares none. A channel in the list with no call to action is
 * reported and skipped while the others proceed — per-channel isolation,
 * the same rule the fan-in example applies per source.
 */
export const manifest = PluginManifestSchema.parse({
  name: 'announce-fanout',
  version: '1.0.0',
  description: 'Fan one draft out to every configured channel with its own call to action, no more often than the configured cadence, and hand the per-channel rewrite off',
  autonomy_level: 'autonomous',
  side_effects: [],
  ttl_hours: 6,
  schedule: 'daily',
  inputs: {
    // An `array`: from the config file or this default, never the command line.
    channels: {
      type: 'array',
      required: true,
      default: [],
      description: 'The channels to fan out to, by name; empty means nothing is handed off',
    },
    // An `object`: a channel name to the call to action appended for it.
    calls_to_action: {
      type: 'object',
      required: true,
      default: {},
      description: 'One call to action per channel name; a channel with no entry is reported as unconfigured and skipped',
    },
    cadence_hours: {
      type: 'number',
      required: true,
      default: 24,
      description: 'The fewest hours between two hand-offs for the same channel',
    },
    // Required AND defaulted: a relative path resolves under the home, so a
    // clean install runs with no config file and finds nothing to fan out.
    draft_path: {
      type: 'string',
      required: true,
      default: 'state/announce-fanout.draft.json',
      description: 'The draft to fan out, as a JSON object; a relative path resolves under the warpline home and nothing outside it is accepted',
    },
  },
  outputs: {
    handoff: { type: 'object', description: 'The fan-out handed off: the draft by path, each due channel with its call to action, and the channels held or unconfigured' },
  },
})
