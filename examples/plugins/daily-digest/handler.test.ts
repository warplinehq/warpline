import { describe, test, expect } from 'bun:test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CapabilityContext } from 'warpline/unstable-capabilities'
import { OutputRecordSchema } from 'warpline/schemas/skill-result'
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
  const home = await mkdtemp(join(tmpdir(), 'daily-digest-'))
  const realHome = process.env.WARPLINE_HOME
  process.env.WARPLINE_HOME = home
  try {
    return await fn(home)
  } finally {
    if (realHome === undefined) delete process.env.WARPLINE_HOME
    else process.env.WARPLINE_HOME = realHome
  }
}

/** What a chaining host drops for each producer, in the shape its Output carries. */
const ANOMALIES = {
  anomalies: [
    { name: 'errors', latest: 42, threshold: 10, direction: 'above' },
    { name: 'signups', latest: 3, threshold: 5, direction: 'below' },
  ],
}
const ISSUES = { observed_at: '2026-01-01T00:00:00.000Z', open_count: 7, newest_number: 12 }

async function seed(home: string, rel: string, value: unknown): Promise<void> {
  await mkdir(join(home, 'state'), { recursive: true })
  await writeFile(join(home, rel), typeof value === 'string' ? value : JSON.stringify(value))
}

describe('daily-digest aggregates its declared dependencies', () => {
  test('both upstream results present: one digest naming both sources, and exactly one Output', async () => {
    await withHome(async (home) => {
      await seed(home, 'state/anomalies.json', ANOMALIES)
      await seed(home, 'state/github-issues.json', ISSUES)
      const result = await invoke({})

      expect(result.status).toBe('success')
      expect(result.summary).toContain('anomaly-watch')
      expect(result.summary).toContain('github-poll')
      expect(result.summary).toContain('2 breached')
      expect(result.summary).toContain('7 open issues')
      expect(result.artifacts_produced).toHaveLength(1)
      const output = OutputRecordSchema.parse(result.artifacts_produced?.[0])
      expect(output.body).toBeDefined()
      expect(output.path).toBeUndefined()
      expect(Buffer.byteLength(output.body!, 'utf8')).toBeLessThanOrEqual(16_384)
    })
  })

  test('one upstream result absent: the digest still returns and says which source had nothing', async () => {
    await withHome(async (home) => {
      await seed(home, 'state/anomalies.json', ANOMALIES)
      const result = await invoke({})

      // A missing upstream is not a failure of the digest. The source that had
      // nothing is named, so the digest does not read as complete when it is not.
      expect(result.status).toBe('success')
      expect(result.summary).toContain('2 breached')
      expect(result.summary).toMatch(/github-poll: nothing/)
      expect(result.artifacts_produced).toHaveLength(1)
    })
  })

  test('no upstream results at all: a prefixed skip, never a bare skipped, and no digest claimed', async () => {
    await withHome(async () => {
      const result = await invoke({})

      // A prefix-less `skipped` is persisted as `failed`, so the arm is a
      // success in status — but it produces NO Output: an empty digest must
      // not enter the engine's last_output as though a day had been digested.
      expect(result.status).not.toBe('skipped')
      expect(result.status).toBe('success')
      expect(result.summary.startsWith(`${manifest.name}:`)).toBe(true)
      expect(result.summary).toContain('nothing to digest')
      expect(result.artifacts_produced ?? []).toHaveLength(0)
    })
  })

  test('the digest Output is the LAST element of artifacts_produced, because the engine takes .at(-1)', async () => {
    await withHome(async (home) => {
      await seed(home, 'state/anomalies.json', ANOMALIES)
      await seed(home, 'state/github-issues.json', ISSUES)
      const result = await invoke({})

      const last = result.artifacts_produced?.at(-1)
      expect(last).toBeDefined()
      const output = OutputRecordSchema.parse(last)
      expect(output.type).toBe('digest')
      const body = JSON.parse(output.body!)
      expect(Object.keys(body.sources).sort()).toEqual(['anomaly-watch', 'github-poll'])
      expect(body.sources['github-poll'].open_count).toBe(7)
    })
  })

  test('an upstream file that exists but is not JSON is a failure naming the key, not "nothing yet"', async () => {
    await withHome(async (home) => {
      await seed(home, 'state/anomalies.json', 'not json')
      const result = await invoke({})

      expect(result.status).toBe('failed')
      expect(result.summary).toContain('anomalies_path')
    })
  })
})

/**
 * Both paths arrive from `<home>/config/daily-digest.json` and every summary
 * lands in the run log, so no arm names the value it was handed. The absent
 * arm and the unreadable arm are both driven with a sentinel path.
 */
describe('daily-digest config value disclosure', () => {
  const SENTINEL = 'do-not-echo-d1g3st'

  test('a configured path never reaches the result, on either arm', async () => {
    await withHome(async (home) => {
      const missing = await invoke({
        anomalies_path: join(tmpdir(), SENTINEL, 'anomalies.json'),
        issues_path: join(tmpdir(), SENTINEL, 'issues.json'),
      })
      expect(missing.status).toBe('success')
      expect(JSON.stringify(missing)).not.toContain(SENTINEL)

      const path = join(home, SENTINEL, 'anomalies.json')
      await mkdir(join(home, SENTINEL), { recursive: true })
      await writeFile(path, 'not json')
      const unreadable = await invoke({ anomalies_path: path })
      expect(unreadable.status).toBe('failed')
      expect(JSON.stringify(unreadable)).not.toContain(SENTINEL)
    })
  })
})
