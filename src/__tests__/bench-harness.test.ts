/**
 * The benchmark harness, end to end, over the deterministic half of the pinned
 * scenario — with no provider key anywhere on the path.
 *
 * Why this file lives under `src/__tests__/` and not under `bench/`: CI shards
 * the suite by a `find` over `src/` plus one explicit `examples/` line, so a
 * test directory anywhere else runs locally and runs NOWHERE in CI. A guard
 * that passes on a laptop and never runs on the branch is the failure mode
 * this repository has already shipped four times.
 *
 * The assertions that make it evidence rather than decoration:
 *
 *   - a roster sentinel. Five manifests must load from the seeded root before
 *     anything downstream is asserted, and the failure names the count. A scan
 *     that found nothing must be red, never clean.
 *   - the two handoff artifacts must be ABSENT at this stage. Nothing has
 *     resolved them yet, so a grader that passed on them would be grading
 *     nothing at all, and the two artifacts it DOES pass would carry no weight.
 *   - the scrubber is fed a raw carrying an operator path and a nested currency
 *     key, because the schema itself declares neither. Asserting the scrub over
 *     a record that could not have contained the thing being scrubbed is a test
 *     that cannot fail.
 */
import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadPluginManifests } from 'warpline/unstable-runtime'
import { runWarplineArm } from '../../bench/arms.js'
import { gradeHome } from '../../bench/grade.js'
import { BenchRunRecordSchema, parseRecord, scrubRecord } from '../../bench/record.js'
import {
  assertHomeSeam,
  GRADED_PATHS,
  PINNED_PLUGINS,
  seedArmHome,
  withArmHome,
} from '../../bench/seed.js'

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

describe('bench harness — the deterministic half, end to end', () => {
  test('one warpline iteration parks two handoffs and materialises two graded artifacts', async () => {
    await withArmHome(async (home) => {
      await seedArmHome(home)
      assertHomeSeam(home)

      // The roster sentinel, before anything downstream.
      const { manifests } = await loadPluginManifests(join(home, 'plugins'))
      if (manifests.size !== PINNED_PLUGINS.length) {
        throw new Error(
          `the seeded plugin root loaded ${manifests.size} manifests where ${PINNED_PLUGINS.length} are pinned`,
        )
      }
      expect([...manifests.keys()].sort()).toEqual([...PINNED_PLUGINS].sort())

      const arm = await runWarplineArm(home)

      expect(arm.parked_handoffs).toBe(2)
      expect(arm.runtime_ms).toBeGreaterThan(0)

      // The two handoff artifacts are absent: nothing has resolved them.
      expect(existsSync(join(home, GRADED_PATHS['draft-writer']))).toBe(false)
      expect(existsSync(join(home, GRADED_PATHS['announce-fanout']))).toBe(false)

      const grade = gradeHome(home)
      expect(grade.paths['daily-digest']).toBe(true)
      expect(grade.paths['metrics-rollup']).toBe(true)
      expect(grade.paths['draft-writer']).toBe(false)
      expect(grade.paths['announce-fanout']).toBe(false)
      expect(grade.passed).toBe(false)

      // The digest names both declared producers, one of which is absent from
      // the plugin root on purpose.
      const digest = JSON.parse(readFileSync(join(home, GRADED_PATHS['daily-digest']), 'utf8')) as {
        lines: string[]
        digest: string
      }
      expect(digest.lines.length).toBe(2)
      expect(digest.digest.length).toBeGreaterThan(0)
    })
  })

  test('the scrub runs before the parse, over a raw that carries what it removes', async () => {
    await withArmHome(async (home) => {
      await seedArmHome(home)
      const arm = await runWarplineArm(home)

      const raw = sampleRecord({
        parked_handoffs: arm.parked_handoffs,
        runtime_ms: arm.runtime_ms,
        wall_clock_ms: arm.runtime_ms,
        // None of these three is a schema field. That is the point: the scrub
        // has to remove them from the RAW, before a parse that would strip
        // them anyway and hide whether the scrub did anything.
        run_log_path: arm.advance.run_log_path,
        usage: { input_tokens: 10, total_cost_usd: 1.23 },
        stdout: 'free text nobody has read',
      })

      const scrubbed = scrubRecord(raw, home) as Record<string, unknown>
      const serialised = JSON.stringify(scrubbed)

      expect(raw.run_log_path as string).toContain(home)
      expect(serialised).not.toContain(home)
      expect(serialised).not.toContain('cost')
      expect(scrubbed.stdout).toBeUndefined()
      expect((scrubbed.usage as Record<string, unknown>).input_tokens).toBe(10)
      expect(scrubbed.run_log_path as string).toContain('<home>')

      const record = parseRecord(raw, home)
      expect(record.parked_handoffs).toBe(2)
      expect(record.tokens.cache_read).toBe(0)
    })
  })

  test('nothing under the results directory is a placeholder', () => {
    const listed = execFileSync('git', ['ls-files', '--', 'bench/results/'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
    const tracked = listed.split('\n').filter((line) => line.trim() !== '')

    // Extension AND shape, never an empty-roster assertion: an assertion that
    // the directory is empty goes permanently red the moment the first real
    // record lands, and takes the whole suite with it.
    expect(tracked.filter((file) => !file.endsWith('.json'))).toEqual([])
    for (const file of tracked) {
      BenchRunRecordSchema.parse(JSON.parse(readFileSync(join(REPO_ROOT, file), 'utf8')))
    }
  })
})
