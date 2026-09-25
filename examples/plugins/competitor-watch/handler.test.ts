import { describe, test, expect } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CapabilityContext } from 'warpline/unstable-capabilities'
import { handler } from './handler.js'
import { manifest } from './manifest.js'

/** The handler is four-parameter; a test hands it a context it never reads. */
const CONTEXT = {} as CapabilityContext

function invoke(args: Record<string, unknown>, signal = new AbortController().signal) {
  return handler(manifest, args, signal, CONTEXT)
}

/**
 * A fresh home per case, removed afterwards. The snapshot lives under the
 * home, so a shared one would let one case compare against what another wrote.
 */
async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'warpline-competitor-watch-home-'))
  const realHome = process.env.WARPLINE_HOME
  process.env.WARPLINE_HOME = home
  try {
    return await fn(home)
  } finally {
    if (realHome === undefined) delete process.env.WARPLINE_HOME
    else process.env.WARPLINE_HOME = realHome
    await rm(home, { recursive: true, force: true })
  }
}

/** Swap `globalThis.fetch` for `stub` and restore the real one whatever happens. */
async function withFetch<T>(stub: (input: unknown, init?: RequestInit) => Promise<unknown>, body: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch
  globalThis.fetch = stub as unknown as typeof fetch
  try {
    return await body()
  } finally {
    globalThis.fetch = realFetch
  }
}

interface Reply {
  ok: boolean
  status: number
  body?: string
}

/** A stub keyed by URL that records every call. An unknown URL throws the way a failed connection does. */
function recorder(replies: Record<string, Reply>) {
  const calls: { url: string; init?: RequestInit }[] = []
  const impl = async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    const reply = replies[url]
    if (!reply) throw new TypeError(`Unable to connect to ${url}`)
    return { ok: reply.ok, status: reply.status, text: async () => reply.body ?? '' }
  }
  return { calls, impl }
}

const ONE = 'https://watch.example.test/one'
const TWO = 'https://watch.example.test/two'
const THREE = 'https://watch.example.test/three'
const TARGETS = [ONE, TWO, THREE]

/** A page body. Each one carries a link elsewhere, which the handler must never follow. */
const page = (...lines: string[]) =>
  ['<feed>', '<link href="https://elsewhere.example.test/x"/>', ...lines, '</feed>'].join('\n')

const ok = (body: string): Reply => ({ ok: true, status: 200, body })

const snapshotPath = (home: string) => join(home, 'state', `${manifest.name}.last.json`)

interface ReportEntry {
  position: number
  status: 'new' | 'changed' | 'unchanged' | 'failed'
  diff?: string[]
  diff_truncated?: boolean
  reason?: string
}

/** The report the run returned as its one inline Output. */
function report(result: { artifacts_produced?: unknown[] }): ReportEntry[] {
  const output = (result.artifacts_produced ?? [])[0] as { body?: string; format?: string; type?: string }
  expect(output.type).toBe('report')
  expect(output.format).toBe('json')
  return (JSON.parse(output.body ?? '') as { targets: ReportEntry[] }).targets
}

describe('competitor-watch reports what changed since the last run', () => {
  test('a first run in a fresh home reports every target new and keeps a snapshot of each', async () => {
    await withHome(async (home) => {
      const { impl } = recorder({ [ONE]: ok(page('v1.0.0')), [TWO]: ok(page('v2.0.0')), [THREE]: ok(page('v3.0.0')) })
      const result = await withFetch(impl, () => invoke({ targets: TARGETS }))

      expect(result.status).toBe('success')
      expect(report(result)).toEqual([
        { position: 1, status: 'new' },
        { position: 2, status: 'new' },
        { position: 3, status: 'new' },
      ])
      const snapshot = JSON.parse(await readFile(snapshotPath(home), 'utf-8')) as Record<string, unknown>
      expect(Object.keys(snapshot)).toEqual(TARGETS)
      for (const text of Object.values(snapshot)) expect(typeof text).toBe('string')
    })
  })

  test('a second run reports changed with a diff, unchanged, and failed, and is still a success', async () => {
    await withHome(async (home) => {
      const first = recorder({ [ONE]: ok(page('v1.0.0')), [TWO]: ok(page('v2.0.0')), [THREE]: ok(page('v3.0.0')) })
      await withFetch(first.impl, () => invoke({ targets: TARGETS }))
      const before = JSON.parse(await readFile(snapshotPath(home), 'utf-8')) as Record<string, string>

      const second = recorder({
        [ONE]: ok(page('v1.0.1', 'v1.0.0')),
        [TWO]: ok(page('v2.0.0')),
        [THREE]: { ok: false, status: 500 },
      })
      const result = await withFetch(second.impl, () => invoke({ targets: TARGETS }))

      // One failing target is isolated from the rest: plain success, the
      // failure carried per target and in `errors`, never a red run.
      expect(result.status).toBe('success')
      const entries = report(result)
      expect(entries.map((e) => [e.position, e.status])).toEqual([[1, 'changed'], [2, 'unchanged'], [3, 'failed']])
      expect(entries[0]!.diff).toContain('+ v1.0.1')
      expect(entries[0]!.diff_truncated).toBe(false)
      expect(entries[2]!.reason).toBe('HTTP 500')
      expect(result.errors?.map((e) => e.message)).toEqual(['target 3: HTTP 500'])
      expect(result.summary).toContain('1 changed')

      // The failed target keeps what the last good fetch saw.
      const after = JSON.parse(await readFile(snapshotPath(home), 'utf-8')) as Record<string, string>
      expect(after[THREE]).toBe(before[THREE]!)
      expect(after[ONE]).not.toBe(before[ONE]!)
    })
  })

  test('only the declared targets are fetched, in order, and every request refuses a redirect', async () => {
    await withHome(async () => {
      const { calls, impl } = recorder({ [ONE]: ok(page('a')), [TWO]: ok(page('b')), [THREE]: ok(page('c')) })
      const result = await withFetch(impl, () => invoke({ targets: TARGETS }))

      expect(result.status).toBe('success')
      // Every body carries a link to elsewhere.example.test; none is followed.
      expect(calls.map((c) => c.url)).toEqual(TARGETS)
      for (const call of calls) expect(call.init?.redirect).toBe('error')
    })
  })
})
