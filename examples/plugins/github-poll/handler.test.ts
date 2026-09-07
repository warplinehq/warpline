import { describe, test, expect } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CapabilityContext } from 'warpline/unstable-capabilities'
import { OutputRecordSchema } from 'warpline/schemas/skill-result'
import { summariseByLabel, handler } from './handler.js'
import { manifest } from './manifest.js'

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

/** The handler is four-parameter; a test hands it a context it never reads. */
const CONTEXT = {} as CapabilityContext

function invoke(args: Record<string, unknown>, signal = new AbortController().signal) {
  return handler(manifest, args, signal, CONTEXT)
}

/**
 * `warpline/lib/paths` exports only `warplineHome`, which resolves
 * `WARPLINE_HOME` per call — the same seam a plugin author has. Every handler
 * call below runs inside its own home, including the disclosure cases: the
 * handler leaves a snapshot behind, and a case that ran in a shared home would
 * read whatever the previous case left there.
 */
async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'github-poll-'))
  const realHome = process.env.WARPLINE_HOME
  process.env.WARPLINE_HOME = home
  try {
    return await fn(home)
  } finally {
    if (realHome === undefined) delete process.env.WARPLINE_HOME
    else process.env.WARPLINE_HOME = realHome
    await rm(home, { recursive: true, force: true })
  }
}

/**
 * Swap `globalThis.fetch` for one returning `response`, run `body`, restore the
 * real one whatever happens. A leaked global breaks unrelated tests
 * non-deterministically, and nobody attributes that back to the file that did it.
 */
async function withStubbedFetch(response: unknown, body: () => Promise<void>): Promise<void> {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    if (response instanceof Error) throw response
    return response
  }) as unknown as typeof fetch
  try {
    await body()
  } finally {
    globalThis.fetch = realFetch
  }
}

/** A fixed issues payload; the API lists newest first and includes PRs. */
const ISSUES = [
  { number: 12, title: 'newest', labels: [{ name: 'bug' }] },
  { number: 11, title: 'older', labels: [] },
  { number: 10, title: 'a pull request', labels: [], pull_request: {} },
]
const OK = { ok: true, status: 200, json: async () => ISSUES }

const REPO = 'example-owner/example-repo'
const SNAPSHOT = (home: string) => join(home, 'state', 'github-poll.last.json')

describe('github-poll persists what it polled', () => {
  test('the first run writes a snapshot and reports it as the first observation', async () => {
    await withHome(async (home) => {
      await withStubbedFetch(OK, async () => {
        const result = await invoke({ repo: REPO })

        expect(result.status).toBe('success')
        expect(result.summary).toContain('first observation')
        expect(result.summary).toMatch(/2 open issues/)

        const written = JSON.parse(await readFile(SNAPSHOT(home), 'utf-8'))
        expect(written.open_count).toBe(2)
        expect(written.newest_number).toBe(12)
        expect(typeof written.observed_at).toBe('string')
      })
    })
  })

  test('a second run in the same home reads the snapshot and says something different', async () => {
    await withHome(async () => {
      await withStubbedFetch(OK, async () => {
        const first = await invoke({ repo: REPO })
        const second = await invoke({ repo: REPO })

        expect(second.status).toBe('success')
        expect(second.summary).not.toBe(first.summary)
        expect(second.summary).not.toContain('first observation')
        expect(second.summary).toContain('since')
        expect(second.summary).toMatch(/2 open issues/)
      })
    })
  })

  test('a changed poll is named against the prior snapshot', async () => {
    await withHome(async () => {
      await withStubbedFetch(OK, async () => {
        await invoke({ repo: REPO })
      })
      const grown = [{ number: 13, title: 'newer still', labels: [] }, ...ISSUES]
      await withStubbedFetch({ ok: true, status: 200, json: async () => grown }, async () => {
        const second = await invoke({ repo: REPO })

        expect(second.summary).toMatch(/open 2 -> 3/)
        expect(second.summary).toMatch(/newest issue is now #13/)
      })
    })
  })

  test('the success arm returns exactly one Output that parses at the boundary and declares body or path, not both', async () => {
    await withHome(async () => {
      await withStubbedFetch(OK, async () => {
        const result = await invoke({ repo: REPO })

        // A dependent now declares this plugin, so the snapshot it saw is
        // returned as an Output — what a digest wants: the identity and the
        // count, not the payload.
        expect(result.artifacts_produced).toHaveLength(1)
        const output = OutputRecordSchema.parse(result.artifacts_produced?.[0])
        expect(output.body !== undefined).not.toBe(output.path !== undefined)
        const body = JSON.parse(output.body!)
        expect(body.open_count).toBe(2)
        expect(body.newest_number).toBe(12)
        expect(typeof body.observed_at).toBe('string')
        expect(Buffer.byteLength(output.body!, 'utf8')).toBeLessThanOrEqual(16_384)
      })
    })
  })

  test('a snapshot in the wrong shape is a parse_error that leaves the file as it is, never "open undefined -> 2"', async () => {
    await withHome(async (home) => {
      await mkdir(join(home, 'state'), { recursive: true })
      for (const wrong of ['{}', '{"observed_at": "x", "open_count": "2", "newest_number": 1}', '[]']) {
        await writeFile(SNAPSHOT(home), wrong)
        await withStubbedFetch(OK, async () => {
          const result = await invoke({ repo: REPO })

          expect(result.status).toBe('failed')
          expect(result.errors?.[0]?.code).toBe('parse_error')
          expect(JSON.stringify(result)).not.toContain('undefined')
          expect(JSON.stringify(result)).not.toContain(home)
        })
        expect(await readFile(SNAPSHOT(home), 'utf-8')).toBe(wrong)
      }
    })
  })

  test('a snapshot that cannot be read is a failure, not a first observation', async () => {
    await withHome(async (home) => {
      await mkdir(join(home, 'state'), { recursive: true })
      await writeFile(SNAPSHOT(home), 'not json')
      await withStubbedFetch(OK, async () => {
        // The read rethrows anything that is not ENOENT and the handler must
        // not swallow it: a swallowed error would report "first observation"
        // over a file that exists and cannot be read.
        await expect(invoke({ repo: REPO })).rejects.toThrow()
      })
    })
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
 * A sentinel here has to pass the input regex in the handler, or the arms
 * below it are unreachable and the case proves nothing about them. That is how
 * the success-path leak shipped: the only sentinel in the suite was invalid by
 * construction, so it never got past the first guard.
 *
 * The snapshot file is a fourth sink: it is written under the home on every
 * successful run, so it is checked the same way the result is.
 */
describe('github-poll handler input guard', () => {
  test('an invalid repo is rejected without the value appearing anywhere in the result', async () => {
    await withHome(async () => {
      const sentinel = 'ghp-do-not-echo-me-0d3f9a'
      const result = await invoke({ repo: sentinel })

      expect(result.status).toBe('failed')
      expect(result.errors?.[0]?.code).toBe('parse_error')
      // The whole result, not just the message: summary is a field too, and so
      // is anything a later edit adds beside them.
      expect(JSON.stringify(result)).not.toContain(sentinel)
      // Still useful to whoever has to fix it.
      expect(result.errors?.[0]?.message).toContain('repo')
      expect(result.errors?.[0]?.message).toContain('owner/name')
    })
  })

  test('a non-ok response names the status, not the repo it was configured with', async () => {
    await withHome(async () => {
      const sentinel = 'sentinel-owner/do-not-echo-7c2f10'
      await withStubbedFetch({ ok: false, status: 404 }, async () => {
        const result = await invoke({ repo: sentinel })

        expect(result.status).toBe('failed')
        expect(result.errors?.[0]?.code).toBe('dependency_unavailable')
        expect(JSON.stringify(result)).not.toContain(sentinel)
        // Still enough to act on: the status is what tells you whether to look
        // at the repo name or at the token.
        expect(result.errors?.[0]?.message).toContain('404')
      })
    })
  })

  test('a fetch that throws fails without forwarding the message that names the URL', async () => {
    await withHome(async () => {
      const sentinel = 'sentinel-owner/do-not-echo-7c2f10'
      const thrown = new TypeError(`Unable to connect to https://api.github.com/repos/${sentinel}/issues`)
      await withStubbedFetch(thrown, async () => {
        const result = await invoke({ repo: sentinel })

        expect(result.status).toBe('failed')
        expect(result.errors?.[0]?.code).toBe('dependency_unavailable')
        expect(JSON.stringify(result)).not.toContain(sentinel)
        expect(JSON.stringify(result)).not.toContain('api.github.com')
      })
    })
  })

  test('a successful poll reports the count without the repo it counted, and the snapshot omits it too', async () => {
    await withHome(async (home) => {
      const sentinel = 'sentinel-owner/do-not-echo-7c2f10'
      await withStubbedFetch(OK, async () => {
        const result = await invoke({ repo: sentinel })

        // The success arm is the one that leaked, and it leaked on every run —
        // the engine writes this summary to the run log whether or not anything
        // went wrong.
        expect(result.status).toBe('success')
        // JSON.stringify(result) covers the Output body too — a fifth sink,
        // and one the engine copies into last_output on every success.
        expect(JSON.stringify(result)).not.toContain(sentinel)
        expect(result.artifacts_produced).toHaveLength(1)
        expect(result.summary).toMatch(/(\d+) open issues/)
        expect(await readFile(SNAPSHOT(home), 'utf-8')).not.toContain(sentinel)
      })
    })
  })
})
