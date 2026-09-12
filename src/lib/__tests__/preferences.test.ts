/**
 * preferences tests, with the retention block as the reason this file exists.
 *
 * Fixtures go in a mkdtemp directory. `preferencesPath()` resolves under the
 * live home, so a test that forgot an explicit path would write operational
 * state (CLAUDE.md Rule 2); every case here passes its own path.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  PreferencesSchema,
  DEFAULT_PREFERENCES,
  readPreferences,
  writePreferences,
} from '../preferences.js'

const DEFAULT_RETENTION = { days: 30, keep_per_plugin: 20, max_bytes: 104857600 }

describe('preferences retention policy', () => {
  let dir: string
  let prefsPath: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'warpline-prefs-'))
    prefsPath = join(dir, 'preferences.json')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test('parsing an empty object fills all three bounds from their defaults', () => {
    expect(PreferencesSchema.parse({}).retention).toEqual(DEFAULT_RETENTION)
    // DEFAULT_PREFERENCES is derived, not hand-written — it must agree.
    expect(DEFAULT_PREFERENCES.retention).toEqual(DEFAULT_RETENTION)
  })

  test('one supplied bound leaves the other two at their defaults', () => {
    expect(PreferencesSchema.parse({ retention: { days: 365 } }).retention).toEqual({
      ...DEFAULT_RETENTION,
      days: 365,
    })
  })

  test('a negative day window is rejected', () => {
    expect(() => PreferencesSchema.parse({ retention: { days: -1 } })).toThrow()
  })

  test('a zero byte budget is a budget, not an absence', () => {
    expect(PreferencesSchema.parse({ retention: { max_bytes: 0 } }).retention).toEqual({
      ...DEFAULT_RETENTION,
      max_bytes: 0,
    })
  })

  test('a file written before this change reads back with retention defaulted', async () => {
    await writeFile(
      prefsPath,
      JSON.stringify({ max_sends_per_day: 5, review_gate: false, quiet_hours: null }),
      'utf-8',
    )
    const prefs = await readPreferences(prefsPath)
    expect(prefs.max_sends_per_day).toBe(5)
    expect(prefs.review_gate).toBe(false)
    expect(prefs.retention).toEqual(DEFAULT_RETENTION)
  })

  test('a misspelled retention key is stripped silently and takes the default', async () => {
    // The operator meant `days`. They get 30, no error, no warning: Zod strips
    // unknown keys rather than failing. Pinned here so it is documented rather
    // than discovered. The pruned count in the machine-readable output is the
    // only confirmation a retention setting took effect.
    await writeFile(prefsPath, JSON.stringify({ retention: { dayz: 365 } }), 'utf-8')
    const prefs = await readPreferences(prefsPath)
    expect(prefs.retention).toEqual(DEFAULT_RETENTION)
  })

  test('a wrong-typed retention value falls back to the whole default object', async () => {
    await writeFile(
      prefsPath,
      JSON.stringify({ max_sends_per_day: 5, retention: 'thirty days' }),
      'utf-8',
    )
    // Unchanged behaviour for any schema violation: the file is discarded
    // wholesale, including the keys that were fine.
    expect(await readPreferences(prefsPath)).toEqual(DEFAULT_PREFERENCES)
  })

  test('writePreferences round-trips the block', async () => {
    const prefs = PreferencesSchema.parse({
      retention: { days: 7, keep_per_plugin: 3, max_bytes: 1024 },
    })
    await writePreferences(prefsPath, prefs)
    const onDisk = JSON.parse(await readFile(prefsPath, 'utf-8'))
    expect(onDisk.retention).toEqual({ days: 7, keep_per_plugin: 3, max_bytes: 1024 })
    expect((await readPreferences(prefsPath)).retention).toEqual({
      days: 7,
      keep_per_plugin: 3,
      max_bytes: 1024,
    })
  })
})
