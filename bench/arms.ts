/**
 * The warpline arm: one advance over a seeded home, timed, counted, and its
 * two deterministic artifacts materialised at the graded paths.
 *
 * The package is reached by SELF-REFERENCE through the exports map — the same
 * specifiers a consumer installing from the registry writes — and never by a
 * relative path into the source tree. An arm that imported an internal module
 * would be measuring something no consumer can run.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { dirname, join } from 'node:path'
import { runAdvance, type AdvanceResult } from 'warpline'
import { EngineStateSchema } from 'warpline/schemas/engine-state'
import { RunLogSchema } from 'warpline/schemas/run-log'
import { GRADED_PATHS } from './seed.js'

/**
 * The prefix a handoff carries. Fixed as contract by the handoff document, and
 * it is the only thing in the run log that identifies one.
 */
export const NEEDS_LLM_PREFIX = '[needs-llm]'

export interface WarplineArmResult {
  /** Float milliseconds across the measured segment: the advance plus materialisation. */
  runtime_ms: number
  /** How many handoffs this run parked. */
  parked_handoffs: number
  /** The advance's own result, so a caller can reach the run log and the run id. */
  advance: AdvanceResult
}

/**
 * Count the handoffs this run parked, from the run log the advance names.
 *
 * By the SUMMARY PREFIX, and deliberately not by a status value: the run log's
 * status enum has no member for a parked handoff, and widening a published
 * enum to make a benchmark easier to write is a contract change. Not by
 * scanning the runs directory either — the advance returns the path to its own
 * log, and a glob over that directory would pick up a sibling run's artifact
 * the first time two runs share a home.
 */
export function countParkedHandoffs(result: AdvanceResult): number {
  const log = RunLogSchema.parse(JSON.parse(readFileSync(result.run_log_path, 'utf8')))
  return log.plugin_entries.filter((entry) => entry.result_summary.startsWith(NEEDS_LLM_PREFIX)).length
}

function writeGraded(home: string, relative: string, body: string): void {
  const destination = join(home, relative)
  mkdirSync(dirname(destination), { recursive: true })
  writeFileSync(destination, body)
}

/**
 * Put the two deterministic artifacts where the grader looks.
 *
 * This is harness bookkeeping inside the MEASURED segment — a file read and a
 * JSON read — and the pre-registration says so rather than leaving a reader to
 * find it. Two different shapes, for two different reasons:
 *
 *   - the rollup plugin keeps its result in a retained state file, so the
 *     graded artifact is the two counts read off it;
 *   - the digest plugin returns its digest as an INLINE body and writes no
 *     file at all, so the graded artifact is that body, read out of the
 *     engine's own state document where the runtime parked it.
 */
export function materializeDeterministic(home: string): void {
  const rollupState = join(home, 'state', 'metrics-rollup.json')
  if (existsSync(rollupState)) {
    const state = JSON.parse(readFileSync(rollupState, 'utf8')) as { rows?: unknown[]; rollups?: unknown[] }
    const rows = Array.isArray(state.rows) ? state.rows.length : 0
    const rollups = Array.isArray(state.rollups) ? state.rollups.length : 0
    writeGraded(home, GRADED_PATHS['metrics-rollup'], JSON.stringify({ rows, rollups }))
  }

  const statePath = join(home, 'state', 'engine-state.json')
  if (existsSync(statePath)) {
    const engineState = EngineStateSchema.parse(JSON.parse(readFileSync(statePath, 'utf8')))
    const body = engineState.plugin_runs['daily-digest']?.last_output?.body
    if (typeof body === 'string') writeGraded(home, GRADED_PATHS['daily-digest'], body)
  }
}

/**
 * One warpline iteration. No options: the plugin root, state, runs,
 * configuration and grant all derive from the home the caller has already
 * assigned and asserted, which is what makes this arm's isolation a property
 * of the home rather than of a list of overrides someone has to keep complete.
 */
export async function runWarplineArm(home: string): Promise<WarplineArmResult> {
  const started = performance.now()
  const advance = await runAdvance()
  materializeDeterministic(home)
  const runtime_ms = performance.now() - started
  return { runtime_ms, parked_handoffs: countParkedHandoffs(advance), advance }
}
