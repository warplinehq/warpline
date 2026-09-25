import { describe, test, expect } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CapabilityContext } from 'warpline/unstable-capabilities'
import { OutputRecordSchema } from 'warpline/schemas/skill-result'
import { handler, weekWindows, type Row } from './handler.js'
import { manifest } from './manifest.js'

/** The handler is four-parameter; a test hands it a context it never reads. */
const CONTEXT = {} as CapabilityContext

const SECRET = 'SEARCH_CONSOLE_TOKEN'
const TOKEN = 'search-console-test-token-4f1c'

/**
 * A throwaway home with the credential set. `env` overrides let a case unset
 * the credential or set it empty. Both are restored whatever the case does.
 */
async function withHome<T>(fn: (home: string) => Promise<T>, env: Record<string, string | undefined> = { [SECRET]: TOKEN }): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'search-console-'))
  const saved = { WARPLINE_HOME: process.env.WARPLINE_HOME, [SECRET]: process.env[SECRET] }
  process.env.WARPLINE_HOME = home
  const value = env[SECRET]
  if (value === undefined) delete process.env[SECRET]
  else process.env[SECRET] = value
  try {
    return await fn(home)
  } finally {
    for (const [name, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[name]
      else process.env[name] = v
    }
    await rm(home, { recursive: true, force: true })
  }
}

async function withFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch
  globalThis.fetch = impl
  try {
    return await fn()
  } finally {
    globalThis.fetch = real
  }
}

type Call = { url: string; init: RequestInit; body: { site_url: string; start_date: string; end_date: string; dimension: string } }
type Answer = { ok: boolean; status: number; json: () => Promise<unknown> }

const okRows = (rows: unknown): Answer => ({ ok: true, status: 200, json: async () => ({ rows }) })
const status = (code: number): Answer => ({ ok: false, status: code, json: async () => ({}) })

/**
 * The fixture: this week and last week, for each dimension. Four queries this
 * week, one of them absent last week and two tied on clicks, and one query
 * last week that is gone this week. Three pages, two tied on clicks.
 */
const ROWS: Record<string, { current: Row[]; previous: Row[] }> = {
  query: {
    current: [
      { key: 'widget price', clicks: 25, impressions: 300 },
      { key: 'widget history', clicks: 3, impressions: 90 },
      { key: 'buy widgets', clicks: 25, impressions: 250 },
      { key: 'widget repair', clicks: 40, impressions: 500 },
    ],
    previous: [
      { key: 'widget price', clicks: 30, impressions: 280 },
      { key: 'buy widgets', clicks: 10, impressions: 200 },
      { key: 'widget history', clicks: 5, impressions: 100 },
      { key: 'gone query', clicks: 50, impressions: 600 },
    ],
  },
  page: {
    current: [
      { key: '/blog/a', clicks: 12, impressions: 300 },
      { key: '/pricing', clicks: 60, impressions: 900 },
      { key: '/', clicks: 12, impressions: 1000 },
    ],
    previous: [
      { key: '/pricing', clicks: 45, impressions: 1000 },
      { key: '/', clicks: 20, impressions: 800 },
      { key: '/blog/a', clicks: 12, impressions: 250 },
    ],
  },
}

/**
 * A fetch stub routed on the request body: the dimension, and whether the
 * start date is this week's or last week's. `override(n)` replaces the answer
 * to the n-th request (1-based) with a response or an Error to throw.
 */
function fakeFetch(override: (n: number) => Answer | Error | undefined = () => undefined) {
  const windows = weekWindows(new Date())
  const calls: Call[] = []
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Call['body']
    calls.push({ url: String(url), init: init ?? {}, body })
    const replaced = override(calls.length)
    if (replaced instanceof Error) throw replaced
    if (replaced) return replaced
    const week = body.start_date === windows.current.start ? 'current'
      : body.start_date === windows.previous.start ? 'previous'
      : undefined
    const set = ROWS[body.dimension]
    if (!week || !set) return status(400)
    return okRows(set[week])
  }) as unknown as typeof fetch
  return { impl, calls, windows }
}

const ARGS = { site_url: 'https://www.site.example.com/', api_base: 'https://api.search.example.com/v1/', top_n: 3 }

function invoke(args: Record<string, unknown> = ARGS, signal = new AbortController().signal) {
  return handler(manifest, args, signal, CONTEXT)
}

function report(result: Awaited<ReturnType<typeof invoke>>) {
  const output = OutputRecordSchema.parse(result.artifacts_produced?.at(-1))
  return JSON.parse(String(output.body))
}

const triple = (current: number, previous: number) => ({ current, previous, delta: current - previous })

describe('search-console', () => {
  test('the week windows are the 7 UTC days ending yesterday and the 7 before, at any hour of the day', () => {
    const expected = { current: { start: '2026-09-18', end: '2026-09-24' }, previous: { start: '2026-09-11', end: '2026-09-17' } }
    expect(weekWindows(new Date('2026-09-25T10:00:00Z'))).toEqual(expected)
    expect(weekWindows(new Date('2026-09-25T00:00:00Z'))).toEqual(expected)
    expect(weekWindows(new Date('2026-09-25T23:59:59.999Z'))).toEqual(expected)
  })

  test('a two-week fixture becomes exact per-key deltas for the top queries and pages, ranked by clicks then key', async () => {
    await withHome(async () => {
      const { impl, calls, windows } = fakeFetch()
      const result = await withFetch(impl, () => invoke())

      expect(result.status).toBe('success')
      expect(result.summary).toBe(`search-console: top 3 queries and 3 pages, the week ending ${windows.current.end} against the week before`)
      const body = report(result)
      expect(body.current).toEqual(windows.current)
      expect(body.previous).toEqual(windows.previous)
      expect(body.queries).toEqual([
        { key: 'widget repair', clicks: triple(40, 0), impressions: triple(500, 0), new: true },
        { key: 'buy widgets', clicks: triple(25, 10), impressions: triple(250, 200), new: false },
        { key: 'widget price', clicks: triple(25, 30), impressions: triple(300, 280), new: false },
      ])
      expect(body.pages).toEqual([
        { key: '/pricing', clicks: triple(60, 45), impressions: triple(900, 1000), new: false },
        { key: '/', clicks: triple(12, 20), impressions: triple(1000, 800), new: false },
        { key: '/blog/a', clicks: triple(12, 12), impressions: triple(300, 250), new: false },
      ])

      // One request per week and dimension, in order, each to the one endpoint.
      expect(calls.map((c) => [c.body.dimension, c.body.start_date, c.body.end_date])).toEqual([
        ['query', windows.current.start, windows.current.end],
        ['query', windows.previous.start, windows.previous.end],
        ['page', windows.current.start, windows.current.end],
        ['page', windows.previous.start, windows.previous.end],
      ])
      for (const call of calls) {
        expect(call.url).toBe('https://api.search.example.com/v1/query')
        expect(call.init.method).toBe('POST')
        expect(call.init.redirect).toBe('error')
        expect(call.body.site_url).toBe(ARGS.site_url)
      }
    })
  })

  test('the token reaches every request as a Bearer header, and nothing in the raw result', async () => {
    await withHome(async () => {
      const { impl, calls } = fakeFetch()
      const result = await withFetch(impl, () => invoke())

      // Presence at the sink first: absence alone is green when the value
      // never resolved at all.
      expect(calls).toHaveLength(4)
      for (const call of calls) {
        expect((call.init.headers as Record<string, string>)['authorization']).toBe(`Bearer ${TOKEN}`)
        expect(JSON.stringify(call.body)).not.toContain(TOKEN)
      }
      const serialised = JSON.stringify(result)
      expect(serialised).not.toContain(TOKEN)
      expect(serialised).not.toContain('Bearer')
    })
  })

  test('a successful run writes nothing under the home', async () => {
    await withHome(async (home) => {
      const before = (await readdir(home, { recursive: true })).sort()
      const { impl } = fakeFetch()
      const result = await withFetch(impl, () => invoke())
      expect(result.status).toBe('success')
      expect((await readdir(home, { recursive: true })).sort()).toEqual(before)
    })
  })
})
