import { makeSkillError } from '../../../src/schemas/skill-result.js'
import type { HandlerFn } from '../../../src/runtime/invoke-plugin.js'

/**
 * Fixture: a `[needs-llm]` handoff that ALSO populates `errors[]`.
 *
 * The error is the discriminating part. A handoff with an empty `errors[]`
 * would pass the attempt-error assertions by accident, since `firstError`
 * would be null whatever the classifier decided. Carrying one proves the
 * classifier — not the absence of input — is what keeps `error` null.
 *
 * Built through `makeSkillError` rather than an object literal so it is a
 * valid SkillError. An invalid one fails `SkillResultSchema.safeParse`, and
 * `invokePlugin` replaces the whole result with a `parse_error` failure — the
 * handoff never reaches the classifier and the fixture silently tests nothing.
 */
export const handler: HandlerFn = async () => ({
  status: 'skipped',
  phases_completed: [],
  phases_failed: [],
  errors: [
    makeSkillError('data_missing', 'one feed was unreachable; handing off the rest', {
      impact: 'LOW',
    }),
  ],
  data_freshness: {},
  summary: '[needs-llm] Triage 2 new feed entries. Context: /tmp/payload.json',
  artifacts_produced: [],
  schema_version: 1,
})
