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
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { runsDir } from '../lib/paths.js'
import type { RunLog } from '../schemas/run-log.js'

/**
 * How long a run record survives, in days.
 *
 * Exported because there is now more than one run-record format under the
 * warpline home, and each one prunes itself. Two literals would be two
 * retention rules that agree today and drift the first time one of them is
 * tuned, which is the whole reason this is a name rather than a number at the
 * call site.
 */
export const RETENTION_DAYS = 30

export function runLogFilename(runId: string): string {
  return `${runId}.json`
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

/**
 * ponytail: deletes `*.json` older than the retention window and leaves the
 * `.log` sibling behind, so a pruned run can strand its own transcript — the
 * exact orphan class `trimPluginHistory` unlinks the pair to avoid
 * (`run-artifacts.ts:121-122`). Upgrade path: unlink the pair here too. Fine
 * while the two live in different directories and the strays are small; stop
 * being fine the moment anything prunes a directory holding both.
 */
export async function pruneRunLogs(baseDir: string = runsDir()): Promise<number> {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000
  let pruned = 0
  try {
    const files = await readdir(baseDir)
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      const filepath = join(baseDir, file)
      const stats = await stat(filepath)
      if (stats.mtimeMs < cutoff) {
        await unlink(filepath)
        pruned++
      }
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  return pruned
}

/**
 * Whether the run log a `run_id` names is still on disk.
 *
 * `pruneRunLogs` deletes on mtime, so any stored `run_id` — a `last_output`
 * pointer, a versioned Output's history — can outlive the run it names. That is
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
