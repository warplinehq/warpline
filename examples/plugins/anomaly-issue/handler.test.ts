import { describe, test, expect } from 'bun:test'
import { pending, issueFor, fileIssues, type Anomaly } from './handler.js'

const errors: Anomaly = { name: 'errors', latest: 42, threshold: 10, direction: 'above' }
const signups: Anomaly = { name: 'signups', latest: 3, threshold: 5, direction: 'below' }

describe('anomaly-issue pending', () => {
  test('drops anomalies already in the ledger', () => {
    expect(pending([errors, signups], { errors: 'https://github.com/o/r/issues/1' })).toEqual([signups])
  })

  test('returns all anomalies for an empty ledger', () => {
    expect(pending([errors, signups], {})).toEqual([errors, signups])
  })
})

describe('anomaly-issue issueFor', () => {
  test('renders the fixed title and a four-row table body', () => {
    const { title, body } = issueFor(errors)
    expect(title).toBe('[anomaly] errors: 42 above threshold 10')
    expect(body).toContain('| name | errors |')
    expect(body).toContain('| latest | 42 |')
    expect(body).toContain('| threshold | 10 |')
    expect(body).toContain('| direction | above |')
  })
})

type Call = { url: string; init: RequestInit }

function fakeFetch(responses: { ok: boolean; status: number; html_url?: string }[]) {
  const calls: Call[] = []
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    const r = responses[calls.length - 1] ?? { ok: false, status: 500 }
    return { ok: r.ok, status: r.status, json: async () => ({ html_url: r.html_url }) }
  }) as unknown as typeof fetch
  return { calls, impl }
}

describe('anomaly-issue fileIssues', () => {
  const signal = new AbortController().signal

  test('POSTs one issue per anomaly with the token in the authorization header', async () => {
    const { calls, impl } = fakeFetch([
      { ok: true, status: 201, html_url: 'https://github.com/o/r/issues/1' },
      { ok: true, status: 201, html_url: 'https://github.com/o/r/issues/2' },
    ])
    const out = await fileIssues('o/r', [errors, signups], 'tok-123', impl, signal)

    expect(calls).toHaveLength(2)
    expect(calls[0]?.url).toBe('https://api.github.com/repos/o/r/issues')
    expect(calls[0]?.init.method).toBe('POST')
    expect(calls[0]?.init.signal).toBe(signal)
    expect(calls[0]?.init.headers).toEqual({
      accept: 'application/vnd.github+json',
      authorization: 'Bearer tok-123',
      'user-agent': 'warpline-example',
      'content-type': 'application/json',
    })
    expect(calls[0]?.init.body).toBe(JSON.stringify(issueFor(errors)))
    expect(out).toEqual({
      created: [
        { name: 'errors', url: 'https://github.com/o/r/issues/1' },
        { name: 'signups', url: 'https://github.com/o/r/issues/2' },
      ],
      error: null,
    })
  })

  test('stops at the first non-ok response with a non-retryable error', async () => {
    const { calls, impl } = fakeFetch([
      { ok: true, status: 201, html_url: 'https://github.com/o/r/issues/1' },
      { ok: false, status: 500 },
    ])
    const third: Anomaly = { name: 'latency', latest: 9, threshold: 1, direction: 'above' }
    const out = await fileIssues('o/r', [errors, signups, third], 'tok-123', impl, signal)

    expect(calls).toHaveLength(2)
    expect(out.created).toHaveLength(1)
    expect(out.error?.code).toBe('dependency_unavailable')
    expect(out.error?.retryable).toBe(false)
    expect(out.error?.message).toContain('500')
    expect(out.error?.message).toContain('signups')
  })

  test('401 and 403 are auth failures', async () => {
    const { impl } = fakeFetch([{ ok: false, status: 401 }])
    const out = await fileIssues('o/r', [errors], 'tok-123', impl, signal)
    expect(out.created).toEqual([])
    expect(out.error?.code).toBe('auth_failure')
    expect(out.error?.retryable).toBe(false)
  })
})
