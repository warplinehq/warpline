/**
 * User preferences (guardrails) for the Warpline board and engine.
 *
 * Provides:
 *   PreferencesSchema — Zod schema with all defaults
 *   DEFAULT_PREFERENCES — parsed defaults object
 *   PreferencesInvalidError — the file exists and cannot be used
 *   readPreferencesFile() — reads from disk and returns the bytes it parsed;
 *                        defaults and null bytes on a missing file only,
 *                        refuses an invalid one
 *   readPreferences()  — the same, the preferences only
 *   writePreferences() — atomic write through fs-atomic, refuses what read refuses
 *   PREFERENCE_KEYS    — every key `warpline prefs set` accepts, dotted
 *   setPreference()    — one key set, refused unless the result is valid
 *   isQuietHours()     — check if current time is within quiet hours window
 *
 * Written atomically and Zod-validated on write — a half-written or
 * malformed preferences file must not be loadable. Strict on read too: an
 * unknown key at any level is an error, never stripped.
 */
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { atomicWriteJson } from './fs-atomic.js'

// -----------------------------------------------------------------------
// Schema
// -----------------------------------------------------------------------

const HHMM = /^\d{2}:\d{2}$/

const QuietHoursSchema = z.strictObject({
  start: z.string().regex(HHMM).default('22:00'),
  end: z.string().regex(HHMM).default('07:00'),
})

/**
 * How much run history survives, as three bounds an operator sets.
 *
 * There is more than one run-record format under the warpline home and each
 * one prunes itself: the run-log prune, the JSONL logger prune, and the
 * per-plugin artifact trim. A literal at each call site would be three
 * retention rules that agree today and drift the first time one of them is
 * tuned, which is why this is one object the three of them read.
 *
 * `max_bytes` is a per-home total over the runs directory with oldest-first
 * eviction, applied AFTER the day and count rules have run. Accepted cost:
 * one large legitimate log can evict several small ones. 100 MiB is a chosen
 * starting point and nothing measured it.
 *
 * Not nullable, unlike `quiet_hours`. Quiet hours are opt-in and default to
 * off. Retention always applies — a null retention block would be the
 * retain-forever this milestone refuses by name.
 */
const RetentionSchema = z.strictObject({
  /** Days a run record survives. */
  days: z.number().int().min(0).default(30),
  /**
   * Records kept per plugin. Read by the run-artifact trim and by the
   * run-log prune both; an advance's run log names no plugin, so every
   * advance shares one bucket under this bound.
   */
  keep_per_plugin: z.number().int().min(0).default(20),
  /** Whole-home byte budget over the runs directory. 0 is a budget. */
  max_bytes: z.number().int().min(0).default(104857600),
})

export const PreferencesSchema = z.strictObject({
  max_sends_per_day: z.number().int().min(0).default(20),
  review_gate: z.boolean().default(true),
  quiet_hours: QuietHoursSchema.nullable().default(null),
  retention: RetentionSchema
    // `.prefault` rather than `.default`: zod 4 returns a `.default` value
    // as-is without parsing it, so `.default({})` would yield an empty object
    // and none of the three field defaults above would ever fire.
    .prefault({}),
})

export type Preferences = z.infer<typeof PreferencesSchema>

/** The retention bounds as one value, so a prune takes one parameter not three. */
export type RetentionPolicy = Preferences['retention']

export const DEFAULT_PREFERENCES: Preferences = PreferencesSchema.parse({})

/** The accepted keys at each object level, read off the schemas themselves. */
const SHAPES: Record<string, readonly string[]> = {
  '': Object.keys(PreferencesSchema.shape),
  quiet_hours: Object.keys(QuietHoursSchema.shape),
  retention: Object.keys(RetentionSchema.shape),
}

/** Every settable key, dotted: each top-level key, and each key of the objects under one. */
export const PREFERENCE_KEYS: readonly string[] = (SHAPES[''] ?? []).flatMap((top) => [
  top,
  ...(Object.hasOwn(SHAPES, top) ? (SHAPES[top] ?? []).map((k) => `${top}.${k}`) : []),
])

// -----------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------

/**
 * A preferences file exists but cannot be used.
 *
 * Mirrors `PluginConfigError`: the path so the operator knows which file, and a
 * `reason` built from key paths and schema-side facts only. Never a value read
 * out of the file, because this message goes to stderr, into the `warpline run`
 * payload and from there into run logs and scheduler mail.
 */
export class PreferencesInvalidError extends Error {
  readonly prefsPath: string
  readonly reason: string

  constructor(prefsPath: string, reason: string) {
    super(
      `Invalid preferences at ${prefsPath}: ${reason}. Fix the file, or remove it ` +
        `to run on the built-in defaults.`,
    )
    this.name = 'PreferencesInvalidError'
    this.prefsPath = prefsPath
    this.reason = reason
  }
}

// -----------------------------------------------------------------------
// Read / Write
// -----------------------------------------------------------------------

/**
 * Read preferences from disk.
 *
 * A missing file is the built-in defaults: the ordinary first-run shape. Any
 * other read error (EISDIR, EACCES) is rethrown as itself. A file that exists
 * and is not valid JSON, has a wrong type, an out-of-range value, a bad HH:MM
 * or an unknown key at any level throws `PreferencesInvalidError`.
 *
 * Fails closed on purpose. Falling back to defaults ran retention on the
 * 30-day rule and deleted evidence the operator meant to keep, and one bad
 * field discarded every valid sibling guardrail with it.
 *
 * Accepted cost: a key added by a later release is refused by an earlier
 * build, so a downgrade needs that key removed from the file first.
 */
export async function readPreferences(prefsPath: string): Promise<Preferences> {
  return (await readPreferencesFile(prefsPath)).prefs
}

/**
 * `readPreferences`, also returning the exact bytes it parsed, or null for a
 * missing file. A production read hands the bytes to the audit store, which
 * compares their digest with the last one it recorded for this file.
 */
export async function readPreferencesFile(
  prefsPath: string,
): Promise<{ prefs: Preferences; bytes: Buffer | null }> {
  let bytes: Buffer
  try {
    bytes = await readFile(prefsPath)
  } catch (err: unknown) {
    if (isEnoent(err)) return { prefs: DEFAULT_PREFERENCES, bytes: null }
    throw err
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf-8'))
  } catch {
    // The parser's own message is not forwarded: Bun quotes the offending
    // token in it, which would put file content into this error.
    throw new PreferencesInvalidError(prefsPath, 'file is not valid JSON')
  }

  const result = PreferencesSchema.safeParse(parsed)
  if (!result.success) {
    throw new PreferencesInvalidError(prefsPath, describeIssues(result.error.issues))
  }
  return { prefs: result.data, bytes }
}

/**
 * Write preferences through `atomicWriteJson`, whose temp name is unique per
 * write, so two writers never share one. Validated through the strict schema
 * first, so an unknown key is refused rather than dropped and nothing is
 * written. The bytes are `JSON.stringify(validated, null, 2)`, which is what a
 * caller digests for the audit record.
 */
export async function writePreferences(prefsPath: string, prefs: Preferences): Promise<void> {
  await atomicWriteJson(prefsPath, PreferencesSchema.parse(prefs))
}

/**
 * `prefs` with one dotted key set to `value`, validated. A key outside
 * `PREFERENCE_KEYS`, or a result the schema refuses, throws
 * `PreferencesInvalidError` naming key paths and schema facts, never the value.
 * Setting `quiet_hours.start` or `.end` while quiet hours are off starts from an
 * empty window, so the schema supplies the other bound's default.
 */
export function setPreference(prefs: Preferences, key: string, value: unknown, prefsPath: string): Preferences {
  if (!PREFERENCE_KEYS.includes(key)) {
    const dot = key.lastIndexOf('.')
    const parent = dot === -1 ? '' : key.slice(0, dot)
    const known = parent !== '' && Object.hasOwn(SHAPES, parent)
    const issue = {
      code: 'unrecognized_keys',
      path: known ? [parent] : [],
      keys: [known ? key.slice(dot + 1) : key],
      message: '',
    } as unknown as Issue
    throw new PreferencesInvalidError(prefsPath, describeIssues([issue]))
  }
  const next: Record<string, unknown> = { ...prefs }
  const [top, sub] = key.split('.') as [string, string | undefined]
  next[top] = sub === undefined ? value : { ...((next[top] as Record<string, unknown> | null) ?? {}), [sub]: value }
  const result = PreferencesSchema.safeParse(next)
  if (!result.success) throw new PreferencesInvalidError(prefsPath, describeIssues(result.error.issues, key))
  return result.data
}

// -----------------------------------------------------------------------
// Guardrail helpers
// -----------------------------------------------------------------------

/**
 * Check if the current time falls within the configured quiet hours window.
 *
 * Handles overnight ranges correctly (e.g. 22:00–07:00 crosses midnight):
 *   - If start > end (overnight): active when time >= start OR time < end
 *   - If start <= end (same-day): active when start <= time < end
 *
 * @param prefs — preferences object with quiet_hours.start and .end
 * @param now — optional Date for testing (defaults to current time)
 */
export function isQuietHours(prefs: Preferences, now?: Date): boolean {
  if (!prefs.quiet_hours) return false

  const d = now ?? new Date()
  const currentMinutes = d.getHours() * 60 + d.getMinutes()

  const [startH, startM] = prefs.quiet_hours.start.split(':').map(Number)
  const [endH, endM] = prefs.quiet_hours.end.split(':').map(Number)

  const startMinutes = startH * 60 + startM
  const endMinutes = endH * 60 + endM

  if (startMinutes > endMinutes) {
    // Overnight range: active if current >= start OR current < end
    return currentMinutes >= startMinutes || currentMinutes < endMinutes
  } else {
    // Same-day range: active if start <= current < end
    return currentMinutes >= startMinutes && currentMinutes < endMinutes
  }
}

// -----------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------

type Issue = z.core.$ZodIssue

/**
 * One clause per issue, joined by '; '. Built from the key path, the issue
 * code and schema-side fields (expected, minimum, pattern, keys) only.
 * `issue.message` and `issue.input` are never read: upstream prose can start
 * quoting input in any release. Key paths go through JSON.stringify so a
 * control character in an operator-typed key cannot split the line. With
 * `typed`, the key `prefs set` was given, a key found inside its value is not
 * named, because that key is part of the value.
 */
function describeIssues(issues: readonly Issue[], typed?: string): string {
  const clauses: string[] = []
  for (const issue of issues) {
    const parent = issue.path.map(String).join('.')
    if (issue.code === 'unrecognized_keys') {
      const accepted = (SHAPES[parent] ?? []).map((k) => JSON.stringify(k)).join(', ')
      // A key inside a value the operator typed is part of that value, and is
      // never repeated: say only that the typed key's value holds one.
      if (typed !== undefined && (parent === typed || parent.startsWith(`${typed}.`))) {
        clauses.push(`key ${JSON.stringify(parent)} holds a key that is not accepted (accepted here: ${accepted})`)
        continue
      }
      for (const key of issue.keys) {
        const full = parent ? `${parent}.${key}` : key
        clauses.push(`key ${JSON.stringify(full)} is not accepted (accepted here: ${accepted})`)
      }
      continue
    }
    const where = parent ? `key ${JSON.stringify(parent)}` : 'the file'
    let expected: string
    switch (issue.code) {
      case 'invalid_type':
        expected = `expected ${issue.expected}`
        break
      case 'too_small':
        expected = `expected ${String(issue.minimum)} or more`
        break
      case 'invalid_format':
        expected = issue.pattern
          ? `expected a string matching ${issue.pattern}`
          : `expected format ${issue.format}`
        break
      default:
        expected = issue.code
    }
    clauses.push(`${where}: ${expected}`)
  }
  return clauses.join('; ')
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as NodeJS.ErrnoException).code === 'ENOENT'
  )
}
