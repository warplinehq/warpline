/**
 * `warpline renew <grant-id> --principal <human-id>` — restart a standing
 * grant's renewal period from now.
 *
 * Renew moves `period_start` and nothing else. The hard maximum is measured
 * from `issued_at`, which issue fixed, so no number of renewals moves it.
 *
 * Only a named active human renews: never the machine that holds the grant,
 * and never a principal read from the environment or the account running the
 * command. The id comes from `--principal` and from nowhere else.
 *
 * No lapsed grant is renewed, final or not. The gate's renew transform refuses
 * with a code, and this file owns the words for each code. A lapse the gate
 * marks final is one no verb clears, and the refusal says how a new grant is
 * issued. (A hand edit that writes a holder back into principals.json does
 * clear `holder not registered`, so the refusal never says "cannot".)
 * Any other lapse clears, with no renewal, if principals.json names the holder
 * an active machine before the grant's next expiry, and the refusal prints
 * that moment.
 *
 * Order, inside one state-lock hold: check the renewer, read the standing
 * grants file, read `asks.json`, run the transform, append `grant.renewed`,
 * and only then write the file. A failed append renews nothing.
 *
 * **A renew can answer a renewal Ask**, with the flags `approve` takes and the
 * same check. The live digest is the stored grant's, so a grant renewed since
 * the Ask was raised refuses as `digest mismatch`. `ask.answered` is on the
 * record before `grant.renewed`. A bare renew refuses while a renewal Ask is
 * open on the grant, and every form refuses when `asks.json` cannot be read.
 *
 * Never terminates the process — it returns a code to the dispatcher.
 */
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { parseArgs } from 'node:util'
import { pathsForStateFile, withStateLockAt } from '../board/state-manager.js'
import { appendAudit } from '../lib/audit-log.js'
import { engineStatePath, preferencesPath } from '../lib/paths.js'
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
  type AnswerForm,
  type Ask,
} from '../lib/asks.js'
import { judgePrincipal, requirePrincipal, standingRegistry } from '../lib/principals.js'
import {
  readStandingStore,
  renewStanding,
  writeStandingStore,
  type RenewRefusal,
  type StandingGrant,
} from '../runtime/approval-gate.js'

export const USAGE = `Usage: warpline renew <grant-id> --principal <human-id>
       warpline renew <grant-id> --nonce <hex> --digest <hex> --principal <human-id> [--via <id>] [--evidence <ref>]

Restarts a live standing grant's renewal period from now. The hard maximum never moves.
A lapsed grant is never renewed; the refusal says whether the lapse is final or can still clear.

Answering a renewal Ask (the same flags approve takes):
  --nonce <hex>     The Ask's nonce, from the notify message.
  --digest <hex>    A prefix of the Ask's digest, at least 12 hex characters.
  --via <id>        The registered machine that relayed the Answer.
  --evidence <ref>  A reference token for the decision.
`

/** The one re-issue sentence, word for word wherever a final lapse is named. */
const REISSUE = 'approve --standing issues a new grant with a new id; the lapsed one stays until revoked'

const iso = (ms: number): string => new Date(ms).toISOString()

/**
 * The sentence for each code the gate's renew transform can refuse with. A
 * lapse is worded from `final` alone: the gate owns which reasons cannot
 * clear. The reason is the gate's own word, never a value from the command.
 */
function renewRefusalText(refusal: RenewRefusal, grant?: StandingGrant): string {
  switch (refusal.code) {
    case 'unknown-id':
      return 'no standing grant has that id'
    case 'holder-renews':
      return 'the holder cannot renew its own grant'
    case 'lapsed': {
      if (refusal.final) return `the grant has lapsed (${refusal.reason}), and no verb clears the lapse. ${REISSUE}`
      // A lapse is only ever read from a stored grant, so the grant is here.
      const g = grant!
      // The next expiry: after a late renewal pushed the renewal deadline past
      // the hard maximum, the hard maximum is the moment the lapse can clear by.
      const end = Math.min(Date.parse(g.period_start) + g.period_ms, Date.parse(g.issued_at) + g.hard_max_ms)
      // The read keeps period_start at or before the hard maximum, so this moment comes first.
      if (refusal.reason === 'future dated') {
        return `the grant has lapsed (future dated). It clears when the clock reaches ${g.period_start}, and is final after ${iso(end)}`
      }
      const clears = 'It clears if principals.json names its holder an active machine before'
      return `the grant has lapsed (${refusal.reason}). ${clears} ${iso(end)}, and is final after that`
    }
    default: {
      // A code added to the union without a sentence fails typecheck here.
      const unmapped: never = refusal
      return unmapped
    }
  }
}

export async function run(argv: string[]): Promise<number> {
  let values: { principal?: string; nonce?: string; digest?: string; via?: string; evidence?: string }
  let positionals: string[]
  try {
    ;({ values, positionals } = parseArgs({
      args: argv,
      options: {
        principal: { type: 'string' },
        nonce: { type: 'string' },
        digest: { type: 'string' },
        via: { type: 'string' },
        evidence: { type: 'string' },
      },
      allowPositionals: true,
      strict: true,
    }))
  } catch (err) {
    // parseArgs refuses an unknown flag or a misplaced value.
    if (!(err instanceof TypeError) || !('code' in err) || !String(err.code).startsWith('ERR_PARSE_ARGS')) throw err
    process.stderr.write(`renew: ${err.message}\n\n${USAGE}`)
    return 1
  }
  const [id, ...extra] = positionals
  if (id === undefined || extra.length > 0) {
    process.stderr.write(USAGE)
    return 1
  }

  const refuse = (sentence: string): number => {
    process.stderr.write(`renew: ${sentence} Nothing was renewed.\n`)
    return 1
  }
  // The Answer flags, checked before anything is read.
  const parsedAnswer = parseAnswerFlags(values, [id])
  if ('refused' in parsedAnswer) return refuse(parsedAnswer.refused)
  const answer = parsedAnswer.answer
  if (values.principal === undefined) {
    return refuse('--principal is required: a named human renews a standing grant.')
  }

  const statePath = engineStatePath()
  const lockPath = pathsForStateFile(statePath).lockPath
  await mkdir(dirname(lockPath), { recursive: true })

  return await withStateLockAt(lockPath, async (): Promise<number> => {
    // Checked in the hold, so a principal disabled while this waited is refused.
    const actor = await requirePrincipal(values.principal, 'active-human')
    if ('refused' in actor) return refuse(`--principal: ${actor.refused}.`)
    // The flag was present above, so the check resolved an id.
    if (actor.id === null) throw new Error('unreachable: --principal resolved no id')
    // The registry the check recorded. A second read could see a hand edit the store never did.
    const view = standingRegistry(actor.loaded)

    const read = await readStandingStore()
    if (!read.readable) return refuse('the standing grants file cannot be read.')

    const now = Date.now()

    // -- The Ask ---------------------------------------------------------
    // Read in this hold, bare or answering. A store that cannot be read is
    // never read as "no Asks".
    const asks = await readAsks(statePath)
    if (!asks.readable) {
      process.stderr.write(`renew: ${asksPath(statePath)} cannot be read (${asks.cause}). Nothing was renewed.\n`)
      return 1
    }
    // One renewal form over the grant as it stands now, for the bare guard and
    // the Answer: one renewed since the Ask was raised has moved its digest.
    const notify = await readNotify(preferencesPath())
    const stored = read.store.grants.find((g) => g.id === id)
    const form: AnswerForm = {
      kinds: ['renewal'],
      liveDigest: () => (stored === undefined ? null : renewalDigest(stored)),
      notify: notify.inUse,
    }
    let answered: { ask: Ask; via: string | null; evidence: string | null } | null = null
    if (answer === null) {
      const open = openAskFor(asks.store, [id], now, form)
      if (open !== undefined) {
        return refuse(
          `${id} has an open Ask, ${open.id}, so a bare renew cannot answer it. Read it with ` +
            `'warpline approvals show ${open.id}', then answer it with its --nonce and --digest.`,
        )
      }
    } else {
      let via: string | null = null
      if (answer.via !== null) {
        // The registry the --principal check read, never a second read.
        const judged = judgePrincipal(actor.loaded.registry, answer.via, 'active-machine')
        if ('refused' in judged) return refuse(`--via: ${judged.refused}.`)
        via = judged.id
      }
      const found = checkAnswer(asks.store, answer, id, now, form)
      if ('refused' in found) return refuse(`refused (${found.refused}): ${ANSWER_REFUSAL_TEXT[found.refused]}`)
      answered = { ask: found.ask, via, evidence: answer.evidence }
    }

    const change = renewStanding(read.store, id, actor.id, now, view)
    if ('refused' in change) {
      return refuse(`${renewRefusalText(change.refused, read.store.grants.find((g) => g.id === id))}.`)
    }
    const grant = change.store.grants.find((g) => g.id === id)!
    const renewalDeadline = iso(now + grant.period_ms)
    const hardMaxAt = Date.parse(grant.issued_at) + grant.hard_max_ms
    const hardMax = iso(hardMaxAt)
    // A renewal near the hard maximum sets a deadline past it, and the grant lapses at the earlier.
    const nextExpiry = iso(Math.min(now + grant.period_ms, hardMaxAt))

    // The notify this command judged goes on the record before anything is written.
    const observed = await observePreferences(notify.loaded, statePath)
    if (observed !== null) return refuse(`${observed.refused}.`)

    // The Answer is on the record, and its Ask closed, before the renewal's own record.
    if (answered !== null) {
      const rec = await recordAnswer(statePath, answered.ask, {
        answer: 'renew',
        principal: actor.id,
        via: answered.via,
        evidence: answered.evidence,
        answeredAt: Date.now(),
      })
      if ('refused' in rec) {
        return refuse(
          rec.refused === 'audit'
            ? 'the audit store could not record this Answer.'
            : `${asksPath(statePath)} could not be read or written after the Answer was recorded, so its Ask ` +
                `is still open. The audit record names an Answer whose effect was not written.`,
        )
      }
    }

    try {
      await appendAudit(statePath, 'grant.renewed', {
        id,
        holder: grant.holder,
        principal: actor.id,
        renewal_deadline: renewalDeadline,
      })
    } catch {
      process.stderr.write('The audit store could not record this renewal, so nothing was renewed.\n')
      return 1
    }

    try {
      await writeStandingStore(change.store)
    } catch {
      process.stderr.write(
        'renew: the standing grants file could not be written. The audit record names a renewal that did not happen.\n',
      )
      return 1
    }

    process.stdout.write(
      `Renewed ${id}, held by ${grant.holder}: renewal deadline ${renewalDeadline}, hard maximum ${hardMax}, next expiry ${nextExpiry}.\n`,
    )
    return 0
  })
}
