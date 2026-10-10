/**
 * Approval gate for plugins that declare side effects.
 *
 * A plugin needs approval when its manifest's `side_effects` array is
 * non-empty. The engine consults this module once per plugin, immediately
 * before invocation. With no live grant covering the plugin it records the
 * plugin `skipped` and the run continues: the gate withholds execution, it does
 * not abort the run. Two kinds of grant can cover a plugin.
 *
 *   1. A session window. The session file at sessionApprovalPath()
 *      (<warplineHome>/.session-approval) carries a `scopes` value of either
 *      '*' or a list of plugin names, and one window per scope, each with its
 *      own expiry (#27). grantApproval() writes that file, 4-hour TTL by
 *      default; mergeGrant() is the additive variant behind
 *      `warpline approve`, and records the principal who issued each window;
 *      revokeApproval() deletes it.
 *   2. A standing grant. Standing grants live in their own file, so no reader
 *      of the session file ever sees one. A standing grant is held by a
 *      machine principal and issued and renewed by a human one. It runs for a
 *      renewal period and lapses unless renewed, and it lapses for good at a
 *      hard maximum fixed at issue. Nothing marks a grant lapsed: the lapse is
 *      derived each time the grant is read. A lapse on time, or on a holder
 *      gone from the registry (whose id never comes back), cannot clear and
 *      reads `final`. A lapse on an unreadable registry, a holder that is not a
 *      machine, or a disabled holder clears once the holder reads as an active
 *      machine again. A grant whose period has not started yet, because its
 *      `period_start` is later than now, covers nothing until the clock
 *      reaches it, so no clock that ran ahead buys it life past the caps.
 *
 * Both file formats are specified in docs/runtime-spec.md § 9.
 *
 * The principal registry is never read here. A caller that wants standing
 * grants considered passes a snapshot of it, and with no snapshot every
 * standing grant reads lapsed.
 *
 * Reads are fail-closed and never throw: a missing, expired, corrupt or
 * unreadable token is treated as unapproved. An exception here would surface as
 * an error a caller could catch and mistake for a recoverable condition, which
 * is the one failure mode a gate must not have.
 *
 * Refusals leave this module as codes. Every sentence an operator reads about
 * one belongs to the verb that printed it. This file is held byte-identical
 * between amendments, and a sentence frozen in it could turn false with no way
 * to correct it short of another amendment.
 */
import { randomBytes } from 'node:crypto'
import { readFile, writeFile, unlink, chmod } from 'node:fs/promises'
import { atomicWriteJson } from '../lib/fs-atomic.js'
import { sessionApprovalPath, standingGrantsPath } from '../lib/paths.js'

/** A principal id, the registry's rule. Copied: the gate may not import the registry module. */
const PRINCIPAL_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/

/** A standing grant id: 12 lowercase hex characters. */
const STANDING_ID = /^[0-9a-f]{12}$/

function isPrincipalId(v: unknown): v is string {
  return typeof v === 'string' && PRINCIPAL_ID.test(v)
}

/**
 * A plugin name, the audit store's rule: 1 to 255 characters, none of them a
 * C0 control character, DEL, `/` or `\`. Copied: the gate may not import the
 * store. A scope the gate takes must be one a `grant.revoked` record can carry.
 */
const PLUGIN_NAME = /^[^\x00-\x1f\x7f/\\]+$/

function isPluginName(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 255 && PLUGIN_NAME.test(v)
}

/**
 * An issuer as attribution, or null. A field that grants nothing must not be
 * able to block a fire, so a malformed one reads as no issuer rather than
 * reaching a strict record schema downstream.
 */
function attributed(v: unknown): string | null {
  return isPrincipalId(v) ? v : null
}

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
   *
   * A window's optional `issuer` is the principal whose grant last named the
   * scope. It is attribution only and grants nothing, so a reader that ignores
   * it reads the same authority, and a rewrite that drops it narrows only who
   * the record names.
   */
  scope_windows?: Record<string, { first_granted_at: string; expires_at: string; issuer?: string }>
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

/**
 * A scope's live window, parsed. `first` is null when the anchor is unusable,
 * and `issuer` when the window names no valid principal.
 */
interface Window {
  first: number | null
  expires: number
  issuer: string | null
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
      out.set(key, { first: parseTimestamp(w.first_granted_at), expires, issuer: attributed(w.issuer) })
    }
    return out
  }

  // A file with no per-scope windows: one window over every listed scope.
  if (now > fileExpires) return out
  const keys = raw.scopes === '*' ? ['*'] : Array.isArray(raw.scopes) ? raw.scopes : []
  for (const key of keys) out.set(key, { first: fileFirst, expires: fileExpires, issuer: null })
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
 * One grant that covers a scope. A session entry is one live window, the
 * scope's own or '*'. A standing entry is one live standing grant. Both name
 * the principal who issued them; a session window may name none.
 */
export type CoveringGrant =
  | { kind: 'session'; scope: string; issuer: string | null }
  | { kind: 'standing'; id: string; holder: string; issuer: string }

/**
 * Every live grant covering `scope`: session entries first ('*', then the
 * scope's own window), then standing grants by id. `[]` means unapproved.
 *
 * Never throws. Each half is read on its own, and a half that cannot be read
 * contributes nothing.
 *
 * Standing grants are considered only when `registry` is passed. Without a
 * registry snapshot no standing grant can be live, so the standing grants file
 * is not opened at all, which also keeps every registry-less caller off it.
 */
export async function grantsCovering(
  scope: string,
  {
    now = Date.now(),
    approvalPath = sessionApprovalPath(),
    standingPath = standingGrantsPath(),
    registry,
  }: { now?: number; approvalPath?: string; standingPath?: string; registry?: RegistrySnapshot | null } = {},
): Promise<CoveringGrant[]> {
  const out: CoveringGrant[] = []
  try {
    const raw = JSON.parse(await readFile(approvalPath, 'utf-8')) as ApprovalFile

    // Expiry is strict `>`, so a window is live up to and including its expiry
    // millisecond — the edge `engine-loader.test.ts:218` pins. An expiry that
    // will not parse is no expiry at all, so it is not live. A scope is
    // approved by its own window or by a live '*' window, never by another
    // scope's.
    const windows = liveWindows(raw, now)
    for (const key of scope === '*' ? ['*'] : ['*', scope]) {
      const w = windows.get(key)
      if (w !== undefined) out.push({ kind: 'session', scope: key, issuer: w.issuer })
    }
  } catch {
    // File doesn't exist, is corrupt, or is unreadable — no session entry
  }

  if (registry === null || registry === undefined) return out
  try {
    const listing = await listStandingGrants({ now, registry, standingPath })
    if (listing.readable) {
      const live = listing.grants.filter((g) => g.state === 'live' && g.scopes.includes(scope)).sort(byId)
      for (const g of live) out.push({ kind: 'standing', id: g.id, holder: g.holder, issuer: g.issuer })
    }
  } catch {
    // Unreachable by construction; a standing half that fails contributes nothing
  }
  return out
}

/**
 * Check if a valid, non-expired approval exists for the given scope.
 *
 * Returns true if approved, false otherwise. Never throws — a missing or
 * corrupt approval file is treated as unapproved.
 *
 * This is the boolean view of {@link grantsCovering}'s session half. It passes
 * no registry, so it reads session windows only. A caller that needs standing
 * grants considered calls `grantsCovering` with a registry snapshot.
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
  return (await grantsCovering(scope, { now: opts.now, approvalPath })).length > 0
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
  /**
   * The principal issuing this grant; each requested scope's window records it
   * as `issuer`, and a null or absent one records none.
   */
  principal?: string | null
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
  let live = new Map<string, { first: number; expires: number; issuer: string | null }>()
  try {
    const raw = JSON.parse(await readFile(approvalPath, 'utf-8')) as ApprovalFile
    for (const [key, w] of liveWindows(raw, now)) {
      if (w.first !== null) live.set(key, { first: w.first, expires: w.expires, issuer: w.issuer })
    }
  } catch {
    live = new Map()
  }

  const requested: string[] = scopes === '*' ? ['*'] : Array.isArray(scopes) ? scopes : [scopes]
  // The last grant that names a scope sets its issuer, an unattributed one
  // included. A window this call does not name keeps the issuer it was read with.
  const issuer = attributed(opts.principal)

  // `--replace` drops every other scope and restarts the requested expiries,
  // but it never restarts a live scope's ceiling, or `approve --replace`
  // repeated would walk the window forward. Each scope keeps its OWN anchor:
  // borrowing another scope's would hand a new scope a ceiling already in the
  // past, a window expired on arrival. A scope with no live window starts
  // fresh, as it would on any approve (Kerberos: a new `kinit`, a new anchor).
  const next = opts.replace ? new Map<string, { first: number; expires: number; issuer: string | null }>() : new Map(live)
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

    next.set(key, { first, expires: expiry, issuer })
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
    // `issuer` is written only when there is one, so an unattributed grant's
    // file is byte-identical to one written before the field existed.
    scope_windows: Object.fromEntries(
      keys.map((k) => {
        const w = next.get(k)!
        const window = { first_granted_at: new Date(w.first).toISOString(), expires_at: new Date(w.expires).toISOString() }
        return [k, w.issuer === null ? window : { ...window, issuer: w.issuer }]
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

// ---------------------------------------------------------------------------
// Standing grants
// ---------------------------------------------------------------------------

/**
 * The standing grants file format this build reads. A file asking for more is
 * refused whole, so an older build reads no standing grant rather than a wider
 * one. Separate from {@link GRANT_READER_VERSION}: the two files move apart.
 */
export const STANDING_READER_VERSION = 1

// The caps live in code, never in preferences: a ceiling a file could raise
// would let a file widen authority.

/** Renewal period when the issuer names none: 24 hours. */
export const DEFAULT_STANDING_PERIOD_MS = 24 * 60 * 60 * 1000
/** The longest renewal period a standing grant may have: 7 days. */
export const MAX_STANDING_PERIOD_MS = 7 * 24 * 60 * 60 * 1000
/** The longest hard maximum a standing grant may have, from issue: 90 days. */
export const MAX_STANDING_HARD_MAX_MS = 90 * 24 * 60 * 60 * 1000

/**
 * What the caller read from the principal registry: each principal's type and
 * status, by id. The gate never reads the registry itself. No principal's key
 * is in the snapshot, because nothing here needs it.
 */
export type RegistrySnapshot = ReadonlyMap<string, { type: 'human' | 'machine'; status: 'active' | 'disabled' }>

/**
 * One standing grant as stored. `period_start` is set at issue and moved only
 * by renew, so the hard maximum, measured from `issued_at`, cannot move.
 * Deadlines are derived, never stored.
 */
export interface StandingGrant {
  id: string
  holder: string
  issuer: string
  scopes: string[]
  issued_at: string
  period_start: string
  period_ms: number
  hard_max_ms: number
}

/** The standing grants file. Grants are written sorted by id. */
export interface StandingStore {
  min_reader_version: number
  grants: StandingGrant[]
}

/**
 * Why a standing grant is not live. When several apply, the first in this
 * order is the one reported.
 */
export type LapseReason =
  | 'hard max'
  | 'not renewed'
  | 'future dated'
  | 'registry unreadable'
  | 'holder not registered'
  | 'holder not machine'
  | 'holder disabled'

/**
 * A standing grant as read at one instant. `final` is true when the lapse can
 * never clear and only a new grant fixes it: a time lapse, or a holder gone
 * from the registry, whose id is never added again. A `future dated` lapse
 * clears when the clock reaches `period_start`, and the other three once the
 * holder reads as an active machine.
 */
export interface StandingStatus extends StandingGrant {
  renewal_deadline: number
  hard_max_at: number
  next_expiry: number
  state: 'live' | 'lapsed'
  reason: LapseReason | null
  final: boolean
}

/**
 * Why the standing grants file could not be read: its bytes or shape are
 * wrong, it was written for a newer reader, or the read itself failed.
 */
export type StandingUnreadableCause = 'corrupt' | 'newer reader' | 'io'

/** Every standing grant with its status, or why none could be read. */
export type StandingListing =
  | { readable: true; grants: StandingStatus[] }
  | { readable: false; cause: StandingUnreadableCause }

/**
 * Why {@link issueStanding} refused. `no-scope` also covers a scope that is
 * not a non-empty string, `bad-scope` one that is not a plugin name, and
 * `bad-period` a period, or a hard maximum, that is not a whole number of
 * milliseconds.
 */
export type IssueRefusal = {
  code:
    | 'no-scope'
    | 'all-scopes'
    | 'bad-scope'
    | 'bad-period'
    | 'period-over-cap'
    | 'hard-max-over-cap'
    | 'hard-max-below-period'
    | 'bad-id'
    | 'duplicate-id'
    | 'bad-principal-id'
    | 'holder-is-issuer'
}

/** Why {@link renewStanding} refused. No lapsed grant can be renewed, final or not. */
export type RenewRefusal = { code: 'unknown-id' | 'holder-renews' } | { code: 'lapsed'; reason: LapseReason; final: boolean }

/** Why {@link revokeStanding} refused. */
export type RevokeRefusal = { code: 'unknown-id' | 'no-ids' }

/** Every refusal a standing transform can return: codes, never sentences. */
export type StandingRefusal = IssueRefusal | RenewRefusal | RevokeRefusal

/** A transform's result: the next store, or a refusal and no store. */
export type StandingChange<R extends StandingRefusal = StandingRefusal> = { store: StandingStore } | { refused: R }

/** The lapses that cannot clear. */
const FINAL: ReadonlySet<LapseReason> = new Set<LapseReason>(['hard max', 'not renewed', 'holder not registered'])

const iso = (ms: number): string => new Date(ms).toISOString()

/** Codepoint order on ids, the same on every host. */
function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** A fresh standing grant id: 12 lowercase hex characters. Issue refuses one already in the file. */
export function newStandingId(): string {
  return randomBytes(6).toString('hex')
}

/** One stored grant's known fields in their fixed order, or null when any is malformed. */
function parseGrant(value: unknown): StandingGrant | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const g = value as Record<string, unknown>
  const { id, holder, issuer, scopes, issued_at, period_start, period_ms, hard_max_ms } = g
  if (typeof id !== 'string' || !STANDING_ID.test(id)) return null
  if (!isPrincipalId(holder) || !isPrincipalId(issuer)) return null
  if (!Array.isArray(scopes) || scopes.length === 0) return null
  if (!scopes.every((s): s is string => isPluginName(s) && s !== '*')) return null
  if (new Set(scopes).size !== scopes.length) return null
  if (typeof issued_at !== 'string' || typeof period_start !== 'string') return null
  const issued = parseTimestamp(issued_at)
  const start = parseTimestamp(period_start)
  if (issued === null || start === null) return null
  if (typeof period_ms !== 'number' || !Number.isInteger(period_ms) || period_ms <= 0) return null
  if (period_ms > MAX_STANDING_PERIOD_MS) return null
  if (typeof hard_max_ms !== 'number' || !Number.isInteger(hard_max_ms)) return null
  if (hard_max_ms < period_ms || hard_max_ms > MAX_STANDING_HARD_MAX_MS) return null
  // Issue sets period_start to issued_at and renew moves it only forward, and
  // only while the grant is live, so no verb writes one outside this range.
  if (start < issued || start > issued + hard_max_ms) return null
  return { id, holder, issuer, scopes: [...scopes], issued_at, period_start, period_ms, hard_max_ms }
}

/**
 * The whole file or nothing. The reader version is read before any other
 * field: a newer format may shape its grants differently, so a grant this
 * build cannot parse in a newer file says `newer reader`, never `corrupt`.
 * Unknown keys are ignored; a field that narrows authority comes with a
 * reader-version bump.
 */
function parseStore(raw: unknown): { store: StandingStore } | { cause: 'corrupt' | 'newer reader' } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { cause: 'corrupt' }
  const file = raw as Record<string, unknown>

  const version = file.min_reader_version
  if (typeof version === 'number' && Number.isInteger(version) && version > STANDING_READER_VERSION) {
    return { cause: 'newer reader' }
  }
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return { cause: 'corrupt' }

  if (!Array.isArray(file.grants)) return { cause: 'corrupt' }
  const grants: StandingGrant[] = []
  const seen = new Set<string>()
  for (const value of file.grants) {
    const grant = parseGrant(value)
    if (grant === null || seen.has(grant.id)) return { cause: 'corrupt' }
    seen.add(grant.id)
    grants.push(grant)
  }
  return { store: { min_reader_version: version, grants } }
}

/**
 * The standing grants file, parsed. Never throws. A missing file is an empty,
 * readable store; anything else that cannot be read reports its cause.
 */
export async function readStandingStore(
  standingPath: string = standingGrantsPath(),
): Promise<{ readable: true; store: StandingStore } | { readable: false; cause: StandingUnreadableCause }> {
  let text: string
  try {
    text = await readFile(standingPath, 'utf-8')
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
      return { readable: true, store: { min_reader_version: STANDING_READER_VERSION, grants: [] } }
    }
    return { readable: false, cause: 'io' }
  }
  try {
    const parsed = parseStore(JSON.parse(text))
    return 'cause' in parsed ? { readable: false, cause: parsed.cause } : { readable: true, store: parsed.store }
  } catch {
    return { readable: false, cause: 'corrupt' }
  }
}

/**
 * A grant's status at `now`. Both instants are inclusive (strict `>`), like a
 * session window's expiry. A timestamp that will not parse reads as already
 * past, so a malformed grant handed in by a caller lapses rather than lives.
 * A period that starts after `now` covers nothing yet: otherwise a grant dated
 * ahead of the clock would stay live past both caps by the clock's lead.
 */
function statusOf(grant: StandingGrant, now: number, registry: RegistrySnapshot | null | undefined): StandingStatus {
  const period_start = parseTimestamp(grant.period_start) ?? Number.NEGATIVE_INFINITY
  const renewal_deadline = period_start + grant.period_ms
  const hard_max_at = (parseTimestamp(grant.issued_at) ?? Number.NEGATIVE_INFINITY) + grant.hard_max_ms
  const holder = registry?.get(grant.holder)
  const reason: LapseReason | null =
    now > hard_max_at
      ? 'hard max'
      : now > renewal_deadline
        ? 'not renewed'
        : now < period_start
          ? 'future dated'
          : registry === null || registry === undefined
            ? 'registry unreadable'
            : holder === undefined
              ? 'holder not registered'
              : holder.type !== 'machine'
                ? 'holder not machine'
                : holder.status !== 'active'
                  ? 'holder disabled'
                  : null
  return {
    ...grant,
    renewal_deadline,
    hard_max_at,
    next_expiry: Math.min(renewal_deadline, hard_max_at),
    state: reason === null ? 'live' : 'lapsed',
    reason,
    final: reason !== null && FINAL.has(reason),
  }
}

/**
 * Every standing grant with its status at `now`, sorted by next expiry and
 * then by id. Never throws. With no registry snapshot every grant reads
 * lapsed, `registry unreadable`.
 */
export async function listStandingGrants({
  now = Date.now(),
  registry,
  standingPath = standingGrantsPath(),
}: { now?: number; registry?: RegistrySnapshot | null; standingPath?: string } = {}): Promise<StandingListing> {
  const read = await readStandingStore(standingPath)
  if (!read.readable) return { readable: false, cause: read.cause }
  const grants = read.store.grants
    .map((g) => statusOf(g, now, registry))
    .sort((a, b) => a.next_expiry - b.next_expiry || byId(a, b))
  return { readable: true, grants }
}

/**
 * The one writer of the standing grants file, owner-only and atomic. Grants
 * are written sorted by id, each with its scopes sorted, under this build's
 * reader version. It never deletes the file: a store with no grants is
 * written as an empty list. Rejects when the write fails; callers report it.
 */
export async function writeStandingStore(
  store: StandingStore,
  standingPath: string = standingGrantsPath(),
): Promise<void> {
  const grants = store.grants
    .map((g) => ({
      id: g.id,
      holder: g.holder,
      issuer: g.issuer,
      scopes: [...g.scopes].sort(),
      issued_at: g.issued_at,
      period_start: g.period_start,
      period_ms: g.period_ms,
      hard_max_ms: g.hard_max_ms,
    }))
    .sort(byId)
  await atomicWriteJson(standingPath, { min_reader_version: STANDING_READER_VERSION, grants }, { mode: GRANT_FILE_MODE })
}

/**
 * Issue a standing grant. Pure: returns the next store, or a refusal and no
 * store. The checks run in a fixed order and the first that fails is the one
 * refused. Holder and issuer are checked only as ids here; who may hold or
 * issue is the caller's check against the registry.
 */
export function issueStanding(
  store: StandingStore,
  terms: { id: string; holder: string; issuer: string; scopes: string[]; periodMs?: number; hardMaxMs: number },
  now: number,
): StandingChange<IssueRefusal> {
  const refuse = (code: IssueRefusal['code']): StandingChange<IssueRefusal> => ({ refused: { code } })
  const scopes = [...new Set(terms.scopes)].sort()
  const period = terms.periodMs ?? DEFAULT_STANDING_PERIOD_MS
  const hardMax = terms.hardMaxMs

  if (scopes.length === 0 || !scopes.every((s) => typeof s === 'string' && s.length > 0)) return refuse('no-scope')
  if (scopes.includes('*')) return refuse('all-scopes')
  if (!scopes.every(isPluginName)) return refuse('bad-scope')
  if (!Number.isInteger(period) || period <= 0 || !Number.isInteger(hardMax)) return refuse('bad-period')
  if (period > MAX_STANDING_PERIOD_MS) return refuse('period-over-cap')
  if (hardMax > MAX_STANDING_HARD_MAX_MS) return refuse('hard-max-over-cap')
  if (hardMax < period) return refuse('hard-max-below-period')
  if (typeof terms.id !== 'string' || !STANDING_ID.test(terms.id)) return refuse('bad-id')
  if (store.grants.some((g) => g.id === terms.id)) return refuse('duplicate-id')
  if (!isPrincipalId(terms.holder) || !isPrincipalId(terms.issuer)) return refuse('bad-principal-id')
  if (terms.holder === terms.issuer) return refuse('holder-is-issuer')

  const grant: StandingGrant = {
    id: terms.id,
    holder: terms.holder,
    issuer: terms.issuer,
    scopes,
    issued_at: iso(now),
    period_start: iso(now),
    period_ms: period,
    hard_max_ms: hardMax,
  }
  return { store: { ...store, grants: [...store.grants, grant].sort(byId) } }
}

/**
 * Renew a live standing grant. Pure. Only `period_start` moves, to `now`, so
 * the hard maximum stays where issue fixed it. A lapsed grant is refused with
 * the reason and finality it read with; the holder may never renew its own.
 */
export function renewStanding(
  store: StandingStore,
  id: string,
  renewer: string,
  now: number,
  registry: RegistrySnapshot | null | undefined,
): StandingChange<RenewRefusal> {
  const grant = store.grants.find((g) => g.id === id)
  if (grant === undefined) return { refused: { code: 'unknown-id' } }
  if (renewer === grant.holder) return { refused: { code: 'holder-renews' } }
  const status = statusOf(grant, now, registry)
  if (status.reason !== null) return { refused: { code: 'lapsed', reason: status.reason, final: status.final } }
  return { store: { ...store, grants: store.grants.map((g) => (g.id === id ? { ...g, period_start: iso(now) } : g)) } }
}

/** Revoke standing grants by id. Pure. Every id must be in the store. */
export function revokeStanding(store: StandingStore, ids: string[]): StandingChange<RevokeRefusal> {
  if (ids.length === 0) return { refused: { code: 'no-ids' } }
  const held = new Set(store.grants.map((g) => g.id))
  if (ids.some((id) => !held.has(id))) return { refused: { code: 'unknown-id' } }
  const dropped = new Set(ids)
  return { store: { ...store, grants: store.grants.filter((g) => !dropped.has(g.id)) } }
}
