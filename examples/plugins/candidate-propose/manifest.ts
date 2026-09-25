import { PluginManifestSchema } from 'warpline/schemas/plugin-manifest'

/**
 * candidate-propose — example plugin.
 *
 * The first half of the candidate example: once a week it picks at most three
 * candidates from a pool the adopter keeps, highest score first, and emits
 * them as one Output an operator can read and approve.
 *
 * Why both `schedule: 'weekly'` and `ttl_hours: 168`. The schedule alone is
 * only a filter for a scheduled profile: an unprofiled `warpline advance` runs
 * every plugin whose TTL has lapsed, so without the TTL this would propose on
 * every advance. The TTL alone would run under a daily profile. Together they
 * mean once a week on every path.
 *
 * Each proposal replaces the last. That is the `outputs` default, `replace`
 * temporality, and nothing is kept in state, so there is no history to grow
 * and no old proposal to approve by mistake. A missing pool file still emits
 * a proposal, an empty one, because a run with no Output would leave last
 * week's proposal in place and still approvable.
 *
 * The cap of three is the point, not a tuning knob. A proposer that floods
 * the operator is one nobody reads, so it is a constant in the handler and
 * not an input.
 *
 * It writes nothing at all. Promotion can happen only through
 * `candidate-promote`, and that only after an operator approves these exact
 * bytes with `warpline approve candidate-promote --content --not-after <when>`.
 */
export const manifest = PluginManifestSchema.parse({
  name: 'candidate-propose',
  version: '1.0.0',
  description: 'Proposes at most three candidates from a declared pool each week; each proposal replaces the last and nothing accumulates. Promotes nothing',
  autonomy_level: 'autonomous',
  side_effects: [],
  schedule: 'weekly',
  ttl_hours: 168,
  timeout_ms: 10_000,
  inputs: {
    pool_path: {
      type: 'string',
      required: true,
      default: 'state/candidates.json',
      description: 'The pool to choose from, as { "candidates": [{ "id", "title", "score" }] }; a relative path under the warpline home',
    },
  },
  outputs: {
    proposal: {
      type: 'object',
      description: 'At most three candidates, highest score first; an operator approves these exact bytes for candidate-promote',
    },
  },
})
