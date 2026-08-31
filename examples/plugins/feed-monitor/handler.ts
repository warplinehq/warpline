import type { PluginManifest } from 'warpline/schemas/plugin-manifest'
import { makeSkillError, type SkillResult } from 'warpline/schemas/skill-result'

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

export async function handler(
  _manifest: PluginManifest,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<SkillResult> {
  const feedUrl = args.feed_url
  if (typeof feedUrl !== 'string' || !/^https?:\/\//.test(feedUrl)) {
    return {
      status: 'failed',
      phases_completed: [],
      phases_failed: ['feed-monitor'],
      errors: [makeSkillError('parse_error', "input 'feed_url' must be an http(s) URL, e.g. https://example.com/feed.xml", { impact: 'HIGH' })],
      data_freshness: {},
      summary: 'feed-monitor: invalid feed_url input',
      artifacts_produced: [],
      schema_version: 1,
    }
  }

  const res = await fetch(feedUrl, { signal, headers: { 'user-agent': 'warpline-example' } })
  if (!res.ok) {
    return {
      status: 'failed',
      phases_completed: [],
      phases_failed: ['feed-monitor'],
      errors: [makeSkillError('dependency_unavailable', `feed fetch ${res.status}`, { retryable: res.status >= 500 })],
      data_freshness: {},
      summary: `feed-monitor: fetch returned ${res.status}`,
      artifacts_produced: [],
      schema_version: 1,
    }
  }

  const entries = parseFeed(await res.text())
  const since = typeof args.since === 'string' ? args.since : null
  const fresh = newerThan(entries, since)

  return {
    status: 'success',
    phases_completed: ['feed-monitor'],
    phases_failed: [],
    errors: [],
    data_freshness: { feed: new Date().toISOString() },
    summary: fresh.length === 0
      ? `no new entries (${entries.length} total on feed)`
      : `${fresh.length} new entries: ${fresh.slice(0, 3).map(e => e.title).join(' · ')}${fresh.length > 3 ? ' …' : ''}`,
    artifacts_produced: [],
    schema_version: 1,
  }
}
