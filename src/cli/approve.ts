/**
 * `warpline approve` — answer whichever gate is actually waiting.
 *
 * One word answers two different gates, and this file decides which:
 *
 *   1. **A parked result.** A supervised plugin ran, its side effects fired,
 *      and its result was parked pending a human yes. Approving it RECORDS
 *      that result. Nothing is re-invoked and no grant is written.
 *   2. **A session Grant.** A side-effecting plugin has not been permitted to
 *      run at all. Approving it merges a Grant, and the next advance runs it.
 *
 * **Gate-first, because the risk is asymmetric.** Merging a Grant when the
 * operator meant "apply that parked result" leaves the plugin due, so it runs
 * again and re-fires side effects that already fired — the handler runs before
 * the supervision gate ever sees the result, so approval can never be
 * permission to re-run. The reverse mistake leaves no Grant and records a skip
 * on the next advance: annoying, not dangerous. The command prints which of the
 * two it did, in both branches, so the operator never has to infer it.
 *
 * There is a THIRD mode, `--content`, and it answers neither of those two: it
 * records a standing yes to SPECIFIC BYTES a producer has already written, so a
 * later unattended advance may ship exactly those and nothing else. It writes
 * no grant and applies no parked result. Like the pair above it is refused
 * whole when mixed with either — there is no half-answer that is not a lie
 * about one of the three. It is the only one of the three with a withdrawal
 * gesture of its own, `--content --remove`: `revoke` retires a grant and `deny`
 * answers a proposal with a no, and neither of those is an operator taking back
 * a yes they already gave to specific bytes.
 *
 * **The gate-apply branch reaches no symbol in `approval-gate.ts`, and so does
 * the content branch.** That is what makes "an outcome review mints no
 * side-effect authority" — and "a content approval mints no session
 * authority" — true by structure rather than by test. Neither branch reaches
 * `mergeGrant`, the default TTL or the grant ceiling. Keep it that way: an
 * import added here for convenience would quietly turn a structural guarantee
 * back into a hope. `--content` is likewise NOT a second breadth gesture:
 * blanket approval stays reachable only through `--all`.
 *
 * The order of operations in `run()` is the security property, not an
 * implementation detail. Everything that can refuse the command runs BEFORE
 * anything is written: every positional is checked against the loaded
 * manifests, the TTL is parsed, and on the Grant path every name is checked
 * against the denial record. Any one of them refuses the whole command with
 * nothing on disk. Validating as you go and writing per name would leave a
 * half-applied grant behind on a typo — the operator would then believe they
 * had granted three scopes and actually have granted one, which is exactly the
 * state a gate must never be in. A mixed invocation — some names with a parked
 * gate, some without — is refused whole for the same reason: there is no
 * half-answer that is not a lie about one of the two gates.
 *
 * That property covers the refusals, and it stops at the apply loop.
 * `applyPendingGate` writes state per call, so with several gated plugins a
 * later refusal leaves the earlier applies on disk. It cannot be otherwise
 * without buffering outcome records across plugins. The loop prints a summary
 * naming what was applied and what was refused, so a reader never carries the
 * stronger all-or-nothing claim across into a place where it is false.
 *
 * Blanket approval is reachable ONLY through an explicit `--all`. No positional
 * name is treated as a wildcard, so no plugin name, glob or shell expansion can
 * widen a grant past what the operator typed. `--all` is unambiguously a Grant
 * gesture and never applies a parked result.
 *
 * Never terminates the process — it returns a code to the dispatcher.
 */
import { parseArgs } from 'node:util'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  applyPendingGate,
  approvalStanding,
  denialStanding,
  eraseIfReleased,
  findPendingGate,
  lastOutputIsCurrent,
  loadPluginManifests,
  proposalFingerprint,
} from '../runtime/engine.js'
import { DEFAULT_TTL_MS, mergeGrant, MAX_GRANT_WINDOW_MS } from '../runtime/approval-gate.js'
import { pathsForStateFile, withStateLockAt } from '../board/state-manager.js'
import { resolveWallClock } from '../lib/wall-clock.js'
import {
  EngineStateInvalidError,
  readEngineState,
  readEngineStateReadOnly,
  writeEngineState,
} from '../runtime/engine-state-store.js'
import type { Approval, EngineState } from '../schemas/engine-state.js'
import type { PluginManifest } from '../schemas/plugin-manifest.js'
import { engineStatePath, pluginsDir, sessionApprovalPath } from '../lib/paths.js'
import { suggest } from './suggest.js'

// Both hour figures are derived, not typed. The `--long` line read a literal
// `24h` while the constant moved to 23, and docs.test.ts guards the DOCS
// against the constant but nothing guarded this string — the one the operator
// actually reads. Same lesson as the dispatcher's command list.
const CEILING_H = MAX_GRANT_WINDOW_MS / (60 * 60 * 1000)
const DEFAULT_TTL_H = DEFAULT_TTL_MS / (60 * 60 * 1000)

const USAGE = `Usage: warpline approve <plugin>... [options]
       warpline approve --all [options]
       warpline approve <plugin> --content --not-after <wall> [options]

Answers whichever gate is waiting. If the plugin has a parked result awaiting
review, that result is recorded — nothing is re-run and no grant is written.
Otherwise it grants side-effecting plugins permission to run for this session.
Grants are additive: approving 'b' after 'a' leaves both approved.

Options:
  --all        Approve every plugin (blanket). Prints its coverage first.
  --ttl <dur>  Requested lifetime, e.g. 30m, 4h, 3d. Default ${DEFAULT_TTL_H}h.
  --replace    Overwrite the current scope list instead of adding to it.
  --long       Permit an expiry past ${CEILING_H}h from the first grant.

Content approval (one plugin, declaring approval_class: 'content'):
  --content         Approve the bytes its single dependency has already
                    produced, so a later unattended advance ships exactly
                    those. Writes no session grant.
  --not-after <w>   REQUIRED. Wall clock the window closes, YYYY-MM-DDTHH:mm.
  --not-before <w>  Wall clock the window opens. Default: now.
  --zone <iana>     IANA zone both bounds are read in. Default: UTC.
  --remove          Withdraw the content approval. Only with --content; a
                    session grant is withdrawn with 'warpline revoke'.
`

const MINUTE = 60 * 1000
const DURATION = /^(\d+)([mhd])$/
const UNIT_MS: Record<string, number> = { m: MINUTE, h: 60 * MINUTE, d: 24 * 60 * MINUTE }

/** Parse `30m` / `4h` / `3d` to integer milliseconds. Returns null if unusable. */
function parseDuration(input: string): number | null {
  const m = DURATION.exec(input)
  if (!m) return null
  const ms = Number(m[1]) * UNIT_MS[m[2]]
  return ms > 0 ? ms : null
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`

/** The zone the bounds are read in when the operator names none. */
const DEFAULT_ZONE = 'UTC'

/**
 * The two lines the approved bytes are printed between, so a reader — and a
 * test — can tell where the plugin's text starts and where it stops.
 */
const BODY_BEGIN = '----- begin approved bytes -----'
const BODY_END = '----- end approved bytes -----'

/**
 * The producer's bytes as the operator will actually read them: every control
 * character visible, nothing removed and nothing cut short.
 *
 * Module-local and not a shared helper: there is exactly one caller and no
 * second one is foreseen. The rules, in order:
 *
 *   1. Escape a literal backslash to two, FIRST, so an escape this function
 *      emitted is tellable apart from a backslash the plugin authored.
 *   2. Replace every C0 control character (U+0000 through U+001F) except LF and
 *      TAB, plus DEL (U+007F), and every C1 control character (U+0080 through
 *      U+009F), with a visible `\xNN` escape. ESC renders `\x1b` and BEL
 *      renders `\x07` out of that general form rather than by a special case.
 *      Escape, never strip: stripping removes the evidence that an attack was
 *      attempted, and seeing what is actually in the bytes is the operator's
 *      whole job here.
 *   3. Never truncate, at any size. The Output schema bounds an inline body at
 *      16 KiB, so there is no unbounded case to defend against, and cutting
 *      would hide the tail — which is where a long batch's surprises live.
 *   4. Leave LF and TAB alone. Line and column structure is the thing being
 *      reviewed, and escaping it would make a multi-line batch unreadable.
 *
 * Rules 1 and 2 are ONE pass over the string, which is what makes "backslash
 * first" true without a second pass re-escaping its own output.
 *
 * The ceiling, stated because it is real: a body may carry plain text that
 * imitates the delimiters or the fingerprint line. Escaping cannot prevent
 * that; it prevents REPAINTING, which is what the control characters would have
 * done, and repainting is the difference between a forgery the operator can see
 * and one they cannot. The fingerprint is printed before the body, so a forged
 * copy inside it arrives after the one the runtime computed.
 */
/**
 * The sentence both marked-unconfirmed refusals say, so they cannot drift into
 * saying two different things about one record.
 *
 * It names the plugin, the effect id and the instant of the mark and NOTHING
 * else — no producer name, no window bound, and never a byte of the approved
 * content. The effect id is the operator's handle at the sink, which is where
 * the open question is actually settled. It is null only on a record marked by
 * a runtime that predates the id, and then the sentence names the hand edit
 * instead, because `warpline resolve`, the verb it would otherwise point at,
 * refuses such a record.
 */
function markedUnconfirmed(plugin: string, approval: Approval): string {
  if (approval.effect_id === null) {
    return (
      `${plugin} was marked at ${approval.marked_at} and never confirmed, by a build that recorded ` +
      `no effect id, so the runtime cannot tell whether those bytes shipped and there is nothing ` +
      `to check the sink with or to answer against: neither this command nor 'warpline resolve' ` +
      `can clear it. Only a hand edit of <home>/state/engine-state.json clears the record, once ` +
      `you are sure of the sink. Nothing was written.\n`
    )
  }
  const effect = approval.effect_id
  return (
    `${plugin} was marked at ${approval.marked_at} and never confirmed, so the runtime does not ` +
    `know whether those bytes shipped. Resolve it at the sink using effect id ${effect} first: ` +
    `once the sink shows nothing arrived, answer it with ` +
    `'warpline resolve ${plugin} --not-shipped <effect-id>'. Nothing was written.\n`
  )
}

function escapeForOperator(body: string): string {
  // A character loop rather than a regex character class: the bounds below are
  // numbers a reader can check against the four rules above, where a class of
  // unicode escapes is a line nobody proof-reads.
  let out = ''
  for (const ch of body) {
    if (ch === '\\') {
      out += '\\\\'
      continue
    }
    const code = ch.charCodeAt(0)
    const control =
      (code < 0x20 && ch !== '\n' && ch !== '\t') ||
      code === 0x7f ||
      (code >= 0x80 && code <= 0x9f)
    out += control ? `\\x${code.toString(16).padStart(2, '0')}` : ch
  }
  return out
}

/**
 * Record a standing yes to the bytes one plugin's single declared dependency
 * has already produced.
 *
 * Everything that can refuse runs INSIDE the lock and BEFORE any mutation of
 * `state.approvals`, so a refused command leaves the document byte-unchanged.
 * That ordering is the security property here exactly as it is in `run()`
 * above, and it is why the read is inside the lock rather than beside it: this
 * rewrites the whole state document, and an advance completing between a read
 * outside and the write would be erased by a command that only meant to record
 * an approval.
 *
 * A record this replaces is withdrawn in the same locked write, and its content
 * is released by the rule `approve --content --remove` uses. When the new
 * record names the same producer, it binds that producer's current Output and
 * holds it, so nothing is erased.
 */
async function approveContent(
  consumer: string,
  values: { 'not-after'?: string; 'not-before'?: string; zone?: string },
  manifests: Map<string, PluginManifest>,
): Promise<number> {
  const manifest = manifests.get(consumer)
  if (manifest === undefined) {
    // Unreachable: every positional was checked against `manifests` before this
    // call. Written out so the record narrows rather than silently continuing
    // on a broken invariant.
    throw new Error(`approve: '${consumer}' passed name validation but has no manifest`)
  }

  const zone = values.zone ?? DEFAULT_ZONE

  const statePath = engineStatePath()
  // The lock that guards THIS document, not whatever the state manager's module
  // paths happen to point at — a bare `withStateLock` resolves through
  // `activePaths()` and can lock a directory a sibling test file deleted while
  // reporting success.
  const lockPath = pathsForStateFile(statePath).lockPath

  return await withStateLockAt(lockPath, async () => {
    // Read once the lock is held. The wait can outlast a --not-after, and every
    // decision below (the closed-window check, standing, approved_at, erasure) is
    // about the state this write replaces, so it reads the clock at that instant.
    const now = Date.now()
    let state: EngineState
    try {
      state = await readEngineState(statePath)
    } catch (err) {
      if (!(err instanceof EngineStateInvalidError)) throw err
      process.stderr.write(
        `Cannot read engine state: ${err.reason}\nNothing was approved.\n`,
      )
      return 1
    }

    // -- The class ---------------------------------------------------------
    // Writing a record nothing would ever read is a lie about what was
    // approved: the operator walks away believing a batch is authorised, and
    // the plugin is gated by the session Grant exactly as before.
    if (manifest.approval_class !== 'content') {
      process.stderr.write(
        `${consumer} declares approval_class '${manifest.approval_class}', so nothing would ever ` +
          `read a content approval written for it — it is gated by the session Grant instead. ` +
          `Approve it with 'warpline approve ${consumer}', or change its manifest. ` +
          `Nothing was written.\n`,
      )
      return 1
    }

    // -- The open question -------------------------------------------------
    // A record marked and never confirmed says the runtime began firing and
    // cannot prove it finished. Writing a fresh approval over it would erase
    // that question rather than answer it, and re-arm a send that may already
    // have gone out. The standing is READ, never re-derived here: a hand-rolled
    // `marked_at !== null && confirmed_at === null` is a second answer to a
    // question that already has one, and two answers eventually disagree.
    const standing = approvalStanding(state, consumer, manifests, now)
    if (standing.standing === 'indeterminate') {
      process.stderr.write(markedUnconfirmed(consumer, standing.approval))
      return 1
    }

    // Guaranteed by the manifest's own cross-field rule, which the check above
    // has now established — so this is a narrowing, not a check of its own.
    const producer = manifest.dependencies[0]!

    // -- The producer ------------------------------------------------------
    const producerManifest = manifests.get(producer)
    if (producerManifest === undefined) {
      process.stderr.write(
        `${consumer} declares '${producer}' as its dependency, but no such plugin is installed, ` +
          `so the bytes it would ship cannot be identified. Nothing was written.\n`,
      )
      return 1
    }

    // This is also what closes the hole a plain index read leaves open one
    // level down: the fingerprint's subject here is an operator-reachable
    // producer name, a wider input than a declared dependency name is
    // elsewhere, and the closure runs through this validation rather than
    // through that function.
    const lastOutput = state.plugin_runs[producer]?.last_output
    if (lastOutput === undefined) {
      process.stderr.write(
        `${producer} has never produced an Output, so there are no bytes to approve. ` +
          `Run it first — a content approval is a yes to something that already exists, not a ` +
          `standing permission for whatever it produces next. Nothing was written.\n`,
      )
      return 1
    }

    // Erased content is its own refusal, checked before the file check below.
    // The record says the producer produced, and its content is gone, so there
    // is nothing an operator could have read. Only the two plugin names are
    // interpolated.
    if (lastOutput.erased_at !== undefined) {
      process.stderr.write(
        `${consumer} cannot be approved by content: ${producer}'s last Output was erased ` +
          `when the approval that bound it closed or was withdrawn, so there are no bytes to read. ` +
          `Run ${producer} again to produce new content. Nothing was written.\n`,
      )
      return 1
    }

    // A carried Output is refused by name too. The producer's latest run
    // produced none, so what is on file was carried forward from an earlier run
    // and is not what the producer proposes now. The gate would refuse to ship
    // it, so binding it would write a yes nothing honours. The predicate is the
    // gate's own, `lastOutputIsCurrent`. Only the two plugin names are
    // interpolated.
    if (!lastOutputIsCurrent(state.plugin_runs[producer])) {
      process.stderr.write(
        `${consumer} cannot be approved by content: ${producer}'s latest run produced no Output, ` +
          `so the bytes on file came from an earlier run and are not what it proposes now. ` +
          `Run ${producer} again to produce new content. Nothing was written.\n`,
      )
      return 1
    }

    // -- The shape of the Output -------------------------------------------
    // A stored Output carries `body`, `path`, or neither once erased. Erasure
    // was refused just above, so an absent body here is the file-pointer form.
    // Refused outright rather than resolved: approving by content means
    // the operator read the exact bytes, and producing them would mean reading
    // a file the runtime was never asked to read. Refusing is also how this
    // sidesteps path traversal entirely instead of defending against it — the
    // value is never normalised, never stat-ed and never echoed back, because a
    // path on an operator's machine is exactly the kind of value that carries
    // that machine's secrets into a scrollback.
    if (lastOutput.body === undefined) {
      process.stderr.write(
        `${consumer} cannot be approved by content: ${producer}'s Output points at a file ` +
          `rather than carrying its bytes inline, and a path Output is refused rather than ` +
          `read — approving by content means you saw the exact bytes. The path is not resolved ` +
          `and is not repeated here. Nothing was written.\n`,
      )
      return 1
    }

    // -- The window --------------------------------------------------------
    const notAfter = values['not-after']
    if (notAfter === undefined) {
      process.stderr.write(
        `--not-after is required: a content approval must say when it stops being true. ` +
          `A window that never closes is ambient authority wearing a bound. Nothing was written.\n`,
      )
      return 1
    }

    // The zone is checked by RESOLVING in it, never by membership in the Intl
    // zone enumeration — that list omits zone links, so `US/Eastern` is absent
    // from it while the host resolves it perfectly well, and a membership test
    // would refuse zones that work. The same call also refuses a bound that is
    // not a naked wall clock, which is one message rather than two for one
    // mistake the operator makes in one place.
    let closesAt: number
    try {
      closesAt = resolveWallClock(notAfter, zone)
    } catch (err) {
      process.stderr.write(
        `Cannot read --not-after '${notAfter}' in zone '${zone}': ` +
          `${err instanceof Error ? err.message : String(err)}\nNothing was written.\n`,
      )
      return 1
    }

    // A closed window authorises nothing, and on a re-approve the release in
    // this same write would erase the bytes the command is about to print.
    if (closesAt <= now) {
      process.stderr.write(`--not-after '${notAfter}' in zone '${zone}' has already passed, so the approval would authorise nothing. Nothing was written.\n`)
      return 1
    }

    // The approval instant when no bound was typed, which is what
    // `approvalStanding` reads for a null `not_before`. Held at this scope so
    // the resolved pair can be printed: a zone mistake is invisible in the wall
    // clocks the operator typed and obvious in the instants they resolve to.
    const notBefore = values['not-before'] ?? null
    let opensAt = now
    if (notBefore !== null) {
      try {
        opensAt = resolveWallClock(notBefore, zone)
      } catch (err) {
        process.stderr.write(
          `Cannot read --not-before '${notBefore}' in zone '${zone}': ` +
            `${err instanceof Error ? err.message : String(err)}\nNothing was written.\n`,
        )
        return 1
      }
      // A window that cannot open. Checked once both bounds RESOLVE, rather
      // than by comparing the two strings: across a DST transition the later
      // wall clock is not always the later instant, and a string comparison
      // would accept a window that never opens while refusing one that does.
      if (opensAt >= closesAt) {
        process.stderr.write(
          `--not-before '${notBefore}' is not before --not-after '${notAfter}' in zone '${zone}', ` +
            `so the window would never open. Nothing was written.\n`,
        )
        return 1
      }
    }

    const fingerprint = proposalFingerprint(state, producer, producerManifest)
    const replaced = Object.hasOwn(state.approvals, consumer) ? state.approvals[consumer] : undefined
    state.approvals[consumer] = {
      plugin: consumer,
      producer,
      fingerprint,
      run_id: lastOutput.run_id ?? null,
      approved_at: new Date(now).toISOString(),
      not_before: notBefore,
      not_after: notAfter,
      zone,
      effect_id: null,
      marked_at: null,
      confirmed_at: null,
    }
    // Replacing a record withdraws it. The new record is already in the table,
    // so it holds whatever it binds.
    if (replaced !== undefined) {
      eraseIfReleased(state.plugin_runs, state.pending_gates, replaced.producer, state.approvals, manifests, now, replaced)
    }
    await writeEngineState(state, statePath)

    // Header, fingerprint, window, then the bytes — the bytes last, so nothing
    // the plugin authored precedes the values the runtime computed.
    process.stdout.write(
      `Answering the content gate: ${consumer} may ship what ${producer} has already produced.\n` +
        `Bound to the fingerprint on the next line, whole and untruncated:\n` +
        `${fingerprint}\n` +
        `Window ${notBefore ?? 'now'} to ${notAfter} read in ${zone}, which resolves to\n` +
        `  ${new Date(opensAt).toISOString()} to ${new Date(closesAt).toISOString()}\n` +
        `If those bytes move, this approval stops applying: it is not renewed and nothing ` +
        `re-asks on your behalf.\n` +
        `${BODY_BEGIN}\n${escapeForOperator(lastOutput.body)}\n${BODY_END}\n`,
    )
    return 0
  })
}

/**
 * Take back a standing yes to specific bytes.
 *
 * Validated against **`state.approvals`**, not against the loaded manifests, on
 * the argument `deny --remove` makes one file over: a plugin uninstalled after
 * it was approved must still be reachable from the CLI, or its record is
 * stranded in the state document for good. The manifest map is still passed,
 * because `approvalStanding` takes it — and the one arm this function refuses on
 * is decided before the map is consulted at all.
 *
 * The read and the write are ONE critical section, which is what makes the
 * marked-unconfirmed refusal enforceable rather than advisory: a record could
 * otherwise be marked between a read that saw it unmarked and the write that
 * removed it. The same write erases the content the record bound, when no
 * other open approval for the same producer still holds it.
 */
async function removeContentApproval(
  consumer: string,
  manifests: Map<string, PluginManifest>,
): Promise<number> {
  const statePath = engineStatePath()
  const lockPath = pathsForStateFile(statePath).lockPath

  return await withStateLockAt(lockPath, async () => {
    // Read once the lock is held, for the reason `approveContent` gives.
    const now = Date.now()
    let state: EngineState
    try {
      state = await readEngineState(statePath)
    } catch (err) {
      if (!(err instanceof EngineStateInvalidError)) throw err
      process.stderr.write(`Cannot read engine state: ${err.reason}\nNothing was removed.\n`)
      return 1
    }

    // `Object.hasOwn`, not `!== undefined`: this name comes straight from the
    // operator and is deliberately not checked against the manifests, so
    // `--remove toString` arrives here — and a plain index read answers that
    // with an inherited function, which would make the guard miss, the delete
    // remove nothing, and the operator be told an approval they never had was
    // taken back.
    if (!Object.hasOwn(state.approvals, consumer)) {
      process.stderr.write(
        `No content approval recorded for ${consumer}, so there is nothing to withdraw. ` +
          `Nothing was removed.\n`,
      )
      return 1
    }

    // A marked record is never replaced by absence. Deleting it destroys the
    // only evidence that a send may have landed, which is the same question the
    // refusal to re-approve exists to keep open — the two are one rule seen from
    // its two sides, so they say the same sentence.
    const standing = approvalStanding(state, consumer, manifests, now)
    if (standing.standing === 'indeterminate') {
      process.stderr.write(markedUnconfirmed(consumer, standing.approval))
      return 1
    }

    // Withdrawal is a closure, so the content it bound is released in this
    // same locked write, under the rule the advance's erasure uses. Left to the
    // next advance it would never go: nothing would name the run any more.
    // The copy an applied gate holds of it goes in the same write.
    const withdrawn = state.approvals[consumer]!
    delete state.approvals[consumer]
    eraseIfReleased(state.plugin_runs, state.pending_gates, withdrawn.producer, state.approvals, manifests, now, withdrawn)
    await writeEngineState(state, statePath)
    process.stdout.write(
      `Withdrew the content approval for ${consumer}. Those bytes will not ship on any later ` +
        `advance, and ${consumer} is reported as unapproved again rather than as refused — ` +
        `withdrawing is not a no to the proposal, it is the yes taken back.\n`,
    )
    return 0
  })
}

export async function run(argv: string[]): Promise<number> {
  let values: {
    all?: boolean
    ttl?: string
    replace?: boolean
    long?: boolean
    content?: boolean
    'not-after'?: string
    'not-before'?: string
    zone?: string
    remove?: boolean
  }
  let positionals: string[]
  try {
    // strict: true buys unknown-flag rejection, and a missing or dash-leading
    // --ttl value, with no hand-rolled scan.
    const parsed = parseArgs({
      args: argv,
      options: {
        all: { type: 'boolean' },
        ttl: { type: 'string' },
        replace: { type: 'boolean' },
        long: { type: 'boolean' },
        content: { type: 'boolean' },
        'not-after': { type: 'string' },
        'not-before': { type: 'string' },
        zone: { type: 'string' },
        remove: { type: 'boolean' },
      },
      allowPositionals: true,
      strict: true,
    })
    values = parsed.values
    // De-duplicated once, here, so every later stage sees each name exactly
    // once. `approve foo foo` used to apply the gate and then re-find it with
    // `applied_at` set, reporting "already applied" and exiting 1 on a
    // successful apply. Order is preserved, so the output still follows what
    // the operator typed.
    positionals = [...new Set(parsed.positionals)]
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`)
    return 1
  }

  // The third mode is refused WHOLE when mixed, on the same argument the pair
  // below already makes: there is no half-answer that is not a lie about one of
  // the modes. A content approval writes no grant, so a grant clock alongside it
  // would be an unanswerable request rather than an ignorable one.
  if (values.content) {
    const mixed = [
      values.all ? '--all' : null,
      values.ttl !== undefined ? '--ttl' : null,
      values.replace ? '--replace' : null,
      values.long ? '--long' : null,
    ].filter((f): f is string => f !== null)
    if (mixed.length > 0) {
      process.stderr.write(
        `--content approves specific bytes and writes no session grant, so ${mixed.join(', ')} ` +
          `${mixed.length === 1 ? 'has' : 'have'} nothing to act on. Nothing was written — ` +
          `run the two gestures separately.\n`,
      )
      return 1
    }
    if (positionals.length !== 1) {
      process.stderr.write(
        `--content approves one plugin's frozen batch, and it names exactly one plugin ` +
          `(got ${positionals.length}). A content approval is bound to one producer's bytes, ` +
          `so there is no breadth gesture here — blanket approval stays --all.\n`,
      )
      return 1
    }
    // Withdrawing takes back a window that is already on the record; it does
    // not set one. Vanishing silently is what this file refuses to do with a
    // flag the operator typed, so the window flags are named rather than
    // ignored.
    if (values.remove) {
      const windowFlags = [
        values['not-after'] !== undefined ? '--not-after' : null,
        values['not-before'] !== undefined ? '--not-before' : null,
        values.zone !== undefined ? '--zone' : null,
      ].filter((f): f is string => f !== null)
      if (windowFlags.length > 0) {
        process.stderr.write(
          `--remove withdraws the approval whole, so ${windowFlags.join(', ')} ` +
            `${windowFlags.length === 1 ? 'has' : 'have'} nothing to act on — an approval is ` +
            `taken back, never edited in place. Nothing was removed.\n`,
        )
        return 1
      }
    }
  } else if (values.remove) {
    // Not a no-op and not a grant gesture. Falling through here would have
    // merged a session Grant while the operator was asking for something to be
    // taken away, which is the wrong-gesture mistake this whole file is shaped
    // around.
    process.stderr.write(
      `--remove withdraws a content approval and only makes sense with --content. ` +
        `A session grant is retired with 'warpline revoke', and a proposal is answered ` +
        `no with 'warpline deny'. Nothing was written.\n`,
    )
    return 1
  }

  if (values.all && positionals.length > 0) {
    process.stderr.write('--all approves every plugin; do not also name plugins.\n')
    return 1
  }
  if (!values.all && positionals.length === 0) {
    process.stderr.write(USAGE)
    return 1
  }

  let ttlMs: number | undefined
  if (values.ttl !== undefined) {
    const parsed = parseDuration(values.ttl)
    if (parsed === null) {
      process.stderr.write(
        `--ttl expects a positive duration like 30m, 4h or 3d — got '${values.ttl}'.\n`,
      )
      return 1
    }
    ttlMs = parsed
  }

  const { manifests, failures } = await loadPluginManifests(pluginsDir())

  // -- Withdrawal: answered by the record, not by what is installed ---------
  // Returns BEFORE the name validation below, and that position is the point.
  // A plugin uninstalled after it was approved has no manifest, so validating
  // this name against the manifests would report it unknown and strand its
  // record in the state document with no CLI gesture that reaches it.
  if (values.content && values.remove) {
    return await removeContentApproval(positionals[0]!, manifests)
  }

  // Name validation, all of it, before any write.
  if (!values.all) {
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
      process.stderr.write('Nothing was granted.\n')
      return 1
    }
  }

  const now = Date.now()
  const approvalPath = sessionApprovalPath()

  // -- Content approval: a standing yes to bytes that already exist ---------
  // Reaches no symbol in `approval-gate.ts`, writes no grant, applies no parked
  // result, and returns before the gate-first dispatch below ever runs.
  if (values.content) {
    return await approveContent(positionals[0]!, values, manifests)
  }

  // -- Gate-first dispatch -------------------------------------------------
  // The write-capable read, on purpose: this command may go on to write. On an
  // unusable state document it aborts BOTH branches rather than falling
  // through, because it cannot prove no parked gate exists — and merging a
  // Grant for a plugin whose result is already parked is the exact wrong-gesture
  // mistake gate-first exists to prevent. A missing file yields defaults, so a
  // fresh install still reaches the Grant path unchanged.
  const statePath = engineStatePath()
  if (!values.all) {
    // **The named path is one locked read-modify-write, and it has to be.**
    // Everything below reads the state document and then writes it back through
    // `applyPendingGate`, and R11's own Edge Coverage row assumes that window is
    // serialised against a concurrent `approve --content`. It was not: only the
    // content branch took a lock, this branch read and wrote outside one, and
    // `applyPendingGate` writes state per call without taking one of its own. A
    // content approval landing from a second attachment between the read and the
    // apply was simply overwritten.
    //
    // The lock wraps the LOOP rather than each call, because the module
    // docstring's observation above is what makes per-call locking wrong here:
    // `applyPendingGate` writes state per call, so several gated plugins are
    // several read-modify-writes over one in-memory document, and a lock
    // released between them reopens the window it was taken to close.
    //
    // Nothing nests. `applyPendingGate` takes no lock — the sibling gate in
    // `engine.ts` asserts that its body never names one — and the imported lock
    // is a non-reentrant `O_EXCL` acquire that would block for the state
    // manager's full ceiling and then throw.
    //
    // The same derived lock path the content branch uses: the lock that guards
    // THIS document, never whatever the state manager's module paths happen to
    // point at.
    //
    // `null` means "fell through to the Grant path"; every other value is this
    // command's exit code, decided while the lock was held.
    const lockPath = pathsForStateFile(statePath).lockPath
    // The lock is an `O_EXCL` file, so its directory has to exist before the
    // acquire — and on a fresh home it does not, because `resolveHome` creates
    // nothing. Without this, `approve <plugin>` on a brand-new install died
    // with an ENOENT on a lock file instead of merging the Grant it was asked
    // for. `recursive: true` so an existing directory is a no-op rather than a
    // second failure mode.
    await mkdir(dirname(lockPath), { recursive: true })
    const settled = await withStateLockAt(
      lockPath,
      async (): Promise<number | null> => {
    let state
    try {
      state = await readEngineState(statePath)
    } catch (err) {
      if (!(err instanceof EngineStateInvalidError)) throw err
      process.stderr.write(
        `Cannot read engine state: ${err.reason}\n` +
          `Nothing was approved — with the state document unreadable there is no way to tell ` +
          `whether a parked result is waiting, and granting one by mistake would let a plugin ` +
          `re-run side effects that already fired.\n`,
      )
      return 1
    }

    // A LIVE gate, not merely a gate. `findPendingGate` returns already-applied
    // markers on purpose, and branching on that predicate is what decides which
    // of the two gates the operator meant — so a spent marker used to route
    // every `approve <plugin>` into the apply path, where it was refused. For
    // as long as the marker lived (up to the 24h ceiling) the Grant verb was
    // unreachable by name, which stranded any operator whose Grant expired
    // after an apply: the plugin was skipped as `unapproved` every advance and
    // the only gesture that still worked was `--all`, a wider authority than
    // was asked for. A marker's job is to stop a second APPLY re-recording a
    // result, which `applyPendingGate` enforces on its own `applied_at` check;
    // it was never permission-to-run.
    const liveGate = (name: string) => {
      const g = findPendingGate(state, name)
      return g !== undefined && g.applied_at === null ? g : undefined
    }
    const gated = positionals.filter((name) => liveGate(name) !== undefined)
    if (gated.length > 0 && gated.length < positionals.length) {
      const ungated = positionals.filter((n) => !gated.includes(n))
      process.stderr.write(
        `These plugins have a parked result awaiting review: ${gated.join(', ')}\n` +
          `These have none and would need a session Grant: ${ungated.join(', ')}\n` +
          `Approve them separately — one command cannot answer both gates without ` +
          `doing the wrong thing to one of them. Nothing was written.\n`,
      )
      return 1
    }

    if (gated.length > 0) {
      // Counted, not latched. `applyPendingGate` writes state per call, so with
      // several gated plugins a third refusal leaves the first two applied —
      // and a bare `failed` flag exited 1 while printing nothing to say that
      // anything had succeeded. The module docstring's "one bad name aborts the
      // whole command with nothing on disk" is a claim about NAME VALIDATION,
      // which happens before any write; it does not extend to this loop, and
      // the summary below is what stops a reader assuming it does.
      // The Grant-clock flags do nothing here, and vanishing silently let the
      // operator believe a window they asked for is open. Applying a parked
      // result writes no grant at all, so there is no clock for `--ttl`,
      // `--replace` or `--long` to set. Named, not summarised: the operator
      // typed a specific flag and should see that specific flag reported.
      //
      // Read off `values` rather than a list, so a flag added to parseArgs
      // later cannot quietly join the set of things that disappear. `--ttl`
      // tests the raw value because its default is applied downstream.
      const ignoredFlags = [
        values.ttl !== undefined ? '--ttl' : null,
        values.replace ? '--replace' : null,
        values.long ? '--long' : null,
      ].filter((f): f is string => f !== null)
      if (ignoredFlags.length > 0) {
        process.stderr.write(
          `Note: ${ignoredFlags.join(', ')} ${ignoredFlags.length === 1 ? 'was' : 'were'} ignored. ` +
            `Applying a parked result records an outcome and writes no grant, so there is no ` +
            `grant clock to set.\n`,
        )
      }

      const applied: string[] = []
      const refused: string[] = []
      for (const name of gated) {
        // Re-found each time: a preceding apply may have rewritten the array,
        // and an apply this loop already performed leaves a marker rather than
        // a live gate — so a repeated name applies once and is skipped after.
        const gate = liveGate(name)
        if (gate === undefined) continue
        // Not a guard: every positional was checked against `manifests` above,
        // before anything was written, so an absence here is a broken invariant
        // rather than an operator error. `continue` swallowed it silently and
        // would have skipped the plugin's apply without saying so.
        const manifest = manifests.get(name)
        if (manifest === undefined) {
          throw new Error(`approve: '${name}' passed name validation but has no manifest`)
        }

        // A standing denial outranks an apply. `deny` and `approve` answer the
        // same proposal, so applying a result the operator explicitly refused
        // is the one gesture the denial record exists to make impossible — and
        // without this it succeeded silently, leaving a live denial and an
        // applied outcome for the same proposal in the same document.
        //
        // Only a denial that still matches blocks. A superseded one is already
        // stale everywhere else, and refusing on it would strand the operator
        // behind an answer to a question that no longer exists.
        //
        const standing = denialStanding(state, name, manifest)
        if (standing.standing === 'live') {
          const denial = standing.denial
          process.stderr.write(
            `${name} was denied at ${denial.denied_at} ('${denial.reason}') and that answer still ` +
              `matches this proposal. Nothing was applied and no grant was written — take the ` +
              `denial back first: warpline deny --remove ${name}\n`,
          )
          refused.push(name)
          continue
        }

        // `manifests` is the whole loaded map, not this plugin's manifest: the
        // discard's approval carve-out resolves a PRODUCER named on an approval
        // record, which is a different plugin from the one being applied.
        const result = await applyPendingGate(state, gate, manifest, {
          statePath,
          manifests,
          now,
        })

        if (result.outcome === 'applied') {
          applied.push(name)
          process.stdout.write(
            `Applied the parked result for ${name} from run ${result.run_id}: ${result.summary}\n` +
              `Recorded at ${result.run_completed_at}, when the run finished. ` +
              `Nothing was re-run and no grant was written.\n`,
          )
          continue
        }
        refused.push(name)
        if (result.outcome === 'already_applied') {
          process.stderr.write(
            `The parked result for ${name} was already applied at ${result.applied_at}. ` +
              `Nothing changed — a result is recorded once.\n`,
          )
        } else if (result.reason === 'superseded') {
          // Nothing was deleted, so the plugin is not due again on that
          // account: its entry is the later run's record.
          process.stderr.write(
            `Refused the parked result for ${name}: ${result.detail}\n` +
              `The gate was discarded, and the later run's record stands. No grant was written.\n`,
          )
        } else {
          process.stderr.write(
            `Refused the parked result for ${name}: ${result.detail}\n` +
              `The gate was discarded and ${name} is due again on the next advance. ` +
              `No grant was written.\n`,
          )
        }
      }

      // Only when there is something a per-plugin line did not already say. On
      // the single-plugin case the lines above are the whole story.
      if (applied.length > 0 && refused.length > 0) {
        process.stderr.write(
          `Applied ${plural(applied.length, 'parked result')} (${applied.join(', ')}) and ` +
            `refused ${refused.length} (${refused.join(', ')}). The applies are on disk — ` +
            `a refusal does not undo them.\n`,
        )
      }
      return refused.length > 0 ? 1 : 0
    }

    // Falling through to the Grant path.
    //
    // A live denial REFUSES here, it does not merely annotate. The denial check
    // in `evaluatePlugin` sits before the approval gate, so a denied plugin is
    // skipped as `denied` on the next advance no matter what is granted — a
    // grant written here buys the operator nothing and widens side-effect
    // authority to get it. Reporting exit 0 and "Approved 1 scope" for a
    // plugin that will not run is the gate reporting a success it did not
    // achieve, which is the one thing it must never do.
    //
    // The apply arm above already refuses on the same standing. Answering the
    // same fact two different ways depending on which arm the operator landed
    // in was the actual defect: `deny p` then `approve p` exited 0 while `deny
    // p` then `approve p` on a parked result exited 1, for one denial.
    //
    // This is not the lockout CR-01 was. That had no in-band escape; this names
    // one, `warpline deny --remove`, which is the gesture that retires the
    // answer standing in the way. Every name is checked before anything is
    // written, so a refusal leaves nothing on disk — the same property name
    // validation has, and for the same reason.
    const denied: string[] = []
    for (const name of positionals) {
      // A spent marker on file. The operator typed the same words that applied
      // a result a moment ago and is getting a different answer, and an
      // unexplained change of behaviour on an unchanged gesture is exactly what
      // a gate must never do. A note and not a refusal: the grant is real and
      // does what the line says, so there is no false success to prevent.
      const spent = findPendingGate(state, name)
      if (spent?.applied_at != null) {
        process.stdout.write(
          `Note: ${name}'s parked result from run ${spent.run_id} was already applied at ` +
            `${spent.applied_at}. This grants ${name} permission to run again — it does not ` +
            `re-record that result.\n`,
        )
      }

      // Only a denial that still matches. A superseded one is stale everywhere
      // else and refusing on it would strand the operator behind an answer to a
      // question that no longer exists.
      const manifest = manifests.get(name)
      const standing =
        manifest === undefined
          ? ({ standing: 'none' } as const)
          : denialStanding(state, name, manifest)
      if (standing.standing === 'live') {
        process.stderr.write(
          `${name} was denied at ${standing.denial.denied_at} ('${standing.denial.reason}') and ` +
            `that answer still matches its proposal, so it would be skipped as denied on the ` +
            `next advance and this grant would not make it run.\n`,
        )
        denied.push(name)
      }
    }

    // Every name, then refuse once — the operator fixes one thing rather than
    // rediscovering the next on each retry.
    if (denied.length > 0) {
      process.stderr.write(
        `Nothing was granted. Take the ${denied.length === 1 ? 'denial' : 'denials'} back ` +
          `first: warpline deny --remove ${denied.join(' ')}\n`,
      )
      return 1
    }
        // Fell through: no parked gate to apply and no denial standing in the
        // way. The Grant write below touches the grant file and not this
        // document, so it happens OUTSIDE the lock rather than holding it over
        // an unrelated file.
        return null
      },
    )
    if (settled !== null) return settled
  }

  if (values.all) {
    const gated = [...manifests.values()].filter((m) => m.side_effects.length > 0)

    // Denials suppress a plugin before the approval gate is consulted, so a
    // blanket grant does not reach one. Saying "4 plugins may now run them"
    // when one of them cannot is the same false success the named path was
    // refusing — it just cannot be fixed the same way. `--all` is a BREADTH
    // gesture: the operator did not name the denied plugin, so refusing the
    // whole command over it would answer a question they did not ask. It
    // narrates instead, and grants the rest.
    //
    // Read-only, and tolerant. `--all` deliberately does not take the
    // write-capable read above — it cannot park a result, so an unreadable
    // state document is not the wrong-gesture hazard it is on the named path.
    // The note is advisory, so a read that fails costs a sentence, not the
    // command, and `--all`'s existing guarantee is unchanged.
    let suppressed: string[] = []
    try {
      const state = await readEngineStateReadOnly(engineStatePath())
      suppressed = gated
        .filter((m) => denialStanding(state, m.name, m).standing === 'live')
        .map((m) => m.name)
    } catch {
      // Unreadable or absent: say nothing rather than guess. A fresh install
      // has no denials, and a broken document is not this command's to report.
    }

    const reachable = gated.filter((m) => !suppressed.includes(m.name))
    const effects = reachable.reduce((n, m) => n + m.side_effects.length, 0)
    process.stdout.write(
      `Blanket approval: ${plural(reachable.length, 'plugin')} declaring ` +
        `${plural(effects, 'side effect')} may now run them.\n`,
    )
    if (suppressed.length > 0) {
      process.stdout.write(
        `Note: ${suppressed.join(', ')} ${suppressed.length === 1 ? 'stays' : 'stay'} denied and ` +
          `will not run under this grant. Take the ${suppressed.length === 1 ? 'denial' : 'denials'} ` +
          `back first: warpline deny --remove ${suppressed.join(' ')}\n`,
      )
    }
  }

  // Both branches say which gate they answered, so the operator never infers it.
  process.stdout.write('Answering the Grant gate: merging a session Grant.\n')

  const result = await mergeGrant(
    values.all ? '*' : positionals,
    { ttlMs, replace: values.replace, long: values.long, now },
    approvalPath,
  )

  const remaining = Math.floor((new Date(result.expires_at).getTime() - now) / MINUTE)
  if (result.scopes === '*') {
    process.stdout.write('Approved scope: * (every plugin)\n')
  } else {
    process.stdout.write(`Approved ${plural(result.scopes.length, 'scope')}:\n`)
    for (const scope of result.scopes) process.stdout.write(`  ${scope}\n`)
  }

  const ceilingHours = MAX_GRANT_WINDOW_MS / (60 * MINUTE)
  const note = result.capped
    ? ` — capped at the ${ceilingHours}h ceiling from the first grant`
    : result.extended
      // No `(--long)` attribution: `extended` is also true for a plain approve
      // that carried an earlier --long window forward, and naming a flag this
      // invocation did not pass tells the operator they asked for something
      // they did not ask for.
      ? ` — runs beyond the ${ceilingHours}h ceiling from the first grant`
      : ''
  process.stdout.write(`Expires ${result.expires_at} (${remaining}m remaining)${note}.\n`)

  return 0
}
