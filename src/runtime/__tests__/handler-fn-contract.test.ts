/**
 * The handler-facing type and the schema it names must agree about what a
 * handler is allowed to return.
 *
 * `SkillResultSchema.artifacts_produced` accepts a bare string and normalizes it
 * at the parse boundary, and the schema says in terms that the arm stays valid
 * until 1.0. `HandlerFn` is the only path a plugin has to that schema. So if
 * `HandlerFn` returns the schema's OUTPUT type, the arm the schema promises is
 * unreachable through the only door into it, and the promise is one no consumer
 * can take.
 *
 * That contradiction shipped because nothing here stood on it. Every example
 * plugin in this repository writes `artifacts_produced: []`, which satisfies
 * both readings, and the suite parses fixtures rather than typing handlers. A
 * consumer typing its own handler against the published `HandlerFn` finds it
 * immediately, and finds it as a type error with no test to name.
 *
 * The detector below is therefore the `satisfies` at the bottom, and it goes
 * red under `bun run typecheck` rather than under `bun test`. A type-level
 * contradiction has no runtime symptom on this side of the boundary — the parse
 * accepts the data either way, which is exactly what the runtime assertions in
 * the first block measure.
 */
import { describe, expect, test } from 'bun:test'
import type { HandlerFn } from '../../index.js'
import { SkillResultSchema } from '../../schemas/skill-result.js'

describe('the bare-string arm survives the parse boundary', () => {
  test('a string normalizes to a path Output', () => {
    const parsed = SkillResultSchema.parse({
      status: 'success',
      phases_completed: ['collect'],
      phases_failed: [],
      data_freshness: {},
      summary: 'wrote one file',
      artifacts_produced: ['reports/one.md'],
    })

    expect(parsed.artifacts_produced).toEqual([
      { type: 'artifact', format: 'markdown', path: 'reports/one.md' },
    ])
  })

  test('a structured Output passes through the same union unchanged', () => {
    const parsed = SkillResultSchema.parse({
      status: 'success',
      phases_completed: [],
      phases_failed: [],
      data_freshness: {},
      summary: 'wrote one file',
      artifacts_produced: [{ type: 'report', format: 'json', path: 'reports/one.json' }],
    })

    expect(parsed.artifacts_produced).toEqual([
      { type: 'report', format: 'json', path: 'reports/one.json' },
    ])
  })
})

/**
 * A handler written the way the schema's documented arm invites. It omits the
 * fields the schema defaults and it returns a bare path string.
 *
 * The `satisfies` is the assertion. Nothing calls this function.
 */
const stringArmHandler = async () => ({
  status: 'success' as const,
  phases_completed: ['collect'],
  phases_failed: [],
  data_freshness: {},
  summary: 'wrote one file',
  artifacts_produced: ['reports/one.md'],
})

stringArmHandler satisfies HandlerFn

/**
 * The structured shape stays assignable too. This is the additivity half: the
 * widening must not cost anything a handler already written against the output
 * type had, or it is a break wearing a fix's clothes.
 */
const structuredHandler = async () => ({
  status: 'success' as const,
  phases_completed: [],
  phases_failed: [],
  errors: [],
  data_freshness: {},
  summary: 'wrote one file',
  artifacts_produced: [
    { type: 'report' as const, format: 'json' as const, path: 'reports/one.json' },
  ],
  schema_version: 2,
})

structuredHandler satisfies HandlerFn
