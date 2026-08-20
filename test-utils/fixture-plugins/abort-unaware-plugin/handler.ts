import type { HandlerFn } from '../../../src/runtime/invoke-plugin.js'

export const handler: HandlerFn = async () => {
  await new Promise<void>(r => setTimeout(r, 5_000))
  return {
    status: 'success',
    phases_completed: ['abort-unaware-plugin'],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: 'abort-unaware-plugin: completed',
    artifacts_produced: [],
    schema_version: 1,
  }
}
