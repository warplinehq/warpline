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
  /** Whether the operation can be safely retried. Defaults to false. Per D-08, D-09. */
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
 * Brief action schema for intel-brief skill output.
 * Each action represents a strategic recommendation that flows into the task board
 * as a human-gated item with stable `intel/strategy/{slug}` IDs.
 */
export const BriefActionSchema = z.object({
  task_id: z.string(),
  description: z.string(),
  tier: z.enum(['immediate', 'medium', 'long']),
  detail: z.string(),
  severity: z.enum(['critical', 'warning', 'info']),
  source_references: z.array(z.string()),
})
export type BriefAction = z.infer<typeof BriefActionSchema>

/**
 * Skill result contract.
 * Every sub-skill must emit this structure in a ```skill-result fenced block.
 * Warpline validates on ingestion via SkillResultSchema.safeParse().
 *
 * See: .warpline/intel/references/skill-contracts.md
 */
export const SkillResultSchema = z.object({
  status: z.enum(['success', 'partial', 'failed', 'skipped']),
  phases_completed: z.array(z.string()),
  phases_failed: z.array(z.string()),
  errors: z.array(SkillErrorSchema).default([]),
  data_freshness: z.record(z.string(), z.string()),
  summary: z.string(),
  artifacts_produced: z.array(z.string()).default([]),
  schema_version: z.number().default(1),
  /** Whether the side effects of this result can be undone (D-14). */
  reversible: z.boolean().optional(),
  /** Human-readable instruction for undoing the side effects, if reversible. */
  undo_instruction: z.string().optional(),
  /** Strategic actions emitted by intel-brief skill. Capped at 15 per D-03. */
  actions: z.array(BriefActionSchema).max(15).optional(),
})

export type SkillResult = z.infer<typeof SkillResultSchema>
export type SkillError = z.infer<typeof SkillErrorSchema>
