/**
 * In-process plugin invocation for warpline.
 *
 * invokePlugin is a NEW function separate from invokeByKey (per Research A4).
 * invokeByKey remains untouched — it handles subprocess invocation of registry scripts.
 * invokePlugin handles direct in-process import of plugin handlers.
 *
 * Design decisions:
 *   D-05: Deterministic handlers imported directly (no subprocess)
 *   D-06: Wrapped in try/catch — handler exceptions become failed SkillResults
 *   Phase 121 D-01: Retry only when first error is `retryable: true`
 *   Phase 121 D-02/D-03: Defaults `max_retries=1`, `retry_delay_ms=2000` preserve pre-121 behaviour
 *   Phase 121 D-04/D-05/D-06: Exponential backoff × ±25% jitter, capped at 30s
 *   Phase 121 D-09: Each retried attempt emits an `attempt_failed` notice BoardEvent
 *   Phase 121 D-12/D-13: Per-attempt `timeout_ms` via AbortController; timeout is always fatal
 *   Phase 121 D-31/D-32: External AbortSignal threads to the handler; cancellation is always fatal
 *
 * Security (T-83-07):
 *   - Plugin path is constructed from pluginsDir() + validated plugin name
 *   - Handler output validated by Zod (SkillResultSchema.safeParse)
 *
 * Shared ownership with Phase 121 Plan 03:
 *   - Plan 01 lands the retry/timeout/abort core + exports HandlerFn and InvokePluginOptions.
 *   - Plan 03 replaces the no-op `persistArtifact` branch below with real
 *     writeRunArtifact + trimPluginHistory wiring.
 */
import { join } from 'node:path'
import { pluginsDir } from '../lib/paths'
import { SkillResultSchema, makeSkillError } from '../schemas/skill-result'
import type { SkillResult } from '../schemas/skill-result'
import type { PluginManifest } from '../schemas/plugin-manifest'
import { emitAttemptFailed } from '../board/engine-events'
import { writeRunArtifact, trimPluginHistory, type RunArtifact } from './run-artifacts'

/**
 * Resolve the default plugins directory via canonical paths.ts.
 */
function getDefaultPluginsDir(): string {
  return pluginsDir()
}

// -------------------------------------------------------------------------
// Types
// -------------------------------------------------------------------------

/**
 * Per-attempt record captured during invokePlugin's retry loop (Phase 121 D-26).
 */
export interface AttemptRecord {
  /** 1-indexed attempt number */
  attempt: number
  /** ISO timestamp when this attempt started */
  started_at: string
  /** Wall-clock duration of this attempt in milliseconds */
  elapsed_ms: number
  /** Terminal status of this attempt */
  status: 'success' | 'failed' | 'cancelled' | 'timeout'
  /** First error message from the attempt, or null on success */
  error: string | null
}

/** Full invocation result from an in-process plugin call */
export interface PluginInvocationResult {
  /** Plugin name that was invoked */
  plugin: string
  /** Parsed and validated SkillResult (never throws — errors become failed results) */
  result: SkillResult
  /** Wall-clock duration in milliseconds (all attempts + backoff) */
  duration_ms: number
  /** Number of attempts made (1 = no retry; N = 1 initial + N-1 retries) */
  attempt_count: number
  /** Per-attempt detail (Phase 121 D-26). attempts.length === attempt_count. */
  attempts: AttemptRecord[]
  /** Last error message after retries exhausted, or null on success */
  final_error: string | null
  /** Backward-compat alias — equals `attempt_count > 1` (kept for one release). */
  retried: boolean
  /** True when the run was cancelled via options.signal */
  cancelled: boolean
  /** True when an attempt tripped manifest.timeout_ms */
  timed_out: boolean
}

/**
 * Plugin handler signature. Phase 121 D-32: the `signal` parameter is new.
 * Handlers SHOULD forward it to abortable IO (fetch / Bun.spawn); handlers that
 * ignore it still run to natural completion or manifest.timeout_ms.
 */
export type HandlerFn = (
  manifest: PluginManifest,
  args: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<SkillResult>

/**
 * Options accepted by invokePlugin. Exported so Plan 03 can wire its API route
 * without `as any` casts. Plan 01 only consumes `pluginsDir`, `signal`, and
 * `maxRetriesOverride`; the other fields flow into the no-op persistArtifact
 * hook that Plan 03 Task 3.2 replaces.
 */
export interface InvokePluginOptions {
  /** Override plugins directory (for testing) */
  pluginsDir?: string
  /** External AbortSignal — when aborted, the in-flight attempt is cancelled */
  signal?: AbortSignal
  /** D-10: per-invocation override of manifest.max_retries (e.g. ?retries=N) */
  maxRetriesOverride?: number
  /** D-26: when true, Plan 03 wires the run artifact write into the end-of-loop hook */
  persistArtifact?: boolean
  /** Run id (Plan 03 passes this for SSE + artifact filename) */
  runId?: string
  /** D-38: true for manual / dashboard-triggered runs */
  userInitiated?: boolean
  /** Override runs dir for artifact persistence. Without it, persistArtifact
   *  writes to the REAL `.warpline/runs/` whatever the caller's own runsDir is —
   *  which is how test fixture run records leaked into live state (2026-08-18). */
  runsDir?: string
  /** Override events.jsonl path for retry notices — same leak class as runsDir. */
  eventsPath?: string
}

/**
 * Terminal run status for an invocation — the SINGLE mapping used by both the
 * persisted RunArtifact and the dashboard's live run bus / board events.
 *
 * `delegated` (2026-08-19): a `skipped` result whose summary carries the
 * `[needs-llm]` prefix is a successful HANDOFF to an LLM skill, not a failure.
 * It previously mapped to `failed`, which painted a red badge on /plugins and
 * made anomaly-watch treat every content-atomiser dispatch as critical.
 * A plain non-needs-llm `skipped` still maps to `failed` — no persisted-run
 * path produces one today; widen deliberately if one appears.
 */
export function deriveRunStatus(inv: {
  cancelled: boolean
  timed_out: boolean
  result: SkillResult | null
}): 'success' | 'failed' | 'cancelled' | 'timeout' | 'delegated' {
  if (inv.cancelled) return 'cancelled'
  if (inv.timed_out) return 'timeout'
  if (inv.result?.status === 'success') return 'success'
  if (
    inv.result?.status === 'skipped' &&
    inv.result.summary?.startsWith('[needs-llm]')
  ) {
    return 'delegated'
  }
  return 'failed'
}

// -------------------------------------------------------------------------
// invokePlugin
// -------------------------------------------------------------------------

/**
 * Invoke a plugin handler in-process via dynamic import.
 *
 * @param pluginName - Plugin directory name under .warpline/plugins/ (or pluginsDir override)
 * @param args - Arguments passed to the handler function
 * @param options - InvokePluginOptions (see type)
 */
export async function invokePlugin(
  pluginName: string,
  args: Record<string, unknown> = {},
  options: InvokePluginOptions = {},
): Promise<PluginInvocationResult> {
  const dir = options.pluginsDir ?? getDefaultPluginsDir()
  const start = Date.now()
  const startedAt = new Date(start).toISOString()

  // -- Load handler and manifest modules --
  const handlerPath = join(dir, pluginName, 'handler.ts')
  const manifestPath = join(dir, pluginName, 'manifest.ts')

  let handlerFn: HandlerFn
  let manifest: PluginManifest

  try {
    const [handlerMod, manifestMod] = await Promise.all([
      import(handlerPath),
      import(manifestPath),
    ])
    handlerFn = handlerMod.handler
    manifest = manifestMod.manifest
  } catch (err) {
    const failedAttempt: AttemptRecord = {
      attempt: 1,
      started_at: new Date(start).toISOString(),
      elapsed_ms: Date.now() - start,
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    }
    return {
      plugin: pluginName,
      result: {
        status: 'failed',
        phases_completed: [],
        phases_failed: [pluginName],
        errors: [
          makeSkillError(
            'dependency_unavailable',
            `Failed to load plugin '${pluginName}': ${err instanceof Error ? err.message : String(err)}`,
          ),
        ],
        data_freshness: {},
        summary: `${pluginName}: failed to load handler`,
        artifacts_produced: [],
        schema_version: 1,
      },
      duration_ms: Date.now() - start,
      attempt_count: 1,
      attempts: [failedAttempt],
      final_error: failedAttempt.error,
      retried: false,
      cancelled: false,
      timed_out: false,
    }
  }

  // -------------------------------------------------------------------
  // Retry loop — Phase 121 D-01/D-04/D-05/D-06/D-08
  // -------------------------------------------------------------------
  // Manifest fields may be absent when the caller bypassed zod parse (legacy
  // test fixtures). Fall back to the schema defaults (D-02/D-03).
  const maxRetries = options.maxRetriesOverride ?? manifest.max_retries ?? 1
  const baseDelay = manifest.retry_delay_ms ?? 2000
  const timeoutMs = manifest.timeout_ms ?? 60_000
  const attempts: AttemptRecord[] = []

  let finalResult: SkillResult | null = null
  let finalErr: string | null = null
  let cancelled = false
  let timedOut = false

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // -- Backoff between retries (not before first attempt) --
    if (attempt > 0) {
      const expBase = Math.min(baseDelay * Math.pow(2, attempt - 1), 30_000)
      const jitterMult = 1 + (Math.random() * 0.5 - 0.25) // ±25%
      const delay = Math.round(expBase * jitterMult)
      await new Promise<void>(r => setTimeout(r, delay))
    }

    // -- Per-attempt AbortController: races external signal + timeout --
    const attemptStart = Date.now()
    const attemptCtl = new AbortController()
    const onExternalAbort = () =>
      attemptCtl.abort(options.signal?.reason ?? 'cancelled')
    if (options.signal?.aborted) {
      attemptCtl.abort(options.signal.reason ?? 'cancelled')
    } else {
      options.signal?.addEventListener('abort', onExternalAbort, { once: true })
    }
    const timeoutTimer = setTimeout(
      () => attemptCtl.abort('timeout'),
      timeoutMs,
    )

    // Race the handler against the attempt signal so abort-unaware handlers
    // don't pin the event loop when timeout fires or the caller cancels.
    // Abort-aware handlers that honour the signal will still return first.
    const abortPromise = new Promise<SkillResult>(resolvePromise => {
      const onAbort = () => {
        const reason = String(attemptCtl.signal.reason ?? '')
        const isTimeout = reason === 'timeout' || reason.includes('timeout')
        resolvePromise({
          status: 'failed',
          phases_completed: [],
          phases_failed: [pluginName],
          errors: [
            makeSkillError(
              isTimeout ? 'timeout' : 'dependency_unavailable',
              isTimeout
                ? `Plugin '${pluginName}' exceeded timeout_ms=${timeoutMs}`
                : `Plugin '${pluginName}' cancelled: ${reason || 'aborted'}`,
              { retryable: false },
            ),
          ],
          data_freshness: {},
          summary: isTimeout
            ? `${pluginName}: timeout`
            : `${pluginName}: cancelled`,
          artifacts_produced: [],
          schema_version: 1,
        })
      }
      if (attemptCtl.signal.aborted) onAbort()
      else attemptCtl.signal.addEventListener('abort', onAbort, { once: true })
    })

    let rawResult: SkillResult
    try {
      rawResult = await Promise.race([
        executeHandler(pluginName, handlerFn, manifest, args, attemptCtl.signal),
        abortPromise,
      ])
    } finally {
      clearTimeout(timeoutTimer)
      options.signal?.removeEventListener('abort', onExternalAbort)
    }

    // -- Validate shape --
    const parsed = SkillResultSchema.safeParse(rawResult)
    const thisResult: SkillResult = parsed.success
      ? parsed.data
      : {
          status: 'failed',
          phases_completed: [],
          phases_failed: [pluginName],
          errors: [
            makeSkillError(
              'parse_error',
              `Plugin '${pluginName}' returned invalid SkillResult: ${parsed.error?.message?.slice(0, 300) ?? 'parse error'}`,
            ),
          ],
          data_freshness: {},
          summary: `${pluginName}: invalid handler output`,
          artifacts_produced: [],
          schema_version: 1,
        }

    const elapsed = Date.now() - attemptStart
    const firstError = thisResult.errors?.[0]?.message ?? null

    // -- Classify attempt status (timeout/cancel take precedence over failed) --
    let attemptStatus: AttemptRecord['status']
    if (attemptCtl.signal.aborted) {
      const reason = String(attemptCtl.signal.reason ?? '')
      if (reason === 'timeout' || reason.includes('timeout')) {
        attemptStatus = 'timeout'
        timedOut = true
      } else {
        attemptStatus = 'cancelled'
        cancelled = true
      }
    } else {
      attemptStatus = thisResult.status === 'success' ? 'success' : 'failed'
    }

    attempts.push({
      attempt: attempt + 1,
      started_at: new Date(attemptStart).toISOString(),
      elapsed_ms: elapsed,
      status: attemptStatus,
      error: attemptStatus === 'success' ? null : firstError,
    })
    finalResult = thisResult
    finalErr = attemptStatus === 'success' ? null : firstError

    // -- LLM stub pass-through: skipped + [needs-llm] prefix is never retried --
    if (thisResult.status === 'skipped') break

    // -- D-12 / D-31: timeout and external-cancel are fatal — no retry --
    if (timedOut || cancelled) break

    // -- D-01: retry only on retryable:true and only while attempts remain --
    const shouldRetry =
      thisResult.status === 'failed' &&
      thisResult.errors?.[0]?.retryable === true &&
      attempt < maxRetries
    if (!shouldRetry) break

    // -- D-09: emit attempt_failed notice before sleeping again --
    await emitAttemptFailed(
      pluginName,
      attempt + 1,
      firstError ?? 'unknown error',
      options.eventsPath,
    )
  }

  const attemptCount = attempts.length

  // -------------------------------------------------------------------
  // Phase 121 D-26/D-27 — Run artifact persistence (Plan 03 Task 3.2).
  //
  // Fire on every invocation that opts in via `persistArtifact: true`. The
  // manual-run path (Plan 03 Task 3.3) always opts in; the pipeline path
  // still writes its own combined artifact via engine.ts so we intentionally
  // skip there by leaving `persistArtifact` undefined.
  // -------------------------------------------------------------------
  if (options.persistArtifact) {
    const runId = options.runId ?? crypto.randomUUID()
    const artifactStatus = deriveRunStatus({
      cancelled,
      timed_out: timedOut,
      result: finalResult,
    })
    const artifact: RunArtifact = {
      run_id: runId,
      plugin: pluginName,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      status: artifactStatus,
      summary: finalResult?.summary ?? `${pluginName}: no summary`,
      user_initiated: options.userInitiated ?? false,
      attempts,
      final_error: finalErr,
      cancelled,
      timed_out: timedOut,
      retried: attemptCount > 1,
    }
    try {
      await writeRunArtifact(artifact, { runsDir: options.runsDir })
      await trimPluginHistory(pluginName, 20, { runsDir: options.runsDir })
    } catch {
      // Persistence failures must not bubble into the plugin result — the
      // caller already has the in-memory PluginInvocationResult. An operator
      // can inspect the engine-events log if artifacts stop appearing.
    }
  }
  return {
    plugin: pluginName,
    result: finalResult ?? {
      status: 'failed',
      phases_completed: [],
      phases_failed: [pluginName],
      errors: [makeSkillError('dependency_unavailable', 'no attempt ran')],
      data_freshness: {},
      summary: `${pluginName}: no attempt produced a result`,
      artifacts_produced: [],
      schema_version: 1,
    },
    duration_ms: Date.now() - start,
    attempt_count: attemptCount,
    attempts,
    final_error: finalErr,
    retried: attemptCount > 1,
    cancelled,
    timed_out: timedOut,
  }
}

// -------------------------------------------------------------------------
// Internal helper
// -------------------------------------------------------------------------

async function executeHandler(
  pluginName: string,
  handlerFn: HandlerFn,
  manifest: PluginManifest,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<SkillResult> {
  try {
    return await handlerFn(manifest, args, signal)
  } catch (err) {
    return {
      status: 'failed',
      phases_completed: [],
      phases_failed: [pluginName],
      errors: [
        makeSkillError(
          'dependency_unavailable',
          err instanceof Error ? err.message : String(err),
        ),
      ],
      data_freshness: {},
      summary: `${pluginName} handler threw: ${err instanceof Error ? err.message : String(err)}`,
      artifacts_produced: [],
      schema_version: 1,
    }
  }
}
