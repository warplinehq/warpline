/**
 * `warpline revoke` — clear the session approval, or revoke standing grants.
 *
 * Three forms:
 * - bare `revoke` clears the session grant and never reads or writes the
 *   standing grants file;
 * - `revoke --holder <principal-id>` revokes every standing grant that one
 *   principal holds, and no other;
 * - `revoke --standing <grant-id>` revokes one standing grant by its id.
 *
 * Every form takes an optional `--principal`, who is revoking. It is checked
 * against principals.json and recorded as `principal` on `grant.revoked`. A
 * claim the registry could not confirm is recorded apart, as
 * `principal_unchecked`, so `principal` always means checked.
 *
 * Every form holds the state lock, as every writer of an authority file does.
 * Inside the hold: check the actor, read the standing grants file, run the
 * gate's revoke transform, append `grant.revoked`, and only then write.
 *
 * A revoke only narrows authority, so a failing audit store or registry
 * observation never blocks one: the grant goes anyway and the command exits
 * 70. The standing grants file is never deleted; with no grants left it holds
 * an empty list.
 *
 * Never terminates the process — it returns a code to the dispatcher.
 */
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { parseArgs } from 'node:util'
import { pathsForStateFile, withStateLockAt } from '../board/state-manager.js'
import { appendAudit, type AuditData } from '../lib/audit-log.js'
import { PRINCIPAL_ID, readRegistry, requirePrincipal } from '../lib/principals.js'
import {
  liveGrantScopes,
  readStandingStore,
  revokeApproval,
  revokeStanding,
  writeStandingStore,
  type RevokeRefusal,
  type StandingUnreadableCause,
} from '../runtime/approval-gate.js'
import { EXIT_AUDIT_FAILED } from '../runtime/exit-codes.js'
import { syncInstalled, syncRemoved } from '../lib/fs-atomic.js'
import { engineStatePath, sessionApprovalPath, standingGrantsPath } from '../lib/paths.js'

export const USAGE = `Usage: warpline revoke [--principal <id>]
       warpline revoke --holder <principal-id> [--principal <id>]
       warpline revoke --standing <grant-id> [--principal <id>]

With no form flag, clears the session approval and never touches a standing grant.

  --holder <principal-id>  Revoke every standing grant one principal holds, and no other.
  --standing <grant-id>    Revoke one standing grant. Here --standing <grant-id> names one grant; on approve, --standing names the kind.
  --principal <id>         Who is revoking: an active registered principal. Optional, never inferred.
`

/** The sentence for each code the gate's revoke transform can refuse with. */
function revokeRefusalText(refusal: RevokeRefusal): string {
  switch (refusal.code) {
    case 'unknown-id':
      return 'no standing grant has that id'
    case 'no-ids':
      return 'no standing grant was named'
    default: {
      // A code added to the union without a sentence fails typecheck here.
      const unmapped: never = refusal.code
      return unmapped
    }
  }
}

/** Why the standing grants file could not be read, one sentence per cause. */
const UNREADABLE: Record<StandingUnreadableCause, string> = {
  corrupt: 'it is not valid JSON or one of its grants is malformed, and one bad grant makes the whole file unreadable.',
  'newer reader':
    'a newer warpline wrote it. Do not edit it: lowering its min_reader_version would let this build act on grants it does not understand. Revoke with the newer warpline.',
  io: 'the file system refused the read.',
}

const NOT_RECORDED =
  'The audit store failed, so no audit record of this revoke was written. ' +
  'The grant was removed anyway: revoking only narrows authority.\n'
const NOT_OBSERVED =
  'The audit store could not record a change to principals.json. ' +
  'The revoke went ahead anyway: revoking only narrows authority.\n'

export async function run(argv: string[]): Promise<number> {
  let values: { holder?: string; standing?: string; principal?: string }
  try {
    ;({ values } = parseArgs({
      args: argv,
      options: { holder: { type: 'string' }, standing: { type: 'string' }, principal: { type: 'string' } },
      allowPositionals: false,
      strict: true,
    }))
  } catch (err) {
    // parseArgs refuses an unknown flag, a positional or a misplaced value.
    if (!(err instanceof TypeError) || !('code' in err) || !String(err.code).startsWith('ERR_PARSE_ARGS')) throw err
    process.stderr.write(`revoke: ${err.message}\n\n${USAGE}`)
    return 1
  }

  const refuse = (sentence: string): number => {
    process.stderr.write(`revoke: ${sentence} Nothing was revoked.\n`)
    return 1
  }
  if (values.holder !== undefined && values.standing !== undefined) {
    return refuse('--holder and --standing are two forms. Name one.')
  }

  const statePath = engineStatePath()
  const lockPath = pathsForStateFile(statePath).lockPath
  await mkdir(dirname(lockPath), { recursive: true })

  return await withStateLockAt(lockPath, async (): Promise<number> => {
    // Notes for a revoke that went through with something unrecorded; any one exits 70.
    const unrecorded = new Set<string>()
    const finish = (): number => {
      for (const note of unrecorded) process.stderr.write(note)
      return unrecorded.size > 0 ? EXIT_AUDIT_FAILED : 0
    }

    // The actor, checked in the hold, so a principal disabled while this waited is refused.
    let principal: string | null = null
    let principalUnchecked: string | null = null
    const actor = await requirePrincipal(values.principal, 'active')
    if ('refused' in actor) {
      const unconfirmed = actor.cause === 'registry' || actor.cause === 'audit'
      // A claim that is no principal id names nobody, whatever the registry holds.
      if (unconfirmed && !PRINCIPAL_ID.test(values.principal!)) return refuse('--principal: no principal has that id.')
      if (!unconfirmed) return refuse(`--principal: ${actor.refused}.`)
      // Blocking here would leave authority wider than the operator chose.
      principalUnchecked = values.principal!
      process.stderr.write(
        'revoke: --principal could not be checked against principals.json, so the record carries it as unchecked.\n',
      )
      if (actor.cause === 'audit') unrecorded.add(NOT_OBSERVED)
    } else {
      principal = actor.id
    }

    let data: AuditData<'grant.revoked'>
    let write: () => Promise<void>
    let done: string

    if (values.holder === undefined && values.standing === undefined) {
      // Bare: the session grant only. The standing grants file is never read.
      const approvalPath = sessionApprovalPath()
      if (!existsSync(approvalPath)) {
        await revokeApproval(approvalPath)
        process.stdout.write(`Session approval cleared (${approvalPath}).\n`)
        return finish()
      }
      const scopes = (await liveGrantScopes(approvalPath)).map((w) => w.scope)
      data = { kind: 'session', scopes, principal, principal_unchecked: principalUnchecked }
      write = () => revokeApproval(approvalPath)
      done = `Session approval cleared (${approvalPath}).\n`
    } else {
      // Whether the holder is registered; undefined means decide from the standing grants file.
      let registered: boolean | undefined
      const holder = values.holder
      if (holder !== undefined) {
        const check = await requirePrincipal(values.holder, 'registered')
        if (!('refused' in check)) registered = true
        else if (check.cause === 'empty') {
          process.stderr.write(USAGE)
          return 1
        } else if (check.cause === 'audit') {
          unrecorded.add(NOT_OBSERVED)
          const registry = await readRegistry()
          if (!('refused' in registry)) registered = registry.registry.principals.some((p) => p.id === holder)
        } else if (check.cause !== 'registry') {
          return refuse('--holder: no principal has that id.')
        }
      }

      const read = await readStandingStore()
      if (!read.readable) {
        process.stderr.write(
          `revoke: the standing grants file cannot be read: ${UNREADABLE[read.cause]} ` +
            'Moving the file aside drops every standing grant in it at once. Nothing was revoked.\n',
        )
        return 1
      }

      let ids: string[]
      if (holder !== undefined) {
        ids = read.store.grants
          .filter((g) => g.holder === holder)
          .map((g) => g.id)
          .sort()
        // With the registry unreadable, a holder the standing grants file names counts as registered.
        if (!(registered ?? ids.length > 0)) return refuse('--holder: no principal has that id.')
        if (ids.length === 0) {
          process.stdout.write(`${holder} holds no standing grant. Nothing was revoked.\n`)
          return finish()
        }
      } else {
        ids = [values.standing!]
      }

      const change = revokeStanding(read.store, ids)
      if ('refused' in change) return refuse(`${revokeRefusalText(change.refused)}.`)
      const removed = read.store.grants.filter((g) => ids.includes(g.id))
      const grantHolder = removed[0]!.holder
      const scopes = [...new Set(removed.flatMap((g) => g.scopes))].sort()
      data = { kind: 'standing', ids, holder: grantHolder, scopes, principal, principal_unchecked: principalUnchecked }
      write = () => writeStandingStore(change.store)
      done =
        holder === undefined
          ? `Revoked standing grant ${ids[0]}, held by ${grantHolder}.\n`
          : `Revoked ${ids.length} standing grant(s) held by ${holder}: ${ids.join(', ')}.\n`
    }

    try {
      await appendAudit(statePath, 'grant.revoked', data)
    } catch {
      unrecorded.add(NOT_RECORDED)
    }

    try {
      await write()
    } catch (err) {
      if (data.kind === 'session') throw err
      process.stderr.write('revoke: the standing grants file could not be written, so the grant still stands.\n')
      return 1
    }
    // A revoke lost to a power loss would hand the authority back.
    if (data.kind === 'standing') {
      try {
        await syncInstalled(standingGrantsPath())
      } catch {
        process.stderr.write(
          'revoke: the standing grants file was written but could not be synced to disk, so a power loss can bring the grant back.\n',
        )
        return 1
      }
    } else {
      try {
        await syncRemoved(sessionApprovalPath())
      } catch {
        process.stderr.write(
          'revoke: the session grant file was removed but the removal could not be synced to disk, so a power loss can bring the grant back.\n',
        )
        return 1
      }
    }

    process.stdout.write(done)
    return finish()
  })
}
