import { describe, it, expect } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SkillResultSchema,
  SkillErrorSchema,
  OutputRecordSchema,
  OUTPUT_BODY_CAP_BYTES,
  resolveOutput,
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

describe('resolveOutput', () => {
  it('resolves an inline body without touching the filesystem', () => {
    const out = OutputRecordSchema.parse({ type: 'brief', body: '# hi' })
    expect(resolveOutput(out)).toEqual({ state: 'inline', body: '# hi' })
  })

  it('resolves a path that exists to a present state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'warpline-output-'))
    try {
      const file = join(dir, 'report.md')
      await writeFile(file, '# report')
      const out = OutputRecordSchema.parse({ type: 'report', path: file })
      expect(resolveOutput(out)).toEqual({ state: 'present', path: file })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('resolves a path that no longer exists to a missing state rather than throwing', () => {
    const gone = join(tmpdir(), 'warpline-output-does-not-exist', 'report.md')
    const out = OutputRecordSchema.parse({ type: 'report', path: gone })
    expect(() => resolveOutput(out)).not.toThrow()
    expect(resolveOutput(out)).toEqual({ state: 'missing', path: gone })
  })
})
