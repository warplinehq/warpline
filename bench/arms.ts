/**
 * The warpline arm: one advance over a seeded home, timed, counted, and its
 * two deterministic artifacts materialised at the graded paths.
 *
 * The package is reached by SELF-REFERENCE through the exports map — the same
 * specifiers a consumer installing from the registry writes — and never by a
 * relative path into the source tree. An arm that imported an internal module
 * would be measuring something no consumer can run.
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { dirname, join, resolve } from 'node:path'
import { runAdvance, type AdvanceResult } from 'warpline'
import { EngineStateSchema } from 'warpline/schemas/engine-state'
import { RunLogSchema } from 'warpline/schemas/run-log'
import { gradeHome, type GradeResult } from './grade.js'
import type { BenchDisposition, BenchRunRecord, TokenClasses } from './record.js'
import { GRADED_PATHS, NOTES_PATH } from './seed.js'
import { sumTokenClasses } from './stats.js'

/**
 * The prefix a handoff carries. Fixed as contract by the handoff document, and
 * it is the only thing in the run log that identifies one.
 */
export const NEEDS_LLM_PREFIX = '[needs-llm]'

/** The checkout root, which is also the package root the arms self-reference. */
const REPO_ROOT = resolve(import.meta.dir, '..')

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
    model_id: selectModelId(result.modelUsage),
  }
}

/**
 * Which of the per-model usage keys names the model that did the work.
 *
 * MEASURED, and the reason this is not `keys[0]`: a session that uses a tool
 * reports TWO models, and the auxiliary one is inserted FIRST. A real smoke
 * iteration of all three arms returned `claude-haiku-4-5-20251001` — 912 input
 * tokens for one internal step — ahead of the pinned model that served every
 * turn. Taking the first key would stamp every record in the published set with
 * a model that did none of the work, and the method's own requirement that the
 * id be one string across the whole set would then be checking the auxiliary
 * model rather than the measured one.
 *
 * So the key is SELECTED by matching the pinned id, and the KEY is what is
 * returned — the dated canonical form when the tool reports one. This is still
 * a read-back rather than an echo, and it is the stronger version of it: a run
 * the pinned model never served returns null, and null is not a publishable
 * record, so a silent model substitution stops the set instead of entering it.
 */
function selectModelId(modelUsage: unknown): string | null {
  for (const [key, entry] of Object.entries(asRecord(modelUsage))) {
    const canonical = asRecord(entry).canonicalModel
    const named = typeof canonical === 'string' ? canonical : ''
    if (key.startsWith(PINNED_MODEL) || named.startsWith(PINNED_MODEL)) return key
  }
  return null
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
  const repoRoot = REPO_ROOT
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

// ─── spawning a session ──────────────────────────────────────────────────────

/** The two arms that are a command-line session and nothing else. */
export type ControlArmId = Exclude<ArmId, 'warpline'>

/**
 * The three sessions that spawn the tool: the two control arms, and the
 * warpline arm's consumer. The warpline arm's own advance is in-process and
 * spawns nothing, which is why it is not a member here.
 */
export type SessionId = ControlArmId | 'consumer'

/** The model every arm passes explicitly, so a default change cannot move it. */
export const PINNED_MODEL = 'claude-opus-5'

/** The per-session ceiling, as the flag's own string. The only one that exists. */
export const SESSION_BUDGET = '5'

/** The plugin source the consumer session is pointed at, absolute. */
export const CONSUMER_PLUGIN_PATH = join(REPO_ROOT, 'plugin')

/**
 * One argv for every session, so the two control arms and the consumer cannot
 * drift into two setups reported as one number.
 *
 * `--setting-sources ""` plus `--strict-mcp-config`, and NEITHER `--bare` nor
 * `--safe-mode`. All three were measured on this tool version, and the two
 * rejected ones fail on different halves of the same requirement:
 *
 *   - `--bare` authenticates strictly through an API key or a key helper, and
 *     setting a configuration directory to ANY value — including the real
 *     default path — suppresses the subscription credential, because the
 *     keychain entry is keyed to that variable. So `--bare` cannot authenticate
 *     here at all, and per-run configuration isolation is not available.
 *   - `--safe-mode` authenticates, and it also DISABLES THE PLUGIN'S OWN
 *     SKILLS. A session given `--plugin-dir` under it lists the tool's built-in
 *     skills and not this checkout's two, and `--add-dir` is inert under it as
 *     well. That makes the plugin flag below a no-op, which is the warpline
 *     arm's definition silently deleted.
 *
 * The pair that remains holds all three properties. `--setting-sources ""`
 * suppresses the operator's instruction file, their own skills, their settings
 * and their hooks — probed for a slug that appears only in the operator's global
 * instruction file, against an unsuppressed positive control in the same batch
 * that returned it. `--strict-mcp-config` suppresses their servers. Subscription
 * auth is intact, with no API key and no long-lived token needed. And the
 * plugin's two skills load: the same skill listing returned both of them, and
 * none of the operator's.
 *
 * What remains in every session is the base system prompt and the built-in tool
 * definitions, which every arm pays identically, so they are a constant rather
 * than a confound.
 *
 * No turn cap is passed because the pinned tool version has no such flag —
 * confirmed absent from its own help — so the spend ceiling is the only one.
 */
export function buildClaudeArgv(session: SessionId, promptBody: string): string[] {
  const argv = [
    '--print',
    promptBody,
    '--output-format',
    'json',
    '--model',
    PINNED_MODEL,
    '--max-budget-usd',
    SESSION_BUDGET,
    '--permission-mode',
    'bypassPermissions',
    // The empty value is the whole point: no user settings, no project
    // settings, no local settings, and so no operator instruction file, no
    // operator skills and no hooks.
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--no-session-persistence',
  ]
  // The warpline arm only. The runtime's own skills are the reference
  // implementation of the thing being measured, and handing them to a control
  // arm would be handing a control the answer.
  if (session === 'consumer') argv.push('--plugin-dir', CONSUMER_PLUGIN_PATH)
  return argv
}

/**
 * One env for every session: the inherited environment, the home pointed at
 * this arm's directory, and the configuration directory variable REMOVED.
 *
 * Removed rather than set, and that is a measurement rather than a preference:
 * with that variable carrying any value at all the session cannot reach the
 * subscription credential and returns an unattributable provider error with
 * every token class present and equal to zero. Deleting it here is what makes
 * the absence a property of the code instead of a property of whatever shell
 * the harness happened to be launched from.
 */
export function buildClaudeEnv(home: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, WARPLINE_HOME: home }
  delete env.CLAUDE_CONFIG_DIR
  return env
}

/**
 * Substitute the run log path into the consumer prompt: the discovery seam.
 *
 * Throws when the token is not there to substitute, and throws again if one
 * survives the substitution. Both failures are silent otherwise — the prompt
 * still reads fine, the session finds no handoffs, writes neither handoff
 * artifact, and the run is dispositioned a grader failure with nothing in the
 * output naming why.
 */
export function buildConsumerPrompt(runLogPath: string): string {
  const prompt = readFileSync(join(REPO_ROOT, 'bench', 'prompts', 'consumer.md'), 'utf8')
  if (!prompt.includes(RUN_LOG_PLACEHOLDER)) {
    throw new Error(`the consumer prompt carries no '${RUN_LOG_PLACEHOLDER}' to substitute — it has no discovery path`)
  }
  const body = prompt.split(RUN_LOG_PLACEHOLDER).join(runLogPath)
  if (body.includes(RUN_LOG_PLACEHOLDER)) {
    throw new Error(`the consumer prompt still carries '${RUN_LOG_PLACEHOLDER}' after substitution`)
  }
  return body
}

/** What one spawned session reported, and how long the harness watched it. */
export interface SessionOutcome {
  parsed: ParsedClaudeResult
  /** Float milliseconds the harness measured, not the duration the tool reported. */
  wall_clock_ms: number
}

/** Which arm a session's failure is named for. A consumer failure is warpline's. */
function armOf(session: SessionId): ArmId {
  return session === 'consumer' ? 'warpline' : session
}

/**
 * Spawn one session and parse what it printed.
 *
 * The working directory is the arm's home, so a relative write from the session
 * lands inside the home rather than in the checkout.
 *
 * Standard output is parsed REGARDLESS of the exit code: the measured
 * authentication failure exited non-zero and printed a complete result object,
 * and that object is the only thing that identifies the failure as the
 * provider's rather than the arm's. Output that is not JSON at all is a
 * different thing and throws, naming the arm.
 */
async function runSession(session: SessionId, home: string, promptBody: string): Promise<SessionOutcome> {
  const started = performance.now()
  const stdout = await new Promise<string>((settle, fail) => {
    const child = spawn('claude', buildClaudeArgv(session, promptBody), {
      cwd: home,
      env: buildClaudeEnv(home),
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let collected = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      collected += chunk
    })
    child.on('error', fail)
    child.on('close', () => settle(collected))
  })
  const wall_clock_ms = performance.now() - started

  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    throw new Error(`${armOf(session)}: the session printed no result object, so this run measures nothing`)
  }
  return { parsed: parseClaudeResult(raw, armOf(session)), wall_clock_ms }
}

/**
 * Refuse a control home seeded for the other control arm.
 *
 * The two control arms differ in exactly one thing — whether a file sits at the
 * notes path — and the prompt body is byte-identical for both. So a home handed
 * to the wrong arm produces a run that measures the OTHER arm and reports it
 * under this one's name, and nothing downstream can tell. Two lines, before any
 * money is spent.
 */
export function assertControlHome(arm: ControlArmId, home: string): void {
  const notes = join(home, NOTES_PATH)
  const present = existsSync(notes)
  if (arm === 'agent-with-state' && !present) {
    throw new Error(`${arm}: no file at '${notes}' — this home would measure the from-scratch arm under this arm's name`)
  }
  if (arm === 'agent-from-scratch' && present) {
    throw new Error(`${arm}: a file is present at '${notes}' — this home would measure the with-state arm under this arm's name`)
  }
}

/** One control arm's run: what it reported, how long it took, how it graded. */
export interface ClaudeArmResult extends SessionOutcome {
  grade: GradeResult
}

/**
 * One control arm iteration. One spawn, one segment.
 *
 * It does NOT seed: it is handed a home the control recipe already prepared,
 * and it asserts that home rather than trusting it.
 */
export async function runClaudeArm(arm: ControlArmId, home: string, promptBody: string): Promise<ClaudeArmResult> {
  assertControlHome(arm, home)
  const outcome = await runSession(arm, home, promptBody)
  return { ...outcome, grade: gradeHome(home) }
}

/** The consumer session's own segment, timed separately from the advance. */
export interface ConsumerSessionResult {
  parsed: ParsedClaudeResult
  consumer_ms: number
}

/** The warpline arm's judgment half: resolve the parked handoffs, and write them. */
export async function runConsumerSession(home: string, runLogPath: string): Promise<ConsumerSessionResult> {
  const outcome = await runSession('consumer', home, buildConsumerPrompt(runLogPath))
  return { parsed: outcome.parsed, consumer_ms: outcome.wall_clock_ms }
}

/**
 * What the advance contributes to the four classes.
 *
 * Zero, and each class present and equal to zero rather than absent: the
 * advance is in-process and asks no provider anything. That it emits nothing at
 * all is the finding this benchmark exists to put a number on, so it is summed
 * in explicitly rather than left out of the arithmetic.
 */
export const ADVANCE_TOKENS: TokenClasses = Object.freeze({
  input: 0,
  output: 0,
  cache_creation: 0,
  cache_read: 0,
})

/** The warpline arm, both segments, as the figures the arm publishes. */
export interface WarplineIterationResult {
  /** The four classes summed across the advance and the consumer session. */
  tokens: TokenClasses
  /** The sum of both segments, which is what the arm is compared on. */
  wall_clock_ms: number
  /** The deterministic segment alone. */
  runtime_ms: number
  /** The judgment segment alone. */
  consumer_ms: number
  /** Deterministic over judgment. A figure, not something a reader derives. */
  deterministic_to_judgment_ratio: number
  parked_handoffs: number
  advance: AdvanceResult
  consumer: ParsedClaudeResult
  grade: GradeResult
}

/** The three seams a test replaces so the assembly is checkable without a key. */
export interface WarplineIterationDeps {
  advance?: (home: string) => Promise<WarplineArmResult>
  consume?: (home: string, runLogPath: string) => Promise<ConsumerSessionResult>
  grade?: (home: string) => GradeResult
}

/**
 * One whole warpline iteration: the advance, then the session that resolves
 * what it parked.
 *
 * The two segments are summed into one published figure AND kept separately,
 * because the split is the claim. A reader who only sees the total cannot tell
 * the deterministic half cost nothing.
 *
 * The zero-handoff abort sits between the segments deliberately. A run that
 * parked nothing has no judgment to buy, so its consumer cost would be a
 * near-zero this arm had not earned — the degenerate comparison the whole
 * method exists to avoid, and reachable by nothing more than a seeding
 * mistake. It throws BEFORE the consumer is spawned, so the abort costs
 * nothing as well as publishing nothing.
 */
export async function runWarplineIteration(
  home: string,
  iteration: number,
  deps: WarplineIterationDeps = {},
): Promise<WarplineIterationResult> {
  const advanceFn = deps.advance ?? runWarplineArm
  const consumeFn = deps.consume ?? runConsumerSession
  const gradeFn = deps.grade ?? gradeHome

  const first = await advanceFn(home)
  if (first.parked_handoffs === 0) throw new ZeroHandoffError('warpline', iteration, first.parked_handoffs)

  const second = await consumeFn(home, first.advance.run_log_path)

  return {
    tokens: sumTokenClasses([{ tokens: ADVANCE_TOKENS }, { tokens: second.parsed.tokens }]),
    wall_clock_ms: first.runtime_ms + second.consumer_ms,
    runtime_ms: first.runtime_ms,
    consumer_ms: second.consumer_ms,
    deterministic_to_judgment_ratio: first.runtime_ms / second.consumer_ms,
    parked_handoffs: first.parked_handoffs,
    advance: first.advance,
    consumer: second.parsed,
    grade: gradeFn(home),
  }
}
