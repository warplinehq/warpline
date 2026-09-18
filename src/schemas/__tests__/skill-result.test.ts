import { describe, it, expect } from 'bun:test'
import {
  SkillResultSchema,
  SkillErrorSchema,
  OutputRecordSchema,
  StoredOutputRecordSchema,
  OUTPUT_BODY_CAP_BYTES,
} from '../skill-result.js'

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

  it('refuses a result whose Output is bodiless and claims to be erased', () => {
    const result = SkillResultSchema.safeParse({
      ...validResult,
      artifacts_produced: [{ type: 'brief', erased_at: '2026-09-02T00:00:00.000Z' }],
    })
    expect(result.success).toBe(false)
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

  it('normalizes a bare-string artifacts_produced entry to a path Output', () => {
    const result = SkillResultSchema.safeParse(validResult)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.artifacts_produced).toEqual([
        {
          type: 'artifact',
          format: 'markdown',
          path: '.warpline/intel/reports/weekly/2026-W14.md',
        },
      ])
    }
  })

  it('defaults schema_version to 2', () => {
    // validResult declares no schema_version — the default is what is under test.
    const result = SkillResultSchema.safeParse(validResult)
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.schema_version).toBe(2)
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

// ── Output records (R5) ──────────────────────────────────────────────────

describe('OutputRecordSchema', () => {
  it('defaults an omitted format to markdown', () => {
    const result = OutputRecordSchema.safeParse({ type: 'report', path: 'report.md' })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.format).toBe('markdown')
  })

  it('rejects an unrecognised format rather than dropping it', () => {
    const result = OutputRecordSchema.safeParse({
      type: 'report',
      format: 'pdf',
      path: 'report.pdf',
    })
    expect(result.success).toBe(false)
  })

  it('rejects a record declaring both body and path', () => {
    const result = OutputRecordSchema.safeParse({
      type: 'report',
      body: '# hello',
      path: 'report.md',
    })
    expect(result.success).toBe(false)
  })

  it('rejects a record declaring neither body nor path', () => {
    const result = OutputRecordSchema.safeParse({ type: 'report' })
    expect(result.success).toBe(false)
  })

  // The handler boundary does not know the stored-only keys. A handler cannot
  // hand the runtime an erased Output, or a hash of its own choosing.
  it('strips the stored-only keys from a handler Output that has a body', () => {
    const result = OutputRecordSchema.safeParse({
      type: 'brief',
      body: 'x',
      erased_at: '2026-09-02T00:00:00.000Z',
      body_sha256: 'a'.repeat(64),
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect('erased_at' in result.data).toBe(false)
      expect('body_sha256' in result.data).toBe(false)
    }
  })

  it('refuses a handler Output that is bodiless and claims to be erased', () => {
    const result = OutputRecordSchema.safeParse({
      type: 'brief',
      erased_at: '2026-09-02T00:00:00.000Z',
    })
    expect(result.success).toBe(false)
  })

  // The cap is measured in UTF-8 BYTES, not characters. These three fixtures
  // are multi-byte on purpose: an ASCII-only cap test passes against a
  // `.length`-based (UTF-16 code unit) implementation and proves nothing.
  // '日' is 3 UTF-8 bytes; 5461 * 3 = 16383, so + 'a' is exactly the cap.
  describe('the inline body cap, measured in UTF-8 bytes', () => {
    const atCap = '日'.repeat(5461) + 'a'
    const overCap = '日'.repeat(5461) + 'ab'

    it('has fixtures whose byte length is exactly the cap and one over', () => {
      expect(OUTPUT_BODY_CAP_BYTES).toBe(16_384)
      expect(Buffer.byteLength(atCap, 'utf8')).toBe(OUTPUT_BODY_CAP_BYTES)
      expect(Buffer.byteLength(overCap, 'utf8')).toBe(OUTPUT_BODY_CAP_BYTES + 1)
      // The trap this test exists for: both fixtures are UNDER the cap when
      // measured in UTF-16 code units, so a `.max()` implementation accepts both.
      expect(atCap.length).toBeLessThan(OUTPUT_BODY_CAP_BYTES)
      expect(overCap.length).toBeLessThan(OUTPUT_BODY_CAP_BYTES)
    })

    it('accepts a body of exactly the cap in UTF-8 bytes', () => {
      expect(OutputRecordSchema.safeParse({ type: 'brief', body: atCap }).success).toBe(true)
    })

    it('rejects a body one UTF-8 byte over the cap', () => {
      expect(OutputRecordSchema.safeParse({ type: 'brief', body: overCap }).success).toBe(false)
    })
  })
})

describe('StoredOutputRecordSchema', () => {
  const erased = {
    type: 'brief',
    format: 'json',
    run_id: 'run-1',
    produced_at: '2026-09-01T00:00:00.000Z',
    erased_at: '2026-09-02T00:00:00.000Z',
    body_sha256: 'a'.repeat(64),
  }

  it('parses an erased record, which carries neither body nor path', () => {
    expect(StoredOutputRecordSchema.safeParse(erased).success).toBe(true)
  })

  it('rejects an erased record that still carries a body', () => {
    expect(StoredOutputRecordSchema.safeParse({ ...erased, body: 'x' }).success).toBe(false)
  })

  it('rejects an erased record that carries a path', () => {
    expect(StoredOutputRecordSchema.safeParse({ ...erased, path: 'x.md' }).success).toBe(false)
  })

  it('rejects an erased record without the hash of what it held', () => {
    const { body_sha256: _dropped, ...hashless } = erased
    expect(StoredOutputRecordSchema.safeParse(hashless).success).toBe(false)
  })

  it('rejects a record that is not erased and carries neither body nor path', () => {
    expect(StoredOutputRecordSchema.safeParse({ type: 'brief' }).success).toBe(false)
  })

  it('still parses a body record and a file-pointer record', () => {
    expect(StoredOutputRecordSchema.safeParse({ type: 'brief', body: 'x' }).success).toBe(true)
    expect(StoredOutputRecordSchema.safeParse({ type: 'brief', path: 'x.md' }).success).toBe(true)
  })

  it('still enforces the body cap in UTF-8 bytes', () => {
    // '日' is 3 UTF-8 bytes; 5461 * 3 + 2 is one byte over the cap.
    const overCap = '日'.repeat(5461) + 'ab'
    expect(Buffer.byteLength(overCap, 'utf8')).toBe(OUTPUT_BODY_CAP_BYTES + 1)
    expect(StoredOutputRecordSchema.safeParse({ type: 'brief', body: overCap }).success).toBe(false)
  })

  it('adds exactly the two stored-only keys to the handler shape', () => {
    expect(Object.keys(StoredOutputRecordSchema.shape).sort()).toEqual([
      'body',
      'body_sha256',
      'erased_at',
      'format',
      'path',
      'produced_at',
      'run_id',
      'type',
    ])
  })
})

describe('artifacts_produced as Outputs', () => {
  const base = {
    status: 'success',
    phases_completed: [],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: 'done',
  }

  it('validates an empty array and yields zero Outputs', () => {
    const result = SkillResultSchema.safeParse({ ...base, artifacts_produced: [] })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.artifacts_produced).toHaveLength(0)
  })

  it('accepts a mixed array and normalizes every entry to one shape', () => {
    const result = SkillResultSchema.safeParse({
      ...base,
      artifacts_produced: ['report.md', { type: 'brief', body: '# hi', format: 'markdown' }],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.artifacts_produced).toEqual([
        { type: 'artifact', format: 'markdown', path: 'report.md' },
        { type: 'brief', format: 'markdown', body: '# hi' },
      ])
    }
  })

  it('rejects the whole result when an Output declares both body and path', () => {
    const result = SkillResultSchema.safeParse({
      ...base,
      artifacts_produced: [{ type: 'brief', body: 'x', path: 'y.md' }],
    })
    expect(result.success).toBe(false)
  })
})
