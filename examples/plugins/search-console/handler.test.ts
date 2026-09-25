import { describe, test, expect } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CapabilityContext } from 'warpline/unstable-capabilities'
import { OutputRecordSchema } from 'warpline/schemas/skill-result'
import { compareWeeks, handler, weekWindows, type Row } from './handler.js'
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

describe('search-console edges and refusals', () => {
  test('a key absent last week is new with last week read as 0, and a tie on clicks goes to the key that sorts first', () => {
    const deltas = compareWeeks([{ key: 'b', clicks: 5, impressions: 9 }, { key: 'a', clicks: 5, impressions: 1 }], [], 1)
    expect(deltas).toEqual([{ key: 'a', clicks: triple(5, 0), impressions: triple(1, 0), new: true }])
  })

  test('a key named __proto__ is a key like any other', () => {
    const rows = JSON.parse('[{"key":"__proto__","clicks":2,"impressions":3}]') as Row[]
    expect(compareWeeks(rows, rows, 5)).toEqual([{ key: '__proto__', clicks: triple(2, 2), impressions: triple(3, 3), new: false }])
    expect(compareWeeks(rows, [], 5)[0]?.new).toBe(true)
  })

  test('a 401 fails the run as auth_failure naming the secret, stops there, and carries neither the token nor the header', async () => {
    await withHome(async () => {
      const { impl, calls } = fakeFetch((n) => (n === 2 ? status(401) : undefined))
      const result = await withFetch(impl, () => invoke())

      expect(result.status).toBe('failed')
      expect(result.errors?.[0]?.code).toBe('auth_failure')
      expect(result.errors?.[0]?.message).toContain('SEARCH_CONSOLE_TOKEN')
      expect(calls).toHaveLength(2)
      expect((calls[1]!.init.headers as Record<string, string>)['authorization']).toBe(`Bearer ${TOKEN}`)
      const serialised = JSON.stringify(result)
      expect(serialised).not.toContain(TOKEN)
      expect(serialised).not.toContain('Bearer')
      expect(result.artifacts_produced ?? []).toHaveLength(0)
    })
  })

  test('a 403 is an auth_failure too', async () => {
    await withHome(async () => {
      const { impl } = fakeFetch((n) => (n === 1 ? status(403) : undefined))
      const result = await withFetch(impl, () => invoke())
      expect(result.errors?.[0]?.code).toBe('auth_failure')
      expect(result.errors?.[0]?.message).toContain('HTTP 403')
    })
  })

  test('a 500 on one request fails the run, naming the dimension and the week and not the URL', async () => {
    await withHome(async () => {
      const { impl, calls } = fakeFetch((n) => (n === 3 ? status(500) : undefined))
      const result = await withFetch(impl, () => invoke())

      expect(result.status).toBe('failed')
      expect(result.errors?.[0]?.code).toBe('dependency_unavailable')
      expect(result.errors?.[0]?.message).toContain('HTTP 500 for the page rows of the current week')
      expect(calls).toHaveLength(3)
      expect(JSON.stringify(result)).not.toContain('search.example.com')
    })
  })

  test('a fetch that throws fails as request failed, and an abort goes back to the runtime', async () => {
    await withHome(async () => {
      const { impl } = fakeFetch((n) => (n === 4 ? new TypeError('Unable to connect to https://api.search.example.com/v1/query') : undefined))
      const result = await withFetch(impl, () => invoke())
      expect(result.errors?.[0]?.code).toBe('dependency_unavailable')
      expect(result.errors?.[0]?.message).toContain('request failed for the page rows of the previous week')
      expect(JSON.stringify(result)).not.toContain('search.example.com')

      const aborting = new AbortController()
      const rejecting = (async () => {
        aborting.abort()
        throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
      }) as unknown as typeof fetch
      await expect(withFetch(rejecting, () => invoke(ARGS, aborting.signal))).rejects.toThrow()
    })
  })

  for (const [label, value] of [['unset', undefined], ['empty', '']] as const) {
    test(`a token that is ${label} fails as auth_failure naming ${SECRET}, before any request`, async () => {
      await withHome(async () => {
        const { impl, calls } = fakeFetch()
        const result = await withFetch(impl, () => invoke())
        expect(result.status).toBe('failed')
        expect(result.errors?.[0]?.code).toBe('auth_failure')
        expect(result.errors?.[0]?.message).toContain('SEARCH_CONSOLE_TOKEN')
        expect(calls).toHaveLength(0)
      }, { [SECRET]: value })
    })
  }

  test('an input of the wrong shape is refused by key, before any request', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ top_n: 0 }, 'top_n'],
      [{ top_n: 1.5 }, 'top_n'],
      [{ top_n: '3' }, 'top_n'],
      [{ api_base: 'ftp://x' }, 'api_base'],
      [{ api_base: 'not a url' }, 'api_base'],
      [{ site_url: '' }, 'site_url'],
    ]
    await withHome(async () => {
      for (const [override, key] of cases) {
        const { impl, calls } = fakeFetch()
        const result = await withFetch(impl, () => invoke({ ...ARGS, ...override }))
        expect(result.status).toBe('failed')
        expect(result.errors?.[0]?.code).toBe('parse_error')
        expect(result.errors?.[0]?.message).toContain(`'${key}'`)
        expect(calls).toHaveLength(0)
      }
    })
  })

  test('the manifest defaults stand in for inputs the caller left out', async () => {
    await withHome(async () => {
      const { impl, calls } = fakeFetch()
      const result = await withFetch(impl, () => invoke({}))
      expect(result.status).toBe('success')
      expect(calls[0]!.url).toBe('https://search.example.com/v1/query')
      expect(calls[0]!.body.site_url).toBe('https://your-site.example.com/')
      expect(report(result).queries).toHaveLength(4)
    })
  })

  test('rows that are not the contract shape fail as parse_error naming the dimension and the week', async () => {
    const bad = [
      okRows([{ key: 'x', clicks: 'many', impressions: 1 }]),
      okRows([{ key: 'x', clicks: Number.NaN, impressions: 1 }]),
      okRows('rows'),
      { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token') } },
      { ok: true, status: 200, json: async () => null },
    ]
    await withHome(async () => {
      for (const answer of bad) {
        const { impl } = fakeFetch((n) => (n === 2 ? answer : undefined))
        const result = await withFetch(impl, () => invoke())
        expect(result.status).toBe('failed')
        expect(result.errors?.[0]?.code).toBe('parse_error')
        expect(result.errors?.[0]?.message).toContain('the query rows of the previous week')
      }
    })
  })

  test('a report over the Output cap fails by name and points at top_n', async () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `query number ${i} ${'x'.repeat(40)}`, clicks: i, impressions: i }))
    await withHome(async () => {
      const { impl } = fakeFetch((n) => (n <= 2 ? okRows(many(500)) : undefined))
      const result = await withFetch(impl, () => invoke({ ...ARGS, top_n: 500 }))
      expect(result.status).toBe('failed')
      expect(result.errors?.[0]?.code).toBe('parse_error')
      expect(result.errors?.[0]?.message).toContain('Output cap')
      expect(result.errors?.[0]?.message).toContain('top_n')
    })
  })
})

/**
 * The site and the endpoint arrive from `<home>/config/search-console.json`
 * and every result lands in the run log, so no arm names the value it was
 * handed. Checked on the raw handler return: `invokePlugin` scrubs secrets on
 * its way out, so a check through it would pass for the wrong reason.
 */
describe('search-console config value disclosure', () => {
  const SITE = 'https://site-do-not-echo-5b2a.example.com/'
  const BASE = 'https://api-do-not-echo-7c3e.example.com/v1'
  const SENTINEL_ARGS = { site_url: SITE, api_base: BASE, top_n: 7 }

  const arms: [string, (n: number) => Answer | Error | undefined, Record<string, unknown>][] = [
    ['success', () => undefined, SENTINEL_ARGS],
    ['401', (n) => (n === 1 ? status(401) : undefined), SENTINEL_ARGS],
    ['500', (n) => (n === 2 ? status(500) : undefined), SENTINEL_ARGS],
    ['thrown fetch', (n) => (n === 3 ? new TypeError(`Unable to connect to ${BASE}/query`) : undefined), SENTINEL_ARGS],
    ['invalid input', () => undefined, { ...SENTINEL_ARGS, top_n: -1 }],
  ]
  for (const [arm, override, args] of arms) {
    test(`neither the site nor the endpoint reaches the result on the ${arm} arm`, async () => {
      await withHome(async () => {
        const { impl, calls } = fakeFetch(override)
        const result = await withFetch(impl, () => invoke(args))
        if (arm === 'success') {
          // Presence at the sink first: the values did reach the request.
          expect(result.status).toBe('success')
          expect(calls[0]!.url).toBe(`${BASE}/query`)
          expect(calls[0]!.body.site_url).toBe(SITE)
        } else {
          expect(result.status).toBe('failed')
        }
        expect(JSON.stringify(result)).not.toContain('do-not-echo')
        expect(result.summary).not.toContain('7 queries')
        expect(JSON.stringify(result)).not.toContain(TOKEN)
      })
    })
  }
})
