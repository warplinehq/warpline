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
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { z } from 'zod'
import { GRADED_KEYS, type GradedKey } from './record.js'
import { GRADED_PATHS } from './seed.js'

export interface GradeResult {
  /**
   * Per-check outcome. The public grader keys it by the four artifact names; a
   * check-driven grader keys it by opaque `check-N` ids, whose mapping to what
   * they grade lives with whoever wrote the checks.
   */
  paths: Record<string, boolean>
  /** True only when every check passed. */
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

/**
 * The channel list the fan-out artifact is graded against.
 *
 * Read from the harness's OWN tracked fixture and never from the home being
 * graded. This used to read `config/announce-fanout.json` inside the home,
 * which quietly made the grader arm-aware: only the warpline arm's home has a
 * reason to carry a plugin-named configuration file, so a control home graded
 * false for a reason nothing in the output named — and seeding that file into
 * a control home to fix it would plant the runtime's own vocabulary inside the
 * control. One frozen list, outside every home, grades all three arms by the
 * same key.
 */
function gradedChannels(): string[] {
  const config = readJson(join(import.meta.dir, 'fixtures', 'config', 'announce-fanout.json'))
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

/** The same keys, no more and no fewer, in any order. */
function sameKeys(actual: readonly string[], expected: readonly string[]): boolean {
  const keys = [...actual].sort()
  const want = [...expected].sort()
  return keys.length === want.length && keys.every((k, i) => k === want[i])
}

/** A fan-out: one entry per graded channel, no more and no fewer. */
function gradeFanout(path: string): boolean {
  const value = readJson(path)
  if (!isRecord(value)) return false
  const channels = gradedChannels()
  if (channels.length === 0) return false
  return sameKeys(Object.keys(value), channels)
}

/** Grade one home's four artifacts, whichever arm produced them. */
export function gradeHome(home: string): GradeResult {
  const at = (key: GradedKey): string => join(home, GRADED_PATHS[key])
  const present = (key: GradedKey): boolean => existsSync(at(key))

  const paths: Record<GradedKey, boolean> = {
    'announce-fanout': present('announce-fanout') && gradeFanout(at('announce-fanout')),
    'daily-digest': present('daily-digest') && gradeDigest(at('daily-digest')),
    'draft-writer': present('draft-writer') && gradeDraft(at('draft-writer')),
    'metrics-rollup': present('metrics-rollup') && gradeRollup(at('metrics-rollup')),
  }

  return { paths, passed: GRADED_KEYS.every((key) => paths[key]) }
}

/**
 * The closed predicate set a check can apply to a parsed value.
 *
 * Closed on purpose. Each predicate asks whether a fact is present in a usable
 * shape, and none of them can ask what the text says or how long it is, so a
 * configuration cannot smuggle an arm-specific wording into the grade.
 */
export const GradePredicateSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('exists') }),
  z.strictObject({ kind: z.literal('integer_gte'), n: z.number().int() }),
  z.strictObject({ kind: z.literal('non_empty_array') }),
  z.strictObject({ kind: z.literal('non_empty_string') }),
  z.strictObject({ kind: z.literal('keyset_equals'), keys: z.array(z.string()).min(1) }),
])
export type GradePredicate = z.infer<typeof GradePredicateSchema>

/**
 * One check: an opaque id, a file under the home's `graded/` directory, a JSON
 * pointer into it, and the predicate the pointed-at value must satisfy.
 */
export const GradeCheckSchema = z.strictObject({
  id: z.string().regex(/^check-\d+$/),
  path: z
    .string()
    .refine(
      (path) => path.startsWith('graded/') && !isAbsolute(path) && !path.split(/[\\/]/).includes('..'),
      'a check path must sit under graded/ and must not climb out of it',
    ),
  pointer: z.string().refine((pointer) => pointer === '' || pointer.startsWith('/'), "a JSON pointer is '' or starts with '/'"),
  predicate: GradePredicateSchema,
})
export type GradeCheck = z.infer<typeof GradeCheckSchema>

const NOT_FOUND = { found: false, value: undefined } as const

/**
 * Resolve an RFC 6901 JSON pointer. `''` is the whole document. Each token is
 * unescaped `~1` before `~0`, so `~01` reads the key `~1` and not `/`. An array
 * token must be a canonical index inside the array; an object token must be an
 * own key. Anything else is not found, never a throw.
 */
export function resolvePointer(value: unknown, pointer: string): { found: boolean; value: unknown } {
  if (pointer === '') return { found: true, value }
  if (!pointer.startsWith('/')) return NOT_FOUND
  let current = value
  for (const raw of pointer.slice(1).split('/')) {
    const token = raw.replaceAll('~1', '/').replaceAll('~0', '~')
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(token) || Number(token) >= current.length) return NOT_FOUND
      current = current[Number(token)]
    } else if (isRecord(current) && Object.hasOwn(current, token)) {
      current = current[token]
    } else {
      return NOT_FOUND
    }
  }
  return { found: true, value: current }
}

function applyPredicate(predicate: GradePredicate, value: unknown): boolean {
  switch (predicate.kind) {
    case 'exists':
      return true
    case 'integer_gte':
      return Number.isInteger(value) && (value as number) >= predicate.n
    case 'non_empty_array':
      return Array.isArray(value) && value.length > 0
    case 'non_empty_string':
      return typeof value === 'string' && value.trim().length > 0
    case 'keyset_equals':
      return isRecord(value) && sameKeys(Object.keys(value), predicate.keys)
  }
}

/**
 * Grade a home against a list of checks. Arm-blind in the same way `gradeHome`
 * is: it reads files and nothing else, and the checks name ids and paths, never
 * whatever produced them.
 *
 * A malformed check, an empty list and a duplicate id are configuration errors
 * and throw. A missing file, a file linked from outside the home, invalid JSON
 * or a pointer that finds nothing is an artifact that failed, and grades false.
 */
export function gradeWithChecks(home: string, checks: readonly GradeCheck[]): GradeResult {
  if (checks.length === 0) throw new Error('grade: a grader with no checks graded nothing')
  const root = resolve(home) + sep
  const realRoot = realpathSync(home) + sep
  const paths: Record<string, boolean> = {}
  for (const raw of checks) {
    const check = GradeCheckSchema.parse(raw)
    if (Object.hasOwn(paths, check.id)) throw new Error(`grade: check id '${check.id}' appears twice`)
    const file = resolve(join(home, check.path))
    if (!file.startsWith(root)) throw new Error(`grade: check '${check.id}' resolves outside the home`)
    // The path is operator-written, the file is arm-written. A link planted in
    // graded/ that points outside the home would grade someone else's file.
    if (!existsSync(file) || !realpathSync(file).startsWith(realRoot)) {
      paths[check.id] = false
      continue
    }
    if (check.predicate.kind === 'exists' && check.pointer === '') {
      paths[check.id] = true
      continue
    }
    const hit = resolvePointer(readJson(file), check.pointer)
    paths[check.id] = hit.found && hit.value !== undefined && applyPredicate(check.predicate, hit.value)
  }
  return { paths, passed: Object.values(paths).every(Boolean) }
}
