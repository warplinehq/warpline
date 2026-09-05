/**
 * The two results a plugin actually writes, built once instead of by hand.
 *
 * A result literal is fifteen lines of which five are the same five every
 * time — `phases_completed: []`, `phases_failed: []`, `data_freshness: {}`,
 * `errors: []`, `artifacts_produced: []` — and the interesting part is one
 * string. Hand-writing that at every site is how a `schema_version` that
 * disagrees with the schema's own default spreads, and how one site quietly
 * omits a required field until the boundary refuses the whole result at
 * runtime.
 *
 * **The return type is `SkillResultInput`, the schema's INPUT type.** Not the
 * output type, and this is the one decision in the file worth stating. A
 * producer writes a result; it does not read one back. Typing against the
 * output type makes the bare-string `artifacts_produced` arm — which the
 * schema documents as valid until 1.0 — unexpressible through the only path a
 * plugin has, which is the defect `HandlerFn`'s docstring records. The same
 * mistake made here would re-close the arm one level further out, where the
 * handler signature that was widened to keep it open still says it is open.
 *
 * **These builders do not validate on the way out.** `makeSkillError` does,
 * and correctly — its schema has no input/output divergence, so validating
 * costs nothing. Validating here would hand back the output type and undo the
 * paragraph above. There is exactly one validator for a result, it lives at
 * the boundary in `invoke-plugin.ts`, and a second one here would be a second
 * place for the answer to differ.
 *
 * **Fields with a declared default are not restated.** `errors`,
 * `artifacts_produced` and `schema_version` are passed through as whatever the
 * caller gave — usually `undefined`, which is precisely what makes the
 * schema's own default apply. Writing `[]` or `2` here would be a second copy
 * of a default, in a file that exists to stop second copies of things.
 */
import { makeSkillError } from '../schemas/skill-result.js'
import type { SkillError, SkillResultInput } from '../schemas/skill-result.js'

/**
 * Everything a caller may set that is not the status or the summary — those
 * two are what the builder itself decides.
 */
type ResultOverrides = Partial<Omit<SkillResultInput, 'status' | 'summary'>>

/** Result fields plus the error fields `makeSkillError` accepts, in one bag. */
type FailureOverrides = ResultOverrides & Partial<Omit<SkillError, 'code' | 'message'>>

/**
 * A successful result carrying `summary` and nothing else the caller did not ask
 * for. An empty summary is allowed: a plugin that succeeded with nothing worth
 * saying is not an error, and refusing it here would be a rule the boundary
 * itself does not have.
 */
export function skillOk(summary: string, overrides: ResultOverrides = {}): SkillResultInput {
  return {
    status: 'success',
    phases_completed: overrides.phases_completed ?? [],
    phases_failed: overrides.phases_failed ?? [],
    data_freshness: overrides.data_freshness ?? {},
    summary,
    errors: overrides.errors,
    artifacts_produced: overrides.artifacts_produced,
    schema_version: overrides.schema_version,
    reversible: overrides.reversible,
    undo_instruction: overrides.undo_instruction,
  }
}

/**
 * A failed result carrying exactly one error.
 *
 * The error goes through `makeSkillError`, so retryability comes from
 * `DEFAULT_RETRYABLE[code]` rather than from whatever the call site guessed —
 * that routing is the whole reason this is a builder and not a literal. A
 * caller who knows better overrides `retryable` explicitly.
 *
 * `summary` defaults to `message`. A failure whose summary and whose error text
 * say different things is a failure two readers describe differently.
 */
export function skillFailure(
  code: SkillError['code'],
  message: string,
  overrides: FailureOverrides = {},
): SkillResultInput {
  return {
    status: 'failed',
    phases_completed: overrides.phases_completed ?? [],
    phases_failed: overrides.phases_failed ?? [],
    data_freshness: overrides.data_freshness ?? {},
    summary: message,
    errors: overrides.errors ?? [makeSkillError(code, message, overrides)],
    artifacts_produced: overrides.artifacts_produced,
    schema_version: overrides.schema_version,
    reversible: overrides.reversible,
    undo_instruction: overrides.undo_instruction,
  }
}
