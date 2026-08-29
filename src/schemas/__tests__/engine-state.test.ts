/**
 * Engine-state read policy.
 *
 * The one thing this file exists to pin: `readEngineState` is the WRITE-CAPABLE
 * read, and a state document it cannot validate must stop the caller rather
 * than hand back defaults the next write would persist over the operator's
 * `task_aging`, `deferrals` and `completed_tasks`.
 *
 * Two failure branches, not one. The rest of the suite writes
 * `'{ this is not json'` in both places it fakes a corrupt state, which only
 * ever exercises the `JSON.parse` throw. The `safeParse` branch — valid JSON,
 * wrong shape — had no coverage anywhere before this file, so every fixture
 * below that parses as JSON is load-bearing rather than a second copy of the
 * one above it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DenialSchema,
  ENGINE_STATE_MAX_SCHEMA_VERSION,
  EngineStateInvalidError,
  PendingGateSchema,
  PluginRunSchema,
  TaskAgingSchema,
  defaultEngineState,
  isStubGate,
  readEngineState,
  readEngineStateReadOnly,
  writeEngineState,
} from '../engine-state.js'

/** Valid JSON, wrong shape — the `safeParse` branch. */
const SCHEMA_INVALID = '{"schema_version": 1, "plugin_runs": "not-a-record"}'
/** Not JSON at all — the `JSON.parse` branch. */
const MALFORMED = '{ this is not json'
/** Written by a build newer than this one. */
const VERSION_AHEAD = `{"schema_version": ${ENGINE_STATE_MAX_SCHEMA_VERSION + 1}}`
/** Neither an older version nor a newer one — not a version. */
const VERSION_FRACTIONAL = '{"schema_version": 1.5}'
const VERSION_NEGATIVE = '{"schema_version": -1}'
/** The substring that distinguishes "your build is behind" from "this is broken". */
const AHEAD_MARKER = 'older than this file'

describe('engine state read policy', () => {
  let stateDir: string
  let statePath: string

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'warpline-engine-state-'))
    statePath = join(stateDir, 'engine-state.json')
  })

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true })
  })

  /** Write a fixture and return its exact bytes, for the after-comparison. */
  async function fixture(content: string): Promise<string> {
    await writeFile(statePath, content, 'utf-8')
    return content
  }

  /** Assert the write-capable read refused, and hand back the error to inspect. */
  async function refusal(): Promise<EngineStateInvalidError> {
    try {
      await readEngineState(statePath)
    } catch (err) {
      if (err instanceof EngineStateInvalidError) return err
      throw err
    }
    throw new Error('expected readEngineState to refuse — it returned a state object')
  }

  async function siblings(): Promise<string[]> {
    return (await readdir(stateDir)).filter((f) => f !== 'engine-state.json')
  }

  // ── The write-capable read fails closed ────────────────────────────────

  it('loads a valid current-shape file unchanged', async () => {
    await fixture(
      JSON.stringify({
        schema_version: 1,
        plugin_runs: { alpha: { last_run_at: '2026-08-01T00:00:00Z', status: 'success' } },
      }),
    )

    const state = await readEngineState(statePath)
    expect(state.schema_version).toBe(1)
    expect(state.plugin_runs.alpha?.status).toBe('success')
    expect(state.task_aging).toEqual([])
  })

  it('refuses valid JSON that fails schema validation, naming the path and a reason', async () => {
    const before = await fixture(SCHEMA_INVALID)

    const err = await refusal()
    expect(err.name).toBe('EngineStateInvalidError')
    expect(err.path).toBe(statePath)
    expect(err.reason.length).toBeGreaterThan(0)
    expect(err.message).toContain(statePath)
    expect(err.message).toContain(err.reason)
    // Not the version refusal — a different failure must read differently.
    expect(err.message).not.toContain(AHEAD_MARKER)

    expect(await readFile(statePath, 'utf-8')).toBe(before)
    expect(await siblings()).toEqual([])
  })

  it('refuses malformed JSON the same way, leaving the file byte-identical', async () => {
    const before = await fixture(MALFORMED)

    const err = await refusal()
    expect(err.path).toBe(statePath)
    expect(err.message).toContain(statePath)
    expect(err.reason.length).toBeGreaterThan(0)

    expect(await readFile(statePath, 'utf-8')).toBe(before)
    expect(await siblings()).toEqual([])
  })

  it('returns defaults for a nonexistent file rather than refusing', async () => {
    const state = await readEngineState(join(stateDir, 'nope.json'))
    expect(state).toEqual(defaultEngineState())
  })

  // ── schema_version is read tolerantly, with one gate ───────────────────

  it('loads a file at the newest schema_version it knows', async () => {
    await fixture(`{"schema_version": ${ENGINE_STATE_MAX_SCHEMA_VERSION}}`)

    const state = await readEngineState(statePath)
    expect(state.schema_version).toBe(ENGINE_STATE_MAX_SCHEMA_VERSION)
  })

  it('refuses a schema_version above the newest known, and says the build is behind', async () => {
    const before = await fixture(VERSION_AHEAD)

    const err = await refusal()
    expect(err.message).toContain(AHEAD_MARKER)
    expect(err.message).toContain(statePath)

    expect(await readFile(statePath, 'utf-8')).toBe(before)
    expect(await siblings()).toEqual([])
  })

  it('refuses a fractional schema_version as unreadable, not as an older version', async () => {
    await fixture(VERSION_FRACTIONAL)

    const err = await refusal()
    expect(err.message).not.toContain(AHEAD_MARKER)
  })

  it('refuses a negative schema_version as unreadable, not as an older version', async () => {
    await fixture(VERSION_NEGATIVE)

    const err = await refusal()
    expect(err.message).not.toContain(AHEAD_MARKER)
  })

  // ── Unknown top-level keys survive a round trip ────────────────────────

  it('round-trips an unknown top-level key through read and write', async () => {
    await fixture(
      JSON.stringify({
        schema_version: 1,
        host_annotations: { source: 'a-newer-build', ids: ['x', 'y'] },
      }),
    )

    const state = await readEngineState(statePath)
    await writeEngineState(state, statePath)

    const raw = JSON.parse(await readFile(statePath, 'utf-8'))
    expect(raw.host_annotations).toEqual({ source: 'a-newer-build', ids: ['x', 'y'] })
  })

  // ── The read-only read stays tolerant ──────────────────────────────────

  it('returns defaults from the read-only read for every fixture the write-capable read refuses', async () => {
    for (const content of [
      SCHEMA_INVALID,
      MALFORMED,
      VERSION_AHEAD,
      VERSION_FRACTIONAL,
      VERSION_NEGATIVE,
    ]) {
      const before = await fixture(content)

      const state = await readEngineStateReadOnly(statePath)
      expect(state).toEqual(defaultEngineState())

      expect(await readFile(statePath, 'utf-8')).toBe(before)
      expect(await siblings()).toEqual([])
    }
  })

  it('returns defaults from the read-only read for a nonexistent file', async () => {
    const state = await readEngineStateReadOnly(join(stateDir, 'nope.json'))
    expect(state).toEqual(defaultEngineState())
  })

  // ── The write path is unchanged and still atomic ───────────────────────

  it('leaves no .tmp sibling behind after a write', async () => {
    await mkdir(stateDir, { recursive: true })
    await writeEngineState(defaultEngineState(), statePath)
    expect(await siblings()).toEqual([])
  })
})

describe('PluginRunSchema.status', () => {
  const base = { last_run_at: '2026-08-01T00:00:00Z', duration_ms: 12 }

  /**
   * A parked supervised plugin records a run. Before it did, the supervised
   * branch returned before the only `plugin_runs` write, so a side-effecting
   * plugin with a live Grant was due again on the very next advance and
   * re-fired its effects for the whole grant window on one human "yes".
   */
  it('accepts the gated member', () => {
    const result = PluginRunSchema.safeParse({ ...base, status: 'gated' })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.status).toBe('gated')
  })

  it('still accepts the four members that were already there', () => {
    for (const status of ['success', 'partial', 'failed', 'skipped']) {
      expect(PluginRunSchema.safeParse({ ...base, status }).success).toBe(true)
    }
  })

  it('is still a closed enum', () => {
    expect(PluginRunSchema.safeParse({ ...base, status: 'approved' }).success).toBe(false)
  })
})

// ── The per-plugin last Output pointer (R7) ──────────────────────────────

describe('PluginRunSchema.last_output', () => {
  let stateDir: string
  let statePath: string

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'warpline-last-output-'))
    statePath = join(stateDir, 'engine-state.json')
  })

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true })
  })

  const base = { last_run_at: '2026-08-01T00:00:00Z', status: 'success' as const }
  const output = {
    type: 'brief',
    format: 'markdown' as const,
    run_id: '20260801T000000-abcd1234',
    produced_at: '2026-08-01T00:00:00Z',
    path: 'brief.md',
  }

  it('parses a run carrying a last_output', () => {
    const result = PluginRunSchema.safeParse({ ...base, last_output: output })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.last_output).toEqual(output)
  })

  it('reuses the Output record shape rather than defining a second one', () => {
    // Both-present is invalid for an Output, so it must be invalid here too.
    const result = PluginRunSchema.safeParse({
      ...base,
      last_output: { type: 'brief', body: 'x', path: 'y.md' },
    })
    expect(result.success).toBe(false)
  })

  it('round-trips the pointer through writeEngineState', async () => {
    const state = defaultEngineState()
    state.plugin_runs['brief-writer'] = { ...base, last_output: output }
    await writeEngineState(state, statePath)

    const reread = await readEngineState(statePath)
    expect(reread.plugin_runs['brief-writer']?.last_output).toEqual(output)
  })

  // Asserted on the RAW re-read JSON, not on the parsed object: absent and
  // `null` and `{}` all read the same after parsing, and the whole point of
  // `.optional()` over `.nullable()` is which one lands on disk.
  it('omits the key entirely for a run that produced no Output', async () => {
    const state = defaultEngineState()
    state.plugin_runs['quiet-plugin'] = { ...base }
    await writeEngineState(state, statePath)

    const raw = JSON.parse(await readFile(statePath, 'utf-8'))
    expect(raw.plugin_runs['quiet-plugin']).toBeDefined()
    expect('last_output' in raw.plugin_runs['quiet-plugin']).toBe(false)
  })
})

/**
 * Run linkage on task aging (R4). The fields live here rather than in
 * `board.ts` because `TaskAgingSchema` does: `TaskDisplaySchema` extends it and
 * `EngineStateSchema.task_aging` holds it.
 */
describe('TaskAgingSchema run linkage', () => {
  const baseTask = {
    task_id: 'task-001',
    first_flagged: '2026-08-01T10:00:00Z',
    description: 'Renewal certificate expires in 12 days',
    severity: 'warning' as const,
  }

  it('reads null for both run ids on a task written before run linkage', () => {
    const result = TaskAgingSchema.parse(baseTask)
    expect(result.first_run_id).toBeNull()
    expect(result.last_flagged_run_id).toBeNull()
  })

  it('carries the run that first raised the task and the run that last re-flagged it', () => {
    const result = TaskAgingSchema.parse({
      ...baseTask,
      first_run_id: 'run-a',
      last_flagged_run_id: 'run-c',
    })
    expect(result.first_run_id).toBe('run-a')
    expect(result.last_flagged_run_id).toBe('run-c')
  })

  /**
   * A run that raises a task and re-flags it in the same advance writes the
   * same id twice. That is the ordinary first-advance case, not a corruption
   * to reject — the two fields answer different questions that happen to have
   * one answer here.
   */
  it('accepts the same run id in both fields — a run that raised and re-flagged in one advance', () => {
    const result = TaskAgingSchema.parse({
      ...baseTask,
      first_run_id: 'run-a',
      last_flagged_run_id: 'run-a',
    })
    expect(result.first_run_id).toBe(result.last_flagged_run_id)
    expect(result.first_run_id).toBe('run-a')
  })

  it('survives a read-then-write round trip through engine state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'warpline-aging-'))
    const statePath = join(dir, 'engine-state.json')
    try {
      const state = defaultEngineState()
      state.task_aging.push(
        TaskAgingSchema.parse({ ...baseTask, first_run_id: 'run-a', last_flagged_run_id: 'run-b' }),
      )
      await writeEngineState(state, statePath)
      const reread = await readEngineState(statePath)
      expect(reread.task_aging[0]?.first_run_id).toBe('run-a')
      expect(reread.task_aging[0]?.last_flagged_run_id).toBe('run-b')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

/**
 * `PendingGateSchema` — the parked result, and telling a real one from a stub.
 *
 * A parked gate used to be a fabrication: `status: 'partial'`, an empty
 * `artifacts_produced`, and no record of when the gated run started or ended.
 * The real result the plugin returned was dropped on the floor. R8 needs the
 * real thing — the approve verb anchors `plugin_runs.last_run_at` at the gated
 * run's completion, refuses when a dependency moved since its start, and plan
 * 05 hashes the Outputs — so the two clock fields and the real result are the
 * whole point of these cases.
 *
 * The two clocks are also the stub discriminator, which is why the round-trip
 * case below is load-bearing rather than a formality: it proves the recogniser
 * does not misfire on a gate this build wrote.
 */
describe('PendingGateSchema', () => {
  const realResult = {
    status: 'success' as const,
    phases_completed: ['render'],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: 'rendered the weekly brief',
    artifacts_produced: [
      { type: 'brief', format: 'markdown' as const, path: 'brief.md', run_id: 'run-a', produced_at: '2026-08-29T10:00:00.000Z' },
    ],
    schema_version: 2,
  }

  const realGate = {
    plugin: 'brief-writer',
    run_id: 'run-a',
    created_at: '2026-08-29T10:00:01.000Z',
    payload_summary: 'rendered the weekly brief',
    plugin_result: realResult,
    run_started_at: '2026-08-29T09:59:58.000Z',
    run_completed_at: '2026-08-29T10:00:00.000Z',
  }

  /** Exactly what `engine.ts` fabricated before this plan: no clocks, no Outputs. */
  const stubGate = {
    plugin: 'brief-writer',
    run_id: 'run-a',
    created_at: '2026-08-29T10:00:01.000Z',
    payload_summary: 'rendered the weekly brief',
    plugin_result: {
      status: 'partial' as const,
      phases_completed: [],
      phases_failed: [],
      errors: [],
      data_freshness: {},
      summary: 'rendered the weekly brief',
      artifacts_produced: [],
      schema_version: 1,
    },
  }

  it('parses a gate carrying the real result and both clock fields', () => {
    const parsed = PendingGateSchema.parse(realGate)
    expect(parsed.run_started_at).toBe('2026-08-29T09:59:58.000Z')
    expect(parsed.run_completed_at).toBe('2026-08-29T10:00:00.000Z')
    expect(parsed.plugin_result.status).toBe('success')
    expect(parsed.plugin_result.artifacts_produced[0]?.path).toBe('brief.md')
    expect(parsed.applied_at).toBeNull()
  })

  it('survives a write and re-read through engine state with its Output intact', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'warpline-gate-'))
    const statePath = join(dir, 'engine-state.json')
    try {
      const state = defaultEngineState()
      state.pending_gates.push(PendingGateSchema.parse(realGate))
      await writeEngineState(state, statePath)

      const reread = await readEngineState(statePath)
      const gate = reread.pending_gates[0]
      expect(gate?.run_started_at).toBe('2026-08-29T09:59:58.000Z')
      expect(gate?.run_completed_at).toBe('2026-08-29T10:00:00.000Z')
      expect(gate?.plugin_result.artifacts_produced[0]?.run_id).toBe('run-a')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  /**
   * The discriminator gets a test of its own so it is a named predicate rather
   * than an implicit heuristic buried in a filter. Both directions: a stub is
   * recognised, and a gate this build wrote is not.
   */
  it('recognises a pre-Phase-8 stub gate by its missing clocks, and a real gate as not one', () => {
    expect(isStubGate(PendingGateSchema.parse(stubGate))).toBe(true)
    expect(isStubGate(PendingGateSchema.parse(realGate))).toBe(false)
  })

  it('reads a pre-Phase-8 gate with both clocks null rather than rejecting the file', () => {
    const parsed = PendingGateSchema.parse(stubGate)
    expect(parsed.run_started_at).toBeNull()
    expect(parsed.run_completed_at).toBeNull()
  })
})

/**
 * The denials record.
 *
 * Keyed by plugin name rather than held as an array, and that shape is the
 * whole idempotency story: a second denial for the same plugin lands on the
 * same key, so re-denying cannot accumulate duplicates and there is no de-dupe
 * scan to get wrong. It also makes a fleet-wide denial inexpressible — there is
 * no key that means every plugin.
 */
describe('DenialSchema and the denials record', () => {
  const denial = {
    plugin: 'digest-sender',
    reason: 'operator declined the parked result',
    denied_at: '2026-08-29T10:00:00.000Z',
    fingerprint: 'a'.repeat(64),
  }

  it('parses a denial and defaults the optional note to null', () => {
    const parsed = DenialSchema.parse(denial)
    expect(parsed.plugin).toBe('digest-sender')
    expect(parsed.fingerprint).toBe('a'.repeat(64))
    expect(parsed.note).toBeNull()
  })

  it('survives a write and re-read through engine state with the entry intact', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'warpline-denial-'))
    const statePath = join(dir, 'engine-state.json')
    try {
      const state = defaultEngineState()
      state.denials['digest-sender'] = DenialSchema.parse({ ...denial, note: 'too chatty' })
      await writeEngineState(state, statePath)

      const reread = await readEngineState(statePath)
      expect(reread.denials['digest-sender']?.fingerprint).toBe('a'.repeat(64))
      expect(reread.denials['digest-sender']?.note).toBe('too chatty')
      expect(Object.keys(reread.denials)).toEqual(['digest-sender'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reads a state document written before denials existed as an empty record', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'warpline-denial-'))
    const statePath = join(dir, 'engine-state.json')
    try {
      await writeFile(statePath, JSON.stringify({ schema_version: 1, plugin_runs: {} }))
      const state = await readEngineState(statePath)
      expect(state.denials).toEqual({})
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  /**
   * The structural half of "denying twice is a no-op": the record's key does
   * it, not a scan. The other half — that a second deny with an UNCHANGED
   * fingerprint writes nothing at all — is asserted in `deny.test.ts`, where
   * the verb decides it.
   */
  it('replaces rather than accumulates when the same plugin is denied again', () => {
    const state = defaultEngineState()
    state.denials['digest-sender'] = DenialSchema.parse(denial)
    state.denials['digest-sender'] = DenialSchema.parse({
      ...denial,
      fingerprint: 'b'.repeat(64),
      denied_at: '2026-08-29T11:00:00.000Z',
    })

    expect(Object.keys(state.denials)).toEqual(['digest-sender'])
    expect(state.denials['digest-sender']?.fingerprint).toBe('b'.repeat(64))
  })
})
