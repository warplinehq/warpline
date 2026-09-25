import { describe, test, expect } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CapabilityContext } from 'warpline/unstable-capabilities'
import { diffLines, handler, normalise } from './handler.js'
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

/** `node:fs/promises` is the only fs specifier an example test may reach for. */
const exists = (path: string) => stat(path).then(() => true, () => false)

/** Put a snapshot in place by hand, the way an operator's edit or a torn write would. */
async function seedSnapshot(home: string, content: string): Promise<void> {
  await mkdir(join(home, 'state'), { recursive: true })
  await writeFile(snapshotPath(home), content)
}

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

describe('competitor-watch', () => {
  test('normalise folds line endings, trims each line, collapses inner whitespace and drops empty lines', () => {
    expect(normalise('a  b\r\n\r\n  c\t\td  \r')).toBe('a b\nc d')
  })

  test('a body that differs only in line endings and spacing reports unchanged', async () => {
    await withHome(async () => {
      const lines = ['<entry>', '<title>release v1.2.3 is out</title>', '</entry>']
      const first = recorder({ [ONE]: ok(lines.join('\n')) })
      await withFetch(first.impl, () => invoke({ targets: [ONE] }))

      // CRLF endings, blank lines between, inner spaces doubled, edges padded.
      const noisy = lines.map((l) => `  ${l.replaceAll(' ', '  ')}\t`).join('\r\n\r\n') + '\r\n'
      const second = recorder({ [ONE]: ok(noisy) })
      const result = await withFetch(second.impl, () => invoke({ targets: [ONE] }))

      expect(result.status).toBe('success')
      expect(report(result)).toEqual([{ position: 1, status: 'unchanged' }])
    })
  })

  test('a repeated target is refused by position before any fetch', async () => {
    await withHome(async (home) => {
      const { calls, impl } = recorder({ [ONE]: ok('a'), [TWO]: ok('b') })
      const result = await withFetch(impl, () => invoke({ targets: [ONE, TWO, ONE] }))

      expect(result.status).toBe('failed')
      expect(result.errors?.[0]?.code).toBe('parse_error')
      expect(result.errors?.[0]?.message).toContain('positions 1 and 3')
      // Located without being echoed.
      expect(JSON.stringify(result)).not.toContain(ONE)
      expect(calls).toHaveLength(0)
      expect(await exists(snapshotPath(home))).toBe(false)
    })
  })

  test('every target failing is a failed run, and no snapshot is written', async () => {
    await withHome(async (home) => {
      const down: Reply = { ok: false, status: 500 }
      const { impl } = recorder({ [ONE]: down, [TWO]: down, [THREE]: down })
      const result = await withFetch(impl, () => invoke({ targets: TARGETS }))

      expect(result.status).toBe('failed')
      expect(result.errors?.[0]?.code).toBe('dependency_unavailable')
      expect(result.summary).toContain('target 1: HTTP 500')
      expect(await exists(snapshotPath(home))).toBe(false)
    })
  })

  test('diffLines keeps at most maxLines and says when it cut', () => {
    const before = Array.from({ length: 50 }, (_, i) => `old ${i}`).join('\n')
    const after = Array.from({ length: 50 }, (_, i) => `new ${i}`).join('\n')
    const { lines, truncated } = diffLines(before, after, 5)
    expect(lines).toHaveLength(5)
    expect(truncated).toBe(true)
    expect(lines[0]).toBe('- old 0')
  })

  test('diffLines cuts a long line to 200 characters, prefix included', () => {
    const { lines, truncated } = diffLines('keep\nshort', `keep\n${'x'.repeat(300)}`, 20)
    expect(truncated).toBe(false)
    expect(lines).toEqual(['- short', `+ ${'x'.repeat(198)}`])
    expect(lines[1]).toHaveLength(200)
  })

  test('diffLines drops the common head and tail and reports only the hunk between', () => {
    expect(diffLines('a\nb\nc\nd', 'a\nB\nc\nd', 10)).toEqual({ lines: ['- b', '+ B'], truncated: false })
  })

  test('a report over the Output cap fails by name, and the snapshot is left as it was', async () => {
    await withHome(async (home) => {
      const targets = Array.from({ length: 10 }, (_, i) => `https://watch.example.test/page-${i}`)
      // A prior snapshot, so every target can report changed.
      const prior = JSON.stringify(Object.fromEntries(targets.map((t) => [t, 'base'])))
      await seedSnapshot(home, prior)
      const block = (k: number) => Array.from({ length: 200 }, (_, n) => `added line ${n} of target ${k}`)
      const { impl } = recorder(Object.fromEntries(targets.map((t, k) => [t, ok(['base', ...block(k)].join('\n'))])))
      const result = await withFetch(impl, () => invoke({ targets, max_diff_lines: 200 }))

      expect(result.status).toBe('failed')
      expect(result.errors?.[0]?.message).toContain('16384-byte Output cap')
      expect(await readFile(snapshotPath(home), 'utf-8')).toBe(prior)
    })
  })

  for (const [label, content] of [['not in the shape it writes', '{"x": 1}'], ['not JSON', 'not json at all']] as const) {
    test(`a last snapshot that is ${label} is refused before any fetch`, async () => {
      await withHome(async (home) => {
        await seedSnapshot(home, content)
        const { calls, impl } = recorder({ [ONE]: ok('a') })
        const result = await withFetch(impl, () => invoke({ targets: [ONE] }))

        expect(result.status).toBe('failed')
        expect(result.errors?.[0]?.code).toBe('parse_error')
        expect(result.errors?.[0]?.message).toContain('last snapshot')
        expect(calls).toHaveLength(0)
        expect(await readFile(snapshotPath(home), 'utf-8')).toBe(content)
      })
    })
  }

  test('an unusable max_diff_lines is refused by key', async () => {
    await withHome(async () => {
      const { calls, impl } = recorder({ [ONE]: ok('a') })
      const result = await withFetch(impl, () => invoke({ targets: [ONE], max_diff_lines: 0 }))

      expect(result.status).toBe('failed')
      expect(result.errors?.[0]?.message).toContain("input 'max_diff_lines'")
      expect(calls).toHaveLength(0)
    })
  })
})

/**
 * `targets` arrives from `<home>/config/competitor-watch.json`, a URL can
 * carry a token, and every field of the result lands in a run log. Each
 * sentinel is shaped to pass the guard above the arm it targets: a non-URL
 * string for the input check, a valid URL for the three arms past it.
 */
describe('competitor-watch config value disclosure', () => {
  const SENTINEL = 'do-not-echo-5e1f07'
  const sentinelUrl = `https://${SENTINEL}.test/page`
  const refuse = async (input: unknown) => { throw new TypeError(`Unable to connect to ${String(input)}`) }

  test('an invalid target is refused without the value appearing anywhere in the result', async () => {
    const result = await invoke({ targets: [SENTINEL] })

    expect(result.status).toBe('failed')
    expect(result.errors?.[0]?.code).toBe('parse_error')
    expect(result.errors?.[0]?.message).toContain("input 'targets'")
    expect(JSON.stringify(result)).not.toContain(SENTINEL)
  })

  test('a successful run reports by position, never by the URL it fetched', async () => {
    await withHome(async () => {
      const { impl } = recorder({ [sentinelUrl]: ok('a'), [TWO]: ok('b') })
      const result = await withFetch(impl, () => invoke({ targets: [sentinelUrl, TWO] }))

      expect(result.status).toBe('success')
      expect(JSON.stringify(result)).not.toContain(SENTINEL)
    })
  })

  test('a target whose fetch throws is failed without forwarding the message that names it', async () => {
    await withHome(async () => {
      const { impl: others } = recorder({ [TWO]: ok('b') })
      const stub = (input: unknown, init?: RequestInit) => String(input) === sentinelUrl ? refuse(input) : others(input, init)
      const result = await withFetch(stub, () => invoke({ targets: [sentinelUrl, TWO] }))

      expect(result.status).toBe('success')
      expect(report(result)[0]).toEqual({ position: 1, status: 'failed', reason: 'request failed' })
      expect(JSON.stringify(result)).not.toContain(SENTINEL)
    })
  })

  test('every target failing is reported without the URLs', async () => {
    await withHome(async () => {
      const result = await withFetch(refuse, () => invoke({ targets: [sentinelUrl, `https://${SENTINEL}.test/other`] }))

      expect(result.status).toBe('failed')
      expect(result.errors?.[0]?.code).toBe('dependency_unavailable')
      expect(JSON.stringify(result)).not.toContain(SENTINEL)
    })
  })
})
