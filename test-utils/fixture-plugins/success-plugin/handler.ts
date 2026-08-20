import type { HandlerFn } from '../../../src/runtime/invoke-plugin.js'

export const handler: HandlerFn = async () => ({
  status: 'success',
  phases_completed: ['success-plugin'],
  phases_failed: [],
  errors: [],
  data_freshness: {},
  summary: 'success-plugin ok',
  artifacts_produced: [],
  schema_version: 1,
})
