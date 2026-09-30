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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gradeWithChecks, type GradeCheck } from '../../bench/grade.js'
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
})
