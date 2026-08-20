import { describe, it, expect } from 'bun:test'
import {
  SkillErrorSchema,
  SkillResultSchema,
  DEFAULT_RETRYABLE,
  makeSkillError,
} from '../skill-result.js'

describe('SkillErrorSchema — retryable field', () => {
  it('Test 1: parses without retryable and defaults to false', () => {
    const result = SkillErrorSchema.parse({
      code: 'rate_limit',
      message: 'too fast',
      impact: 'MEDIUM',
    })
    expect(result.retryable).toBe(false)
  })

  it('Test 2: retains explicit retryable: true', () => {
    const result = SkillErrorSchema.parse({
      code: 'timeout',
      message: 'timed out',
      impact: 'HIGH',
      retryable: true,
    })
    expect(result.retryable).toBe(true)
  })

  it('Test 3: existing SkillResultSchema with errors array still parses (backward compat)', () => {
    const result = SkillResultSchema.parse({
      status: 'failed',
      phases_completed: [],
      phases_failed: ['some-phase'],
      errors: [{ code: 'auth_failure', message: 'not authed', impact: 'HIGH' }],
      data_freshness: {},
      summary: 'failed',
    })
    expect(result.status).toBe('failed')
    expect(result.errors[0].retryable).toBe(false)
  })
})

describe('makeSkillError helper', () => {
  it('Test 4: rate_limit returns retryable: true by default', () => {
    const err = makeSkillError('rate_limit', 'msg')
    expect(err.retryable).toBe(true)
  })

  it('Test 5: auth_failure returns retryable: false by default', () => {
    const err = makeSkillError('auth_failure', 'msg')
    expect(err.retryable).toBe(false)
  })

  it('Test 6: override retryable: false on timeout', () => {
    const err = makeSkillError('timeout', 'msg', { retryable: false })
    expect(err.retryable).toBe(false)
  })
})

describe('DEFAULT_RETRYABLE map', () => {
  it('exports a record with rate_limit: true and auth_failure: false', () => {
    expect(DEFAULT_RETRYABLE.rate_limit).toBe(true)
    expect(DEFAULT_RETRYABLE.auth_failure).toBe(false)
    expect(DEFAULT_RETRYABLE.timeout).toBe(true)
    expect(DEFAULT_RETRYABLE.dependency_unavailable).toBe(false)
  })
})
