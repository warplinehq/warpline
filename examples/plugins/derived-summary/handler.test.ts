import { describe, test, expect } from 'bun:test'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CapabilityContext } from 'warpline/unstable-capabilities'
import { handler } from './handler.js'
import { manifest } from './manifest.js'

/** The handler is four-parameter; a test hands it a context it never reads. */
const CONTEXT = {} as CapabilityContext

function invoke(args: Record<string, unknown>) {
  return handler(manifest, args, new AbortController().signal, CONTEXT)
}

/**
 * `warpline/lib/paths` exports only `warplineHome`, which resolves
 * `WARPLINE_HOME` per call — the same seam a plugin author has. Each test
 * below gets its own home and restores the suite's afterwards.
 */
async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'derived-summary-'))
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

/**
 * The whole home as `path|bytes|contents`, sorted. A full recursive walk with
 * no exclusion list, because the moment a path is named as "expected to
 * change" the test stops proving that nothing changed. Contents inline rather
 * than hashed: a test home holds a few hundred bytes, and `examples/` may not
 * reach for `node:crypto`.
 */
async function snapshot(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      out.push(...(await snapshot(join(dir, entry.name), rel)))
    } else {
      const bytes = await readFile(join(dir, entry.name))
      out.push(`${rel}|${bytes.byteLength}|${bytes.toString('base64')}`)
    }
  }
  return out.sort()
}

const METRICS = {
  series: [
    { name: 'errors', latest: 42, threshold: 10, direction: 'above' },
    { name: 'signups', latest: 3, threshold: 5, direction: 'below' },
    { name: 'latency', latest: 90, threshold: 100, direction: 'above' },
  ],
}

async function seedMetrics(home: string, metrics: unknown = METRICS): Promise<void> {
  await mkdir(join(home, 'state'), { recursive: true })
  await writeFile(join(home, 'state', 'metrics.json'), JSON.stringify(metrics))
}

describe('derived-summary derives and stores nothing', () => {
  test('a source under the home is summarised and the whole home is byte-identical afterwards', async () => {
    await withHome(async (home) => {
      await seedMetrics(home)
      const before = await snapshot(home)
      const result = await invoke({})
      const after = await snapshot(home)

      expect(result.status).toBe('success')
      expect(result.summary).toContain('3 series')
      expect(result.summary).toContain('2 breached')
      expect(result.summary).toContain('errors')
      expect(result.summary).toContain('signups')
      expect(after).toEqual(before)
    })
  })

  test('the answer is a function of the source: same source, same answer; changed source, changed answer', async () => {
    await withHome(async (home) => {
      await seedMetrics(home)
      const first = await invoke({})
      const second = await invoke({})
      expect(second.summary).toBe(first.summary)

      await seedMetrics(home, {
        series: [
          { name: 'errors', latest: 1, threshold: 10, direction: 'above' },
          { name: 'signups', latest: 3, threshold: 5, direction: 'below' },
          { name: 'latency', latest: 90, threshold: 100, direction: 'above' },
        ],
      })
      const third = await invoke({})
      expect(third.summary).not.toBe(first.summary)
      expect(third.summary).toContain('1 breached')
      expect(await snapshot(home)).toHaveLength(1)
    })
  })

  test('no source is a prefixed skip on the success arm, never a bare skipped', async () => {
    await withHome(async () => {
      const result = await invoke({})

      // A prefix-less `skipped` is persisted as `failed`, which paints a red
      // run for a plugin that simply has nothing to summarise yet.
      expect(result.status).not.toBe('skipped')
      expect(result.status).toBe('success')
      expect(result.summary.startsWith(`${manifest.name}:`)).toBe(true)
      expect(result.summary).toContain('nothing to summarise')
    })
  })

  test('a source that exists but is not JSON is a failure, not "no data yet"', async () => {
    await withHome(async (home) => {
      await mkdir(join(home, 'state'), { recursive: true })
      await writeFile(join(home, 'state', 'metrics.json'), 'not json')
      const result = await invoke({})

      expect(result.status).toBe('failed')
      expect(result.summary).toContain("source_path")
    })
  })
})

/**
 * `source_path` arrives from `<home>/config/derived-summary.json` and every
 * summary lands in the run log, so no arm names the value it was handed.
 * The absolute sentinel path exercises the ENOENT arm outside the home; the
 * in-home one exercises the unreadable arm.
 */
describe('derived-summary config value disclosure', () => {
  const SENTINEL = 'do-not-echo-a1b2c3'

  test('a configured path never reaches the result, on either arm', async () => {
    await withHome(async (home) => {
      const missing = await invoke({ source_path: join(tmpdir(), SENTINEL, 'metrics.json') })
      expect(missing.status).toBe('success')
      expect(JSON.stringify(missing)).not.toContain(SENTINEL)

      const path = join(home, SENTINEL, 'metrics.json')
      await mkdir(join(home, SENTINEL), { recursive: true })
      await writeFile(path, 'not json')
      const unreadable = await invoke({ source_path: path })
      expect(unreadable.status).toBe('failed')
      expect(JSON.stringify(unreadable)).not.toContain(SENTINEL)
    })
  })
})
