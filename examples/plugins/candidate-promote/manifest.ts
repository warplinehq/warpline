import { PluginManifestSchema } from 'warpline/schemas/plugin-manifest'

/**
 * candidate-promote — example plugin.
 *
 * The second half of the candidate example, and the side effect: it appends
 * exactly the candidates `candidate-propose` proposed, once each, to a file
 * the adopter keeps.
 *
 * It is content class. An operator reads the proposal and approves those
 * exact bytes with `warpline approve candidate-promote --content --not-after
 * <when>`. A later advance may then promote them unattended. Without that
 * approval this plugin is skipped every advance, and a session grant never
 * makes it run, not even `approve --all`.
 *
 * It has no pool input. Its only input is where promoted candidates go, so it
 * can append only what the operator was shown. If the proposal moves by one
 * byte after the approval, a new pool or a new week, the approval stops
 * applying and nothing is appended until someone approves the new proposal.
 *
 * "Append" is read, dedupe by id, rewrite whole. The file is read, every
 * approved candidate whose id is already there is left out, and the file is
 * replaced in one atomic write with the existing entries first and the new
 * ones after, in proposal order. A file it cannot read as this shape is
 * refused, never overwritten.
 */
export const manifest = PluginManifestSchema.parse({
  name: 'candidate-promote',
  version: '1.0.0',
  description: 'Appends exactly the candidates an operator approved to a declared file, once each',
  autonomy_level: 'autonomous',
  side_effects: ['modifies_file'],
  approval_class: 'content',
  dependencies: ['candidate-propose'],
  ttl_hours: 1,
  schedule: 'on_run',
  timeout_ms: 10_000,
  inputs: {
    promoted_path: {
      type: 'string',
      required: true,
      default: 'state/promoted.json',
      description: 'The file promoted candidates are appended to, as { "promoted": [{ "id", "title", "score" }] }; a relative path under the warpline home',
    },
  },
  outputs: {
    promoted: { type: 'number', description: 'Candidates appended this run' },
  },
})
