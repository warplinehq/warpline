import { describe, test, expect } from 'bun:test'
import { parseFeed, newerThan } from './handler.js'

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
