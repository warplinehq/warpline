/**
 * `warpline revoke` — clear the current session approval.
 *
 * Deliberately the whole command: `revokeApproval` already swallows a missing
 * file, and a revoke that is a no-op is still the state the operator asked for.
 * There is nothing to validate — revoking only ever narrows what may run, so
 * the failure direction is safe and no confirmation is warranted.
 *
 * Never terminates the process — it returns a code to the dispatcher.
 */
import { revokeApproval } from '../runtime/approval-gate.js'
import { sessionApprovalPath } from '../lib/paths.js'

export async function run(_argv: string[]): Promise<number> {
  const approvalPath = sessionApprovalPath()
  await revokeApproval(approvalPath)
  process.stdout.write(`Session approval cleared (${approvalPath}).\n`)
  return 0
}
