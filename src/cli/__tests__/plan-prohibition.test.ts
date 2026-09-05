/**
 * `warpline plan` — the two prohibitions, proven rather than asserted.
 *
 *   1. **`plan` writes nothing.** Not to state, not to the runs
 *      directory, not to the approval file, not to `events.jsonl`. Event
 *      emission counts as a write, so nothing is excluded from the walk: the
 *      snapshot covers the WHOLE warpline home, and a "harmless" append to the
 *      event log fails this test exactly as loudly as a state rewrite.
 *
 *   2. **`plan` invokes no handler.** A preview that silently ran
 *      handlers would defeat the approval gate outright: the gate's whole
 *      premise is that nothing with a side effect happens until an operator
 *      says so, and "I was only looking" is not a defence.
 *
 * The snapshot compares (relative path, byte length, sha256, mtimeMs) — not a
 * file count and not a name list. A count catches creation and deletion but not
 * an in-place rewrite, and an equal-length rewrite (a timestamp field, a status
 * flip) is precisely the write shape a read-only claim gets wrong. mtime is in
 * there too, so a byte-identical rewrite still fails.
 *
 * The corrupt-state fixture in Test 2 is a REGRESSION GUARD, not a curiosity:
 * before plan 02-05 added `readEngineStateReadOnly` + `withoutStateBackups`, a
 * corrupt `engine-state.json` made every plugin read as never-run, so the guard
 * chain always reached `checkTaskLock`, whose read wrote a `.corrupt` backup.
 * The command whose entire claim is "writes nothing" wrote a file. Keep it.
 *
 * The two sentinel fixtures live in SEPARATE plugin directories and must never
 * be merged, nor swept into the snapshot homes above:
 *
 *   - the handler sentinel must NOT appear (prohibition 2), and
 *   - the manifest sentinel MUST appear (accepted and documented) —
 *
 * so one fixture in one home would falsify the other. The manifest-sentinel
 * fixture also deliberately violates the declarative-manifest rule that plan
 * 02-09 lints; that is another reason it is quarantined in its own directory.
 */
import { describe, test, expect, beforeEach, afterEach, afterAll } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestHome } from '../../runtime/__tests__/helpers/create-test-home.js'
import type { TestHome } from '../../runtime/__tests__/helpers/create-test-home.js'
// The whole-home walk is shared: this file, `approve.test.ts` and the engine's
// refusal cases all assert against the same bytes, with the same absence of an
// exclusion list.
import { snapshotHome } from '../../runtime/__tests__/helpers/snapshot-home.js'
import { _setHome } from '../../lib/paths.js'
import { _getPaths, _setPaths } from '../../board/state-manager.js'
import { invokePlugin } from '../../runtime/invoke-plugin.js'
import { run } from '../plan.js'

const REAL_PATHS = _getPaths()

async function capture(fn: () => Promise<number>): Promise<number> {
  const realOut = process.stdout.write
  const realErr = process.stderr.write
  process.stdout.write = (() => true) as typeof process.stdout.write
  process.stderr.write = (() => true) as typeof process.stderr.write
  try {
    return await fn()
  } finally {
    process.stdout.write = realOut
    process.stderr.write = realErr
  }
}

// ── Fixtures ──

async function writePlugin(
  home: TestHome,
  name: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const manifest = {
    name,
    version: '1.0.0',
    description: `fixture ${name}`,
    inputs: {},
    outputs: {},
    capabilities: [],
    schedule: 'on_run',
    autonomy_level: 'autonomous',
    side_effects: [],
    ttl_hours: 24,
    dependencies: [],
    timeout_ms: 5000,
    max_retries: 1,
    retry_delay_ms: 2000,
    max_parallelism: 1,
    min_tier: 'normal',
    ...overrides,
  }
  const dir = join(home.pluginsDir, name)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'manifest.ts'),
    `export const manifest = ${JSON.stringify(manifest, null, 2)}\n`,
  )
}

async function writeState(home: TestHome, pluginRuns: Record<string, unknown>): Promise<void> {
  await writeFile(
    join(home.stateDir, 'engine-state.json'),
    JSON.stringify({
      schema_version: 1,
      last_run_id: null,
      last_run_at: null,
      last_interaction_at: null,
      plugin_runs: pluginRuns,
      deferrals: [],
      task_aging: [],
      completed_tasks: [],
      pending_gates: [],
      extensions: {},
    }),
  )
}

/**
 * A home with something to lose: state, a prior event log, one due plugin and
 * one fresh one. An empty home would satisfy any snapshot comparison, which is
 * why every test below also asserts the snapshot is non-trivial.
 */
async function populate(home: TestHome): Promise<void> {
  await writePlugin(home, 'due-one')
  await writePlugin(home, 'fresh-one')
  await writeState(home, {
    'fresh-one': { last_run_at: new Date(Date.now() - 3_600_000).toISOString(), status: 'success' },
  })
  await writeFile(
    join(home.stateDir, 'events.jsonl'),
    `${JSON.stringify({ ts: new Date(Date.now() - 60_000).toISOString(), severity: 'notice', kind: 'seed', summary: 'pre-existing event' })}\n`,
  )
}

let home: TestHome
/** Sentinels live outside the warpline home so a sentinel write can never be mistaken for a home write. */
let sentinelDir: string

beforeEach(async () => {
  home = await createTestHome()
  _setHome(home.root)
  sentinelDir = await mkdtemp(join(tmpdir(), 'warpline-sentinel-'))
})

afterEach(async () => {
  _setHome(null)
  await home.cleanup()
  await rm(sentinelDir, { recursive: true, force: true })
})

afterAll(() => {
  _setPaths(REAL_PATHS)
})

describe('plan writes nothing under the warpline home', () => {
  test('Test 1: a normal home is byte-identical, mtime-identical and file-set-identical after plan', async () => {
    await populate(home)

    const before = await snapshotHome(home.root)
    const code = await capture(() => run([]))
    const after = await snapshotHome(home.root)

    expect(code).toBe(0)
    // Not a vacuous comparison: there is real state here to have damaged.
    expect(before.length).toBeGreaterThan(4)
    expect(after).toEqual(before)
  })

  test('Test 2: a corrupt engine-state.json produces no .corrupt backup and moves no mtime', async () => {
    await populate(home)
    // Overwritten AFTER populate so the file exists, is read, and fails
    // validation — the exact shape that used to trigger the backup write.
    await writeFile(join(home.stateDir, 'engine-state.json'), '{ this is not json')

    const before = await snapshotHome(home.root)
    const code = await capture(() => run([]))
    const after = await snapshotHome(home.root)

    expect(code).toBe(0)
    expect(after).toEqual(before)
    // Named explicitly as well as covered by the snapshot: this is the specific
    // regression (02-05 Deviation 3) and it deserves to fail by name.
    expect(after.filter((entry) => entry.includes('.corrupt'))).toEqual([])
  })

  test('Test 3: a live session grant is read without being touched', async () => {
    await populate(home)
    await writePlugin(home, 'gated-one', { side_effects: ['sends_email'] })
    await writeFile(
      join(home.root, '.session-approval'),
      JSON.stringify({
        granted_at: new Date(Date.now() - 60_000).toISOString(),
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        scopes: ['gated-one'],
      }),
    )

    const before = await snapshotHome(home.root)
    const code = await capture(() => run([]))
    const after = await snapshotHome(home.root)

    expect(code).toBe(0)
    expect(before.some((entry) => entry.startsWith('.session-approval|'))).toBe(true)
    expect(after).toEqual(before)
  })
})

describe('plan invokes no plugin handler', () => {
  test('Test 4: the handler sentinel is absent after plan, and present after a real invocation', async () => {
    const sentinel = join(sentinelDir, 'handler-ran')
    // Declarative manifest, side-effect-free and never run, so this plugin is
    // exactly what `plan` reports as DUE — the one whose handler must not run.
    await writePlugin(home, 'sentinel-handler')
    await writeFile(
      join(home.pluginsDir, 'sentinel-handler', 'handler.ts'),
      `import { writeFileSync } from 'node:fs'
export async function handler(_manifest, _args) {
  writeFileSync(${JSON.stringify(sentinel)}, 'the handler ran')
  return {
    status: 'success',
    phases_completed: [],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: 'sentinel handler ran',
    artifacts_produced: [],
    schema_version: 1,
  }
}
`,
    )

    const code = await capture(() => run([]))
    expect(code).toBe(0)
    expect(existsSync(sentinel)).toBe(false)

    // The positive control. A fixture that cannot fail proves nothing: without
    // this half, a typo in the sentinel path would read as a passing test.
    const { result } = await invokePlugin('sentinel-handler', {}, { pluginsDir: home.pluginsDir }, { granted: false, reason: 'manual-run' })
    expect(result.status).toBe('success')
    expect(existsSync(sentinel)).toBe(true)
  })

  test('Test 5: a manifest with top-level code DOES run — importing a manifest executes it', async () => {
    const sentinel = join(sentinelDir, 'manifest-ran')
    const dir = join(home.pluginsDir, 'sentinel-manifest')
    await mkdir(dir, { recursive: true })
    // Deliberately NOT declarative. This is the accepted consequence of reading
    // a manifest by importing it, pinned here so it is a known contract rather
    // than a surprise; plan 02-09 documents it in docs/plugin-authoring.md and
    // lints shipped manifests for declarativeness. Quarantined in its own
    // directory: it must never reach a snapshot fixture above.
    await writeFile(
      join(dir, 'manifest.ts'),
      `import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(sentinel)}, 'the manifest module executed')
export const manifest = {
  name: 'sentinel-manifest',
  version: '1.0.0',
  description: 'a manifest with top-level side effects',
  inputs: {},
  outputs: {},
  capabilities: [],
  schedule: 'on_run',
  autonomy_level: 'autonomous',
  side_effects: [],
  ttl_hours: 24,
  dependencies: [],
  timeout_ms: 5000,
  max_retries: 1,
  retry_delay_ms: 2000,
  max_parallelism: 1,
  min_tier: 'normal',
}
`,
    )

    expect(existsSync(sentinel)).toBe(false)

    // One run only. Bun caches modules by resolved path, so the top-level body
    // executes on the FIRST import and never again in this process — deleting
    // the sentinel and re-running would assert a false expectation.
    const code = await capture(() => run([]))

    expect(code).toBe(0)
    expect(existsSync(sentinel)).toBe(true)
    expect(await readFile(sentinel, 'utf-8')).toBe('the manifest module executed')
  })
})
