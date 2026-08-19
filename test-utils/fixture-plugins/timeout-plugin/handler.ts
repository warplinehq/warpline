import type { HandlerFn } from '../../../src/runtime/invoke-plugin'

export const handler: HandlerFn = async () => {
  await new Promise<void>(r => setTimeout(r, 10_000))
  return {
    status: 'success',
    phases_completed: ['timeout-plugin'],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: 'timeout-plugin: should never reach this — timeout should have fired',
    artifacts_produced: [],
    schema_version: 1,
  }
}
