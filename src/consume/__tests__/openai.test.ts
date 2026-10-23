/**
 * The openai-compatible renderer, pinned at the module against a local stub.
 *
 * One try is one non-streaming `POST <endpoint>/chat/completions` carrying the
 * model, the prompt as one user message and `stream: false`, and no token-limit
 * field. It calls again, at most twice, only when the server did no work: a
 * refused connect, or HTTP 429 or 503. A 502 or 504 can follow an upstream
 * generation a gateway already billed, so it ends the try, as a timeout, any
 * other status or a failure after the call was sent do. A try's cost is the
 * cost its 200 carries: reported (the `x-litellm-response-cost` header, then the
 * body's `usage.cost`) before computed (the price table, from the token counts)
 * before unknown. A try with no 200 has no cost, so the caller keeps its full
 * reservation. A refusal reason names a status or a fixed phrase, never the
 * endpoint, the credential or a price.
 *
 * No case reaches a real provider. Every case passes `pauseMs: 0`.
 */
import { describe, expect, test } from 'bun:test'
import { withOpenAiStub, type StubReply } from '../../../test-utils/openai-stub.js'
// The module this file pins before it exists, read through the namespace so
// each export is named where it is used.
import * as openai from '../openai.js'

const NO_PRICES = {}
const OK_BODY = { model: 'm-served', choices: [{ message: { content: 'hello' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }
const ok = (extra: Partial<StubReply> = {}): StubReply => ({ status: 200, body: OK_BODY, ...extra })
const status = (s: number): StubReply => ({ status: s, body: { error: { message: 'upstream said no' } } })

function render(endpoint: string, over: Partial<Parameters<typeof openai.renderOpenAi>[0]> = {}) {
  return openai.renderOpenAi({ endpoint, model: 'm', prompt: 'p', apiKey: null, prices: NO_PRICES, pauseMs: 0, ...over })
}

/** A port that was free a moment ago and has nothing listening on it now. */
async function closedPort(): Promise<number> {
  const s = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') })
  const port = s.port!
  await s.stop(true)
  return port
}

describe('one try against a 200', () => {
  test('tracer: a 200 becomes one result with its text, served model and one call', async () => {
    await withOpenAiStub([ok()], async (stub) => {
      const r = await render(stub.url)
      expect(r).toMatchObject({ ok: true, text: 'hello', served: 'm-served', calls: 1, reason: null })
      expect(r.calls).toBe(stub.calls())
      expect(stub.bodies()).toEqual([{ model: 'm', messages: [{ role: 'user', content: 'p' }], stream: false }])
    })
  })

  test('the body carries no token-limit field', async () => {
    await withOpenAiStub([ok()], async (stub) => {
      await render(stub.url)
      const body = stub.bodies()[0] as Record<string, unknown>
      expect(Object.keys(body).sort()).toEqual(['messages', 'model', 'stream'])
      expect('max_tokens' in body).toBe(false)
      expect('max_completion_tokens' in body).toBe(false)
    })
  })

  test('a trailing slash on the endpoint is dropped before the path is added', async () => {
    await withOpenAiStub([ok()], async (stub) => {
      const r = await render(`${stub.url}//`)
      expect(r.ok).toBe(true)
      expect(stub.calls()).toBe(1)
    })
  })

  test('the credential goes only as a bearer header, and only when one is given', async () => {
    await withOpenAiStub([ok()], async (stub) => {
      await render(stub.url, { apiKey: 'sk-test-0001' })
      await render(stub.url, { apiKey: null })
      expect(stub.auth()).toEqual(['Bearer sk-test-0001', null])
    })
  })

  test('a 200 whose body is not JSON is not ok', async () => {
    await withOpenAiStub([{ status: 200, body: 'not json at all' }], async (stub) => {
      const r = await render(stub.url)
      expect(r).toMatchObject({ ok: false, text: null, calls: 1, reason: 'the response was not JSON' })
    })
  })

  test('a 200 with no text in its first choice is not ok', async () => {
    await withOpenAiStub([{ status: 200, body: { model: 'm-served', choices: [{ message: { content: null } }] } }], async (stub) => {
      const r = await render(stub.url)
      expect(r).toMatchObject({ ok: false, text: null, calls: 1, reason: 'the response carried no text' })
    })
  })

  test('a served model that is not a string is recorded as null', async () => {
    await withOpenAiStub([ok({ body: { ...OK_BODY, model: 42 } })], async (stub) => {
      const r = await render(stub.url)
      expect(r).toMatchObject({ ok: true, served: null })
    })
  })
})

describe('calls again only when nothing was answered', () => {
  test('a 503 then a 200 is two calls', async () => {
    await withOpenAiStub([status(503), ok()], async (stub) => {
      const r = await render(stub.url)
      expect(r).toMatchObject({ ok: true, text: 'hello', calls: 2 })
      expect(stub.calls()).toBe(2)
    })
  })

  for (const s of [429]) {
    test(`a ${s} is called again`, async () => {
      await withOpenAiStub([status(s), ok()], async (stub) => {
        const r = await render(stub.url)
        expect(r).toMatchObject({ ok: true, calls: 2 })
        expect(stub.calls()).toBe(2)
      })
    })
  }

  // A gateway answers these after its upstream may have finished and billed the generation.
  for (const s of [502, 504]) {
    test(`a ${s} is one call and ends the try with no cost`, async () => {
      await withOpenAiStub([status(s), ok()], async (stub) => {
        const r = await render(stub.url)
        expect(r).toMatchObject({ ok: false, text: null, calls: 1, cost_micro_usd: null, cost_basis: 'unknown' })
        expect(r.reason).toBe(`the endpoint answered HTTP ${s}`)
        expect(stub.calls()).toBe(1)
      })
    })
  }

  test('three 503s stop at three calls, with no cost', async () => {
    await withOpenAiStub([status(503)], async (stub) => {
      const r = await render(stub.url)
      expect(r).toMatchObject({ ok: false, text: null, calls: 3, cost_micro_usd: null, cost_basis: 'unknown' })
      expect(r.reason).toBe('the endpoint answered HTTP 503')
      expect(stub.calls()).toBe(3)
    })
  })

  test('a 400 is one call and is not called again', async () => {
    await withOpenAiStub([status(400), ok()], async (stub) => {
      const r = await render(stub.url)
      expect(r).toMatchObject({ ok: false, calls: 1, cost_micro_usd: null, cost_basis: 'unknown' })
      expect(r.reason).toBe('the endpoint answered HTTP 400')
      expect(stub.calls()).toBe(1)
    })
  })

  test('a refused connect is called again, three calls in all, and nothing is answered', async () => {
    const port = await closedPort()
    const r = await render(`http://127.0.0.1:${port}`)
    expect(r).toMatchObject({ ok: false, text: null, served: null, calls: 3, cost_micro_usd: null, cost_basis: 'unknown' })
    expect(r.reason).toBe('the endpoint did not answer')
  })

  test('a reply slower than the timeout is one call, not ok, with no cost', async () => {
    await withOpenAiStub(
      [ok({ headers: { 'x-litellm-response-cost': '0.000123' } })],
      async (stub) => {
        const r = await render(stub.url, { timeoutMs: 100 })
        expect(r).toMatchObject({ ok: false, calls: 1, cost_micro_usd: null, cost_basis: 'unknown' })
        expect(r.reason).toBe('the endpoint did not answer')
        expect(stub.calls()).toBe(1)
      },
      { delayMs: 1_000 },
    )
  })

  test('the limits are the published constants', () => {
    expect(openai.OPENAI_MAX_CALLS).toBe(3)
    expect([...openai.OPENAI_RETRY_STATUSES]).toEqual([429, 503])
    expect(openai.OPENAI_TIMEOUT_MS).toBe(300_000)
    expect(openai.CONSUME_API_KEY_ENV).toBe('WARPLINE_CONSUME_API_KEY')
  })
})

describe('the cost of a try', () => {
  const PRICES = { m: { usd_per_mtok_in: 3, usd_per_mtok_out: 15 } }
  const TOKENS = { prompt_tokens: 1000, completion_tokens: 2000 }

  test('the x-litellm-response-cost header is reported, and beats the body', async () => {
    await withOpenAiStub(
      [ok({ headers: { 'x-litellm-response-cost': '0.000123' }, body: { ...OK_BODY, usage: { ...TOKENS, cost: 0.0005 } } })],
      async (stub) => {
        const r = await render(stub.url, { prices: PRICES })
        expect(r).toMatchObject({ cost_micro_usd: 123, cost_basis: 'reported' })
      },
    )
  })

  test('a header in exponent form, as a Python float prints it, is read', async () => {
    await withOpenAiStub([ok({ headers: { 'x-litellm-response-cost': '1.23e-05' } })], async (stub) => {
      const r = await render(stub.url)
      expect(r).toMatchObject({ cost_micro_usd: 13, cost_basis: 'reported' })
    })
  })

  test('the body usage.cost is reported, and beats the price table', async () => {
    await withOpenAiStub([ok({ body: { ...OK_BODY, usage: { ...TOKENS, cost: 0.0005 } } })], async (stub) => {
      const r = await render(stub.url, { prices: PRICES })
      expect(r).toMatchObject({ cost_micro_usd: 500, cost_basis: 'reported' })
    })
  })

  test('the price table gives a computed cost, never a reported one', async () => {
    await withOpenAiStub([ok({ body: { ...OK_BODY, usage: TOKENS } })], async (stub) => {
      const r = await render(stub.url, { prices: PRICES })
      expect(r).toMatchObject({ ok: true, cost_micro_usd: 33000, cost_basis: 'computed' })
    })
  })

  test('the price table is read for the requested model, not the served one', async () => {
    await withOpenAiStub([ok({ body: { ...OK_BODY, model: 'm', usage: TOKENS } })], async (stub) => {
      const r = await render(stub.url, { model: 'other', prices: PRICES })
      expect(r).toMatchObject({ cost_micro_usd: null, cost_basis: 'unknown' })
    })
  })

  test('a computed cost rounds a fraction of a micro-USD up', async () => {
    // One token at $0.5 per million is half a micro-USD.
    await withOpenAiStub([ok({ body: { ...OK_BODY, usage: { prompt_tokens: 1, completion_tokens: 0 } } })], async (stub) => {
      const r = await render(stub.url, { prices: { m: { usd_per_mtok_in: 0.5, usd_per_mtok_out: 0 } } })
      expect(r).toMatchObject({ cost_micro_usd: 1, cost_basis: 'computed' })
    })
  })

  test('no header, no usage.cost and no price is an unknown cost on an answered call', async () => {
    await withOpenAiStub([ok()], async (stub) => {
      const r = await render(stub.url)
      expect(r).toMatchObject({ ok: true, cost_micro_usd: null, cost_basis: 'unknown' })
    })
  })

  test('a cost that is not a finite number at or above zero is not taken', async () => {
    for (const bad of ['-0.1', 'NaN', 'Infinity', '', 'abc', '0x10']) {
      await withOpenAiStub([ok({ headers: { 'x-litellm-response-cost': bad } })], async (stub) => {
        const r = await render(stub.url)
        expect({ bad, cost: r.cost_micro_usd, basis: r.cost_basis }).toEqual({ bad, cost: null, basis: 'unknown' })
      })
    }
    await withOpenAiStub([ok({ body: { ...OK_BODY, usage: { cost: -1 } } })], async (stub) => {
      expect((await render(stub.url)).cost_micro_usd).toBeNull()
    })
    await withOpenAiStub([ok({ body: { ...OK_BODY, usage: { cost: '0.5' } } })], async (stub) => {
      expect((await render(stub.url)).cost_micro_usd).toBeNull()
    })
  })

  test('a 503 then a 200 is two calls whose costs settle as one try: the 503 counts 0', async () => {
    await withOpenAiStub([status(503), ok({ headers: { 'x-litellm-response-cost': '0.000123' } })], async (stub) => {
      const r = await render(stub.url)
      expect(r).toMatchObject({ ok: true, calls: 2, cost_micro_usd: 123, cost_basis: 'reported' })
    })
  })

  test('a try with no 200 has no cost, so the full reservation is kept', async () => {
    await withOpenAiStub([status(400)], async (stub) => {
      const r = await render(stub.url, { prices: PRICES })
      expect(r).toMatchObject({ ok: false, cost_micro_usd: null, cost_basis: 'unknown' })
    })
  })

  test('expectedOpenAiBasis is computed only for a model with its own price-table entry', () => {
    expect(openai.expectedOpenAiBasis('m', PRICES)).toBe('computed')
    expect(openai.expectedOpenAiBasis('other', PRICES)).toBe('unknown')
    expect(openai.expectedOpenAiBasis('toString', PRICES)).toBe('unknown')
    expect(openai.expectedOpenAiBasis('m', {})).toBe('unknown')
  })
})

describe('a refusal reason names a status or a fixed phrase', () => {
  const KEY = 'sk-test-0042-secret'
  const PRICES = { m: { usd_per_mtok_in: 7.654321, usd_per_mtok_out: 8.765432 } }

  test('never the endpoint, the credential or a price', async () => {
    const reasons: string[] = []
    const endpoints: string[] = []
    const scripts: StubReply[][] = [[status(503)], [status(400)], [{ status: 200, body: 'not json' }], [{ status: 200, body: {} }]]
    for (const script of scripts) {
      await withOpenAiStub(script, async (stub) => {
        endpoints.push(stub.url)
        const r = await render(stub.url, { apiKey: KEY, prices: PRICES })
        reasons.push(r.reason ?? '')
      })
    }
    await withOpenAiStub(
      [ok()],
      async (stub) => {
        endpoints.push(stub.url)
        reasons.push((await render(stub.url, { apiKey: KEY, prices: PRICES, timeoutMs: 100 })).reason ?? '')
      },
      { delayMs: 1_000 },
    )
    const port = await closedPort()
    endpoints.push(`http://127.0.0.1:${port}`)
    reasons.push((await render(`http://127.0.0.1:${port}`, { apiKey: KEY, prices: PRICES })).reason ?? '')

    expect(reasons.every((r) => r.length > 0)).toBe(true)
    for (const r of reasons) {
      expect(r).not.toContain('127.0.0.1')
      expect(r).not.toContain('http')
      expect(r).not.toContain(KEY)
      expect(r).not.toContain('sk-')
      expect(r).not.toMatch(/7\.?654321|8\.?765432/)
      for (const e of endpoints) expect(r).not.toContain(e.split(':').at(-1)!)
    }
  })
})
