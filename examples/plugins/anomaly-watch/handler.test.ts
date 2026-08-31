import { describe, test, expect } from 'bun:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginManifest } from 'warpline/schemas/plugin-manifest'
import { findAnomalies, handler } from './handler.js'

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

/**
 * `metrics_path` arrives from `<home>/config/anomaly-watch.json` and the
 * summary below is written into the run log on every run. Naming the path back
 * puts an operator-configured value into a document meant to be shareable, so
 * the arm names the input key and says nothing about what it was handed.
 *
 * The sentinel is a path that does not exist, which is what makes the
 * no-metrics-file arm reachable at all.
 */
describe('anomaly-watch config value disclosure', () => {
  const SENTINEL = 'do-not-echo-d4e5f6'

  test('a missing metrics file reports nothing to check without naming the path', async () => {
    const result = await handler(
      {} as PluginManifest,
      { metrics_path: join(tmpdir(), SENTINEL, 'metrics.json') },
    )

    expect(result.status).toBe('skipped')
    expect(JSON.stringify(result)).not.toContain(SENTINEL)
  })
})
