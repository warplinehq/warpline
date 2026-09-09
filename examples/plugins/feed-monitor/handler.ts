import { join } from 'node:path'
import { warplineHome } from 'warpline/lib/paths'
import type { CapabilityHandlerFn } from 'warpline/unstable-capabilities'
import { atomicWriteJson } from 'warpline/unstable-fs'
import { skillFailure, skillOk } from 'warpline/unstable-result'

/**
 * Input: `feed_url` (required) and `since` (optional), both operator-configured
 * in `<home>/config/feed-monitor.json`.
 *
 * Written after a successful poll, `<home>/state/feed-monitor.entries.json`,
 * and named by the `path` Output this handler returns:
 * {
 *   "fetched_at": "2026-08-20T09:00:00.000Z",
 *   "new_entries": [
 *     { "title": "An article", "link": "https://example.com/a", "published": "2026-08-20T09:00:00Z" }
 *   ]
 * }
 *
 * The path is derived from `warplineHome()` and the manifest's own name and
 * from nothing else. A configured feed URL can carry a token, so it reaches
 * the single arm that validates it and never a path or a summary.
 */
export interface FeedEntry {
  title: string
  link: string
  published: string | null
}

/**
 * Minimal RSS 2.0 + Atom entry extraction. Deliberately not a full XML
 * parser: feeds are fetched from a URL the OPERATOR configured (not from
 * observed content), and the extracted fields are treated as data. A host
 * needing full spec coverage should swap in a real parser.
 */
export function parseFeed(xml: string): FeedEntry[] {
  const entries: FeedEntry[] = []
  const items = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/g) ?? []
  for (const item of items) {
    const title = extract(item, 'title')
    // Atom links live in an href attribute; RSS links are element text.
    const link = item.match(/<link[^>]*href="([^"]+)"/)?.[1] ?? extract(item, 'link')
    const published = extract(item, 'pubDate') ?? extract(item, 'published') ?? extract(item, 'updated')
    if (title && link) entries.push({ title, link, published })
  }
  return entries
}

function extract(block: string, tag: string): string | null {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))
  if (!m) return null
  return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, '$1').trim() || null
}

export function newerThan(entries: FeedEntry[], since: string | null): FeedEntry[] {
  if (!since) return entries
  const cutoff = new Date(since).getTime()
  if (Number.isNaN(cutoff)) return entries
  return entries.filter(e => {
    if (!e.published) return true // undated entries always surface
    const t = new Date(e.published).getTime()
    return Number.isNaN(t) ? true : t > cutoff
  })
}

export const handler: CapabilityHandlerFn = async (manifest, args, signal, _capabilities) => {
  const feedUrl = args.feed_url
  // Names the key and the shape expected of it, never the value it was handed:
  // this message lands in a run log, and a feed URL can carry a token.
  if (typeof feedUrl !== 'string' || !/^https?:\/\//.test(feedUrl)) {
    return skillFailure(
      'parse_error',
      "input 'feed_url' must be an http(s) URL, e.g. https://example.com/feed.xml",
      { phases_failed: [manifest.name], impact: 'HIGH' },
    )
  }

  // Forward the runtime's AbortSignal so the per-attempt timeout can cancel
  // the request instead of orphaning it.
  let res: Response
  try {
    res = await fetch(feedUrl, { signal, headers: { 'user-agent': 'warpline-example' } })
  } catch (err) {
    // An abort is the runtime's own timeout or cancellation, and it classifies
    // the run by the signal, so the rejection goes back to it untouched. Any
    // other fetch error's message embeds the request URL, which is the
    // configured value, so the message is dropped rather than forwarded.
    if (signal.aborted) throw err
    return skillFailure(
      'dependency_unavailable',
      `${manifest.name}: fetch of the configured feed_url failed`,
      { phases_failed: [manifest.name] },
    )
  }
  if (!res.ok) {
    return skillFailure(
      'dependency_unavailable',
      `feed fetch ${res.status}`,
      { phases_failed: [manifest.name], retryable: res.status >= 500 },
    )
  }

  const entries = parseFeed(await res.text())
  const since = typeof args.since === 'string' ? args.since : null
  const fresh = newerThan(entries, since)

  // "Nothing new" is a quiet day, and a quiet day is a success. A bare
  // `skipped` here would be mapped to `failed` by deriveRunStatus and persisted
  // as a red run.
  const summary = fresh.length === 0
    ? `no new entries (${entries.length} total on feed)`
    : `${fresh.length} new entries: ${fresh.slice(0, 3).map(e => e.title).join(' · ')}${fresh.length > 3 ? ' …' : ''}`

  // Both success arms write, the quiet day included: an empty result is an
  // observation, not the absence of one, and a consumer that reads an empty
  // list learns the poll happened. Neither failure arm above reaches here, so
  // a failed poll leaves the previous file exactly as it was.
  const fetchedAt = new Date().toISOString()
  const entriesPath = join(warplineHome(), 'state', `${manifest.name}.entries.json`)
  await atomicWriteJson(entriesPath, { fetched_at: fetchedAt, new_entries: fresh })

  return skillOk(summary, {
    phases_completed: [manifest.name],
    data_freshness: { feed: fetchedAt },
    // A `path` Output, not `body`: the entry list grows with the feed and the
    // body cap is 16 KiB of UTF-8. Never both.
    artifacts_produced: [{ type: 'feed-entries', format: 'json', path: entriesPath }],
  })
}
