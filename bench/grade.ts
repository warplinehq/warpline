/**
 * The grader. Arm-agnostic by construction.
 *
 * It reads a filesystem. It imports no handler and no handler's test, because
 * an agent arm produced the same four files without running any of them, and a
 * grader that reached into the runtime would be grading the runtime rather than
 * the artifacts. Nothing here can tell which arm wrote what it is reading, and
 * that is the whole property.
 *
 * Every check is existence plus a parsed VALUE. Never a string length, never a
 * text equality, never a normalisation compare — three arms writing the same
 * fact in three different words are three passes, and an artifact that carries
 * the fact in a shape a reader can use is what the benchmark is about.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { GRADED_KEYS, type GradedKey } from './record.js'
import { GRADED_PATHS } from './seed.js'

export interface GradeResult {
  /** Per-artifact outcome, one entry per graded key. */
  paths: Record<GradedKey, boolean>
  /** True only when every one of the four passed. */
  passed: boolean
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The channels this home was configured to fan out to, or an empty list. */
function configuredChannels(home: string): string[] {
  const config = readJson(join(home, 'config', 'announce-fanout.json'))
  if (!isRecord(config) || !Array.isArray(config.channels)) return []
  return config.channels.filter((c): c is string => typeof c === 'string')
}

/** A digest: one sentence, and the lines a downstream reader consumes. */
function gradeDigest(path: string): boolean {
  const value = readJson(path)
  if (!isRecord(value)) return false
  return Array.isArray(value.lines) && value.lines.length > 0 && typeof value.digest === 'string'
}

/**
 * A rollup: the two counts, as integers, with at least one rollup present.
 *
 * The rollup count is what says the retention fold ran. A file reporting rows
 * and no rollups is the shape of a first run over empty retained state, which
 * every arm would produce by doing nothing.
 */
function gradeRollup(path: string): boolean {
  const value = readJson(path)
  if (!isRecord(value)) return false
  return Number.isInteger(value.rows) && Number.isInteger(value.rollups) && (value.rollups as number) >= 1
}

/** A draft: non-empty text. Not its length, and not its words. */
function gradeDraft(path: string): boolean {
  try {
    return readFileSync(path, 'utf8').trim().length > 0
  } catch {
    return false
  }
}

/** A fan-out: one entry per configured channel, no more and no fewer. */
function gradeFanout(path: string, home: string): boolean {
  const value = readJson(path)
  if (!isRecord(value)) return false
  const channels = configuredChannels(home)
  if (channels.length === 0) return false
  const keys = Object.keys(value).sort()
  const expected = [...channels].sort()
  return keys.length === expected.length && keys.every((k, i) => k === expected[i])
}

/** Grade one home's four artifacts, whichever arm produced them. */
export function gradeHome(home: string): GradeResult {
  const at = (key: GradedKey): string => join(home, GRADED_PATHS[key])
  const present = (key: GradedKey): boolean => existsSync(at(key))

  const paths: Record<GradedKey, boolean> = {
    'announce-fanout': present('announce-fanout') && gradeFanout(at('announce-fanout'), home),
    'daily-digest': present('daily-digest') && gradeDigest(at('daily-digest')),
    'draft-writer': present('draft-writer') && gradeDraft(at('draft-writer')),
    'metrics-rollup': present('metrics-rollup') && gradeRollup(at('metrics-rollup')),
  }

  return { paths, passed: GRADED_KEYS.every((key) => paths[key]) }
}
