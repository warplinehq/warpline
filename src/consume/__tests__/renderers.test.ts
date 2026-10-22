/**
 * The one rule that turns a float USD into integer micro-USD, pinned at the
 * module.
 *
 * Every cost a renderer reports goes through `toMicroUp`. It must be exact on
 * every exact micro value, so a reported $0.000123 is 123 and not 124, and it
 * must still round a genuine sub-micro fraction up, so a cost is never
 * undercounted. Small exact costs must also add up: ten thousand calls at
 * $0.0001 are exactly one dollar.
 */
import { describe, expect, test } from 'bun:test'
// The module this file pins before it exists.
import * as renderers from '../renderers.js'

describe('toMicroUp', () => {
  test('is exact on every micro value from 0 to 1,999,999', () => {
    let mismatches = 0
    for (let m = 0; m <= 1_999_999; m++) if (renderers.toMicroUp(m / 1e6) !== m) mismatches++
    expect(mismatches).toBe(0)
  })

  test('rounds a genuine fraction of a micro-USD up', () => {
    expect(renderers.toMicroUp(1.0000004)).toBe(1_000_001)
  })

  test('ten thousand calls at $0.0001 sum to exactly one dollar', () => {
    let sum = 0
    for (let i = 0; i < 10_000; i++) sum += renderers.toMicroUp(0.0001)
    expect(sum).toBe(1_000_000)
  })
})
