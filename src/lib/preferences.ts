/**
 * User preferences (guardrails) for the Warpline board and engine.
 *
 * Provides:
 *   PreferencesSchema — Zod schema with all defaults
 *   DEFAULT_PREFERENCES — parsed defaults object
 *   readPreferences()  — reads from disk, returns defaults on missing/invalid
 *   writePreferences() — atomic write (tmp + rename)
 *   isQuietHours()     — check if current time is within quiet hours window
 *
 * Written atomically and Zod-validated on write — a half-written or
 * malformed preferences file must not be loadable.
 */
import { readFile, writeFile, rename } from 'node:fs/promises'
import { z } from 'zod'

// -----------------------------------------------------------------------
// Schema
// -----------------------------------------------------------------------

export const PreferencesSchema = z.object({
  max_sends_per_day: z.number().int().min(0).default(20),
  review_gate: z.boolean().default(true),
  quiet_hours: z
    .object({
      start: z.string().regex(/^\d{2}:\d{2}$/).default('22:00'),
      end: z.string().regex(/^\d{2}:\d{2}$/).default('07:00'),
    })
    .nullable()
    .default(null),

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
  retention: z
    .object({
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
    // `.prefault` rather than `.default`: zod 4 returns a `.default` value
    // as-is without parsing it, so `.default({})` would yield an empty object
    // and none of the three field defaults above would ever fire.
    .prefault({}),
})

export type Preferences = z.infer<typeof PreferencesSchema>

/** The retention bounds as one value, so a prune takes one parameter not three. */
export type RetentionPolicy = Preferences['retention']

export const DEFAULT_PREFERENCES: Preferences = PreferencesSchema.parse({})

// -----------------------------------------------------------------------
// Path helpers
// -----------------------------------------------------------------------

// -----------------------------------------------------------------------
// Read / Write
// -----------------------------------------------------------------------

/**
 * Read preferences from disk. Returns DEFAULT_PREFERENCES on:
 *   - File not found (first run)
 *   - Invalid JSON
 *   - Schema validation failure (partial / unexpected shape)
 *
 * Unknown extra keys are stripped by Zod — safe to add new fields later.
 */
export async function readPreferences(prefsPath: string): Promise<Preferences> {
  let content: string
  try {
    content = await readFile(prefsPath, 'utf-8')
  } catch (err: unknown) {
    if (isEnoent(err)) return DEFAULT_PREFERENCES
    throw err
  }

  try {
    const parsed = JSON.parse(content)
    const result = PreferencesSchema.safeParse(parsed)
    if (result.success) return result.data
    return DEFAULT_PREFERENCES
  } catch {
    return DEFAULT_PREFERENCES
  }
}

/**
 * Write preferences atomically via tmp + rename.
 * This prevents concurrent readers from seeing a half-written file.
 * Zod strips unknown keys before writing to prevent field injection.
 */
export async function writePreferences(prefsPath: string, prefs: Preferences): Promise<void> {
  // Re-parse through schema to strip unknown keys and validate
  const validated = PreferencesSchema.parse(prefs)
  const tmpPath = `${prefsPath}.tmp`
  await writeFile(tmpPath, JSON.stringify(validated, null, 2), 'utf-8')
  await rename(tmpPath, prefsPath)
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

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as NodeJS.ErrnoException).code === 'ENOENT'
  )
}
