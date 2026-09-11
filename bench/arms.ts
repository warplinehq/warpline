/**
 * The warpline arm: one advance over a seeded home, timed, counted, and its
 * two deterministic artifacts materialised at the graded paths.
 *
 * The package is reached by SELF-REFERENCE through the exports map — the same
 * specifiers a consumer installing from the registry writes — and never by a
 * relative path into the source tree. An arm that imported an internal module
 * would be measuring something no consumer can run.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { dirname, join } from 'node:path'
import { runAdvance, type AdvanceResult } from 'warpline'
import { EngineStateSchema } from 'warpline/schemas/engine-state'
import { RunLogSchema } from 'warpline/schemas/run-log'
import type { GradeResult } from './grade.js'
import type { BenchDisposition, BenchRunRecord, TokenClasses } from './record.js'
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

/**
 * The three arms, in the fixed order the frozen method states.
 *
 * Fixed rather than rotated: the cache-cold first run is published as its own
 * row, and a rotation would make "first" mean a different arm in different
 * iterations. Each run records its own index into this array, so an order
 * effect stays visible instead of being assumed away.
 */
export const ARM_ORDER = Object.freeze([
  'warpline',
  'agent-with-state',
  'agent-from-scratch',
] as const) satisfies readonly ArmId[]

/** Which arm a run belongs to. Closed at three by the record schema. */
export type ArmId = BenchRunRecord['arm']

/**
 * The provider was unreachable, so this run says nothing about the arm.
 *
 * Thrown rather than dispositioned, and that is the point: there is no
 * disposition value that means "not the arm's fault", so a run that reached
 * the chain at all would enter one of the published rates. See
 * `parseClaudeResult` for the measurement that makes this necessary.
 */
export class ApiUnavailableError extends Error {
  readonly arm: ArmId
  readonly terminalReason: string

  constructor(arm: ArmId, terminalReason: string) {
    super(`${arm}: the provider was unreachable (terminal reason ${terminalReason}); this run measures nothing`)
    this.name = 'ApiUnavailableError'
    this.arm = arm
    this.terminalReason = terminalReason
  }
}

/**
 * The run parked no handoffs, so its judgment half would cost nothing.
 *
 * Aborts the harness instead of publishing a zero. A warpline figure whose
 * judgment half is zero because there was no judgment to do is the degenerate
 * comparison the whole method exists to avoid, and it is reachable by nothing
 * more than a seeding mistake.
 */
export class ZeroHandoffError extends Error {
  readonly arm: ArmId
  readonly iteration: number
  readonly count: number

  constructor(arm: ArmId, iteration: number, count: number) {
    super(`${arm} iteration ${iteration}: parked ${count} handoffs, so the judgment half would measure nothing`)
    this.name = 'ZeroHandoffError'
    this.arm = arm
    this.iteration = iteration
    this.count = count
  }
}

/**
 * The token substituted into the consumer prompt: the discovery seam.
 *
 * The prompt is handed the absolute path of the run log the advance returned,
 * because the discovery skill's own glob is blind to an advance — it filters
 * the home's run artifacts for a delegated status that only the manual-run
 * path writes, and the pipeline path deliberately writes a combined log
 * instead. A consumer launched with this token UNSUBSTITUTED therefore has no
 * discovery path at all: it finds nothing, writes nothing, and fails the
 * grader on both handoff artifacts with nothing in the output naming why.
 */
export const RUN_LOG_PLACEHOLDER = '{{RUN_LOG_PATH}}'

/** What one session of the command-line tool reported about itself. */
export interface ParsedClaudeResult {
  /** The four classes, each separately nullable. Absent is null; zero is 0. */
  tokens: TokenClasses
  /** Float milliseconds the tool reported for the whole session. */
  duration_ms: number
  num_turns: number
  /** The tool's own subtype. Read for the truncation branch and for nothing else. */
  subtype: string
  is_error: boolean
  terminal_reason: string | null
  /** The canonical id that served the request, read back from per-model usage. */
  model_id: string | null
}

/** The four strings that make a raw record falsifiable. */
export interface Provenance {
  git_sha: string
  package_version: string
  claude_cli_version: string
  model_id: string
}

/** One disposition and, on exactly one of the four, the tool's own subtype. */
export interface ResolvedDisposition {
  disposition: BenchDisposition
  truncation_subtype: string | null
}

/** The terminal reason that means the provider, not the arm. */
const API_ERROR_REASON = 'api_error'

/**
 * The two subtypes that mean a stop point tripped.
 *
 * Both are the tool's own literals and both are recorded verbatim. The frozen
 * method sets one of them and the tool's internal ceiling produces the other;
 * neither is a value this harness chooses.
 */
const TRUNCATED_SUBTYPES: ReadonlySet<string> = new Set(['error_max_turns', 'error_max_budget_usd'])

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * An integer, or null when the key is not there.
 *
 * The distinction is the only reason the class fields are nullable at all: a
 * class the tool did not report and a class it reported as zero are different
 * facts, and folding the first into the second understates a total silently.
 */
function intOrNull(source: Record<string, unknown>, key: string): number | null {
  const value = source[key]
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}

function numberOr(source: Record<string, unknown>, key: string, fallback: number): number {
  const value = source[key]
  return typeof value === 'number' ? value : fallback
}

/**
 * Parse one session's result JSON.
 *
 * **The authentication check runs before everything else, and it does not read
 * the subtype.** Measured on this machine against an unkeyed environment under
 * the arms' own isolation, the failure came back with `subtype: "success"`, a
 * zero spend, a fifty-one millisecond duration and all four token classes
 * PRESENT and equal to zero. It satisfies neither the genuine-zero branch nor
 * the missing-class branch, so it would sail through the schema check, fail
 * the grader, and be published as a grader-failure rate that blames the arm
 * for a provider outage. The subtype lies on this path.
 *
 * An error flag WITHOUT that terminal reason is a different thing and falls
 * through: a tool failure inside the session is the arm failing to do the
 * work, and swallowing it would remove a real failure from the published rate.
 *
 * No spend field is read. The scrubber removes them at the record boundary and
 * nothing downstream may consume one.
 */
export function parseClaudeResult(raw: unknown, arm: ArmId): ParsedClaudeResult {
  const result = asRecord(raw)
  const is_error = result.is_error === true
  const terminal_reason = typeof result.terminal_reason === 'string' ? result.terminal_reason : null

  if (is_error && terminal_reason === API_ERROR_REASON) throw new ApiUnavailableError(arm, terminal_reason)

  const usage = asRecord(result.usage)
  return {
    tokens: {
      input: intOrNull(usage, 'input_tokens'),
      output: intOrNull(usage, 'output_tokens'),
      cache_creation: intOrNull(usage, 'cache_creation_input_tokens'),
      cache_read: intOrNull(usage, 'cache_read_input_tokens'),
    },
    duration_ms: numberOr(result, 'duration_ms', 0),
    num_turns: numberOr(result, 'num_turns', 0),
    subtype: typeof result.subtype === 'string' ? result.subtype : '',
    is_error,
    terminal_reason,
    // The key, not the flag. A mid-run default change would otherwise be
    // invisible in N records that all name the id the harness asked for.
    model_id: Object.keys(asRecord(result.modelUsage))[0] ?? null,
  }
}

/**
 * One chain, four steps, highest first: truncated, then schema failure, then
 * grader failure, then passed.
 *
 * A chain rather than four independent branches because a run can satisfy more
 * than one step at once — a session the spend stop point cut short has of
 * course not written the artifacts — and two readers of the same record must
 * not be able to disagree about what happened. Each step returns, so the order
 * of the steps IS the precedence and there is nowhere for a second value to
 * come from.
 */
export function resolveDisposition({
  parsed,
  graded,
}: {
  parsed: ParsedClaudeResult
  graded: GradeResult
}): ResolvedDisposition {
  if (TRUNCATED_SUBTYPES.has(parsed.subtype)) {
    return { disposition: 'truncated', truncation_subtype: parsed.subtype }
  }
  if (Object.values(parsed.tokens).some((value) => value === null)) {
    return { disposition: 'failed-schema', truncation_subtype: null }
  }
  if (!graded.passed) return { disposition: 'failed-grader', truncation_subtype: null }
  return { disposition: 'passed', truncation_subtype: null }
}

/**
 * Stamp a raw record so it can be falsified.
 *
 * Without the commit a published figure is unattributable to any state of the
 * tree, and a comparison across a version bump reads as a comparison between
 * arms. The model id is passed in from the parsed result rather than read
 * again, so the stamp and the measurement name the same one.
 */
export function readProvenance(modelId: string): Provenance {
  const repoRoot = join(import.meta.dir, '..')
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version?: string }
  const capture = (command: string, args: string[]): string =>
    execFileSync(command, args, { cwd: repoRoot, encoding: 'utf8' }).trim()

  return {
    git_sha: capture('git', ['rev-parse', 'HEAD']),
    package_version: pkg.version ?? '',
    claude_cli_version: capture('claude', ['--version']),
    model_id: modelId,
  }
}
