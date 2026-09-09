/**
 * The returning-question note reaches the gate's detail string.
 *
 * `supersededNote` is produced by the denial check and consumed by the approval
 * check, so it is computed ONCE before the `GATES` array is scanned rather than
 * inside the entry that reads it. That eager-computation ordering survived the
 * refactor that split the chain into the declared `GATES` array by argument, not
 * by test: presence checks see the wiring and cannot see the order.
 *
 * This is the missing half — it runs the interleaving instead of reading it.
 * Deny a side-effecting plugin, move the proposal so the fingerprint no longer
 * matches, then evaluate with no grant so the chain falls through to
 * `unapproved`. If the note were ever computed lazily inside the denial entry,
 * or the entries reordered so the approval check ran first, the detail would
 * lose its prefix and this reddens.
 */
import { describe, it, expect } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { evaluatePlugin, proposalFingerprint } from '../engine.js'
import { defaultEngineState } from '../../schemas/engine-state.js'
import type { OutputRecord } from '../../schemas/skill-result.js'
import type { PluginManifest } from '../../schemas/plugin-manifest.js'

const pathOutput = (path: string): OutputRecord => ({ type: 'report', format: 'markdown', path })

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

/** A path that cannot hold a grant, so `checkApproval` is false without a fixture home. */
const noGrantPath = join(tmpdir(), 'warpline-no-such-approval', 'approval.json')

describe('supersededNote reaches the unapproved detail', () => {
  it('prefixes the returning-question note after a superseded denial', async () => {
    const state = defaultEngineState()
    const manifest = makeManifest('x', ['fs_write'])

    state.denials['x'] = {
      plugin: 'x',
      reason: 'operator said no',
      denied_at: '2026-08-29T10:00:00.000Z',
      note: null,
      fingerprint: proposalFingerprint(state, 'x', manifest),
    }

    // Move the proposal: the denial fingerprint no longer matches, so the
    // standing is `superseded` and the denial gate does NOT fire.
    state.plugin_runs['x'] = {
      last_run_at: '2026-08-29T11:00:00.000Z',
      status: 'gated',
      last_output: pathOutput('moved.md'),
    }

    const result = await evaluatePlugin(
      'x',
      manifest,
      { currentTier: 'normal', force: false, state, approvalPath: noGrantPath },
      Date.parse('2026-09-08T00:00:00.000Z'),
    )

    expect(result.due).toBe(false)
    if (result.due) return
    expect(result.reason).toBe('unapproved')
    expect(result.detail).toBe(
      "previously denied 2026-08-29T10:00:00.000Z ('operator said no') — the proposal has " +
        'changed since, so this is a returning question, not a new one. ' +
        'unapproved: side effects require session approval',
    )
  })

  /**
   * Non-vacuity: without a denial there is no note, so the assertion above is
   * pinning the prefix rather than matching a string that is always there.
   */
  it('carries no note when there was no denial', async () => {
    const state = defaultEngineState()
    const manifest = makeManifest('x', ['fs_write'])
    state.plugin_runs['x'] = {
      last_run_at: '2026-08-29T11:00:00.000Z',
      status: 'gated',
      last_output: pathOutput('moved.md'),
    }

    const result = await evaluatePlugin(
      'x',
      manifest,
      { currentTier: 'normal', force: false, state, approvalPath: noGrantPath },
      Date.parse('2026-09-08T00:00:00.000Z'),
    )

    expect(result.due).toBe(false)
    if (result.due) return
    expect(result.detail).toBe('unapproved: side effects require session approval')
  })
})
