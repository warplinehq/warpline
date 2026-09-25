import { describe, test, expect } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CapabilityContext, DependenciesHandle } from 'warpline/unstable-capabilities'
import type { OutputRecord } from 'warpline/schemas/skill-result'
import { handler } from './handler.js'
import { manifest } from './manifest.js'

type RunStatus = ReturnType<DependenciesHandle['lastRun']>

/**
 * The fourth parameter, hand-built. An example may not import `src/`, so the
 * runtime's mint is out of reach on purpose: this file proves the handler does
 * the right thing with what it is handed, and the delivery is proven under
 * `src/`. Both members throw for any name but `cadence-plan`, the way the
 * runtime refuses an undeclared name.
 */
function contextWith(record: OutputRecord | null, run: RunStatus = record === null ? null : 'success'): CapabilityContext {
  const declared = (name: string): void => {
    if (name !== 'cadence-plan') throw new Error(`cadence-send does not declare '${name}' in manifest.dependencies`)
  }
  return {
    caller: { plugin: 'cadence-send' },
    secrets: { resolvedNames: () => [] },
    dependencies: {
      lastOutput: (_caller, name: string) => {
        declared(name)
        return record
      },
      lastRun: (_caller, name: string) => {
        declared(name)
        return run
      },
    },
  } as CapabilityContext
}

const TOKEN = 'cadence-send-token-8d1a'
const API_BASE = 'https://mail.example.com/v1'

/**
 * A throwaway home with the token set, both restored in `finally`. Pass
 * `token: undefined` to run with the variable unset.
 */
async function withHome<T>(fn: (home: string) => Promise<T>, token: string | undefined = TOKEN): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'cadence-send-'))
  const saved = { WARPLINE_HOME: process.env.WARPLINE_HOME, CADENCE_MAIL_TOKEN: process.env.CADENCE_MAIL_TOKEN }
  process.env.WARPLINE_HOME = home
  if (token === undefined) delete process.env.CADENCE_MAIL_TOKEN
  else process.env.CADENCE_MAIL_TOKEN = token
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

/** A fetch stub recording every call; `answer(k)` gives the status of call k (1-based). */
function recorder(answer: (k: number) => number = () => 202) {
  const calls: Call[] = []
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    const status = answer(calls.length)
    return { ok: status >= 200 && status < 300, status, json: async () => ({}) }
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

const DUE_AT = '2026-01-05T09:00:00.000Z'

/** The five-email outbox cadence-plan's own test asserts, written out email by email. */
const OUTBOX = [
  { id: 'c-1:1', contact_id: 'c-1', step: 1, to: 'c-1@example.com', subject: 'Hello', body: 'First note', due_at: DUE_AT },
  { id: 'c-2:1', contact_id: 'c-2', step: 1, to: 'c-2@example.com', subject: 'Hello', body: 'First note', due_at: DUE_AT },
  { id: 'c-3:1', contact_id: 'c-3', step: 1, to: 'c-3@example.com', subject: 'Hello', body: 'First note', due_at: DUE_AT },
  { id: 'c-4:1', contact_id: 'c-4', step: 1, to: 'c-4@example.com', subject: 'Hello', body: 'First note', due_at: DUE_AT },
  { id: 'c-5:1', contact_id: 'c-5', step: 1, to: 'c-5@example.com', subject: 'Hello', body: 'First note', due_at: DUE_AT },
]

const planOf = (outbox: unknown[]): OutputRecord => ({ type: 'outbox', format: 'json', body: JSON.stringify({ outbox, review_tasks: [] }) })

function invoke(record: OutputRecord | null, args: Record<string, unknown> = {}) {
  return handler(manifest, args, new AbortController().signal, contextWith(record))
}

const LEDGER = (home: string) => join(home, 'state', 'cadence-send.sent.json')

describe('cadence-send sends the approved outbox', () => {
  test('an approved outbox becomes one POST per email and a ledger of what went out', async () => {
    await withHome(async (home) => {
      const { impl, calls } = recorder()
      const result = await withFetch(impl, () => invoke(planOf(OUTBOX)))

      expect(result.status).toBe('success')
      expect(calls).toHaveLength(5)
      for (const call of calls) {
        expect(call.url).toBe(`${API_BASE}/send`)
        expect(call.init.method).toBe('POST')
        expect((call.init.headers as Record<string, string>)['authorization']).toBe(`Bearer ${TOKEN}`)
      }
      expect(calls.map((c) => JSON.parse(String(c.init.body)))).toEqual(
        OUTBOX.map(({ to, subject, body }) => ({ to, subject, body })),
      )
      expect(calls.map((c) => JSON.parse(String(c.init.body)).to)).toEqual(OUTBOX.map((e) => e.to))

      const ledger = JSON.parse(await readFile(LEDGER(home), 'utf-8'))
      expect(ledger.sent).toEqual(OUTBOX.map((e) => [e.id, e.to]))

      const serialised = JSON.stringify(result)
      expect(serialised).not.toContain(TOKEN)
      expect(serialised).not.toContain('Bearer')
    })
  })
})
