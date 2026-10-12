/**
 * The verifier seam: the one place an Answer's assurance is assigned.
 */
import { describe, expect, test } from 'bun:test'
import { ASSURANCE_LEVELS, verifyAnswer } from '../assurance.js'

describe('the assurance seam', () => {
  test('the assurance levels are exactly asserted', () => {
    expect([...ASSURANCE_LEVELS]).toEqual(['asserted'])
  })

  test('verifyAnswer assigns asserted', () => {
    expect(verifyAnswer(null)).toBe('asserted')
    expect(verifyAnswer('OPS-123')).toBe('asserted')
  })
})
