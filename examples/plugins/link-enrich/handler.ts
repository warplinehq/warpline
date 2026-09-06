import { join, resolve } from 'node:path'
import { warplineHome } from 'warpline/lib/paths'
import type { CapabilityHandlerFn } from 'warpline/unstable-capabilities'
import { atomicWriteJson, readJsonOrNull } from 'warpline/unstable-fs'
import { skillFailure, skillOk } from 'warpline/unstable-result'

/**
 * Input, `<home>/state/links.json` by default:
 * { "links": ["https://..."] }
 *
 * Each source takes one POST carrying the whole set and answers with a record
 * keyed by link: { "<link>": { ...fields } }. Written after a run,
 * `<home>/state/link-enrich.enriched.json`:
 * {
 *   "enriched_at": "...",
 *   "sources": { "contributed": ["metadata"], "refused": [{ "source": "reputation", "reason": "HTTP 503" }] },
 *   "merged": { "<link>": { "metadata": { ...fields } } }
 * }
 */
interface Source {
  name: string
  /** The manifest input carrying this source's endpoint. */
  urlKey: string
  /** The environment variable, declared on `manifest.secrets`, carrying its credential. */
  secret: string
}

const SOURCES: readonly Source[] = [
  { name: 'metadata', urlKey: 'metadata_url', secret: 'LINK_ENRICH_METADATA_TOKEN' },
  { name: 'preview', urlKey: 'preview_url', secret: 'LINK_ENRICH_PREVIEW_TOKEN' },
  { name: 'reputation', urlKey: 'reputation_url', secret: 'LINK_ENRICH_REPUTATION_TOKEN' },
]

type Lookup =
  | { name: string; outcome: 'contributed'; entries: Record<string, unknown> }
  | { name: string; outcome: 'refused'; reason: string }

/**
 * One source, start to finish, and nothing here throws past the abort case.
 * Every refusal is a reason in shape terms — a status, "request failed", a
 * credential NAME — never the endpoint and never a credential value, because
 * the reason lands in the summary and the summary lands in the run log.
 */
async function lookup(source: Source, url: unknown, links: string[], signal: AbortSignal): Promise<Lookup> {
  const refused = (reason: string): Lookup => ({ name: source.name, outcome: 'refused', reason })
  if (typeof url !== 'string') return refused(`input '${source.urlKey}' is not a string`)
  // The credential goes into the authorization header and nowhere else. A
  // source with no credential is disabled, not fatal: the others still run.
  const token = process.env[source.secret]
  if (!token) return refused(`${source.secret} is not set`)

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      signal,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'user-agent': 'warpline-example',
      },
      body: JSON.stringify({ links }),
    })
  } catch (err) {
    // An abort is the runtime's own timeout or cancellation; it is rethrown
    // so the runtime classifies the run by the signal. Any other fetch error's
    // message embeds the request URL — the configured value — so it is dropped.
    if (signal.aborted) throw err
    return refused('request failed')
  }
  if (!res.ok) return refused(`HTTP ${res.status}`)
  let entries: unknown
  try {
    entries = await res.json()
  } catch {
    return refused('response was not JSON')
  }
  if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) return refused('response was not a record')
  return { name: source.name, outcome: 'contributed', entries: entries as Record<string, unknown> }
}

export const handler: CapabilityHandlerFn = async (manifest, args, signal, _capabilities) => {
  const home = warplineHome()
  const linksPath = resolve(home, typeof args.links_path === 'string' ? args.links_path : 'state/links.json')

  // `links_path` is operator-configured and this result lands in the run
  // log, so neither arm names it. ENOENT is "nothing to enrich yet".
  let raw: { links?: unknown } | null
  try {
    raw = await readJsonOrNull<{ links?: unknown }>(linksPath)
  } catch {
    return skillFailure('parse_error', `${manifest.name}: the file named by input 'links_path' is unreadable or not JSON`, {
      phases_failed: [manifest.name],
      impact: 'HIGH',
      retryable: false,
    })
  }
  const links = (Array.isArray(raw?.links) ? raw.links : []).filter((l): l is string => typeof l === 'string')
  if (raw === null || links.length === 0) {
    // NOT a bare `skipped`: a prefix-less `skipped` is persisted as `failed`,
    // and "no data yet" must not paint a red run.
    return skillOk(`${manifest.name}: no links at the configured path — nothing to enrich`, {
      phases_completed: [manifest.name],
    })
  }

  // Every source in flight at once, each settling on its own. `allSettled`
  // is what keeps one source's rejection from taking the others down; the
  // per-source catch above is what keeps a rejection from happening at all,
  // and the two together are the isolation this example exists to show.
  const settled = await Promise.allSettled(SOURCES.map((s) => lookup(s, args[s.urlKey], links, signal)))
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error(`${manifest.name}: aborted`)
  }
  const lookups: Lookup[] = settled.map((outcome, i) =>
    outcome.status === 'fulfilled'
      ? outcome.value
      : { name: SOURCES[i]!.name, outcome: 'refused', reason: 'lookup threw' })

  const contributed = lookups.filter((l): l is Extract<Lookup, { outcome: 'contributed' }> => l.outcome === 'contributed')
  const refused = lookups.filter((l): l is Extract<Lookup, { outcome: 'refused' }> => l.outcome === 'refused')
  const refusedList = refused.map((r) => `${r.name}: ${r.reason}`).join('; ')

  // All-failed is a FAILURE. A merge of nothing returned as a success is the
  // silent false-negative: a green run over a day nothing was enriched.
  if (contributed.length === 0) {
    return skillFailure('dependency_unavailable', `${manifest.name}: every source refused (${refusedList})`, {
      phases_failed: [manifest.name],
      impact: 'HIGH',
    })
  }

  // Null prototype throughout: a link is an untrusted key from a source
  // response, and `merged['__proto__'] = ...` on a plain object sets the
  // prototype instead of an own property — and is then never serialised.
  const merged: Record<string, Record<string, unknown>> = Object.create(null)
  for (const source of contributed) {
    for (const [link, fields] of Object.entries(source.entries)) {
      const record = merged[link] ?? (merged[link] = Object.create(null))
      record[source.name] = fields
    }
  }

  const enrichedAt = new Date().toISOString()
  const enrichedPath = join(home, 'state', `${manifest.name}.enriched.json`)
  await atomicWriteJson(enrichedPath, {
    enriched_at: enrichedAt,
    sources: { contributed: contributed.map((c) => c.name), refused: refused.map((r) => ({ source: r.name, reason: r.reason })) },
    merged,
  })

  // The summary names what succeeded and what did not, never all-or-nothing.
  const summary = `${manifest.name}: enriched ${links.length} links from ${contributed.length} of ${SOURCES.length} sources `
    + `(${contributed.map((c) => c.name).join(', ')})`
    + (refused.length > 0 ? `; refused ${refused.length} (${refusedList})` : '')

  const result = skillOk(summary, {
    phases_completed: [manifest.name],
    data_freshness: { enriched: enrichedAt },
    // A `path` Output, not `body`: the merged record grows with the link set
    // and the body cap is 16 KiB of UTF-8. Never both.
    artifacts_produced: [{ type: 'enriched-links', format: 'json', path: enrichedPath }],
  })
  // No builder emits `partial`, and a run that merged some sources and was
  // refused by others is exactly that: the file holds what came back, the
  // summary says what did not. The status is set over the built result.
  return refused.length === 0 ? result : { ...result, status: 'partial' }
}
