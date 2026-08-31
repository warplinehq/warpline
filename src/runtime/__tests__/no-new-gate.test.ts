/**
 * Two closed sets that invalid plugin config must not grow.
 *
 * When config resolution learned to fail, the obvious-looking move was to give
 * the engine a ninth not-due reason — a `bad_config` gate beside `denied` and
 * `unapproved` — so a plugin with a broken config never reached `invokePlugin`
 * at all. That move was refused, and this file is what keeps it refused.
 *
 * The reason is not taste. `invokePlugin` already models this failure: an
 * invalid config returns `status: 'failed'` with one `parse_error`,
 * `retryable: false`, and exactly one attempt, because the arm sits above the
 * retry loop. A gate would model the same failure a second time, one layer
 * earlier, in the due/not-due filter chain that is already the longest
 * sequential chain in the runtime and already the thing reviewers flag when
 * they ask why a plugin did not run. A second answer to "why did nothing
 * happen" is worse than the one that exists — it is a place for the two
 * answers to disagree.
 *
 * The same pressure exists one level down as a fifth `SkillResult.status`.
 * Same refusal, same reason: `failed` with a `parse_error` is what a bad
 * config is.
 *
 * `NotDueReason` is a TypeScript union, not a Zod enum, so it has no runtime
 * shape to read and the assertion is a line-wise read of the source — the same
 * genre as the other source guards in this repo, which are all regex and none
 * of which parse TypeScript. `SkillResult.status` IS a Zod enum, so that half
 * reads the schema directly. Both compare sets, so reordering a member is not
 * a failure; adding or removing one is.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SkillResultSchema } from '../../schemas/skill-result.js'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')
const ENGINE = join(REPO_ROOT, 'src', 'runtime', 'engine.ts')

/**
 * The eight reasons a plugin can be not due, as of this release. Written out
 * here rather than derived, because a derived expectation would agree with
 * whatever the source says and pin nothing.
 */
const NOT_DUE_REASONS = [
  'profile_schedule',
  'min_tier',
  'headless_supervised',
  'manual',
  'fresh',
  'denied',
  'task_locked',
  'unapproved',
]

/** The four terminal states a skill result can report. */
const SKILL_RESULT_STATUSES = ['success', 'partial', 'failed', 'skipped']

/**
 * Collect the quoted members of the `NotDueReason` union.
 *
 * The scan starts at the declaration and stops at the first line that is not a
 * union arm, which is what keeps it from walking into `EvalResult` two lines
 * below — that type's arms are object literals, and a scan that ran past the
 * end of this one would start reporting whatever they happen to quote.
 */
function readNotDueReasons(): string[] {
  const lines = readFileSync(ENGINE, 'utf8').split('\n')
  const start = lines.findIndex((l) => /^export type NotDueReason\s*=/.test(l))
  if (start === -1) throw new Error(`no 'export type NotDueReason' declaration in ${ENGINE}`)

  const members: string[] = []
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i] as string
    // The declaration line itself is in scope (a one-line union would put its
    // first member there); after it, only arm lines are.
    if (i > start && !/^\s*\|/.test(line)) break
    for (const m of line.matchAll(/'([^']+)'/g)) members.push(m[1] as string)
  }
  return members
}

describe('invalid config grows no new gate', () => {
  test('NotDueReason declares exactly its eight members', () => {
    const found = readNotDueReasons()
    // Non-empty first: a scan that matched nothing would otherwise only fail
    // the comparison below by being empty, which reads like a deleted union
    // rather than a broken extractor.
    expect(found.length).toBeGreaterThan(0)
    expect([...found].sort()).toEqual([...NOT_DUE_REASONS].sort())
  })

  test('SkillResult.status offers exactly its four members', () => {
    // Widened to string[]: the point is to compare against a hand-written list,
    // and a list typed from the enum would be tautological anyway.
    const options: string[] = [...SkillResultSchema.shape.status.options]
    expect(options).toHaveLength(4)
    expect(options.sort()).toEqual([...SKILL_RESULT_STATUSES].sort())
  })

  /**
   * The extractor is only as good as its stopping rule. A union of two members
   * must come back as two, and the scan must not run into the type that
   * follows it.
   */
  test('the union scan stops at the end of the union', () => {
    const found = readNotDueReasons()
    expect(found).not.toContain('due')
    expect(found).not.toContain('reason')
  })
})
