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
 * **The gate-apply branch reaches no symbol in `approval-gate.ts`.** That is
 * what makes "an outcome review mints no side-effect authority" true by
 * structure rather than by test. Keep it that way: an import added here for
 * convenience would quietly turn a structural guarantee back into a hope.
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
import {
  applyPendingGate,
  denialStanding,
  findPendingGate,
  loadPluginManifests,
} from '../runtime/engine.js'
import { DEFAULT_TTL_MS, mergeGrant, MAX_GRANT_WINDOW_MS } from '../runtime/approval-gate.js'
import {
  EngineStateInvalidError,
  readEngineState,
  readEngineStateReadOnly,
} from '../schemas/engine-state.js'
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

Answers whichever gate is waiting. If the plugin has a parked result awaiting
review, that result is recorded — nothing is re-run and no grant is written.
Otherwise it grants side-effecting plugins permission to run for this session.
Grants are additive: approving 'b' after 'a' leaves both approved.

Options:
  --all        Approve every plugin (blanket). Prints its coverage first.
  --ttl <dur>  Requested lifetime, e.g. 30m, 4h, 3d. Default ${DEFAULT_TTL_H}h.
  --replace    Overwrite the current scope list instead of adding to it.
  --long       Permit an expiry past ${CEILING_H}h from the first grant.
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

export async function run(argv: string[]): Promise<number> {
  let values: { all?: boolean; ttl?: string; replace?: boolean; long?: boolean }
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

  // -- Gate-first dispatch -------------------------------------------------
  // The write-capable read, on purpose: this command may go on to write. On an
  // unusable state document it aborts BOTH branches rather than falling
  // through, because it cannot prove no parked gate exists — and merging a
  // Grant for a plugin whose result is already parked is the exact wrong-gesture
  // mistake gate-first exists to prevent. A missing file yields defaults, so a
  // fresh install still reaches the Grant path unchanged.
  const statePath = engineStatePath()
  if (!values.all) {
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

        const result = await applyPendingGate(state, gate, manifest, { statePath, now })

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
