/**
 * The `consume` block in preferences.json: the operator's settings for the
 * `consume` verb, judged apart from the file the way `notify` is.
 *
 * Money is USD exact to the micro-dollar, the tool opt-in is a map from
 * plugin to a tool list, and a window cap needs a per-call cap beside
 * it, because the per-call cap is the amount a try reserves. Every refusal
 * names a key path and never the value, so each refused value here carries
 * `sentinel-7f3a` and no answer may repeat it.
 *
 * Nothing here touches a file: `parsePreferences` judges bytes in memory.
 */
import { describe, test, expect } from 'bun:test'
// A namespace, so a missing export fails the cases that read it, not the file.
import * as preferences from '../preferences.js'

const SENTINEL = 'sentinel-7f3a'
const PREFS_PATH = '/nonexistent/preferences.json'

const DEFAULTS: preferences.ConsumeSettings = {
  renderer: 'claude-code',
  models: {},
  window_seconds: 86400,
  prices: {},
  model_mismatch: 'record',
  max_tries: 3,
  max_output_bytes: 1048576,
  tools: {},
}

const CONSUME_KEYS = [
  'renderer',
  'model',
  'models',
  'endpoint',
  'max_usd_per_call',
  'max_usd_per_window',
  'window_seconds',
  'prices',
  'model_mismatch',
  'max_tries',
  'max_output_bytes',
  'tools',
  'run_as',
]

/** The answer's unusable key path, or a marker that the block was accepted. */
function unusableAt(raw: unknown): string {
  const answer = preferences.parseConsume(raw)
  return 'unusable' in answer ? answer.unusable : 'accepted'
}

describe('the consume block', () => {
  test('absent, null or empty gives every default', () => {
    expect(preferences.parseConsume(undefined)).toEqual({ consume: DEFAULTS })
    expect(preferences.parseConsume(null)).toEqual({ consume: DEFAULTS })
    expect(preferences.parseConsume({})).toEqual({ consume: DEFAULTS })
  })

  test('every consume key is settable, and no settable key is three levels deep', () => {
    for (const key of CONSUME_KEYS) expect(preferences.PREFERENCE_KEYS).toContain(`consume.${key}`)
    expect(preferences.PREFERENCE_KEYS).toContain('consume')
    expect(preferences.PREFERENCE_KEYS.filter((k) => k.split('.').length > 2)).toEqual([])
  })

  test('a full block parses as written', () => {
    const block: preferences.ConsumeSettings = {
      renderer: 'openai-compatible',
      model: 'claude-opus-5',
      models: { prod: 'us.anthropic.claude-opus-4-8', 'ops-digest': 'opus[1m]' },
      endpoint: 'https://gateway.example.com/v1',
      max_usd_per_call: 0.5,
      max_usd_per_window: 25,
      window_seconds: 3600,
      prices: { 'claude-opus-5': { usd_per_mtok_in: 5, usd_per_mtok_out: 25.123456 } },
      model_mismatch: 'refuse',
      max_tries: 5,
      max_output_bytes: 4096,
      tools: { prod: ['Read', 'Grep', 'mcp__docs__search'] },
      run_as: 'warpline-judge',
    }
    expect(preferences.parseConsume(block)).toEqual({ consume: block })
  })

  test('USD amounts are exact to the micro-dollar, and anything finer or negative is refused by key path', () => {
    for (const usd of [0, 0.000001, 1.5, 12.123456]) {
      expect(unusableAt({ max_usd_per_call: usd })).toBe('accepted')
      expect(unusableAt({ prices: { m: { usd_per_mtok_in: usd, usd_per_mtok_out: usd } } })).toBe('accepted')
    }
    for (const usd of [0.0000001, -1, 1.1234567, 1e-7]) {
      expect(unusableAt({ max_usd_per_call: usd })).toBe('consume.max_usd_per_call')
      expect(unusableAt({ max_usd_per_call: 1, max_usd_per_window: usd })).toBe('consume.max_usd_per_window')
      expect(unusableAt({ prices: { m: { usd_per_mtok_in: usd, usd_per_mtok_out: 1 } } })).toBe(
        'consume.prices.m.usd_per_mtok_in',
      )
    }
  })

  test('a window cap without a per-call cap is unusable at max_usd_per_window', () => {
    expect(unusableAt({ max_usd_per_window: 10 })).toBe('consume.max_usd_per_window')
    expect(unusableAt({ max_usd_per_window: 10, max_usd_per_call: 0.25 })).toBe('accepted')
    expect(unusableAt({ max_usd_per_call: 0.25 })).toBe('accepted')
  })

  test('each unusable block names its key path and never the refused value', () => {
    const cases: [unknown, RegExp][] = [
      [{ model: `a b ${SENTINEL}` }, /^consume\.model$/],
      [{ models: { [`Bad-${SENTINEL}`]: 'x' } }, /^consume\.models(\.|$)/],
      [{ models: { prod: `bad id ${SENTINEL}` } }, /^consume\.models\.prod$/],
      [{ prices: { [`bad id ${SENTINEL}`]: { usd_per_mtok_in: 1, usd_per_mtok_out: 1 } } }, /^consume\.prices(\.|$)/],
      [{ prices: { m: { usd_per_mtok_in: 1 } } }, /^consume\.prices\.m\.usd_per_mtok_out$/],
      [{ tools: { prod: [`Bash(rm:*)${SENTINEL}`] } }, /^consume\.tools(\.|$)/],
      [{ tools: { prod: [] } }, /^consume\.tools\.prod$/],
      [{ tools: { [`Bad-${SENTINEL}`]: ['Read'] } }, /^consume\.tools(\.|$)/],
      [{ run_as: `two words ${SENTINEL}` }, /^consume\.run_as$/],
      [{ endpoint: `ftp://${SENTINEL}.example` }, /^consume\.endpoint$/],
      [{ endpoint: `not a url ${SENTINEL}` }, /^consume\.endpoint$/],
      [{ renderer: SENTINEL }, /^consume\.renderer$/],
      [{ model_mismatch: SENTINEL }, /^consume\.model_mismatch$/],
      [{ max_tries: 0 }, /^consume\.max_tries$/],
      [{ max_output_bytes: 0 }, /^consume\.max_output_bytes$/],
      [{ window_seconds: 1.5 }, /^consume\.window_seconds$/],
      [{ api_key: SENTINEL }, /^consume\.api_key$/],
      [SENTINEL, /^consume$/],
    ]
    for (const [block, keyPath] of cases) {
      const answer = preferences.parseConsume(block)
      expect('unusable' in answer).toBe(true)
      expect(unusableAt(block)).toMatch(keyPath)
      expect(JSON.stringify(answer)).not.toContain(SENTINEL)
    }
  })

  test('no endpoint credential is accepted: a key named for one, or a URL carrying one, is refused', () => {
    expect(unusableAt({ api_key: SENTINEL })).toBe('consume.api_key')
    expect(unusableAt({ endpoint: `https://user:${SENTINEL}@gateway.example.com/v1` })).toBe('consume.endpoint')
    expect(unusableAt({ endpoint: `https://gateway.example.com/v1?key=${SENTINEL}` })).toBe('consume.endpoint')
    expect(unusableAt({ endpoint: 'http://127.0.0.1:4000' })).toBe('accepted')
  })

  test('prefs set refuses each unusable block naming consume and never the value', () => {
    const blocks: unknown[] = [
      { model: `a b ${SENTINEL}` },
      { models: { [`Bad-${SENTINEL}`]: 'x' } },
      { prices: { [`bad id ${SENTINEL}`]: { usd_per_mtok_in: 1, usd_per_mtok_out: 1 } } },
      { tools: { [`Bad-${SENTINEL}`]: ['Read'] } },
      { tools: { prod: [`Bash(rm:*)${SENTINEL}`] } },
      { run_as: `two words ${SENTINEL}` },
      { endpoint: `https://user:${SENTINEL}@gateway.example.com` },
      { api_key: SENTINEL },
      { max_usd_per_call: 1.1234567 },
      { max_usd_per_window: 10 },
    ]
    for (const block of blocks) {
      let err: unknown
      try {
        preferences.setPreference(preferences.DEFAULT_PREFERENCES, 'consume', block, PREFS_PATH)
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(preferences.PreferencesInvalidError)
      const message = (err as Error).message
      expect(message).toContain('consume')
      expect(message).not.toContain(SENTINEL)
    }
  })

  test('prefs set refuses a credential key by its path, never its value', () => {
    let err: unknown
    try {
      preferences.setPreference(preferences.DEFAULT_PREFERENCES, 'consume.api_key', SENTINEL, PREFS_PATH)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(preferences.PreferencesInvalidError)
    expect((err as Error).message).toContain('consume.api_key')
    expect((err as Error).message).not.toContain(SENTINEL)
  })

  test('prefs set accepts one consume key at a time', () => {
    const one = preferences.setPreference(
      preferences.DEFAULT_PREFERENCES,
      'consume.tools',
      { prod: ['Read', 'Grep'] },
      PREFS_PATH,
    )
    const two = preferences.setPreference(one, 'consume.run_as', 'warpline-judge', PREFS_PATH)
    expect(two.consume).toEqual({ tools: { prod: ['Read', 'Grep'] }, run_as: 'warpline-judge' })
  })

  test('a broken consume block never refuses the file, and is judged on its own', () => {
    const bytes = Buffer.from(
      JSON.stringify({ review_gate: false, consume: { tools: { prod: [] }, run_as: SENTINEL } }),
      'utf-8',
    )
    const prefs = preferences.parsePreferences(bytes, PREFS_PATH)
    expect(prefs.review_gate).toBe(false)
    expect(preferences.parseConsume(prefs.consume)).toEqual({ unusable: 'consume.tools.prod' })
  })

  test('the defaults carry no consume key', () => {
    expect('consume' in preferences.DEFAULT_PREFERENCES).toBe(false)
  })
})
