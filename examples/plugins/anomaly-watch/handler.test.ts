import { describe, test, expect } from 'bun:test'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CapabilityContext } from 'warpline/unstable-capabilities'
import { OutputRecordSchema, OUTPUT_BODY_CAP_BYTES } from 'warpline/schemas/skill-result'
import { findAnomalies, handler } from './handler.js'
import { manifest } from './manifest.js'

describe('anomaly-watch findAnomalies', () => {
  test('flags above-direction breaches only when latest exceeds threshold', () => {
    const out = findAnomalies([
      { name: 'errors', latest: 42, threshold: 10, direction: 'above' },
      { name: 'ok', latest: 9, threshold: 10, direction: 'above' },
    ])
    expect(out.map(s => s.name)).toEqual(['errors'])
  })

  test('flags below-direction breaches only when latest undercuts threshold', () => {
    const out = findAnomalies([
      { name: 'signups', latest: 3, threshold: 5, direction: 'below' },
      { name: 'ok', latest: 6, threshold: 5, direction: 'below' },
    ])
    expect(out.map(s => s.name)).toEqual(['signups'])
  })

  test('equal to threshold is not a breach in either direction', () => {
    expect(findAnomalies([
      { name: 'a', latest: 10, threshold: 10, direction: 'above' },
      { name: 'b', latest: 10, threshold: 10, direction: 'below' },
    ])).toEqual([])
  })
})

const METRICS = {
  series: [
    { name: 'errors', latest: 42, threshold: 10, direction: 'above' },
    { name: 'signups', latest: 3, threshold: 5, direction: 'below' },
    { name: 'latency', latest: 90, threshold: 100, direction: 'above' },
  ],
}

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
  const home = await mkdtemp(join(tmpdir(), 'anomaly-watch-'))
  const realHome = process.env.WARPLINE_HOME
  process.env.WARPLINE_HOME = home
  try {
    return await fn(home)
  } finally {
    if (realHome === undefined) delete process.env.WARPLINE_HOME
    else process.env.WARPLINE_HOME = realHome
  }
}

async function seedMetrics(home: string): Promise<void> {
  await mkdir(join(home, 'state'), { recursive: true })
  await writeFile(join(home, 'state', 'metrics.json'), JSON.stringify(METRICS))
}

describe('anomaly-watch reads what it wrote', () => {
  test('the first run writes its observation and reports it as the first', async () => {
    await withHome(async (home) => {
      await seedMetrics(home)
      const result = await invoke({})

      expect(result.status).toBe('success')
      expect(result.summary).toContain('first observation')
      expect(result.summary).toContain('errors')
      expect(result.summary).toContain('signups')

      const written = JSON.parse(await readFile(join(home, 'state', 'anomaly-watch.last.json'), 'utf-8'))
      expect(written.breached).toEqual(['errors', 'signups'])
      expect(typeof written.observed_at).toBe('string')
    })
  })

  test('a second run in the same home reads the first and says something different', async () => {
    await withHome(async (home) => {
      await seedMetrics(home)
      const first = await invoke({})
      const second = await invoke({})

      expect(second.status).toBe('success')
      expect(second.summary).not.toBe(first.summary)
      expect(second.summary).not.toContain('first observation')
    })
  })

  test('a series that clears and one that newly breaches are both named against the prior run', async () => {
    await withHome(async (home) => {
      await seedMetrics(home)
      await invoke({})
      await writeFile(join(home, 'state', 'metrics.json'), JSON.stringify({
        series: [
          { name: 'errors', latest: 1, threshold: 10, direction: 'above' },
          { name: 'signups', latest: 3, threshold: 5, direction: 'below' },
          { name: 'latency', latest: 150, threshold: 100, direction: 'above' },
        ],
      }))
      const second = await invoke({})

      expect(second.summary).toMatch(/new: latency/)
      expect(second.summary).toMatch(/cleared: errors/)
    })
  })
})

describe('anomaly-watch produces an Output', () => {
  test('the success arm returns exactly one Output that parses at the boundary', async () => {
    await withHome(async (home) => {
      await seedMetrics(home)
      const result = await invoke({})

      expect(result.artifacts_produced).toHaveLength(1)
      const raw = result.artifacts_produced![0]
      expect(typeof raw).toBe('object')

      const parsed = OutputRecordSchema.parse(raw)
      expect(['markdown', 'json', 'html', 'text']).toContain(parsed.format)
      expect((parsed.body === undefined) !== (parsed.path === undefined)).toBe(true)
      expect(parsed.run_id).toBeUndefined()
      expect(parsed.produced_at).toBeUndefined()
    })
  })

  test('a body Output stays under the cap measured in UTF-8 bytes', async () => {
    await withHome(async (home) => {
      await seedMetrics(home)
      const result = await invoke({})
      const output = OutputRecordSchema.parse(result.artifacts_produced![0])

      expect(output.body).toBeDefined()
      expect(Buffer.byteLength(output.body!, 'utf8')).toBeLessThan(OUTPUT_BODY_CAP_BYTES)
      expect(JSON.parse(output.body!).breached.map((s: { name: string }) => s.name)).toEqual(['errors', 'signups'])
    })
  })
})

/**
 * `metrics_path` arrives from `<home>/config/anomaly-watch.json` and the
 * summary below is written into the run log on every run. Naming the path back
 * puts an operator-configured value into a document meant to be shareable, so
 * every arm names the input key and says nothing about what it was handed.
 *
 * The first sentinel is a path that does not exist, which is what makes the
 * no-metrics-file arm reachable at all. The second is a file that exists and
 * is not JSON, which is the arm a swallowed read error would misreport as
 * "no data yet".
 */
describe('anomaly-watch config value disclosure', () => {
  const SENTINEL = 'do-not-echo-d4e5f6'

  test('a missing metrics file reports nothing to check without naming the path', async () => {
    await withHome(async () => {
      const result = await invoke({ metrics_path: join(tmpdir(), SENTINEL, 'metrics.json') })

      expect(result.status).toBe('success')
      expect(result.artifacts_produced ?? []).toHaveLength(0)
      expect(JSON.stringify(result)).not.toContain(SENTINEL)
    })
  })

  test('an unreadable metrics file fails without naming the path', async () => {
    await withHome(async (home) => {
      const path = join(home, SENTINEL, 'metrics.json')
      await mkdir(join(home, SENTINEL), { recursive: true })
      await writeFile(path, 'not json')
      const result = await invoke({ metrics_path: path })

      expect(result.status).toBe('failed')
      expect(JSON.stringify(result)).not.toContain(SENTINEL)
    })
  })
})
