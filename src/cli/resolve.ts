/**
 * `warpline resolve` — answer a content fire the runtime could not confirm.
 *
 * Before a content consumer's handler runs, the runtime marks its approval
 * with an effect id and the fire instant. When the advance sees the handler
 * finish, it confirms the mark. A handler that returns `failed`, or a process
 * that dies mid-call, leaves the mark unconfirmed, and the approval reads
 * `indeterminate` on every advance after: the runtime cannot see the sink, so
 * it cannot tell whether the bytes arrived, and it never takes a handler's word
 * either way. The operator can look. This is where they say what they found:
 * the bytes shipped, or nothing did.
 *
 * **Its own verb, because it grants nothing.** `approve` has three modes and
 * every one is a yes about something to come: a parked result applied, a
 * session grant, bytes that may ship. This answers a claim about a fire that
 * already began, identified by its effect id, and it authorises no fire at
 * all. The answered record reads `spent`, so shipping those bytes after all
 * takes a fresh `approve --content`, over bytes the operator reads again.
 *
 * **The answer is the operator's word, and the record says so.** It is
 * written as `shipped_at` or `not_shipped_at` beside the mark, which stays,
 * and it never touches `confirmed_at`: that field is the advance's account of
 * a fire it saw finish, and this is a different fact from a different witness. No board
 * event and no run-log entry is written. The state document is where the
 * answer lives.
 *
 * **Refusal order is the security property**, as it is in `approve.ts`. Every
 * check runs before any mutation, and every check that reads the document runs
 * inside the state lock, so a refused command leaves the document
 * byte-unchanged. "Indeterminate" is never re-derived here: the verb reads
 * `approvalStanding`, the one authority read, and answers only what it calls
 * `indeterminate`, so a record that already holds an answer refuses a second
 * one, either way round. When the state write after the answer did not land,
 * the record still reads `indeterminate`, and the audit store lookup below
 * refuses the other answer instead. No operator-typed text is echoed, the plugin name included:
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
 * on this machine, is the crashed advance the verb exists for. The exception is
 * a silent holder this machine can see is still alive: a suspended or blocked
 * advance stops its heartbeat while its fire can still land, so a live pid on
 * this machine blocks whatever the lock's age. The cost: the
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
 * **The answer is on the audit record first**, as `fire.resolved` with
 * `answer: shipped` or `not_shipped`, and it closes the fire intent it answers.
 * Before the append, the store is read for an earlier `fire.resolved` with this
 * plugin and effect id. The other answer is refused. The same answer is not
 * appended again, so running a command whose state write did not land again
 * finishes it, with only the state document written. This lookup can only
 * refuse an answer or skip a duplicate record, and never lets anything fire. A
 * store that cannot be read for it refuses the answer. The open intent is
 * looked up only to name its seq in the record. A store that cannot take the
 * record refuses the answer, with nothing written. A state write that fails
 * after the record landed says the answer is there and names the command that
 * finishes it, and prints nothing from the error.
 *
 * **Any open fire intent is answered by its seq**, with `--intent <seq>` and
 * `--shipped` or `--not-shipped`. That covers what the form above cannot: a
 * session fire, and a content fire whose outcome was lost after its mark was
 * confirmed. This form reads the audit store, because the open intent is the
 * thing it answers, and a seq that is not open is refused. It authorises no
 * fire, never writes the state document, and appends one `fire.resolved`
 * carrying the intent's plugin, effect id and seq and the operator's answer,
 * and nothing else. One case it hands back: a content fire still marked and
 * unconfirmed under the same effect id is answered only by the form above,
 * either way, because that form is the one writer of both answer fields and
 * closes the same intent. Both forms check the run lock first, by the same
 * function, for the same reason.
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
import { deriveHost, isLockStale, isProcessAlive, readLock } from '../runtime/lock.js'
import { engineStatePath, lockPath as runLockPath, pluginsDir } from '../lib/paths.js'
import { AuditAppendError, appendAudit, openIntents, readCompleteLines, type OpenIntent } from '../lib/audit-log.js'

const USAGE = `Usage: warpline resolve <plugin> --shipped|--not-shipped <effect-id>
       warpline resolve --intent <seq> --shipped|--not-shipped

The first answers a content fire that was marked and never confirmed, after you
checked the sink with its effect id: --shipped when the bytes reached it,
--not-shipped when nothing did. Either way the approval then reads spent and
fires nothing. To fire those bytes again, approve them again:
warpline approve <plugin> --content --not-after <when>.

The second answers any fire intent the audit record still lists as open, after
you checked whether its effect happened. It records your answer and nothing else.
`

/**
 * The run-lock refusal both forms make first, inside the state lock. Prints
 * the reason and returns true when it refused.
 */
async function refusedByRunLock(): Promise<boolean> {
  // The run lock first, before the clock or the document. An advance marks a
  // fire only while it holds the run lock, and only under the state lock the
  // caller holds, so a live lock seen here is the one window in which a
  // marked fire may still be in flight, and none can open before the write.
  // Only `acquired_at` is printed: a runtime-written instant, never a path.
  const held = await readLock(runLockPath())
  // `isLockStale` is the heal predicate: it answers on age before it reads
  // the pid. A live holder on this machine can go silent past the window,
  // suspended or blocked in a handler, with its fire still able to land, so
  // here a pid this machine can see alive outranks the age.
  const aliveHere =
    held !== null &&
    held.pid !== null &&
    held.host != null &&
    held.host === deriveHost() &&
    isProcessAlive(held.pid)
  if (held !== null && (aliveHere || !isLockStale(held))) {
    process.stderr.write(
      `An advance is running (it took the run lock at ${held.acquired_at}), so a fire it marked ` +
        `may still be in flight and the sink cannot answer for it yet. Resolve it after the ` +
        `advance ends. Nothing was written.\n`,
    )
    return true
  }
  // `readLock` says null for an absent file and for one that is not a lock.
  // Only the first is known to be no advance.
  if (held === null && existsSync(runLockPath())) {
    process.stderr.write(
      `The run lock could not be read back as a lock, so whether an advance is still firing ` +
        `cannot be told. Nothing was written.\n`,
    )
    return true
  }
  return false
}

/** The open intents, or null once the refusal is printed. */
async function openIntentsOrRefuse(statePath: string): Promise<OpenIntent[] | null> {
  try {
    return await openIntents(statePath)
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    process.stderr.write(`The audit store's open intents could not be read (${why}). Nothing was written.\n`)
    return null
  }
}

/** The refusal for a `fire.resolved` the store did not take. */
function refuseAppend(err: unknown): number {
  process.stderr.write(
    err instanceof AuditAppendError
      ? `The audit store could not record this answer: ${err.reason}. Nothing was written.\n`
      : 'The audit store could not record this answer. Nothing was written.\n',
  )
  return 1
}

type Answer = 'shipped' | 'not_shipped'

/**
 * The answer an earlier `fire.resolved` gave this plugin's fire with this
 * effect id, or null when the store holds none. A line that does not parse
 * carries no answer anyone can read, and verify reports it, so it is skipped.
 * Throws when the store cannot be read: the caller refuses on that.
 */
// ponytail: reads every segment once per answer, which a rare operator command
// can afford. An answered-effect set carried in `segment.opened` is the upgrade path.
async function answerOnRecord(statePath: string, plugin: string, effectId: string): Promise<Answer | null> {
  for await (const line of readCompleteLines(statePath, 0)) {
    let rec: { type?: unknown; data?: { plugin?: unknown; effect_id?: unknown; answer?: unknown } } | null
    try {
      rec = JSON.parse(line.toString('utf-8'))
    } catch {
      continue
    }
    if (
      rec?.type === 'warpline.audit.fire.resolved' &&
      rec.data?.plugin === plugin &&
      rec.data.effect_id === effectId &&
      (rec.data.answer === 'shipped' || rec.data.answer === 'not_shipped')
    ) {
      return rec.data.answer
    }
  }
  return null
}

/** An answer as a sentence says it. */
const spoken = (a: Answer): string => (a === 'shipped' ? 'shipped' : 'not shipped')

/** The state document, or null once the refusal is printed. */
async function stateOrRefuse(statePath: string): Promise<EngineState | null> {
  try {
    return await readEngineState(statePath)
  } catch (err) {
    if (!(err instanceof EngineStateInvalidError)) throw err
    process.stderr.write(`Cannot read engine state: ${err.reason}\nNothing was written.\n`)
    return null
  }
}

export async function run(argv: string[]): Promise<number> {
  if (argv.some((a) => a === '--intent' || a.startsWith('--intent='))) return runBySeq(argv)
  let values: { shipped?: string; 'not-shipped'?: string }
  let positionals: string[]
  try {
    // strict: true, so any other flag is refused by the parser rather than
    // ignored. A flag that vanishes silently is a lie about what was answered.
    const parsed = parseArgs({
      args: argv,
      options: { shipped: { type: 'string' }, 'not-shipped': { type: 'string' } },
      allowPositionals: true,
      strict: true,
    })
    values = parsed.values
    positionals = parsed.positionals
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`)
    return 1
  }

  if (values.shipped === undefined && values['not-shipped'] === undefined) {
    process.stderr.write(USAGE)
    return 1
  }
  if (values.shipped !== undefined && values['not-shipped'] !== undefined) {
    process.stderr.write(
      `resolve takes one answer, --shipped or --not-shipped, not both. Nothing was written.\n\n${USAGE}`,
    )
    return 1
  }
  const shipped = values.shipped !== undefined
  const typed = (values.shipped ?? values['not-shipped'])!
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
    if (await refusedByRunLock()) return 1

    // Read once the lock is held: the standing and the answer instant are
    // about the document this write replaces.
    const now = Date.now()
    const state = await stateOrRefuse(statePath)
    if (state === null) return 1

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

    // The answer lives on the store, so uniqueness is checked there: a state
    // write that did not land leaves the record indeterminate with the answer
    // already recorded. This can only refuse or skip a duplicate record.
    const answer: Answer = shipped ? 'shipped' : 'not_shipped'
    let earlier: Answer | null
    try {
      earlier = await answerOnRecord(statePath, plugin, record.effect_id)
    } catch {
      process.stderr.write(
        'The audit store could not be read, so whether this fire was already answered cannot be told. ' +
          'Nothing was written.\n',
      )
      return 1
    }
    const fired = `the fire marked at ${record.marked_at} for ${plugin} (effect id ${record.effect_id})`
    if (earlier !== null && earlier !== answer) {
      process.stderr.write(
        `The fire marked at ${record.marked_at} for ${plugin} (effect id ${record.effect_id}) was already ` +
          `answered ${spoken(earlier)} on the audit record, so it cannot also be answered ` +
          `${spoken(answer)}. Nothing was written.\n`,
      )
      return 1
    }

    if (earlier === null) {
      // Bookkeeping, never a decision input: every check above has already
      // accepted the answer, and the lookup only names the intent it closes.
      const open = await openIntentsOrRefuse(statePath)
      if (open === null) return 1
      const answered = open.find((i) => i.plugin === plugin && i.effect_id === record.effect_id)
      try {
        await appendAudit(statePath, 'fire.resolved', {
          plugin,
          effect_id: record.effect_id,
          intent_seq: answered?.seq ?? null,
          answer,
        })
      } catch (err) {
        return refuseAppend(err)
      }
    }

    // The answer field only, never `confirmed_at`: that is the advance's.
    state.approvals[plugin] = shipped
      ? { ...record, shipped_at: new Date(now).toISOString() }
      : { ...record, not_shipped_at: new Date(now).toISOString() }
    try {
      await writeEngineState(state, statePath)
    } catch {
      // Never the error's text: raw fs messages carry paths. The flag is the
      // one given and the id the recorded one, never the typed text.
      process.stderr.write(
        `Your answer is on the audit record, but the state document could not be written, so ` +
          `${plugin} still reads indeterminate. Run the same command again to finish it: ` +
          `warpline resolve ${plugin} ${shipped ? '--shipped' : '--not-shipped'} ${record.effect_id}.\n`,
      )
      return 1
    }
    const already =
      earlier === null ? '' : ' The answer was already on the audit record, so only the state document was written.'
    process.stdout.write(
      shipped
        ? `Resolved ${fired} as shipped, on your word that it reached the sink. The approval now ` +
            `reads spent and fires nothing. To fire again, approve the bytes again: ` +
            `warpline approve ${plugin} --content --not-after <when>.${already}\n`
        : `Resolved ${fired} as not shipped, on your word that nothing reached the sink. The approval ` +
            `now reads spent and fires nothing. To ship those bytes, approve them again: ` +
            `warpline approve ${plugin} --content --not-after <when>.${already}\n`,
    )
    return 0
  })
}

/** A malformed by-seq form: one line of reason, then the usage. */
function bySeqUsage(reason: string): number {
  process.stderr.write(`${reason}\n\n${USAGE}`)
  return 1
}

/**
 * `resolve --intent <seq> --shipped|--not-shipped`: close one open fire intent
 * on the record, with the operator's answer. Every check runs before the one
 * append, and the state document is never written.
 */
async function runBySeq(argv: string[]): Promise<number> {
  let values: { intent?: string; shipped?: boolean; 'not-shipped'?: boolean }
  let positionals: string[]
  try {
    const parsed = parseArgs({
      args: argv,
      options: { intent: { type: 'string' }, shipped: { type: 'boolean' }, 'not-shipped': { type: 'boolean' } },
      allowPositionals: true,
      strict: true,
    })
    values = parsed.values
    positionals = parsed.positionals
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`)
    return 1
  }

  // No refusal below repeats the typed seq: it is operator text.
  if (positionals.length > 0) {
    return bySeqUsage('resolve --intent names an intent by its seq alone, so it takes no plugin name.')
  }
  if (argv.filter((a) => a === '--intent' || a.startsWith('--intent=')).length !== 1) {
    return bySeqUsage('resolve --intent answers one intent, so it takes one seq.')
  }
  if ((values.shipped === true) === (values['not-shipped'] === true)) {
    return bySeqUsage('resolve --intent takes exactly one answer: --shipped or --not-shipped.')
  }
  const typed = values.intent ?? ''
  const seq = Number(typed)
  if (!/^[1-9][0-9]*$/.test(typed) || !Number.isSafeInteger(seq)) {
    return bySeqUsage('The seq after --intent is a positive whole number, as audit verify prints it.')
  }
  const shipped = values.shipped === true

  const statePath = engineStatePath()
  const lockPath = pathsForStateFile(statePath).lockPath

  return await withStateLockAt(lockPath, async () => {
    if (await refusedByRunLock()) return 1

    const open = await openIntentsOrRefuse(statePath)
    if (open === null) return 1
    const intent = open.find((i) => i.seq === seq)
    if (intent === undefined) {
      process.stderr.write(
        'No open fire intent has that seq, so there is nothing to answer. ' +
          'warpline audit verify lists the open ones. Nothing was written.\n',
      )
      return 1
    }

    // A content intent whose approval still reads indeterminate under the same
    // effect id is the content form's to answer, either way: it is the one
    // writer of both answer fields. The plugin and effect id printed come from
    // the record, which the walk checked.
    if (intent.effect_id !== null) {
      const state = await stateOrRefuse(statePath)
      if (state === null) return 1
      let stillMarked = false
      if (Object.hasOwn(state.approvals, intent.plugin)) {
        const { manifests } = await loadPluginManifests(pluginsDir())
        const standing = approvalStanding(state, intent.plugin, manifests, Date.now())
        stillMarked = standing.standing === 'indeterminate' && standing.approval.effect_id === intent.effect_id
      }
      if (stillMarked) {
        process.stderr.write(
          `That intent is a content fire for ${intent.plugin} still marked and unconfirmed. Answer it ` +
            `with warpline resolve ${intent.plugin} --shipped ${intent.effect_id} or ` +
            `warpline resolve ${intent.plugin} --not-shipped ${intent.effect_id}, which records the ` +
            `answer in the state document too and closes this intent. Nothing was written.\n`,
        )
        return 1
      }
    }

    try {
      await appendAudit(statePath, 'fire.resolved', {
        plugin: intent.plugin,
        effect_id: intent.effect_id,
        intent_seq: intent.seq,
        answer: shipped ? 'shipped' : 'not_shipped',
      })
    } catch (err) {
      return refuseAppend(err)
    }

    process.stdout.write(
      `Closed fire intent ${intent.seq} for ${intent.plugin} (run ${intent.run_id}) as ` +
        `${shipped ? 'shipped' : 'not shipped'}, on your word. The audit record keeps the intent and this answer.\n`,
    )
    return 0
  })
}
