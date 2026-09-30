/**
 * preferences tests, with the retention block as the reason this file exists.
 *
 * Fixtures go in a mkdtemp directory. `preferencesPath()` resolves under the
 * live home, so a test that forgot an explicit path would write operational
 * state (AGENTS.md rule 2); every case here passes its own path.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  PreferencesSchema,
  DEFAULT_PREFERENCES,
  readPreferences,
  writePreferences,
  type Preferences,
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

  test('a misspelled retention key is refused, naming the key and the accepted ones', async () => {
    // The operator meant `days`. Stripping it would run retention on the 30-day
    // default and delete evidence they meant to keep, so the read refuses.
    await writeFile(prefsPath, JSON.stringify({ retention: { dayz: 365 } }), 'utf-8')
    const err = await readPreferences(prefsPath).then(
      () => null,
      (e: unknown) => e as Error,
    )
    expect(err?.name).toBe('PreferencesInvalidError')
    expect(err?.message).toContain(prefsPath)
    expect(err?.message).toContain('retention.dayz')
    expect(err?.message).toContain('days')
  })

  test('a wrong-typed retention value is refused, naming the key and the expected shape', async () => {
    await writeFile(
      prefsPath,
      JSON.stringify({ max_sends_per_day: 5, retention: 'thirty days' }),
      'utf-8',
    )
    const err = await readPreferences(prefsPath).then(
      () => null,
      (e: unknown) => e as Error,
    )
    expect(err?.name).toBe('PreferencesInvalidError')
    expect(err?.message).toContain('retention')
    expect(err?.message).toContain('object')
  })

  test('an invalid sibling does not reset a valid guardrail, it refuses the file', async () => {
    // The old reader discarded the whole file on any violation, so this came
    // back with max_sends_per_day 20: one bad retention field silently loosened
    // the send cap the operator had set beside it.
    await writeFile(
      prefsPath,
      JSON.stringify({ max_sends_per_day: 5, retention: { days: -1 } }),
      'utf-8',
    )
    const err = await readPreferences(prefsPath).then(
      () => null,
      (e: unknown) => e as Error,
    )
    expect(err?.name).toBe('PreferencesInvalidError')
    expect(err?.message).toContain('retention.days')
  })

  test.each([
    [{ max_sends_per_dya: 5 }, 'max_sends_per_dya'],
    [{ quiet_hours: { start: '22:00', end: '07:00', x: 1 } }, 'quiet_hours.x'],
    [{ retention: { dayz: 1 } }, 'retention.dayz'],
  ])('an unknown key is refused at every level: %j', async (body, keyPath) => {
    await writeFile(prefsPath, JSON.stringify(body), 'utf-8')
    const err = await readPreferences(prefsPath).then(
      () => null,
      (e: unknown) => e as Error,
    )
    expect(err?.name).toBe('PreferencesInvalidError')
    expect(err?.message).toContain(prefsPath)
    expect(err?.message).toContain(keyPath)
  })

  test('the refusal never carries a value read out of the file', async () => {
    // Identifier characters only, so a JSON parser quotes it as a bare token.
    // Bun's parser message does; forwarding it would leak file content.
    const SENTINEL = 'S3NTINEL_7f3a'
    const bodies = [
      JSON.stringify({ max_sends_per_day: SENTINEL }),
      JSON.stringify({ quiet_hours: { start: SENTINEL, end: '07:00' } }),
      `{"retention": {"days": ${SENTINEL}}}`,
    ]
    for (const body of bodies) {
      await writeFile(prefsPath, body, 'utf-8')
      const err = await readPreferences(prefsPath).then(
        () => null,
        (e: unknown) => e as Error,
      )
      expect(err?.name).toBe('PreferencesInvalidError')
      expect(err?.message).toContain(prefsPath)
      expect(err?.message).not.toContain(SENTINEL)
    }
  })

  test('a missing file is the built-in defaults', async () => {
    expect(await readPreferences(prefsPath)).toEqual(DEFAULT_PREFERENCES)
  })

  test('a read error other than a missing file is rethrown as itself', async () => {
    const err = await readPreferences(dir).then(
      () => null,
      (e: unknown) => e as NodeJS.ErrnoException,
    )
    expect(err?.code).toBe('EISDIR')
    expect(err?.name).not.toBe('PreferencesInvalidError')
  })

  test('writePreferences refuses an unknown key and writes nothing', async () => {
    const withExtra = { ...DEFAULT_PREFERENCES, surprise: 1 } as unknown as Preferences
    await expect(writePreferences(prefsPath, withExtra)).rejects.toThrow()
    expect(existsSync(prefsPath)).toBe(false)
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
