/**
 * `warpline resolve` — answer a content fire the runtime could not confirm.
 *
 * Before a content consumer's handler runs, the runtime marks its approval
 * with an effect id and the fire instant. When the advance sees the handler
 * finish, it confirms the mark. A handler that returns `failed`, or a process
 * that dies mid-call, leaves the mark unconfirmed, and the approval reads
 * `indeterminate` on every advance after: the runtime cannot see the sink, so
 * it cannot tell whether the bytes arrived, and it never takes a handler's word
 * that they did not. The operator can look. This is where they say what they
 * found: nothing shipped.
 *
 * **Its own verb, because it grants nothing.** `approve` has three modes and
 * every one is a yes about something to come: a parked result applied, a
 * session grant, bytes that may ship. This answers a claim about a fire that
 * already began, identified by its effect id, and it authorises no fire at
 * all. The answered record reads `spent`, so shipping those bytes after all
 * takes a fresh `approve --content`, over bytes the operator reads again.
 *
 * **The answer is the operator's word, and the record says so.** It is
 * written as `not_shipped_at` beside the mark, which stays, and it never
 * touches `confirmed_at`: that field is the advance's account of a fire it saw
 * finish, and this is a different fact from a different witness. No board
 * event and no run-log entry is written. The state document is where the
 * answer lives.
 *
 * **Refusal order is the security property**, as it is in `approve.ts`. Every
 * check runs before any mutation, and every check that reads the document runs
 * inside the state lock, so a refused command leaves the document
 * byte-unchanged. "Indeterminate" is never re-derived here: the verb reads
 * `approvalStanding`, the one authority read, and answers only what it calls
 * `indeterminate`. No operator-typed text is echoed, the plugin name included:
 * the typed effect id is compared and never echoed or stored, and the refusal
 * prints the recorded id instead; the plugin is named only once a record was
 * found under it.
 *
 * **It waits for a running advance.** The mark reaches the disk before the
 * handler runs, and the advance's own write comes after it, so between the two
 * the record reads `indeterminate` while the fire may still land. An answer
 * given then is overwritten by that advance's write if the fire fails (it
 * marked the record, so its copy wins the merge), dropped if it succeeds, and
 * turned into a double send if the process dies after the send landed and the
 * operator re-approves. The run lock is held for exactly that window, so the
 * verb refuses while a live advance holds it. It reads the lock inside the
 * state lock and before the document: an advance marks a fire only while
 * holding the run lock, and only under that state lock, so no fire can be
 * marked between this check and this write. A lock that cannot be read is
 * refused, because could-not-look is not looked-and-found-nothing. A stale
 * lock does not block: a holder silent past the two-hour window, or a dead pid
 * on this machine, is the crashed advance the verb exists for. The cost: the
 * operator waits for the running advance to end, and after a crash on a
 * machine that cannot identify itself, for the two-hour window. The one
 * residual is the run-lock overlap the runtime spec names, where a healed
 * advance may still be running without a lock. The verb only reads the lock:
 * it never writes, heals or removes it.
 *
 * **Validated against the record, not the installed manifests**, on the
 * argument `approve --content --remove` makes: a plugin may be uninstalled
 * after its fire, and the question its record holds must still be answerable.
 * The manifests are loaded only because `approvalStanding` takes them, and it
 * decides a marked record before it consults them.
 *
 * No content is erased here. An answered record binds its producer's content
 * by fingerprint until its window closes, as a confirmed one does, and the
 * advance's release rule lets it go then.
 *
 * Never terminates the process — it returns a code to the dispatcher.
 */
import { existsSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { approvalStanding, loadPluginManifests } from '../runtime/engine.js'
import { pathsForStateFile, withStateLockAt } from '../board/state-manager.js'
import {
  EngineStateInvalidError,
  readEngineState,
  writeEngineState,
} from '../runtime/engine-state-store.js'
import type { EngineState } from '../schemas/engine-state.js'
import { isLockStale, readLock } from '../runtime/lock.js'
import { engineStatePath, lockPath as runLockPath, pluginsDir } from '../lib/paths.js'

const USAGE = `Usage: warpline resolve <plugin> --not-shipped <effect-id>

Answers a content fire that was marked and never confirmed, after you checked
the sink with its effect id and found that nothing shipped. The approval then
reads spent and fires nothing. To ship those bytes after all, approve them
again: warpline approve <plugin> --content --not-after <when>.
`

export async function run(argv: string[]): Promise<number> {
  let values: { 'not-shipped'?: string }
  let positionals: string[]
  try {
    // strict: true, so any other flag is refused by the parser rather than
    // ignored. A flag that vanishes silently is a lie about what was answered.
    const parsed = parseArgs({
      args: argv,
      options: { 'not-shipped': { type: 'string' } },
      allowPositionals: true,
      strict: true,
    })
    values = parsed.values
    positionals = parsed.positionals
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`)
    return 1
  }

  const typed = values['not-shipped']
  if (typed === undefined) {
    process.stderr.write(USAGE)
    return 1
  }
  if (positionals.length !== 1) {
    process.stderr.write(
      `resolve answers one fire of one plugin, so it names exactly one plugin ` +
        `(got ${positionals.length}). Nothing was written.\n`,
    )
    return 1
  }
  const plugin = positionals[0]!

  const { manifests } = await loadPluginManifests(pluginsDir())
  const statePath = engineStatePath()
  // The lock that guards THIS document, as in `approve.ts`.
  const lockPath = pathsForStateFile(statePath).lockPath

  return await withStateLockAt(lockPath, async () => {
    // The run lock first, before the clock or the document. An advance marks a
    // fire only while it holds the run lock, and only under the state lock this
    // callback holds, so a live lock seen here is the one window in which a
    // marked fire may still be in flight, and none can open before the write.
    // Only `acquired_at` is printed: a runtime-written instant, never a path.
    const held = await readLock(runLockPath())
    if (held !== null && !isLockStale(held)) {
      process.stderr.write(
        `An advance is running (it took the run lock at ${held.acquired_at}), so a fire it marked ` +
          `may still be in flight and the sink cannot answer for it yet. Resolve it after the ` +
          `advance ends. Nothing was written.\n`,
      )
      return 1
    }
    // `readLock` says null for an absent file and for one that is not a lock.
    // Only the first is known to be no advance.
    if (held === null && existsSync(runLockPath())) {
      process.stderr.write(
        `The run lock could not be read back as a lock, so whether an advance is still firing ` +
          `cannot be told. Nothing was written.\n`,
      )
      return 1
    }

    // Read once the lock is held: the standing and the answer instant are
    // about the document this write replaces.
    const now = Date.now()
    let state: EngineState
    try {
      state = await readEngineState(statePath)
    } catch (err) {
      if (!(err instanceof EngineStateInvalidError)) throw err
      process.stderr.write(`Cannot read engine state: ${err.reason}\nNothing was written.\n`)
      return 1
    }

    // Own-property, never a bare index: `resolve toString` must read as absent.
    // The typed name is not repeated: it is operator text, and nothing was
    // found under it.
    if (!Object.hasOwn(state.approvals, plugin)) {
      process.stderr.write(
        `No content approval recorded under that name, so there is no fire to resolve. ` +
          `Nothing was written.\n`,
      )
      return 1
    }

    const standing = approvalStanding(state, plugin, manifests, now)
    if (standing.standing !== 'indeterminate') {
      process.stderr.write(
        `${plugin} has no fire waiting on an answer: only a fire that was marked and never ` +
          `confirmed can be resolved. Nothing was written.\n`,
      )
      return 1
    }

    const record = standing.approval
    if (record.effect_id === null) {
      process.stderr.write(
        `${plugin} was marked at ${record.marked_at} by a build that recorded no effect id, ` +
          `so there is nothing to match an answer against, and only a hand edit of the state ` +
          `document clears the record. Nothing was written.\n`,
      )
      return 1
    }
    if (typed !== record.effect_id) {
      process.stderr.write(
        `The effect id given does not match the fire marked at ${record.marked_at} for ${plugin}, ` +
          `whose effect id is ${record.effect_id}. Check the sink for that fire. ` +
          `Nothing was written.\n`,
      )
      return 1
    }

    state.approvals[plugin] = { ...record, not_shipped_at: new Date(now).toISOString() }
    await writeEngineState(state, statePath)
    process.stdout.write(
      `Resolved the fire marked at ${record.marked_at} for ${plugin} (effect id ${record.effect_id}) ` +
        `as not shipped, on your word that nothing reached the sink. The approval now reads spent ` +
        `and fires nothing. To ship those bytes, approve them again: ` +
        `warpline approve ${plugin} --content --not-after <when>.\n`,
    )
    return 0
  })
}
