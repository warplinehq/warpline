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
 * upsert overwrites and a duplicate would show as a second key. `answers`
 * gives a given id a status, stored nothing, or an Error to throw the way
 * fetch does; `fallback` answers every other id. Every call is recorded in order.
 */
function stubApi(answers: Record<string, number | Error> = {}, fallback = 200) {
  const store = new Map<string, unknown>()
  const calls: Call[] = []
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname
    const id = decodeURIComponent(path.slice(path.lastIndexOf('/records/') + '/records/'.length))
    calls.push({ url: String(url), id, init: init ?? {} })
    const answer = Object.hasOwn(answers, id) ? answers[id]! : fallback
    if (answer instanceof Error) throw answer
    const code = answer
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

  test('every record failing is a failure, not a success that synced nothing', async () => {
    await withHome(async (home) => {
      await seedRecords(home, THREE)
      const { impl, calls, store } = stubApi({ 'r-2': new TypeError('Unable to connect') }, 500)
      const result = await withFetch(impl, () => invoke())

      expect(result.status).toBe('failed')
      expect(result.errors).toHaveLength(1)
      expect(result.errors?.[0]?.code).toBe('dependency_unavailable')
      expect(result.summary).toBe('graph-sync: every record failed (3 attempted; first: r-1: HTTP 500)')
      expect(result.artifacts_produced ?? []).toHaveLength(0)
      expect(calls).toHaveLength(3)
      expect(store.size).toBe(0)
    })
  })

  test('a fetch that throws fails its record as "request failed" and the loop goes on', async () => {
    await withHome(async (home) => {
      await seedRecords(home, THREE)
      const { impl, calls } = stubApi({ 'r-1': new TypeError('Unable to connect') })
      const result = await withFetch(impl, () => invoke())

      expect(result.status).toBe('success')
      expect(calls).toHaveLength(3)
      expect(bodyOf(result).errors).toEqual([{ id: 'r-1', reason: 'request failed' }])
    })
  })

  test('a duplicate id is refused before any call, naming the id', async () => {
    await withHome(async (home) => {
      await seedRecords(home, [{ id: 'a', v: 1 }, { id: 'b', v: 2 }, { id: 'a', v: 3 }])
      const { impl, calls } = stubApi()
      const result = await withFetch(impl, () => invoke())

      expect(result.status).toBe('failed')
      expect(result.errors?.[0]?.code).toBe('parse_error')
      expect(result.summary).toContain("record id 'a' appears twice")
      expect(calls).toHaveLength(0)
    })
  })

  test('an id named __proto__ or constructor is an id like any other: synced once, and refused when repeated', async () => {
    await withHome(async (home) => {
      await seedRecords(home, [{ id: '__proto__' }, { id: 'constructor' }, { id: 'toString' }])
      const { impl, calls, store } = stubApi()
      const result = await withFetch(impl, () => invoke())
      expect(result.status).toBe('success')
      expect(calls.map((c) => c.id)).toEqual(['__proto__', 'constructor', 'toString'])
      expect(store.size).toBe(3)

      await seedRecords(home, [{ id: '__proto__' }, { id: '__proto__' }])
      const again = stubApi()
      const refused = await withFetch(again.impl, () => invoke())
      expect(refused.status).toBe('failed')
      expect(refused.summary).toContain("record id '__proto__' appears twice")
      expect(again.calls).toHaveLength(0)
    })
  })

  test('a record with no string id is refused by its position before any call', async () => {
    for (const bad of [{ name: 'no id' }, { id: '' }, { id: 7 }, 'r-9', null, ['r-9']]) {
      await withHome(async (home) => {
        await seedRecords(home, [{ id: 'r-1' }, bad])
        const { impl, calls } = stubApi()
        const result = await withFetch(impl, () => invoke())

        expect(result.status).toBe('failed')
        expect(result.errors?.[0]?.code).toBe('parse_error')
        expect(result.summary).toBe('graph-sync: record 2 in the records file has no string id')
        expect(calls).toHaveLength(0)
      })
    }
  })

  // WR-03. encodeURIComponent leaves `.` alone and the URL parser resolves dot
  // segments, so `..` would PUT this record to `<base>/`, a resource nobody named.
  test('an id of . or .. is refused by its position before any call', async () => {
    for (const id of ['.', '..']) {
      await withHome(async (home) => {
        await seedRecords(home, [{ id: 'r-1' }, { id }])
        const { impl, calls } = stubApi()
        const result = await withFetch(impl, () => invoke())

        expect(result.status).toBe('failed')
        expect(result.errors?.[0]?.code).toBe('parse_error')
        expect(result.summary).toBe('graph-sync: record 2 in the records file has an id that is a path segment')
        expect(calls).toHaveLength(0)
      })
    }
  })

  test('an empty records list is a success counting nothing, with no call', async () => {
    await withHome(async (home) => {
      await seedRecords(home, [])
      const { impl, calls } = stubApi()
      const result = await withFetch(impl, () => invoke())

      expect(result.status).toBe('success')
      expect(result.summary).toBe('graph-sync: synced 0 of 0 records')
      expect(bodyOf(result)).toEqual({ attempted: 0, succeeded: 0, failed: 0, errors: [], errors_omitted: 0 })
      expect(result.errors).toBeUndefined()
      expect(calls).toHaveLength(0)
    })
  })

  test('records are sent in file order and failures are listed in that order', async () => {
    await withHome(async (home) => {
      await seedRecords(home, [{ id: 'r-3' }, { id: 'r-1' }, { id: 'r-2' }])
      const { impl, calls } = stubApi({ 'r-3': 500, 'r-2': 500 })
      const result = await withFetch(impl, () => invoke())

      expect(result.status).toBe('success')
      expect(calls.map((c) => c.id)).toEqual(['r-3', 'r-1', 'r-2'])
      const body = bodyOf(result)
      expect(body.errors.map((e) => e.id)).toEqual(['r-3', 'r-2'])
      expect(result.errors?.map((e) => e.message)).toEqual(['record r-3: HTTP 500', 'record r-2: HTTP 500'])
      expect(result.summary).toContain('first r-3: HTTP 500')
    })
  })

  test('failures past fifty are counted, not listed, and an overflowing list goes while the counts stay exact', async () => {
    await withHome(async (home) => {
      const short = [{ id: 'ok' }, ...Array.from({ length: 60 }, (_, i) => ({ id: `f-${i}` }))]
      await seedRecords(home, short)
      const capped = await withFetch(stubApi({ ok: 200 }, 500).impl, () => invoke())
      const body = bodyOf(capped)
      expect(capped.status).toBe('success')
      expect(body).toMatchObject({ attempted: 61, succeeded: 1, failed: 60, errors_omitted: 10 })
      expect(body.errors).toHaveLength(50)
      expect(body.errors[49]?.id).toBe('f-49')
      expect(capped.errors).toHaveLength(50)

      const long = [{ id: 'ok' }, ...Array.from({ length: 60 }, (_, i) => ({ id: `f-${i}-${'x'.repeat(400)}` }))]
      await seedRecords(home, long)
      const emptied = await withFetch(stubApi({ ok: 200 }, 500).impl, () => invoke())
      expect(emptied.status).toBe('success')
      expect(bodyOf(emptied)).toEqual({ attempted: 61, succeeded: 1, failed: 60, errors: [], errors_omitted: 60 })
      expect(emptied.errors).toBeUndefined()
    })
  })

  test('every call carries the runtime-supplied signal, and an abort rejects the run', async () => {
    await withHome(async (home) => {
      await seedRecords(home, THREE)
      const controller = new AbortController()
      const { impl, calls } = stubApi()
      await withFetch(impl, () => invoke({ api_base: BASE }, controller.signal))
      for (const call of calls) expect(call.init.signal).toBe(controller.signal)

      const aborting = new AbortController()
      const rejecting = (async () => {
        aborting.abort()
        throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
      }) as unknown as typeof fetch
      await expect(withFetch(rejecting, () => invoke({ api_base: BASE }, aborting.signal))).rejects.toThrow()
    })
  })

  test('a rejected token stops the run at the first record and names the secret, never its value', async () => {
    for (const code of [401, 403]) {
      await withHome(async (home) => {
        await seedRecords(home, THREE)
        const { impl, calls } = stubApi({ 'r-1': code })
        const result = await withFetch(impl, () => invoke())

        expect(result.status).toBe('failed')
        expect(result.errors?.[0]?.code).toBe('auth_failure')
        expect(result.summary).toBe(`graph-sync: GRAPH_SYNC_TOKEN was rejected (HTTP ${code})`)
        expect(calls).toHaveLength(1)
        expect((calls[0]!.init.headers as Record<string, string>)['authorization']).toBe(`Bearer ${TOKEN}`)
        const serialised = JSON.stringify(result)
        expect(serialised).not.toContain(TOKEN)
        expect(serialised).not.toContain('Bearer')
      })
    }
  })

  test('an unset or empty token is refused by name with no call', async () => {
    for (const value of [undefined, '']) {
      await withHome(async (home) => {
        await seedRecords(home, THREE)
        const { impl, calls } = stubApi()
        const result = await withFetch(impl, () => invoke())

        expect(result.status).toBe('failed')
        expect(result.errors?.[0]?.code).toBe('auth_failure')
        expect(result.summary).toBe('graph-sync: GRAPH_SYNC_TOKEN is not set')
        expect(calls).toHaveLength(0)
      }, { [SECRET]: value })
    }
  })

  test('a records path outside the home is refused before any read or call', async () => {
    for (const records_path of ['../outside.json', 'state/../../outside.json', '/etc/records.json', 'C:\\records.json', '']) {
      await withHome(async () => {
        const { impl, calls } = stubApi()
        const result = await withFetch(impl, () => invoke({ records_path, api_base: BASE }))

        expect(result.status).toBe('failed')
        expect(result.errors?.[0]?.code).toBe('parse_error')
        expect(result.summary).toContain("input 'records_path'")
        expect(calls).toHaveLength(0)
      })
    }
  })

  test('an api_base that is not an http(s) URL is refused by key', async () => {
    for (const api_base of ['ftp://graph.example.com/v1', 'not a url', 42]) {
      await withHome(async (home) => {
        await seedRecords(home, THREE)
        const { impl, calls } = stubApi()
        const result = await withFetch(impl, () => invoke({ api_base }))

        expect(result.status).toBe('failed')
        expect(result.summary).toBe("graph-sync: input 'api_base' must be an http(s) URL")
        expect(calls).toHaveLength(0)
      })
    }
  })

  test('a records file that is not JSON, or holds no records list, is refused by key', async () => {
    for (const text of ['{ not json', JSON.stringify({ items: [] }), JSON.stringify([{ id: 'r-1' }]), '7']) {
      await withHome(async (home) => {
        await seedRaw(home, text)
        const { impl, calls } = stubApi()
        const result = await withFetch(impl, () => invoke())

        expect(result.status).toBe('failed')
        expect(result.errors?.[0]?.code).toBe('parse_error')
        expect(result.summary).toContain("input 'records_path'")
        expect(calls).toHaveLength(0)
      })
    }
  })

  test('no records file is a prefixed success with no Output and no call, never a bare skipped', async () => {
    await withHome(async () => {
      const { impl, calls } = stubApi()
      const result = await withFetch(impl, () => invoke())

      expect(result.status).toBe('success')
      expect(result.summary).toBe('graph-sync: no records file at the configured path — nothing to sync')
      expect(result.artifacts_produced ?? []).toHaveLength(0)
      expect(calls).toHaveLength(0)
    })
  })

  test('a host that passes no inputs gets the manifest defaults', async () => {
    await withHome(async (home) => {
      await seedRecords(home, THREE)
      const { impl, calls } = stubApi()
      const result = await withFetch(impl, () => invoke({}))

      expect(result.status).toBe('success')
      expect(calls[0]?.url).toBe(`${manifest.inputs.api_base?.default}/records/r-1`)
    })
  })
})

/**
 * `records_path` and `api_base` arrive from `<home>/config/graph-sync.json`,
 * and every field of the result is written to a run log, so no arm may quote
 * them. Each sentinel is shaped to PASS the guard above the arm it targets:
 * the records file really sits at the sentinel path, and the sentinel host is
 * a valid URL. A sentinel stopped at the first check proves nothing below it.
 * Asserted on the raw handler return, before any runtime normalisation.
 */
describe('graph-sync config value disclosure', () => {
  const SENTINEL = 'do-not-echo-5a7f3c'
  const PATH = `state/${SENTINEL}/records.json`
  const API = `https://${SENTINEL}.example.com/v1`
  const ARGS = { records_path: PATH, api_base: API }

  async function arm(answers: Record<string, number | Error>, fallback = 200) {
    return withHome(async (home) => {
      await seedRecords(home, THREE, PATH)
      const { impl, calls } = stubApi(answers, fallback)
      const result = await withFetch(impl, () => invoke(ARGS))
      // The sentinels reached the arm: the path was read and the host was called.
      expect(calls.length).toBeGreaterThan(0)
      expect(calls[0]!.url.startsWith(API)).toBe(true)
      return result
    })
  }

  test('success: neither configured value reaches the result', async () => {
    const result = await arm({})
    expect(result.status).toBe('success')
    expect(JSON.stringify(result)).not.toContain(SENTINEL)
  })

  test('one record failing, one throwing with the URL in its message: neither value reaches the result', async () => {
    const result = await arm({ 'r-2': 500, 'r-3': new TypeError(`Unable to connect to ${API}/records/r-3`) })
    expect(result.status).toBe('success')
    expect(bodyOf(result).failed).toBe(2)
    expect(JSON.stringify(result)).not.toContain(SENTINEL)
  })

  test('every record failing: neither value reaches the result', async () => {
    const result = await arm({}, 500)
    expect(result.status).toBe('failed')
    expect(JSON.stringify(result)).not.toContain(SENTINEL)
  })

  test('a rejected token: neither value nor the token reaches the result', async () => {
    const result = await arm({}, 401)
    expect(result.status).toBe('failed')
    expect(result.errors?.[0]?.code).toBe('auth_failure')
    const serialised = JSON.stringify(result)
    expect(serialised).not.toContain(SENTINEL)
    expect(serialised).not.toContain(TOKEN)
  })

  test('invalid inputs: each is refused by key without its value', async () => {
    for (const args of [
      { records_path: `/abs/${SENTINEL}.json`, api_base: API },
      { records_path: `../${SENTINEL}.json`, api_base: API },
      { records_path: PATH, api_base: `ftp://${SENTINEL}.example.com` },
      { records_path: PATH, api_base: `${SENTINEL} not a url` },
    ]) {
      await withHome(async (home) => {
        await seedRecords(home, THREE, PATH)
        const { impl, calls } = stubApi()
        const result = await withFetch(impl, () => invoke(args))
        expect(result.status).toBe('failed')
        expect(calls).toHaveLength(0)
        expect(JSON.stringify(result)).not.toContain(SENTINEL)
      })
    }
  })

  test('an unreadable records file and a missing one: the path is not named', async () => {
    await withHome(async (home) => {
      await seedRaw(home, '{ not json', PATH)
      const unreadable = await invoke(ARGS)
      expect(unreadable.status).toBe('failed')
      expect(JSON.stringify(unreadable)).not.toContain(SENTINEL)

      const missing = await invoke({ ...ARGS, records_path: `state/${SENTINEL}/absent.json` })
      expect(missing.status).toBe('success')
      expect(JSON.stringify(missing)).not.toContain(SENTINEL)
    })
  })
})
