import { describe, it, expect } from 'bun:test'
import { SkillResultSchema, SkillErrorSchema } from '../skill-result.js'

describe('SkillResultSchema', () => {
  const validResult = {
    status: 'success',
    phases_completed: ['market', 'seo'],
    phases_failed: [],
    errors: [],
    data_freshness: { gsc: '2026-04-01T00:00:00Z', market_scan: '2026-03-30T00:00:00Z' },
    summary: 'All phases completed successfully.',
    artifacts_produced: ['.warpline/intel/reports/weekly/2026-W14.md'],
  }

  it('validates a complete valid input', () => {
    const result = SkillResultSchema.safeParse(validResult)
    expect(result.success).toBe(true)
  })

  it('rejects invalid status value', () => {
    const result = SkillResultSchema.safeParse({ ...validResult, status: 'invalid' })
    expect(result.success).toBe(false)
  })

  it('rejects missing required field summary', () => {
    const { summary: _, ...noSummary } = validResult
    const result = SkillResultSchema.safeParse(noSummary)
    expect(result.success).toBe(false)
  })

  it('defaults errors and artifacts_produced to empty arrays', () => {
    const { errors: _e, artifacts_produced: _a, ...minimal } = validResult
    const result = SkillResultSchema.safeParse(minimal)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.errors).toEqual([])
      expect(result.data.artifacts_produced).toEqual([])
    }
  })

  it('includes data_freshness as Record<string, string>', () => {
    const result = SkillResultSchema.safeParse(validResult)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.data_freshness).toEqual({
        gsc: '2026-04-01T00:00:00Z',
        market_scan: '2026-03-30T00:00:00Z',
      })
    }
  })

  it('includes artifacts_produced as string[]', () => {
    const result = SkillResultSchema.safeParse(validResult)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.artifacts_produced).toEqual(['.warpline/intel/reports/weekly/2026-W14.md'])
    }
  })

  it('does not have a duration_ms field', () => {
    const withDuration = { ...validResult, duration_ms: 45000 }
    const result = SkillResultSchema.safeParse(withDuration)
    // Schema should parse (strict mode not used) but data should not contain duration_ms
    if (result.success) {
      expect('duration_ms' in result.data).toBe(false)
    }
  })
})

describe('SkillErrorSchema', () => {
  const validCodes = [
    ['auth_failure'],
    ['rate_limit'],
    ['data_missing'],
    ['stale_data'],
    ['parse_error'],
    ['timeout'],
    ['dependency_unavailable'],
  ] as const

  it.each(validCodes)('validates error with code=%s', (code) => {
    const result = SkillErrorSchema.safeParse({
      code,
      message: `Test ${code} error`,
      impact: 'HIGH',
    })
    expect(result.success).toBe(true)
  })

  it('rejects unknown error code', () => {
    const result = SkillErrorSchema.safeParse({
      code: 'unknown_error',
      message: 'Bad code',
      impact: 'HIGH',
    })
    expect(result.success).toBe(false)
  })

  it('rejects invalid impact level', () => {
    const result = SkillErrorSchema.safeParse({
      code: 'timeout',
      message: 'Timed out',
      impact: 'CRITICAL',
    })
    expect(result.success).toBe(false)
  })
})
