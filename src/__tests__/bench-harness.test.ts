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
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { performance } from 'node:perf_hooks'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { warplineHome } from 'warpline/lib/paths'
import { loadPluginManifests } from 'warpline/unstable-runtime'
import {
  ADVANCE_TOKENS,
  ApiUnavailableError,
  ARM_ORDER,
  assertCleanWorktree,
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
  type Provenance,
  type SessionId,
  type WarplineArmResult,
} from '../../bench/arms.js'
import { gradeHome, type GradeResult } from '../../bench/grade.js'
import { BenchRunRecordSchema, parseRecord, scrubRecord } from '../../bench/record.js'
import {
  MAX_ITERATIONS,
  NoNotesProducedError,
  resumeState,
  runIteration,
  runSet,
  runWarmup,
  summariseSet,
  WARM_TARGET,
  type ArmRunner,
  type ArmRunOutcome,
} from '../../bench/run.js'
import { SHORTFALL_N } from '../../bench/stats.js'
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

/**
 * A tool-using session, verbatim in the shape a real one returned: TWO models,
 * with the auxiliary one inserted FIRST.
 *
 * Measured during the smoke iteration of all three arms. Every arm passed the
 * pinned model explicitly and every arm's result named this auxiliary model as
 * its first per-model usage key — so a parser taking the first key stamps every
 * record in the published set with a model that did none of the work.
 */
const TWO_MODEL_RESULT = {
  ...SUCCESS_RESULT,
  modelUsage: {
    'claude-haiku-4-5-20251001': { inputTokens: 912, outputTokens: 16, canonicalModel: 'claude-haiku-4-5' },
    'claude-opus-5': { inputTokens: 4, outputTokens: 207, canonicalModel: 'claude-opus-5' },
  },
}

/** A session the pinned model never served at all. */
const WRONG_MODEL_RESULT = {
  ...SUCCESS_RESULT,
  modelUsage: {
    'claude-haiku-4-5-20251001': { inputTokens: 912, outputTokens: 16, canonicalModel: 'claude-haiku-4-5' },
  },
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

  test('the model id is the pinned one even when an auxiliary model is reported first', () => {
    // The trap, asserted on the fixture: the auxiliary model IS the first key,
    // so a parser reading position rather than identity goes green here by
    // accident the day the tool stops reporting two.
    expect(Object.keys(TWO_MODEL_RESULT.modelUsage)[0]).toBe('claude-haiku-4-5-20251001')

    expect(parseClaudeResult(TWO_MODEL_RESULT, 'agent-from-scratch').model_id).toBe(PINNED_MODEL)
  })

  test('a session the pinned model never served has no model id at all', () => {
    // Null rather than the model that did serve: the record requires a string,
    // so a silent substitution stops the set instead of entering it under a name
    // the method never pinned.
    expect(parseClaudeResult(WRONG_MODEL_RESULT, 'agent-from-scratch').model_id).toBeNull()
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
    '--setting-sources',
    '--strict-mcp-config',
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
      // The EMPTY string, and asserted as a pair for the same reason as the
      // others: `--setting-sources` carrying any source at all readmits the
      // operator's instruction file, their skills and their hooks, and the
      // membership check above would still be green.
      expect(argv[argv.indexOf('--setting-sources') + 1]).toBe('')
    }
    expect(missing).toEqual([])
  })

  test('no session carries the minimal flag, the clean-room flag, or a turn cap', () => {
    const offenders: string[] = []
    for (const session of SESSIONS) {
      const argv = buildClaudeArgv(session, 'the body')
      // Three absences, each measured on this tool version rather than assumed.
      // The minimal flag cannot reach the subscription credential at all. The
      // clean-room flag authenticates but DISABLES THE PLUGIN'S OWN SKILLS, so
      // under it the plugin flag below is a no-op and the warpline arm's
      // definition is silently deleted. And there is no turn-cap flag.
      for (const absent of ['--bare', '--safe-mode', '--max-turns']) {
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

  /**
   * The stamped SHA names the commit checked out and not the code that ran, so a
   * set taken over uncommitted edits describes a tree nobody can reproduce. Over
   * a fixture repository and never over this one: a check closed over this
   * checkout could only ever be watched passing, and the refusal is the point.
   */
  test('a dirty worktree is refused at stamp time, and a written record is not what makes it dirty', () => {
    const root = mkdtempSync(join(tmpdir(), 'warpline-bench-clean-'))
    const fixtureGit = (args: string[]): void => {
      execFileSync('git', args, {
        cwd: root,
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
      })
    }
    try {
      fixtureGit(['init', '-q'])
      writeFileSync(join(root, 'arms.ts'), 'the code that ran\n')
      fixtureGit(['add', '-A'])
      fixtureGit([
        '-c',
        'user.name=fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-q',
        '-m',
        'the measured configuration',
      ])

      // Clean, so the SHA names what is here.
      expect(() => assertCleanWorktree(root)).not.toThrow()

      // A record written by the driver dirties the tree on the first run, and
      // every stamp after it would refuse. A record is output and never code, so
      // this exclusion is what makes the guard usable rather than a loophole.
      mkdirSync(join(root, 'bench', 'results'), { recursive: true })
      writeFileSync(join(root, 'bench', 'results', 'warpline-001.json'), '{"iteration":1}\n')
      expect(() => assertCleanWorktree(root)).not.toThrow()

      // An edit to the code, named in the refusal.
      writeFileSync(join(root, 'arms.ts'), 'the code that actually ran\n')
      expect(() => assertCleanWorktree(root)).toThrow(/would not name the code that ran/)

      // An untracked module elsewhere is in scope too: it can be code that ran.
      fixtureGit(['checkout', '--', 'arms.ts'])
      writeFileSync(join(root, 'extra.ts'), 'an untracked module\n')
      expect(() => assertCleanWorktree(root)).toThrow(/extra\.ts/)
    } finally {
      rmSync(root, { recursive: true, force: true })
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

/**
 * The driver, with the arms replaced.
 *
 * Every test here injects a fake arm runner, so the whole driver — the fixed
 * order, the sequencing, the per-arm seeding split, the incremental writes, the
 * resume arithmetic and both warm-up refusals — is asserted with no provider
 * key and no spawn of the tool.
 *
 * Two parameters are handed in by every test rather than defaulted, and both
 * for reasons that would otherwise show up as a write inside the repository:
 *
 *   - the RESULTS DIRECTORY. The driver's tracked default is bound at its entry
 *     point alone. A test that used it would plant a fabricated record among the
 *     published raw data, and a later add of that directory would sweep it in.
 *   - the NOTES SOURCE. The tracked fixture does not exist while this task runs
 *     — the next task produces it — and the seeder refuses a with-state home
 *     with no notes source by name. A test reaching for the tracked path would
 *     therefore be red until somebody hand-wrote a stub there, which is exactly
 *     the fabricated with-state fixture that refusal exists to prevent.
 *
 * The last test in the block is what makes both claims checkable rather than
 * stated: it asserts the two tracked directories are clean after the suite ran.
 */
describe('bench harness — the driver', () => {
  /**
   * A results directory that does NOT exist yet, and a notes source that does,
   * both under the system temp root and both removed in a `finally`.
   *
   * The results directory is deliberately left uncreated: one test asserts the
   * driver creates it, and a fixture that pre-created it would make that test
   * unable to fail.
   */
  async function withDriverFixtures<T>(
    fn: (fixtures: { scratch: string; resultsDir: string; notesSource: string; notesBody: string }) => Promise<T>,
  ): Promise<T> {
    const scratch = await mkdtemp(join(tmpdir(), 'warpline-bench-driver-'))
    try {
      const notesSource = join(scratch, 'notes-source.md')
      const notesBody = '# what an earlier session learned\n\nthe six inputs are flat, under inputs/\n'
      await writeFile(notesSource, notesBody)
      return await fn({ scratch, resultsDir: join(scratch, 'results'), notesSource, notesBody })
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  }

  /** One arm's outcome in the shape the driver consumes, without running an arm. */
  function armOutcome(overrides: Partial<ArmRunOutcome> = {}): ArmRunOutcome {
    return {
      tokens: { input: 10, output: 20, cache_creation: 30, cache_read: 40 },
      wall_clock_ms: 1_000,
      runtime_ms: null,
      consumer_ms: null,
      parked_handoffs: 2,
      subtype: 'success',
      model_id: PINNED_MODEL,
      grade: gradeOutcome(true),
      ...overrides,
    }
  }

  /**
   * Provenance without a spawn. The real reader runs `git` and the tool itself,
   * and the tool is not on a continuous-integration runner.
   */
  const stamp = (modelId: string): Provenance => ({
    git_sha: 'abcdef0',
    package_version: '0.0.0',
    claude_cli_version: '0.0.0 (test)',
    model_id: modelId,
  })

  /** Everything but the iteration index, which each caller varies. */
  function opts(resultsDir: string, notesSource: string, runner: ArmRunner) {
    return { runner, resultsDir, notesSource, provenance: stamp }
  }

  const passing: ArmRunner = async () => armOutcome()

  test('one iteration visits the three arms in the fixed order and records that index', async () => {
    await withDriverFixtures(async ({ resultsDir, notesSource }) => {
      const visited: string[] = []
      const runner: ArmRunner = async (arm) => {
        visited.push(arm)
        return armOutcome()
      }
      const records = await runIteration({ iteration: 1, ...opts(resultsDir, notesSource, runner) })

      expect(visited).toEqual([...ARM_ORDER])
      expect(records.map((r) => r.arm)).toEqual([...ARM_ORDER])
      // The order is in the DATA and not only in the prose, so an order effect
      // stays visible instead of being assumed away.
      expect(records.map((r) => r.arm_order_index)).toEqual([0, 1, 2])
    })
  })

  /**
   * Sequential is a requirement and not an optimisation choice: two arms
   * holding homes at once on one host puts sibling contention into the
   * wall-clock, which is the number being published. So the assertion is that
   * no two intervals OVERLAP, and not merely that three arms ran.
   */
  test('the three arms of one iteration are awaited one at a time', async () => {
    await withDriverFixtures(async ({ resultsDir, notesSource }) => {
      const intervals: { arm: string; entered: number; left: number }[] = []
      const runner: ArmRunner = async (arm) => {
        const entered = performance.now()
        await new Promise((settle) => setTimeout(settle, 15))
        intervals.push({ arm, entered, left: performance.now() })
        return armOutcome()
      }
      await runIteration({ iteration: 1, ...opts(resultsDir, notesSource, runner) })

      expect(intervals.map((i) => i.arm)).toEqual([...ARM_ORDER])
      for (let i = 1; i < intervals.length; i += 1) {
        expect((intervals[i] as { entered: number }).entered).toBeGreaterThanOrEqual(
          (intervals[i - 1] as { left: number }).left,
        )
      }
    })
  })

  test('each arm gets its own home: pairwise distinct absolute paths, every iteration', async () => {
    await withDriverFixtures(async ({ resultsDir, notesSource }) => {
      const homes: string[] = []
      const runner: ArmRunner = async (_arm, home) => {
        homes.push(home)
        return armOutcome()
      }
      await runIteration({ iteration: 1, ...opts(resultsDir, notesSource, runner) })
      await runIteration({ iteration: 2, ...opts(resultsDir, notesSource, runner) })

      expect(homes.length).toBe(6)
      // Relative is refused for the neighbouring reason a collision is: it
      // resolves against whatever the working directory happens to be.
      expect(homes.filter((home) => !isAbsolute(home))).toEqual([])
      expect(new Set(homes).size).toBe(6)
    })
  })

  /**
   * Seeding is PER ARM, and the split IS the arm definition. A control home
   * carrying the reference implementation is a control arm handed the answer,
   * and this is the same refusal that withholds the plugin-directory flag from
   * the controls, one layer down.
   *
   * Asserted from inside the runner, because the homes are gone after the call.
   */
  test('the warpline home alone carries the reference implementation', async () => {
    await withDriverFixtures(async ({ resultsDir, notesSource }) => {
      const seen = new Map<string, Record<string, boolean>>()
      let warplineSeam = ''
      let warplineGivenHome = ''
      const runner: ArmRunner = async (arm, home) => {
        seen.set(arm, {
          plugins: existsSync(join(home, 'plugins')),
          link: lstatSync(join(home, 'node_modules', 'warpline'), { throwIfNoEntry: false })?.isSymbolicLink() ?? false,
          config:
            existsSync(join(home, 'config', 'draft-writer.json')) &&
            existsSync(join(home, 'config', 'announce-fanout.json')),
          grant: existsSync(join(home, '.session-approval')),
        })
        if (arm === 'warpline') {
          // Through the PUBLISHED accessor, which is the seam the built copy of
          // the path resolver actually reads — the one comparison that turns
          // isolated from an assumption into a measurement.
          warplineSeam = warplineHome()
          warplineGivenHome = home
        }
        return armOutcome()
      }
      await runIteration({ iteration: 1, ...opts(resultsDir, notesSource, runner) })

      expect(warplineSeam).toBe(resolve(warplineGivenHome))
      expect(seen.get('warpline')).toEqual({ plugins: true, link: true, config: true, grant: true })
      for (const control of ['agent-with-state', 'agent-from-scratch'] as const) {
        expect(seen.get(control)).toEqual({ plugins: false, link: false, config: false, grant: false })
      }
    })
  })

  /**
   * The ONE predicate that separates the two control arms. Without it the pair
   * receives an identical prompt over an identical home, and the published
   * figures separate nothing — one thing measured twice, looking exactly like a
   * valid result.
   *
   * The bytes asserted are the bytes of the source the TEST handed the driver,
   * written under a temp directory, which is also what proves the notes source
   * is a parameter rather than a path the driver reaches for.
   */
  test('the with-state home alone holds a copy of the notes source it was handed', async () => {
    await withDriverFixtures(async ({ resultsDir, notesSource, notesBody }) => {
      const notes = new Map<string, string | null>()
      const runner: ArmRunner = async (arm, home) => {
        const at = join(home, NOTES_PATH)
        notes.set(arm, existsSync(at) ? readFileSync(at, 'utf8') : null)
        return armOutcome()
      }
      await runIteration({ iteration: 1, ...opts(resultsDir, notesSource, runner) })

      expect(notes.get('agent-with-state')).toBe(notesBody)
      expect(notes.get('agent-from-scratch')).toBe(null)
      expect(notes.get('warpline')).toBe(null)
    })
  })

  /**
   * Written per RUN and not per set: the measured set spans hours, and an abort
   * partway has to keep what it earned. The exact remaining count is the
   * assertion — a check that "some" files survived would pass over a driver
   * that wrote the whole set at the end and happened to have flushed one.
   */
  test('a throw mid-set leaves every record already written', async () => {
    await withDriverFixtures(async ({ resultsDir, notesSource }) => {
      const runner: ArmRunner = async (arm) => {
        if (arm === 'agent-with-state') throw new Error('the second arm fell over')
        return armOutcome()
      }
      await expect(runIteration({ iteration: 1, ...opts(resultsDir, notesSource, runner) })).rejects.toThrow(
        'the second arm fell over',
      )
      expect(readdirSync(resultsDir).sort()).toEqual(['warpline-001.json'])
    })
  })

  test('the first run of each arm is cold and every later run is warm', async () => {
    await withDriverFixtures(async ({ resultsDir, notesSource }) => {
      const first = await runIteration({ iteration: 1, ...opts(resultsDir, notesSource, passing) })
      const second = await runIteration({ iteration: 2, ...opts(resultsDir, notesSource, passing) })

      expect(first.map((r) => r.cold)).toEqual([true, true, true])
      expect(second.map((r) => r.cold)).toEqual([false, false, false])
    })
  })

  /**
   * Created at runtime, because a placeholder committed to make it exist IS a
   * commit adding a file under it — which freezes the pre-registration blob
   * before any real result exists and destroys the property the ordering guard
   * is built to deliver.
   */
  test('the results directory is created at runtime when absent', async () => {
    await withDriverFixtures(async ({ resultsDir, notesSource }) => {
      expect(existsSync(resultsDir)).toBe(false)
      // And the resume read tolerates the absence rather than throwing on it.
      expect((await resumeState(resultsDir)).nextIteration).toBe(1)

      await runIteration({ iteration: 1, ...opts(resultsDir, notesSource, passing) })
      expect(existsSync(resultsDir)).toBe(true)
    })
  })

  test('below the warm target the summary is a shortfall row and no median', async () => {
    await withDriverFixtures(async ({ resultsDir, notesSource }) => {
      await runIteration({ iteration: 1, ...opts(resultsDir, notesSource, passing) })
      await runIteration({ iteration: 2, ...opts(resultsDir, notesSource, passing) })

      // Read from the statistics module rather than restated here, which is
      // also what the driver does.
      expect(WARM_TARGET).toBe(SHORTFALL_N)
      const summary = await summariseSet(resultsDir)
      for (const arm of ARM_ORDER) {
        const row = summary[arm]
        expect('shortfall' in row).toBe(true)
        expect('median' in row).toBe(false)
        // One cold, one warm passing: the count is the WARM passing one.
        expect((row as { shortfall: { count: number; threshold: number } }).shortfall).toEqual({
          count: 1,
          threshold: SHORTFALL_N,
        })
      }
    })
  })

  /**
   * A provider outage says nothing about the arm, and there is no disposition
   * value meaning "not the arm's fault" — so it aborts the set rather than
   * entering one of the published rates.
   */
  test('an unattributable provider failure aborts the set and leaves the earned records', async () => {
    await withDriverFixtures(async ({ resultsDir, notesSource }) => {
      const runner: ArmRunner = async (arm) => {
        if (arm === 'agent-from-scratch') throw new ApiUnavailableError(arm, 'api_error')
        return armOutcome()
      }
      await expect(runSet(opts(resultsDir, notesSource, runner))).rejects.toBeInstanceOf(ApiUnavailableError)
      expect(readdirSync(resultsDir).sort()).toEqual(['agent-with-state-001.json', 'warpline-001.json'])
    })
  })

  /**
   * The one drift guard the method promises the DRIVER performs, and the only
   * one no fixture reached: every other driver test here hands `runSet` the
   * constant `stamp`, so the abort branch had never been observed red. This
   * project's recorded failure class is a guard that ran green while the thing
   * it catches sat outside its reach, so the stamp drifts on purpose.
   *
   * The tool auto-updates on its own schedule, which is what makes this
   * reachable without anybody doing anything: three records taken under one
   * version and the rest under the next is not one configuration, and a set
   * like that must stop rather than be published.
   */
  test('a tool version that drifts part-way through the set aborts it and names both versions', async () => {
    await withDriverFixtures(async ({ resultsDir, notesSource }) => {
      // One version for the first iteration's three arms, another after it.
      let stamped = 0
      const drifting = (modelId: string): Provenance => {
        stamped += 1
        return { ...stamp(modelId), claude_cli_version: stamped <= ARM_ORDER.length ? '0.0.0 (test)' : '0.0.1 (test)' }
      }

      await expect(runSet({ ...opts(resultsDir, notesSource, passing), provenance: drifting })).rejects.toThrow(
        /the command-line tool changed mid-set, from '0\.0\.0 \(test\)' to '0\.0\.1 \(test\)'/,
      )
      // Aborted, and the records it already earned are left where they are.
      expect(readdirSync(resultsDir).length).toBe(2 * ARM_ORDER.length)
    })
  })

  /**
   * The other half of the same promise, and the half a running process cannot
   * see: drift that sits ENTIRELY in the records already on disk.
   *
   * A measured set spans hours and is resumable, and the tool auto-updates on
   * its own schedule, so the realistic shape is a set interrupted under one
   * version and resumed under the next. The comparison the driver used to make
   * was record-versus-pin for records THIS process wrote, and the pin itself came
   * off the filename-sorted first record. Nothing ever compared the records on
   * disk against each other, so a set whose drift was already complete when the
   * driver started was summarised and published as one configuration.
   *
   * Watched accepting it before the fix: the fixture below is a finished set
   * carrying two tool versions, and runSet returned a summary over it.
   */
  test('records already on disk carrying two tool versions are refused before anything is summarised', async () => {
    await withDriverFixtures(async ({ resultsDir, notesSource }) => {
      await mkdir(resultsDir, { recursive: true })
      // A finished set: every arm at its warm target, so the driver breaks out
      // of the loop on the first pass and the refusal cannot be coming from a
      // record this process wrote.
      for (const [index, arm] of ARM_ORDER.entries()) {
        for (let iteration = 1; iteration <= WARM_TARGET; iteration += 1) {
          const record = sampleRecord({
            arm,
            arm_order_index: index,
            iteration,
            cold: false,
            // The drift sits on the LAST iteration of the last arm, which is
            // not the filename-sorted first record. A pin taken from that
            // record reads one version and the set carries two.
            claude_cli_version: index === ARM_ORDER.length - 1 && iteration === WARM_TARGET ? '2.1.270' : '2.1.269',
          })
          await writeFile(
            join(resultsDir, `${arm}-${String(iteration).padStart(3, '0')}.json`),
            `${JSON.stringify(record, null, 2)}\n`,
          )
        }
      }

      // Nothing may run: the refusal has to land before a session is paid for,
      // and before the set is summarised.
      const refuses: ArmRunner = async (arm) => {
        throw new Error(`the driver ran ${arm} over a set it should have refused`)
      }
      await expect(runSet(opts(resultsDir, notesSource, refuses))).rejects.toThrow(
        /records on disk carry 2 tool versions: \[2\.1\.269, 2\.1\.270\]/,
      )
      // Refused, and it kept every record. A driver that tidied up here would
      // destroy the evidence of the thing it just refused.
      expect(readdirSync(resultsDir).length).toBe(WARM_TARGET * ARM_ORDER.length)
    })
  })

  /**
   * The cap is what gives the shortfall row a trigger. A loop that ran until
   * every arm passed would spend without bound on an arm that never passes, and
   * the shortfall row the statistics module already implements would be
   * unreachable code.
   */
  test('a runner that never passes the grader stops at the iteration cap', async () => {
    await withDriverFixtures(async ({ resultsDir, notesSource }) => {
      const runner: ArmRunner = async () => armOutcome({ grade: gradeOutcome(false) })
      const summary = await runSet(opts(resultsDir, notesSource, runner))

      expect(readdirSync(resultsDir).length).toBe(MAX_ITERATIONS * ARM_ORDER.length)
      for (const arm of ARM_ORDER) {
        expect('shortfall' in summary[arm]).toBe(true)
        expect(summary[arm].warm_passing).toBe(0)
      }
    })
  }, 30_000)

  /**
   * Resumable, because a measured set is not a command that finishes inside one
   * foreground window. Without this, a relaunch after an interruption restarts
   * at the first iteration with every arm flagged cold and overwrites the
   * records it earned.
   */
  test('a driver started against existing records resumes rather than restarts', async () => {
    await withDriverFixtures(async ({ resultsDir, notesSource }) => {
      await runIteration({ iteration: 1, ...opts(resultsDir, notesSource, passing) })
      await runIteration({ iteration: 2, ...opts(resultsDir, notesSource, passing) })
      const earned = readdirSync(resultsDir).sort()

      const state = await resumeState(resultsDir)
      expect(state.nextIteration).toBe(3)
      for (const arm of ARM_ORDER) {
        expect(state.seen[arm]).toBe(true)
        // Warm passing only: the cold run is excluded from every warm figure.
        expect(state.passing[arm]).toBe(1)
      }

      const third = await runIteration({ iteration: state.nextIteration, ...opts(resultsDir, notesSource, passing) })
      // No arm with a prior record is flagged cold, ever again.
      expect(third.map((r) => r.cold)).toEqual([false, false, false])

      const after = readdirSync(resultsDir).sort()
      expect(after.length).toBe(9)
      for (const name of earned) expect(after).toContain(name)
      expect(new Set(after).size).toBe(9)

      // And an already-written record is never overwritten: re-running an
      // iteration that exists refuses rather than replacing what it earned.
      await expect(runIteration({ iteration: 1, ...opts(resultsDir, notesSource, passing) })).rejects.toThrow(/EEXIST/)
    })
  })

  /**
   * The post-return existence check IS the assertion. Homes are removed in a
   * `finally`, so a warm-up that reported the in-home path would hand the
   * operator a path that no longer exists by the time they read it, and the
   * copy-to-fixture step would have nothing to copy. That failure is silent —
   * it arrives as a missing file in a manual step.
   */
  test('warm-up mode runs the from-scratch arm once and reports a path that outlives the home', async () => {
    await withDriverFixtures(async ({ resultsDir }) => {
      const body = '# notes from the one unmeasured pass\n\nwhere each input actually was\n'
      const arms: string[] = []
      const runner: ArmRunner = async (arm, home) => {
        arms.push(arm)
        await writeFile(join(home, NOTES_PATH), body)
        return armOutcome()
      }
      const produced = await runWarmup({ runner, resultsDir })
      try {
        expect(arms).toEqual(['agent-from-scratch'])
        expect(existsSync(produced)).toBe(true)
        expect(readFileSync(produced, 'utf8')).toBe(body)
        expect(existsSync(resultsDir) ? readdirSync(resultsDir) : []).toEqual([])
      } finally {
        await rm(dirname(produced), { recursive: true, force: true })
      }
    })
  })

  /**
   * The worst outcome available, refused by name. A silent miss here commits
   * the fixture empty or not at all, the with-state arm is handed nothing, both
   * control arms then receive an identical prompt over an identical home, and
   * the whole published pair measures one thing twice while looking exactly
   * like a valid result.
   */
  test('warm-up mode refuses by name when the session produced no notes', async () => {
    await withDriverFixtures(async ({ resultsDir }) => {
      const runner: ArmRunner = async () => armOutcome()
      await expect(runWarmup({ runner, resultsDir })).rejects.toBeInstanceOf(NoNotesProducedError)
      expect(existsSync(resultsDir) ? readdirSync(resultsDir) : []).toEqual([])
    })
  })

  /**
   * The one assertion that makes every claim above checkable rather than
   * stated. The sibling guard in this suite only sees COMMITTED files under the
   * results directory; this one sees the untracked write a later add would
   * sweep into the published raw data, and the fixture half catches a
   * hand-written stub at the tracked notes path — the fabricated with-state
   * state the seeder's refusal is designed to make impossible.
   */
  test('no driver test wrote into the tracked results directory or at the tracked notes path', () => {
    const status = execFileSync('git', ['status', '--porcelain', '-uall', '--', 'bench/results', 'bench/fixtures'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
    expect(status.trim()).toBe('')
  })
})
