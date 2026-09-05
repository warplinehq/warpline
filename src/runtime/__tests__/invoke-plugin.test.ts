import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { invokePlugin, deriveRunStatus } from '../invoke-plugin.js'
import type { PluginManifest } from '../../schemas/plugin-manifest.js'

// Fixture plugin directories live in a tmp dir to avoid polluting .warpline/plugins/

let tmpDir: string
let EVENTS_PATH: string

const MANIFEST: PluginManifest = {
  name: 'good-plugin',
  version: '1.0.0',
  description: 'Test plugin',
  inputs: {},
  outputs: {},
  capabilities: [],
  schedule: 'on_run',
  autonomy_level: 'autonomous',
  side_effects: [],
  ttl_hours: 24,
  dependencies: [],
  timeout_ms: 5000,
  max_parallelism: 1,
  min_tier: 'normal',
  max_retries: 1,
  retry_delay_ms: 2000,
}

async function writePlugin(
  dir: string,
  name: string,
  handlerCode: string,
  manifestOverride?: Partial<PluginManifest>,
) {
  const pluginDir = join(dir, name)
  await mkdir(pluginDir, { recursive: true })

  const manifest = { ...MANIFEST, name, ...manifestOverride }
  await writeFile(
    join(pluginDir, 'manifest.ts'),
    `export const manifest = ${JSON.stringify(manifest)}`,
  )
  await writeFile(join(pluginDir, 'handler.ts'), handlerCode)
}

beforeEach(async () => {
  tmpDir = join(tmpdir(), `warpline-invoke-plugin-test-${Date.now()}`)
  // Retry notices default to the REAL .warpline/state/events.jsonl — redirect them
  // so fixture attempt_failed events stop leaking into live state (2026-08-18).
  EVENTS_PATH = join(tmpDir, 'events.jsonl')
  await mkdir(tmpDir, { recursive: true })

  // good-plugin — returns success
  await writePlugin(tmpDir, 'good-plugin', `
    export async function handler(manifest, args) {
      return {
        status: 'success',
        phases_completed: ['good-plugin'],
        phases_failed: [],
        errors: [],
        data_freshness: {},
        summary: 'good plugin succeeded',
        artifacts_produced: [],
        schema_version: 1,
      }
    }
  `)

  // throwing-plugin — handler throws
  await writePlugin(tmpDir, 'throwing-plugin', `
    export async function handler(manifest, args) {
      throw new Error('handler exploded')
    }
  `)

  // bad-shape-plugin — returns non-SkillResult
  await writePlugin(tmpDir, 'bad-shape-plugin', `
    export async function handler(manifest, args) {
      return { notASkillResult: true }
    }
  `)

  // llm-stub-plugin — returns skipped with [needs-llm] prefix
  await writePlugin(tmpDir, 'llm-stub-plugin', `
    export async function handler(manifest, args) {
      return {
        status: 'skipped',
        phases_completed: [],
        phases_failed: [],
        errors: [],
        data_freshness: {},
        summary: '[needs-llm] requires LLM judgment',
        artifacts_produced: [],
        schema_version: 1,
      }
    }
  `)
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('invokePlugin', () => {
  test('Test 1: loads handler via dynamic import and returns its SkillResult', async () => {
    const result = await invokePlugin('good-plugin', {}, { pluginsDir: tmpDir, eventsPath: EVENTS_PATH }, { granted: false, reason: 'manual-run' })

    expect(result.plugin).toBe('good-plugin')
    expect(result.result.status).toBe('success')
    expect(result.result.summary).toBe('good plugin succeeded')
    expect(result.duration_ms).toBeGreaterThanOrEqual(0)
    expect(result.retried).toBe(false)
  })

  test('Test 2: handler that throws returns failed SkillResult — not a thrown exception', async () => {
    // Must NOT throw — must return a failed result
    const result = await invokePlugin('throwing-plugin', {}, { pluginsDir: tmpDir, eventsPath: EVENTS_PATH }, { granted: false, reason: 'manual-run' })

    expect(result.plugin).toBe('throwing-plugin')
    expect(result.result.status).toBe('failed')
    expect(result.result.errors.length).toBeGreaterThan(0)
    expect(result.result.summary).toContain('handler exploded')
  })

  test('Test 3: handler returning invalid SkillResult shape triggers parse_error in result', async () => {
    const result = await invokePlugin('bad-shape-plugin', {}, { pluginsDir: tmpDir, eventsPath: EVENTS_PATH }, { granted: false, reason: 'manual-run' })

    expect(result.plugin).toBe('bad-shape-plugin')
    expect(result.result.status).toBe('failed')
    expect(result.result.errors[0]?.code).toBe('parse_error')
    expect(result.result.summary).toContain('invalid')
  })

  test('Test 4: retryable error retries after 2s backoff, second failure returns final failed result', async () => {
    // Write a plugin that always fails with retryable error
    await writePlugin(tmpDir, 'retryable-fail-plugin', `
      export async function handler(manifest, args) {
        return {
          status: 'failed',
          phases_completed: [],
          phases_failed: ['retryable-fail-plugin'],
          errors: [{ code: 'rate_limit', message: 'rate limited', impact: 'MEDIUM', retryable: true }],
          data_freshness: {},
          summary: 'rate limited',
          artifacts_produced: [],
          schema_version: 1,
        }
      }
    `)

    const start = Date.now()
    const result = await invokePlugin('retryable-fail-plugin', {}, { pluginsDir: tmpDir, eventsPath: EVENTS_PATH }, { granted: false, reason: 'manual-run' })
    const elapsed = Date.now() - start

    expect(result.result.status).toBe('failed')
    expect(result.attempt_count).toBe(2)
    expect(result.retried).toBe(true)
    // Should have waited ~2s for backoff (default retry_delay_ms=2000; ±25% jitter)
    expect(elapsed).toBeGreaterThanOrEqual(1400)
  }, 10_000)

  test('Test 5: retryable: false error does NOT retry — returns failed immediately', async () => {
    await writePlugin(tmpDir, 'non-retryable-plugin', `
      export async function handler(manifest, args) {
        return {
          status: 'failed',
          phases_completed: [],
          phases_failed: ['non-retryable-plugin'],
          errors: [{ code: 'auth_failure', message: 'auth failed', impact: 'HIGH', retryable: false }],
          data_freshness: {},
          summary: 'auth failed',
          artifacts_produced: [],
          schema_version: 1,
        }
      }
    `)

    const start = Date.now()
    const result = await invokePlugin('non-retryable-plugin', {}, { pluginsDir: tmpDir, eventsPath: EVENTS_PATH }, { granted: false, reason: 'manual-run' })
    const elapsed = Date.now() - start

    expect(result.result.status).toBe('failed')
    expect(result.retried).toBe(false)
    // Should NOT wait 2s
    expect(elapsed).toBeLessThan(1000)
  })

  test('Test 6: successful retry (first call fails retryable, second succeeds) returns success result', async () => {
    // Use a counter file to track calls
    const counterFile = join(tmpDir, 'retry-counter.json')
    await writeFile(counterFile, '{"count": 0}')

    await writePlugin(tmpDir, 'retry-success-plugin', `
      import { readFileSync, writeFileSync } from 'node:fs'
      export async function handler(manifest, args) {
        const data = JSON.parse(readFileSync('${counterFile}', 'utf-8'))
        data.count++
        writeFileSync('${counterFile}', JSON.stringify(data))

        if (data.count === 1) {
          return {
            status: 'failed',
            phases_completed: [],
            phases_failed: ['retry-success-plugin'],
            errors: [{ code: 'rate_limit', message: 'rate limited first call', impact: 'MEDIUM', retryable: true }],
            data_freshness: {},
            summary: 'first call failed',
            artifacts_produced: [],
            schema_version: 1,
          }
        }
        return {
          status: 'success',
          phases_completed: ['retry-success-plugin'],
          phases_failed: [],
          errors: [],
          data_freshness: {},
          summary: 'second call succeeded',
          artifacts_produced: [],
          schema_version: 1,
        }
      }
    `)

    const result = await invokePlugin('retry-success-plugin', {}, { pluginsDir: tmpDir, eventsPath: EVENTS_PATH }, { granted: false, reason: 'manual-run' })

    expect(result.result.status).toBe('success')
    expect(result.retried).toBe(true)
  }, 10_000)

  test('Test 7: result includes duration_ms and plugin name metadata', async () => {
    const result = await invokePlugin('good-plugin', {}, { pluginsDir: tmpDir, eventsPath: EVENTS_PATH }, { granted: false, reason: 'manual-run' })

    expect(result.plugin).toBe('good-plugin')
    expect(typeof result.duration_ms).toBe('number')
    expect(result.duration_ms).toBeGreaterThanOrEqual(0)
    expect(typeof result.retried).toBe('boolean')
  })

  test('Test 8: handler returning skipped with [needs-llm] prefix is returned as-is (no retry, not treated as failure)', async () => {
    const result = await invokePlugin('llm-stub-plugin', {}, { pluginsDir: tmpDir, eventsPath: EVENTS_PATH }, { granted: false, reason: 'manual-run' })

    expect(result.result.status).toBe('skipped')
    expect(result.result.summary).toContain('[needs-llm]')
    expect(result.retried).toBe(false)
    // duration should be fast
    expect(result.duration_ms).toBeLessThan(1000)
  })

  test('Test 8b: a [needs-llm] handoff persists a delegated artifact, not failed', async () => {
    const runsDir = join(tmpDir, 'runs')
    const result = await invokePlugin('llm-stub-plugin', {}, {
      pluginsDir: tmpDir,
      eventsPath: EVENTS_PATH,
      runsDir,
      persistArtifact: true,
      runId: 'delegated-artifact-test',
    }, { granted: false, reason: 'manual-run' })

    expect(deriveRunStatus(result)).toBe('delegated')
    const artifact = JSON.parse(
      await readFile(join(runsDir, 'delegated-artifact-test.json'), 'utf-8'),
    )
    expect(artifact.status).toBe('delegated')
  })
})
