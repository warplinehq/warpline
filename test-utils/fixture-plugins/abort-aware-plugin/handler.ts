import type { HandlerFn } from '../../../src/runtime/invoke-plugin.js'

/**
 * Loops on `signal.aborted` and resolves with a non-retryable cancelled
 * SkillResult the moment the caller aborts. Used to verify that AbortSignal is
 * threaded through to handlers end-to-end.
 */
export const handler: HandlerFn = async (_manifest, _args, signal) => {
  for (let i = 0; i < 100; i++) {
    if (signal.aborted) {
      return {
        status: 'failed',
        phases_completed: [],
        phases_failed: ['abort-aware-plugin'],
        errors: [
          {
            code: 'dependency_unavailable',
            message: 'aborted by caller',
            impact: 'LOW',
            retryable: false,
          },
        ],
        data_freshness: {},
        summary: 'abort-aware-plugin: aborted',
        artifacts_produced: [],
        schema_version: 1,
      }
    }
    await new Promise<void>(r => setTimeout(r, 10))
  }

  return {
    status: 'success',
    phases_completed: ['abort-aware-plugin'],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: 'abort-aware-plugin: completed without abort',
    artifacts_produced: [],
    schema_version: 1,
  }
}
