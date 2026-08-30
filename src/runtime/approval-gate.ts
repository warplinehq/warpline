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
 *      per call; mergeGrant() is the additive variant behind
 *      `warpline approve`; revokeApproval() deletes it. The file format is
 *      specified in docs/runtime-spec.md § 9
 *   4. With no live approval the engine records the plugin `skipped` and the
 *      run continues; the gate withholds execution, it does not abort the run
 *
 * Reads are fail-closed and never throw: a missing, expired, corrupt or
 * unreadable token is treated as unapproved. An exception here would surface as
 * an error a caller could catch and mistake for a recoverable condition, which
 * is the one failure mode a gate must not have.
 */
import { readFile, writeFile, unlink, chmod } from 'node:fs/promises'
import { sessionApprovalPath } from '../lib/paths.js'

/** Default TTL: 4 hours in milliseconds */
export const DEFAULT_TTL_MS = 4 * 60 * 60 * 1000

/**
 * Absolute ceiling on a grant's lifetime, measured from `first_granted_at`.
 *
 * Anchored at FIRST issue, not at the latest grant. Anchored at the latter,
 * repeated `approve --ttl 4h` calls would walk the window forward indefinitely
 * and a "4-hour" grant would in practice never expire. Every system that
 * permits renewal pairs it with a second absolute clock fixed at first issue
 * (Kerberos `renew_till`, Vault `max_ttl`); this is that clock.
 *
 * 23 hours, not 24, and the hour is the point. An engine advancing on a daily
 * cadence would meet a 24-hour ceiling at exactly the moment the next advance
 * runs — the grant and the run race, and which wins depends on scheduler jitter
 * rather than on anything the operator decided. At 23 the ceiling has always
 * lapsed before the next daily advance, so authority never straddles two runs
 * by accident. A daily operator re-authorises daily, deliberately, which is the
 * property a session grant is for.
 */
export const MAX_GRANT_WINDOW_MS = 23 * 60 * 60 * 1000

interface ApprovalFile {
  /** ISO 8601 timestamp when approval was granted */
  granted_at: string
  /**
   * ISO 8601 timestamp of the FIRST grant in this window — the anchor for
   * `MAX_GRANT_WINDOW_MS`.
   *
   * Optional on read, always written. A grant file written before this field
   * existed still loads: every read is `first_granted_at ?? granted_at`, which
   * for a single-grant file is the same instant anyway.
   */
  first_granted_at?: string
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
 *
 * `opts.now` is the clock seam. It is appended rather than slotted before
 * `approvalPath` because both the engine and the tests already pass the path
 * positionally. Callers that hold an injected clock MUST pass it: a caller
 * that threads `now` into some of its reads and lets the rest hit the wall
 * clock renders a view that disagrees with itself, which is the bug this
 * parameter closes, not a style preference.
 */
export async function checkApproval(
  scope: string,
  approvalPath: string = sessionApprovalPath(),
  opts: { now?: number } = {},
): Promise<boolean> {
  const now = opts.now ?? Date.now()
  try {
    const raw = JSON.parse(await readFile(approvalPath, 'utf-8')) as ApprovalFile

    // Check expiry. Strict `>`, so a grant is live up to and including its
    // expiry millisecond — the edge `engine-loader.test.ts:218` pins.
    if (now > new Date(raw.expires_at).getTime()) return false

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
 * Owner-only. The grant file is a capability: anything that can read it learns
 * exactly which side effects are currently permitted, and on a shared or
 * multi-user host that is a map of what to abuse before the TTL runs out.
 * `writeFile`'s default is 0o666 masked by the umask — 0o644 on a typical box,
 * i.e. world-readable.
 */
const GRANT_FILE_MODE = 0o600

/**
 * The single writer for the grant file. Both `grantApproval` and `mergeGrant`
 * go through it so a third writer cannot quietly reintroduce a world-readable
 * grant — the mode belongs to the file, not to one call site.
 *
 * `mode` on `writeFile` only applies when the file is CREATED, so it does
 * nothing for a grant file that already exists from an older version. The
 * explicit `chmod` is what heals those; the `mode` option is what stops the
 * new-file case from being briefly 0o644 between creation and chmod. Both are
 * needed, for different cases.
 */
async function writeGrantFile(approvalPath: string, payload: ApprovalFile): Promise<void> {
  await writeFile(approvalPath, JSON.stringify(payload, null, 2), { mode: GRANT_FILE_MODE })
  await chmod(approvalPath, GRANT_FILE_MODE)
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
    first_granted_at: new Date(now).toISOString(),
    expires_at: new Date(now + ttlMs).toISOString(),
    scopes: scopes === '*' ? '*' : Array.isArray(scopes) ? scopes : [scopes],
  }
  await writeGrantFile(approvalPath, payload)
}

/** Options for {@link mergeGrant}. Every field is optional. */
export interface MergeGrantOptions {
  /** Requested lifetime from `now`. Omitted on a merge = keep the live expiry. */
  ttlMs?: number
  /** Overwrite the scope list instead of unioning it, and reset the expiry. */
  replace?: boolean
  /** Permit `expires_at` past `first_granted_at + MAX_GRANT_WINDOW_MS`. */
  long?: boolean
  /** Injected clock, so a caller can print exactly what it wrote. */
  now?: number
}

/** What {@link mergeGrant} actually wrote, so the caller can print it. */
export interface MergeGrantResult {
  /** ISO 8601 — the effective expiry after any cap or extension. */
  expires_at: string
  /** ISO 8601 — the ceiling anchor, carried over from the live grant. */
  first_granted_at: string
  /** The scopes now on disk, sorted. */
  scopes: '*' | string[]
  /** True when the ceiling pulled the requested expiry back. */
  capped: boolean
  /**
   * True when the effective expiry sits past the ceiling — either because
   * `long` was passed on THIS call, or because a window an earlier `--long`
   * opened was carried forward by a later plain approve. It is a statement
   * about the window, not a record of the flag.
   */
  extended: boolean
}

/** Read the live grant, or null if it is missing, corrupt or already expired. */
async function readLiveGrant(approvalPath: string, now: number): Promise<ApprovalFile | null> {
  try {
    const raw = JSON.parse(await readFile(approvalPath, 'utf-8')) as ApprovalFile
    // An expired grant is not merged onto: the operator's window has closed and
    // a new grant restarts it. Merging would silently resurrect scopes the
    // expiry was supposed to have retired.
    if (now > new Date(raw.expires_at).getTime()) return null
    return raw
  } catch {
    return null
  }
}

/**
 * Grant approval additively: union the requested scopes with any live grant,
 * preserve that grant's expiry, and cap any extension at the first-grant
 * ceiling.
 *
 * This is the write path behind `warpline approve`. `grantApproval` above is
 * the unconditional overwrite it always was — programmatic pre-grants want that
 * — while an operator typing `approve b` after `approve a` means "and b", not
 * "instead of a". Losing an earlier grant to a later one is the failure this
 * function exists to prevent.
 *
 * `checkApproval` is deliberately untouched by any of this: the run path reads
 * the grant and never writes it, and keeping that provable by inspection rather
 * than by test is worth more than any sharing between the two.
 */
export async function mergeGrant(
  scopes: '*' | string | string[],
  opts: MergeGrantOptions = {},
  approvalPath: string = sessionApprovalPath(),
): Promise<MergeGrantResult> {
  const now = opts.now ?? Date.now()
  const live = await readLiveGrant(approvalPath, now)

  const firstGrantedAt = live
    ? new Date(live.first_granted_at ?? live.granted_at).getTime()
    : now
  const ceiling = firstGrantedAt + MAX_GRANT_WINDOW_MS
  const liveExpiry = live ? new Date(live.expires_at).getTime() : null

  const requested: '*' | string[] = scopes === '*' ? '*' : Array.isArray(scopes) ? scopes : [scopes]
  const merged: '*' | string[] =
    opts.replace || !live
      ? requested
      : requested === '*' || live.scopes === '*'
        ? '*'
        : [...new Set([...live.scopes, ...requested])]
  const finalScopes: '*' | string[] = merged === '*' ? '*' : [...merged].sort()

  // Expiry: replace (or a fresh window) restarts the clock; a merge keeps the
  // live expiry unless an explicit --ttl asks for more, and never for less.
  let expiry: number
  if (opts.replace || liveExpiry === null) {
    expiry = now + (opts.ttlMs ?? DEFAULT_TTL_MS)
  } else if (opts.ttlMs !== undefined) {
    expiry = Math.max(liveExpiry, now + opts.ttlMs)
  } else {
    expiry = liveExpiry
  }

  // The ceiling never shortens time the operator already holds — an earlier
  // --long grant stays honoured — it only refuses to hand out more.
  let capped = false
  if (!opts.long) {
    const bound = Math.max(ceiling, liveExpiry ?? ceiling)
    if (expiry > bound) {
      expiry = bound
      capped = true
    }
  }

  const payload: ApprovalFile = {
    granted_at: new Date(now).toISOString(),
    first_granted_at: new Date(firstGrantedAt).toISOString(),
    expires_at: new Date(expiry).toISOString(),
    scopes: finalScopes,
  }
  await writeGrantFile(approvalPath, payload)

  return {
    expires_at: payload.expires_at,
    first_granted_at: payload.first_granted_at as string,
    scopes: finalScopes,
    capped,
    extended: !capped && expiry > ceiling,
  }
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
