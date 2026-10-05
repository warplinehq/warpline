/**
 * `warpline revoke` — clear the current session approval.
 *
 * Deliberately the whole command: `revokeApproval` already swallows a missing
 * file, and a revoke that is a no-op is still the state the operator asked for.
 * There is nothing to validate — revoking only ever narrows what may run, so
 * the failure direction is safe and no confirmation is warranted.
 *
 * When a grant file exists, a `grant.revoked` record naming its live scopes is
 * appended first. A revoke narrows authority, so a failing store never blocks
 * it: the file is removed anyway and the command reports 70 instead. With no
 * grant file there is nothing to revoke and nothing is recorded.
 *
 * Never terminates the process — it returns a code to the dispatcher.
 */
import { existsSync } from 'node:fs'
import { appendAudit } from '../lib/audit-log.js'
import { liveGrantScopes, revokeApproval } from '../runtime/approval-gate.js'
import { EXIT_AUDIT_FAILED } from '../runtime/exit-codes.js'
import { engineStatePath, sessionApprovalPath } from '../lib/paths.js'

export async function run(_argv: string[]): Promise<number> {
  const approvalPath = sessionApprovalPath()
  let recorded = true
  if (existsSync(approvalPath)) {
    const scopes = (await liveGrantScopes(approvalPath)).map((w) => w.scope)
    try {
      await appendAudit(engineStatePath(), 'grant.revoked', {
        scopes,
      })
    } catch {
      recorded = false
    }
  }
  await revokeApproval(approvalPath)
  process.stdout.write(`Session approval cleared (${approvalPath}).\n`)
  if (!recorded) {
    process.stderr.write(
      'The audit store failed, so no audit record of this revoke was written. ' +
        'The grant file was removed anyway: revoking only narrows authority.\n',
    )
    return EXIT_AUDIT_FAILED
  }
  return 0
}
