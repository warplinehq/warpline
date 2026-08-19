/**
 * Board event emission helpers for the warpline auto-advance engine.
 *
 * Provides:
 *   emitBoardEvent()    — append one event JSON line to events.jsonl
 *   makeEvent()         — construct a BoardEvent with sane defaults
 *   emitRunStarted()    — run lifecycle: started
 *   emitRunCompleted()  — run lifecycle: completed
 *   emitPluginStarted() — plugin lifecycle: started
 *   emitPluginCompleted() — plugin lifecycle: completed
 *   emitPluginFailed()  — plugin lifecycle: failed
 *   emitPluginSkipped() — plugin lifecycle: skipped
 *   emitPluginGated()   — plugin lifecycle: gated (awaiting approval)
 *
 * Design:
 *   D-20: Engine emits structured events for all plugin lifecycle transitions.
 *   Events are appended to events.jsonl — Phase 85 board reads them.
 *   File path injectable for test isolation.
 *
 * Threat model:
 *   T-84-07: events.jsonl is append-only from engine side. No integrity guarantee
 *   needed — events are ephemeral operational data consumed by board UI.
 */
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { eventsJsonlPath } from '../lib/paths'
import type { BoardEvent } from '../schemas/board'

/**
 * Size cap for events.jsonl (2026-08-19, operator decision).
 *
 * The log is append-only and had grown to 74k lines (56% test-fixture noise
 * before the 2026-08-18 purge; ~24k source-ambiguous engine lines after it),
 * and every dashboard page's "N notices" header counts the whole file. The
 * cap self-maintains the file and ages residue out naturally. Trim fires only
 * past cap + slack so a busy run isn't rewriting the file on every append.
 * History beyond the cap lives in git.
 */
const EVENTS_LOG_CAP = 20_000
const EVENTS_LOG_TRIM_SLACK = 2_000

/**
 * Trim a JSONL event log to its newest `cap` lines. Exported for tests.
 * Atomic rewrite (tmp + rename); a concurrent append landing between the read
 * and the rename can be lost — acceptable for ephemeral operational data
 * (T-84-07), and the engine is single-writer per D-17.
 */
export async function _trimEventsLog(
  eventsPath: string,
  cap: number = EVENTS_LOG_CAP,
  slack: number = EVENTS_LOG_TRIM_SLACK,
): Promise<void> {
  let raw: string
  try {
    raw = await readFile(eventsPath, 'utf-8')
  } catch {
    return // nothing to trim
  }
  const lines = raw.split('\n').filter((l) => l.length > 0)
  if (lines.length <= cap + slack) return
  const tmp = `${eventsPath}.trim-tmp`
  await writeFile(tmp, lines.slice(-cap).join('\n') + '\n', 'utf-8')
  await rename(tmp, eventsPath)
}

/**
 * Append a single BoardEvent as a JSON line to events.jsonl.
 *
 * Creates the parent directory if it doesn't exist (idempotent).
 * Uses append mode — safe for concurrent writers within a single process
 * (per D-17, only one engine run at a time). Trims the file back to
 * EVENTS_LOG_CAP once it drifts past cap + slack.
 */
export async function emitBoardEvent(
  event: BoardEvent,
  eventsPath: string = eventsJsonlPath(),
): Promise<void> {
  await mkdir(dirname(eventsPath), { recursive: true })
  const line = JSON.stringify(event) + '\n'
  await appendFile(eventsPath, line, 'utf-8')
  // ponytail: O(file) line count per append past the threshold; events are
  // low-frequency (~100/day live). Move to a counter if that ever changes.
  await _trimEventsLog(eventsPath).catch(() => {
    /* trim failure must never block the run — next append retries */
  })
}

/**
 * Construct a BoardEvent with required fields and sane defaults.
 * Summary is capped at 200 chars per the Ink single-line constraint (D-21).
 */
export function makeEvent(
  type: BoardEvent['type'],
  source: string,
  summary: string,
  overrides: Partial<BoardEvent> = {},
): BoardEvent {
  return {
    event_id: crypto.randomUUID(),
    type,
    timestamp: new Date().toISOString(),
    source,
    summary: summary.slice(0, 200),
    severity: 'info',
    task_id: null,
    metadata_json: null,
    ...overrides,
  }
}

// -----------------------------------------------------------------------
// Convenience emitters — per D-20 lifecycle events
// -----------------------------------------------------------------------

/** Emit run_started event — call at the very beginning of runAdvance. */
export const emitRunStarted = (runId: string, eventsPath?: string): Promise<void> =>
  emitBoardEvent(makeEvent('run_started', 'engine', `Run ${runId} started`), eventsPath)

/** Emit run_completed event — call at the end of runAdvance with final status. */
export const emitRunCompleted = (runId: string, status: string, eventsPath?: string): Promise<void> =>
  emitBoardEvent(makeEvent('run_completed', 'engine', `Run ${runId} ${status}`), eventsPath)

/** Emit plugin_result event indicating plugin execution has begun. */
export const emitPluginStarted = (plugin: string, eventsPath?: string): Promise<void> =>
  emitBoardEvent(makeEvent('plugin_result', plugin, `${plugin}: started`), eventsPath)

/** Emit plugin_result event indicating plugin completed successfully. */
export const emitPluginCompleted = (plugin: string, summary: string, eventsPath?: string): Promise<void> =>
  emitBoardEvent(makeEvent('plugin_result', plugin, `${plugin}: ${summary}`), eventsPath)

/**
 * Emit error event indicating plugin failed.
 * severity=warning (not critical) — failed plugins are logged and execution continues
 * for remaining plugins in the level.
 */
export const emitPluginFailed = (plugin: string, error: string, eventsPath?: string): Promise<void> =>
  emitBoardEvent(
    makeEvent('error', plugin, `${plugin}: ${error}`, { severity: 'warning' }),
    eventsPath,
  )

/** Emit plugin_result event indicating plugin was skipped (fresh, manual, or locked). */
export const emitPluginSkipped = (plugin: string, reason: string, eventsPath?: string): Promise<void> =>
  emitBoardEvent(makeEvent('plugin_result', plugin, `${plugin}: skipped — ${reason}`), eventsPath)

/**
 * Emit an attempt_failed notice during invokePlugin's retry loop (Phase 121 D-09).
 *
 * Uses `type: 'notice'` because the BoardEvent enum is closed (nine values); the
 * retry sub-type is encoded in `summary` instead. Severity stays `info` — an
 * attempt failure is not an error until retries are exhausted.
 */
export const emitAttemptFailed = (
  plugin: string,
  attempt: number,
  error: string,
  eventsPath?: string,
): Promise<void> =>
  emitBoardEvent(
    makeEvent('notice', plugin, `attempt ${attempt} failed: ${error}`, {
      metadata_json: JSON.stringify({ plugin, attempt, retryable: true }),
    }),
    eventsPath,
  )

/**
 * Emit plugin_result event indicating supervised plugin is awaiting human approval.
 * severity=warning — gate requires action before engine can continue.
 */
export const emitPluginGated = (plugin: string, eventsPath?: string): Promise<void> =>
  emitBoardEvent(
    makeEvent('plugin_result', plugin, `${plugin}: awaiting approval`, { severity: 'warning' }),
    eventsPath,
  )

