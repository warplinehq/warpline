import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SkillResultSchema } from 'warpline/schemas/skill-result'
import type { CapabilityContext } from 'warpline/unstable-capabilities'
import { parseFeed, newerThan, handler } from './handler.js'
import { manifest } from './manifest.js'

const RSS = `<rss><channel>
<item><title>First</title><link>https://x.test/1</link><pubDate>Tue, 18 Aug 2026 10:00:00 GMT</pubDate></item>
<item><title><![CDATA[Second & more]]></title><link>https://x.test/2</link></item>
</channel></rss>`

const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom">
<entry><title>A1</title><link href="https://y.test/a1"/><updated>2026-08-19T06:00:00Z</updated></entry>
</feed>`

describe('feed-monitor parseFeed', () => {
  test('parses RSS items incl. CDATA titles and missing dates', () => {
    const out = parseFeed(RSS)
    expect(out).toEqual([
      { title: 'First', link: 'https://x.test/1', published: 'Tue, 18 Aug 2026 10:00:00 GMT' },
      { title: 'Second & more', link: 'https://x.test/2', published: null },
    ])
  })

  test('parses Atom entries with href links', () => {
    expect(parseFeed(ATOM)).toEqual([
      { title: 'A1', link: 'https://y.test/a1', published: '2026-08-19T06:00:00Z' },
    ])
  })
})

describe('feed-monitor newerThan', () => {
  const entries = parseFeed(RSS)
  test('filters by cutoff; undated entries always surface', () => {
    const out = newerThan(entries, '2026-08-18T12:00:00Z')
    expect(out.map(e => e.title)).toEqual(['Second & more'])
  })
  test('null or invalid since returns everything', () => {
    expect(newerThan(entries, null).length).toBe(2)
    expect(newerThan(entries, 'not-a-date').length).toBe(2)
  })
})

/** The handler is four-parameter; a test hands it a context it never reads. */
const CONTEXT = {} as CapabilityContext

function invoke(args: Record<string, unknown>, signal = new AbortController().signal) {
  return handler(manifest, args, signal, CONTEXT)
}

// CLAUDE.md rule 2: every fixture lives under tmpdir() and is removed after.
// One tracking hook rather than a per-call `finally`, so the creation-site
// census in src/__tests__/example-test-hygiene.test.ts stays balanced.
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(r => rm(r, { recursive: true, force: true })))
})

/**
 * `warpline/lib/paths` exports only `warplineHome`, which resolves
 * `WARPLINE_HOME` per call — the same seam a plugin author has. Every success
 * arm now writes its entries under the home, so every case that reaches one
 * gets its own; the preload's shared home would let one case read what another
 * wrote.
 */
async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'warpline-feed-monitor-home-'))
  roots.push(home)
  const realHome = process.env.WARPLINE_HOME
  process.env.WARPLINE_HOME = home
  try {
    return await fn(home)
  } finally {
    if (realHome === undefined) delete process.env.WARPLINE_HOME
    else process.env.WARPLINE_HOME = realHome
  }
}

/** Where a run leaves what it found. Derived exactly as the handler derives it. */
const entriesPath = (home: string) => join(home, 'state', `${manifest.name}.entries.json`)

/**
 * Swap `globalThis.fetch` for `stub`, run `body`, restore the real one whatever
 * happens. A leaked global breaks unrelated tests non-deterministically and
 * nobody attributes that back to the file that did it.
 */
async function withFetch(stub: (input: unknown, init?: RequestInit) => Promise<unknown>, body: () => Promise<void>): Promise<void> {
  const realFetch = globalThis.fetch
  globalThis.fetch = stub as unknown as typeof fetch
  try {
    await body()
  } finally {
    globalThis.fetch = realFetch
  }
}

const FEED_URL = 'https://feeds.example.test/feed.xml'
const okWith = (xml: string) => async () => ({ ok: true, status: 200, text: async () => xml })

describe('feed-monitor builds its result', () => {
  test('a successful fetch is a success built by the result builder, with no schema_version written by the handler', async () => {
    await withHome(() => withFetch(okWith(RSS), async () => {
      const result = await invoke({ feed_url: FEED_URL })

      expect(result.status).toBe('success')
      expect(result.summary).toContain('First')
      // The builder leaves the field to the schema's own default; a handler
      // that restates it is the drift the builder exists to stop.
      expect(result.schema_version).toBeUndefined()
      expect(SkillResultSchema.parse(result).schema_version).toBe(2)
    }))
  })

  test('the signal the runtime passes reaches fetch, and aborting it rejects the call', async () => {
    const controller = new AbortController()
    let received: AbortSignal | null | undefined
    await withFetch(async (_input, init) => {
      received = init?.signal
      return new Promise((_, reject) => {
        const abort = () => reject(new DOMException('The operation was aborted.', 'AbortError'))
        if (init?.signal?.aborted) abort()
        else init?.signal?.addEventListener('abort', abort, { once: true })
      })
    }, async () => {
      const pending = invoke({ feed_url: FEED_URL }, controller.signal)
      controller.abort()
      await expect(pending).rejects.toThrow()
      expect(received).toBe(controller.signal)
    })
  })

  test('no new entries is a success, never a bare skipped', async () => {
    // ATOM, not RSS: an undated entry always surfaces, so only a fully dated
    // feed can be entirely older than `since`.
    await withHome(() => withFetch(okWith(ATOM), async () => {
      const result = await invoke({ feed_url: FEED_URL, since: '2027-01-01T00:00:00Z' })

      // deriveRunStatus maps a prefix-less `skipped` to `failed`, and the
      // engine persists the artifact: "nothing new yet" as a skip would paint
      // a red run on every quiet day.
      expect(result.status).toBe('success')
      expect(result.summary).toContain('no new entries')
    }))
  })
})

/**
 * The producer half of the dependency edge. A run writes what it found under
 * the home and returns a `path` Output naming that file, which is what the
 * runtime carries forward as `last_output` for a consumer to read.
 */
describe('feed-monitor publishes what it found', () => {
  test('a successful poll writes its entries under the home and returns a path Output naming the file', async () => {
    await withHome(home => withFetch(okWith(RSS), async () => {
      const result = await invoke({ feed_url: FEED_URL })

      const record = (result.artifacts_produced ?? []).at(-1)
      expect(typeof record).toBe('object')
      const output = record as { path?: string; body?: string; format?: string }
      expect(output.format).toBe('json')
      expect(output.body).toBeUndefined()
      expect(output.path).toBe(entriesPath(home))

      expect(existsSync(output.path!)).toBe(true)
      const written = JSON.parse(await readFile(output.path!, 'utf-8')) as { new_entries: unknown }
      // The shape feed-triage's degrader already tolerates: the entries this
      // run reported as new, in the element type its docstring documents.
      expect(written.new_entries).toEqual(parseFeed(RSS))
    }))
  })
})

/**
 * `feed_url` is a declared, required input read from
 * `<home>/config/feed-monitor.json`, and a feed URL can carry a token in a
 * query string. Every `SkillResult` field here lands in a run log, so an arm
 * that quotes the URL it was handed is a disclosure path. The arm names the
 * key and the shape it wanted instead.
 *
 * The four cases below cover the four arms a configured value reaches: the
 * input guard, the non-ok response, a fetch that throws, and the success path.
 * Only a sentinel that is a valid http(s) URL gets past the first one.
 */
describe('feed-monitor config value disclosure', () => {
  const SENTINEL = 'do-not-echo-091a2b'
  const sentinelUrl = `https://${SENTINEL}.test/feed.xml`

  test('an invalid feed_url is rejected without the value appearing anywhere in the result', async () => {
    const result = await invoke({ feed_url: SENTINEL })

    expect(result.status).toBe('failed')
    expect(result.errors?.[0]?.code).toBe('parse_error')
    expect(JSON.stringify(result)).not.toContain(SENTINEL)
    expect(result.errors?.[0]?.message).toContain('feed_url')
    expect(result.errors?.[0]?.message).toContain('http(s)')
  })

  test('a non-ok response names the status, not the feed it was configured with', async () => {
    await withFetch(async () => ({ ok: false, status: 500 }), async () => {
      const result = await invoke({ feed_url: sentinelUrl })

      expect(result.status).toBe('failed')
      expect(result.errors?.[0]?.code).toBe('dependency_unavailable')
      expect(JSON.stringify(result)).not.toContain(SENTINEL)
      expect(result.errors?.[0]?.message).toContain('500')
    })
  })

  test('a fetch that throws fails without forwarding the message that names the URL', async () => {
    await withFetch(async (input) => { throw new TypeError(`Unable to connect to ${String(input)}`) }, async () => {
      const result = await invoke({ feed_url: sentinelUrl })

      expect(result.status).toBe('failed')
      expect(result.errors?.[0]?.code).toBe('dependency_unavailable')
      expect(JSON.stringify(result)).not.toContain(SENTINEL)
    })
  })

  test('a successful poll reports the entries without the feed it read them from', async () => {
    await withHome(home => withFetch(okWith(RSS), async () => {
      const result = await invoke({ feed_url: sentinelUrl })

      expect(result.status).toBe('success')
      expect(JSON.stringify(result)).not.toContain(SENTINEL)
      expect(result.summary).toContain('First')
      // The written path is derived from the home and the manifest name, so
      // the configured URL cannot reach it either.
      expect(JSON.stringify(result.artifacts_produced ?? [])).not.toContain(SENTINEL)
      expect(existsSync(entriesPath(home))).toBe(true)
    }))
  })
})
