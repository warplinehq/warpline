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
 * implementation detail: EVERY positional name is checked against the loaded
 * manifests, and the TTL is parsed, BEFORE anything is written. One unknown
 * name aborts the whole command with nothing on disk. Validating as you go and
 * writing per name would leave a half-applied grant behind on a typo — the
 * operator would then believe they had granted three scopes and actually have
 * granted one, which is exactly the state a gate must never be in. A mixed
 * invocation — some names with a parked gate, some without — is refused whole
 * for the same reason: there is no half-answer that is not a lie about one of
 * the two gates.
 *
 * Blanket approval is reachable ONLY through an explicit `--all`. No positional
 * name is treated as a wildcard, so no plugin name, glob or shell expansion can
 * widen a grant past what the operator typed. `--all` is unambiguously a Grant
 * gesture and never applies a parked result.
 *
 * Never terminates the process — it returns a code to the dispatcher.
 */
import { parseArgs } from 'node:util'
import { applyPendingGate, findPendingGate, loadPluginManifests } from '../runtime/engine.js'
import { mergeGrant, MAX_GRANT_WINDOW_MS } from '../runtime/approval-gate.js'
import { EngineStateInvalidError, readEngineState } from '../schemas/engine-state.js'
import { engineStatePath, pluginsDir, sessionApprovalPath } from '../lib/paths.js'

const USAGE = `Usage: warpline approve <plugin>... [options]
       warpline approve --all [options]

Answers whichever gate is waiting. If the plugin has a parked result awaiting
review, that result is recorded — nothing is re-run and no grant is written.
Otherwise it grants side-effecting plugins permission to run for this session.
Grants are additive: approving 'b' after 'a' leaves both approved.

Options:
  --all        Approve every plugin (blanket). Prints its coverage first.
  --ttl <dur>  Requested lifetime, e.g. 30m, 4h, 3d. Default 4h.
  --replace    Overwrite the current scope list instead of adding to it.
  --long       Permit an expiry past 24h from the first grant.
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

/** Levenshtein distance — only ever called on a typo, so the O(nm) is free. */
function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
    prev = row
  }
  return prev[b.length]
}

/** The closest known name, or null when nothing is close enough to suggest. */
function suggest(name: string, known: string[]): string | null {
  let best: string | null = null
  let bestScore = Infinity
  for (const candidate of known) {
    const d = distance(name, candidate)
    if (d < bestScore) {
      bestScore = d
      best = candidate
    }
  }
  return best !== null && bestScore <= Math.max(2, Math.floor(name.length / 3)) ? best : null
}

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
    positionals = parsed.positionals
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

    const gated = positionals.filter((name) => findPendingGate(state, name) !== undefined)
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
      let failed = false
      for (const name of gated) {
        // Re-found each time: a preceding apply may have rewritten the array.
        const gate = findPendingGate(state, name)
        if (gate === undefined) continue
        const manifest = manifests.get(name)
        if (manifest === undefined) continue
        const result = await applyPendingGate(state, gate, manifest, { statePath, now })

        if (result.outcome === 'applied') {
          process.stdout.write(
            `Applied the parked result for ${name} from run ${result.run_id}: ${result.summary}\n` +
              `Recorded at ${result.run_completed_at}, when the run finished. ` +
              `Nothing was re-run and no grant was written.\n`,
          )
          continue
        }
        failed = true
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
      return failed ? 1 : 0
    }
  }

  if (values.all) {
    const gated = [...manifests.values()].filter((m) => m.side_effects.length > 0)
    const effects = gated.reduce((n, m) => n + m.side_effects.length, 0)
    process.stdout.write(
      `Blanket approval: ${plural(gated.length, 'plugin')} declaring ` +
        `${plural(effects, 'side effect')} may now run them.\n`,
    )
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
