/**
 * The openai-compatible renderer: one try is one non-streaming
 * `POST <endpoint>/chat/completions`.
 *
 * The body is exactly the model, the prompt as one user message and
 * `stream: false`. It carries no token-limit field, because servers disagree on
 * which field name they accept, and some refuse the other one. The output size
 * is bounded on warpline's side. The credential arrives from the
 * caller, read from `WARPLINE_CONSUME_API_KEY`, and leaves only as a bearer
 * header.
 *
 * It calls again, at most twice, only when the server says it did no work: a
 * refused connect, HTTP 429, or HTTP 503 (unable to handle the request, RFC
 * 9110 § 15.6.4). A 502 or 504 comes from a gateway whose upstream may have
 * finished and billed the generation, so it ends the try with cost unknown and
 * the caller's full reservation counts, as a timeout, any other status and a
 * failure after the call was sent do. A 429 or 503 costs nothing, so a try's
 * cost is the cost its 200 carries: reported (the `x-litellm-response-cost`
 * header, then the body's `usage.cost`) before computed (the price table for
 * the requested model, from the token counts) before unknown. A try with no
 * 200 has no cost, which keeps the caller's full reservation.
 *
 * Every refusal reason names a status or a fixed phrase. None names the
 * endpoint, the credential or a price.
 */
import { toMicroUp, type CostBasis, type PriceTable, type Rendered } from './renderers.js'

export const CONSUME_API_KEY_ENV = 'WARPLINE_CONSUME_API_KEY'
export const OPENAI_RETRY_STATUSES = [429, 503] as const
export const OPENAI_MAX_CALLS = 3
export const OPENAI_TIMEOUT_MS = 300_000
const PAUSE_MS = 500

/** The basis a 200 with no reported cost would get: known before the call. */
export function expectedOpenAiBasis(model: string, prices: PriceTable): CostBasis {
  return Object.hasOwn(prices, model) ? 'computed' : 'unknown'
}

/** A float USD from provider text, as micro-USD; null unless it is a finite number at or above zero. */
function micro(usd: unknown): number | null {
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) return null
  const m = toMicroUp(usd)
  return Number.isSafeInteger(m) ? m : null
}

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0

function costOf(header: string | null, body: unknown, model: string, prices: PriceTable): { cost: number | null; basis: CostBasis } {
  // Decimal, optionally in exponent form as a Python float prints it; never hex, never empty.
  if (header !== null && /^\d+(\.\d+)?([eE][-+]?\d+)?$/.test(header.trim())) {
    const m = micro(Number(header.trim()))
    if (m !== null) return { cost: m, basis: 'reported' }
  }
  const usage = (body as { usage?: Record<string, unknown> } | null)?.usage
  const reported = micro(usage?.cost)
  if (reported !== null) return { cost: reported, basis: 'reported' }
  const price = Object.hasOwn(prices, model) ? prices[model] : undefined
  const pin = micro(price?.usd_per_mtok_in)
  const pout = micro(price?.usd_per_mtok_out)
  const tin = usage?.prompt_tokens
  const tout = usage?.completion_tokens
  if (pin !== null && pout !== null && isCount(tin) && isCount(tout)) {
    const total = BigInt(tin) * BigInt(pin) + BigInt(tout) * BigInt(pout)
    const m = Number((total + 999_999n) / 1_000_000n)
    if (Number.isSafeInteger(m)) return { cost: m, basis: 'computed' }
  }
  return { cost: null, basis: 'unknown' }
}

export async function renderOpenAi(o: {
  endpoint: string
  model: string
  prompt: string
  apiKey: string | null
  prices: PriceTable
  timeoutMs?: number
  pauseMs?: number
}): Promise<Rendered & { calls: number }> {
  const url = `${o.endpoint.replace(/\/+$/, '')}/chat/completions`
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (o.apiKey !== null) headers.authorization = `Bearer ${o.apiKey}`
  const body = JSON.stringify({ model: o.model, messages: [{ role: 'user', content: o.prompt }], stream: false })
  const failed = (calls: number, reason: string) =>
    ({ ok: false, text: null, served: null, cost_micro_usd: null, cost_basis: 'unknown', reason, calls }) as const

  let calls = 0
  let lastStatus: number | null = null
  while (calls < OPENAI_MAX_CALLS) {
    if (calls > 0) await new Promise((r) => setTimeout(r, o.pauseMs ?? PAUSE_MS))
    calls++
    let res: Response
    try {
      res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(o.timeoutMs ?? OPENAI_TIMEOUT_MS) })
    } catch (err) {
      // Bun 1.4.2 rejects a closed port with code 'ConnectionRefused'; node's fetch gives ECONNREFUSED on its cause.
      const e = err as { code?: unknown; cause?: { code?: unknown } }
      const code = e.code ?? e.cause?.code
      if (code === 'ConnectionRefused' || code === 'ECONNREFUSED') {
        lastStatus = null
        continue
      }
      return failed(calls, 'the endpoint did not answer')
    }
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {})
      if ((OPENAI_RETRY_STATUSES as readonly number[]).includes(res.status)) {
        lastStatus = res.status
        continue
      }
      return failed(calls, `the endpoint answered HTTP ${res.status}`)
    }

    let raw: string
    try {
      raw = await res.text()
    } catch {
      return failed(calls, 'the endpoint did not answer')
    }
    let parsed: unknown = null
    let json = true
    try {
      parsed = JSON.parse(raw)
    } catch {
      json = false // the header may still carry what the call cost
    }
    const { cost, basis } = costOf(res.headers.get('x-litellm-response-cost'), parsed, o.model, o.prices)
    const answer = parsed as { model?: unknown; choices?: Array<{ message?: { content?: unknown } }> } | null
    const served = typeof answer?.model === 'string' ? answer.model : null
    const content = Array.isArray(answer?.choices) ? answer.choices[0]?.message?.content : undefined
    const base = { served, cost_micro_usd: cost, cost_basis: basis, calls }
    if (!json) return { ...base, ok: false, text: null, reason: 'the response was not JSON' }
    if (typeof content !== 'string') return { ...base, ok: false, text: null, reason: 'the response carried no text' }
    return { ...base, ok: true, text: content, reason: null }
  }
  return failed(calls, lastStatus === null ? 'the endpoint did not answer' : `the endpoint answered HTTP ${lastStatus}`)
}
