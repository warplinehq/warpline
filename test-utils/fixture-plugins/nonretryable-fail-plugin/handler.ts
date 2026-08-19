import type { HandlerFn } from '../../../src/runtime/invoke-plugin'

export const handler: HandlerFn = async () => ({
  status: 'failed',
  phases_completed: [],
  phases_failed: ['nonretryable-fail-plugin'],
  errors: [
    {
      code: 'auth_failure',
      message: 'auth denied',
      impact: 'HIGH',
      retryable: false,
    },
  ],
  data_freshness: {},
  summary: 'nonretryable-fail-plugin: auth denied',
  artifacts_produced: [],
  schema_version: 1,
})
