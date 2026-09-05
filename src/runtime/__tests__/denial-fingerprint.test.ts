/**
 * The denial fingerprint — what a "no" is bound to.
 *
 * A denial suppresses a question, so it must be bound to the question and not
 * to the plugin alone. The fingerprint is what makes "the same proposal" a
 * decidable claim: an unchanged proposal keeps the denial live, and a
 * materially different one is a different question that has not been answered.
 *
 * It lives in its own file rather than in `engine.test.ts` because these are
 * value tests on a pure function — no temp home, no state document, no advance.
 * Mixing them into the engine's fixture-heavy suite would make a hash
 * comparison pay for an engine setup.
 */
import { describe, it, expect } from 'bun:test'
import { denialFingerprint, denialStanding, proposalFingerprint } from '../engine.js'
import { defaultEngineState } from '../../schemas/engine-state.js'
import type { OutputRecord } from '../../schemas/skill-result.js'
import type { PluginManifest } from '../../schemas/plugin-manifest.js'

const HEX_64 = /^[0-9a-f]{64}$/

const pathOutput = (path: string): OutputRecord => ({ type: 'report', format: 'markdown', path })
const bodyOutput = (body: string): OutputRecord => ({ type: 'brief', format: 'markdown', body })

function makeManifest(name: string, sideEffects: string[]): PluginManifest {
  return {
    name,
    version: '1.0.0',
    description: `${name} fixture`,
    inputs: {},
    outputs: {},
    capabilities: [],
    secrets: [],
    schedule: 'on_run',
    autonomy_level: 'supervised',
    side_effects: sideEffects as PluginManifest['side_effects'],
    ttl_hours: 24,
    dependencies: [],
    timeout_ms: 5000,
    max_parallelism: 1,
    min_tier: 'normal',
    max_retries: 1,
    retry_delay_ms: 2000,
  }
}

describe('denialFingerprint', () => {
  it('is a whole hex-encoded sha256 — 64 characters, never truncated', () => {
    const fp = denialFingerprint('digest-sender', ['sends_email'], [pathOutput('digest.md')])
    expect(fp).toMatch(HEX_64)
  })

  /**
   * R3 names the Output's `type` as part of what enters the fingerprint, and it
   * was not hashed: only the path or the body was. So a plugin that turned the
   * file at `report.md` from a `draft` into a `report` produced a
   * byte-identical value, and a denial recorded against the draft went on
   * silently suppressing the report — an answer to a question never asked.
   */
  it('changes when an Output keeps its path but changes its semantic type', () => {
    const draft: OutputRecord = { type: 'draft', format: 'markdown', path: 'report.md' }
    const report: OutputRecord = { type: 'report', format: 'markdown', path: 'report.md' }

    expect(denialFingerprint('x', [], [draft])).not.toBe(denialFingerprint('x', [], [report]))

    // The same for an inline Output, where the body is identical and only the
    // declared type moves — the body hash alone could not tell them apart.
    const noteBody: OutputRecord = { type: 'brief', format: 'markdown', body: 'same words' }
    const reportBody: OutputRecord = { type: 'report', format: 'markdown', body: 'same words' }
    expect(denialFingerprint('x', [], [noteBody])).not.toBe(
      denialFingerprint('x', [], [reportBody]),
    )
  })

  /**
   * Declaration order in a manifest is an editing accident, not a proposal
   * change. Without the sort, moving one line in `manifest.ts` would re-raise
   * an Ask the operator already answered.
   */
  it('does not change when a manifest reorders its side_effects', () => {
    const a = denialFingerprint('x', ['sends_email', 'writes_db', 'external_api'], [])
    const b = denialFingerprint('x', ['external_api', 'sends_email', 'writes_db'], [])
    expect(a).toBe(b)
  })

  it('does not change when the produced Outputs are reordered', () => {
    const one = pathOutput('a.md')
    const two = pathOutput('b.md')
    expect(denialFingerprint('x', [], [one, two])).toBe(denialFingerprint('x', [], [two, one]))
  })

  /**
   * The plugin name is INSIDE the hashed object, not merely the record key.
   * Two plugins with byte-identical payloads must not share a value, or one
   * plugin's denial could be made to answer for another's proposal.
   */
  it('gives two plugins with byte-identical payloads different values', () => {
    const payload: [string[], OutputRecord[]] = [['sends_email'], [pathOutput('same.md')]]
    expect(denialFingerprint('alpha', ...payload)).not.toBe(denialFingerprint('beta', ...payload))
  })

  /**
   * Not an error case. A plugin that declares no side effects and produced no
   * Output is denied by name within its own scope, and the value is stable so
   * the denial stays live across advances.
   */
  it('hashes the empty sets to a stable value, scoped by name', () => {
    expect(denialFingerprint('quiet', [], [])).toBe(denialFingerprint('quiet', [], []))
    expect(denialFingerprint('quiet', [], [])).toMatch(HEX_64)
    expect(denialFingerprint('quiet', [], [])).not.toBe(denialFingerprint('other', [], []))
  })

  it('changes when a declared side effect changes', () => {
    expect(denialFingerprint('x', ['sends_email'], [])).not.toBe(
      denialFingerprint('x', ['writes_db'], []),
    )
    expect(denialFingerprint('x', ['sends_email'], [])).not.toBe(
      denialFingerprint('x', ['sends_email', 'writes_db'], []),
    )
  })

  it("changes when an Output's path changes", () => {
    expect(denialFingerprint('x', [], [pathOutput('a.md')])).not.toBe(
      denialFingerprint('x', [], [pathOutput('b.md')]),
    )
  })

  /**
   * The body is hashed, not embedded, so the fingerprint stays 64 characters
   * whatever the inline cap allows — and the denials record never holds the
   * content of an Output.
   */
  it("changes when an inline Output's body changes, without embedding it", () => {
    const first = denialFingerprint('x', [], [bodyOutput('the weekly brief')])
    const second = denialFingerprint('x', [], [bodyOutput('the weekly brief, revised')])
    expect(first).not.toBe(second)
    expect(first).toMatch(HEX_64)
  })

  it('does not confuse a path Output with an inline one of the same text', () => {
    expect(denialFingerprint('x', [], [pathOutput('brief.md')])).not.toBe(
      denialFingerprint('x', [], [bodyOutput('brief.md')]),
    )
  })
})

/**
 * `proposalFingerprint` is the single caller-facing entry point: both the
 * evaluator and the deny verb go through it, so the value written at deny time
 * and the value recomputed on the next advance cannot be produced by two
 * different pieces of arithmetic.
 */
describe('proposalFingerprint', () => {
  it('reads the plugin\'s last recorded Output out of engine state', () => {
    const state = defaultEngineState()
    state.plugin_runs['digest-sender'] = {
      last_run_at: '2026-08-29T10:00:00.000Z',
      status: 'gated',
      last_output: pathOutput('digest.md'),
    }
    const manifest = makeManifest('digest-sender', ['sends_email'])

    expect(proposalFingerprint(state, 'digest-sender', manifest)).toBe(
      denialFingerprint('digest-sender', ['sends_email'], [pathOutput('digest.md')]),
    )
  })

  it('hashes the empty Output set for a plugin that has never run', () => {
    const state = defaultEngineState()
    const manifest = makeManifest('never-ran', [])

    expect(proposalFingerprint(state, 'never-ran', manifest)).toBe(
      denialFingerprint('never-ran', [], []),
    )
  })

  it('moves when the manifest declares a different side effect', () => {
    const state = defaultEngineState()
    const before = proposalFingerprint(state, 'x', makeManifest('x', ['sends_email']))
    const after = proposalFingerprint(state, 'x', makeManifest('x', ['writes_db']))
    expect(before).not.toBe(after)
  })

  it('moves when the plugin\'s recorded Output moves', () => {
    const state = defaultEngineState()
    const manifest = makeManifest('x', [])
    state.plugin_runs['x'] = {
      last_run_at: '2026-08-29T10:00:00.000Z',
      status: 'gated',
      last_output: pathOutput('v1.md'),
    }
    const before = proposalFingerprint(state, 'x', manifest)
    state.plugin_runs['x'] = {
      last_run_at: '2026-08-29T11:00:00.000Z',
      status: 'gated',
      last_output: pathOutput('v2.md'),
    }
    expect(proposalFingerprint(state, 'x', manifest)).not.toBe(before)
  })

  /**
   * The durability property, asserted directly because it is the reason the
   * Outputs come from `plugin_runs` and not from the parked gate: a gate is
   * destroyed by the next advance, and a denial bound to something that
   * evaporates would re-raise an answered question a day later for no reason
   * the operator could see.
   */
  it('is unaffected by a parked gate appearing or being discarded', () => {
    const state = defaultEngineState()
    const manifest = makeManifest('x', ['sends_email'])
    state.plugin_runs['x'] = {
      last_run_at: '2026-08-29T10:00:00.000Z',
      status: 'gated',
      last_output: pathOutput('v1.md'),
    }
    const withoutGate = proposalFingerprint(state, 'x', manifest)

    state.pending_gates.push({
      plugin: 'x',
      run_id: 'run-a',
      created_at: '2026-08-29T10:00:00.000Z',
      payload_summary: 'did the thing',
      plugin_result: {
        status: 'success',
        phases_completed: [],
        phases_failed: [],
        errors: [],
        data_freshness: {},
        summary: 'did the thing',
        artifacts_produced: [pathOutput('v1.md'), pathOutput('extra.md')],
        schema_version: 2,
      },
      run_started_at: '2026-08-29T09:59:00.000Z',
      run_completed_at: '2026-08-29T10:00:00.000Z',
      applied_at: null,
    })

    expect(proposalFingerprint(state, 'x', manifest)).toBe(withoutGate)
  })
})

describe('denialStanding', () => {
  /**
   * The three states, pinned together. This predicate used to be spelled out at
   * four call sites and it drifted at two of them — one forgot the fingerprint
   * comparison, one used an existence test where the record is a plain object.
   * Both mistakes are shaped like a passing test, so they are asserted here
   * rather than left to the callers that happen to exercise them.
   */
  const deny = (state: ReturnType<typeof defaultEngineState>, plugin: string, fp: string) => {
    state.denials[plugin] = {
      plugin,
      reason: 'operator said no',
      denied_at: '2026-08-29T10:00:00.000Z',
      note: null,
      fingerprint: fp,
    }
  }

  it('reports none when no denial is on file', () => {
    const state = defaultEngineState()
    const manifest = makeManifest('x', ['fs_write'])
    expect(denialStanding(state, 'x', manifest).standing).toBe('none')
  })

  it('reports live while the fingerprint still answers the proposal', () => {
    const state = defaultEngineState()
    const manifest = makeManifest('x', ['fs_write'])
    deny(state, 'x', proposalFingerprint(state, 'x', manifest))

    const standing = denialStanding(state, 'x', manifest)
    expect(standing.standing).toBe('live')
    if (standing.standing !== 'none') expect(standing.denial.reason).toBe('operator said no')
  })

  /**
   * The half a caller forgets. A record on file is not a live answer: move the
   * proposal and the same record must stop suppressing, or the operator is held
   * behind an answer to a question that no longer exists.
   */
  it('reports superseded — and still hands back the record — once the proposal moves', () => {
    const state = defaultEngineState()
    const manifest = makeManifest('x', ['fs_write'])
    deny(state, 'x', proposalFingerprint(state, 'x', manifest))

    state.plugin_runs['x'] = {
      last_run_at: '2026-08-29T11:00:00.000Z',
      status: 'gated',
      last_output: pathOutput('moved.md'),
    }

    const standing = denialStanding(state, 'x', manifest)
    expect(standing.standing).toBe('superseded')
    // Handed back, not dropped: the evaluator narrates a returning question
    // from it, so 'superseded' cannot collapse into 'none'.
    if (standing.standing !== 'none') expect(standing.denial.denied_at).toBe('2026-08-29T10:00:00.000Z')
  })

  /**
   * The other half. `denials` is a plain object, so `denials['toString']`
   * answers with an inherited function; an existence test believes it and
   * suppresses a plugin nobody denied. Non-vacuous by construction — the same
   * name reports `live` once genuinely denied, below.
   */
  it('does not mistake an Object.prototype member for a denial', () => {
    const state = defaultEngineState()
    const manifest = makeManifest('toString', [])
    expect(denialStanding(state, 'toString', manifest).standing).toBe('none')

    deny(state, 'toString', proposalFingerprint(state, 'toString', manifest))
    expect(denialStanding(state, 'toString', manifest).standing).toBe('live')
  })
})
