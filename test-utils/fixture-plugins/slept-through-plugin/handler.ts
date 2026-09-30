import type { HandlerFn } from '../../../src/runtime/invoke-plugin.js'

export const handler: HandlerFn = async () => {
  await new Promise<void>(r => setTimeout(r, 600))
  return {
    status: 'success',
    phases_completed: ['slept-through-plugin'],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: 'slept-through-plugin: completed',
    artifacts_produced: [],
    schema_version: 1,
  }
}
