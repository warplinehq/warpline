/**
 * `warpline deny` — record that a human said no, so the next advance stops
 * asking.
 *
 * Without this there is nowhere for "no" to land. A plugin is skipped for want
 * of a Grant or parked for supervision, and both re-raise on every advance, so
 * the only way to stop being asked is to grant something — which is the
 * opposite of the answer the operator wanted to give.
 *
 * **A denial answers a proposal, not a plugin.** The record carries a
 * fingerprint of what was proposed — the plugin's name, its declared side
 * effects and the Output it produced — and the evaluator recomputes it on every
 * advance. While it matches, the question is not asked. When it moves, the
 * plugin is due again and the returning Ask says a denial existed and the
 * proposal changed. A denial that outlived what it answered would suppress a
 * question nobody has answered.
 *
 * **No module on this path calls anything that writes the session grant file.**
 * That is the claim, and it is narrower than the one this comment used to make.
 * The grant module IS in the transitive graph: the route into
 * `../runtime/engine.js` used here is the manifest loader, the gate lookup and
 * the fingerprint, but `engine.ts` statically imports the approval gate for its
 * READER, and a static import evaluates the whole module. So the writers are
 * loaded. What nothing on the path does is call one.
 *
 * Saying no to an outcome must not move side-effect authority in either
 * direction. A test walks the whole import closure to hold that, because the
 * grep of this one file it replaced would not have seen a call added two
 * modules down — the prohibition would have gone false with every test green.
 * The whole-home snapshot in `deny.test.ts` is the backstop, not the guarantee.
 *
 * **No gesture mutes the fleet.** There is no `--all` and no wildcard: two
 * independent controls make one impossible. `parseArgs({strict: true})` rejects
 * an undeclared flag before any code here runs, and the denials record is keyed
 * by plugin name, so there is no key that could mean every plugin.
 *
 * The order of operations mirrors `approve.ts`, and for the same reason: EVERY
 * positional is validated before anything is written, and one unknown name
 * aborts the whole command with nothing on disk. A half-applied denial would
 * leave the operator believing they had silenced three plugins when they had
 * silenced one.
 *
 * Every denial, and every removal of one, is on the audit record before the
 * state document changes.
 *
 * Denying a live parked result that was a handoff withdraws that run's Handoff
 * record too, after the audit record and before the state write. Every such
 * record is read before anything is written, and one that cannot be read stops
 * the command there. A deny that stops after a withdraw names each record it
 * withdrew. The record stays withdrawn, and the gate stays parked for
 * `approve` or a second `deny` to answer, as any parked result is.
 *
 * **A deny can answer an Ask.** With `--nonce`, `--digest` and `--principal`
 * it answers the open parked-result, missing-Grant or content Ask on the one
 * plugin it names, through the same check `approve` runs, and needs nothing
 * `approve` does not: a no costs what a yes costs. A bare deny refuses while
 * such an Ask is open. `deny --standing <grant-id>` is the no to a standing
 * grant's renewal Ask. It records the Answer and writes nothing else: no
 * standing grant, no state document. Every form but `--list` and `--remove`
 * reads `asks.json` under the state lock and refuses when it cannot be read.
 *
 * Never terminates the process — it returns a code to the dispatcher.
 */
import { parseArgs } from 'node:util'
import { join } from 'node:path'
import { appendAudit } from '../lib/audit-log.js'
import {
  ANSWER_REFUSAL_TEXT,
  asksPath,
  checkAnswer,
  observePreferences,
  openAskFor,
  parseAnswerFlags,
  readAsks,
  readNotify,
  recordAnswer,
  renewalDigest,
  type AnswerFlags,
  type AnswerForm,
  type AnswerRefusal,
  type Ask,
} from '../lib/asks.js'
import { judgePrincipal, observeRegistry, readPrincipal, requirePrincipal } from '../lib/principals.js'
import { readStandingStore } from '../runtime/approval-gate.js'
import { findPendingGate, loadPluginManifests, proposalFingerprint } from '../runtime/engine.js'
import { emitDenialRecorded, emitGateInvalidated } from '../board/engine-events.js'
import { pathsForStateFile, withStateLockAt } from '../board/state-manager.js'
import {
  EngineStateInvalidError,
  readEngineState,
  writeEngineState,
} from '../runtime/engine-state-store.js'
import { DenialSchema } from '../schemas/engine-state.js'
import type { Denial, EngineState } from '../schemas/engine-state.js'
import { engineStatePath, eventsJsonlPath, handoffsDir, pluginsDir, preferencesPath } from '../lib/paths.js'
import { readHandoff, withdrawHandoff } from '../lib/handoffs.js'
import { suggest } from './suggest.js'

const USAGE = `Usage: warpline deny <plugin>... [options]
       warpline deny <plugin> --nonce <hex> --digest <hex> --principal <id>
       warpline deny --standing <grant-id> --nonce <hex> --digest <hex> --principal <id>
       warpline deny --list
       warpline deny --remove <plugin>...

Records that you said no to what a plugin proposed, so the next advance stops
asking. The answer is bound to the proposal: change the plugin's declared side
effects or the Output it produces and the question comes back, saying it was
denied before and that the proposal moved.

There is no blanket denial. A denial covers exactly the plugins you name.

Options:
  --list          Show the live denials and exit.
  --remove        Take the denial back for each named plugin.
  --note <text>   Record why, in your own words.
  --principal <id>  Who is denying: a registered, active principal.
                    Optional, never inferred. Required on an Answer.

Answering an Ask (the same flags approve takes):
  --nonce <hex>   The Ask's nonce, from the notify message.
  --digest <hex>  A prefix of the Ask's digest, at least 12 hex characters.
  --via <id>      The registered machine that relayed the Answer.
  --evidence <ref>  A reference token for the decision.
  --standing <grant-id>  Answer a standing grant's renewal Ask no. Records the
                  Answer and nothing else: the grant lapses at its renewal
                  deadline unless someone renews it.
`

/** A thrown error's errno code, or 'unknown'. Only the code, because a thrown message embeds absolute paths. */
function errnoCode(err: unknown): string {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined
  return typeof code === 'string' ? code : 'unknown'
}

/**
 * The end of a deny that stopped: every record it already withdrew, which
 * stays so, and an Answer it already recorded. It names no command, so no open
 * Ask can make it a refused one.
 */
function stoppedTail(withdrawn: readonly string[], answered: boolean): string {
  const records = withdrawn.map(
    (id) =>
      ` The Handoff record ${id} was withdrawn and stays withdrawn. Its parked result is still parked, and approve or deny answers it.`,
  )
  return records.join('') + (answered ? ' The Answer is on the record, and the next advance asks again.' : '')
}

/** A store that could not be read is never read as "no Asks". */
function refuseUnreadableAsks(statePath: string, cause: string): number {
  process.stderr.write(`deny: ${asksPath(statePath)} cannot be read (${cause}). Nothing was written.\n`)
  return 1
}

/** A bare deny while an Ask is open on what it names. Names the Ask, never its nonce. */
function refuseBare(ask: Ask): number {
  process.stderr.write(
    `deny: ${ask.scope} has an open Ask, ${ask.id}, so a bare deny cannot answer it. ` +
      `Read it with 'warpline approvals show ${ask.id}', then answer it with its --nonce and --digest. ` +
      `Nothing was written.\n`,
  )
  return 1
}

/** An Answer that does not match its Ask: the reason by name, and nothing written. */
function refuseAnswer(reason: AnswerRefusal): number {
  process.stderr.write(`deny: refused (${reason}): ${ANSWER_REFUSAL_TEXT[reason]} Nothing was written.\n`)
  return 1
}

/** The notify read could not be recorded: nothing was written. */
function refuseObserve(refused: string, ending: 'written' | 'denied'): number {
  process.stderr.write(`deny: ${refused}. Nothing was ${ending}.\n`)
  return 1
}

/** `recordAnswer` refused: nothing of the effect was written. */
function refuseRecord(refused: 'audit' | 'store', statePath: string): number {
  process.stderr.write(
    refused === 'audit'
      ? 'The audit store could not record this Answer. Nothing was written.\n'
      : `deny: ${asksPath(statePath)} could not be read or written after the Answer was recorded, so its ` +
          `Ask is still open. The audit record names an Answer whose effect was not written, and nothing ` +
          `else was written.\n`,
  )
  return 1
}

/** Who answered and through what, `--via` judged on the registry the `--principal` check read. */
function answerer(
  actor: Awaited<ReturnType<typeof requirePrincipal>>,
  answer: AnswerFlags,
): { principal: string; via: string | null } | { refused: string } {
  if ('refused' in actor) return { refused: `--principal: ${actor.refused}.` }
  if (actor.id === null) return { refused: '--principal is required on an Answer.' }
  if (answer.via === null) return { principal: actor.id, via: null }
  const judged = judgePrincipal(actor.loaded.registry, answer.via, 'active-machine')
  return 'refused' in judged ? { refused: `--via: ${judged.refused}.` } : { principal: actor.id, via: judged.id }
}

/**
 * Read the state document, or explain why not.
 *
 * Fail-closed on every path, `--list` included. The tolerant read would render
 * an unusable document as "no denials", which is the one wrong answer here: the
 * operator would conclude they had never denied anything and deny it again,
 * against a file that is about to be overwritten.
 */
/**
 * `announceDiscards: false` on a read that will not write. `--list` discards
 * stub gates like every other read, but it never persists the discard — so the
 * notice it emitted was re-emitted on the next `--list`, and the next, until
 * something else wrote state. The policy stays fail-closed: an unusable
 * document must stop this command, not come back as "No denials".
 */
async function loadState(
  statePath: string,
  opts: { announceDiscards?: boolean } = {},
): Promise<EngineState | null> {
  try {
    return await readEngineState(statePath, opts)
  } catch (err) {
    if (!(err instanceof EngineStateInvalidError)) throw err
    process.stderr.write(
      `Cannot read engine state: ${err.reason}\n` +
        `Nothing was written — with the document unreadable there is no way to tell what is ` +
        `already denied, and rewriting it would destroy whatever else it holds.\n`,
    )
    return null
  }
}

function describe(denial: Denial): string {
  const note = denial.note === null ? '' : `\n    note: ${denial.note}`
  return `  ${denial.plugin} — denied ${denial.denied_at}\n    ${denial.reason}${note}`
}

export async function run(argv: string[]): Promise<number> {
  let values: {
    list?: boolean
    remove?: boolean
    note?: string
    principal?: string
    nonce?: string
    digest?: string
    via?: string
    evidence?: string
    standing?: string
  }
  let positionals: string[]
  try {
    // strict: true rejects an undeclared flag — an all-plugins wildcard among
    // them — and a missing or dash-leading --note value, with no hand-rolled
    // scan. The prohibition is delivered by the parser, not by a check of ours.
    const parsed = parseArgs({
      args: argv,
      options: {
        list: { type: 'boolean' },
        remove: { type: 'boolean' },
        note: { type: 'string' },
        principal: { type: 'string' },
        nonce: { type: 'string' },
        digest: { type: 'string' },
        via: { type: 'string' },
        evidence: { type: 'string' },
        standing: { type: 'string' },
      },
      allowPositionals: true,
      strict: true,
    })
    values = parsed.values
    positionals = parsed.positionals
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`)
    return 1
  }

  // Refused first and by name: a flag that vanished would let the operator
  // believe their name went on a record that does not exist.
  if (values.list && values.principal !== undefined) {
    process.stderr.write(
      'deny: --list records nothing, so there is no act for --principal to name. Nothing was written.\n',
    )
    return 1
  }
  if (values.list && (values.remove || positionals.length > 0)) {
    process.stderr.write('--list shows the denials and changes nothing; do not combine it.\n')
    return 1
  }

  // The Answer flags, checked before anything is read.
  if (values.standing !== undefined) {
    const mixed = [
      positionals.length > 0 ? 'a plugin name' : null,
      values.list ? '--list' : null,
      values.remove ? '--remove' : null,
      values.note !== undefined ? '--note' : null,
    ].filter((f): f is string => f !== null)
    if (mixed.length > 0) {
      process.stderr.write(
        `deny: --standing answers a renewal Ask and does nothing else, so ${mixed.join(', ')} cannot go with it. ` +
          `Nothing was written.\n`,
      )
      return 1
    }
    if (values.nonce === undefined) {
      process.stderr.write(
        'deny: --standing answers a renewal Ask and does nothing else, so it needs the Ask\'s --nonce and --digest. ' +
          'Nothing was written.\n',
      )
      return 1
    }
  }
  const answerFlagsGiven = [
    values.nonce !== undefined ? '--nonce' : null,
    values.digest !== undefined ? '--digest' : null,
    values.via !== undefined ? '--via' : null,
    values.evidence !== undefined ? '--evidence' : null,
  ].filter((f): f is string => f !== null)
  if (answerFlagsGiven.length > 0 && (values.list || values.remove)) {
    process.stderr.write(
      `deny: ${answerFlagsGiven.join(', ')} cannot go with ${values.list ? '--list' : '--remove'}: it answers no Ask. ` +
        `Nothing was written.\n`,
    )
    return 1
  }
  const parsedAnswer = parseAnswerFlags(values, values.standing !== undefined ? [values.standing] : positionals)
  if ('refused' in parsedAnswer) {
    process.stderr.write(`deny: ${parsedAnswer.refused} Nothing was written.\n`)
    return 1
  }
  const answer = parsedAnswer.answer
  if (answer !== null && values.principal === undefined) {
    process.stderr.write(
      'deny: --principal is required on an Answer: it names who answered, and one is never inferred. ' +
        'Nothing was written.\n',
    )
    return 1
  }

  if (!values.list && values.standing === undefined && positionals.length === 0) {
    process.stderr.write(USAGE)
    return 1
  }

  const statePath = engineStatePath()
  // The lock that guards THIS document, not whatever the state manager's
  // module paths point at — see `withStateLockAt`.
  const lockPath = pathsForStateFile(statePath).lockPath

  // -- Deny a renewal: the Answer record and nothing else -------------------
  // No standing grant is written and no state document: the grant lapses at
  // its renewal deadline unless someone renews it, and the next advance does
  // not ask again while the grant is unchanged.
  if (values.standing !== undefined && answer !== null) {
    const grantId = values.standing
    return await withStateLockAt(lockPath, async () => {
      // Checked in the hold, so a principal disabled while this waited is refused.
      // Judged without recording: a hand edit goes on the record only once this acts.
      const actor = await readPrincipal(values.principal, 'active')
      const who = answerer(actor, answer)
      // The second test only narrows: answerer admits only a principal it judged.
      if ('refused' in who || !('loaded' in actor)) {
        const why = 'refused' in who ? who.refused : '--principal is required on an Answer.'
        process.stderr.write(`deny: ${why} Nothing was written.\n`)
        return 1
      }
      const asks = await readAsks(statePath)
      if (!asks.readable) return refuseUnreadableAsks(statePath, asks.cause)
      const notify = await readNotify(preferencesPath())
      // The grant as it stands now. A grant gone, or a file that cannot be
      // read, has no live digest, so the Answer refuses as a mismatch.
      const standing = await readStandingStore()
      const grant = standing.readable ? standing.store.grants.find((g) => g.id === grantId) : undefined
      const found = checkAnswer(asks.store, answer, grantId, Date.now(), {
        kinds: ['renewal'],
        liveDigest: () => (grant === undefined ? null : renewalDigest(grant)),
        notify: notify.inUse,
      })
      if ('refused' in found) return refuseAnswer(found.refused)
      // The notify this command judged goes on the record before the Answer.
      const observed = await observePreferences(notify.loaded, statePath)
      if (observed !== null) return refuseObserve(observed.refused, 'written')
      const registryObserved = await observeRegistry(actor.loaded, statePath)
      if (registryObserved !== null) return refuseObserve(`--principal: ${registryObserved.refused}`, 'written')
      const rec = await recordAnswer(statePath, found.ask, {
        answer: 'deny',
        principal: who.principal,
        via: who.via,
        evidence: answer.evidence,
        answeredAt: Date.now(),
      })
      if ('refused' in rec) return refuseRecord(rec.refused, statePath)
      process.stdout.write(
        `Answered the renewal Ask ${found.ask.id} no. Standing grant ${grantId} was not renewed: it lapses at ` +
          `its renewal deadline unless someone renews it. No grant was written.\n`,
      )
      return 0
    })
  }

  // -- List: read, print, write nothing -----------------------------------
  if (values.list) {
    const state = await loadState(statePath, { announceDiscards: false })
    if (state === null) return 1
    const denials = Object.values(state.denials)
    if (denials.length === 0) {
      process.stdout.write('No denials — every plugin will be asked about normally.\n')
      return 0
    }
    process.stdout.write(`${denials.length === 1 ? '1 denial' : `${denials.length} denials`}:\n`)
    for (const denial of denials.sort((a, b) => (a.plugin < b.plugin ? -1 : 1))) {
      process.stdout.write(`${describe(denial)}\n`)
    }
    return 0
  }

  // -- Remove: validated against the denials record, not the manifests -----
  // A plugin uninstalled after it was denied must still be removable, or its
  // record would be unreachable from the CLI for good.
  if (values.remove) {
    // Locked, and the read is inside it: this rewrites the WHOLE state
    // document, so an advance completing between the read and the write would
    // be erased by a command that only meant to forget a denial.
    return await withStateLockAt(lockPath, async () => {
      // Checked in the hold, so a principal disabled while this waited is refused.
      const actor = await requirePrincipal(values.principal, 'active')
      if ('refused' in actor) {
        process.stderr.write(`deny: --principal: ${actor.refused}. Nothing was removed.\n`)
        return 1
      }
      const state = await loadState(statePath)
      if (state === null) return 1

      // `Object.hasOwn`, not `!== undefined`. These names come straight from the
      // operator and are deliberately NOT validated against the manifests, so
      // `--remove toString` arrives here — and on a plain-object record that
      // lookup answers with `Object.prototype.toString`. The guard would not
      // fire, the delete would remove nothing, the state document would be
      // rewritten anyway, and the operator would be told a denial they never had
      // was taken back.
      const missing = positionals.filter((name) => !Object.hasOwn(state.denials, name))
      if (missing.length > 0) {
        for (const name of missing) {
          process.stderr.write(`No denial recorded for ${name}.\n`)
        }
        process.stderr.write('Nothing was removed.\n')
        return 1
      }

      // Every lift is on the audit record before the state document changes.
      for (const plugin of positionals) {
        const stored = state.denials[plugin]!.fingerprint
        try {
          await appendAudit(statePath, 'denial.lifted', {
            plugin,
            fingerprint: /^[0-9a-f]{64}$/.test(stored) ? stored : null,
            principal: actor.id,
          })
        } catch {
          process.stderr.write(
            `The audit store could not record the removal of the denial of ${plugin}. Nothing was removed.\n`,
          )
          return 1
        }
      }

      for (const name of positionals) delete state.denials[name]
      await writeEngineState(state, statePath)
      process.stdout.write(
        `Removed the denial for ${positionals.join(', ')}. ` +
          `${positionals.length === 1 ? 'It' : 'They'} will be asked about again on the next advance.\n`,
      )
      return 0
    })
  }

  // -- Deny --------------------------------------------------------------
  const { manifests, failures } = await loadPluginManifests(pluginsDir())

  // Name validation, all of it, before any write.
  const known = [...manifests.keys()]
  const unknown = positionals.filter((name) => !manifests.has(name))
  if (unknown.length > 0) {
    for (const name of unknown) {
      const broken = failures.find((f) => f.plugin === name)
      if (broken) {
        process.stderr.write(
          `Plugin '${name}' exists but its manifest failed to load: ${broken.error}\n`,
        )
        continue
      }
      const hint = suggest(name, known)
      process.stderr.write(
        hint
          ? `Unknown plugin: ${name} — did you mean '${hint}'?\n`
          : `Unknown plugin: ${name}. Known plugins: ${known.sort().join(', ') || '(none)'}\n`,
      )
    }
    process.stderr.write('Nothing was denied.\n')
    return 1
  }

  const recorded: Denial[] = []
  const discarded: { plugin: string; runId: string }[] = []
  const withdrawn: string[] = []

  // Same reason as `--remove`, and one of its own: this arm also filters
  // `state.pending_gates`, which the advance owns and rewrites wholesale. Both
  // sides writing the whole document is what makes last-writer-wins reachable,
  // so the read moves inside the lock and the write follows it directly.
  //
  // Nothing that waits on a human is in here. The loop decides and prints; the
  // board events go out after the lock is released, below.
  const early = await withStateLockAt(lockPath, async (): Promise<number | null> => {
    // Judged without recording: a hand edit goes on the record only once this acts.
    const actor = await readPrincipal(values.principal, 'active')
    if ('refused' in actor) {
      process.stderr.write(`deny: --principal: ${actor.refused}. Nothing was denied.\n`)
      return 1
    }
    const state = await loadState(statePath)
    if (state === null) return 1

    const now = Date.now()
    const denied_at = new Date(now).toISOString()

    // -- The Ask ---------------------------------------------------------
    // Read in this hold, bare or answering. A store that cannot be read
    // refuses, and a bare deny refuses while an Ask is open on what it names.
    const asks = await readAsks(statePath)
    if (!asks.readable) return refuseUnreadableAsks(statePath, asks.cause)
    // One form per plugin for the bare guard and the Answer. A content Ask
    // binds the producer's proposal; every other kind the plugin's own.
    const notify = await readNotify(preferencesPath())
    const formFor = (plugin: string): AnswerForm => {
      const manifest = manifests.get(plugin)!
      const producer = manifest.approval_class === 'content' ? manifest.dependencies[0] : undefined
      const producerManifest = producer === undefined ? undefined : manifests.get(producer)
      return {
        kinds: ['parked_result', 'missing_grant', 'content'],
        liveDigest: (ask) =>
          ask.kind !== 'content'
            ? proposalFingerprint(state, plugin, manifest)
            : producer === undefined || producerManifest === undefined
              ? null
              : proposalFingerprint(state, producer, producerManifest),
        notify: notify.inUse,
      }
    }
    if (answer === null) {
      for (const plugin of positionals) {
        const open = openAskFor(asks.store, [plugin], now, formFor(plugin))
        if (open !== undefined) return refuseBare(open)
      }
    } else {
      const who = answerer(actor, answer)
      if ('refused' in who) {
        process.stderr.write(`deny: ${who.refused} Nothing was written.\n`)
        return 1
      }
      // Exactly one plugin: parseAnswerFlags refused any other count.
      const found = checkAnswer(asks.store, answer, positionals[0]!, now, formFor(positionals[0]!))
      if ('refused' in found) return refuseAnswer(found.refused)
      // The notify this command judged goes on the record before the Answer.
      const observed = await observePreferences(notify.loaded, statePath)
      if (observed !== null) return refuseObserve(observed.refused, 'written')
      const registryObserved = actor.id === null ? null : await observeRegistry(actor.loaded, statePath)
      if (registryObserved !== null) return refuseObserve(`--principal: ${registryObserved.refused}`, 'written')
      // On the record, and the Ask closed, before any denial is decided or recorded.
      const rec = await recordAnswer(statePath, found.ask, {
        answer: 'deny',
        principal: who.principal,
        via: who.via,
        evidence: answer.evidence,
        answeredAt: Date.now(),
      })
      if ('refused' in rec) return refuseRecord(rec.refused, statePath)
      process.stdout.write(`Answered Ask ${found.ask.id} no.\n`)
    }

    for (const plugin of positionals) {
      const fingerprint = proposalFingerprint(state, plugin, manifests.get(plugin)!)
      // Own-property lookup for the same reason as `--remove` above. The
      // manifest schema already refuses a name off `Object.prototype`, so this
      // holds independently of that rather than duplicating it.
      const existing = Object.hasOwn(state.denials, plugin) ? state.denials[plugin] : undefined

      // Denying twice against an unchanged proposal is a no-op, and observably
      // so: nothing is written, so the state document is byte-identical. The
      // record's key makes duplicates impossible; this makes re-answering
      // visible instead of silently restamping the clock.
      if (existing !== undefined && existing.fingerprint === fingerprint) {
        process.stdout.write(
          `${plugin} is already denied (${existing.denied_at}) and its proposal has not changed. ` +
            `Nothing was written.\n`,
        )
        continue
      }

      // A parked result is what a denial most often answers, so the reason says
      // which run it was. Without one, the operator is answering the standing
      // proposal rather than a specific outcome, and the reason says that.
      //
      // A LIVE gate, not merely a gate: `findPendingGate` returns already-applied
      // markers on purpose, and a marker means the operator ACCEPTED that result.
      // Recording that they declined it puts a false sentence somewhere it is
      // read back — `deny --list` prints it, `emitDenialRecorded` writes it into
      // `events.jsonl`, and the evaluator quotes it on every suppressed advance.
      // A marker now lives up to the gate ceiling, so the window is not a corner.
      const gate = findPendingGate(state, plugin)
      const live = gate !== undefined && gate.applied_at === null
      const reason = live
        ? `the operator declined the parked result from run ${gate.run_id}`
        : 'the operator declined this proposal'

      // **The denied gate is discarded, not merely outranked.** Answering a
      // parked result is what dequeues it, exactly as applying one does — the
      // sentence above says the operator declined that run, and leaving the run
      // sitting in `pending_gates` made that sentence describe something that had
      // not happened.
      //
      // It also cannot legitimately be applied afterwards. While the denial
      // holds, both `approve` arms refuse it. Once the denial is superseded the
      // proposal has moved, which means `plugin_runs.last_output` changed, which
      // means the plugin ran again and a newer gate exists — so the old one
      // answers a question nobody is asking. The only path that ever reached it
      // was `deny --remove`, which would hand back a stale result the operator
      // had already declined, in answer to a question they thought they were
      // re-opening.
      //
      // Nothing a reader depends on is lost. Whatever the park wrote to
      // `plugin_runs[plugin]` stays, `last_output` included, and
      // the run log keeps a summary of the run, never its result.
      // The gate is the review queue, not the record.
      //
      // Only a LIVE gate. A marker is the trace of a result the operator
      // ACCEPTED, and a denial recorded later answers the standing proposal
      // rather than that outcome — discarding it would erase the one thing that
      // stops a second `approve` re-recording an applied result.
      if (live) {
        state.pending_gates = state.pending_gates.filter((g) => g !== gate)
        discarded.push({ plugin, runId: gate.run_id })
      }

      const denial = DenialSchema.parse({
        plugin,
        reason,
        denied_at,
        note: values.note ?? null,
        fingerprint,
      })
      state.denials[plugin] = denial
      recorded.push(denial)
    }

    if (recorded.length === 0) return 0

    // Every record this command will close is read before anything is
    // written. So a file that cannot be read appends no audit record for a
    // denial that does not happen, and writes nothing at all in the bare form.
    // The read decides only whether the command goes on.
    for (const d of discarded) {
      const id = `${d.runId}.${d.plugin}`
      try {
        await readHandoff(handoffsDir(), d.runId, d.plugin)
      } catch (err: unknown) {
        process.stderr.write(
          `deny: the Handoff record ${id} could not be read (${errnoCode(err)}), so no denial was recorded.` +
            (answer === null ? ' Nothing was written.' : stoppedTail([], true)) +
            ` Deny again once ${join(handoffsDir(), `${id}.json`)} reads as a Handoff record or is no longer there.\n`,
        )
        return 1
      }
    }

    // A bare deny records the notify and the registry it judged before its
    // first denial record. An Answer already recorded them with the Answer.
    if (answer === null) {
      const observed = await observePreferences(notify.loaded, statePath)
      if (observed !== null) return refuseObserve(observed.refused, 'denied')
      const registryObserved = actor.id === null ? null : await observeRegistry(actor.loaded, statePath)
      if (registryObserved !== null) return refuseObserve(`--principal: ${registryObserved.refused}`, 'denied')
    }

    // Each denial is on the audit record before the state document changes,
    // one record per plugin, in order. The note is operator free text and
    // never enters a record. A record that cannot be written stops the command
    // here, before the write, so nothing is denied.
    for (const denial of recorded) {
      const gone = discarded.find((d) => d.plugin === denial.plugin)
      try {
        await appendAudit(statePath, 'denial.recorded', {
          plugin: denial.plugin,
          fingerprint: denial.fingerprint,
          discarded_gate_run_id: gone?.runId ?? null,
          principal: actor.id,
        })
      } catch {
        process.stderr.write(
          answer === null
            ? `The audit store could not record the denial of ${denial.plugin}. Nothing was denied.\n`
            : `The audit store could not record the denial of ${denial.plugin}, so nothing was denied. The Answer is on the record, and the next advance asks again.\n`,
        )
        return 1
      }
    }

    // A parked handoff's record closes after the audit records, each of which
    // names the run whose gate it discards, and before the state write. So a
    // deny that succeeds never leaves the denied run's record open. One that
    // stops after a close leaves that record withdrawn beside a parked gate.
    // That is the safe side, because nothing routes a run the operator tried
    // to deny. The gate is then answered as any parked result is, so the
    // failure lines name the record and no command.
    for (const d of discarded) {
      try {
        if (await withdrawHandoff(handoffsDir(), d.runId, d.plugin, denied_at)) withdrawn.push(`${d.runId}.${d.plugin}`)
      } catch (err: unknown) {
        process.stderr.write(
          `deny: the Handoff record ${d.runId}.${d.plugin} could not be closed (${errnoCode(err)}), so no denial was recorded.${stoppedTail(withdrawn, answer !== null)}\n`,
        )
        return 1
      }
    }

    try {
      await writeEngineState(state, statePath)
    } catch (err: unknown) {
      process.stderr.write(
        `deny: the state document could not be written (${errnoCode(err)}), so no denial was recorded.${stoppedTail(withdrawn, answer !== null)}\n`,
      )
      throw err
    }
    return null
  })
  if (early !== null) return early

  const eventsPath = eventsJsonlPath()
  for (const denial of recorded) {
    // Best-effort: a notice that cannot be written must not fail a denial that
    // is already on disk.
    await emitDenialRecorded(denial.plugin, denial.reason, denial.fingerprint, eventsPath).catch(
      () => {},
    )
    // The gate discard is its own event, not an implication of the denial one.
    // Every other discard path emits it, and a parked result that vanishes with
    // no board trace is a state change only whoever was watching stdout can
    // know about — the operator tomorrow reads the board.
    const gone = discarded.find((d) => d.plugin === denial.plugin)
    if (gone !== undefined) {
      await emitGateInvalidated(gone.plugin, gone.runId, 'denied', eventsPath).catch(() => {})
    }
    // Say that the result is gone, because it is. The operator declined a
    // specific run and that run is no longer applyable by any gesture — a
    // consequence they cannot see from the state file and should not discover
    // later from a `deny --remove` that hands back nothing.
    const dropped = discarded.some((d) => d.plugin === denial.plugin)
      ? `The parked result was discarded — taking the denial back will let ${denial.plugin} be ` +
        `asked fresh, not re-offer that run. `
      : ''
    const id = gone === undefined ? undefined : `${gone.runId}.${gone.plugin}`
    const closed = id !== undefined && withdrawn.includes(id) ? `Its Handoff record ${id} was withdrawn. ` : ''
    process.stdout.write(
      `Denied ${denial.plugin}: ${denial.reason}\n` +
        `It will not be asked about again while it proposes the same thing. ` +
        `${dropped}${closed}No grant was written or cleared.\n`,
    )
  }

  return 0
}
