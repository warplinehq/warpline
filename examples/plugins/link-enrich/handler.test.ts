import { describe, test, expect } from 'bun:test'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CapabilityContext } from 'warpline/unstable-capabilities'
import { OutputRecordSchema } from 'warpline/schemas/skill-result'
import { handler } from './handler.js'
import { manifest } from './manifest.js'

/** The handler is four-parameter; a test hands it a context it never reads. */
const CONTEXT = {} as CapabilityContext

const TOKENS = {
  LINK_ENRICH_METADATA_TOKEN: 'tok-metadata-do-not-echo-1a',
  LINK_ENRICH_PREVIEW_TOKEN: 'tok-preview-do-not-echo-2b',
  LINK_ENRICH_REPUTATION_TOKEN: 'tok-reputation-do-not-echo-3c',
}

/**
 * A throwaway home with the three credentials set. `warpline/lib/paths`
 * exports only `warplineHome`, which resolves `WARPLINE_HOME` per call — the
 * seam a plugin author has. `env` overrides let a case unset one credential.
 */
async function withHome<T>(fn: (home: string) => Promise<T>, env: Record<string, string | undefined> = TOKENS): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'link-enrich-'))
  const saved: Record<string, string | undefined> = { WARPLINE_HOME: process.env.WARPLINE_HOME }
  for (const name of Object.keys(TOKENS)) saved[name] = process.env[name]
  process.env.WARPLINE_HOME = home
  for (const name of Object.keys(TOKENS)) {
    const value = env[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  try {
    return await fn(home)
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await rm(home, { recursive: true, force: true })
  }
}

type Call = { url: string; init: RequestInit }

/**
 * A fetch stub answering per source URL. `answers` maps a URL to a response
 * factory or an Error to throw; anything unmapped is a 200 with an empty
 * record. Every call is recorded so a case can assert on headers and signal.
 */
function fakeFetch(answers: Record<string, (() => unknown) | Error> = {}) {
  const calls: Call[] = []
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    const answer = answers[String(url)]
    if (answer instanceof Error) throw answer
    if (answer) return answer()
    return { ok: true, status: 200, json: async () => ({}) }
  }) as unknown as typeof fetch
  return { impl, calls }
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

const URLS = {
  metadata_url: 'https://metadata.example.com/lookup',
  preview_url: 'https://preview.example.com/lookup',
  reputation_url: 'https://reputation.example.com/lookup',
}
const LINKS = ['https://links.example.com/one', 'https://links.example.com/two']

const okJson = (body: unknown) => () => ({ ok: true, status: 200, json: async () => body })
const status = (code: number) => () => ({ ok: false, status: code, json: async () => ({}) })

/** Each source answers with one field per link. */
const perLink = (field: string, value: unknown) =>
  okJson(Object.fromEntries(LINKS.map((link) => [link, { [field]: value }])))

const ALL_OK = {
  [URLS.metadata_url]: perLink('title', 'A page'),
  [URLS.preview_url]: perLink('preview', 'https://preview.example.com/img.png'),
  [URLS.reputation_url]: perLink('verdict', 'clean'),
}

async function seedLinks(home: string, links: unknown = LINKS): Promise<void> {
  await mkdir(join(home, 'state'), { recursive: true })
  await writeFile(join(home, 'state', 'links.json'), JSON.stringify({ links }))
}

function invoke(args: Record<string, unknown> = URLS, signal = new AbortController().signal) {
  return handler(manifest, args, signal, CONTEXT)
}

const ENRICHED = (home: string) => join(home, 'state', 'link-enrich.enriched.json')

async function readEnriched(home: string): Promise<{ merged: Record<string, Record<string, unknown>>; sources: { contributed: string[]; refused: { source: string; reason: string }[] } }> {
  return JSON.parse(await readFile(ENRICHED(home), 'utf-8'))
}

describe('link-enrich fans several sources into one record', () => {
  test('three sources, all reachable: the result names all three and merges their contributions per link', async () => {
    await withHome(async (home) => {
      await seedLinks(home)
      const { impl, calls } = fakeFetch(ALL_OK)
      const result = await withFetch(impl, () => invoke())

      expect(result.status).toBe('success')
      expect(result.summary).toContain('3 of 3 sources')
      for (const name of ['metadata', 'preview', 'reputation']) expect(result.summary).toContain(name)
      expect(calls).toHaveLength(3)

      const { merged, sources } = await readEnriched(home)
      expect(sources.contributed.sort()).toEqual(['metadata', 'preview', 'reputation'])
      expect(sources.refused).toEqual([])
      for (const link of LINKS) {
        expect(merged[link]).toEqual({
          metadata: { title: 'A page' },
          preview: { preview: 'https://preview.example.com/img.png' },
          reputation: { verdict: 'clean' },
        })
      }
      const output = OutputRecordSchema.parse(result.artifacts_produced?.at(-1))
      expect(output.path).toBe(ENRICHED(home))
    })
  })

  test('one source failing: a non-failure run, the other contributions present, the refused source named with its reason', async () => {
    await withHome(async (home) => {
      await seedLinks(home)
      const { impl } = fakeFetch({ ...ALL_OK, [URLS.reputation_url]: status(503) })
      const result = await withFetch(impl, () => invoke())

      // The act. A loop with a shared failure path would have failed here.
      expect(result.status).not.toBe('failed')
      expect(result.status).toBe('partial')
      expect(result.summary).toContain('2 of 3 sources')
      expect(result.summary).toMatch(/refused 1 \(reputation: HTTP 503\)/)

      const { merged, sources } = await readEnriched(home)
      expect(sources.contributed.sort()).toEqual(['metadata', 'preview'])
      expect(sources.refused).toEqual([{ source: 'reputation', reason: 'HTTP 503' }])
      expect(merged[LINKS[0]!]).toEqual({ metadata: { title: 'A page' }, preview: { preview: 'https://preview.example.com/img.png' } })
    })
  })

  test('every source failing: a failure, not a success with an empty merge', async () => {
    await withHome(async (home) => {
      await seedLinks(home)
      const { impl } = fakeFetch({
        [URLS.metadata_url]: status(500),
        [URLS.preview_url]: new TypeError('Unable to connect'),
        [URLS.reputation_url]: status(401),
      })
      const result = await withFetch(impl, () => invoke())

      expect(result.status).toBe('failed')
      expect(result.errors?.[0]?.code).toBe('dependency_unavailable')
      expect(result.summary).toContain('every source refused')
      expect(result.summary).toContain('metadata: HTTP 500')
      expect(result.summary).toContain('preview: request failed')
      expect(result.summary).toContain('reputation: HTTP 401')
      expect(result.artifacts_produced ?? []).toHaveLength(0)
      // Nothing merged, nothing written: the home still holds only the seed.
      expect(await readdir(join(home, 'state'))).toEqual(['links.json'])
    })
  })

  test('every outbound call receives the runtime-supplied signal, and aborting rejects the run', async () => {
    await withHome(async (home) => {
      await seedLinks(home)
      const controller = new AbortController()
      const { impl, calls } = fakeFetch(ALL_OK)
      await withFetch(impl, () => invoke(URLS, controller.signal))
      expect(calls).toHaveLength(3)
      for (const call of calls) expect(call.init.signal).toBe(controller.signal)

      // An abort mid-flight: the stub rejects the way fetch does, and the
      // handler hands the rejection back to the runtime, which classifies
      // cancel and timeout by the signal.
      const aborting = new AbortController()
      const rejecting = (async (_url: unknown, init?: RequestInit) => {
        aborting.abort()
        throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError', signal: init?.signal })
      }) as unknown as typeof fetch
      await expect(withFetch(rejecting, () => invoke(URLS, aborting.signal))).rejects.toThrow()
    })
  })

  test('a __proto__ key from a source response becomes an own property of the merged record, never its prototype', async () => {
    await withHome(async (home) => {
      await seedLinks(home)
      const { impl } = fakeFetch({
        ...ALL_OK,
        [URLS.metadata_url]: okJson(JSON.parse('{"__proto__": {"polluted": true}, "https://links.example.com/one": {"title": "A page"}}')),
      })
      const result = await withFetch(impl, () => invoke())

      expect(result.status).toBe('success')
      expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false)
      expect(({} as Record<string, unknown>).polluted).toBeUndefined()
      const raw = await readFile(ENRICHED(home), 'utf-8')
      const merged = JSON.parse(raw).merged as Record<string, unknown>
      expect(Object.hasOwn(merged, '__proto__')).toBe(true)
    })
  })

  test('no links file is a prefixed skip on the success arm, never a bare skipped, with nothing fetched', async () => {
    await withHome(async () => {
      const { impl, calls } = fakeFetch(ALL_OK)
      const result = await withFetch(impl, () => invoke())

      expect(result.status).not.toBe('skipped')
      expect(result.status).toBe('success')
      expect(result.summary.startsWith(`${manifest.name}:`)).toBe(true)
      expect(result.summary).toContain('nothing to enrich')
      expect(calls).toHaveLength(0)
    })
  })
})

/**
 * A credential value goes into the authorization header and nowhere else.
 * Presence at the sink is asserted FIRST, then absence everywhere else:
 * absence alone is green when the value never resolved at all.
 */
describe('link-enrich credentials', () => {
  test('each token reaches its own source\'s authorization header, and no token reaches the result or the written file', async () => {
    await withHome(async (home) => {
      await seedLinks(home)
      const { impl, calls } = fakeFetch(ALL_OK)
      const result = await withFetch(impl, () => invoke())

      const headerFor = (url: string) => (calls.find((c) => c.url === url)?.init.headers as Record<string, string>)['authorization']
      expect(headerFor(URLS.metadata_url)).toBe(`Bearer ${TOKENS.LINK_ENRICH_METADATA_TOKEN}`)
      expect(headerFor(URLS.preview_url)).toBe(`Bearer ${TOKENS.LINK_ENRICH_PREVIEW_TOKEN}`)
      expect(headerFor(URLS.reputation_url)).toBe(`Bearer ${TOKENS.LINK_ENRICH_REPUTATION_TOKEN}`)

      const serialised = JSON.stringify(result)
      const written = await readFile(ENRICHED(home), 'utf-8')
      for (const token of Object.values(TOKENS)) {
        expect(serialised).not.toContain(token)
        expect(written).not.toContain(token)
      }
      expect(serialised).not.toContain('Bearer')
    })
  })

  test('a missing credential disables that source and is reported by name; the others still run', async () => {
    await withHome(async (home) => {
      await seedLinks(home)
      const { impl, calls } = fakeFetch(ALL_OK)
      const result = await withFetch(impl, () => invoke())

      expect(result.status).toBe('partial')
      expect(calls.map((c) => c.url).sort()).toEqual([URLS.metadata_url, URLS.reputation_url])
      expect(result.summary).toMatch(/refused 1 \(preview: LINK_ENRICH_PREVIEW_TOKEN is not set\)/)
      const { sources } = await readEnriched(home)
      expect(sources.contributed.sort()).toEqual(['metadata', 'reputation'])
    }, { ...TOKENS, LINK_ENRICH_PREVIEW_TOKEN: undefined })
  })
})

/**
 * Every endpoint URL arrives from `<home>/config/link-enrich.json` and every
 * summary lands in the run log, so no arm names the value it was handed.
 */
describe('link-enrich config value disclosure', () => {
  const SENTINEL = 'https://do-not-echo-9e8d7c.example.com/lookup'

  test('a configured endpoint never reaches the result, whether it refused, threw or answered', async () => {
    await withHome(async (home) => {
      await seedLinks(home)
      const { impl } = fakeFetch({
        [SENTINEL]: status(404),
        [URLS.preview_url]: new TypeError(`Unable to connect to ${SENTINEL}`),
      })
      const result = await withFetch(impl, () => invoke({ ...URLS, metadata_url: SENTINEL }))

      expect(JSON.stringify(result)).not.toContain('do-not-echo')
      expect(await readFile(ENRICHED(home), 'utf-8')).not.toContain('do-not-echo')
      expect(result.summary).toContain('metadata: HTTP 404')
      expect(result.summary).toContain('preview: request failed')
    })
  })
})
