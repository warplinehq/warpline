/**
 * Session approval gate for plugins that declare side effects.
 *
 * Its only non-test consumer is the engine, which consults it once per plugin,
 * immediately before invocation:
 *
 *   1. A plugin needs approval when its manifest's `side_effects` array is
 *      non-empty; the engine calls checkApproval() with the plugin's name
 *   2. Approval is a JSON file at sessionApprovalPath()
 *      (<warplineHome>/.session-approval) carrying an expiry and a `scopes`
 *      value of either '*' or a list of plugin names
 *   3. grantApproval() writes that file — 4-hour TTL by default, overridable
 *      per call; revokeApproval() deletes it
 *   4. With no live approval the engine records the plugin `skipped` and the
 *      run continues; the gate withholds execution, it does not abort the run
 *
 * Reads are fail-closed and never throw: a missing, expired, corrupt or
 * unreadable token is treated as unapproved. An exception here would surface as
 * an error a caller could catch and mistake for a recoverable condition, which
 * is the one failure mode a gate must not have.
 */
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { sessionApprovalPath } from '../lib/paths.js'

/** Default TTL: 4 hours in milliseconds */
const DEFAULT_TTL_MS = 4 * 60 * 60 * 1000

interface ApprovalFile {
  /** ISO 8601 timestamp when approval was granted */
  granted_at: string
  /** ISO 8601 timestamp when approval expires */
  expires_at: string
  /** '*' = every plugin, or an array of specific plugin names */
  scopes: '*' | string[]
}

/**
 * Check if a valid, non-expired approval exists for the given scope.
 *
 * Returns true if approved, false otherwise. Never throws — a missing or
 * corrupt approval file is treated as unapproved.
 */
export async function checkApproval(
  scope: string,
  approvalPath: string = sessionApprovalPath(),
): Promise<boolean> {
  try {
    const raw = JSON.parse(await readFile(approvalPath, 'utf-8')) as ApprovalFile

    // Check expiry
    if (Date.now() > new Date(raw.expires_at).getTime()) return false

    // Wildcard grants all scopes
    if (raw.scopes === '*') return true

    // Array — check if scope is explicitly granted
    return Array.isArray(raw.scopes) && raw.scopes.includes(scope)
  } catch {
    // File doesn't exist, is corrupt, or is unreadable — treat as unapproved
    return false
  }
}

/**
 * Grant approval by writing the session approval file.
 *
 * Can be called:
 *   - Before an automated pipeline run (pre-grant for known scopes)
 *   - After a user confirmation prompt (interactive approval)
 *   - With '*' for blanket approval (CI environments where all scripts are trusted)
 */
export async function grantApproval(
  scopes: '*' | string | string[],
  ttlMs: number = DEFAULT_TTL_MS,
  approvalPath: string = sessionApprovalPath(),
): Promise<void> {
  const now = Date.now()
  const payload: ApprovalFile = {
    granted_at: new Date(now).toISOString(),
    expires_at: new Date(now + ttlMs).toISOString(),
    scopes: scopes === '*' ? '*' : Array.isArray(scopes) ? scopes : [scopes],
  }
  await writeFile(approvalPath, JSON.stringify(payload, null, 2))
}

/**
 * Revoke approval by deleting the session approval file.
 * No-op if the file doesn't exist.
 */
export async function revokeApproval(
  approvalPath: string = sessionApprovalPath(),
): Promise<void> {
  try {
    await unlink(approvalPath)
  } catch (err: unknown) {
    // ENOENT means file already gone — that's fine
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}
