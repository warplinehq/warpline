/**
 * assurance — the verifier seam: the one place an Answer's assurance is assigned.
 *
 * In this release every Answer is `asserted`. The identity on it is a
 * registry id someone typed, and nothing checks the evidence it names. A
 * later level, one that does check, is added here and to the list, and the
 * audit store's `ask.answered` schema takes its levels from this list.
 *
 * It imports nothing, so the audit store can import it without a cycle.
 */

/** Every assurance level an Answer can carry. */
export const ASSURANCE_LEVELS = ['asserted'] as const

export type AssuranceLevel = (typeof ASSURANCE_LEVELS)[number]

/** The assurance an Answer with this evidence carries. Every Answer is asserted until a verifier lands here. */
export function verifyAnswer(evidence: string | null): AssuranceLevel {
  return 'asserted'
}
