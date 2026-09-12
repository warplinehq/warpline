/**
 * The driver: iterations of three sequentially-run, independently-homed arms,
 * each scrubbed record written the moment it exists.
 *
 * **This never runs in continuous integration.** The two control arms are real
 * sessions of the command-line tool against a real provider, so a measured set
 * spends real money and takes hours. The reason lives here rather than in the
 * package manifest, because the manifest is where a reader looks for what a
 * script does and not for why it is dangerous.
 *
 * Every seam is a PARAMETER, and each one for a stated reason rather than for
 * symmetry:
 *
 *   - the ARM RUNNER, because a driver that reached for the real arms internally
 *     could not be verified without a provider key, and the order, the
 *     sequencing, the seeding split and the resume arithmetic are exactly the
 *     parts a published number depends on;
 *   - the RESULTS DIRECTORY, because three of this driver's tests exercise it,
 *     and a driver holding the tracked path internally forces all three to write
 *     inside the repository — which, once the real records are committed, means a
 *     local suite run plants fabricated records among the published raw data;
 *   - the NOTES SOURCE, because the tracked fixture is produced by the warm-up
 *     pass below and does not exist before it, and the seeder refuses a
 *     with-state home with no notes source by name;
 *   - the PROVENANCE READER, because the real one runs `git` and the tool itself,
 *     and the tool is not on a continuous-integration runner.
 *
 * The tracked default of each is bound at `main()` and nowhere else.
 */
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  ARM_ORDER,
  readProvenance,
  resolveDisposition,
  runClaudeArm,
  runWarplineIteration,
  type ArmId,
  type ControlArmId,
  type Provenance,
} from './arms.js'
import type { GradeResult } from './grade.js'
import { BenchRunRecordSchema, parseRecord, type BenchRunRecord, type TokenClasses } from './record.js'
import { assertHomeSeam, assertHomesDistinct, NOTES_FIXTURE, NOTES_PATH, seedArmHome, seedControlHome } from './seed.js'
import { SHORTFALL_N, summariseArm, type ArmSummary, type SummarisableRun } from './stats.js'

/** The checkout root, which is also the package root the arms self-reference. */
const REPO_ROOT = resolve(import.meta.dir, '..')

/**
 * The cache-cold runs per arm: the first one, published as its own labelled row
 * and excluded from every warm median and every rate.
 */
export const COLD_RUNS = 1

/**
 * The warm graded-passing runs an arm needs before a median is published.
 *
 * READ from the statistics module rather than restated. A threshold that appears
 * twice is a threshold that can be changed in one place, and the half that moved
 * would still print a table.
 */
export const WARM_TARGET = SHORTFALL_N

/**
 * The iteration cap, as the frozen method names it.
 *
 * A loop that ran "until each arm has the target warm passing count" has no stop
 * point at all: an arm that never passes the grader spends without bound, and the
 * shortfall row the statistics module already implements becomes unreachable
 * code. The cap is what gives that row a trigger, which is why it is method
 * rather than an implementation detail.
 */
export const MAX_ITERATIONS = 15

/** The mode argument the one unmeasured warm-up invocation passes. */
export const WARMUP_MODE = 'warmup'

/** The arm the warm-up pass runs: the one that starts with no notes. */
const WARMUP_ARM: ControlArmId = 'agent-from-scratch'

/** The name the warm-up pass copies its notes out under. */
const WARMUP_NOTES_NAME = 'agent-notes.md'

/**
 * What one arm's run reports, in the shape the record is assembled from.
 *
 * `tokens` is the arm's PUBLISHED four classes — summed across both segments for
 * the warpline arm, and the session's own for a control arm — so the disposition
 * is resolved over the same figures the record carries.
 */
export interface ArmRunOutcome {
  tokens: TokenClasses
  /** Float milliseconds, whole run. Both segments for the warpline arm. */
  wall_clock_ms: number
  /** The deterministic segment alone; null for an arm that has none. */
  runtime_ms: number | null
  /** The judgment segment alone; null for an arm that has none. */
  consumer_ms: number | null
  parked_handoffs: number
  /** The session's own subtype, which is what the truncation step reads. */
  subtype: string
  /** The canonical id read back from the session; null when the pinned model served nothing. */
  model_id: string | null
  grade: GradeResult
}

/** The one seam a test replaces. Takes a seeded home, returns what it measured. */
export type ArmRunner = (arm: ArmId, home: string, iteration: number) => Promise<ArmRunOutcome>

/** Stamps a record with the four strings that make it falsifiable. */
export type ProvenanceReader = (modelId: string) => Provenance

/**
 * The warm-up session produced no notes file.
 *
 * Named, and thrown rather than papered over with an empty file, because a
 * silent miss here is the worst outcome available: the fixture would be
 * committed empty or not at all, the with-state arm would be handed nothing,
 * both control arms would then receive an identical prompt over an identical
 * home, and the published pair would measure one thing twice while looking
 * exactly like a valid result.
 */
export class NoNotesProducedError extends Error {
  readonly arm: ArmId
  readonly path: string

  constructor(arm: ArmId, path: string) {
    super(
      `${arm}: the warm-up session wrote no notes file at '${path}' — check the control prompt's notes paragraph still carries its unconditional write clause and run the warm-up again, rather than hand-writing a substitute`,
    )
    this.name = 'NoNotesProducedError'
    this.arm = arm
    this.path = path
  }
}

/**
 * Seed one home by ITS OWN arm's recipe. One branch, no default case.
 *
 * The split is the arm definition and not a convenience:
 *
 *   - the warpline home gets the full recipe — the plugin root, the package
 *     link, the six fixture bodies at their manifest defaults, the preferences,
 *     the two plugin configuration files and the session grant;
 *   - a control home gets the flat inputs, an empty graded directory, and
 *     NOTHING that reveals the reference implementation. A control session runs
 *     with its working directory set to its own home and with permission checks
 *     bypassed, so anything placed there is readable by it, and a control home
 *     carrying the implementation is a control arm handed the answer. This is
 *     the same refusal that withholds the plugin-directory flag from the
 *     controls, one layer down; both layers hold or neither does;
 *   - the with-state home ADDITIONALLY gets a fresh copy of the notes source
 *     this call was handed. The from-scratch call passes no source at all, so it
 *     cannot fall through to the seeder's own default — which is the tracked
 *     fixture path, absent until the warm-up pass has taken place.
 *
 * An unrecognised arm throws. A new arm silently seeded on the wrong recipe is a
 * contaminated number that reads as a valid one, and the `never` binding below
 * makes that a typecheck failure before it can be a runtime one.
 */
async function seedFor(arm: ArmId, home: string, notesSource: string): Promise<void> {
  if (arm === 'warpline') return seedArmHome(home)
  if (arm === 'agent-with-state') return seedControlHome(home, arm, notesSource)
  if (arm === 'agent-from-scratch') return seedControlHome(home, arm)
  const unreachable: never = arm
  throw new Error(
    `no seeding recipe for arm '${String(unreachable)}' — an arm seeded on another arm's recipe publishes a contaminated measurement as a valid number`,
  )
}

/**
 * Run `fn` with the home environment variable pointed at `home`, restored after.
 *
 * The warpline arm alone needs it: handlers run in-process and resolve the home
 * themselves through the built copy of the path resolver, so this variable is
 * the only seam that reaches them. A control arm's home reaches its session
 * through the spawned environment instead. `assertHomeSeam` is the one
 * comparison that turns isolated from an assumption into a measurement.
 */
async function withHomeEnv<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const prior = process.env.WARPLINE_HOME
  process.env.WARPLINE_HOME = home
  try {
    assertHomeSeam(home)
    return await fn()
  } finally {
    if (prior === undefined) delete process.env.WARPLINE_HOME
    else process.env.WARPLINE_HOME = prior
  }
}

/** One record's own file, named by arm and zero-padded index so a listing sorts. */
function recordPath(resultsDir: string, arm: ArmId, iteration: number): string {
  return join(resultsDir, `${arm}-${String(iteration).padStart(3, '0')}.json`)
}

/** Every arm, zero. Written out rather than built from the order, so no cast is needed. */
const perArm = <T,>(value: T): Record<ArmId, T> => ({
  warpline: value,
  'agent-with-state': value,
  'agent-from-scratch': value,
})

/** What the records already on disk say about where a relaunch should pick up. */
export interface ResumeState {
  /** One past the highest index present, so no existing file is a candidate. */
  nextIteration: number
  runs: readonly BenchRunRecord[]
  /** WARM graded-passing runs per arm. The cold run is excluded, as everywhere. */
  passing: Record<ArmId, number>
  /** Whether an arm has any prior record at all, which is what decides cold. */
  seen: Record<ArmId, boolean>
}

/**
 * Read every record already written and derive where to resume.
 *
 * A measured set is not a command that finishes inside one foreground window.
 * Without this, a relaunch after an interruption restarts at the first iteration
 * with every arm flagged cold and overwrites the records it earned.
 *
 * An absent directory is the first launch and reads as an empty set rather than
 * an error. Every file present is parsed against the published schema, so a
 * corrupt or foreign file stops the set instead of skewing it.
 */
export async function resumeState(resultsDir: string): Promise<ResumeState> {
  let entries: string[] = []
  try {
    entries = await readdir(resultsDir)
  } catch {
    entries = []
  }

  const runs: BenchRunRecord[] = []
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.json')) continue
    runs.push(BenchRunRecordSchema.parse(JSON.parse(await readFile(join(resultsDir, entry), 'utf8'))))
  }

  const passing = perArm(0)
  const seen = perArm(false)
  let highest = 0
  for (const run of runs) {
    seen[run.arm] = true
    if (!run.cold && run.disposition === 'passed') passing[run.arm] += 1
    highest = Math.max(highest, run.iteration)
  }
  return { nextIteration: highest + 1, runs, passing, seen }
}

/** Everything one iteration needs. Four seams, none of them defaulted here. */
export interface IterationOptions {
  iteration: number
  runner: ArmRunner
  resultsDir: string
  notesSource: string
  provenance: ProvenanceReader
}

/**
 * One iteration: three fresh homes, seeded per arm, run one at a time in the
 * fixed order, each record written the moment it exists.
 *
 * SEQUENTIAL is a requirement and not an optimisation choice. Two arms holding
 * homes at once on one host puts sibling contention into the wall-clock, which
 * is the number being published.
 *
 * WRITTEN PER RUN and not per set. The measured set spans hours, and an abort
 * partway has to keep what it earned — so nothing is buffered and no file that
 * already exists is replaced. The exclusive write flag is the refusal: it is one
 * operation, where an existence check followed by a write is two.
 *
 * Homes are removed in a `finally`, whatever happened, including a throw from
 * the runner.
 */
export async function runIteration(options: IterationOptions): Promise<BenchRunRecord[]> {
  const { iteration, runner, resultsDir, notesSource, provenance } = options
  await mkdir(resultsDir, { recursive: true })
  // Read ONCE, before the iteration starts, so every arm in one iteration reads
  // the same pre-iteration state and `cold` cannot depend on arm order.
  const prior = await resumeState(resultsDir)

  const homes = new Map<ArmId, string>()
  for (const arm of ARM_ORDER) {
    homes.set(arm, await mkdtemp(join(tmpdir(), `warpline-bench-${arm}-`)))
  }
  assertHomesDistinct([...homes.values()])

  const written: BenchRunRecord[] = []
  try {
    for (const [index, arm] of ARM_ORDER.entries()) {
      const home = homes.get(arm) as string
      await seedFor(arm, home, notesSource)

      const outcome =
        arm === 'warpline'
          ? await withHomeEnv(home, () => runner(arm, home, iteration))
          : await runner(arm, home, iteration)

      if (outcome.model_id === null) {
        // The pinned model served nothing this run, so the record would name a
        // model that did none of the work. A silent substitution stops the set
        // rather than entering it.
        throw new Error(
          `${arm} iteration ${iteration}: the session reported no usage for the pinned model, so this run is not a publishable record`,
        )
      }

      const { disposition, truncation_subtype } = resolveDisposition({
        parsed: { subtype: outcome.subtype, tokens: outcome.tokens },
        graded: outcome.grade,
      })

      // Scrubbed before it is parsed, on the one write path, so no caller can
      // reach a validated record without the scrub having run.
      const record = parseRecord(
        {
          arm,
          iteration,
          arm_order_index: index,
          cold: !prior.seen[arm],
          disposition,
          truncation_subtype,
          tokens: outcome.tokens,
          wall_clock_ms: outcome.wall_clock_ms,
          runtime_ms: outcome.runtime_ms,
          consumer_ms: outcome.consumer_ms,
          parked_handoffs: outcome.parked_handoffs,
          graded: outcome.grade.paths,
          ...provenance(outcome.model_id),
        },
        home,
      )
      await writeFile(recordPath(resultsDir, arm, iteration), `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' })
      written.push(record)
    }
  } finally {
    for (const home of homes.values()) await rm(home, { recursive: true, force: true })
  }
  return written
}

/** One published row per arm, keyed by arm. */
export type SetSummary = Record<ArmId, ArmSummary>

/**
 * The published rows, computed from the records on disk by the statistics
 * module and not by a second implementation here.
 *
 * That module refuses a summary row below the warm target and reports the
 * shortfall instead, and the refusal is enforced by its return type rather than
 * by a convention nobody re-reads.
 */
export async function summariseSet(resultsDir: string): Promise<SetSummary> {
  const { runs } = await resumeState(resultsDir)
  const of = (arm: ArmId): SummarisableRun[] => runs.filter((run) => run.arm === arm)
  return {
    warpline: summariseArm(of('warpline')),
    'agent-with-state': summariseArm(of('agent-with-state')),
    'agent-from-scratch': summariseArm(of('agent-from-scratch')),
  }
}

/** Everything a whole set needs. The iteration index is derived, never passed. */
export type SetOptions = Omit<IterationOptions, 'iteration'>

/**
 * Iterations until every arm has the warm target, or the cap, whichever comes
 * first — then the summary.
 *
 * Nothing here catches. A provider outage says nothing about the arm and there
 * is no disposition value meaning "not the arm's fault", so an unattributable
 * failure must stop the set rather than become a row; and a runner failure has
 * to leave the records already written exactly where they are.
 */
export async function runSet(options: SetOptions): Promise<SetSummary> {
  let pinnedCli: string | null = null
  for (;;) {
    const state = await resumeState(options.resultsDir)
    pinnedCli ??= state.runs[0]?.claude_cli_version ?? null
    if (ARM_ORDER.every((arm) => state.passing[arm] >= WARM_TARGET)) break
    if (state.nextIteration > MAX_ITERATIONS) break

    for (const record of await runIteration({ iteration: state.nextIteration, ...options })) {
      pinnedCli ??= record.claude_cli_version
      if (record.claude_cli_version !== pinnedCli) {
        // An auto-update part-way through voids the set in the same way a model
        // change does, and the tool auto-updates on its own schedule.
        throw new Error(
          `the command-line tool changed mid-set, from '${pinnedCli}' to '${record.claude_cli_version}' — the set is no longer one configuration and cannot be published as one`,
        )
      }
    }
  }
  return summariseSet(options.resultsDir)
}

/** The warm-up pass. No notes source and no provenance: it writes no record. */
export interface WarmupOptions {
  runner: ArmRunner
  resultsDir: string
}

/**
 * The one unmeasured pass that PRODUCES the notes fixture, and the copy-out that
 * makes its result reachable.
 *
 * It runs the from-scratch arm once — the arm that starts with no notes, which
 * is the only state from which honest first-pass notes can be written — under
 * the identical isolation the measured runs use, because a notes file produced
 * under the operator's ambient configuration is not the fixture a stranger
 * reproducing from a clean checkout would get. The session produces one because
 * the control prompt's notes paragraph carries an unconditional write clause;
 * nothing else in the harness writes notes.
 *
 * **The copy-out ordering is load-bearing and its failure is silent.** The home
 * is removed in the `finally` below, so reporting the in-home path would hand
 * the operator a path that no longer exists by the time they read it, and the
 * copy-to-fixture step would have nothing to copy. That arrives as a missing
 * file in a manual step and not as a red test.
 *
 * It refuses to run once any record exists: the warm-up belongs before the
 * measured set, and a fixture produced after it is state the set never had.
 */
export async function runWarmup(options: WarmupOptions): Promise<string> {
  const existing = await resumeState(options.resultsDir)
  if (existing.runs.length > 0) {
    throw new Error(
      `the warm-up pass belongs BEFORE the measured set, and ${existing.runs.length} records already exist — a fixture produced now is state the measured runs never had`,
    )
  }

  const home = await mkdtemp(join(tmpdir(), `warpline-bench-${WARMUP_ARM}-`))
  try {
    await seedControlHome(home, WARMUP_ARM)
    await options.runner(WARMUP_ARM, home, 1)

    const produced = join(home, NOTES_PATH)
    if (!existsSync(produced)) throw new NoNotesProducedError(WARMUP_ARM, produced)

    // OUT of the home before the `finally` removes it, and under the system
    // temp root rather than inside the checkout — the operator copies it to the
    // tracked path and commits it as its own step.
    const keep = await mkdtemp(join(tmpdir(), 'warpline-bench-warmup-notes-'))
    const stable = join(keep, WARMUP_NOTES_NAME)
    await copyFile(produced, stable)
    return stable
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

/**
 * The real arms. The only path here that spawns anything or asks a provider
 * anything, and the one seam every test replaces.
 *
 * EXPORTED so a shakedown pass can drive one real iteration into a results
 * directory outside the checkout, before the first tracked record freezes the
 * method. A shakedown that reconstructed this function would be proving a copy
 * of the thing the measured set runs, which is worth nothing.
 */
export const runRealArm: ArmRunner = async (arm, home, iteration) => {
  if (arm === 'warpline') {
    const result = await runWarplineIteration(home, iteration)
    return {
      tokens: result.tokens,
      wall_clock_ms: result.wall_clock_ms,
      runtime_ms: result.runtime_ms,
      consumer_ms: result.consumer_ms,
      parked_handoffs: result.parked_handoffs,
      subtype: result.consumer.subtype,
      model_id: result.consumer.model_id,
      grade: result.grade,
    }
  }
  const prompt = await readFile(join(REPO_ROOT, 'bench', 'prompts', 'agent.md'), 'utf8')
  const result = await runClaudeArm(arm, home, prompt)
  return {
    tokens: result.parsed.tokens,
    wall_clock_ms: result.wall_clock_ms,
    // A control arm is one session and one segment, so the other is absent
    // rather than zero — zero would read as a segment that cost nothing.
    runtime_ms: null,
    consumer_ms: null,
    parked_handoffs: 0,
    subtype: result.parsed.subtype,
    model_id: result.parsed.model_id,
    grade: result.grade,
  }
}

/**
 * The entry point, and the ONE place the tracked defaults are bound.
 *
 * It prints the summary and writes no prose. The published table is transcribed
 * by hand from this output, because a generator that writes into the published
 * write-up is a generator that can quietly reword a caveat.
 */
async function main(argv: readonly string[]): Promise<void> {
  const resultsDir = join(REPO_ROOT, 'bench/results')

  if (argv[2] === WARMUP_MODE) {
    const produced = await runWarmup({ runner: runRealArm, resultsDir })
    process.stdout.write(`the warm-up session's notes were copied out to:\n  ${produced}\n`)
    process.stdout.write(`read it by eye, then copy it to ${NOTES_FIXTURE} and commit it.\n`)
    return
  }

  const summary = await runSet({
    runner: runRealArm,
    resultsDir,
    notesSource: join(REPO_ROOT, NOTES_FIXTURE),
    provenance: readProvenance,
  })
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
}

if (import.meta.main) await main(process.argv)
