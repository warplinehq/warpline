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
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { loadPluginManifests } from 'warpline/unstable-runtime'
import { runWarplineArm } from '../../bench/arms.js'
import { gradeHome } from '../../bench/grade.js'
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
