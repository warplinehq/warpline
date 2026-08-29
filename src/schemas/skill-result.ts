import { z } from 'zod'
import { existsSync } from 'node:fs'

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
 * What an Output points at right now.
 *
 * A path Output can outlive the file it names — the runtime never deletes a
 * path Output's target, but nothing stops the operator or the producing plugin
 * from doing so. That is a defined state, not an error, so a renderer can say
 * "the file is gone" instead of throwing.
 */
export type OutputResolution =
  | { state: 'inline'; body: string }
  | { state: 'present'; path: string }
  | { state: 'missing'; path: string }

/** Resolve an Output to its current state. Never throws. */
export function resolveOutput(output: OutputRecord): OutputResolution {
  if (output.body !== undefined) return { state: 'inline', body: output.body }
  const path = output.path as string
  return existsSync(path) ? { state: 'present', path } : { state: 'missing', path }
}

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
})

export type SkillResult = z.infer<typeof SkillResultSchema>
export type SkillError = z.infer<typeof SkillErrorSchema>
