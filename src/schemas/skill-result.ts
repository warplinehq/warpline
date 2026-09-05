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
 * Carries either an inline `body` or a `path`, never both and never neither.
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
      z.union([
        z
          .string()
          .transform((s): OutputRecord => ({ type: 'artifact', format: 'markdown', path: s })),
        OutputRecordSchema,
      ]),
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
