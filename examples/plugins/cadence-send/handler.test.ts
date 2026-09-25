import { describe, test, expect } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
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
 * `token: null` to run with the variable unset.
 */
async function withHome<T>(fn: (home: string) => Promise<T>, token: string | null = TOKEN): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'cadence-send-'))
  const saved = { WARPLINE_HOME: process.env.WARPLINE_HOME, CADENCE_MAIL_TOKEN: process.env.CADENCE_MAIL_TOKEN }
  process.env.WARPLINE_HOME = home
  if (token === null) delete process.env.CADENCE_MAIL_TOKEN
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

/**
 * A fetch stub recording every call. `answer(k)` gives the status of call k
 * (1-based), and may do work first, such as reading the ledger mid-run.
 */
function recorder(answer: (k: number) => number | Promise<number> = () => 202) {
  const calls: Call[] = []
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    const status = await answer(calls.length)
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

function invoke(record: OutputRecord | null, args: Record<string, unknown> = {}, signal = new AbortController().signal) {
  return handler(manifest, args, signal, contextWith(record))
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

async function ledgerPairs(home: string): Promise<[string, string][]> {
  try {
    return JSON.parse(await readFile(LEDGER(home), 'utf-8')).sent
  } catch {
    return []
  }
}

const failOn = (bad: number, status = 500) => (k: number) => (k === bad ? status : 202)
const sentTo = (calls: Call[]) => calls.map((c) => JSON.parse(String(c.init.body)).to)

describe('cadence-send stops at the first failure and retries only what is unrecorded', () => {
  test('a failure on the fourth email is partial, names that email by id, and leaves three pairs recorded', async () => {
    await withHome(async (home) => {
      const { impl, calls } = recorder(failOn(4))
      const result = await withFetch(impl, () => invoke(planOf(OUTBOX)))

      expect(result.status).toBe('partial')
      expect(calls).toHaveLength(4)
      expect(result.errors?.[0]?.retryable).toBe(false)
      expect(result.summary).toContain('c-4:1')
      expect(result.summary).not.toContain('c-4@example.com')
      expect(await ledgerPairs(home)).toEqual(OUTBOX.slice(0, 3).map((e) => [e.id, e.to]))
      expect(result.reversible).toBe(false)
      expect(result.undo_instruction).toContain('cadence-send.sent.json')
    })
  })

  test('the same record again sends exactly the two unrecorded emails', async () => {
    await withHome(async (home) => {
      const first = recorder(failOn(4))
      await withFetch(first.impl, () => invoke(planOf(OUTBOX)))
      expect(first.calls).toHaveLength(4)

      const retry = recorder()
      const result = await withFetch(retry.impl, () => invoke(planOf(OUTBOX)))
      expect(result.status).toBe('success')
      expect(retry.calls).toHaveLength(2)
      expect(sentTo(retry.calls)).toEqual(['c-4@example.com', 'c-5@example.com'])
      expect(result.summary).toContain('3 already sent')
      expect(await ledgerPairs(home)).toEqual(OUTBOX.map((e) => [e.id, e.to]))
    })
  })

  test('each email is recorded before the next is tried', async () => {
    await withHome(async (home) => {
      const seen: number[] = []
      const { impl } = recorder(async () => {
        seen.push((await ledgerPairs(home)).length)
        return 202
      })
      const result = await withFetch(impl, () => invoke(planOf(OUTBOX)))
      expect(result.status).toBe('success')
      expect(seen).toEqual([0, 1, 2, 3, 4])
    })
  })

  test('a failure on the first email fails the run and writes no ledger', async () => {
    await withHome(async (home) => {
      const { impl, calls } = recorder(failOn(1))
      const result = await withFetch(impl, () => invoke(planOf(OUTBOX)))
      expect(result.status).toBe('failed')
      expect(result.errors?.[0]?.code).toBe('dependency_unavailable')
      expect(calls).toHaveLength(1)
      await expect(stat(LEDGER(home))).rejects.toThrow()
    })
  })

  test('an abort after a send is partial with a non-retryable timeout, never a throw', async () => {
    await withHome(async () => {
      const aborting = new AbortController()
      let k = 0
      const impl = (async () => {
        k += 1
        if (k === 1) return { ok: true, status: 202, json: async () => ({}) }
        aborting.abort()
        throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
      }) as unknown as typeof fetch
      const result = await withFetch(impl, () => invoke(planOf(OUTBOX), {}, aborting.signal))
      expect(result.status).toBe('partial')
      expect(result.errors?.[0]?.code).toBe('timeout')
      expect(result.errors?.[0]?.retryable).toBe(false)
    })
  })

  test('a ledger that cannot be read is refused before anything is sent', async () => {
    await withHome(async (home) => {
      await mkdir(LEDGER(home), { recursive: true })
      const { impl, calls } = recorder()
      const result = await withFetch(impl, () => invoke(planOf(OUTBOX)))
      expect(result.status).toBe('failed')
      expect(result.errors?.[0]?.code).toBe('parse_error')
      expect(calls).toHaveLength(0)
    })
  })

  test.skipIf(process.getuid?.() === 0)('a ledger write that fails after a send is partial, and the handler does not throw', async () => {
    await withHome(async (home) => {
      const state = join(home, 'state')
      try {
        const { impl, calls } = recorder(async (k) => {
          if (k === 1) {
            await mkdir(state, { recursive: true })
            await chmod(state, 0o555)
          }
          return 202
        })
        const result = await withFetch(impl, () => invoke(planOf(OUTBOX)))
        expect(result.status).toBe('partial')
        expect(calls).toHaveLength(1)
        expect(result.errors?.[0]?.code).toBe('dependency_unavailable')
        expect(result.summary).toContain('could not record it in the send ledger')
      } finally {
        await chmod(state, 0o755).catch(() => {})
      }
    })
  })
})

describe('cadence-send has nothing to send', () => {
  test('an empty outbox succeeds with no call', async () => {
    await withHome(async () => {
      const { impl, calls } = recorder()
      const result = await withFetch(impl, () => invoke(planOf([])))
      expect(result.status).toBe('success')
      expect(calls).toHaveLength(0)
    })
  })

  test('no Output from cadence-plan yet succeeds with no call and says so', async () => {
    await withHome(async () => {
      const { impl, calls } = recorder()
      const result = await withFetch(impl, () => invoke(null))
      expect(result.status).toBe('success')
      expect(result.summary).toContain('cadence-plan')
      expect(calls).toHaveLength(0)
    })
  })

  test('an erased record, with no body, succeeds with no call', async () => {
    await withHome(async () => {
      const { impl, calls } = recorder()
      const erased: OutputRecord = { type: 'outbox', format: 'json', erased_at: '2026-01-06T00:00:00.000Z' } as OutputRecord
      const result = await withFetch(impl, () => invoke(erased))
      expect(result.status).toBe('success')
      expect(result.summary).toContain('no longer held')
      expect(calls).toHaveLength(0)
    })
  })

  test('a body that is not an outbox fails with no call', async () => {
    await withHome(async () => {
      const { impl, calls } = recorder()
      const result = await withFetch(impl, () => invoke({ type: 'outbox', format: 'json', body: '{"outbox": {}}' }))
      expect(result.status).toBe('failed')
      expect(result.errors?.[0]?.code).toBe('parse_error')
      expect(calls).toHaveLength(0)
    })
  })
})

describe('cadence-send can only send what it was shown', () => {
  test('every request body is an outbox entry, and the recipients are exactly the outbox\'s', async () => {
    await withHome(async () => {
      const varied = OUTBOX.map((e, i) => ({ ...e, subject: `Subject ${i}`, body: `Body ${i}` }))
      const { impl, calls } = recorder()
      await withFetch(impl, () => invoke(planOf(varied)))
      const allowed = varied.map(({ to, subject, body }) => ({ to, subject, body }))
      for (const call of calls) expect(allowed).toContainEqual(JSON.parse(String(call.init.body)))
      expect(new Set(sentTo(calls))).toEqual(new Set(varied.map((e) => e.to)))
    })
  })

  test('the manifest takes no contacts or template input and is content class', () => {
    expect(Object.keys(manifest.inputs)).toEqual(['api_base'])
    expect(manifest.dependencies).toEqual(['cadence-plan'])
    expect(manifest.approval_class).toBe('content')
    expect(manifest.side_effects).toEqual(['sends_email'])
    expect(manifest.llm_handoff).toBe(false)
  })
})

/**
 * The token goes into the authorization header and nowhere else. Presence at
 * the sink is asserted FIRST, then absence: absence alone is green when the
 * value never resolved at all.
 */
describe('cadence-send credentials', () => {
  test('a 401 on the first email fails the run with auth_failure naming the secret', async () => {
    await withHome(async () => {
      const { impl } = recorder(failOn(1, 401))
      const result = await withFetch(impl, () => invoke(planOf(OUTBOX)))
      expect(result.status).toBe('failed')
      expect(result.errors?.[0]?.code).toBe('auth_failure')
      expect(result.errors?.[0]?.message).toContain('CADENCE_MAIL_TOKEN')
    })
  })

  test('a 401 on the third email is partial with an auth_failure error', async () => {
    await withHome(async () => {
      const { impl, calls } = recorder(failOn(3, 401))
      const result = await withFetch(impl, () => invoke(planOf(OUTBOX)))
      expect(result.status).toBe('partial')
      expect(calls).toHaveLength(3)
      expect(result.errors?.[0]?.code).toBe('auth_failure')
    })
  })

  test('an unset or empty token is refused by name with no call', async () => {
    for (const token of [null, '']) {
      await withHome(async () => {
        const { impl, calls } = recorder()
        const result = await withFetch(impl, () => invoke(planOf(OUTBOX)))
        expect(result.status).toBe('failed')
        expect(result.errors?.[0]?.code).toBe('auth_failure')
        expect(result.summary).toContain('CADENCE_MAIL_TOKEN')
        expect(calls).toHaveLength(0)
      }, token)
    }
  })

  test('the token reaches the header, and never the result or the ledger, on every arm', async () => {
    await withHome(async (home) => {
      const results: Awaited<ReturnType<typeof invoke>>[] = []
      for (const answer of [failOn(1), failOn(3), () => 202]) {
        const { impl, calls } = recorder(answer)
        results.push(await withFetch(impl, () => invoke(planOf(OUTBOX))))
        expect((calls[0]!.init.headers as Record<string, string>)['authorization']).toBe(`Bearer ${TOKEN}`)
      }
      expect(results.map((r) => r.status)).toEqual(['failed', 'partial', 'success'])
      for (const result of results) {
        expect(JSON.stringify(result)).not.toContain(TOKEN)
        expect(JSON.stringify(result)).not.toContain('Bearer')
      }
      expect(await readFile(LEDGER(home), 'utf-8')).not.toContain(TOKEN)
    })
  })
})

/** `api_base` is a configured value and every summary lands in the run log. */
describe('cadence-send config value disclosure', () => {
  const SENTINEL = 'https://do-not-echo-3b7c.example.com/v1'

  test('a configured endpoint never reaches the result, whether it answered, refused or threw', async () => {
    const throwing = (async (url: string | URL | Request) => {
      throw new TypeError(`Unable to connect to ${String(url)}`)
    }) as unknown as typeof fetch
    const results: Awaited<ReturnType<typeof invoke>>[] = []
    // A fresh home per arm, so no arm finds the previous one's ledger.
    for (const answer of [() => 202, failOn(2)]) {
      await withHome(async () => {
        const { impl, calls } = recorder(answer)
        results.push(await withFetch(impl, () => invoke(planOf(OUTBOX), { api_base: SENTINEL })))
        expect(calls[0]!.url).toBe(`${SENTINEL}/send`)
      })
    }
    await withHome(async () => {
      results.push(await withFetch(throwing, () => invoke(planOf(OUTBOX), { api_base: SENTINEL })))
    })

    expect(results.map((r) => r.status)).toEqual(['success', 'partial', 'failed'])
    for (const result of results) expect(JSON.stringify(result)).not.toContain('do-not-echo')
  })
})
