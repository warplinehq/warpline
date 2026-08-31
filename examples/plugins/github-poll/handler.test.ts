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
 *
 * A sentinel here has to pass the input regex at handler.ts:29, or the two arms
 * below it are unreachable and the case proves nothing about them. That is how
 * the success-path leak shipped: the only sentinel in the suite was invalid by
 * construction, so it never got past the first guard.
 */

/**
 * Swap `globalThis.fetch` for one returning `response`, run `body`, restore the
 * real one whatever happens. A leaked global breaks unrelated tests
 * non-deterministically, and nobody attributes that back to the file that did it.
 */
async function withStubbedFetch(response: unknown, body: () => Promise<void>): Promise<void> {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () => response) as unknown as typeof fetch
  try {
    await body()
  } finally {
    globalThis.fetch = realFetch
  }
}

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

  test('a non-ok response names the status, not the repo it was configured with', async () => {
    const sentinel = 'sentinel-owner/do-not-echo-7c2f10'
    await withStubbedFetch({ ok: false, status: 404 }, async () => {
      const result = await handler(
        {} as PluginManifest,
        { repo: sentinel },
        new AbortController().signal,
      )

      expect(result.status).toBe('failed')
      expect(result.errors[0]?.code).toBe('dependency_unavailable')
      expect(JSON.stringify(result)).not.toContain(sentinel)
      // Still enough to act on: the status is what tells you whether to look at
      // the repo name or at the token.
      expect(result.errors[0]?.message).toContain('404')
    })
  })

  test('a successful poll reports the count without the repo it counted', async () => {
    const sentinel = 'sentinel-owner/do-not-echo-7c2f10'
    const issues = [
      { title: 'first', labels: [{ name: 'bug' }] },
      { title: 'second', labels: [] },
    ]
    await withStubbedFetch({ ok: true, status: 200, json: async () => issues }, async () => {
      const result = await handler(
        {} as PluginManifest,
        { repo: sentinel },
        new AbortController().signal,
      )

      // The success arm is the one that leaked, and it leaked on every run —
      // the engine writes this summary to the run log whether or not anything
      // went wrong.
      expect(result.status).toBe('success')
      expect(JSON.stringify(result)).not.toContain(sentinel)
      expect(result.summary).toMatch(/(\d+) open issues/)
    })
  })
})
