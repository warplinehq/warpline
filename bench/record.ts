/**
 * The benchmark run record, and the scrubber that sits at its parse boundary.
 *
 * This schema is a stability contract from its first commit. Every file under
 * `bench/results/` is validated against it, those files are published, and a
 * reader a year from now has to be able to parse the oldest of them with the
 * newest copy of this module. Adding an optional field is free; changing what
 * an existing field means is not.
 *
 * Two shapes are deliberate rather than convenient:
 *
 *   - Token classes are `int | null`, never a defaulted zero. A class the CLI
 *     did not report and a class it reported as zero are different facts, and
 *     coercing the first into the second silently understates a total. `null`
 *     is the missing-class signal and the run carrying it is dispositioned
 *     `failed-schema`.
 *   - Token counts are integers in the raw record and are never averaged here.
 *     Aggregation belongs to the statistics module, over the raw integers. A
 *     fraction in this file would mean a mean had already been taken and the
 *     samples it came from are gone.
 *
 * Wall clock is float milliseconds from `performance.now()`. `runtime_ms` and
 * `consumer_ms` are nullable so the warpline arm can record its two segments
 * separately while an arm with only one segment records `null` for the other.
 */
import { tmpdir } from 'node:os'
import { z } from 'zod'

/**
 * The four artifacts that are GRADED, in fixed order.
 *
 * Defined here rather than beside the seeding code because this module is the
 * leaf: a record is parsed by readers that never seed a home, and the graded
 * key set is part of the record's shape. The seeding module imports these and
 * maps them to paths; nothing restates the names.
 */
export const GRADED_KEYS = ['announce-fanout', 'daily-digest', 'draft-writer', 'metrics-rollup'] as const
export type GradedKey = (typeof GRADED_KEYS)[number]

/**
 * The four token classes a run reports, each nullable.
 *
 * Exported as a schema AND as a type so the statistics module can consume the
 * class shape structurally without importing the record schema.
 */
export const TokenClassesSchema = z.object({
  input: z.number().int().nullable(),
  output: z.number().int().nullable(),
  cache_creation: z.number().int().nullable(),
  cache_read: z.number().int().nullable(),
})
export type TokenClasses = z.infer<typeof TokenClassesSchema>

/**
 * Per-artifact grading outcome. The `satisfies` clause is the drift guard: a
 * key added to or removed from the graded set fails the typecheck here rather
 * than producing a record whose `graded` map silently disagrees with the
 * grader's.
 */
const GradedSchema = z.object({
  'announce-fanout': z.boolean(),
  'daily-digest': z.boolean(),
  'draft-writer': z.boolean(),
  'metrics-rollup': z.boolean(),
} satisfies Record<GradedKey, z.ZodBoolean>)

export const BenchRunRecordSchema = z.object({
  /** Which arm produced this run. Three, closed — an unknown arm is a bug, not data. */
  arm: z.enum(['warpline', 'agent-with-state', 'agent-from-scratch']),
  /** Which iteration of that arm, 1-based. */
  iteration: z.number().int(),
  /** Where this arm sat in the interleaving order for this iteration, so an order effect is visible rather than assumed away. */
  arm_order_index: z.number().int(),
  /** Whether the provider prompt cache was cold for this run. State, never state of the warpline home — homes are always fresh. */
  cold: z.boolean(),
  /**
   * The single precedence chain, resolved once per run: truncated over
   * failed-schema over failed-grader over passed. A run can satisfy more than
   * one of these and only the highest is recorded, so two readers of the same
   * record cannot disagree about what happened.
   */
  disposition: z.enum(['passed', 'failed-grader', 'failed-schema', 'truncated']),
  /** The CLI's own subtype for a truncated run; null on every other disposition. */
  truncation_subtype: z.string().nullable(),
  tokens: TokenClassesSchema,
  /** Float milliseconds, whole run. */
  wall_clock_ms: z.number(),
  /** Float milliseconds inside the deterministic segment; null for an arm that has none. */
  runtime_ms: z.number().nullable(),
  /** Float milliseconds inside the judgment segment; null for an arm that has none. */
  consumer_ms: z.number().nullable(),
  /** How many handoffs this run parked, counted from the run log. */
  parked_handoffs: z.number().int(),
  graded: GradedSchema,
  /**
   * Provenance. Four strings that let a reader re-run this exact configuration,
   * and that make a comparison across a version bump visible instead of silent.
   */
  git_sha: z.string(),
  package_version: z.string(),
  claude_cli_version: z.string(),
  model_id: z.string(),
})

export type BenchRunRecord = z.infer<typeof BenchRunRecordSchema>
export type BenchDisposition = BenchRunRecord['disposition']

/** What an operator path is rewritten to before anything is parsed or written. */
export const HOME_PLACEHOLDER = '<home>'

/** Keys holding free text that a published record must not carry. */
const FREE_TEXT_KEYS = new Set(['result', 'stdout', 'stderr', 'message'])

/**
 * Home first, then the system temp root.
 *
 * The order is load-bearing and not cosmetic: an arm home lives UNDER the
 * temp root, so rewriting the temp root first would leave the home's unique
 * suffix behind in the string — the operator-identifying half of it.
 */
function scrubString(value: string, home: string): string {
  let out = value
  if (home !== '') out = out.split(home).join(HOME_PLACEHOLDER)
  const temp = tmpdir()
  if (temp !== '') out = out.split(temp).join(HOME_PLACEHOLDER)
  return out
}

/**
 * Scrub a raw record. Runs BEFORE the schema parse, never after.
 *
 * The ORDERING is the safety property here, not the placeholder's shape. A
 * scrub applied after parsing would be applied to a value that had already
 * been accepted, and a caller holding the parsed object could write it out
 * without ever reaching the scrub. `parseRecord` below is the only exported
 * path to a validated record for exactly that reason: no caller can reach the
 * parse without the scrub having run first.
 *
 * Three removals, at every depth:
 *   - any key whose lower-cased name contains the substring `cost`, because a
 *     published benchmark that carries a currency figure invites a comparison
 *     against a price list that changes underneath it;
 *   - any occurrence of the arm home or the system temp root inside a string
 *     value, because both name the operator's machine;
 *   - any free-text response body, because nobody has read it and it is the
 *     one field that can carry anything at all.
 */
export function scrubRecord(raw: unknown, home: string): unknown {
  if (typeof raw === 'string') return scrubString(raw, home)
  if (Array.isArray(raw)) return raw.map((entry) => scrubRecord(entry, home))
  if (raw !== null && typeof raw === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(raw)) {
      if (key.toLowerCase().includes('cost')) continue
      if (FREE_TEXT_KEYS.has(key) && typeof value === 'string') continue
      out[key] = scrubRecord(value, home)
    }
    return out
  }
  return raw
}

/** Scrub, then parse. The one function a caller uses to obtain a record. */
export function parseRecord(raw: unknown, home: string): BenchRunRecord {
  return BenchRunRecordSchema.parse(scrubRecord(raw, home))
}
