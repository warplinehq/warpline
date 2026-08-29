/**
 * In-process plugin invocation for warpline.
 *
 * Handlers are imported and called in-process rather than spawned: they are
 * deterministic TypeScript, and a subprocess would buy isolation warpline does
 * not need while costing the AbortSignal thread it does. Every call is wrapped
 * in try/catch, so a handler that throws becomes a failed SkillResult instead
 * of taking the run down.
 *
 * The retry / timeout / cancel rules, which are easy to get subtly wrong:
 *   - Retry only when the FIRST error was `retryable: true`.
 *   - Delay is exponential backoff × ±25% jitter, capped at 30s. Jitter matters
 *     because the engine runs a level in parallel — unjittered retries would
 *     re-collide on exactly the beat that just failed.
 *   - Each retried attempt emits an `attempt_failed` notice BoardEvent, so a
 *     run that eventually succeeds still shows what it cost.
 *   - `timeout_ms` is PER ATTEMPT, via AbortController, and a timeout is always
 *     fatal — never retried. A retry would double the budget the manifest
 *     declared, which is the one thing a timeout exists to bound.
 *   - An external AbortSignal threads through to the handler, and cancellation
 *     is likewise always fatal.
 *
 * Security:
 *   - Plugin path is constructed from pluginsDir() + a validated plugin name.
 *   - Handler output is validated by Zod (SkillResultSchema.safeParse).
 */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { pluginsDir } from '../lib/paths.js'
import { SkillResultSchema, makeSkillError } from '../schemas/skill-result.js'
import type { SkillResult } from '../schemas/skill-result.js'
import type { PluginManifest } from '../schemas/plugin-manifest.js'
import { emitAttemptFailed } from '../board/engine-events.js'
import { writeRunArtifact, trimPluginHistory, type RunArtifact } from './run-artifacts.js'

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
 * Per-attempt record captured during invokePlugin's retry loop.
 */
export interface AttemptRecord {
  /** 1-indexed attempt number */
  attempt: number
  /** ISO timestamp when this attempt started */
  started_at: string
  /** Wall-clock duration of this attempt in milliseconds */
  elapsed_ms: number
  /**
   * Terminal status of this attempt.
   *
   * `delegated` mirrors the run-level status of the same name: an attempt that
   * ended in a `[needs-llm]` handoff dispatched successfully, so calling it
   * `failed` misreports it to anyone reading `attempts[]` directly. Both
   * levels classify through `isHandoff`, so they cannot drift apart.
   */
  status: 'success' | 'failed' | 'cancelled' | 'timeout' | 'delegated'
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
  /** Per-attempt detail. attempts.length === attempt_count. */
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
 * Plugin handler signature.
 * Handlers SHOULD forward it to abortable IO (fetch / child_process); handlers that
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
  /** Per-invocation override of manifest.max_retries (e.g. `--retries=N`) */
  maxRetriesOverride?: number
  /** When true, the end-of-loop hook writes a run artifact for this invocation */
  persistArtifact?: boolean
  /** Run id — used for the artifact filename and any event stream */
  runId?: string
  /** True for manual / host-triggered runs, as opposed to scheduled ones */
  userInitiated?: boolean
  /** Override runs dir for artifact persistence. Without it, persistArtifact
   *  writes to the REAL `.warpline/runs/` whatever the caller's own runsDir is —
   *  which is how test fixture run records leaked into live state (2026-08-18). */
  runsDir?: string
  /** Override events.jsonl path for retry notices — same leak class as runsDir. */
  eventsPath?: string
}

/**
 * Is this result a `[needs-llm]` handoff?
 *
 * One definition, because there are two classifiers that must never disagree:
 * the run-level `deriveRunStatus` below and the attempt-level classifier in
 * the retry loop. They disagreed until 2026-08-28 — the run said `delegated`
 * while its own `attempts[0]` said `failed` — and a second copy of this
 * predicate is exactly how that comes back.
 */
function isHandoff(result: SkillResult | null): boolean {
  return result?.status === 'skipped' && (result.summary?.startsWith('[needs-llm]') ?? false)
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
  if (isHandoff(inv.result)) return 'delegated'
  return 'failed'
}

/**
 * Stamp run provenance onto every Output a result carries.
 *
 * The runtime says which run produced an Output and when — never the plugin.
 * The assignment is unconditional and overwrites whatever the handler put
 * there: a plugin that could stamp its own `run_id` could claim a run it did
 * not come from, so `output.run_id ?? runId` would be the bug, not the fix.
 *
 * Nothing is synthesized. A result that produced no Output gets no Output.
 */
export function stampOutputs(result: SkillResult, runId: string): SkillResult {
  if (result.artifacts_produced.length === 0) return result
  const producedAt = new Date().toISOString()
  return {
    ...result,
    artifacts_produced: result.artifacts_produced.map((o) => ({
      ...o,
      run_id: runId,
      produced_at: producedAt,
    })),
  }
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
  // One id for this invocation, shared by the Output provenance stamp below and
  // by the run artifact further down. They used to be able to disagree because
  // the artifact minted its own.
  const runId = options.runId ?? crypto.randomUUID()

  // -- Load handler and manifest modules --
  // import() needs file:// URLs, not bare absolute paths.
  const handlerPath = pathToFileURL(join(dir, pluginName, 'handler.ts')).href
  const manifestPath = pathToFileURL(join(dir, pluginName, 'manifest.ts')).href

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
  // Retry loop
  // -------------------------------------------------------------------
  // Manifest fields may be absent when the caller bypassed zod parse (legacy
  // test fixtures). Fall back to the schema defaults.
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
    // The parse boundary is also the provenance boundary: bare-string artifacts
    // normalize to Outputs here, and the runtime stamps them here, so every
    // caller downstream sees one shape carrying a run it can trust.
    const parsed = SkillResultSchema.safeParse(rawResult)
    const thisResult: SkillResult = stampOutputs(
      parsed.success
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
          },
      runId,
    )

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
    } else if (thisResult.status === 'success') {
      attemptStatus = 'success'
    } else if (isHandoff(thisResult)) {
      attemptStatus = 'delegated'
    } else {
      attemptStatus = 'failed'
    }

    // A dispatched handoff is not an error, so it carries none — the same
    // reason `delegated` exists at all. Both fields used to test `=== 'success'`,
    // which meant "not success" implied "failed"; that stopped being true the
    // moment a fifth status arrived, and a handoff that also set `errors[]`
    // would have reported a `final_error` on a run that did not fail.
    const attemptErrored = attemptStatus !== 'success' && attemptStatus !== 'delegated'

    attempts.push({
      attempt: attempt + 1,
      started_at: new Date(attemptStart).toISOString(),
      elapsed_ms: elapsed,
      status: attemptStatus,
      error: attemptErrored ? firstError : null,
    })
    finalResult = thisResult
    finalErr = attemptErrored ? firstError : null

    // -- LLM stub pass-through: skipped + [needs-llm] prefix is never retried --
    if (thisResult.status === 'skipped') break

    // -- Timeout and external cancel are fatal — never retried --
    if (timedOut || cancelled) break

    // -- Retry only on retryable:true, and only while attempts remain --
    const shouldRetry =
      thisResult.status === 'failed' &&
      thisResult.errors?.[0]?.retryable === true &&
      attempt < maxRetries
    if (!shouldRetry) break

    // -- Emit an attempt_failed notice before sleeping again --
    // `options.runId` is set by the engine advance and by `warpline run`
    // alike; null only where a caller invoked a plugin outside either, which
    // is exactly what a null run id means.
    await emitAttemptFailed(
      pluginName,
      attempt + 1,
      firstError ?? 'unknown error',
      options.runId ?? null,
      options.eventsPath,
    )
  }

  const attemptCount = attempts.length

  // -------------------------------------------------------------------
  // Run artifact persistence.
  //
  // Fires on every invocation that opts in via `persistArtifact: true`. The
  // manual-run path always opts in; the pipeline path still writes its own
  // combined artifact via engine.ts, so we intentionally
  // skip there by leaving `persistArtifact` undefined.
  // -------------------------------------------------------------------
  if (options.persistArtifact) {
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
