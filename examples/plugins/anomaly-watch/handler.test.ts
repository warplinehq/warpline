import { describe, test, expect } from 'bun:test'
import { findAnomalies } from './handler.js'

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
