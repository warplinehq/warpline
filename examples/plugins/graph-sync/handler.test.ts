import { describe, test, expect } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CapabilityContext } from 'warpline/unstable-capabilities'
import { OutputRecordSchema } from 'warpline/schemas/skill-result'
import { handler } from './handler.js'
import { manifest } from './manifest.js'

/** The handler is four-parameter; a test hands it a context it never reads. */
const CONTEXT = {} as CapabilityContext

const SECRET = 'GRAPH_SYNC_TOKEN'
const TOKEN = 'graph-sync-test-token-9b2e'
const BASE = 'https://graph.example.com/v1'

/**
 * A throwaway home with the credential set. `env` overrides let a case unset
 * the credential or set it empty. Both are restored whatever the case does.
 */
async function withHome<T>(fn: (home: string) => Promise<T>, env: Record<string, string | undefined> = { [SECRET]: TOKEN }): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'graph-sync-'))
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

type Rec = { id: string; [field: string]: unknown }
type Call = { url: string; id: string; init: RequestInit }

/** Written as raw text so a case can seed a file that is not JSON at all. */
async function seedRaw(home: string, text: string, rel = 'state/records.json'): Promise<void> {
  await mkdir(join(home, rel, '..'), { recursive: true })
  await writeFile(join(home, rel), text)
}

const seedRecords = (home: string, records: unknown, rel?: string) => seedRaw(home, JSON.stringify({ records }), rel)

/**
 * The API: a Map keyed by the decoded id of `PUT <base>/records/<id>`, so an
 * upsert overwrites and a duplicate would show as a second key. `statuses`
 * answers a given id with that status and stores nothing for it. Every call
 * is recorded in order.
 */
function stubApi(statuses: Record<string, number> = {}) {
  const store = new Map<string, unknown>()
  const calls: Call[] = []
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname
    const id = decodeURIComponent(path.slice(path.lastIndexOf('/records/') + '/records/'.length))
    calls.push({ url: String(url), id, init: init ?? {} })
    const code = statuses[id] ?? 200
    if (code >= 200 && code < 300) store.set(id, JSON.parse(String(init?.body)))
    return { ok: code >= 200 && code < 300, status: code, json: async () => ({}) }
  }) as unknown as typeof fetch
  return { impl, calls, store }
}

function invoke(args: Record<string, unknown> = { api_base: BASE }, signal = new AbortController().signal) {
  return handler(manifest, args, signal, CONTEXT)
}

type Body = { attempted: number; succeeded: number; failed: number; errors: { id: string; reason: string }[]; errors_omitted: number }

function bodyOf(result: Awaited<ReturnType<typeof invoke>>): Body {
  const output = OutputRecordSchema.parse(result.artifacts_produced?.at(-1))
  expect(output.type).toBe('sync')
  expect(output.format).toBe('json')
  return JSON.parse(String(output.body)) as Body
}

const THREE: Rec[] = [
  { id: 'r-1', name: 'first', weight: 1 },
  { id: 'r-2', name: 'second', weight: 2 },
  { id: 'r-3', name: 'third', weight: 3 },
]

describe('graph-sync', () => {
  test('two runs over the same records leave the API holding the same three records: an upsert by id, never a duplicate', async () => {
    await withHome(async (home) => {
      await seedRecords(home, THREE)
      const { impl, calls, store } = stubApi()

      const first = await withFetch(impl, () => invoke())
      expect(first.status).toBe('success')
      expect(bodyOf(first)).toEqual({ attempted: 3, succeeded: 3, failed: 0, errors: [], errors_omitted: 0 })
      expect(store.size).toBe(3)
      expect(calls).toHaveLength(3)

      const second = await withFetch(impl, () => invoke())
      expect(second.status).toBe('success')
      expect(bodyOf(second)).toEqual({ attempted: 3, succeeded: 3, failed: 0, errors: [], errors_omitted: 0 })
      // The act: three more calls, and the count did not move.
      expect(calls).toHaveLength(6)
      expect(store.size).toBe(3)
      expect([...store.keys()].sort()).toEqual(['r-1', 'r-2', 'r-3'])
      expect(second.summary).toBe('graph-sync: synced 3 of 3 records')
    })
  })

  test('one record answering 500 fails alone: the run succeeds, the body counts it, and the error names its id', async () => {
    await withHome(async (home) => {
      await seedRecords(home, THREE)
      const { impl, calls, store } = stubApi({ 'r-2': 500 })
      const result = await withFetch(impl, () => invoke())

      expect(result.status).toBe('success')
      expect(calls.map((c) => c.id)).toEqual(['r-1', 'r-2', 'r-3'])
      expect([...store.keys()].sort()).toEqual(['r-1', 'r-3'])
      expect(bodyOf(result)).toEqual({ attempted: 3, succeeded: 2, failed: 1, errors: [{ id: 'r-2', reason: 'HTTP 500' }], errors_omitted: 0 })
      expect(result.errors).toHaveLength(1)
      expect(result.errors?.[0]?.code).toBe('dependency_unavailable')
      expect(result.errors?.[0]?.message).toContain('r-2')
      expect(result.summary).toBe('graph-sync: synced 2 of 3 records; 1 failed, first r-2: HTTP 500')
    })
  })

  test('every request is a PUT of the record to its own id, Bearer-authorised, refusing redirects', async () => {
    await withHome(async (home) => {
      await seedRecords(home, [...THREE, { id: 'a b/c?d', note: 'escaped' }])
      const { impl, calls } = stubApi()
      const result = await withFetch(impl, () => invoke())

      expect(result.status).toBe('success')
      expect(calls).toHaveLength(4)
      const records = [...THREE, { id: 'a b/c?d', note: 'escaped' }]
      calls.forEach((call, i) => {
        const record = records[i]!
        expect(call.url).toBe(`${BASE}/records/${encodeURIComponent(record.id)}`)
        expect(call.id).toBe(record.id)
        expect(call.init.method).toBe('PUT')
        expect(call.init.redirect).toBe('error')
        const headers = call.init.headers as Record<string, string>
        expect(headers['authorization']).toBe(`Bearer ${TOKEN}`)
        expect(headers['content-type']).toBe('application/json')
        expect(JSON.parse(String(call.init.body))).toEqual(record)
      })

      // Presence at the sink first, then absence from the result.
      const serialised = JSON.stringify(result)
      expect(serialised).not.toContain(TOKEN)
      expect(serialised).not.toContain('Bearer')
    })
  })
})
