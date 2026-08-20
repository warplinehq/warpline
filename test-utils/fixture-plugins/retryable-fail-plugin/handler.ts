import type { HandlerFn } from '../../../src/runtime/invoke-plugin.js'

export const handler: HandlerFn = async () => ({
  status: 'failed',
  phases_completed: [],
  phases_failed: ['retryable-fail-plugin'],
  errors: [
    {
      code: 'rate_limit',
      message: 'boom',
      impact: 'MEDIUM',
      retryable: true,
    },
  ],
  data_freshness: {},
  summary: 'retryable-fail-plugin: boom',
  artifacts_produced: [],
  schema_version: 1,
})
