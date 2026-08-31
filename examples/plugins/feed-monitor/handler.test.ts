import { describe, test, expect } from 'bun:test'
import type { PluginManifest } from 'warpline/schemas/plugin-manifest'
import { parseFeed, newerThan, handler } from './handler.js'

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

/**
 * `feed_url` is a declared, required input read from
 * `<home>/config/feed-monitor.json`, and a feed URL can carry a token in a
 * query string. Every `SkillResult` field here lands in a run log, so an arm
 * that quotes the URL it was handed is a disclosure path. The arm names the
 * key and the shape it wanted instead.
 *
 * The three cases below cover the three arms a configured value reaches: the
 * input guard, the non-ok response, and the success path. Only a sentinel that
 * is a valid http(s) URL gets past the first one.
 */

/**
 * Swap `globalThis.fetch` for one returning `response`, run `body`, restore the
 * real one whatever happens. A leaked global breaks unrelated tests
 * non-deterministically and nobody attributes that back to the file that did it.
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

describe('feed-monitor config value disclosure', () => {
  const SENTINEL = 'do-not-echo-091a2b'
  const sentinelUrl = `https://${SENTINEL}.test/feed.xml`

  test('an invalid feed_url is rejected without the value appearing anywhere in the result', async () => {
    const result = await handler(
      {} as PluginManifest,
      { feed_url: SENTINEL },
      new AbortController().signal,
    )

    expect(result.status).toBe('failed')
    expect(result.errors[0]?.code).toBe('parse_error')
    expect(JSON.stringify(result)).not.toContain(SENTINEL)
    expect(result.errors[0]?.message).toContain('feed_url')
    expect(result.errors[0]?.message).toContain('http(s)')
  })

  test('a non-ok response names the status, not the feed it was configured with', async () => {
    await withStubbedFetch({ ok: false, status: 500 }, async () => {
      const result = await handler(
        {} as PluginManifest,
        { feed_url: sentinelUrl },
        new AbortController().signal,
      )

      expect(result.status).toBe('failed')
      expect(result.errors[0]?.code).toBe('dependency_unavailable')
      expect(JSON.stringify(result)).not.toContain(SENTINEL)
      expect(result.errors[0]?.message).toContain('500')
    })
  })

  test('a successful poll reports the entries without the feed it read them from', async () => {
    await withStubbedFetch({ ok: true, status: 200, text: async () => RSS }, async () => {
      const result = await handler(
        {} as PluginManifest,
        { feed_url: sentinelUrl },
        new AbortController().signal,
      )

      expect(result.status).toBe('success')
      expect(JSON.stringify(result)).not.toContain(SENTINEL)
      expect(result.summary).toContain('First')
    })
  })
})
