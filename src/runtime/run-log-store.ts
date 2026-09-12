/**
 * Disk I/O for the advance run log: where it is written, when it is pruned, and
 * what a stored `run_id` resolves to afterwards.
 *
 * These seven helpers used to live in `src/schemas/run-log.ts`, and that was a
 * mistake with a specific mechanism. `./schemas/*` is a **wildcard** entry in
 * the `exports` map, so every file under `src/schemas/` becomes public API the
 * moment it is written — with no review step between writing it and shipping
 * it. The effect was a published subpath named `schemas` that was public API
 * for `mkdir`, `writeFile` and `unlink`: a consumer could reach into the runs
 * directory through a specifier whose whole name promises declarative shapes.
 *
 * They moved here rather than into `run-artifacts.ts` because that module
 * already exports a *different* `writeRunLog`, with a different signature,
 * appending the per-attempt transcript. Folding these in would put two
 * unrelated functions behind one name in one import list, which is the kind of
 * collision that gets resolved wrongly at three in the morning.
 *
 * **There is no back-compat re-export from the old home, deliberately.** The
 * schemas subpath is a hard break at this release, which is the one moment it
 * is free — the installed base is near zero and nothing has been announced. A
 * bridge would keep the helpers reachable from exactly the path this narrowing
 * exists to close. `src/lib/paths-public.ts` set the precedent: a public
 * subpath exports the narrowest thing that serves it, and widening needs a
 * decision record. `src/__tests__/no-orphan-schema-fields.test.ts` is what
 * keeps the boundary enforced rather than re-checked by reading.
 *
 * This file is a relocation. Nothing here was rewritten; signatures and
 * behaviour are what they were.
 */
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { join } from 'node:path'

import { runsDir } from '../lib/paths.js'
import { DEFAULT_PREFERENCES } from '../lib/preferences.js'
import type { RetentionPolicy } from '../lib/preferences.js'
import type { RunLog } from '../schemas/run-log.js'

export function runLogFilename(runId: string): string {
  return `${runId}.json`
}

/**
 * The transcript that sits beside a run's document.
 *
 * Same convention the artifact store writes with. It is named here because the
 * prune enumerates PAIRS, and a store that owns one half of a filename
 * convention owns both halves or the two drift.
 */
export function runTranscriptFilename(runId: string): string {
  return `${runId}.log`
}

export async function ensureRunDir(baseDir: string = runsDir()): Promise<string> {
  await mkdir(baseDir, { recursive: true })
  return baseDir
}

export async function writeRunLog(log: RunLog, baseDir: string = runsDir()): Promise<string> {
  const dir = await ensureRunDir(baseDir)
  const filename = runLogFilename(log.run_id)
  const filepath = join(dir, filename)
  await writeFile(filepath, JSON.stringify(log, null, 2))
  return filepath
}

/** One run as the prune sees it: a pair of files, an age, a size, a verdict. */
interface RunRecord {
  id: string
  /**
   * The NEWER mtime of the pair. A run whose transcript was appended to
   * recently is a recent run, and erring toward "recent" errs toward keeping.
   */
  mtimeMs: number
  /**
   * Document plus transcript. The transcript is normally the larger of the two,
   * so a budget counting only the document does not bound the directory.
   */
  bytes: number
  /** Never evicted by any rule: delegated, caller-protected, or unreadable. */
  exempt: boolean
  /**
   * The plugin an artifact document names, or '' for an engine run log and for
   * an orphan transcript with no document to read. The count bound is applied
   * within one of these, not across the directory.
   */
  plugin: string
}

/**
 * Total order over runs, oldest first.
 *
 * Ties in mtime are broken by run id ascending — a run id is a timestamped
 * string, so it is a stable secondary key that needs no extra read. Directory
 * order is not an order: it is whatever the filesystem returned, and a rule
 * that deletes on it deletes a different run on a different machine.
 */
function oldestFirst(a: RunRecord, b: RunRecord): number {
  if (a.mtimeMs !== b.mtimeMs) return a.mtimeMs - b.mtimeMs
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

async function statOrNull(path: string): Promise<Stats | null> {
  try {
    return await stat(path)
  } catch {
    return null
  }
}

/**
 * Classify a run document by its top-level status, without sniffing its shape.
 *
 * Both record formats under the runs directory carry a top-level `status`, and
 * only the artifact format's union contains the delegated member — so that one
 * field decides, whichever shape the document is. Returns null for a document
 * that will not parse or that carries no string status: the artifact store's
 * own policy is to leave such a file alone so an operator can inspect it, and
 * copying that policy is what keeps the two prune paths agreeing.
 */
async function classifyDocument(path: string): Promise<{ status: string; plugin: string } | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return null
    const doc = parsed as Record<string, unknown>
    if (typeof doc.status !== 'string') return null
    return { status: doc.status, plugin: typeof doc.plugin === 'string' ? doc.plugin : '' }
  } catch {
    return null
  }
}

/**
 * Delete runs the operator's retention policy no longer keeps. Returns the
 * number of RUNS removed, not the number of files.
 *
 * A run is a pair — `<run_id>.json` and `<run_id>.log` — and both go together,
 * because a prune that unlinks one of them strands the other forever. Run ids
 * come from a single directory read, as the union of the stems of both
 * extensions, so a transcript whose document is already gone is reachable and
 * reclaimable rather than immortal.
 *
 * Two kinds of run are removed from the candidate set BEFORE any bound applies,
 * and a third is never a candidate at all:
 *
 *   - a run whose document reports the delegated status — a result parked
 *     pending a human's approval;
 *   - a run id in `protectedRunIds`, which the caller supplies;
 *   - a document that will not parse, left on disk for an operator to inspect.
 *
 * The ordering matters and is the part most easily written wrong. The day and
 * count rules compose as filters, but the byte bound is a loop with an
 * accumulator, and written over the raw directory listing it would evict the
 * oldest records in the home — which are exactly the records the exemptions
 * exist to protect. Exemption happens once, at the top; all three bounds
 * compose after it.
 *
 * `protectedRunIds` is a SET rather than a single id or a single source because
 * more than one kind of reference will eventually protect a run. Today the one
 * caller passes the run ids of pending approval gates. A later release adds a
 * second kind of held record and joins the same set by the same mechanism, so
 * the reference-aware machinery here is built and tested against one reference
 * kind and widened by the caller, never by this module.
 *
 * The byte bound is a per-home total over `baseDir`: exempt and unreadable runs
 * count toward the total even though nothing can evict them. That is the honest
 * arithmetic — those bytes are on the disk — and it has a consequence worth
 * stating rather than discovering: a home whose exempt records alone exceed the
 * budget evicts every ordinary run and is still over budget.
 */
export async function pruneRunLogs(
  baseDir: string = runsDir(),
  policy: RetentionPolicy = DEFAULT_PREFERENCES.retention,
  protectedRunIds: ReadonlySet<string> = new Set<string>(),
): Promise<number> {
  let entries: string[]
  try {
    entries = await readdir(baseDir)
  } catch (err: unknown) {
    // A missing runs directory is a defined answer, not an error.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw err
  }

  const ids = new Set<string>()
  for (const name of entries) {
    if (name.endsWith('.json')) ids.add(name.slice(0, -'.json'.length))
    else if (name.endsWith('.log')) ids.add(name.slice(0, -'.log'.length))
  }

  const records: RunRecord[] = []
  for (const id of ids) {
    const docPath = join(baseDir, runLogFilename(id))
    const logPath = join(baseDir, runTranscriptFilename(id))
    const docStat = await statOrNull(docPath)
    const logStat = await statOrNull(logPath)
    if (docStat === null && logStat === null) continue

    let exempt = protectedRunIds.has(id)
    let plugin = ''
    if (docStat !== null) {
      const doc = await classifyDocument(docPath)
      if (doc === null) exempt = true
      else {
        if (doc.status === 'delegated') exempt = true
        plugin = doc.plugin
      }
    }

    records.push({
      id,
      mtimeMs: Math.max(docStat?.mtimeMs ?? 0, logStat?.mtimeMs ?? 0),
      bytes: (docStat?.size ?? 0) + (logStat?.size ?? 0),
      exempt,
      plugin,
    })
  }

  const candidates = records.filter((r) => !r.exempt)
  const doomed = new Set<string>()

  // Day rule. Strictly older than the window: a run exactly at the cutoff
  // survives.
  const cutoff = Date.now() - policy.days * 24 * 60 * 60 * 1000
  for (const record of candidates) {
    if (record.mtimeMs < cutoff) doomed.add(record.id)
  }

  // Count rule, within one plugin rather than across the directory. The runs
  // directory holds both record formats, and the same bound is what the
  // per-plugin artifact trim keeps — applied across the directory here it would
  // evict artifacts that trim had just decided to keep, which is two prune
  // paths disagreeing about what survives. Engine run logs and orphan
  // transcripts name no plugin and share one bucket.
  const buckets = new Map<string, RunRecord[]>()
  for (const record of candidates) {
    if (doomed.has(record.id)) continue
    const bucket = buckets.get(record.plugin)
    if (bucket) bucket.push(record)
    else buckets.set(record.plugin, [record])
  }
  for (const bucket of buckets.values()) {
    bucket.sort(oldestFirst).reverse() // newest first
    for (const record of bucket.slice(policy.keep_per_plugin)) doomed.add(record.id)
  }

  // Byte rule. A loop with an accumulator, run over the survivor set and never
  // over the directory listing. At-budget is within budget.
  let total = 0
  for (const record of records) {
    if (!doomed.has(record.id)) total += record.bytes
  }
  if (total > policy.max_bytes) {
    const evictable = candidates.filter((r) => !doomed.has(r.id)).sort(oldestFirst)
    for (const record of evictable) {
      if (total <= policy.max_bytes) break
      doomed.add(record.id)
      total -= record.bytes
    }
  }

  for (const id of doomed) {
    await unlink(join(baseDir, runLogFilename(id))).catch(() => {})
    await unlink(join(baseDir, runTranscriptFilename(id))).catch(() => {})
  }
  return doomed.size
}

/**
 * Whether the run log a `run_id` names is still on disk.
 *
 * `pruneRunLogs` deletes under the operator's retention policy, so any stored
 * `run_id` — a `last_output` pointer, a versioned Output's history — can
 * outlive the run it names. A stored pointer is NOT protective, deliberately:
 * treating one as protective would be retain-forever by accident. That is
 * a defined state rather than an error: the caller renders "run no longer
 * retained" instead of failing.
 */
export function isRunLogRetained(runId: string, baseDir: string = runsDir()): boolean {
  return existsSync(join(baseDir, runLogFilename(runId)))
}

/**
 * What a stored `run_id` resolves to. Three states, and the third is not the
 * second: an event emitted outside any run was never part of one, while a
 * pruned run's record aged out of a directory that used to hold it. Collapsing
 * them loses the only signal that anything was ever there.
 *
 * `kind: 'none'` is the resolution of a null or absent id, so callers hand the
 * field over as-is rather than branching on null before they get here — which
 * is how two readers end up rendering the same fact two ways.
 */
export type RunRef =
  | { kind: 'none' }
  | { kind: 'retained'; run_id: string }
  | { kind: 'not_retained'; run_id: string }

/**
 * Resolve a stored run id against the runs directory. Never throws: a missing
 * directory, a missing file and a null id are all defined answers.
 *
 * One helper for every reader on purpose. A `BoardEvent.run_id` and a
 * `plugin_runs[...].last_output.run_id` dangle for the same reason and must
 * render the same way; a second copy of this branch is how they stop doing so.
 */
export function resolveRunRef(runId: string | null | undefined, baseDir: string = runsDir()): RunRef {
  if (runId === null || runId === undefined || runId === '') return { kind: 'none' }
  return isRunLogRetained(runId, baseDir)
    ? { kind: 'retained', run_id: runId }
    : { kind: 'not_retained', run_id: runId }
}

/** Single-line rendering of a `RunRef`, for any surface that shows a run id. */
export function describeRunRef(ref: RunRef): string {
  switch (ref.kind) {
    case 'none': return 'no run'
    case 'retained': return `run ${ref.run_id}`
    case 'not_retained': return `run no longer retained (${ref.run_id})`
  }
}
