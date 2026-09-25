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
    return { ok: code >= 200 && code < 300, status: code, json: async () => ({ value: Object.hasOwn(VALUES, instrument) ? VALUES[instrument] : 1 }) }
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

/** Written as raw text so a case can seed a ledger that is not a ledger at all. */
async function seedRaw(home: string, text: string, rel = 'state/ledger.json'): Promise<void> {
  await mkdir(join(home, rel, '..'), { recursive: true })
  await writeFile(join(home, rel), text)
}

/** The ledger file's text, or null when there is none. */
const ledgerText = (home: string, rel?: string) => readFile(LEDGER(home, rel), 'utf-8').catch(() => null)

const PRIOR = '2026-01-01T00:00:00.000Z'

describe('ledger-runner keeps what it had', () => {
  test('every instrument failing is a failure, and no ledger file is written', async () => {
    await withHome(async (home) => {
      const { impl, calls } = stubQuotes({ 'example-b': new TypeError('Unable to connect') }, 500)
      const result = await withFetch(impl, () => invoke())

      expect(result.status).toBe('failed')
      expect(result.errors).toHaveLength(1)
      expect(result.errors?.[0]?.code).toBe('dependency_unavailable')
      expect(result.summary).toBe('ledger-runner: every instrument failed (3 attempted; first at position 1: HTTP 500)')
      expect(result.artifacts_produced ?? []).toHaveLength(0)
      expect(calls).toHaveLength(3)
      expect(await ledgerText(home)).toBeNull()
    })
  })

  test('every instrument failing over an existing ledger leaves it byte-identical', async () => {
    await withHome(async (home) => {
      const seeded = JSON.stringify({ values: { 'example-a': { value: 1, as_of: PRIOR } } }, null, 2)
      await seedRaw(home, seeded)
      const result = await withFetch(stubQuotes({}, 503).impl, () => invoke())

      expect(result.status).toBe('failed')
      expect(await ledgerText(home)).toBe(seeded)
    })
  })

  test('a failing instrument keeps its prior value and as_of; the others are fresh, and an unlisted entry survives', async () => {
    await withHome(async (home) => {
      await seedRaw(home, JSON.stringify({
        values: {
          'example-b': { value: 7, as_of: PRIOR },
          'example-c': { value: 9, as_of: PRIOR },
          'example-z': { value: 42, as_of: PRIOR },
        },
      }))
      const result = await withFetch(stubQuotes({ 'example-b': 500 }).impl, () => invoke())

      expect(result.status).toBe('success')
      const { values } = await readLedger(home)
      expect(values['example-b']).toEqual({ value: 7, as_of: PRIOR })
      expect(values['example-z']).toEqual({ value: 42, as_of: PRIOR })
      expect(values['example-a']!.value).toBe(VALUES['example-a']!)
      expect(values['example-c']!.value).toBe(VALUES['example-c']!)
      expect(values['example-a']!.as_of).not.toBe(PRIOR)
      expect(values['example-c']!.as_of).not.toBe(PRIOR)
    })
  })

  test('a fetch that throws, and a response with no numeric value, each fail their instrument alone', async () => {
    await withHome(async (home) => {
      const { impl, calls } = stubQuotes({
        'example-a': new TypeError('Unable to connect'),
        'example-b': { body: { value: 'twelve' } },
      })
      const result = await withFetch(impl, () => invoke({ instruments: [...THREE, 'example-d', 'example-e'], api_base: BASE }))
      const second = stubQuotes({ 'example-d': { body: null }, 'example-e': { body: { value: Infinity } } })
      const again = await withFetch(second.impl, () => invoke({ instruments: ['example-c', 'example-d', 'example-e'], api_base: BASE }))

      expect(result.status).toBe('success')
      expect(calls).toHaveLength(5)
      expect(bodyOf(result).errors).toEqual([
        { position: 1, reason: 'request failed' },
        { position: 2, reason: 'response carried no numeric value' },
      ])
      expect(again.status).toBe('success')
      expect(bodyOf(again).errors).toEqual([
        { position: 2, reason: 'response carried no numeric value' },
        { position: 3, reason: 'response carried no numeric value' },
      ])
      const { values } = await readLedger(home)
      expect(Object.keys(values).sort()).toEqual(['example-c', 'example-d', 'example-e'])
    })
  })

  test('failures past fifty are counted, not listed', async () => {
    await withHome(async () => {
      const instruments = ['ok', ...Array.from({ length: 60 }, (_, i) => `f-${i}`)]
      const result = await withFetch(stubQuotes({ ok: 200 }, 500).impl, () => invoke({ instruments, api_base: BASE }))

      expect(result.status).toBe('success')
      const body = bodyOf(result)
      expect(body).toMatchObject({ attempted: 61, succeeded: 1, failed: 60, errors_omitted: 10 })
      expect(body.errors).toHaveLength(50)
      expect(body.errors[49]).toEqual({ position: 51, reason: 'HTTP 500' })
      expect(result.errors).toHaveLength(50)
    })
  })

  test('an instrument named __proto__ is a ledger key like any other', async () => {
    await withHome(async (home) => {
      const result = await withFetch(stubQuotes().impl, () => invoke({ instruments: ['__proto__', 'constructor'], api_base: BASE }))

      expect(result.status).toBe('success')
      expect(Object.hasOwn(Object.prototype, 'value')).toBe(false)
      const { values } = await readLedger(home)
      expect(Object.hasOwn(values, '__proto__')).toBe(true)
      expect(Object.hasOwn(values, 'constructor')).toBe(true)
    })
  })

  test('every call carries the runtime-supplied signal, and an abort rejects the run with nothing written', async () => {
    await withHome(async (home) => {
      const controller = new AbortController()
      const { impl, calls } = stubQuotes()
      await withFetch(impl, () => invoke({ instruments: THREE, api_base: BASE }, controller.signal))
      for (const call of calls) expect(call.init.signal).toBe(controller.signal)

      await rm(LEDGER(home))
      const aborting = new AbortController()
      const rejecting = (async () => {
        aborting.abort()
        throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
      }) as unknown as typeof fetch
      await expect(withFetch(rejecting, () => invoke({ instruments: THREE, api_base: BASE }, aborting.signal))).rejects.toThrow()
      expect(await ledgerText(home)).toBeNull()
    })
  })

  // WR-04. By the time the handler sees this abort the runtime has recorded a
  // timeout, so the ledger it says was never written must not be written.
  test('an abort while reading the last body rejects the run and leaves the ledger as it was', async () => {
    await withHome(async (home) => {
      await seedRaw(home, JSON.stringify({ values: { 'example-a': { value: 1, as_of: PRIOR } } }))
      const before = await ledgerText(home)
      const aborting = new AbortController()
      let k = 0
      const impl = (async () => {
        k += 1
        const last = k === THREE.length
        return {
          ok: true,
          status: 200,
          json: async () => {
            if (!last) return { value: 5 }
            aborting.abort()
            throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
          },
        }
      }) as unknown as typeof fetch
      await expect(withFetch(impl, () => invoke({ instruments: THREE, api_base: BASE }, aborting.signal))).rejects.toThrow()
      expect(await ledgerText(home)).toBe(before)
    })
  })
})

describe('ledger-runner credentials', () => {
  test('a rejected token on the second instrument stops the run, names the secret, and leaves the ledger untouched', async () => {
    for (const code of [401, 403]) {
      for (const seeded of [null, JSON.stringify({ values: { 'example-a': { value: 1, as_of: PRIOR } } }, null, 2)]) {
        await withHome(async (home) => {
          if (seeded !== null) await seedRaw(home, seeded)
          const { impl, calls } = stubQuotes({ 'example-b': code })
          const result = await withFetch(impl, () => invoke())

          expect(result.status).toBe('failed')
          expect(result.errors?.[0]?.code).toBe('auth_failure')
          expect(result.summary).toBe(`ledger-runner: LEDGER_QUOTES_TOKEN was rejected (HTTP ${code})`)
          expect(result.errors?.[0]?.message).toContain('LEDGER_QUOTES_TOKEN')
          expect(calls).toHaveLength(2)
          expect((calls[1]!.init.headers as Record<string, string>)['authorization']).toBe(`Bearer ${TOKEN}`)
          const serialised = JSON.stringify(result)
          expect(serialised).not.toContain(TOKEN)
          expect(serialised).not.toContain('Bearer')
          const text = await ledgerText(home)
          expect(text).toBe(seeded)
          expect(text ?? '').not.toContain(TOKEN)
        })
      }
    }
  })

  test('the written ledger carries no token', async () => {
    await withHome(async (home) => {
      await withFetch(stubQuotes().impl, () => invoke())
      const text = await ledgerText(home)
      expect(text).not.toBeNull()
      expect(text).not.toContain(TOKEN)
      expect(text).not.toContain('Bearer')
    })
  })

  test('an unset or empty token is refused by name with no request', async () => {
    for (const value of [undefined, '']) {
      await withHome(async (home) => {
        const { impl, calls } = stubQuotes()
        const result = await withFetch(impl, () => invoke())

        expect(result.status).toBe('failed')
        expect(result.errors?.[0]?.code).toBe('auth_failure')
        expect(result.summary).toBe('ledger-runner: LEDGER_QUOTES_TOKEN is not set')
        expect(calls).toHaveLength(0)
        expect(await ledgerText(home)).toBeNull()
      }, { [SECRET]: value })
    }
  })
})

describe('ledger-runner refusals', () => {
  test('an empty instruments list is a prefixed success naming warpline configure, with no request and no Output', async () => {
    for (const args of [{ instruments: [], api_base: BASE }, {}]) {
      await withHome(async (home) => {
        const { impl, calls } = stubQuotes()
        const result = await withFetch(impl, () => invoke(args))

        expect(result.status).toBe('success')
        expect(result.summary.startsWith('ledger-runner:')).toBe(true)
        expect(result.summary).toContain('warpline configure')
        expect(result.artifacts_produced ?? []).toHaveLength(0)
        expect(calls).toHaveLength(0)
        expect(await ledgerText(home)).toBeNull()
      })
    }
  })

  test('an instruments input that is not a list of non-empty strings is refused by key', async () => {
    // `.` and `..` (WR-03): the URL parser would resolve them out of `/quotes/`.
    for (const instruments of ['example-a', [''], ['example-a', 7], [null], { a: 1 }, ['example-a', '..'], ['.']]) {
      await withHome(async () => {
        const { impl, calls } = stubQuotes()
        const result = await withFetch(impl, () => invoke({ instruments, api_base: BASE }))

        expect(result.status).toBe('failed')
        expect(result.errors?.[0]?.code).toBe('parse_error')
        expect(result.summary).toContain("input 'instruments'")
        expect(calls).toHaveLength(0)
      })
    }
  })

  test('a ledger path outside the home is refused by key before any read or request', async () => {
    for (const ledger_path of ['../x.json', 'state/../../x.json', '/etc/ledger.json', 'C:\\ledger.json', '', 7]) {
      await withHome(async () => {
        const { impl, calls } = stubQuotes()
        const result = await withFetch(impl, () => invoke({ instruments: THREE, api_base: BASE, ledger_path }))

        expect(result.status).toBe('failed')
        expect(result.errors?.[0]?.code).toBe('parse_error')
        expect(result.summary).toContain("input 'ledger_path'")
        expect(calls).toHaveLength(0)
      })
    }
  })

  test('an unreadable or wrong-shaped ledger is refused by key before any request, and left as it was', async () => {
    const shapes = [
      '{ not json',
      JSON.stringify({ values: [] }),
      JSON.stringify({ values: null }),
      JSON.stringify({ entries: {} }),
      JSON.stringify([]),
      '7',
      JSON.stringify({ values: { 'example-a': 5 } }),
      JSON.stringify({ values: { 'example-a': { value: '5', as_of: PRIOR } } }),
      JSON.stringify({ values: { 'example-a': { value: 5 } } }),
    ]
    for (const text of shapes) {
      await withHome(async (home) => {
        await seedRaw(home, text)
        const { impl, calls } = stubQuotes()
        const result = await withFetch(impl, () => invoke())

        expect(result.status).toBe('failed')
        expect(result.errors?.[0]?.code).toBe('parse_error')
        expect(result.summary).toBe("ledger-runner: the file named by input 'ledger_path' is unreadable — refusing to overwrite it")
        expect(calls).toHaveLength(0)
        expect(await ledgerText(home)).toBe(text)
      })
    }
  })

  test('a directory at the ledger path is refused by key before any request', async () => {
    await withHome(async (home) => {
      await mkdir(LEDGER(home), { recursive: true })
      const { impl, calls } = stubQuotes()
      const result = await withFetch(impl, () => invoke())

      expect(result.status).toBe('failed')
      expect(result.errors?.[0]?.code).toBe('parse_error')
      expect(result.summary).toContain("input 'ledger_path'")
      expect(calls).toHaveLength(0)
    })
  })

  test('an api_base that is not an http(s) URL is refused by key', async () => {
    for (const api_base of ['ftp://quotes.example.com/v1', 'not a url', 42]) {
      await withHome(async () => {
        const { impl, calls } = stubQuotes()
        const result = await withFetch(impl, () => invoke({ instruments: THREE, api_base }))

        expect(result.status).toBe('failed')
        expect(result.summary).toBe("ledger-runner: input 'api_base' must be an http(s) URL")
        expect(calls).toHaveLength(0)
      })
    }
  })

  test('the ledger is written only through the atomic writer', async () => {
    const source = await readFile(join(import.meta.dir, 'handler.ts'), 'utf8')
    expect(source.split('atomicWriteJson(').length - 1).toBe(1)
    expect(['atomicWriteText', 'writeFile', 'rename'].filter((other) => source.includes(other))).toEqual([])
  })
})

/**
 * `instruments`, `api_base` and `ledger_path` arrive from
 * `<home>/config/ledger-runner.json`, and every field of the result is
 * written to a run log, so no arm may quote them. Each sentinel is shaped to
 * PASS the guard above the arm it targets: the ledger really sits at the
 * sentinel path, the sentinel host is a valid URL and the sentinel names are
 * really requested. A sentinel stopped at the first check proves nothing
 * below it. Asserted on the raw handler return, before any runtime normalisation.
 */
describe('ledger-runner config value disclosure', () => {
  const SENTINEL = 'do-not-echo-4e1b9a'
  const NAMES = [`${SENTINEL}-one`, `${SENTINEL}-two`, `${SENTINEL}-three`]
  const PATH = `state/${SENTINEL}/ledger.json`
  const API = `https://${SENTINEL}.example.com/v1`
  const ARGS = { instruments: NAMES, api_base: API, ledger_path: PATH }

  async function arm(answers: Record<string, number | Error>, fallback?: number) {
    return withHome(async (home) => {
      await seedRaw(home, JSON.stringify({ values: { [NAMES[1]!]: { value: 7, as_of: PRIOR } } }), PATH)
      const { impl, calls } = stubQuotes(answers, fallback)
      const result = await withFetch(impl, () => invoke(ARGS))
      // The sentinels reached the arm: the ledger was read and the host was called.
      expect(calls.length).toBeGreaterThan(0)
      expect(calls[0]!.url.startsWith(`${API}/quotes/`)).toBe(true)
      expect(calls[0]!.instrument).toBe(NAMES[0]!)
      return result
    })
  }

  test('success: no configured value reaches the result', async () => {
    const result = await arm({})
    expect(result.status).toBe('success')
    expect(JSON.stringify(result)).not.toContain(SENTINEL)
  })

  test('one failing, one throwing with the URL in its message: no configured value reaches the result', async () => {
    const result = await arm({ [NAMES[1]!]: 500, [NAMES[2]!]: new TypeError(`Unable to connect to ${API}/quotes/${NAMES[2]}`) })
    expect(result.status).toBe('success')
    expect(bodyOf(result).failed).toBe(2)
    expect(JSON.stringify(result)).not.toContain(SENTINEL)
  })

  test('every instrument failing: no configured value reaches the result', async () => {
    const result = await arm({}, 500)
    expect(result.status).toBe('failed')
    expect(JSON.stringify(result)).not.toContain(SENTINEL)
  })

  test('a rejected token: no configured value and no token reaches the result', async () => {
    const result = await arm({ [NAMES[1]!]: 401 })
    expect(result.status).toBe('failed')
    expect(result.errors?.[0]?.code).toBe('auth_failure')
    const serialised = JSON.stringify(result)
    expect(serialised).not.toContain(SENTINEL)
    expect(serialised).not.toContain(TOKEN)
  })

  test('invalid inputs and an unreadable ledger: each is refused by key without its value', async () => {
    for (const [args, ledger] of [
      [{ ...ARGS, instruments: [...NAMES, ''] }, null],
      [{ ...ARGS, ledger_path: `../${SENTINEL}.json` }, null],
      [{ ...ARGS, ledger_path: `/abs/${SENTINEL}.json` }, null],
      [{ ...ARGS, api_base: `ftp://${SENTINEL}.example.com` }, null],
      [{ ...ARGS, api_base: `${SENTINEL} not a url` }, null],
      [ARGS, `{ "values": { "${SENTINEL}": 1 } }`],
      [ARGS, `{ not json ${SENTINEL}`],
    ] as const) {
      await withHome(async (home) => {
        if (ledger !== null) await seedRaw(home, ledger, PATH)
        const { impl, calls } = stubQuotes()
        const result = await withFetch(impl, () => invoke(args))
        expect(result.status).toBe('failed')
        expect(result.errors?.[0]?.code).toBe('parse_error')
        expect(calls).toHaveLength(0)
        expect(JSON.stringify(result)).not.toContain(SENTINEL)
      })
    }
  })
})
