/**
 * Session approval gate for plugins that declare side effects.
 *
 * Its only non-test consumer is the engine, which consults it once per plugin,
 * immediately before invocation:
 *
 *   1. A plugin needs approval when its manifest's `side_effects` array is
 *      non-empty; the engine calls checkApproval() with the plugin's name
 *   2. Approval is a JSON file at sessionApprovalPath()
 *      (<warplineHome>/.session-approval) carrying a `scopes` value of either
 *      '*' or a list of plugin names, and an expiry per scope (#27)
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
  /**
   * One window per scope key (a plugin name, or '*'), so each scope expires on
   * its own clock (#27). Before it, one `expires_at` covered every scope, and
   * a later `approve b --ttl 1h` inherited a standing `--long` window for `a`.
   *
   * Optional on read; `mergeGrant` always writes it, `grantApproval` never
   * does. A file without it is read as one window over every listed scope,
   * which is exactly what it meant when it was written. The top-level
   * `expires_at` and `first_granted_at` are then written as the EARLIEST
   * window's, so an older build that ignores this key expires every scope
   * early and never late: a rollback narrows authority, it cannot widen it.
   */
  scope_windows?: Record<string, { first_granted_at: string; expires_at: string }>
  /**
   * The oldest reader that may interpret this file. A reader whose
   * {@link GRANT_READER_VERSION} is lower refuses the file outright: fail
   * closed, never guess at a format it cannot see (RFC 5280's critical flag,
   * Delta Lake's `minReaderVersion`). Nothing writes it yet. It exists so a
   * future change that an older reader could misread as MORE authority can
   * set it, and every reader from this one on already refuses.
   */
  min_reader_version?: number
}

/** The grant-file format this build reads. See `ApprovalFile.min_reader_version`. */
export const GRANT_READER_VERSION = 1

/** A scope's live window, parsed. `first` is null when the anchor is unusable. */
interface Window {
  first: number | null
  expires: number
}

/**
 * The live windows in a grant file, keyed by scope ('*' or a plugin name).
 *
 * The one reader of the format, shared by the decision path and the merge
 * path so the two cannot disagree about what is live. Fail-closed: an
 * unparseable top-level `expires_at` is a corrupt file and yields nothing,
 * and a window only counts for a scope the file actually lists.
 */
function liveWindows(raw: ApprovalFile, now: number): Map<string, Window> {
  const out = new Map<string, Window>()
  // Absent means every reader. Anything present that is not a number this
  // build meets is refused, a garbage value included.
  if (raw.min_reader_version !== undefined) {
    const v = raw.min_reader_version
    if (typeof v !== 'number' || !Number.isFinite(v) || v > GRANT_READER_VERSION) return out
  }
  const fileExpires = parseTimestamp(raw.expires_at)
  if (fileExpires === null) return out
  const fileFirst = parseTimestamp(raw.first_granted_at ?? raw.granted_at)
  const listed = (key: string) =>
    raw.scopes === '*' || (Array.isArray(raw.scopes) && key !== '*' && raw.scopes.includes(key))

  const perScope = raw.scope_windows
  if (perScope !== null && typeof perScope === 'object' && !Array.isArray(perScope)) {
    for (const [key, w] of Object.entries(perScope)) {
      if (!listed(key) || w === null || typeof w !== 'object') continue
      const expires = parseTimestamp(w.expires_at)
      if (expires === null || now > expires) continue
      out.set(key, { first: parseTimestamp(w.first_granted_at), expires })
    }
    return out
  }

  // A file with no per-scope windows: one window over every listed scope.
  if (now > fileExpires) return out
  const keys = raw.scopes === '*' ? ['*'] : Array.isArray(raw.scopes) ? raw.scopes : []
  for (const key of keys) out.set(key, { first: fileFirst, expires: fileExpires })
  return out
}

/**
 * The live scopes of a grant file with their expiries, for display. Never
 * throws; a missing or corrupt file reads as none. Decisions go through
 * {@link checkApproval}, never through this.
 */
export async function liveGrantScopes(
  approvalPath: string = sessionApprovalPath(),
  now: number = Date.now(),
): Promise<Array<{ scope: string; expiresAt: number }>> {
  try {
    const raw = JSON.parse(await readFile(approvalPath, 'utf-8')) as ApprovalFile
    return [...liveWindows(raw, now)].map(([scope, w]) => ({ scope, expiresAt: w.expires }))
  } catch {
    return []
  }
}

/**
 * A grant timestamp as milliseconds, or null when the string is not a date.
 *
 * `new Date(x).getTime()` is NaN for an unparseable string, and every
 * comparison against NaN is false. `now > NaN` therefore answers "not
 * expired", which turned a grant file with a corrupt expiry into an approval
 * of everything it scoped — the one direction a gate must never fail in.
 * Callers treat null as invalid and refuse. `readGrant` in `src/cli/plan.ts`
 * already guarded the display path this way; this is the decision path
 * catching up.
 */
function parseTimestamp(iso: unknown): number | null {
  if (typeof iso !== 'string') return null
  const ms = new Date(iso).getTime()
  return Number.isNaN(ms) ? null : ms
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

    // Expiry is strict `>`, so a window is live up to and including its expiry
    // millisecond — the edge `engine-loader.test.ts:218` pins. An expiry that
    // will not parse is no expiry at all, so it is not live. A scope is
    // approved by its own window or by a live '*' window, never by another
    // scope's.
    const windows = liveWindows(raw, now)
    return windows.has(scope) || windows.has('*')
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
  /** True when the ceiling pulled a requested scope's expiry back. */
  capped: boolean
  /**
   * True when the effective expiry sits past the ceiling — either because
   * `long` was passed on THIS call, or because a window an earlier `--long`
   * opened was carried forward by a later plain approve. It is a statement
   * about the window, not a record of the flag.
   */
  extended: boolean
  /**
   * The window each REQUESTED scope now holds. They can differ: a scope that
   * already held a live window keeps its expiry, a new one opens its own.
   */
  windows: Array<{ scope: string; expires_at: string; capped: boolean; extended: boolean }>
}

/**
 * Grant approval additively, one window per scope: a requested scope that
 * holds a live window keeps its expiry (an explicit TTL may extend it), a new
 * one opens its own, and every other live scope is left exactly as it was.
 * Each window's extension is capped at its own first-grant ceiling.
 *
 * This is the write path behind `warpline approve`. `grantApproval` above is
 * the unconditional overwrite it always was — programmatic pre-grants want that
 * — while an operator typing `approve b` after `approve a` means "and b", not
 * "instead of a". Losing an earlier grant to a later one is the failure this
 * function exists to prevent. Per-scope windows (#27) are what keep "and b"
 * from also meaning "and b for as long as a": a later `approve b --ttl 1h`
 * gets one hour, and a standing `--long` window on `a` is neither shortened
 * nor lent.
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

  // An expired window is not merged onto: its scope's window has closed and a
  // new grant restarts it. A window whose anchor will not parse is dropped
  // too: the anchor is what the ceiling is measured from, so honouring it
  // would hand out time nobody authorised. Either costs the operator a scope
  // they re-grant in one command.
  let live = new Map<string, { first: number; expires: number }>()
  try {
    const raw = JSON.parse(await readFile(approvalPath, 'utf-8')) as ApprovalFile
    for (const [key, w] of liveWindows(raw, now)) {
      if (w.first !== null) live.set(key, { first: w.first, expires: w.expires })
    }
  } catch {
    live = new Map()
  }

  const requested: string[] = scopes === '*' ? ['*'] : Array.isArray(scopes) ? scopes : [scopes]

  // `--replace` drops every other scope and restarts the requested expiries,
  // but it never restarts a live scope's ceiling, or `approve --replace`
  // repeated would walk the window forward. Each scope keeps its OWN anchor:
  // borrowing another scope's would hand a new scope a ceiling already in the
  // past, a window expired on arrival. A scope with no live window starts
  // fresh, as it would on any approve (Kerberos: a new `kinit`, a new anchor).
  const next = opts.replace ? new Map<string, { first: number; expires: number }>() : new Map(live)
  const windows: MergeGrantResult['windows'] = []

  for (const key of requested) {
    const held = live.get(key)
    const first = held?.first ?? now
    const ceiling = first + MAX_GRANT_WINDOW_MS

    // Expiry: replace (or a fresh window) restarts the clock; a merge keeps the
    // live expiry unless an explicit --ttl asks for more, and never for less.
    let expiry: number
    if (opts.replace || held === undefined) {
      expiry = now + (opts.ttlMs ?? DEFAULT_TTL_MS)
    } else if (opts.ttlMs !== undefined) {
      expiry = Math.max(held.expires, now + opts.ttlMs)
    } else {
      expiry = held.expires
    }

    // The ceiling never shortens time this scope already holds — an earlier
    // --long window stays honoured — it only refuses to hand out more.
    let capped = false
    if (!opts.long) {
      const bound = Math.max(ceiling, held?.expires ?? ceiling)
      if (expiry > bound) {
        expiry = bound
        capped = true
      }
    }

    next.set(key, { first, expires: expiry })
    windows.push({
      scope: key,
      expires_at: new Date(expiry).toISOString(),
      capped,
      extended: !capped && expiry > ceiling,
    })
  }

  const keys = [...next.keys()].sort()
  const finalScopes: '*' | string[] = next.has('*') ? '*' : keys
  // The top-level fields are the EARLIEST window's, so a build that reads only
  // them expires every scope early and never late (see `scope_windows`). An
  // empty grant, reachable only from the library, approves nothing.
  const all = [...next.values()]
  const fileExpiry = all.length > 0 ? Math.min(...all.map((w) => w.expires)) : now + (opts.ttlMs ?? DEFAULT_TTL_MS)
  const fileFirst = all.length > 0 ? Math.min(...all.map((w) => w.first)) : now

  const payload: ApprovalFile = {
    granted_at: new Date(now).toISOString(),
    first_granted_at: new Date(fileFirst).toISOString(),
    expires_at: new Date(fileExpiry).toISOString(),
    scopes: finalScopes,
    scope_windows: Object.fromEntries(
      keys.map((k) => {
        const w = next.get(k)!
        return [k, { first_granted_at: new Date(w.first).toISOString(), expires_at: new Date(w.expires).toISOString() }]
      }),
    ),
  }
  await writeGrantFile(approvalPath, payload)

  return {
    expires_at: payload.expires_at,
    first_granted_at: payload.first_granted_at as string,
    scopes: finalScopes,
    capped: windows.some((w) => w.capped),
    extended: windows.some((w) => w.extended),
    windows,
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
