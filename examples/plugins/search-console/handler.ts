import type { PluginManifest } from 'warpline/schemas/plugin-manifest'
import { OUTPUT_BODY_CAP_BYTES } from 'warpline/schemas/skill-result'
import type { CapabilityHandlerFn } from 'warpline/unstable-capabilities'
import { skillFailure, skillOk } from 'warpline/unstable-result'

/**
 * The request contract. It is this example's own, not a vendor's: point
 * `api_base` at an adapter that speaks it.
 *
 * POST <api_base>/query
 * authorization: Bearer <SEARCH_CONSOLE_TOKEN>
 * { "site_url": "https://...", "start_date": "YYYY-MM-DD", "end_date": "YYYY-MM-DD", "dimension": "query" | "page" }
 *
 * Both dates are inclusive UTC dates. The answer:
 * { "rows": [{ "key": "...", "clicks": 12, "impressions": 340 }] }
 *
 * Four requests a run, one per week and dimension. The Output body:
 * { "current": { "start", "end" }, "previous": { "start", "end" },
 *   "queries": [Delta], "pages": [Delta] }
 *
 * Nothing is written anywhere. The site and the endpoint are configured
 * values, so neither reaches the result, and the token reaches the
 * authorization header and nothing else.
 */
export interface Window { start: string; end: string }
export interface Row { key: string; clicks: number; impressions: number }
export interface Delta {
  key: string
  clicks: { current: number; previous: number; delta: number }
  impressions: { current: number; previous: number; delta: number }
  new: boolean
}

const DAY_MS = 86_400_000
const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/**
 * This week is the 7 complete UTC days ending yesterday, and last week the 7
 * before those. Pure, so a test can pin the clock. The handler passes
 * `new Date()`.
 */
export function weekWindows(now: Date): { current: Window; previous: Window } {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  return {
    current: { start: isoDate(today - 7 * DAY_MS), end: isoDate(today - DAY_MS) },
    previous: { start: isoDate(today - 14 * DAY_MS), end: isoDate(today - 8 * DAY_MS) },
  }
}

/**
 * The top `topN` keys of this week by clicks, a tie going to the key that
 * sorts first, each with last week's figures beside it. A key with no row
 * last week is `new`, and its last week reads 0.
 */
export function compareWeeks(current: Row[], previous: Row[], topN: number): Delta[] {
  // Null prototype, read with `Object.hasOwn`: a key is untrusted API data,
  // and one named `__proto__` or `constructor` must be a key and nothing else.
  const prevIndex: Record<string, Row> = Object.create(null)
  for (const row of previous) prevIndex[row.key] = row
  // `<` and `>`, not `localeCompare`: the order must not depend on the host locale.
  const ranked = [...current].sort((a, b) =>
    b.clicks - a.clicks || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return ranked.slice(0, topN).map((row) => {
    const isNew = !Object.hasOwn(prevIndex, row.key)
    const before = isNew ? { clicks: 0, impressions: 0 } : prevIndex[row.key]!
    return {
      key: row.key,
      clicks: { current: row.clicks, previous: before.clicks, delta: row.clicks - before.clicks },
      impressions: { current: row.impressions, previous: before.impressions, delta: row.impressions - before.impressions },
      new: isNew,
    }
  })
}

/**
 * A configured value, or the manifest's own default when the caller left it
 * out. The runtime merges defaults before a handler is called; a host that
 * calls the handler directly may not, and the default lives in ONE place.
 */
function configured(manifest: PluginManifest, args: Record<string, unknown>, key: string): unknown {
  return args[key] !== undefined ? args[key] : manifest.inputs[key]?.default
}

function httpBase(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const { protocol } = new URL(value)
    return protocol === 'http:' || protocol === 'https:' ? value.replace(/\/+$/, '') : null
  } catch {
    return null
  }
}

function isRows(value: unknown): value is Row[] {
  return Array.isArray(value) && value.every((r) =>
    r !== null && typeof r === 'object'
    && typeof r.key === 'string'
    && typeof r.clicks === 'number' && Number.isFinite(r.clicks)
    && typeof r.impressions === 'number' && Number.isFinite(r.impressions))
}

export const handler: CapabilityHandlerFn = async (manifest, args, signal, _capabilities) => {
  const FAILED = { phases_failed: [manifest.name], impact: 'HIGH' as const, retryable: false }
  const fail = (code: 'parse_error' | 'auth_failure' | 'dependency_unavailable', message: string) =>
    skillFailure(code, `${manifest.name}: ${message}`, FAILED)

  // No arm below quotes a configured value. Each names the input key and the
  // shape it wanted.
  const base = httpBase(configured(manifest, args, 'api_base'))
  if (base === null) return fail('parse_error', "input 'api_base' must be an http(s) URL")
  const siteUrl = configured(manifest, args, 'site_url')
  if (typeof siteUrl !== 'string' || siteUrl === '') return fail('parse_error', "input 'site_url' must be a non-empty string")
  const topN = configured(manifest, args, 'top_n')
  if (typeof topN !== 'number' || !Number.isInteger(topN) || topN < 1) {
    return fail('parse_error', "input 'top_n' must be a whole number of at least 1")
  }

  // The secret's name comes from the manifest, so a copy that renames it needs
  // no edit here. The runtime refuses an unset one before the handler runs;
  // this arm is for a host that calls the handler directly.
  const secret = manifest.secrets[0]
  const token = secret === undefined ? undefined : process.env[secret]
  if (!token) return fail('auth_failure', `${secret ?? 'the token named on secrets'} is not set`)

  const windows = weekWindows(new Date())

  type Fetched = { ok: true; rows: Row[] } | { ok: false; failure: ReturnType<typeof fail> }
  // Every failure fails the run: a report missing a quarter of its figures is
  // not a report. A reason names the dimension and the week, never the URL,
  // because a fetch error's message embeds the request URL.
  async function rows(dimension: 'query' | 'page', week: 'current' | 'previous'): Promise<Fetched> {
    const what = `the ${dimension} rows of the ${week} week`
    const { start, end } = windows[week]
    let res: Response
    try {
      res = await fetch(`${base}/query`, {
        method: 'POST',
        signal,
        // A redirect would carry the authorization header to wherever it points.
        redirect: 'error',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'user-agent': 'warpline-example',
        },
        body: JSON.stringify({ site_url: siteUrl, start_date: start, end_date: end, dimension }),
      })
    } catch (err) {
      // An abort is the runtime's own timeout or cancellation, and it
      // classifies the run by the signal, so the rejection goes back untouched.
      if (signal.aborted) throw err
      return { ok: false, failure: fail('dependency_unavailable', `request failed for ${what}`) }
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, failure: fail('auth_failure', `${secret} was rejected (HTTP ${res.status})`) }
    }
    if (!res.ok) return { ok: false, failure: fail('dependency_unavailable', `HTTP ${res.status} for ${what}`) }
    let parsed: unknown
    try {
      parsed = await res.json()
    } catch (err) {
      if (signal.aborted) throw err
      parsed = undefined
    }
    const list = parsed !== null && typeof parsed === 'object' ? (parsed as { rows?: unknown }).rows : undefined
    if (!isRows(list)) {
      return { ok: false, failure: fail('parse_error', `${what} are not a list of { key, clicks, impressions }`) }
    }
    return { ok: true, rows: list }
  }

  const fetched: Record<string, Row[]> = {}
  for (const [dimension, week] of [['query', 'current'], ['query', 'previous'], ['page', 'current'], ['page', 'previous']] as const) {
    const got = await rows(dimension, week)
    if (!got.ok) return got.failure
    fetched[`${dimension}/${week}`] = got.rows
  }
  const queries = compareWeeks(fetched['query/current']!, fetched['query/previous']!, topN)
  const pages = compareWeeks(fetched['page/current']!, fetched['page/previous']!, topN)

  // One inline Output, and the body cap is 16 KiB of UTF-8. Checked by name.
  const body = JSON.stringify({ current: windows.current, previous: windows.previous, queries, pages })
  if (Buffer.byteLength(body, 'utf8') > OUTPUT_BODY_CAP_BYTES) {
    return fail('parse_error', `the report exceeds the ${OUTPUT_BODY_CAP_BYTES}-byte Output cap — lower top_n`)
  }
  return skillOk(
    `${manifest.name}: top ${queries.length} queries and ${pages.length} pages, the week ending ${windows.current.end} against the week before`,
    {
      phases_completed: [manifest.name],
      artifacts_produced: [{ type: 'report', format: 'json', body }],
    },
  )
}
