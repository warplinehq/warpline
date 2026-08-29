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
  ENGINE_STATE_MAX_SCHEMA_VERSION,
  EngineStateInvalidError,
  defaultEngineState,
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
