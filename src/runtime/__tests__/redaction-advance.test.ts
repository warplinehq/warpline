/**
 * A resolved credential value reaches none of the four files an ADVANCE writes.
 *
 * `invokePlugin` on its own has two sinks — the run artifact and `events.jsonl`
 * — and those are asserted next door in `secrets.test.ts`. Everything here is a
 * file only `runAdvance` produces: the engine's run log, `engine-state.json`'s
 * `plugin_runs[p].last_output` (an Output's inline body, straight into the
 * single state document), `engine-state.json`'s `pending_gates[].plugin_result`
 * (the WHOLE parked result, not a projection of it), and the daily JSONL run
 * log.
 *
 * Every case proves the canary REACHED the sink before asserting it is absent.
 * Absence on its own is green when the credential never resolved, when the
 * handler never ran, or when the parse boundary rejected the result and a
 * fabricated failure was persisted instead — three ways for a redaction guard to
 * pass over nothing at all.
 *
 * The environment variable is set and removed around each case. Bun runs a
 * file's tests in one process and CI shards by directory, so a leaked key is
 * visible to every sibling file in the same shard.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { grantApproval } from '../approval-gate.js'
import { createTestHome, type TestHome } from './helpers/create-test-home.js'

/** A value no other string in this suite contains. */
const CANARY = 'WL-CANARY-4e18b7fa9d30'

/** The declared name the fixtures resolve. */
const KEY = 'WARPLINE_TEST_CANARY_ADVANCE'

let ctx: TestHome
let statePath: string
let eventsPath: string
let logsDir: string

/** Run `fn` with `KEY` set to the canary, and remove it afterwards. */
async function withCanary(fn: () => Promise<void>): Promise<void> {
  const had = Object.prototype.hasOwnProperty.call(process.env, KEY)
  const previous = process.env[KEY]
  process.env[KEY] = CANARY
  try {
    await fn()
  } finally {
    if (had) process.env[KEY] = previous
    else delete process.env[KEY]
  }
}

/**
 * A fixture that puts the resolved credential into every free-text carrier a
 * `SkillResult` has: the summary, the undo instruction, an Output's inline body,
 * and the structured `[needs-llm]` field's inner `task` string.
 *
 * `context_path` is an in-home RELATIVE path with no parent-directory segment.
 * The schema refuses anything else, and a refusal drops the whole result into
 * the fabricated `failed` fallback — which carries no canary, so the absence
 * assertions would pass over a result that never held one.
 */
async function writeLeakyPlugin(
  name: string,
  opts: { supervised?: boolean } = {},
): Promise<void> {
  const dir = join(ctx.pluginsDir, name)
  await mkdir(dir, { recursive: true })
  const manifest = {
    name,
    version: '1.0.0',
    description: 'advance redaction fixture',
    inputs: {},
    outputs: {},
    capabilities: [],
    secrets: [KEY],
    schedule: 'on_run',
    autonomy_level: opts.supervised ? 'supervised' : 'autonomous',
    side_effects: opts.supervised ? ['sends_email'] : [],
    ttl_hours: 24,
    dependencies: [],
    timeout_ms: 5000,
    max_parallelism: 1,
    min_tier: 'normal',
    max_retries: 1,
    retry_delay_ms: 1,
  }
  await writeFile(join(dir, 'manifest.ts'), `export const manifest = ${JSON.stringify(manifest)}`)
  await writeFile(
    join(dir, 'handler.ts'),
    `export async function handler() {
      const value = process.env[${JSON.stringify(KEY)}] ?? ''
      return {
        status: 'success',
        phases_completed: ['${name}'],
        phases_failed: [],
        errors: [],
        data_freshness: {},
        summary: '${name} authenticated with ' + value,
        reversible: true,
        undo_instruction: 'revoke the token ' + value,
        artifacts_produced: [{ type: 'report', format: 'markdown', body: 'the token was ' + value }],
        schema_version: 1,
        needs_llm: { task: 'Triage the account behind ' + value, context_path: 'state/entries.json' },
      }
    }`,
  )
}

beforeEach(async () => {
  ctx = await createTestHome()
  statePath = join(ctx.stateDir, 'engine-state.json')
  eventsPath = join(ctx.stateDir, 'events.jsonl')
  logsDir = join(ctx.root, 'logs')
})

afterEach(async () => {
  await ctx.cleanup()
})

/** Today's daily JSONL file, at the literal path the logger must use. */
function jsonlPath(): string {
  return join(logsDir, 'runs', `${new Date().toISOString().slice(0, 10)}.jsonl`)
}

describe('a resolved credential reaches no file an advance writes', () => {
  test("the engine's run log carries no resolved credential value", async () => {
    const { runAdvance } = await import('../engine.js')
    await writeLeakyPlugin('leak-runlog')

    await withCanary(async () => {
      const res = await runAdvance({
        pluginsDir: ctx.pluginsDir,
        stateDir: statePath,
        runsDir: ctx.runsDir,
        eventsPath,
        logsDir,
      })

      // Presence: the handler ran, and both free-text fields reached the log.
      const raw = await readFile(res.run_log_path, 'utf-8')
      const log = JSON.parse(raw)
      const entry = log.plugin_entries.find((e: { plugin: string }) => e.plugin === 'leak-runlog')
      expect(entry).toBeDefined()
      expect(entry.status).toBe('completed')
      expect(typeof entry.result_summary).toBe('string')
      expect(entry.result_summary.length).toBeGreaterThan(0)
      expect(typeof entry.undo_instruction).toBe('string')
      expect(entry.undo_instruction.length).toBeGreaterThan(0)

      // Absence.
      expect(raw).not.toContain(CANARY)
    })
  })

  test("engine-state.json's plugin_runs last_output body carries no resolved credential value", async () => {
    const { runAdvance } = await import('../engine.js')
    await writeLeakyPlugin('leak-state')

    await withCanary(async () => {
      await runAdvance({
        pluginsDir: ctx.pluginsDir,
        stateDir: statePath,
        runsDir: ctx.runsDir,
        eventsPath,
        logsDir,
      })

      // Presence: the inline body reached the single state document.
      const raw = await readFile(statePath, 'utf-8')
      const state = JSON.parse(raw)
      expect(state.plugin_runs['leak-state']).toBeDefined()
      expect(typeof state.plugin_runs['leak-state'].last_output?.body).toBe('string')
      expect(state.plugin_runs['leak-state'].last_output.body.length).toBeGreaterThan(0)

      // Absence.
      expect(raw).not.toContain(CANARY)
    })
  })

  test('the daily JSONL run log carries no resolved credential value', async () => {
    const { runAdvance } = await import('../engine.js')
    await writeLeakyPlugin('leak-jsonl')

    await withCanary(async () => {
      await runAdvance({
        pluginsDir: ctx.pluginsDir,
        stateDir: statePath,
        runsDir: ctx.runsDir,
        eventsPath,
        logsDir,
      })

      // Presence: the file is where it must be, and a plugin line carries text.
      const raw = await readFile(jsonlPath(), 'utf-8')
      const lines = raw.trim().split('\n').map((l) => JSON.parse(l))
      const result = lines.find((l) => l.event === 'plugin_result' && l.plugin === 'leak-jsonl')
      expect(result).toBeDefined()
      expect(typeof result.detail).toBe('string')
      expect(result.detail.length).toBeGreaterThan(0)

      // The third format is NOT in the run-artifact directory. `JsonlRunLogger`
      // appends its own `runs/` segment, so a home-root logs directory would put
      // the daily file exactly where `pruneRunLogs` and `trimPluginHistory` scan.
      const artifacts = await readdir(ctx.runsDir)
      expect(artifacts.filter((f) => f.endsWith('.jsonl'))).toHaveLength(0)

      // Absence.
      expect(raw).not.toContain(CANARY)
    })
  })

  test("engine-state.json's pending_gates plugin_result carries no resolved credential value", async () => {
    const { runAdvance } = await import('../engine.js')
    await writeLeakyPlugin('leak-gate', { supervised: true })

    // A live Grant, so the approval gate passes and the SUPERVISION gate is the
    // one that stops the plugin. Without it the run is refused for unapproved
    // side effects — an arm that returns before `invokePlugin` — so the handler
    // never runs, nothing is parked, and the absence assertion passes vacuously.
    const approvalPath = join(ctx.root, '.session-approval-redaction')
    await grantApproval('leak-gate', 4 * 60 * 60 * 1000, approvalPath)

    await withCanary(async () => {
      const res = await runAdvance({
        pluginsDir: ctx.pluginsDir,
        stateDir: statePath,
        runsDir: ctx.runsDir,
        eventsPath,
        approvalPath,
        logsDir,
      })
      expect(res.gated_plugins).toContain('leak-gate')

      // Presence: the WHOLE result was parked, structured handoff field and all.
      const raw = await readFile(statePath, 'utf-8')
      const state = JSON.parse(raw)
      expect(state.pending_gates.length).toBeGreaterThanOrEqual(1)
      const parked = state.pending_gates[0].plugin_result
      expect(typeof parked.summary).toBe('string')
      expect(typeof parked.undo_instruction).toBe('string')
      expect(typeof parked.artifacts_produced?.[0]?.body).toBe('string')
      expect(typeof parked.needs_llm?.task).toBe('string')
      expect(parked.needs_llm.task.length).toBeGreaterThan(0)

      // Absence, over the whole document — summary, undo instruction, inline
      // body and the structured `[needs-llm]` task at once.
      expect(raw).not.toContain(CANARY)
    })
  })

  test('a refused advance writes no JSONL run log', async () => {
    const { runAdvance } = await import('../engine.js')

    // An absent plugin root is refused above every write. The logs directory is
    // passed EXPLICITLY under the test root: `engine.test.ts`'s byte-identical
    // home assertion snapshots `createTestHome()`'s root, while a defaulted
    // logs directory resolves under the preload's own separate `WARPLINE_HOME`
    // — a run-start line appended before the refusal would land outside that
    // snapshot's reach and it would stay green while the invariant broke.
    await expect(
      runAdvance({
        pluginsDir: join(ctx.root, 'no-such-plugin-root'),
        stateDir: statePath,
        runsDir: ctx.runsDir,
        eventsPath,
        logsDir,
      }),
    ).rejects.toThrow(/cannot read plugin root/)

    expect(existsSync(logsDir)).toBe(false)
  })
})
