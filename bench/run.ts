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
 * The tracked default of each is bound at `main()` and nowhere else. The
 * private entry points take the same seams, plus the preconditions and the
 * canary, as optional dependencies that default to the real ones, and
 * `main()` is the one caller that leaves them unset.
 *
 * The private modes that spend are `private`, `private-warmup` and
 * `private-shakedown`. The rest spend nothing: `snapshot`, `salt`, `commit`,
 * and `bind`, which prints the six digests a measured set is bound to, for
 * the private pre-registration.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { agreementVerdict, type AgreementReport } from './agreement.js'
import {
  ARM_ORDER,
  assertCleanWorktree,
  readProvenance,
  resolveDisposition,
  runCanary,
  runClaudeArm,
  runConsumerSession,
  runWarplineArm,
  runWarplineIteration,
  type ArmId,
  type ClaudeArmResult,
  type ConsumerSessionResult,
  type ControlArmId,
  type Provenance,
} from './arms.js'
import { gradeWithChecks, type GradeResult } from './grade.js'
import {
  assertPrivatePreconditions,
  assertPrivateSeam,
  assertScratchDir,
  BIND_KEYS,
  commitment,
  copyMapMtimes,
  formatBindings,
  loadPrivateConfig,
  materializeCopyMap,
  methodBindings,
  PINNED_PACKAGE_VERSION,
  privatePluginsDir,
  privateWarplineHome,
  realPathOf,
  scrubEnv,
  seedPrivateControl,
  seedPrivateHome,
  recordStamp,
  takeSnapshot,
  treeDigest,
  type FrozenMethod,
  type PrivateConfig,
  type PrivateStamp,
} from './private.js'
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

/** The measured private set: `private <absolute config path>`. */
export const PRIVATE_MODE = 'private'

/** The private warm-up, which produces the with-state notes: `private-warmup <absolute config path>`. */
export const PRIVATE_WARMUP_MODE = 'private-warmup'

/** One disclosed, uncountable iteration: `private-shakedown <absolute config path> <absolute scratch dir>`. */
export const PRIVATE_SHAKEDOWN_MODE = 'private-shakedown'

/** Take the private snapshot once and print its digest: `snapshot <absolute config path>`. */
export const SNAPSHOT_MODE = 'snapshot'

/** Write a fresh salt outside this repository: `salt <absolute path>`. */
export const SALT_MODE = 'salt'

/** Print one salted digest of a file or a directory: `commit <absolute salt path> <absolute document path>`. */
export const COMMIT_MODE = 'commit'

/** Print the six bind lines the measured gate compares: `bind <absolute config path>`. */
export const BIND_MODE = 'bind'

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
  /** Outbound attempts the session sandbox blocked. Absent when the arm had no sandbox to count them. */
  outbound_blocked?: number | null
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

/**
 * What a privately configured scenario changes about one iteration: how each
 * home is seeded, where the warpline arm's engine home sits inside its arm
 * home, what every record is stamped with, and, on a measured set, which
 * records already on disk it refuses before it spends.
 */
export interface PrivateIterationHooks {
  seed(arm: ArmId, home: string): Promise<unknown>
  warplineHomeOf(home: string): string
  stamp: PrivateStamp
  /**
   * Refuse the records already on disk before this iteration spends. A record
   * that arrived during the set must not move `cold`, the passing counts or the
   * stop rule, so it is refused before any home exists.
   */
  assertBound?(runs: readonly BenchRunRecord[]): void
}

/**
 * Everything one iteration needs. Four seams, none of them defaulted here.
 *
 * `privateHooks` is the one seam through which a second, privately configured
 * scenario runs on this exact driver, so the order, the sequencing, the cold
 * flag, the disposition chain and the exclusive write are the ones the public
 * set was measured with. Absent, the iteration is today's behaviour byte for
 * byte.
 */
export interface IterationOptions {
  iteration: number
  runner: ArmRunner
  resultsDir: string
  notesSource: string
  provenance: ProvenanceReader
  privateHooks?: PrivateIterationHooks
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
 *
 * With `privateHooks`, four things change and nothing else: the records
 * already on disk are checked by the hook before any home exists, each home is
 * seeded by the hook instead of the tracked recipe, the home variable points at
 * the warpline home inside the arm home, and the stamp joins the raw record
 * BEFORE the scrub and the parse, so a stamped record passes the same one write
 * path as any other.
 */
export async function runIteration(options: IterationOptions): Promise<BenchRunRecord[]> {
  const { iteration, runner, resultsDir, notesSource, provenance, privateHooks } = options
  await mkdir(resultsDir, { recursive: true })
  // Read ONCE, before the iteration starts, so every arm in one iteration reads
  // the same pre-iteration state and `cold` cannot depend on arm order.
  const prior = await resumeState(resultsDir)
  privateHooks?.assertBound?.(prior.runs)

  const homes = new Map<ArmId, string>()
  for (const arm of ARM_ORDER) {
    homes.set(arm, await mkdtemp(join(tmpdir(), `warpline-bench-${arm}-`)))
  }
  assertHomesDistinct([...homes.values()])

  const written: BenchRunRecord[] = []
  try {
    for (const [index, arm] of ARM_ORDER.entries()) {
      const home = homes.get(arm) as string
      if (privateHooks) await privateHooks.seed(arm, home)
      else await seedFor(arm, home, notesSource)

      const outcome =
        arm === 'warpline'
          ? await withHomeEnv(privateHooks ? privateHooks.warplineHomeOf(home) : home, () => runner(arm, home, iteration))
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
          ...(privateHooks ? privateHooks.stamp : {}),
          ...(typeof outcome.outbound_blocked === 'number' ? { outbound_blocked: outcome.outbound_blocked } : {}),
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

    // Every record on disk against every other, and BEFORE the two breaks
    // below. The comparison further down is record-versus-pin for records this
    // process wrote, so drift sitting entirely in records that were already
    // there was invisible: a set interrupted under one tool version and resumed
    // under the next was summarised and published as one configuration. A
    // finished set reaches the break on the first pass, so a refusal placed
    // after it would never see the case it exists for.
    const onDisk = new Set(state.runs.map((run) => run.claude_cli_version))
    if (onDisk.size > 1) {
      throw new Error(
        `the records on disk carry ${onDisk.size} tool versions: [${[...onDisk].sort().join(', ')}] — the set is not one configuration and cannot be published as one`,
      )
    }
    // One version or none, so there is nothing left for an ordering to pick
    // wrongly. This used to read `state.runs[0]`, which is the FILENAME-sorted
    // first record and not the chronologically first one, so the pin was
    // whichever arm sorts first rather than whichever ran first.
    pinnedCli ??= [...onDisk][0] ?? null

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

/**
 * The fields that must each hold one value across a private set, with the
 * words a refusal uses for them. The snapshot, the package and the commit are
 * not here: each record is pinned to its frozen value instead.
 */
const ONE_CONFIGURATION: readonly (readonly [keyof BenchRunRecord, string])[] = [
  ['claude_cli_version', 'tool version'],
  ['model_id', 'model'],
]

/**
 * Refuse unless every record is bound to the frozen method: made under its
 * commitment, at its freeze commit, on the pinned package, with each of its
 * six digests, under the isolation's count of blocked attempts, and graded on
 * exactly the frozen checks.
 *
 * The records sit in a gitignored dir that anything could have written, so a
 * record the method did not bind is not data, whatever else it says.
 */
export function assertRecordsBound(runs: readonly BenchRunRecord[], frozen: FrozenMethod): void {
  const short = (sha: string): string => sha.slice(0, 7)
  for (const run of runs) {
    const id = `${run.arm}-${run.iteration}`
    if (run.prereg_commitment === undefined) throw new Error(`${id} carries no prereg commitment, so it is not data for a private set`)
    if (run.prereg_commitment !== frozen.prereg_commitment) {
      throw new Error(`${id} was made under another prereg commitment than the committed one, so it is not data for this set`)
    }
    for (const key of BIND_KEYS) {
      if (run[key] === undefined) throw new Error(`${id} carries no ${key}, so its method is unbound`)
      if (run[key] !== frozen[key]) throw new Error(`${id} carries a ${key} other than the frozen one`)
    }
    if (run.git_sha !== frozen.freeze_commit) {
      throw new Error(`${id} carries git_sha ${short(run.git_sha)} where the method was frozen at ${short(frozen.freeze_commit)}`)
    }
    if (run.package_version !== PINNED_PACKAGE_VERSION) {
      throw new Error(`the private records were made on package version ${run.package_version}, and the private set is pinned to ${PINNED_PACKAGE_VERSION}`)
    }
    // A record made without the isolation's count is not a record of the isolated method.
    if (typeof run.outbound_blocked !== 'number') throw new Error(`${id} carries no outbound_blocked, so it was not made under the isolation`)
    if ('announce-fanout' in run.graded) throw new Error(`${id} is graded in the public workload's shape, so it is not a private record`)
    const graded = Object.keys(run.graded).sort()
    const checks = [...frozen.check_ids].sort()
    if (graded.join('\0') !== checks.join('\0')) {
      throw new Error(`${id} is graded on [${graded.join(', ')}] where the method checks [${checks.join(', ')}]`)
    }
  }
}

/**
 * The private set's published rows: the public summary, over records bound to
 * the one frozen method, and nothing else.
 *
 * This is the one gate between a record on disk and a published ratio. Every
 * record must pass `assertRecordsBound`, and the set must be one configuration:
 * the model for that refusal is the tool-version refusal in `runSet`, widened
 * to every field that makes a set one. After them the statistics are the
 * public module's, unchanged.
 *
 * It summarises a set `runSet` finished. Called mid-set, an arm with no warm
 * run yet throws from the statistics module, and that is not a shortfall.
 */
export async function summarisePrivate(resultsDir: string, frozen: FrozenMethod): Promise<SetSummary> {
  const { runs } = await resumeState(resultsDir)
  if (runs.length === 0) throw new Error(`blind: no record in ${resultsDir} to summarise`)

  assertRecordsBound(runs, frozen)

  for (const [field, words] of ONE_CONFIGURATION) {
    const values = new Set(runs.map((run) => run[field]))
    if (values.size > 1) {
      throw new Error(`the private records carry ${values.size} ${words} values (${field}) — the set is not one configuration`)
    }
  }
  return summariseSet(resultsDir)
}

/** The warm-up pass. No notes source and no provenance: it writes no record. */
export interface WarmupOptions {
  runner: ArmRunner
  resultsDir: string
  /** Seeds the warm-up home in place of the tracked control recipe, for a privately configured scenario. */
  seed?: (arm: ControlArmId, home: string) => Promise<void>
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
    if (options.seed) await options.seed(WARMUP_ARM, home)
    else await seedControlHome(home, WARMUP_ARM)
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

/** The two seams inside a private arm a test replaces. Absent, each is the real isolated session. */
export interface PrivateRunnerDeps {
  consume?: (home: string, runLogPath: string) => Promise<ConsumerSessionResult>
  control?: (arm: ControlArmId, home: string, prompt: string) => Promise<ClaudeArmResult>
}

/**
 * The private arms: the real ones, pointed at a privately configured fleet.
 *
 * Every session runs isolated. The warpline arm advances the fleet's own plugin
 * root and grades the copied deterministic outputs; its consumer reads the
 * config's prompt with its working directory at the arm home and the warpline
 * home beside it. Each control reads the config's agent prompt. All three are
 * graded by the config's checks, so no tracked line names what is graded.
 *
 * The fleet's path seam is measured before the advance, with the home variable
 * already pointed at the warpline home, because that is the last moment a
 * leftover override is a refusal rather than a write into live state.
 */
export function makePrivateRunner(config: PrivateConfig, deps: PrivateRunnerDeps = {}): ArmRunner {
  const grade = (home: string): GradeResult => gradeWithChecks(home, config.checks)
  return async (arm, home, iteration) => {
    if (arm === 'warpline') {
      const warplineHome = privateWarplineHome(home, config)
      await assertPrivateSeam(home, config)
      const result = await runWarplineIteration(home, iteration, {
        advance: (h) => {
          // Taken before the timed segment: what each source was before this advance.
          const before = copyMapMtimes(h, config.copyMap)
          return runWarplineArm(h, privatePluginsDir(h, config), (h2, a) => materializeCopyMap(h2, a, config.copyMap, before))
        },
        consume:
          deps.consume ??
          ((h, runLogPath) => runConsumerSession(h, runLogPath, { isolated: true, warplineHome, promptPath: config.prompts.consumer })),
        grade,
      })
      return {
        tokens: result.tokens,
        wall_clock_ms: result.wall_clock_ms,
        runtime_ms: result.runtime_ms,
        consumer_ms: result.consumer_ms,
        parked_handoffs: result.parked_handoffs,
        subtype: result.consumer.subtype,
        model_id: result.consumer.model_id,
        grade: result.grade,
        outbound_blocked: result.outbound_blocked,
      }
    }
    const prompt = await readFile(config.prompts.agent, 'utf8')
    const control = deps.control ?? ((a: ControlArmId, h: string, p: string) => runClaudeArm(a, h, p, { isolated: true, grade }))
    const result = await control(arm, home, prompt)
    return {
      tokens: result.parsed.tokens,
      wall_clock_ms: result.wall_clock_ms,
      runtime_ms: null,
      consumer_ms: null,
      parked_handoffs: 0,
      subtype: result.parsed.subtype,
      model_id: result.parsed.model_id,
      grade: result.grade,
      outbound_blocked: result.outbound_blocked,
    }
  }
}

/** How a private iteration seeds each home, where its warpline home sits, what it stamps, and what it refuses first. */
export function privateHooks(
  config: PrivateConfig,
  stamp: PrivateStamp,
  assertBound?: (runs: readonly BenchRunRecord[]) => void,
): PrivateIterationHooks {
  return {
    seed: (arm, home) => (arm === 'warpline' ? seedPrivateHome(home, config) : seedPrivateControl(home, arm, config)),
    warplineHomeOf: (home) => privateWarplineHome(home, config),
    stamp,
    ...(assertBound ? { assertBound } : {}),
  }
}

/**
 * The six bind lines of the method as it stands, exactly what the measured
 * gate compares, for the operator to paste into the private pre-registration
 * before its commitment is computed.
 *
 * The prereg block must already be in the config, because it is inside the
 * config digest. A dirty tree is refused: a digest printed from it is one that
 * HEAD could never reproduce, and the method frozen on it could never run.
 * It spends nothing and runs no session.
 */
export function bindingLines(config: PrivateConfig, repoRoot: string, build?: (outDir: string) => void): string {
  if (config.prereg === undefined) {
    throw new Error('the config has no prereg block — add it before printing the bindings, because it is part of the config digest')
  }
  assertCleanWorktree(repoRoot)
  return formatBindings(methodBindings(config, repoRoot, build))
}

/** Everything a private entry point may be handed in place of the real thing. */
export interface PrivateSetDeps {
  preconditions?: (options: { requirePrereg: boolean }) => PrivateStamp | FrozenMethod
  canary?: () => Promise<number>
  runner?: ArmRunner
  provenance?: ProvenanceReader
  /** The public records the verdict compares against. */
  publicResultsDir?: string
}

/**
 * The real preconditions: every private check, then a clean tree.
 *
 * The clean-tree refusal comes after the plugin check on purpose. A missing
 * plugin is the one mistake an operator can make in the config alone, and it
 * must be named as itself whatever state the checkout is in. Nothing is spent
 * until both have passed, so the order between them costs nothing.
 *
 * `main()` binds it with no overrides, and tests pass a fixture repository.
 */
export function realPreconditions(
  config: PrivateConfig,
  repoRoot: string = REPO_ROOT,
  overrides: { engineBase?: string; build?: (outDir: string) => void } = {},
): NonNullable<PrivateSetDeps['preconditions']> {
  return (options) => {
    const stamp = assertPrivatePreconditions(config, repoRoot, { ...options, ...overrides })
    assertCleanWorktree(repoRoot)
    return stamp
  }
}

/**
 * Refuse unless a measured set's preconditions returned a whole frozen method:
 * its freeze commit, its check ids, its commitment and all six digests.
 * Anything less binds nothing, so nothing is spent on it.
 */
function requireFrozen(stamp: PrivateStamp | FrozenMethod): FrozenMethod {
  const frozen = stamp as Partial<FrozenMethod>
  const whole =
    typeof frozen.freeze_commit === 'string' &&
    Array.isArray(frozen.check_ids) &&
    typeof frozen.prereg_commitment === 'string' &&
    BIND_KEYS.every((key) => typeof frozen[key] === 'string')
  if (!whole) throw new Error("a measured set's preconditions bound no frozen method, so nothing is spent")
  return stamp as FrozenMethod
}

/**
 * The gate every private entry point passes before it spends: scrub the
 * configured variables, check the preconditions, check the records already on
 * disk when the set is a measured one, then run the canary.
 *
 * The order is the safety property. The scrub is first, so no fleet override
 * survives into anything that follows. The preconditions are next, so a missing
 * plugin is named before anything is spent. The records already in the
 * measured results dir are next, so an unbound or foreign one stops the set
 * before it is paid for rather than after. The canary is last, so an absent
 * sandbox refuses before the first paid session. Each step throws, and a throw
 * here runs no arm and writes no record.
 */
async function privateGate(config: PrivateConfig, deps: PrivateSetDeps, requirePrereg: true): Promise<FrozenMethod>
async function privateGate(config: PrivateConfig, deps: PrivateSetDeps, requirePrereg: false): Promise<PrivateStamp>
async function privateGate(config: PrivateConfig, deps: PrivateSetDeps, requirePrereg: boolean): Promise<PrivateStamp | FrozenMethod> {
  scrubEnv(config.envScrub)
  let stamp = (deps.preconditions ?? realPreconditions(config))({ requirePrereg })
  if (requirePrereg) {
    const frozen = requireFrozen(stamp)
    assertRecordsBound((await resumeState(config.resultsDir)).runs, frozen)
    stamp = frozen
  }
  await (deps.canary ?? runCanary)()
  return stamp
}

/**
 * The measured private set, then its summary and the verdict against the
 * public one, computed together and mechanically.
 *
 * The gate runs first, so nothing is spent unless the preconditions, the
 * records already on disk and the canary pass, and the same records are
 * checked again before every iteration. The set runs on the public driver
 * through the private hooks, so
 * the order, the cap, the cold flag and the exclusive write are the ones the
 * public set was measured with. The verdict is computed only over a set
 * `runSet` finished, from the private summary, which refuses any record not
 * bound to the committed method.
 */
export async function runPrivateSet(
  config: PrivateConfig,
  deps: PrivateSetDeps = {},
): Promise<{ summary: SetSummary; agreement: AgreementReport }> {
  const frozen = await privateGate(config, deps, true)
  await runSet({
    runner: deps.runner ?? makePrivateRunner(config),
    resultsDir: config.resultsDir,
    notesSource: config.notes,
    provenance: deps.provenance ?? readProvenance,
    privateHooks: privateHooks(config, recordStamp(frozen), (runs) => assertRecordsBound(runs, frozen)),
  })
  const summary = await summarisePrivate(config.resultsDir, frozen)
  const agreement = agreementVerdict(summary, await summariseSet(deps.publicResultsDir ?? join(REPO_ROOT, 'bench/results')))
  return { summary, agreement }
}

/**
 * One disclosed iteration of the private set, written to a scratch dir, never
 * the measured one.
 *
 * It exists because a mistake in the private prompts or checks found after the
 * method is frozen costs a whole measured set. It runs behind the same gate,
 * with the prereg not required, so its records carry the snapshot digest and
 * no commitment. They are unbound by design: the private summary refuses any
 * record without the commitment, so a shakedown record can never be counted.
 * The pre-registration must disclose each shakedown iteration all the same.
 */
export async function runPrivateShakedown(
  config: PrivateConfig,
  scratchDir: string,
  deps: PrivateSetDeps = {},
): Promise<BenchRunRecord[]> {
  assertScratchDir(scratchDir, config.resultsDir)
  const stamp = await privateGate(config, deps, false)
  return runIteration({
    iteration: (await resumeState(scratchDir)).nextIteration,
    runner: deps.runner ?? makePrivateRunner(config),
    resultsDir: scratchDir,
    notesSource: config.notes,
    provenance: deps.provenance ?? readProvenance,
    privateHooks: privateHooks(config, stamp),
  })
}

/**
 * The private warm-up: the from-scratch arm once, in a private control home,
 * behind the same gate, producing the notes the with-state arm is later handed.
 *
 * The prereg is not required, because the notes it produces are part of what
 * the method freezes. It writes no record, and it refuses once the measured
 * results dir holds any, exactly as the public warm-up does.
 */
export async function runPrivateWarmup(config: PrivateConfig, deps: PrivateSetDeps = {}): Promise<string> {
  await privateGate(config, deps, false)
  return runWarmup({
    runner: deps.runner ?? makePrivateRunner(config),
    resultsDir: config.resultsDir,
    seed: (arm, home) => seedPrivateControl(home, arm, config),
  })
}

/** A path argument, refused unless absolute: a relative one would depend on where the command ran. */
function absoluteArg(value: string | undefined, what: string): string {
  if (value === undefined || !isAbsolute(value)) throw new Error(`the ${what} path must be absolute, got '${value ?? ''}'`)
  return value
}

/**
 * Refuse a salt path inside this checkout, under any spelling of it, its
 * private dir included.
 *
 * Both sides are resolved through every link by `realPathOf`, so a path
 * reached through a link into the checkout is refused as well.
 */
function refuseInsideRepository(path: string): void {
  const real = realPathOf(path)
  const root = realPathOf(REPO_ROOT)
  if (real === root || real.startsWith(root + sep)) {
    throw new Error('the salt must live in the private repository, never inside this repository')
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

  // The private modes. Every private value arrives through the config, whose
  // path must be absolute, so no tracked line names what the set measures and
  // no mode's meaning depends on where it was launched from.
  if (argv[2] === PRIVATE_MODE) {
    const { summary, agreement } = await runPrivateSet(loadPrivateConfig(argv[3] ?? ''))
    process.stdout.write(`${JSON.stringify({ summary, agreement }, null, 2)}\n`)
    return
  }

  if (argv[2] === PRIVATE_WARMUP_MODE) {
    const produced = await runPrivateWarmup(loadPrivateConfig(argv[3] ?? ''))
    process.stdout.write(`the private warm-up session's notes were copied out to:\n  ${produced}\n`)
    process.stdout.write(`read it by eye, copy it to the config's notes path, and record its sha256 in the private pre-registration.\n`)
    return
  }

  // Its records are printed and never summarised: they carry no commitment, so
  // the private summary would refuse them anyway.
  if (argv[2] === PRIVATE_SHAKEDOWN_MODE) {
    const config = loadPrivateConfig(argv[3] ?? '')
    const records = await runPrivateShakedown(config, absoluteArg(argv[4], 'shakedown scratch dir'))
    for (const { arm, iteration, disposition, graded, outbound_blocked } of records) {
      process.stdout.write(`${JSON.stringify({ arm, iteration, disposition, graded, outbound_blocked })}\n`)
    }
    return
  }

  if (argv[2] === SNAPSHOT_MODE) {
    const digest = await takeSnapshot(loadPrivateConfig(argv[3] ?? ''))
    process.stdout.write(`${digest}\nrecord it as snapshot.sha256 in the private config.\n`)
    return
  }

  // The salt is what keeps a published commitment from being reversed by
  // hashing guesses, so it is written once, readable by its owner alone, never
  // inside this repository, and never printed.
  if (argv[2] === SALT_MODE) {
    const path = absoluteArg(argv[3], 'salt')
    refuseInsideRepository(path)
    writeFileSync(path, randomBytes(32), { flag: 'wx', mode: 0o600 })
    process.stdout.write('wrote a 32-byte salt\n')
    return
  }

  // Exactly one line, the salted digest, so the output can be pasted into the
  // public ledger as it stands. A directory is bound through its tree digest.
  if (argv[2] === COMMIT_MODE) {
    const saltPath = absoluteArg(argv[3], 'salt')
    refuseInsideRepository(saltPath)
    const doc = absoluteArg(argv[4], 'document')
    const bytes = statSync(doc).isDirectory() ? Buffer.from(treeDigest(doc)) : readFileSync(doc)
    process.stdout.write(`${commitment(readFileSync(saltPath), bytes)}\n`)
    return
  }

  // The method's bind lines, for the private pre-registration. Spends nothing.
  if (argv[2] === BIND_MODE) {
    process.stdout.write(bindingLines(loadPrivateConfig(argv[3] ?? ''), REPO_ROOT))
    process.stdout.write('paste these lines into the private pre-registration before computing its commitment.\n')
    return
  }

  if (argv[2] === WARMUP_MODE) {
    const produced = await runWarmup({ runner: runRealArm, resultsDir })
    process.stdout.write(`the warm-up session's notes were copied out to:\n  ${produced}\n`)
    process.stdout.write(`read it by eye, then copy it to ${NOTES_FIXTURE} and commit it.\n`)
    return
  }

  // A mistyped mode must not fall through to the public measured set, which
  // spends. The public set is the invocation with no mode at all.
  if (argv[2] !== undefined) {
    throw new Error(
      `unknown mode '${argv[2]}' — expected no mode, or one of ${[WARMUP_MODE, PRIVATE_MODE, PRIVATE_WARMUP_MODE, PRIVATE_SHAKEDOWN_MODE, SNAPSHOT_MODE, SALT_MODE, COMMIT_MODE, BIND_MODE].join(', ')}`,
    )
  }

  // Before the spend and not only at stamp time. readProvenance refuses a dirty
  // tree on every record, which catches an edit made part-way through; this
  // catches the same thing before a single session has been paid for.
  assertCleanWorktree(REPO_ROOT)

  const summary = await runSet({
    runner: runRealArm,
    resultsDir,
    notesSource: join(REPO_ROOT, NOTES_FIXTURE),
    provenance: readProvenance,
  })
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
}

if (import.meta.main) await main(process.argv)
