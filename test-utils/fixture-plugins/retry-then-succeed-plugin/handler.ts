import { readFileSync, writeFileSync } from 'node:fs'
import type { HandlerFn } from '../../../src/runtime/invoke-plugin.js'

/**
 * Reads/writes a counter file passed via `args.counterPath`. Each test gets its
 * own tmpdir counter path so runs stay isolated. Attempt 1 writes `1` and
 * returns retryable failure; attempt 2 reads `1`, writes `2`, and returns
 * success.
 */
export const handler: HandlerFn = async (_manifest, args) => {
  const counterPath = typeof args.counterPath === 'string' ? args.counterPath : null
  if (!counterPath) {
    return {
      status: 'failed',
      phases_completed: [],
      phases_failed: ['retry-then-succeed-plugin'],
      errors: [
        {
          code: 'data_missing',
          message: 'counterPath arg missing',
          impact: 'HIGH',
          retryable: false,
        },
      ],
      data_freshness: {},
      summary: 'retry-then-succeed-plugin: counterPath missing',
      artifacts_produced: [],
      schema_version: 1,
    }
  }

  let current = 0
  try {
    current = Number(readFileSync(counterPath, 'utf-8')) || 0
  } catch {
    current = 0
  }
  const next = current + 1
  writeFileSync(counterPath, String(next), 'utf-8')

  if (next === 1) {
    return {
      status: 'failed',
      phases_completed: [],
      phases_failed: ['retry-then-succeed-plugin'],
      errors: [
        {
          code: 'rate_limit',
          message: 'flaky-first-call',
          impact: 'MEDIUM',
          retryable: true,
        },
      ],
      data_freshness: {},
      summary: 'retry-then-succeed-plugin: first call failed',
      artifacts_produced: [],
      schema_version: 1,
    }
  }

  return {
    status: 'success',
    phases_completed: ['retry-then-succeed-plugin'],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: `retry-then-succeed-plugin: succeeded on attempt ${next}`,
    artifacts_produced: [],
    schema_version: 1,
  }
}
