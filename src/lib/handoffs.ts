/**
 * handoffs — one Handoff record per `[needs-llm]` handoff, under the home's
 * `handoffs/` directory, named `<run_id>.<plugin>.json`.
 *
 * A plugin hands off at most once per run, so the run and the plugin are the
 * record's natural key, and the filename stem is its id. A newer handoff for a
 * plugin supersedes that plugin's older open records.
 *
 * **It takes no lock.** That is safe only while supersede is the sole
 * rewriter of these files. Any later writer of a record must coordinate with
 * supersede before it writes one.
 *
 * **It imports nothing from the runtime or the board, and resolves no home.**
 * Every function takes the directory from its caller: the engine derives it
 * from its state file path, `warpline run` from the paths module. It reads no
 * environment variable.
 *
 * **A record never holds payload bytes.** Only `context_path`, copied raw,
 * never normalised, resolved or judged.
 *
 * **The new record is written before any older one is superseded,** so a
 * plugin never ends with zero open records because of a supersede.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { atomicWriteJson } from './fs-atomic.js'
import { isPluginName } from '../schemas/plugin-name.js'
import { makeSkillError, type SkillResult } from '../schemas/skill-result.js'

export const HANDOFFS_READER_VERSION = 1

// What makes a run id safe as half of a filename: no dot, no separator, no `..`.
const RUN_ID = /^[A-Za-z0-9_-]{1,128}$/

const Iso = z.iso.datetime()

/** One stored Handoff. Not strict: a key a later build adds is ignored, and a narrowing one bumps the reader version. */
const HandoffSchema = z.object({
  min_reader_version: z.number().int().positive(),
  id: z.string(),
  run_id: z.string().regex(RUN_ID),
  plugin: z.string().refine(isPluginName),
  task: z.string(),
  context_path: z.string().nullable(),
  created_at: Iso,
  state: z.enum(['open', 'superseded']),
  closed_at: Iso.nullable(),
})

export type Handoff = z.infer<typeof HandoffSchema>
export type HandoffInput = { run_id: string; plugin: string; task: string; context_path: string | null }

type ReadRecord = { name: string; raw: Record<string, unknown>; record: Handoff } | { name: string; unreadable: true }

/**
 * One record file. Never throws. The reader version is read before any other
 * field, and a record whose id is not its filename stem is unreadable.
 */
async function readRecord(dir: string, name: string): Promise<ReadRecord> {
  const unreadable = { name, unreadable: true } as const
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(join(dir, name), 'utf-8'))
  } catch {
    return unreadable
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return unreadable
  const file = raw as Record<string, unknown>
  const version = file.min_reader_version
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1 || version > HANDOFFS_READER_VERSION) {
    return unreadable
  }
  const parsed = HandoffSchema.safeParse(file)
  if (!parsed.success) return unreadable
  const record = parsed.data
  const stem = name.slice(0, -'.json'.length)
  if (record.id !== stem || record.id !== `${record.run_id}.${record.plugin}`) return unreadable
  return { name, raw: file, record }
}

/** Record file names. A missing directory has none; any other failure to list throws, so could not look is never none. */
async function listNames(dir: string): Promise<string[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') return []
    throw err
  }
  // Exactly `.json`, so an `atomicWriteJson` temp file never counts.
  return names.filter((n) => n.endsWith('.json'))
}

/** This plugin's record files: a stem that splits at its one dot into a run id and exactly this plugin. */
async function recordsFor(dir: string, plugin: string): Promise<ReadRecord[]> {
  const names = (await listNames(dir)).filter((n) => {
    const parts = n.slice(0, -'.json'.length).split('.')
    return parts.length === 2 && parts[1] === plugin
  })
  return Promise.all(names.map((n) => readRecord(dir, n)))
}

/** Strictly older by (`created_at`, `id`). The only filter that keeps the writer from superseding its own record. */
function older(a: Handoff, b: Handoff): boolean {
  const ta = Date.parse(a.created_at)
  const tb = Date.parse(b.created_at)
  return ta < tb || (ta === tb && a.id < b.id)
}

const PREFIX = '[needs-llm]'
const CONTEXT = 'Context: '

/**
 * The record's fields from a handoff result. The structured `needs_llm` field
 * wins. Otherwise `task` is the summary after the prefix up to the first
 * `Context: `, trimmed, with one trailing period dropped, and `context_path`
 * is the trimmed text after it, or null when there is none.
 */
export function handoffFields(runId: string, plugin: string, result: SkillResult): HandoffInput {
  if (result.needs_llm !== undefined) {
    return { run_id: runId, plugin, task: result.needs_llm.task, context_path: result.needs_llm.context_path }
  }
  const rest = result.summary.startsWith(PREFIX) ? result.summary.slice(PREFIX.length) : result.summary
  const at = rest.indexOf(CONTEXT)
  const task = (at === -1 ? rest : rest.slice(0, at)).trim().replace(/\.$/, '')
  const contextPath = at === -1 ? null : rest.slice(at + CONTEXT.length).trim()
  return { run_id: runId, plugin, task, context_path: contextPath }
}

function refuse(half: 'run id' | 'plugin name'): Error {
  return Object.assign(new Error(`Handoff ${half} is not a file name`), { code: 'EINVAL' })
}

/**
 * Write one open record, then supersede this plugin's older open ones. Only a
 * failed write of the new record throws. `created_at` is clamped above every
 * one this plugin has, so two handoffs in one millisecond still order.
 */
export async function writeHandoff(dir: string, input: HandoffInput, now = Date.now()): Promise<Handoff> {
  if (!RUN_ID.test(input.run_id)) throw refuse('run id')
  if (!isPluginName(input.plugin)) throw refuse('plugin name')

  let floor = now
  for (const r of await recordsFor(dir, input.plugin)) {
    if ('record' in r) floor = Math.max(floor, Date.parse(r.record.created_at) + 1)
  }
  const id = `${input.run_id}.${input.plugin}`
  const record: Handoff = {
    min_reader_version: HANDOFFS_READER_VERSION,
    id,
    run_id: input.run_id,
    plugin: input.plugin,
    task: input.task,
    context_path: input.context_path,
    created_at: new Date(floor).toISOString(),
    state: 'open',
    closed_at: null,
  }
  await atomicWriteJson(join(dir, `${id}.json`), record)

  try {
    // Re-listed after the write, so a racing writer's record is seen.
    for (const r of await recordsFor(dir, input.plugin)) {
      if (!('record' in r) || r.record.state !== 'open' || !older(r.record, record)) continue
      await atomicWriteJson(join(dir, r.name), { ...r.raw, state: 'superseded', closed_at: record.created_at })
    }
  } catch {
    // Two open records is the state a race already leaves; the next handoff reconciles them.
  }
  return record
}

/** The open records, oldest first, and the names of files that could not be read. A missing directory is empty. */
export async function readOpenHandoffs(dir: string): Promise<{ open: Handoff[]; unreadable: string[] }> {
  const read = await Promise.all((await listNames(dir)).map((n) => readRecord(dir, n)))
  const open: Handoff[] = []
  const unreadable: string[] = []
  for (const r of read) {
    if (!('record' in r)) unreadable.push(r.name)
    else if (r.record.state === 'open') open.push(r.record)
  }
  open.sort((a, b) => (older(a, b) ? -1 : older(b, a) ? 1 : 0))
  unreadable.sort()
  return { open, unreadable }
}

/**
 * The fixed result a caller substitutes when the record cannot be written.
 * A fresh literal, never a spread of the handler's result.
 */
export function handoffNotRecorded(plugin: string, err: unknown): SkillResult {
  // Only the code: a thrown message embeds absolute paths, and this text lands in the run log.
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined
  const cause = typeof code === 'string' ? code : 'unknown'
  return {
    status: 'failed',
    phases_completed: [],
    phases_failed: [plugin],
    errors: [
      makeSkillError(
        'dependency_unavailable',
        `Plugin '${plugin}' handed off, and its Handoff record could not be written (${cause})`,
        { retryable: false },
      ),
    ],
    data_freshness: {},
    summary: `${plugin}: handoff not recorded`,
    artifacts_produced: [],
    schema_version: 1,
  }
}
