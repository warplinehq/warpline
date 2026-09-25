import { describe, test, expect } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CapabilityContext } from 'warpline/unstable-capabilities'
import { OutputRecordSchema } from 'warpline/schemas/skill-result'
import { handler } from './handler.js'
import { manifest } from './manifest.js'

/** The handler is four-parameter; a test hands it a context it never reads. */
const CONTEXT = {} as CapabilityContext

const SECRET = 'LEDGER_QUOTES_TOKEN'
const TOKEN = 'ledger-runner-test-token-2c7d'
const BASE = 'https://quotes.example.com/v1'
const THREE = ['example-a', 'example-b', 'example-c']
const VALUES: Record<string, number> = { 'example-a': 101.5, 'example-b': 202.25, 'example-c': 303 }

/**
 * A throwaway home with the credential set. `env` overrides let a case unset
 * the credential or set it empty. Both are restored whatever the case does.
 */
async function withHome<T>(fn: (home: string) => Promise<T>, env: Record<string, string | undefined> = { [SECRET]: TOKEN }): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'ledger-runner-'))
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

type Call = { url: string; instrument: string; init: RequestInit }

/**
 * The quote API, routed by the decoded path segment after `/quotes/`.
 * `answers` gives an instrument a status, a raw JSON body, or an Error to
 * throw the way fetch does; anything else answers 200 with its value from
 * VALUES. Every call is recorded in order.
 */
function stubQuotes(answers: Record<string, number | Error | { body: unknown }> = {}, fallback?: number) {
  const calls: Call[] = []
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname
    const instrument = decodeURIComponent(path.slice(path.lastIndexOf('/quotes/') + '/quotes/'.length))
    calls.push({ url: String(url), instrument, init: init ?? {} })
    const answer = Object.hasOwn(answers, instrument) ? answers[instrument]! : fallback
    if (answer instanceof Error) throw answer
    if (typeof answer === 'object') return { ok: true, status: 200, json: async () => answer.body }
    const code = answer ?? 200
    return { ok: code >= 200 && code < 300, status: code, json: async () => ({ value: VALUES[instrument] ?? 1 }) }
  }) as unknown as typeof fetch
  return { impl, calls }
}

function invoke(args: Record<string, unknown> = { instruments: THREE, api_base: BASE }, signal = new AbortController().signal) {
  return handler(manifest, args, signal, CONTEXT)
}

const LEDGER = (home: string, rel = 'state/ledger.json') => join(home, rel)

type Ledger = { values: Record<string, { value: number; as_of: string }> }

async function readLedger(home: string, rel?: string): Promise<Ledger> {
  return JSON.parse(await readFile(LEDGER(home, rel), 'utf-8')) as Ledger
}

type Body = { attempted: number; succeeded: number; failed: number; errors: { position: number; reason: string }[]; errors_omitted: number }

function bodyOf(result: Awaited<ReturnType<typeof invoke>>): Body {
  const output = OutputRecordSchema.parse(result.artifacts_produced?.at(-1))
  expect(output.type).toBe('ledger-run')
  expect(output.format).toBe('json')
  return JSON.parse(String(output.body)) as Body
}

describe('ledger-runner', () => {
  test('three instruments, one answering 500, no ledger yet: the ledger holds the other two and the run succeeds 3/2', async () => {
    await withHome(async (home) => {
      const { impl, calls } = stubQuotes({ 'example-b': 500 })
      const before = Date.now()
      const result = await withFetch(impl, () => invoke())

      expect(result.status).toBe('success')
      expect(calls.map((c) => c.instrument)).toEqual(THREE)
      expect(bodyOf(result)).toEqual({ attempted: 3, succeeded: 2, failed: 1, errors: [{ position: 2, reason: 'HTTP 500' }], errors_omitted: 0 })
      expect(result.summary).toBe('ledger-runner: read 2 of 3 instruments; 1 failed, first at position 2: HTTP 500')
      expect(result.errors).toHaveLength(1)
      expect(result.errors?.[0]?.code).toBe('dependency_unavailable')
      expect(result.errors?.[0]?.message).toBe('instrument at position 2: HTTP 500')

      const { values } = await readLedger(home)
      expect(Object.keys(values).sort()).toEqual(['example-a', 'example-c'])
      for (const name of ['example-a', 'example-c']) {
        expect(values[name]!.value).toBe(VALUES[name]!)
        expect(Date.parse(values[name]!.as_of)).toBeGreaterThanOrEqual(before - 1000)
        expect(Object.keys(values[name]!).sort()).toEqual(['as_of', 'value'])
      }
    })
  })

  test('every request is a GET of <base>/quotes/<instrument>, Bearer-authorised, refusing redirects, in declared order', async () => {
    await withHome(async () => {
      const instruments = [...THREE, 'a b/c?d']
      const { impl, calls } = stubQuotes()
      const result = await withFetch(impl, () => invoke({ instruments, api_base: BASE }))

      expect(result.status).toBe('success')
      expect(calls).toHaveLength(4)
      calls.forEach((call, i) => {
        expect(call.url).toBe(`${BASE}/quotes/${encodeURIComponent(instruments[i]!)}`)
        expect(call.instrument).toBe(instruments[i]!)
        expect(call.init.method ?? 'GET').toBe('GET')
        expect(call.init.redirect).toBe('error')
        const headers = call.init.headers as Record<string, string>
        expect(headers['authorization']).toBe(`Bearer ${TOKEN}`)
      })
    })
  })

  test('the result carries neither the token, nor a Bearer header, nor any instrument name', async () => {
    await withHome(async (home) => {
      const { impl, calls } = stubQuotes({ 'example-b': 500 })
      const result = await withFetch(impl, () => invoke())

      // Presence at the sink first, then absence from the result and the ledger.
      expect((calls[0]!.init.headers as Record<string, string>)['authorization']).toBe(`Bearer ${TOKEN}`)
      const serialised = JSON.stringify(result)
      expect(serialised).not.toContain(TOKEN)
      expect(serialised).not.toContain('Bearer')
      for (const name of THREE) expect(serialised).not.toContain(name)
      expect(await readFile(LEDGER(home), 'utf-8')).not.toContain(TOKEN)
    })
  })
})
