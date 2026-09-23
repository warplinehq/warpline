/**
 * Shapes only. This module is reachable as `warpline/schemas/skill-result`, and
 * `./schemas/*` is a wildcard entry in the `exports` map — so anything written
 * here is public API from the release it appears in, with no review step in
 * between.
 *
 * The one helper that used to sit among these schemas, `resolveOutput`, and the
 * `OutputResolution` union it returns, are gone as of 0.3.0. A single
 * synchronous existence check was enough to make a subpath named `schemas`
 * public API for disk I/O. It moved to the runtime first, where it turned out
 * to have no caller anywhere in the repository, so it was deleted rather than
 * kept as unreachable code with a filesystem import serving only itself. The
 * three states it resolved to are described in the 0.3.0 release notes. There
 * is no back-compat re-export: the bridge that would soften the break is the
 * same bridge that keeps the old path working.
 * `src/__tests__/no-orphan-schema-fields.test.ts` asserts no file under
 * `src/schemas/` imports the Node filesystem or path built-ins, so the boundary
 * holds for the next schema module as well as for this one.
 */
import { z } from 'zod'

/**
 * Error taxonomy for skill results.
 * 7 categories covering all failure modes skills can encounter.
 * Impact level determines routing behavior in warpline.
 */
export const SkillErrorSchema = z.object({
  code: z.enum([
    'auth_failure',
    'rate_limit',
    'data_missing',
    'stale_data',
    'parse_error',
    'timeout',
    'dependency_unavailable',
  ]),
  message: z.string(),
  impact: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  source: z.string().optional(),
  /** Whether the operation can be safely retried. Defaults to false. */
  retryable: z.boolean().default(false),
})

/**
 * Default retryability per error code.
 * rate_limit and timeout are transient — retrying after backoff is valid.
 * All others represent permanent or human-action-required failures.
 */
export const DEFAULT_RETRYABLE: Record<string, boolean> = {
  rate_limit: true,
  timeout: true,
  auth_failure: false,
  data_missing: false,
  stale_data: false,
  parse_error: false,
  dependency_unavailable: false,
}

/**
 * Construct a SkillError with correct retryability defaults per error code.
 * Callers may override any field via `overrides`.
 */
export function makeSkillError(
  code: SkillError['code'],
  message: string,
  overrides: Partial<Omit<SkillError, 'code' | 'message'>> = {},
): SkillError {
  return SkillErrorSchema.parse({
    code,
    message,
    impact: overrides.impact ?? 'MEDIUM',
    source: overrides.source,
    retryable: overrides.retryable ?? DEFAULT_RETRYABLE[code] ?? false,
  })
}

/**
 * Maximum size of an Output's inline `body`, in UTF-8 **bytes**.
 *
 * The binding constraint is not the event log — it is `engine-state.json`. An
 * inline body sits inside a `SkillResult` embedded in `PendingGateSchema`, in
 * the single state document that is reparsed and rewritten whole on every
 * advance and every `warpline plan`. 16 KiB holds a substantial markdown brief
 * while a dozen parked gates keep that document under 200 KB.
 *
 * It lives here rather than in a shared constants module because it is one
 * value used by one schema, and the schema is the thing that enforces it.
 */
export const OUTPUT_BODY_CAP_BYTES = 16_384

/**
 * A thing a plugin produced that an operator will read and take away.
 *
 * A handler's Output carries exactly one of an inline `body` or a `path`. The
 * record the state document stores is `StoredOutputRecordSchema` below, whose
 * erased state carries neither.
 * `run_id` and `produced_at` are stamped by the RUNTIME, never by the plugin —
 * they are optional here precisely because a handler must be able to return an
 * Output without them, and the runtime overwrites whatever a handler put there.
 *
 * The body cap is enforced with `Buffer.byteLength` and NOT with
 * `z.string().max()`: `.max()` counts UTF-16 code units, so it accepts
 * `'😀'.repeat(5)` — 10 code units, 20 UTF-8 bytes — against a limit of 10. The
 * cap that matters is the byte cost in the state document.
 */
export const OutputRecordSchema = z
  .object({
    /** Semantic kind, chosen by the plugin — 'report', 'brief', 'artifact'. */
    type: z.string(),
    /**
     * Rendering key. Closed enum: an unrecognised value fails validation rather
     * than being dropped. An undeclared one reads `markdown`; anything the
     * renderer does not understand is shown as preformatted text, never hidden.
     */
    format: z.enum(['markdown', 'json', 'html', 'text']).default('markdown'),
    /** The run that produced this Output. Stamped by the runtime. */
    run_id: z.string().optional(),
    /** When the producing run accepted it. Stamped by the runtime. */
    produced_at: z.string().optional(),
    /** Inline content, capped in UTF-8 bytes. Mutually exclusive with `path`. */
    body: z
      .string()
      .refine((s) => Buffer.byteLength(s, 'utf8') <= OUTPUT_BODY_CAP_BYTES, {
        message: `body exceeds ${OUTPUT_BODY_CAP_BYTES} UTF-8 bytes`,
      })
      .optional(),
    /** Filesystem path to the content. Mutually exclusive with `body`. */
    path: z.string().optional(),
  })
  .refine((o) => (o.body === undefined) !== (o.path === undefined), {
    message: 'an Output must declare exactly one of body or path',
  })

export type OutputRecord = z.infer<typeof OutputRecordSchema>

/**
 * The pre-0.2 bare-string Output, normalized at the parse boundary to a `path`
 * Output. One arm, shared by `SkillResultSchema` and `StoredSkillResultSchema`,
 * so the two result schemas cannot drift on it.
 */
const bareStringOutput = z
  .string()
  .transform((s): OutputRecord => ({ type: 'artifact', format: 'markdown', path: s }))

/**
 * The Output record the state document stores at `plugin_runs[name].last_output`.
 *
 * Its one difference from `OutputRecordSchema` is the erased state. Once the
 * last content approval for this producer that binds it has closed, been
 * withdrawn, or been replaced by a re-approve, the runtime erases `body` and
 * stamps `erased_at` and `body_sha256`. The record stays, so a
 * reader can still tell "produced, content erased" and "never produced" apart.
 * An applied gate stores the same record inside `StoredSkillResultSchema`.
 * An approval binds it by `run_id`, or, unless its fire was left marked and
 * unconfirmed, by fingerprint until its window closes.
 * The binding rule does not erase bytes that only such an unconfirmed fire
 * would match, or content bound only by fingerprint once the producer is
 * uninstalled, its manifest failed to load, or its `side_effects` changed. An
 * approval in a zone the host can no longer resolve is kept, and so is the
 * content it binds: the erasure never reads that window as closed.
 * docs/runtime-spec.md § 10 names these and
 * other cases erasure does not reach.
 *
 * **Handlers never see this shape.** They are still parsed against
 * `OutputRecordSchema`, which does not know the two keys. A handler Output that
 * carries them has them stripped when it has a body or a path, and is refused
 * as an invalid result when it has neither. No plugin can hand the runtime a
 * bodiless Output.
 *
 * **Nothing may strip `body` from a record after a parse.** A `{type, format}`
 * leftover fails this refine on the next fail-closed read and makes the home
 * unreadable. Erasure writes both stamps in the same step.
 *
 * **The hash is required once erased.** Without it an erased record would
 * fingerprint like an empty body, and a denial of real content would read the
 * same as a denial of nothing. It is refused on a record that is not erased,
 * because both stored-only keys belong to the erased state and nowhere else.
 *
 * Built by spreading the shape, not with `.extend`: `.extend` keeps the base
 * exactly-one refine, which can never admit a record with neither. The spread
 * keeps the byte cap, because the cap sits on the `body` field itself.
 */
export const StoredOutputRecordSchema = z
  .object({
    ...OutputRecordSchema.shape,
    /**
     * When the runtime erased `body`. Stamped by the runtime, never by a
     * plugin. Present only on a record whose content is gone. An ISO instant
     * in UTC, the form the runtime writes, and nothing looser: the state
     * document is hand-editable and this is its fail-closed read.
     */
    erased_at: z.iso.datetime().optional(),
    /**
     * The hex sha256 of the erased body, so a fingerprint taken before erasure
     * still matches after it. A digest, not content. Exactly 64 lowercase hex
     * characters, because it enters the fingerprint verbatim: an empty or
     * truncated value would move it, and a live denial would read superseded.
     */
    body_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .refine(
    (o) =>
      o.erased_at !== undefined
        ? o.body === undefined && o.path === undefined && o.body_sha256 !== undefined
        : o.body_sha256 === undefined && (o.body === undefined) !== (o.path === undefined),
    {
      message:
        'a stored Output declares exactly one of body or path, or neither once erased, and only an erased one keeps the hash of what it held',
    },
  )

export type StoredOutputRecord = z.infer<typeof StoredOutputRecordSchema>

/**
 * The shape a handoff's context path must have, as one sentence reused by the
 * refusal below.
 *
 * The refusal names the key and the shape expected of it and never the value.
 * A path is exactly the kind of value an operator's machine puts secrets in,
 * and this string lands in a run log — the same discipline `resolvePluginArgs`
 * states for config problems.
 */
const CONTEXT_PATH_SHAPE =
  'needs_llm.context_path must be a path relative to the warpline home, with no parent-directory segment'

/**
 * Does this path resolve inside the warpline home, whatever that home is?
 *
 * A schema module cannot ask where the home is — `warpline/schemas/*` ships
 * shapes and imports nothing but `zod` and its siblings, which is asserted. So
 * the check is on the path's SHAPE rather than on its resolution: a relative
 * path with no parent-directory segment lands under whatever root it is joined
 * to, and that is the whole of the guarantee needed here. An absolute path, a
 * drive letter and a `..` segment are the three ways out, and all three are
 * refused.
 */
function resolvesInsideHome(p: string): boolean {
  if (p.startsWith('/') || p.startsWith('\\')) return false
  if (/^[A-Za-z]:[\\/]/.test(p)) return false
  return !p.split(/[\\/]/).includes('..')
}

/**
 * A `[needs-llm]` handoff, as a field a plugin can construct rather than a
 * string it has to assemble.
 *
 * `context_path` names a PATH and never an inline payload, for the reason
 * docs/needs-llm-contract.md gives for the string arm: the scanner runs in a
 * session with the operator's rights, so the set of things a plugin can make
 * it open has to be bounded by the warpline home rather than by the plugin. An
 * inline blob would be read as a path, fail to resolve, and be reported as
 * out-of-home instead of consumed. Write the payload to a file under the home
 * and name that file, relative to the home.
 */
export const NeedsLlmSchema = z.object({
  /** What judgment work is being handed off, in one sentence and no punctuation at the end. */
  task: z.string(),
  /** Path to the payload, RELATIVE to the warpline home. */
  context_path: z.string().min(1).refine(resolvesInsideHome, { message: CONTEXT_PATH_SHAPE }),
})

export type NeedsLlm = z.infer<typeof NeedsLlmSchema>

/**
 * Skill result contract.
 * Every sub-skill must emit this structure in a ```skill-result fenced block.
 * Warpline validates on ingestion via SkillResultSchema.safeParse().
 */
export const SkillResultSchema = z.object({
  status: z.enum(['success', 'partial', 'failed', 'skipped']),
  phases_completed: z.array(z.string()),
  phases_failed: z.array(z.string()),
  errors: z.array(SkillErrorSchema).default([]),
  data_freshness: z.record(z.string(), z.string()),
  summary: z.string(),
  /**
   * The Outputs this result produced.
   *
   * The bare-string arm is the pre-0.2 shape and normalizes AT THE PARSE
   * BOUNDARY to a path Output, so nothing downstream branches on which arm an
   * entry arrived through. It stays valid until 1.0 and is dropped then with an
   * announcement — do not remove it before that.
   */
  artifacts_produced: z
    .array(
      z.union([bareStringOutput, OutputRecordSchema]),
    )
    .default([]),
  schema_version: z.number().default(2),
  /** Whether the side effects of this result can be undone. */
  reversible: z.boolean().optional(),
  /** Human-readable instruction for undoing the side effects, if reversible. */
  undo_instruction: z.string().optional(),
  /**
   * The judgment work this result hands off, structured rather than spelled
   * into the summary. Emitted TOGETHER with the `[needs-llm]` summary prefix,
   * never instead of it — the scanner that ships as a Claude Code skill reads
   * the summary string, and a result carrying only this field is one the
   * runtime calls delegated and the scanner never picks up.
   *
   * Optional, never nullable: an absent optional is omitted by
   * Zod and dropped by `JSON.stringify`, so a plugin that delegated nothing
   * carries no key at all rather than a `null` a reader would have to
   * interpret.
   */
  needs_llm: NeedsLlmSchema.optional(),
})

export type SkillResult = z.infer<typeof SkillResultSchema>

/**
 * The skill result the state document stores at `pending_gates[].plugin_result`.
 *
 * Its one difference from `SkillResultSchema` is its Outputs, which are
 * `StoredOutputRecordSchema` records. Once erasure releases the content an
 * applied gate recorded, the gate's copy is erased and its record stays,
 * marked, so the gate still says what the run produced.
 *
 * **Handlers never see this shape.** A handler's result is parsed against
 * `SkillResultSchema`, whose Outputs cannot be bodiless.
 *
 * `.extend` replaces the one field, and both schemas share `bareStringOutput`,
 * so the two cannot drift.
 */
export const StoredSkillResultSchema = SkillResultSchema.extend({
  artifacts_produced: z.array(z.union([bareStringOutput, StoredOutputRecordSchema])).default([]),
})

export type StoredSkillResult = z.infer<typeof StoredSkillResultSchema>

/**
 * The result as a PRODUCER writes it, before the parse boundary runs.
 *
 * `SkillResult` above is `z.infer<>` — the schema's OUTPUT type, what a reader
 * holds after `.parse()`. This is the input side of the same schema: defaulted
 * fields are optional, and `artifacts_produced` still carries the bare-string
 * arm documented above.
 *
 * The distinction is not decorative. A handler typed against the output type
 * can never write a bare string, so the arm this schema promises until 1.0 is
 * unreachable through the only path a plugin has. `HandlerFn` returns this type
 * for that reason. Every value assignable to `SkillResult` is assignable here
 * too — the widening is additive, and a handler already written against the
 * output type keeps typechecking unchanged.
 */
export type SkillResultInput = z.input<typeof SkillResultSchema>
export type SkillError = z.infer<typeof SkillErrorSchema>
