import { describe, test, expect } from 'bun:test'
import type { PluginManifest } from 'warpline/schemas/plugin-manifest'
import { summariseByLabel, handler } from './handler.js'

describe('github-poll summariseByLabel', () => {
  test('counts by label, multi-label issues count once per label', () => {
    const counts = summariseByLabel([
      { title: 'a', labels: [{ name: 'bug' }, { name: 'p1' }] },
      { title: 'b', labels: [{ name: 'bug' }] },
    ])
    expect(counts).toEqual({ bug: 2, p1: 1 })
  })

  test('unlabelled issues bucket together; PRs are excluded', () => {
    const counts = summariseByLabel([
      { title: 'a', labels: [] },
      { title: 'pr', labels: [{ name: 'bug' }], pull_request: {} },
    ])
    expect(counts).toEqual({ '(unlabelled)': 1 })
  })
})

/**
 * A config value is read from a file an operator may have put a token in, and
 * a SkillResult is written to a run log on disk. So an error message that
 * quotes the value it was handed is a disclosure path from the one to the
 * other. The message names the key and the shape expected of it; the value is
 * omitted entirely, never masked, because a mask needs a heuristic for what
 * looks secret and that heuristic is what goes stale.
 */
describe('github-poll handler input guard', () => {
  test('an invalid repo is rejected without the value appearing anywhere in the result', async () => {
    const sentinel = 'ghp-do-not-echo-me-0d3f9a'
    const result = await handler(
      {} as PluginManifest,
      { repo: sentinel },
      new AbortController().signal,
    )

    expect(result.status).toBe('failed')
    expect(result.errors[0]?.code).toBe('parse_error')
    // The whole result, not just the message: summary is a field too, and so
    // is anything a later edit adds beside them.
    expect(JSON.stringify(result)).not.toContain(sentinel)
    // Still useful to whoever has to fix it.
    expect(result.errors[0]?.message).toContain('repo')
    expect(result.errors[0]?.message).toContain('owner/name')
  })
})
