/**
 * The private-scale harness, exercised on synthetic data only.
 *
 * No fleet name, path or variable appears here, and every fixture is invented.
 * A private run grades its homes by opaque check ids whose mapping to plugins
 * lives outside this repository, so what is pinned here is the machinery: the
 * one record schema both runs share, and the data-driven grader a private
 * configuration drives without ever naming what it is grading.
 */
import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  GradeCheckSchema,
  GradePredicateSchema,
  gradeWithChecks,
  resolvePointer,
  type GradeCheck,
} from '../../bench/grade.js'
import { BenchRunRecordSchema, GRADED_KEYS, parseRecord } from '../../bench/record.js'

const REPO_ROOT = join(import.meta.dir, '..', '..')

/** A record with every field the schema requires, so a test can vary one thing. */
function sampleRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    arm: 'warpline',
    iteration: 1,
    arm_order_index: 0,
    cold: true,
    disposition: 'passed',
    truncation_subtype: null,
    tokens: { input: 0, output: 0, cache_creation: 0, cache_read: 0 },
    wall_clock_ms: 1.5,
    runtime_ms: 1.5,
    consumer_ms: null,
    parked_handoffs: 2,
    graded: {
      'announce-fanout': false,
      'daily-digest': true,
      'draft-writer': false,
      'metrics-rollup': true,
    },
    git_sha: 'abcdef0',
    package_version: '0.0.0',
    claude_cli_version: 'none',
    model_id: 'none',
    ...overrides,
  }
}

/** Run `fn` against a fresh temp home, removed afterwards whatever happens. */
function withHome<T>(files: Record<string, string>, fn: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), 'bench-private-'))
  try {
    for (const [rel, body] of Object.entries(files)) {
      const path = join(home, rel)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, body)
    }
    return fn(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

describe('graded map', () => {
  test('a synthetic home flows through the check grader into a record the one schema accepts', () => {
    withHome(
      { 'graded/check-1.json': '{"items":[1,2]}', 'graded/check-2.json': '{"n":3}' },
      (home) => {
        const checks: GradeCheck[] = [
          { id: 'check-1', path: 'graded/check-1.json', pointer: '/items', predicate: { kind: 'non_empty_array' } },
          { id: 'check-2', path: 'graded/check-2.json', pointer: '/n', predicate: { kind: 'integer_gte', n: 2 } },
        ]
        const result = gradeWithChecks(home, checks)
        expect(result).toEqual({ paths: { 'check-1': true, 'check-2': true }, passed: true })

        const stamped = {
          snapshot_sha256: 'a'.repeat(64),
          prereg_commitment: 'b'.repeat(64),
          outbound_blocked: 0,
        }
        const record = parseRecord(sampleRecord({ graded: result.paths, ...stamped }), home)
        expect(record.graded).toEqual({ 'check-1': true, 'check-2': true })
        expect(record.snapshot_sha256).toBe(stamped.snapshot_sha256)
        expect(record.prereg_commitment).toBe(stamped.prereg_commitment)
        expect(record.outbound_blocked).toBe(0)
      },
    )
  })

  test('every tracked public record still parses, with exactly the four public keys and no new field', () => {
    const listed = execFileSync('git', ['ls-files', '--', 'bench/results/'], { cwd: REPO_ROOT, encoding: 'utf8' })
      .split('\n')
      .filter((line) => line.trim() !== '')
    // A roster sentinel: an empty listing would make every assertion below vacuous.
    expect(listed.length).toBeGreaterThan(0)
    for (const file of listed) {
      const record = BenchRunRecordSchema.parse(JSON.parse(readFileSync(join(REPO_ROOT, file), 'utf8')))
      expect(Object.keys(record.graded).sort()).toEqual([...GRADED_KEYS].sort())
      expect(record.snapshot_sha256).toBeUndefined()
      expect(record.prereg_commitment).toBeUndefined()
      expect(record.outbound_blocked).toBeUndefined()
    }
  })

  test('a public-shaped record parses without any of the three optional fields', () => {
    expect(BenchRunRecordSchema.safeParse(sampleRecord()).success).toBe(true)
  })

  const PUBLIC_GRADED = {
    'announce-fanout': true,
    'daily-digest': true,
    'draft-writer': true,
    'metrics-rollup': true,
  }
  const withoutPackageVersion = (): Record<string, unknown> => {
    const record = sampleRecord()
    delete record.package_version
    return record
  }
  const REFUSED: [string, () => Record<string, unknown>][] = [
    ['an empty graded map, which graded nothing', () => sampleRecord({ graded: {} })],
    ['a map mixing the public keys with a check id', () => sampleRecord({ graded: { ...PUBLIC_GRADED, 'check-1': true } })],
    ['a check id that is not check-<digits>', () => sampleRecord({ graded: { 'check-x': true } })],
    ['the public keys plus a fifth', () => sampleRecord({ graded: { ...PUBLIC_GRADED, extra: true } })],
    ['a snapshot digest that is not 64 hex', () => sampleRecord({ snapshot_sha256: 'xyz' })],
    ['an uppercase commitment', () => sampleRecord({ prereg_commitment: 'A'.repeat(64) })],
    ['a negative blocked count', () => sampleRecord({ outbound_blocked: -1 })],
    ['a fractional blocked count', () => sampleRecord({ outbound_blocked: 1.5 })],
    ['a record missing a provenance field', withoutPackageVersion],
  ]
  test.each(REFUSED)('the schema refuses %s', (_name, build) => {
    expect(BenchRunRecordSchema.safeParse(build()).success).toBe(false)
  })
})

/** Grade one invented artifact with one check, in a fresh home. `undefined` leaves the file absent. */
function gradeOne(body: string | undefined, pointer: string, predicate: GradeCheck['predicate']): boolean {
  const files: Record<string, string> = body === undefined ? {} : { 'graded/check-1.json': body }
  return withHome(files, (home) => {
    const result = gradeWithChecks(home, [{ id: 'check-1', path: 'graded/check-1.json', pointer, predicate }])
    expect(result.passed).toBe(result.paths['check-1'] === true)
    return result.paths['check-1'] === true
  })
}

/** Each value as the `/v` member of an invented artifact. */
const at = (value: unknown): string => JSON.stringify({ v: value })

describe('check evaluator', () => {
  // Every predicate's wrong artifacts come BEFORE its right one: a grader that
  // passes everything must go red here before anything else is believed.
  test('exists: an absent file fails, a present one passes', () => {
    expect(gradeOne(undefined, '', { kind: 'exists' })).toBe(false)
    expect(gradeOne('not json at all', '', { kind: 'exists' })).toBe(true)
    expect(gradeOne(at(null), '/missing', { kind: 'exists' })).toBe(false)
    expect(gradeOne(at(null), '/v', { kind: 'exists' })).toBe(true)
  })

  test('integer_gte: a smaller, fractional, quoted or null value fails; an equal or larger integer passes', () => {
    for (const wrong of [1, 1.5, '3', null]) expect(gradeOne(at(wrong), '/v', { kind: 'integer_gte', n: 2 })).toBe(false)
    expect(gradeOne(at(2), '/v', { kind: 'integer_gte', n: 2 })).toBe(true)
    expect(gradeOne(at(3), '/v', { kind: 'integer_gte', n: 2 })).toBe(true)
  })

  test('non_empty_array: an empty array, an object or a string fails; a one-element array passes', () => {
    for (const wrong of [[], {}, 'x']) expect(gradeOne(at(wrong), '/v', { kind: 'non_empty_array' })).toBe(false)
    expect(gradeOne(at([0]), '/v', { kind: 'non_empty_array' })).toBe(true)
  })

  test('non_empty_string: an empty or blank string or a number fails; a word passes', () => {
    for (const wrong of ['', '   ', 3]) expect(gradeOne(at(wrong), '/v', { kind: 'non_empty_string' })).toBe(false)
    expect(gradeOne(at('x'), '/v', { kind: 'non_empty_string' })).toBe(true)
  })

  test('keyset_equals: a missing key, an extra key or an array fails; the same keys in any order pass', () => {
    const predicate: GradeCheck['predicate'] = { kind: 'keyset_equals', keys: ['a', 'b'] }
    for (const wrong of [{ a: 1 }, { a: 1, b: 2, c: 3 }, []]) expect(gradeOne(at(wrong), '/v', predicate)).toBe(false)
    expect(gradeOne(at({ b: 1, a: 2 }), '/v', predicate)).toBe(true)
  })

  test('pointers unescape ~1 before ~0', () => {
    const doc = JSON.stringify({ 'a/b': 'slash', 'm~n': 'tilde', '~1': 'literal' })
    expect(gradeOne(doc, '/a/b', { kind: 'non_empty_string' })).toBe(false)
    expect(gradeOne(doc, '/a~1b', { kind: 'non_empty_string' })).toBe(true)
    expect(gradeOne(doc, '/m~0n', { kind: 'non_empty_string' })).toBe(true)
    expect(resolvePointer(JSON.parse(doc), '/~01')).toEqual({ found: true, value: 'literal' })
  })

  test('an array token must be a canonical index inside the array', () => {
    const doc = JSON.stringify({ items: ['first'] })
    for (const wrong of ['/items/5', '/items/01', '/items/-', '/items/1']) {
      expect(gradeOne(doc, wrong, { kind: 'exists' })).toBe(false)
    }
    expect(resolvePointer(JSON.parse(doc), '/items/0')).toEqual({ found: true, value: 'first' })
    expect(gradeOne(doc, '/items/0', { kind: 'non_empty_string' })).toBe(true)
  })

  test("an object token must be an own key, and '' is the whole document", () => {
    expect(gradeOne(at(1), '/constructor', { kind: 'exists' })).toBe(false)
    expect(gradeOne('[1]', '', { kind: 'non_empty_array' })).toBe(true)
    expect(resolvePointer({ a: 1 }, '')).toEqual({ found: true, value: { a: 1 } })
  })

  test('invalid JSON grades false and does not throw', () => {
    expect(gradeOne('{"v": [1,', '/v', { kind: 'non_empty_array' })).toBe(false)
    expect(gradeOne('{"v": [1,', '', { kind: 'non_empty_array' })).toBe(false)
    expect(gradeOne('{"v": [1,', '/v', { kind: 'exists' })).toBe(false)
  })

  test('a graded file that links outside the home grades false', () => {
    const outside = mkdtempSync(join(tmpdir(), 'bench-private-outside-'))
    try {
      writeFileSync(join(outside, 'real.json'), at([1]))
      withHome({}, (home) => {
        mkdirSync(join(home, 'graded'))
        symlinkSync(join(outside, 'real.json'), join(home, 'graded', 'check-1.json'))
        const check: GradeCheck = { id: 'check-1', path: 'graded/check-1.json', pointer: '/v', predicate: { kind: 'non_empty_array' } }
        expect(gradeWithChecks(home, [check]).paths['check-1']).toBe(false)
      })
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test('passed is false when any single check fails', () => {
    withHome({ 'graded/check-1.json': at([1]), 'graded/check-2.json': at([]) }, (home) => {
      const result = gradeWithChecks(home, [
        { id: 'check-1', path: 'graded/check-1.json', pointer: '/v', predicate: { kind: 'non_empty_array' } },
        { id: 'check-2', path: 'graded/check-2.json', pointer: '/v', predicate: { kind: 'non_empty_array' } },
      ])
      expect(result).toEqual({ paths: { 'check-1': true, 'check-2': false }, passed: false })
    })
  })

  const valid: GradeCheck = { id: 'check-1', path: 'graded/check-1.json', pointer: '', predicate: { kind: 'exists' } }
  const refuse = (checks: unknown[], message?: RegExp): void => {
    withHome({}, (home) => {
      const run = (): unknown => gradeWithChecks(home, checks as GradeCheck[])
      if (message === undefined) expect(run).toThrow()
      else expect(run).toThrow(message)
    })
  }

  test('a check path that climbs out, leaves graded/ or is absolute is refused', () => {
    refuse([{ ...valid, path: 'graded/../../x.json' }])
    refuse([{ ...valid, path: 'state/x.json' }])
    refuse([{ ...valid, path: join(tmpdir(), 'graded', 'x.json') }])
    refuse([{ ...valid, path: '/graded/x.json' }])
    expect(GradeCheckSchema.safeParse({ ...valid, path: 'state/x.json' }).success).toBe(false)
  })

  test('a pointer without a leading slash is refused', () => {
    refuse([{ ...valid, pointer: 'items' }])
  })

  test('an empty check list and a duplicate id each throw', () => {
    refuse([], /no checks/)
    refuse([valid, { ...valid }], /twice/)
  })

  test('the closed predicate set cannot express text equality, and integer_gte needs its bound', () => {
    expect(GradeCheckSchema.safeParse({ ...valid, predicate: { kind: 'text_equals', value: 'x' } }).success).toBe(false)
    expect(GradeCheckSchema.safeParse({ ...valid, predicate: { kind: 'integer_gte' } }).success).toBe(false)
    expect(GradeCheckSchema.safeParse({ ...valid, predicate: { kind: 'non_empty_string', min_length: 3 } }).success).toBe(false)
    expect(GradePredicateSchema.options.map((option) => option.shape.kind.value).sort()).toEqual([
      'exists',
      'integer_gte',
      'keyset_equals',
      'non_empty_array',
      'non_empty_string',
    ])
  })
})
