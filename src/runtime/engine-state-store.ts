/**
 * Disk I/O for the engine state document: how it is read, what an unusable
 * document does, and how it is written back atomically.
 *
 * These five exports used to live in `src/schemas/engine-state.ts`, and that
 * was a mistake with a specific mechanism. `./schemas/*` is a **wildcard** entry
 * in the `exports` map, so every file under `src/schemas/` becomes public API
 * the moment it is written — with no review step between writing it and
 * shipping it. The effect was a published subpath named `schemas` that was
 * public API for `readFile`, `writeFile`, `mkdir` and `rename`: a consumer
 * could read and overwrite the engine's own state document through a specifier
 * whose whole name promises declarative shapes.
 *
 * They moved into a module of their own rather than being folded into
 * `run-artifacts.ts` or `run-log-store.ts`, because those two own different
 * documents with different retention stories — the per-attempt transcript and
 * the pruned-at-30-days advance log. The state document is neither: it is
 * single, long-lived and never pruned, so it gets its own module rather than
 * riding along in one whose retention rules do not apply to it.
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
import { readFile } from 'node:fs/promises'

import { z } from 'zod'
import { atomicWriteText } from '../lib/fs-atomic.js'
import {
  ENGINE_STATE_MAX_SCHEMA_VERSION,
  EngineStateSchema,
  defaultEngineState,
  isStubGate,
} from '../schemas/engine-state.js'
import type { EngineState } from '../schemas/engine-state.js'

/**
 * Raised when a state document exists but cannot be used. Carries the `path`
 * and the `reason` separately so a caller can surface either without
 * re-parsing the message.
 *
 * `name` is assigned the literal in the constructor and that is load-bearing:
 * it is how `src/cli/warpline.ts` catches this without importing this module.
 * Both that dispatcher and `src/bin/warpline.ts` forbid static imports — the
 * whole point is that `--help` never loads zod — so the catch is duck-typed on
 * the name. Renaming the class without renaming the string breaks the mapping
 * silently.
 */
export class EngineStateInvalidError extends Error {
  readonly path: string
  readonly reason: string

  constructor(path: string, reason: string) {
    super(`engine state at ${path} is unusable: ${reason}`)
    this.name = 'EngineStateInvalidError'
    this.path = path
    this.reason = reason
  }
}

/** What a read does with a document it cannot validate. */
type ReadPolicy = 'fail-closed' | 'tolerant'

/**
 * The one read implementation. `policy` decides what an unusable document
 * does; both public entry points route through here so the two cannot drift by
 * a comparison.
 *
 * `fail-closed` throws and touches nothing. That is the whole point: the read
 * used to return `defaultEngineState()`, and the next engine write persisted
 * that reset over the operator's `task_aging`, `deferrals` and
 * `completed_tasks`. A file we cannot read is a file we must not overwrite.
 *
 * `tolerant` returns defaults, for the read-only callers that are contracted
 * never to fail — `warpline plan` above all. It writes nothing either.
 *
 * Nothing here copies the file aside any more. The old `{path}.corrupt` backup
 * was a write on a read path, and it only existed to preserve evidence before
 * defaults destroyed it; failing closed preserves the original in place.
 *
 * A missing file is not an unusable one: ENOENT yields defaults under both
 * policies, so a fresh install still works.
 */
async function readStateFile(
  statePath: string,
  policy: ReadPolicy,
  eventsPath?: string,
  announceDiscards = true,
): Promise<EngineState> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(statePath, 'utf-8'))
  } catch (err: unknown) {
    const isNotFound = err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT'
    if (isNotFound) return defaultEngineState()
    if (policy === 'tolerant') return defaultEngineState()
    throw new EngineStateInvalidError(statePath, err instanceof Error ? err.message : String(err))
  }

  const result = EngineStateSchema.safeParse(parsed)
  if (!result.success) {
    if (policy === 'tolerant') return defaultEngineState()
    throw new EngineStateInvalidError(statePath, describeIssues(result.error))
  }

  // Checked after a successful parse, not inside the schema: a version we have
  // never heard of is a different problem from a broken document, and the
  // operator's fix is different too. Refusing it is what stops an older build
  // from round-tripping a newer file down to the fields it happens to know.
  if (result.data.schema_version > ENGINE_STATE_MAX_SCHEMA_VERSION) {
    if (policy === 'tolerant') return defaultEngineState()
    throw new EngineStateInvalidError(
      statePath,
      `schema_version ${result.data.schema_version} is newer than this build understands ` +
        `(highest known: ${ENGINE_STATE_MAX_SCHEMA_VERSION}) — your build is older than this file, ` +
        `so upgrade warpline rather than letting this build rewrite it`,
    )
  }

  return discardStubGates(result.data, policy, eventsPath, announceDiscards)
}

/**
 * Throw away any pre-Phase-8 parked gate, naming the plugin in the event log.
 *
 * A stub gate carries a fabricated status and no Outputs, so applying it
 * would record an outcome the plugin never produced. There is nothing to
 * migrate — the real result was never written — so the only honest thing to do
 * is drop it and say so.
 *
 * **The notice is emitted on the write-capable read only.** The tolerant read
 * still discards, silently. `warpline plan` is contracted to write nothing at
 * all, and `plan-prohibition.test.ts` snapshots the entire warpline home to
 * prove it — an append to `events.jsonl` from a read path fails that test as
 * loudly as a state rewrite, and rightly so. `withoutStateBackups` forces the
 * tolerant policy across `plan`'s indirect reads too, so this one comparison
 * covers every path it reaches.
 *
 * Emission is awaited, not fired and forgotten: a caller that reads the event
 * log straight after the state read must see the notice. It is still
 * best-effort — a log that cannot be written must not stop a state read.
 */
async function discardStubGates(
  state: EngineState,
  policy: ReadPolicy,
  eventsPath?: string,
  announceDiscards = true,
): Promise<EngineState> {
  const stubs = state.pending_gates.filter(isStubGate)
  if (stubs.length === 0) return state

  if (policy === 'fail-closed' && announceDiscards) {
    try {
      // Dynamic import: `engine-events` is not otherwise on this module's
      // dependency graph, and a static one would pull the board's event
      // surface into every consumer of the state store.
      const { emitGateInvalidated } = await import('../board/engine-events.js')
      await Promise.all(
        stubs.map((g) => emitGateInvalidated(g.plugin, g.run_id, 'stub', eventsPath)),
      )
    } catch {
      /* a discard notice that cannot be written must not fail the read */
    }
  }

  return { ...state, pending_gates: state.pending_gates.filter((g) => !isStubGate(g)) }
}

/** First issue, path-qualified. The reason a human acts on, not a dump. */
function describeIssues(error: z.ZodError): string {
  const issue = error.issues[0]
  if (!issue) return 'failed schema validation'
  const where = issue.path.length > 0 ? issue.path.join('.') : '(root)'
  return `${where}: ${issue.message}`
}

let tolerantReads = false

/**
 * Read engine state on a path that may go on to write it.
 *
 * Missing file → defaults. Unusable file → `EngineStateInvalidError`, with the
 * document left exactly as it was on disk. Callers return a non-zero code and
 * surface the message; only `src/bin/warpline.ts` exits.
 *
 * `opts.eventsPath` redirects the stub-gate discard notice. It is threaded
 * rather than defaulted at the emitter so a caller that already redirected its
 * own event log — every engine test does — does not have one notice escape to
 * a different file than the rest of the run's.
 *
 * `opts.announceDiscards: false` keeps the fail-closed policy and suppresses
 * that notice. It exists because the two are separate questions and this
 * function used to answer both with one flag: a caller that will NOT persist
 * the discard re-emits the same notice on every read, forever, since nothing
 * ever writes the stub away. `readEngineStateReadOnly` is not the answer for
 * such a caller — it is tolerant, so an unusable document would come back as
 * defaults, and `deny --list` would print "No denials" over a file that holds
 * some. Silently telling an operator nothing is denied is a worse failure than
 * a repeated notice.
 */
export async function readEngineState(
  statePath: string,
  opts: { eventsPath?: string; announceDiscards?: boolean } = {},
): Promise<EngineState> {
  return readStateFile(
    statePath,
    tolerantReads ? 'tolerant' : 'fail-closed',
    opts.eventsPath,
    opts.announceDiscards ?? true,
  )
}

/**
 * Read engine state for a command that will not write.
 *
 * Always tolerant: an unusable document yields defaults rather than stopping
 * the caller. `warpline plan` is a preview and is contracted never to fail, so
 * a corrupt state file must degrade the preview, not end it. This is a product
 * decision, not a test convenience — guaranteeing a valid fixture state file
 * would make the prohibition test pass and leave the shipped claim false.
 */
export async function readEngineStateReadOnly(statePath: string): Promise<EngineState> {
  return readStateFile(statePath, 'tolerant')
}

/**
 * Read tolerantly for the duration of `fn`.
 *
 * The name is older than the meaning: it once suppressed a `{path}.corrupt`
 * backup write, and that backup no longer exists. What it does now is force
 * the tolerant policy — which is the same job it was always really doing,
 * namely keeping a read-only command out of the write-capable path.
 *
 * `readEngineStateReadOnly` covers the reads a caller makes directly. This
 * covers the ones it cannot see: `state-manager.checkTaskLock` reads state
 * through `readEngineState` off a module global and takes no options, and
 * `evaluatePlugin` calls it, so `warpline plan` reaches the write-capable read
 * indirectly no matter how carefully its own call sites are written. Without
 * this, the one command contracted never to fail throws on the exact input it
 * was hardened against. One guard in the shared read is a smaller and safer
 * change than a variant threaded through every intermediate caller.
 *
 * ponytail: process-global, restored in a `finally`. Fine for a one-shot CLI
 * command; if two concurrent callers ever need different answers, make it an
 * AsyncLocalStorage context.
 */
export async function withoutStateBackups<T>(fn: () => Promise<T>): Promise<T> {
  const previous = tolerantReads
  tolerantReads = true
  try {
    return await fn()
  } finally {
    tolerantReads = previous
  }
}

/**
 * Atomic write, through the shared helper rather than a local copy of it.
 *
 * This used to hand-roll the temp-file-then-rename dance with a *fixed* temp
 * name, `${statePath}.tmp`, which is the one detail that made the atomicity
 * claim narrower than it read. Two writers share that inode: A truncates and
 * starts writing, B finishes and renames, and the document renamed into place
 * is A's half. A throw between the write and the rename also left the temp
 * file beside the real document forever. `atomicWriteText` fixes both — a
 * per-process, per-call temp name and a best-effort unlink on failure — and
 * it is the implementation its own docstring says must not be copy-pasted.
 *
 * `atomicWriteText` rather than `atomicWriteJson` only to keep the trailing
 * newline this has always written; the bytes are unchanged.
 *
 * Serialising concurrent writers is a separate, partly-closed problem.
 * `cli/deny.ts` now takes `withStateLock` around its read-modify-write, and
 * `board/state-manager.ts` always did. `engine.ts` does not: `runAdvance`
 * reads at the top and writes at the end, so its window spans plugin
 * execution, and holding the lock across that would block the board for the
 * length of a run. Closing it means applying the advance's changes as deltas
 * onto a fresh read inside the lock — tracked in #25.
 *
 * `cli/approve.ts` is NOT a writer of this document. It reads it, and writes
 * only the grant file via `mergeGrant`. It was named here in error.
 *
 * The lock still cannot move down into here: `board/state-manager.ts` calls
 * this from inside `withStateLock`, which is a non-reentrant `O_EXCL` file
 * lock, so a nested acquire would self-deadlock. It belongs at the call site.
 */
export async function writeEngineState(state: EngineState, statePath: string): Promise<void> {
  await atomicWriteText(statePath, JSON.stringify(state, null, 2) + '\n')
}
