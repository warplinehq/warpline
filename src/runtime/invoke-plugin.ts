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
import { pluginsDir, pluginConfigPath } from '../lib/paths.js'
import { loadPluginConfig, PluginConfigError } from '../lib/plugin-config.js'
import { resolvePluginArgs } from '../schemas/plugin-config.js'
import { SkillResultSchema, makeSkillError } from '../schemas/skill-result.js'
import type { SkillResult, SkillResultInput } from '../schemas/skill-result.js'
import type { PluginManifest } from '../schemas/plugin-manifest.js'
import { emitAttemptFailed } from '../board/engine-events.js'
import { writeRunArtifact, trimPluginHistory, type RunArtifact } from './run-artifacts.js'
import { mintContext } from './capabilities.js'
import type { CapabilityContext, CapabilityGrantWitness } from './capabilities.js'

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
 *
 * The return is `SkillResultInput`, the schema's INPUT type, not `SkillResult`.
 * A handler writes a result; it does not read one back. Typing it against the
 * output type made the bare-string `artifacts_produced` arm — which the schema
 * documents as valid until 1.0 — unreachable through the only path a plugin
 * has. The widening is additive: everything assignable to `SkillResult` is
 * still assignable here, and the parse boundary below is unmoved.
 */
export type HandlerFn = (
  manifest: PluginManifest,
  args: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<SkillResultInput>

/**
 * The handler signature with the capability context on it.
 *
 * This is what `executeHandler` calls through, and `HandlerFn` above is its
 * assignable-narrower variant rather than a second code path: a three-parameter
 * function type IS assignable to a four-parameter one, so every handler written
 * before this parameter existed keeps working by construction and no
 * compatibility branch exists to drift.
 *
 * Widening the PARAMETER TYPE is the whole mechanism, and it is not the same
 * claim as "JavaScript ignores extra arguments". That is true at run time and
 * insufficient at compile time — calling a `HandlerFn`-typed value with four
 * arguments is `TS2554: Expected 3 arguments, but got 4`. So the type below is
 * what `executeHandler` takes, and nothing is cast to reach the fourth
 * argument.
 *
 * `HandlerFn` in the root barrel is untouched and stays the published name. It
 * is permanent public contract from 0.1.0, and naming a capability type inside
 * a root-barrel signature would make that type structurally permanent while its
 * own specifier promises the opposite. A plugin author who wants the fourth
 * parameter typed imports this from `warpline/unstable-capabilities`, where the
 * instability is in the import path.
 */
export type CapabilityHandlerFn = (
  manifest: PluginManifest,
  args: Record<string, unknown>,
  signal: AbortSignal,
  capabilities: CapabilityContext,
) => Promise<SkillResultInput>

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
 *
 * It reads FIELD-OR-PREFIX: the structured `needs_llm` field, or the older
 * `[needs-llm]` summary prefix. Both, because the prefix arm cannot be retired
 * yet — the scanner that finds handoffs ships as a Claude Code skill, outside
 * this package and outside `bun test`'s reach, and it reads the summary string.
 * Dropping the prefix would move the same disagreement one layer out, where
 * nothing here can see it. A `skipped` status is still required by both arms:
 * the field alone must not make a successful result delegated.
 */
function isHandoff(result: SkillResult | null): boolean {
  if (result?.status !== 'skipped') return false
  return result.needs_llm !== undefined || (result.summary?.startsWith('[needs-llm]') ?? false)
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
 * `witness` is a SEPARATE, NON-DEFAULTED parameter, and never a field on
 * `options`. `options` carries a default, so every field on it is optional by
 * construction — a witness placed there could be omitted and would still
 * compile, which turns a caller obligation fixed at the signature back into a
 * rule each call site has to remember. Here, omitting it does not compile.
 *
 * What that buys is narrow and worth stating exactly. It is not that a witness
 * cannot be constructed by hand: within one package any caller can write the
 * literal, and this runtime does not sandbox its handlers. It is that a NEW
 * caller — including a third-party host reaching this function through
 * `warpline/unstable-runtime` — cannot be added without answering whether the
 * Grant was read. The runtime hands a handler authority minted from what its
 * manifest declared, so the caller that supplies no answer is the one that
 * would make warpline the deputy granting it.
 *
 * @param pluginName - Plugin directory name under .warpline/plugins/ (or pluginsDir override)
 * @param args - Arguments passed to the handler function
 * @param options - InvokePluginOptions (see type)
 * @param witness - What the caller learned when it read the Grant, or the arm
 *   naming why it read none. Required; there is no default and no `?`.
 */
export async function invokePlugin(
  pluginName: string,
  args: Record<string, unknown> = {},
  options: InvokePluginOptions = {},
  witness: CapabilityGrantWitness,
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
  // Config resolution
  // -------------------------------------------------------------------
  // Here, and not in the callers. Both production call sites and any
  // third-party host calling runAdvance route through this function, so one
  // insertion serves all of them and none can skip it.
  //
  // ABOVE the retry loop, and that placement is the whole mechanism behind
  // "an invalid config is never retried". Only `retryable: true` re-enters the
  // loop, but this return sits outside it entirely, so the rule holds by
  // construction rather than by a predicate someone could edit.
  //
  // The SHAPE below is the load-failure arm above. The error CODE is not:
  // a config an operator mistyped is a parse failure, not a missing
  // dependency, and it takes its wording from the invalid-handler-output arm
  // further down.
  const configPath = pluginConfigPath(pluginName)
  let resolvedArgs: Record<string, unknown>
  try {
    const fileConfig = await loadPluginConfig(configPath)
    // `?? {}` because a manifest that bypassed zod parse has no `inputs` at
    // all — the same tolerance the retry-loop defaults below rely on.
    const resolution = resolvePluginArgs(manifest.inputs ?? {}, fileConfig, args)
    if (!resolution.ok) {
      return configFailure(
        pluginName,
        start,
        `Plugin '${pluginName}' has an invalid config (${configPath}): ${resolution.problems.join('; ')}`,
      )
    }
    resolvedArgs = resolution.args
  } catch (err) {
    if (!(err instanceof PluginConfigError)) throw err
    return configFailure(pluginName, start, err.message)
  }

  // -------------------------------------------------------------------
  // Capability context
  // -------------------------------------------------------------------
  // Here, and not in the callers, for the reason the config resolution above
  // states in its own words: both production call sites and any third-party
  // host reaching this function through `warpline/unstable-runtime` route
  // through it, so one insertion serves every caller and none can skip it.
  //
  // ABOVE the retry loop, because the members a plugin is entitled to are
  // decided by what its manifest declared and by the answer the caller carried
  // in. Neither changes between attempt one and attempt three, and minting per
  // attempt would invite a member that quietly differs across them.
  //
  // Only `context` is taken. `withheld` is the runtime-facing half — the
  // per-member refusal an operator can act on — and nothing here has a place to
  // surface it yet, so it is left where it is rather than dropped into a log
  // line nobody reads.
  const { context: capabilities } = mintContext(
    { manifest, caller: { plugin: pluginName, runId } },
    witness,
  )

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

    let rawResult: SkillResultInput
    try {
      rawResult = await Promise.race([
        executeHandler(pluginName, handlerFn, manifest, resolvedArgs, attemptCtl.signal, capabilities),
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
    // `runId`, not `options.runId`. The id is minted above when the caller
    // supplies none, and it is the id that stamps the Outputs and names the run
    // artifact — so this is the only value that links the notice on the board
    // back to the artifact it came from, which is the whole point of carrying
    // one. The comment that used to sit here claimed `warpline run` supplies
    // `options.runId`; it does not (`run-plugin.ts` passes `signal`,
    // `maxRetriesOverride`, `persistArtifact` and `userInitiated`, and no run
    // id). So every retried `warpline run` wrote its artifact under the
    // synthesized id and rendered its retry notice as "no run".
    await emitAttemptFailed(
      pluginName,
      attempt + 1,
      firstError ?? 'unknown error',
      runId,
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

/**
 * The one-attempt failure a bad config produces.
 *
 * `message` is composed by the caller and is the contract half that matters:
 * it names the config file path and the offending input key and the shape
 * expected of it, and it never carries the value that was read. Config files
 * are where operators put tokens, and this string lands in a run log.
 */
function configFailure(
  pluginName: string,
  start: number,
  message: string,
): PluginInvocationResult {
  const failedAttempt: AttemptRecord = {
    attempt: 1,
    started_at: new Date(start).toISOString(),
    elapsed_ms: Date.now() - start,
    status: 'failed',
    error: message,
  }
  return {
    plugin: pluginName,
    result: {
      status: 'failed',
      phases_completed: [],
      phases_failed: [pluginName],
      errors: [makeSkillError('parse_error', message)],
      data_freshness: {},
      summary: `${pluginName}: invalid config`,
      artifacts_produced: [],
      schema_version: 1,
    },
    duration_ms: Date.now() - start,
    attempt_count: 1,
    attempts: [failedAttempt],
    final_error: message,
    retried: false,
    cancelled: false,
    timed_out: false,
  }
}

async function executeHandler(
  pluginName: string,
  handlerFn: CapabilityHandlerFn,
  manifest: PluginManifest,
  args: Record<string, unknown>,
  signal: AbortSignal,
  capabilities: CapabilityContext,
): Promise<SkillResultInput> {
  try {
    return await handlerFn(manifest, args, signal, capabilities)
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
