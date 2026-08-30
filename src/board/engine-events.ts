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
 *   emitGateInvalidated() — a parked gate was discarded rather than applied
 *
 * Design:
 *   The engine emits a structured event for every plugin lifecycle transition;
 *   they are appended to events.jsonl, which the board reads. The file path is
 *   injectable so tests do not touch a real log.
 *
 *   events.jsonl is append-only from the engine's side and carries no integrity
 *   guarantee. That is deliberate rather than an omission: these are ephemeral
 *   operational breadcrumbs for a UI, not an audit trail, and nothing downstream
 *   may treat them as one.
 */
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { eventsJsonlPath } from '../lib/paths.js'
import type { BoardEvent } from '../schemas/board.js'

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
 * and the rename can be lost — acceptable for ephemeral operational data, and
 * the engine is single-writer anyway.
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
 * (only one engine run at a time). Trims the file back to
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
 *
 * Summary is capped at 200 chars because an event is rendered as one line in a
 * list — the board CLI's notice table and the Board's Ask rows both — and a
 * longer summary overflows the row rather than telling anyone more.
 *
 * `runId` is required and has no default on purpose. Every call site has to
 * decide whether this event belongs to an advance or not, and the compiler is
 * what asks: a default would let a new emitter quietly write `null` for an
 * event the engine could have named. Pass `null` only where it is true.
 */
export function makeEvent(
  type: BoardEvent['type'],
  source: string,
  summary: string,
  runId: string | null,
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
    run_id: runId,
    metadata_json: null,
    ...overrides,
  }
}

// -----------------------------------------------------------------------
// Convenience emitters — one per lifecycle transition
// -----------------------------------------------------------------------

/** Emit run_started event — call at the very beginning of runAdvance. */
export const emitRunStarted = (runId: string, eventsPath?: string): Promise<void> =>
  emitBoardEvent(makeEvent('run_started', 'engine', `Run ${runId} started`, runId), eventsPath)

/** Emit run_completed event — call at the end of runAdvance with final status. */
export const emitRunCompleted = (runId: string, status: string, eventsPath?: string): Promise<void> =>
  emitBoardEvent(makeEvent('run_completed', 'engine', `Run ${runId} ${status}`, runId), eventsPath)

/** Emit plugin_result event indicating plugin execution has begun. */
export const emitPluginStarted = (plugin: string, runId: string | null, eventsPath?: string): Promise<void> =>
  emitBoardEvent(makeEvent('plugin_result', plugin, `${plugin}: started`, runId), eventsPath)

/** Emit plugin_result event indicating plugin completed successfully. */
export const emitPluginCompleted = (plugin: string, summary: string, runId: string | null, eventsPath?: string): Promise<void> =>
  emitBoardEvent(makeEvent('plugin_result', plugin, `${plugin}: ${summary}`, runId), eventsPath)

/**
 * Emit error event indicating plugin failed.
 * severity=warning (not critical) — failed plugins are logged and execution continues
 * for remaining plugins in the level.
 */
export const emitPluginFailed = (plugin: string, error: string, runId: string | null, eventsPath?: string): Promise<void> =>
  emitBoardEvent(
    makeEvent('error', plugin, `${plugin}: ${error}`, runId, { severity: 'warning' }),
    eventsPath,
  )

/** Emit plugin_result event indicating plugin was skipped (fresh, manual, or locked). */
export const emitPluginSkipped = (plugin: string, reason: string, runId: string | null, eventsPath?: string): Promise<void> =>
  emitBoardEvent(makeEvent('plugin_result', plugin, `${plugin}: skipped — ${reason}`, runId), eventsPath)

/**
 * Emit an attempt_failed notice during invokePlugin's retry loop.
 *
 * Uses `type: 'notice'` because the BoardEvent enum is closed (nine values); the
 * retry sub-type is encoded in `summary` instead. Severity stays `info` — an
 * attempt failure is not an error until retries are exhausted.
 */
export const emitAttemptFailed = (
  plugin: string,
  attempt: number,
  error: string,
  runId: string | null,
  eventsPath?: string,
): Promise<void> =>
  emitBoardEvent(
    makeEvent('notice', plugin, `attempt ${attempt} failed: ${error}`, runId, {
      metadata_json: JSON.stringify({ plugin, attempt, retryable: true }),
    }),
    eventsPath,
  )

/**
 * Emit a notice that a parked gate was thrown away rather than applied.
 *
 * `reason` says which of the three discards happened: a pre-Phase-8 stub found
 * at read time, a dependency that moved since the gated run started, or an
 * expiry. All three leave the plugin due again on the next advance.
 *
 * Rides `type: 'notice'` for the same reason `emitAttemptFailed` does, and the
 * reason is worth stating in print rather than rediscovering: growing
 * `BoardEventSchema.type` raises NO compile error — `typeLabel` in
 * `board-cli.ts` has a default arm — while `VISIBLE_TYPES` is a hand-maintained
 * Set, so a new member would be silently dropped from every board view. Any
 * `notice` is already in that Set. The sub-type therefore lives in
 * `metadata_json`, machine-readable, rather than in the enum.
 */
export const emitGateInvalidated = (
  plugin: string,
  runId: string | null,
  reason: 'stub' | 'dependency_moved' | 'expired',
  eventsPath?: string,
): Promise<void> =>
  emitBoardEvent(
    makeEvent(
      'notice',
      plugin,
      `${plugin}: parked gate discarded — ${GATE_DISCARD_PROSE[reason]}`,
      runId,
      {
        severity: 'warning',
        metadata_json: JSON.stringify({
          event: reason === 'expired' ? 'gate_expired' : 'gate_invalidated',
          plugin,
          run_id: runId,
          reason,
        }),
      },
    ),
    eventsPath,
  )

/**
 * Emit a notice that an operator denied a plugin's proposal.
 *
 * Severity `info`, not `warning`: a recorded denial is the system working as
 * intended — a human answered a question. The gate notices next door are
 * `warning` because something the operator was waiting on was thrown away
 * without an answer, which is a different kind of news.
 *
 * Rides `type: 'notice'` for the reason `emitGateInvalidated` states above:
 * growing `BoardEventSchema.type` raises no compile error and a new member
 * would be silently dropped from every board view by the hand-maintained
 * `VISIBLE_TYPES` set. Any `notice` is already in that set, so the sub-type
 * lives in `metadata_json` where a reader can match on it.
 */
export const emitDenialRecorded = (
  plugin: string,
  reason: string,
  fingerprint: string,
  eventsPath?: string,
): Promise<void> =>
  emitBoardEvent(
    makeEvent('notice', plugin, `${plugin}: denied — ${reason}`, null, {
      severity: 'info',
      metadata_json: JSON.stringify({ event: 'denial_recorded', plugin, reason, fingerprint }),
    }),
    eventsPath,
  )

/**
 * Emit a notice that a plugin was skipped because a live denial answered it.
 *
 * NOT `emitPluginSkipped`. The run log distinguishes `denied` from `skipped`
 * precisely so an answered question cannot be read as an unanswered one, and
 * filing the event as a skip put a denial in the same board bucket as "no
 * Grant" and "still fresh" — so the two logs disagreed about the same advance.
 *
 * Rides `type: 'notice'` with a `metadata_json` discriminator for the reason
 * `emitGateInvalidated` states above: growing `BoardEventSchema.type` raises no
 * compile error and a new member would be silently dropped from every board
 * view by the hand-maintained `VISIBLE_TYPES` set. Severity `info`, matching
 * `emitDenialRecorded` — the denial being honoured is the system working.
 */
export const emitPluginDenied = (
  plugin: string,
  reason: string,
  runId: string | null,
  eventsPath?: string,
): Promise<void> =>
  emitBoardEvent(
    makeEvent('notice', plugin, `${plugin}: denied — ${reason}`, runId, {
      severity: 'info',
      metadata_json: JSON.stringify({ event: 'plugin_denied', plugin, run_id: runId, reason }),
    }),
    eventsPath,
  )

const GATE_DISCARD_PROSE: Record<'stub' | 'dependency_moved' | 'expired', string> = {
  stub: 'written by a build older than the one holding the real result, so there is no outcome to approve',
  dependency_moved: 'a dependency re-ran after the gated run started, so the result was computed against inputs that have moved',
  // The hour figure is a literal on purpose: importing GATE_MAX_AGE_MS from
  // engine.ts would close an import cycle (engine → engine-events → engine)
  // and this const is built at module init, so the binding would be in TDZ and
  // throw. Pinned against the constant by engine-events.test.ts instead.
  expired: 'older than the earlier of the plugin TTL and 23 hours',
}

/**
 * Emit plugin_result event indicating supervised plugin is awaiting human approval.
 * severity=warning — gate requires action before engine can continue.
 */
export const emitPluginGated = (plugin: string, runId: string | null, eventsPath?: string): Promise<void> =>
  emitBoardEvent(
    makeEvent('plugin_result', plugin, `${plugin}: awaiting approval`, runId, { severity: 'warning' }),
    eventsPath,
  )

