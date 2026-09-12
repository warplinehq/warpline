/**
 * The benchmark harness, end to end, over the deterministic half of the pinned
 * scenario — with no provider key anywhere on the path.
 *
 * Why this file lives under `src/__tests__/` and not under `bench/`: CI shards
 * the suite by a `find` over `src/` plus one explicit `examples/` line, so a
 * test directory anywhere else runs locally and runs NOWHERE in CI. A guard
 * that passes on a laptop and never runs on the branch is the failure mode
 * this repository has already shipped four times.
 *
 * The assertions that make it evidence rather than decoration:
 *
 *   - a roster sentinel. Five manifests must load from the seeded root before
 *     anything downstream is asserted, and the failure names the count. A scan
 *     that found nothing must be red, never clean.
 *   - the two handoff artifacts must be ABSENT at this stage. Nothing has
 *     resolved them yet, so a grader that passed on them would be grading
 *     nothing at all, and the two artifacts it DOES pass would carry no weight.
 *   - the scrubber is fed a raw carrying an operator path and a nested currency
 *     key, because the schema itself declares neither. Asserting the scrub over
 *     a record that could not have contained the thing being scrubbed is a test
 *     that cannot fail.
 */
import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { loadPluginManifests } from 'warpline/unstable-runtime'
import {
  ADVANCE_TOKENS,
  ApiUnavailableError,
  ARM_ORDER,
  buildClaudeArgv,
  buildClaudeEnv,
  buildConsumerPrompt,
  CONSUMER_PLUGIN_PATH,
  parseClaudeResult,
  PINNED_MODEL,
  resolveDisposition,
  RUN_LOG_PLACEHOLDER,
  runClaudeArm,
  runWarplineArm,
  runWarplineIteration,
  SESSION_BUDGET,
  ZeroHandoffError,
  type ConsumerSessionResult,
  type SessionId,
  type WarplineArmResult,
} from '../../bench/arms.js'
import { gradeHome, type GradeResult } from '../../bench/grade.js'
import { BenchRunRecordSchema, parseRecord, scrubRecord } from '../../bench/record.js'
import {
  assertHomeSeam,
  buildPluginRoot,
  CONTROL_INPUT_PATHS,
  ControlSeedError,
  GRADED_DIR,
  GRADED_PATHS,
  NOTES_PATH,
  PINNED_PLUGINS,
  seedArmHome,
  seedControlHome,
  withArmHome,
  writeSessionGrant,
} from '../../bench/seed.js'

const REPO_ROOT = join(import.meta.dir, '..', '..')

/** A record with every field the schema requires, so a test can vary one thing. */
function sampleRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    arm: 'warpline',
    iteration: 1,
    arm_order_index: 0,
    cold: true,
    disposition: 'passed',
    truncation_subtype: null,
    tokens: { input: 0, output: 0, cache_creation: 0, cache_read: 0 },
    wall_clock_ms: 1.5,
    runtime_ms: 1.5,
    consumer_ms: null,
    parked_handoffs: 2,
    graded: {
      'announce-fanout': false,
      'daily-digest': true,
      'draft-writer': false,
      'metrics-rollup': true,
    },
    git_sha: 'abcdef0',
    package_version: '0.0.0',
    claude_cli_version: 'none',
    model_id: 'none',
    ...overrides,
  }
}

describe('bench harness — the deterministic half, end to end', () => {
  test('one warpline iteration parks two handoffs and materialises two graded artifacts', async () => {
    await withArmHome(async (home) => {
      await seedArmHome(home)
      assertHomeSeam(home)

      // The roster sentinel, before anything downstream.
      const { manifests } = await loadPluginManifests(join(home, 'plugins'))
      if (manifests.size !== PINNED_PLUGINS.length) {
        throw new Error(
          `the seeded plugin root loaded ${manifests.size} manifests where ${PINNED_PLUGINS.length} are pinned`,
        )
      }
      expect([...manifests.keys()].sort()).toEqual([...PINNED_PLUGINS].sort())

      const arm = await runWarplineArm(home)

      expect(arm.parked_handoffs).toBe(2)
      expect(arm.runtime_ms).toBeGreaterThan(0)

      // The two handoff artifacts are absent: nothing has resolved them.
      expect(existsSync(join(home, GRADED_PATHS['draft-writer']))).toBe(false)
      expect(existsSync(join(home, GRADED_PATHS['announce-fanout']))).toBe(false)

      const grade = gradeHome(home)
      expect(grade.paths['daily-digest']).toBe(true)
      expect(grade.paths['metrics-rollup']).toBe(true)
      expect(grade.paths['draft-writer']).toBe(false)
      expect(grade.paths['announce-fanout']).toBe(false)
      expect(grade.passed).toBe(false)

      // The digest names both declared producers, one of which is absent from
      // the plugin root on purpose.
      const digest = JSON.parse(readFileSync(join(home, GRADED_PATHS['daily-digest']), 'utf8')) as {
        lines: string[]
        digest: string
      }
      expect(digest.lines.length).toBe(2)
      expect(digest.digest.length).toBeGreaterThan(0)
    })
  })

  test('the scrub runs before the parse, over a raw that carries what it removes', async () => {
    await withArmHome(async (home) => {
      await seedArmHome(home)
      const arm = await runWarplineArm(home)

      const raw = sampleRecord({
        parked_handoffs: arm.parked_handoffs,
        runtime_ms: arm.runtime_ms,
        wall_clock_ms: arm.runtime_ms,
        // None of these three is a schema field. That is the point: the scrub
        // has to remove them from the RAW, before a parse that would strip
        // them anyway and hide whether the scrub did anything.
        run_log_path: arm.advance.run_log_path,
        usage: { input_tokens: 10, total_cost_usd: 1.23 },
        stdout: 'free text nobody has read',
      })

      const scrubbed = scrubRecord(raw, home) as Record<string, unknown>
      const serialised = JSON.stringify(scrubbed)

      expect(raw.run_log_path as string).toContain(home)
      expect(serialised).not.toContain(home)
      expect(serialised).not.toContain('cost')
      expect(scrubbed.stdout).toBeUndefined()
      expect((scrubbed.usage as Record<string, unknown>).input_tokens).toBe(10)
      expect(scrubbed.run_log_path as string).toContain('<home>')

      const record = parseRecord(raw, home)
      expect(record.parked_handoffs).toBe(2)
      expect(record.tokens.cache_read).toBe(0)
    })
  })

  test('nothing under the results directory is a placeholder', () => {
    const listed = execFileSync('git', ['ls-files', '--', 'bench/results/'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
    const tracked = listed.split('\n').filter((line) => line.trim() !== '')

    // Extension AND shape, never an empty-roster assertion: an assertion that
    // the directory is empty goes permanently red the moment the first real
    // record lands, and takes the whole suite with it.
    expect(tracked.filter((file) => !file.endsWith('.json'))).toEqual([])
    for (const file of tracked) {
      BenchRunRecordSchema.parse(JSON.parse(readFileSync(join(REPO_ROOT, file), 'utf8')))
    }
  })
})

/**
 * The two things the benchmark's own prose asserts about the world, asserted
 * in CI instead of re-read by a human.
 *
 * Offenders are collected and compared against an empty list, never counted:
 * a failure that says "4 of 5" sends a reader looking, and a failure that says
 * which directory or which manifest sends them straight there.
 */
describe('bench harness — the pin and the grant', () => {
  const EXAMPLE_ROOT = join(REPO_ROOT, 'examples', 'plugins')

  test('every pinned example resolves to a directory under the example root', () => {
    const offenders = PINNED_PLUGINS.filter((name) => {
      const path = join(EXAMPLE_ROOT, name)
      return !existsSync(path) || !statSync(path).isDirectory()
    })
    expect(offenders).toEqual([])
  })

  /**
   * Every pinned manifest declares an EMPTY side-effect array, so the grant
   * seeded into each arm home is provably belt-and-braces today rather than
   * load-bearing — the gate consults a grant only for a plugin whose array is
   * non-empty. Earlier prose for this scenario said the fan-out plugin
   * declares side effects; the manifest says otherwise, and this test is what
   * keeps the two from drifting apart again.
   *
   * What goes wrong the day this turns red: the gate starts holding that
   * plugin before its handler runs, so the handoff prefix is never emitted at
   * all, and the failure arrives as a run that parked zero handoffs with no
   * mention of approval anywhere in it. The grant becomes load-bearing on that
   * day and the pre-registration's wording about it becomes false.
   *
   * Read through the same loader the engine uses, over the seeded root, so
   * this is the manifest the run would have loaded and not a second copy.
   */
  test('every pinned manifest declares an empty side-effect array', async () => {
    await withArmHome(async (home) => {
      await buildPluginRoot(home)
      const { manifests } = await loadPluginManifests(join(home, 'plugins'))
      expect(manifests.size).toBe(PINNED_PLUGINS.length)

      const offenders = [...manifests.entries()]
        .filter(([, manifest]) => (manifest.side_effects ?? []).length > 0)
        .map(([name]) => name)
      expect(offenders).toEqual([])
    })
  })

  /**
   * The grant is written by hand, because no writer for it is published. So
   * the payload is asserted directly against the shape the real gate reads: a
   * payload the gate would reject surfaces downstream as a run that parked
   * nothing, with nothing in the failure naming approval at all.
   *
   * The file the writer produced is read back rather than an inline literal
   * being checked against itself.
   */
  test('the seeded grant carries exactly the four fields the gate reads', async () => {
    await withArmHome(async (home) => {
      const path = await writeSessionGrant(home)
      const payload = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>

      expect(Object.keys(payload).sort()).toEqual(['expires_at', 'first_granted_at', 'granted_at', 'scopes'])
      expect(payload.scopes).toBe('*')
      expect(Date.parse(payload.expires_at as string)).toBeGreaterThan(Date.parse(payload.granted_at as string))
      expect(statSync(path).mode & 0o777).toBe(0o600)
    })
  })

  test('the four graded paths are pairwise distinct', () => {
    const entries = Object.entries(GRADED_PATHS)
    const byPath = new Map<string, string>()
    const offenders: string[] = []
    for (const [key, relative] of entries) {
      const prior = byPath.get(relative)
      if (prior !== undefined) offenders.push(`${prior} and ${key} both resolve to ${relative}`)
      else byPath.set(relative, key)
    }
    expect(offenders).toEqual([])
    expect(byPath.size).toBe(entries.length)
  })
})

/**
 * The control home, and the three-way agreement the benchmark's own documents
 * depend on.
 *
 * The assertions that make this evidence rather than decoration:
 *
 *   - the purity walk runs over BOTH recipes. A walk that only ever looked at
 *     a control home would be asserting the absence of things nothing put
 *     there; the same walk over a home the other recipe seeded has to find all
 *     four of them, or the control assertion proves nothing.
 *   - the agreement test iterates the EXPORTED constants and never restates a
 *     path literal. A test carrying its own copy of the strings goes green on
 *     a matched pair of renames, which is the one failure the agreement exists
 *     to catch.
 */
describe('bench harness — the control home', () => {
  const FIXTURE_ROOT = join(REPO_ROOT, 'bench', 'fixtures')

  /**
   * Every path segment under `root`, plus the relative path of every symbolic
   * link at any depth.
   *
   * Recursion is on `isDirectory()`, which is FALSE for a symbolic link to a
   * directory — deliberately. A `stat`-based walk would follow the package
   * link in the other recipe's home straight back into the repository and
   * enumerate the whole checkout.
   */
  function walk(root: string): { segments: Set<string>; symlinks: string[] } {
    const segments = new Set<string>()
    const symlinks: string[] = []
    const visit = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        segments.add(entry.name)
        if (entry.isSymbolicLink()) symlinks.push(relative(root, full))
        else if (entry.isDirectory()) visit(full)
      }
    }
    visit(root)
    return { segments, symlinks }
  }

  /**
   * The five things a control home must not carry, named as the path segment
   * a walk would find: the plugin root, the package directory the one link
   * lives in, the plugin-named configuration directory, the grant file, and
   * the runtime's preferences file — which is a knob on a runtime a control
   * arm does not have, and which the frozen method lists beside the other
   * four rather than a step below them.
   */
  const REVEALING = ['plugins', 'node_modules', 'config', '.session-approval', 'preferences.json']

  test('the from-scratch home carries the six input bodies and an empty graded directory', async () => {
    await withArmHome(async (home) => {
      await seedControlHome(home, 'agent-from-scratch')

      const missing: string[] = []
      for (const [fixture, rel] of Object.entries(CONTROL_INPUT_PATHS)) {
        const placed = join(home, rel)
        if (!existsSync(placed)) {
          missing.push(rel)
          continue
        }
        // Bytes, not a parse: the arms are comparable only if every arm reads
        // the identical body, and a re-serialised JSON document is a different
        // body that would still parse equal.
        expect(readFileSync(placed)).toEqual(readFileSync(join(FIXTURE_ROOT, fixture)))
      }
      expect(missing).toEqual([])

      const graded = join(home, GRADED_DIR)
      expect(statSync(graded).isDirectory()).toBe(true)
      expect(readdirSync(graded)).toEqual([])
    })
  })

  test('a control home reveals nothing the other recipe reveals, and that recipe reveals all of it', async () => {
    await withArmHome(async (home) => {
      await seedControlHome(home, 'agent-from-scratch')
      const control = walk(home)
      expect(REVEALING.filter((name) => control.segments.has(name))).toEqual([])
      expect(control.symlinks).toEqual([])
    })

    // The comparison home, seeded by the OTHER recipe, inside its own
    // set-and-restore of the home variable — that recipe reads the resolver.
    await withArmHome(async (home) => {
      await seedArmHome(home)
      const warpline = walk(home)
      expect(REVEALING.filter((name) => !warpline.segments.has(name))).toEqual([])
      expect(warpline.symlinks.length).toBeGreaterThan(0)
    })
  })

  test('the with-state home gets a fresh byte copy of the notes source, never a link', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'warpline-bench-notes-'))
    const source = join(scratch, 'agent-notes.md')
    try {
      await writeFile(source, '# what the last pass learned\n\nOne line of it.\n')
      await withArmHome(async (home) => {
        await seedControlHome(home, 'agent-with-state', source)
        const placed = join(home, NOTES_PATH)
        expect(readFileSync(placed)).toEqual(readFileSync(source))
        // A link would let one measured run's edits reach the tracked fixture
        // and therefore every later run in the set.
        expect(lstatSync(placed).isSymbolicLink()).toBe(false)
        expect(lstatSync(placed).isFile()).toBe(true)
      })
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })

  test('the from-scratch home has no file at the notes path at all', async () => {
    await withArmHome(async (home) => {
      await seedControlHome(home, 'agent-from-scratch')
      // A rejecting stat, not an empty-string read: the prompt's read clause
      // tests for existence, and an empty file is a file.
      expect(() => lstatSync(join(home, NOTES_PATH))).toThrow()
    })
  })

  test('a with-state seed with no notes source refuses, naming the arm and the path', async () => {
    await withArmHome(async (home) => {
      const absent = join(home, 'no-such-notes-source.md')
      let thrown: unknown
      try {
        await seedControlHome(home, 'agent-with-state', absent)
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(ControlSeedError)
      expect((thrown as Error).message).toContain('agent-with-state')
      expect((thrown as Error).message).toContain(absent)
      expect(existsSync(join(home, NOTES_PATH))).toBe(false)
    })
  })

  test('the control recipe refuses the warpline arm by name', async () => {
    await withArmHome(async (home) => {
      let thrown: unknown
      try {
        await seedControlHome(home, 'warpline')
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(ControlSeedError)
      expect((thrown as Error).message).toContain('warpline')
    })
  })

  /**
   * The three-way agreement: the seeder's constants, the frozen method
   * document, and the prompt the control arms are handed.
   *
   * One test over every leg, iterating the constants. Split in two, one leg
   * could go red while the other stayed green and a reader would take the
   * green one as the state of the agreement. The pre-registration freezes once
   * a result exists, so a drift found after that is a method change rather
   * than a rename — which is why this runs now.
   */
  test('every control path in the seeder appears verbatim in the pre-registration and in the prompt', () => {
    const preRegistration = readFileSync(join(REPO_ROOT, 'bench', 'PRE-REGISTRATION.md'), 'utf8')
    const prompt = readFileSync(join(REPO_ROOT, 'bench', 'prompts', 'agent.md'), 'utf8')
    const controlPaths = [...Object.values(CONTROL_INPUT_PATHS), NOTES_PATH]

    const missing: string[] = []
    for (const rel of controlPaths) {
      if (!preRegistration.includes(rel)) missing.push(`bench/PRE-REGISTRATION.md: ${rel}`)
    }
    // The prompt leg carries the graded paths too: those are the other half of
    // what this file has to name, and a control session that cannot find the
    // path writes its output somewhere the grader never looks.
    for (const rel of [...controlPaths, ...Object.values(GRADED_PATHS)]) {
      if (!prompt.includes(rel)) missing.push(`bench/prompts/agent.md: ${rel}`)
    }
    // And the channel names, read from the fixture the grader itself keys on
    // rather than restated here. A control home carries no configuration file
    // naming them, so the prompt is the only place a control session can learn
    // them — and a channel name that drifted from the fixture would fail every
    // control run's fan-out with nothing in the output naming the cause.
    const fixture = JSON.parse(
      readFileSync(join(FIXTURE_ROOT, 'config', 'announce-fanout.json'), 'utf8'),
    ) as { channels: string[] }
    expect(fixture.channels.length).toBeGreaterThan(0)
    for (const channel of fixture.channels) {
      if (!prompt.includes(channel)) missing.push(`bench/prompts/agent.md: ${channel}`)
    }

    expect(missing).toEqual([])
  })
})

/**
 * Parsing and dispositioning the command-line tool's result JSON.
 *
 * Every fixture below is a module constant and every test here runs with no
 * subprocess and no provider key, so this whole block is evidence on a branch
 * rather than something only the operator's machine can produce.
 *
 * The authentication fixture is the one that earns the block. It was measured
 * on this machine, verbatim, by running the arms' own isolation against an
 * unkeyed environment — and it returned a SUCCESS subtype, a zero spend and
 * all four token classes present and equal to zero. A parser reading the
 * subtype, or reading the token shape, calls that a legitimate all-zero run,
 * fails it at the grader, and publishes a provider outage as the arm's own
 * failure rate. That is the misattribution these tests exist to make
 * impossible.
 */

/** A successful session. The four classes, the duration, and the canonical id. */
const SUCCESS_RESULT = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  terminal_reason: 'end_turn',
  duration_ms: 8421,
  duration_api_ms: 8104,
  num_turns: 6,
  session_id: '11111111-2222-3333-4444-555555555555',
  total_cost_usd: 0.42,
  usage: {
    input_tokens: 14,
    output_tokens: 233,
    cache_creation_input_tokens: 18022,
    cache_read_input_tokens: 4110,
  },
  modelUsage: { 'claude-opus-5-20260101': { inputTokens: 14, outputTokens: 233 } },
  result: 'wrote graded/draft-writer.md and graded/announce-fanout.json',
}

/** Every class present, every class zero, and nothing wrong with the run. */
const GENUINE_ZERO_RESULT = {
  ...SUCCESS_RESULT,
  usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
}

/** One class absent from the usage object. Not zero — absent. */
const MISSING_CLASS_RESULT = {
  ...SUCCESS_RESULT,
  usage: { input_tokens: 14, output_tokens: 233, cache_creation_input_tokens: 18022 },
}

/**
 * The measured authentication failure, captured verbatim this session by
 * running the arms' own isolation — a fresh configuration directory, the bare
 * flag, the model flag, JSON output — against an environment with no key.
 *
 * Trimmed only of the fields nothing reads (the subagent and fast-mode
 * blocks); every field any of these tests or the parser touches is as it came
 * back. Note `subtype: "success"` and the four zeroes sitting beside
 * `is_error: true`.
 */
const AUTH_FAILURE_RESULT = {
  type: 'result',
  subtype: 'success',
  is_error: true,
  terminal_reason: 'api_error',
  api_error_status: null,
  stop_reason: 'stop_sequence',
  duration_ms: 51,
  duration_api_ms: 0,
  num_turns: 1,
  session_id: 'eb9e877a-faaa-4d34-b97c-c5581275425c',
  total_cost_usd: 0,
  usage: {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  },
  modelUsage: {},
  permission_denials: [],
  result: 'Not logged in · Please run /login',
}

/** The tool's own turn ceiling tripped. The subtype is the record's evidence. */
const TURN_LIMIT_RESULT = {
  ...SUCCESS_RESULT,
  subtype: 'error_max_turns',
  is_error: true,
  terminal_reason: 'error',
}

/** The spend stop point tripped. Same disposition, different subtype. */
const SPEND_LIMIT_RESULT = {
  ...SUCCESS_RESULT,
  subtype: 'error_max_budget_usd',
  is_error: true,
  terminal_reason: 'error',
}

/** A tool failure inside the session: the arm failed to do the work. */
const IN_SESSION_ERROR_RESULT = {
  ...SUCCESS_RESULT,
  is_error: true,
  terminal_reason: 'error_during_execution',
}

/** A grade outcome in the shape `gradeHome` returns, without seeding a home. */
function gradeOutcome(passed: boolean): GradeResult {
  return {
    paths: {
      'announce-fanout': passed,
      'daily-digest': passed,
      'draft-writer': passed,
      'metrics-rollup': passed,
    },
    passed,
  }
}

describe('bench harness — the result JSON, parsed and dispositioned', () => {
  test('a successful result yields the four classes, the duration and the canonical model id', () => {
    const parsed = parseClaudeResult(SUCCESS_RESULT, 'agent-from-scratch')

    expect(parsed.tokens).toEqual({ input: 14, output: 233, cache_creation: 18022, cache_read: 4110 })
    expect(parsed.duration_ms).toBe(8421)
    expect(parsed.num_turns).toBe(6)
    // Read back from the per-model usage key, never echoed from the flag, so
    // the record names the id that actually served the request.
    expect(parsed.model_id).toBe('claude-opus-5-20260101')
  })

  test('a class present and equal to zero is 0, never null and never omitted', () => {
    const parsed = parseClaudeResult(GENUINE_ZERO_RESULT, 'agent-from-scratch')

    expect(parsed.tokens).toEqual({ input: 0, output: 0, cache_creation: 0, cache_read: 0 })
    for (const value of Object.values(parsed.tokens)) expect(value).not.toBeNull()
    // And a genuine all-zero run is not a schema failure.
    expect(resolveDisposition({ parsed, graded: gradeOutcome(true) }).disposition).toBe('passed')
  })

  test('a class absent from the usage object is null for that class only, and the run is a schema failure', () => {
    const parsed = parseClaudeResult(MISSING_CLASS_RESULT, 'agent-from-scratch')

    expect(parsed.tokens.cache_read).toBeNull()
    expect(parsed.tokens).toEqual({ input: 14, output: 233, cache_creation: 18022, cache_read: null })
    // Even with every artifact graded true: an unreportable class means the
    // total is unknown, and an unknown total is not a measurement.
    expect(resolveDisposition({ parsed, graded: gradeOutcome(true) }).disposition).toBe('failed-schema')
  })

  test('the measured authentication failure throws by name before any disposition is computed', () => {
    // The trap, asserted on the fixture itself so a later edit that softened it
    // would turn this red rather than quietly weakening the test below.
    expect(AUTH_FAILURE_RESULT.subtype).toBe('success')
    expect(AUTH_FAILURE_RESULT.total_cost_usd).toBe(0)
    expect(Object.values(AUTH_FAILURE_RESULT.usage)).toEqual([0, 0, 0, 0])

    expect(() => parseClaudeResult(AUTH_FAILURE_RESULT, 'agent-with-state')).toThrow(ApiUnavailableError)
    // Named: the arm and the terminal reason, because an operator reading a
    // halted run has to know which arm and that it was not the arm's fault.
    expect(() => parseClaudeResult(AUTH_FAILURE_RESULT, 'agent-with-state')).toThrow(/agent-with-state/)
    expect(() => parseClaudeResult(AUTH_FAILURE_RESULT, 'agent-with-state')).toThrow(/api_error/)
  })

  test('the turn-ceiling subtype is truncated and the subtype is carried verbatim', () => {
    const parsed = parseClaudeResult(TURN_LIMIT_RESULT, 'agent-from-scratch')
    const resolved = resolveDisposition({ parsed, graded: gradeOutcome(true) })

    expect(resolved.disposition).toBe('truncated')
    expect(resolved.truncation_subtype).toBe('error_max_turns')
  })

  test('the spend stop point is truncated and the subtype is carried verbatim', () => {
    const parsed = parseClaudeResult(SPEND_LIMIT_RESULT, 'agent-from-scratch')
    const resolved = resolveDisposition({ parsed, graded: gradeOutcome(true) })

    expect(resolved.disposition).toBe('truncated')
    expect(resolved.truncation_subtype).toBe('error_max_budget_usd')
  })

  test('a run that is simultaneously truncated and grader-failing resolves to truncated', () => {
    // The precedence is only observable where two of its steps are true at
    // once. A run truncated mid-work has of course not written the artifacts,
    // so this is the ordinary case rather than a contrived one — and counting
    // it as a grader failure would blame the arm for a stop point the method
    // set.
    const parsed = parseClaudeResult(SPEND_LIMIT_RESULT, 'agent-from-scratch')
    const resolved = resolveDisposition({ parsed, graded: gradeOutcome(false) })

    expect(resolved.disposition).toBe('truncated')
    // One value per run: the grader failure is not also recorded somewhere.
    expect(resolved.truncation_subtype).toBe('error_max_budget_usd')

    // And with nothing wrong, the chain falls all the way through.
    const clean = parseClaudeResult(SUCCESS_RESULT, 'agent-from-scratch')
    expect(resolveDisposition({ parsed: clean, graded: gradeOutcome(true) })).toEqual({
      disposition: 'passed',
      truncation_subtype: null,
    })
    expect(resolveDisposition({ parsed: clean, graded: gradeOutcome(false) }).disposition).toBe('failed-grader')
  })

  /**
   * The discovery seam, asserted before the code that substitutes it exists.
   *
   * The consumer prompt is the only place this token appears, and an
   * unsubstituted one is a session with no discovery path: it finds no
   * handoffs, writes neither handoff artifact, and fails the grader for a
   * reason nothing in the output names. A rename on either side is silent
   * otherwise — the prompt still reads fine and the substitution still runs,
   * over a token that is no longer there.
   */
  test('the run-log placeholder is the one substitution point the consumer prompt carries', () => {
    const prompt = readFileSync(join(REPO_ROOT, 'bench', 'prompts', 'consumer.md'), 'utf8')

    expect(prompt).toContain(RUN_LOG_PLACEHOLDER)
    // And exactly one such token in the file, so a second seam cannot be added
    // on one side without the substitution learning about it.
    expect(prompt.match(/\{\{[A-Z_]+\}\}/g)).toEqual([RUN_LOG_PLACEHOLDER])
  })

  test('an error flag without the api_error terminal reason is the arm failing, not the provider', () => {
    // No throw: a tool failure inside the session IS the arm failing to do the
    // work, and swallowing it as unattributable would remove a real failure
    // from the published rate.
    const parsed = parseClaudeResult(IN_SESSION_ERROR_RESULT, 'agent-with-state')

    expect(parsed.is_error).toBe(true)
    expect(resolveDisposition({ parsed, graded: gradeOutcome(false) }).disposition).toBe('failed-grader')
  })
})

/**
 * How the three sessions are spawned, asserted from pure builders with no
 * subprocess and no provider key.
 *
 * The argv and env tests are the only guard against the failure that costs a
 * whole measured set and reports a number anyway: two arms run under two
 * different setups and published as one comparison. Asserting them from a
 * builder rather than from a spawn is what lets them run on the branch.
 *
 * The flag list is asserted POSITIVELY and the two absent flags are asserted
 * BY ABSENCE, because both absences are load-bearing and measured: the minimal
 * flag reads strictly an API key or a key helper and never the subscription
 * credential, and the pinned tool version has no turn-cap flag at all, so
 * passing one would abort every session on an unrecognised argument.
 */
describe('bench harness — the three sessions, built', () => {
  const SESSIONS: readonly SessionId[] = ['agent-with-state', 'agent-from-scratch', 'consumer']

  /** Every flag every session carries, whichever session it is. */
  const SHARED_FLAGS = [
    '--print',
    '--output-format',
    '--model',
    '--max-budget-usd',
    '--permission-mode',
    '--safe-mode',
    '--no-session-persistence',
  ]

  test('every session carries the shared flags, the pinned model and the spend ceiling', () => {
    const missing: string[] = []
    for (const session of SESSIONS) {
      const argv = buildClaudeArgv(session, 'the body')
      for (const flag of SHARED_FLAGS) if (!argv.includes(flag)) missing.push(`${session}: ${flag}`)

      // The prompt body is the positional argument and the value flags carry
      // their own values, so each is asserted as a PAIR: a flag present with
      // the wrong value is the failure a membership check cannot see.
      expect(argv[0]).toBe('--print')
      expect(argv[1]).toBe('the body')
      expect(argv[argv.indexOf('--output-format') + 1]).toBe('json')
      expect(argv[argv.indexOf('--model') + 1]).toBe(PINNED_MODEL)
      expect(argv[argv.indexOf('--max-budget-usd') + 1]).toBe(SESSION_BUDGET)
      expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('bypassPermissions')
    }
    expect(missing).toEqual([])
  })

  test('no session carries the minimal flag or a turn cap', () => {
    const offenders: string[] = []
    for (const session of SESSIONS) {
      const argv = buildClaudeArgv(session, 'the body')
      // The minimal flag cannot reach the subscription credential, and the
      // pinned tool version has no turn-cap flag — measured, not assumed.
      for (const absent of ['--bare', '--max-turns']) {
        if (argv.includes(absent)) offenders.push(`${session}: ${absent}`)
      }
    }
    expect(offenders).toEqual([])
  })

  test('the consumer alone is pointed at this checkout, as an absolute path', () => {
    const consumer = buildClaudeArgv('consumer', 'the body')
    const flag = '--plugin-dir'

    expect(consumer).toContain(flag)
    const given = consumer[consumer.indexOf(flag) + 1] as string
    // Absolute, because the flag resolves against the working directory and the
    // working directory is the arm's home — a relative path does not exist there.
    expect(isAbsolute(given)).toBe(true)
    expect(given).toBe(CONSUMER_PLUGIN_PATH)
    expect(statSync(given).isDirectory()).toBe(true)

    // Withheld from both control arms: the runtime's own skills are the
    // reference implementation of the thing being measured.
    for (const control of ['agent-with-state', 'agent-from-scratch'] as const) {
      expect(buildClaudeArgv(control, 'the body')).not.toContain(flag)
    }
  })

  test('each session gets its own home and no configuration directory at all', () => {
    // Set on the way in, so the removal below is a removal and not an absence
    // that was already there.
    const prior = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = '/tmp/would-suppress-the-credential'
    try {
      const homes = SESSIONS.map((session) => join(tmpdir(), `home-${session}`))
      const envs = SESSIONS.map((session, i) => buildClaudeEnv(homes[i] as string))

      for (const [i, env] of envs.entries()) {
        expect(env.WARPLINE_HOME).toBe(homes[i] as string)
        // Absent rather than distinct. Measured: that variable carrying ANY
        // value — including the real default path — suppresses the subscription
        // credential, and the session returns an unattributable provider error
        // with all four token classes present and equal to zero.
        expect('CLAUDE_CONFIG_DIR' in env).toBe(false)
      }
      expect(new Set(envs.map((env) => env.WARPLINE_HOME)).size).toBe(SESSIONS.length)
    } finally {
      if (prior === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = prior
    }
  })

  test('the consumer prompt reaches the spawn carrying the absolute run-log path', () => {
    const runLog = '/tmp/warpline-bench-xyz/runs/run-1.json'
    const body = buildConsumerPrompt(runLog)

    expect(body).toContain(runLog)
    // An unsubstituted token is a session with no discovery path: it finds no
    // handoffs, writes neither handoff artifact, and fails the grader for a
    // reason nothing in its output names.
    expect(body).not.toContain(RUN_LOG_PLACEHOLDER)
    expect(buildClaudeArgv('consumer', body)[1]).toContain(runLog)
  })

  test('the fixed arm order is the three arms, warpline first', () => {
    expect([...ARM_ORDER]).toEqual(['warpline', 'agent-with-state', 'agent-from-scratch'])
  })
})

/**
 * The warpline arm's two-segment assembly, and the two refusals that spend no
 * money.
 *
 * Every test here injects the segments, so the arithmetic and both refusals are
 * checkable on the branch — and the zero-handoff test proves the consumer is
 * never spawned by injecting one that throws if it is reached.
 */
describe('bench harness — both segments, summed and refused', () => {
  /** An advance result in the shape the assembly consumes, without running one. */
  function advanceResult(overrides: Partial<WarplineArmResult> = {}): WarplineArmResult {
    return {
      runtime_ms: 1200,
      parked_handoffs: 2,
      advance: { run_log_path: '/tmp/warpline-bench-xyz/runs/run-1.json' } as WarplineArmResult['advance'],
      ...overrides,
    }
  }

  /** A consumer segment in the shape the assembly consumes, without spawning one. */
  function consumerResult(raw: unknown = SUCCESS_RESULT, consumer_ms = 8400): ConsumerSessionResult {
    return { parsed: parseClaudeResult(raw, 'warpline'), consumer_ms }
  }

  test('the published figures are the sum of both segments, with each segment also kept', async () => {
    const iteration = await runWarplineIteration('/tmp/nowhere', 1, {
      advance: async () => advanceResult(),
      consume: async () => consumerResult(),
      grade: () => gradeOutcome(true),
    })

    // The advance contributes zero to every class, present and equal to zero,
    // because it asks no provider anything. That is the finding, not a bug.
    expect(ADVANCE_TOKENS).toEqual({ input: 0, output: 0, cache_creation: 0, cache_read: 0 })
    expect(iteration.tokens).toEqual({ input: 14, output: 233, cache_creation: 18022, cache_read: 4110 })

    expect(iteration.wall_clock_ms).toBe(1200 + 8400)
    expect(iteration.runtime_ms).toBe(1200)
    expect(iteration.consumer_ms).toBe(8400)
    // Both present and distinct: one figure standing in for both would hide the
    // split that is the whole claim.
    expect(iteration.runtime_ms).not.toBe(iteration.consumer_ms)
    expect(iteration.deterministic_to_judgment_ratio).toBe(1200 / 8400)
    expect(iteration.parked_handoffs).toBe(2)
  })

  test('a null class in either segment stays null in the sum', async () => {
    const iteration = await runWarplineIteration('/tmp/nowhere', 1, {
      advance: async () => advanceResult(),
      consume: async () => consumerResult(MISSING_CLASS_RESULT),
      grade: () => gradeOutcome(true),
    })

    // A total over a sample with a hole is not a total, so it is not summed to a
    // smaller number that looks like a measurement.
    expect(iteration.tokens.cache_read).toBeNull()
    expect(resolveDisposition({ parsed: iteration.consumer, graded: gradeOutcome(true) }).disposition).toBe(
      'failed-schema',
    )
  })

  test('a run that parked nothing throws by name and never reaches the consumer', async () => {
    let thrown: unknown
    try {
      await runWarplineIteration('/tmp/nowhere', 7, {
        advance: async () => advanceResult({ parked_handoffs: 0 }),
        consume: async () => {
          throw new Error('the consumer session was spawned for a run that parked nothing')
        },
        grade: () => gradeOutcome(true),
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(ZeroHandoffError)
    // Named: the arm, the iteration and the count, because an operator reading a
    // halted set has to know which run and why without opening the code.
    expect((thrown as Error).message).toContain('warpline')
    expect((thrown as Error).message).toContain('7')
    expect((thrown as ZeroHandoffError).count).toBe(0)
  })

  test('a control arm refuses a home seeded for the other control arm', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'warpline-bench-misseeded-'))
    try {
      const withState = join(scratch, 'with-state')
      const fromScratch = join(scratch, 'from-scratch')
      await mkdir(withState)
      await mkdir(fromScratch)
      // The from-scratch home is the one carrying the notes file, and the
      // with-state home is the one without: each arm is handed the other's.
      await writeFile(join(fromScratch, NOTES_PATH), 'notes from a previous pass\n')

      for (const [arm, home] of [
        ['agent-with-state', withState],
        ['agent-from-scratch', fromScratch],
      ] as const) {
        let thrown: unknown
        try {
          await runClaudeArm(arm, home, 'the body')
        } catch (error) {
          thrown = error
        }
        // Thrown before any spawn, so a mis-seeded home costs nothing.
        expect((thrown as Error | undefined)?.message).toContain(arm)
        expect((thrown as Error).message).toContain(join(home, NOTES_PATH))
      }
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })
})
