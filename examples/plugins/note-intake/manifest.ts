import { PluginManifestSchema } from 'warpline/schemas/plugin-manifest'

/**
 * note-intake — example plugin.
 *
 * Takes a piece of operator text supplied for THIS run and routes it to a
 * file under the home. The two things an author of this shape needs to know:
 *
 * First, where the text comes from. The operator runs
 * `warpline run note-intake default --input note=<text>` and the value lands
 * at the `invocation_args` tier, which wins over the config file and over the
 * manifest default. It is a per-run value: nothing is edited, nothing
 * persists past the invocation, and the next run starts with no note.
 *
 * Second, the ceiling. Values passed through `--input` are STRINGS and are
 * not converted. An input declared as `number`, `boolean`, `array` or
 * `object` cannot be populated from the command line at all; the resolver
 * refuses the string with its own "must be a <type>" problem, and such a
 * value has to come from `<home>/config/<plugin>.json` or from a manifest
 * default instead. So a plugin taking operator text declares the input as
 * `string`, as this one does, and parses inside the handler if it must.
 *
 * `schedule: 'manual'`: the engine's manual run profile is the only one that
 * admits this schedule, so an advance running under a profile (the headless,
 * scheduled form) never picks the plugin up, and `warpline run` by hand is
 * the way it runs. An advance with NO profile applies no schedule filter at
 * all today, so an interactive advance would try this plugin and fail on the
 * missing note; that is the engine's gap, recorded rather than papered over
 * here. `schedule` is a different question from `autonomy_level`, which
 * stays `autonomous` because the run itself needs no supervision once a
 * human has started it.
 */
export const manifest = PluginManifestSchema.parse({
  name: 'note-intake',
  version: '1.0.0',
  description: 'Route one piece of operator text, supplied per run with --input, to a file under the home',
  autonomy_level: 'autonomous',
  side_effects: [],
  ttl_hours: 1,
  schedule: 'manual',
  inputs: {
    // No default on purpose: a note is what the operator has to say this
    // run, and a placeholder note would be routed on every run that forgot
    // to supply one.
    note: {
      type: 'string',
      required: true,
      description: 'The text to route; supply it per run with --input note=<text>',
    },
    // Optional and undefaulted: when absent the handler derives
    // notes/<plugin-name> under the home. A supplied value must be relative,
    // carry no drive letter and no `..` segment, or the handler refuses it.
    inbox: {
      type: 'string',
      required: false,
      description: 'Directory under the warpline home the note is written into; when absent, notes/note-intake',
    },
  },
  outputs: {
    routed: { type: 'object', description: 'Where the note went and how long it was' },
  },
})
