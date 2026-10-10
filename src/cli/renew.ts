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
 * marks final cannot clear, and the refusal says how a new grant is issued.
 * Any other lapse clears, with no renewal, if principals.json names the holder
 * an active machine before the grant's next expiry, and the refusal prints
 * that moment.
 *
 * Order, inside one state-lock hold: check the renewer, read the standing
 * grants file, run the transform, append `grant.renewed`, and only then write
 * the file. A failed append renews nothing.
 *
 * Never terminates the process — it returns a code to the dispatcher.
 */
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { parseArgs } from 'node:util'
import { pathsForStateFile, withStateLockAt } from '../board/state-manager.js'
import { appendAudit } from '../lib/audit-log.js'
import { engineStatePath } from '../lib/paths.js'
import { requirePrincipal, standingRegistry } from '../lib/principals.js'
import {
  readStandingStore,
  renewStanding,
  writeStandingStore,
  type RenewRefusal,
  type StandingGrant,
} from '../runtime/approval-gate.js'

export const USAGE = `Usage: warpline renew <grant-id> --principal <human-id>

Restarts a live standing grant's renewal period from now. The hard maximum never moves.
A lapsed grant is never renewed; the refusal says whether the lapse is final or can still clear.
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
      if (refusal.final) return `the grant has lapsed (${refusal.reason}), and the lapse cannot clear. ${REISSUE}`
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
  let values: { principal?: string }
  let positionals: string[]
  try {
    ;({ values, positionals } = parseArgs({
      args: argv,
      options: { principal: { type: 'string' } },
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
