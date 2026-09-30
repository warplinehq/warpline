import type { HandlerFn } from '../../../src/runtime/invoke-plugin.js'

// Holding the event loop is the one way a test can make a timer fire late
// without suspending the machine. The timeout timer comes due at 100ms and
// runs only when this loop yields, ~1.5s in: the same shape as a sleep.
export const handler: HandlerFn = async () => {
  const until = Date.now() + 1_500
  while (Date.now() < until) { /* hold the event loop */ }
  await new Promise<void>(r => setTimeout(r, 5_000))
  return {
    status: 'success',
    phases_completed: ['late-timer-plugin'],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: 'late-timer-plugin: completed',
    artifacts_produced: [],
    schema_version: 1,
  }
}
