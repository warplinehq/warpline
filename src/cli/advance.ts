/**
 * `warpline advance` — execute everything the engine finds due, unattended, and
 * report what happened as an exit code.
 *
 * This is the command a scheduler calls. Nothing about it is interactive, and
 * its exit code is the machine interface a scheduler keys on: there is no HTTP
 * surface and no alerting hook anywhere in this runtime. `--json` writes one
 * document to stdout carrying the detail a code has no room for, and it never
 * replaces the code — a consumer that reads only the document has to parse
 * something before it can tell whether anything ran.
 *
 * Five read-path landmines this file exists to respect:
 *
 *   1. The exit-code table is PUBLISHED CONTRACT SURFACE, carried in
 *      `docs/runtime-spec.md` § 11. The mapping itself lives in
 *      `src/runtime/exit-codes.ts` rather than inline here, so this command and
 *      the suite compute it at one call site instead of two that can disagree
 *      about the same run.
 *   2. Any throw out of `runAdvance` is `75`, never `1`. A throw there means the
 *      advance could not finish, which is the definition of "could not look",
 *      and "could not look" must never read as "looked and it was fine". One
 *      catch rather than a growing `instanceof` chain, so a refusal added later
 *      cannot silently fall through to `1`. The accepted
 *      cost, named rather than hidden: a genuine internal fault inside
 *      `runAdvance` also reports `75`, i.e. "retry later". Under a fifteen-minute
 *      timer that retry is free, and the alternative is a chain somebody has to
 *      keep complete forever. Do NOT write "nothing was written" here. Only the
 *      refusals above the run lock leave the home byte-identical — a fault
 *      below it arrives after the fleet has run, and `runtime-spec` § 11 now
 *      says so in the published table this comment used to contradict. The run-lock arm inside that catch is not the
 *      start of such a chain: it changes the message and nothing else, both
 *      arms return the same `75`, and deleting it would cost a sentence rather
 *      than a code.
 *   3. Nothing executes at module scope. The dispatcher reaches this file
 *      through `await import`, so module scope runs ON IMPORT — including inside
 *      `main(['advance'])` under `bun test`. A signal handler or a
 *      `process.exit` installed out here would register on the test runner, and
 *      a Ctrl-C during the suite would exit it from inside a library. The
 *      interrupt handler therefore goes INSIDE `run`, and comes off again in a
 *      `finally`: installing it inside and leaving it installed would leak one
 *      listener per in-process test of this verb, which is the same bug reached
 *      by a longer road.
 *   4. This module terminates the process in exactly ONE place — the interrupt
 *      handler inside `run`, which exits `130` for SIGINT and for SIGTERM
 *      alike. Every other path returns a number and `src/bin/warpline.ts` is
 *      where that number becomes an exit. The exception is not a convenience:
 *      the handler runs while `run` is parked on `await runAdvance`, nothing
 *      threads an abort into that await, so there is no return path for it to
 *      take.
 *   5. NOTHING reaches stdout on a failure path — not even under `--json`, and
 *      especially not an error-shaped document. A monitor parsing this stream
 *      is better served by an empty stream plus a non-zero code than by a
 *      document it has to distinguish from a real one. Every refusal below
 *      writes its sentence to stderr and returns; the single emission site is
 *      past all of them. The engine holds up the other half of that contract:
 *      it writes nothing to stdout either, which is asserted structurally
 *      because no in-process capture can observe it. The interrupt handler's
 *      own write is a flush barrier carrying no bytes, so it adds nothing to
 *      that stream and cannot be mistaken for a document. The third writer on
 *      this stream is the plugin handler, which is not ours at all: its stdout
 *      is redirected to stderr for the length of its invocation, in
 *      `invokePlugin` rather than here, because `warpline run` needs the same
 *      thing and a guard written in one verb is a guard the other lacks. The
 *      three writes that redirect does not reach are named in `runtime-spec`
 *      § 11 — the promise is bounded, and stating the bound is how it stays
 *      worth making.
 *
 * The cost of interrupting this command, stated here rather than filed as a
 * known issue, because the people who pay it read this file. An interrupted
 * advance exits `130` — the process stopped, NOT the work. The plugin that was
 * in flight may run to completion in a process the operator believes is dead,
 * because making the advance genuinely interruptible means threading an abort
 * through the level loop and the invocation path, and that is engine surgery
 * this phase deliberately did not do in the same breath as rewiring the lock
 * and the prune. The run lock the interrupt leaves behind is reclaimed by the
 * dead-holder heal — the holder's process id is gone, so the next advance heals
 * the lock rather than waiting out the two-hour window — which is what keeps an
 * interrupted advance recoverable without a flag that breaks a held lock.
 * `docs/runtime-spec.md` §§ 11 and 12 carry the same two facts for operators.
 *
 * The due-set is `runAdvance`'s and never this file's. `warpline plan` agrees
 * with this command precisely because both route every verdict through the same
 * evaluator; a due-set derived here would be a second answer to one question.
 *
 * One more thing that reads as an omission and is not: the same single catch
 * also handles a state document that fails validation. The dispatcher maps that
 * error to `1` for every other verb, and that mapping must stay exactly as it
 * is — catching it here means this command reports `75` without changing what
 * `plan`, `approve`, `deny` and `revoke` report.
 *
 * Three more that arrived with the refusals:
 *
 *   5. The home check refuses to CREATE a home, NEVER to RUN unattended, and
 *      widening it would defeat the phase it belongs to. An existing home with
 *      no terminal on stdin is the ordinary scheduled case and it proceeds; only
 *      an ABSENT home with no terminal refuses. Home resolution falls back to
 *      the nearest ancestor of cwd holding a warpline directory and then to a
 *      cwd-relative path, and under launchd both of those arms are wrong — a
 *      second empty home means the fleet runs nothing, writes a fresh state
 *      document and exits `0` reporting healthy.
 *   6. The seam is STDIN, not stdout. Keying on stdout would make
 *      `warpline advance | tee log` refuse for an operator sitting at the
 *      keyboard, which is the one case a human is there to handle. The check
 *      goes through `isInteractive`, whose truthiness test is deliberate: a
 *      piped stream reports `isTTY` as `undefined` rather than `false`, so a
 *      strict comparison calls a pipe interactive in exactly the case that
 *      matters.
 *   7. The preferences report is a SECOND read beside the validated one, not a
 *      replacement for it. Every reader of preferences keeps its silent
 *      fallback to defaults, which is right for all of them; what is not right
 *      is that an operator who widened the retention window and fat-fingered
 *      the JSON gets the built-in 30-day rule, has the evidence they were
 *      preserving deleted, and is told so by an exit code of `0`. The report is
 *      honest about its own reach: malformed JSON and wrong value types are
 *      caught, a MISSPELLED key is not, because Zod strips unknown keys rather
 *      than refusing them. The pruned count in the machine-readable output is
 *      the only confirmation that a retention setting took effect.
 *
 * The preferences path comes from the accessor, which resolves to the home
 * level. The engine derives its own one directory deeper when a host passes a
 * state override, and that discrepancy is known and deliberately NOT fixed here
 * — fixing it would put a preferences-resolution change and a retention-policy
 * change in one bisect. This command passes no override, so both reads land on
 * the same file and the shipped verb is unaffected.
 */
import * as nodeUtil from 'node:util'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { preferencesPath, warplineHome } from '../lib/paths.js'
import { PreferencesSchema } from '../lib/preferences.js'
import { runAdvance } from '../runtime/engine.js'
import type { AdvanceResult, PluginFsmState } from '../runtime/engine.js'
import { advanceCounts, advanceExitCode } from '../runtime/exit-codes.js'
import { isInteractive } from './prompt.js'

export const USAGE = `Usage: warpline advance [--strict] [--json]

Executes every plugin the engine finds due and exits with a code a scheduler can
read. The codes are published in docs/runtime-spec.md § 11.

  --strict   Report an approval gate still waiting on a human, whichever
             advance parked it, or a content approval that refused the fire,
             as a failure (exit 1) rather than 0.
  --json     Write one JSON document to stdout instead of the human rendering.
`

/**
 * One advance, as the single object every rendering is built from.
 *
 * One payload and one emission site: a second site would be a second chance for
 * the two records of one advance to disagree, which is the argument the engine
 * already makes about its own run log.
 *
 * The field list is deliberately short, because this document is parsed outside
 * this repository and every field is one somebody's detector can start reading.
 * A run id, a status, five integers, a code, the plugin list the human
 * rendering is built from — a name and a state token each — and one refusal
 * list of a plugin name and a closed-enum reason. No plugin summary, no plugin
 * output, no path, no operator configuration value. Same constraint as the
 * dead-man file, for the same reason.
 *
 * `refused_plugins` is the one field here the dead-man file deliberately does
 * NOT carry. It is bounded by construction — a declared plugin name and one of
 * exactly three enum values, never a string a plugin or an operator authored —
 * which is what makes it safe on a stream a scheduler logs. The health file
 * takes the count alone because its own contract is narrower.
 */
export interface AdvancePayload {
  run_id: string
  status: AdvanceResult['status']
  gated: number
  /**
   * How many approval gates are still waiting on a human, whichever advance
   * parked them. `gated` above is this advance's parks only.
   *
   * Always present, `0` included. Read off `advanceCounts`, never recounted
   * here, which is what keeps an `exit_code: 1` under `--strict` explained by
   * a count in the same document on a tick that parked nothing.
   */
  pending_gates: number
  failed: number
  /**
   * How many run records this advance's retention prune removed.
   *
   * Always present, `0` included — a monitor has to be able to tell "nothing to
   * prune" from "this warpline does not report pruning". Threaded from the
   * prune's own return value by way of the advance result, never recounted
   * here; and because unknown keys in `preferences.json` are stripped rather
   * than refused, this is the only signal that a retention bound did anything
   * at all.
   */
  pruned: number
  /**
   * How many plugins a content approval declined to authorise on this advance.
   *
   * Always present, `0` included, for the same reason `pruned` is: a monitor
   * has to be able to tell "nothing was refused" from "this warpline does not
   * report refusals". Read off `advanceCounts` — the one walk the exit code and
   * the dead-man file are both derived from — never counted again here.
   */
  refused: number
  /**
   * Which plugins were refused, and why.
   *
   * The count above answers "did this happen"; this answers "what do I do
   * about it", and the two are the same advance's account so they cannot
   * disagree. An ARRAY rather than a map, because this document goes through
   * `JSON.stringify` and a `Map` serialises to `{}` — the field would be
   * present, empty, and wrong on exactly the advances it exists for.
   */
  refused_plugins: AdvanceResult['refused_plugins']
  exit_code: 0 | 1
  /**
   * Every plugin the run loaded, in the engine's own order.
   *
   * Not re-sorted here. `plugin_states` is populated in topological order and
   * that ordering is the engine's to decide — a second sort in the renderer is
   * a second opinion about which plugin comes first.
   */
  plugins: { name: string; state: PluginFsmState | 'skipped' }[]
}

function renderHuman(payload: AdvancePayload): string {
  const lines = [`Advance ${payload.run_id} — ${payload.status}`]

  if (payload.plugins.length === 0) {
    lines.push('  no plugin manifests loaded')
  } else {
    for (const { name, state } of payload.plugins) lines.push(`  ${name}: ${state}`)
  }

  // Refused sits between the two counts it belongs with. An operator watching
  // this rendering is the same reader the `refused` count exists for, and a
  // refusal absent from the human view is the same silence the scheduler half
  // of this plan removes.
  lines.push(
    `Gated: ${payload.gated}  Pending gates: ${payload.pending_gates}  ` +
      `Refused: ${payload.refused}  Failed: ${payload.failed}  Exit: ${payload.exit_code}`,
  )
  return `${lines.join('\n')}\n`
}

/**
 * One payload, two renderings — they cannot drift because there is one source.
 *
 * Both arms end in a newline, so the machine rendering is one
 * newline-terminated document on a stream carrying nothing else.
 */
function render(payload: AdvancePayload, json?: boolean): string {
  return json === true ? `${JSON.stringify(payload)}\n` : renderHuman(payload)
}

/**
 * The one stream this command reads a property of, as a parameter.
 *
 * `{ isTTY?: boolean }` rather than a stream type on purpose: it is exactly what
 * `isInteractive` takes, so a test drives both branches with a plain object and
 * no pty is involved anywhere. `main` cannot inject it — the dispatcher forwards
 * argv and nothing else — which is why these two branches are tested against
 * `run` directly.
 */
export interface AdvanceIo {
  stdin: { isTTY?: boolean }
}

/**
 * Say so, once, when the preferences file exists and cannot be used.
 *
 * Modelled on the lock read rather than on `readJsonOrNull`: three states, and
 * the middle one is the whole point. `readJsonOrNull` returns `null` for a
 * missing file but RETHROWS on malformed JSON, which is one of the two cases
 * this has to report rather than raise.
 *
 * Reports, never raises. A preferences file that cannot be parsed is not a
 * reason to refuse an advance — every reader falls back to defaults and the run
 * is valid. It is a reason to stop the fallback being silent.
 */
async function reportUnusablePreferences(): Promise<void> {
  const path = preferencesPath()

  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch {
    // Absent is the ordinary first-run shape and every default legitimately
    // applies. Any other read error belongs to the engine's own read a moment
    // later, which is the one that decides whether the advance can proceed.
    return
  }

  let reason: string | null = null
  try {
    const result = PreferencesSchema.safeParse(JSON.parse(raw))
    if (!result.success) {
      const issue = result.error.issues[0]
      const where = issue?.path.join('.')
      reason = issue
        ? `${where === undefined || where === '' ? '(root)' : where}: ${issue.message}`
        : 'does not match the preferences schema'
    }
  } catch (err) {
    reason = err instanceof Error ? err.message : String(err)
  }

  if (reason === null) return

  // One line, whatever the runtime's parser put in its message — a multi-line
  // diagnostic in a scheduler's mail is where a single actionable sentence goes
  // to be skimmed past.
  process.stderr.write(
    `warpline advance: ${path} could not be used (${reason.replace(/\s+/g, ' ')}) — running on ` +
      `built-in defaults, retention included. Malformed JSON and wrong value types are caught ` +
      `here; a misspelled key is not, because unknown keys are stripped rather than refused.\n`,
  )
}

export async function run(
  argv: string[],
  io: AdvanceIo = { stdin: process.stdin },
): Promise<number> {
  // The interrupt handler, installed HERE and removed in the `finally` below —
  // never at module scope, for the reason landmine 3 gives: module scope runs on
  // import, including inside every in-process test of this verb.
  //
  // Terminating rather than returning a code is not a shortcut taken to save a
  // parameter. A signal handler runs while this function is parked on
  // `await runAdvance`, and nothing threads an abort into that await — the
  // advance is not interruptible, and this file deliberately does not pretend
  // otherwise by taking a controller it would never honour. The handler
  // therefore has no return path: ending the process is the only way the signal
  // ends anything at all.
  //
  // The empty write is a flush barrier carrying no bytes. Under a scheduler
  // stdout is a pipe, writes to a pipe are asynchronous, and the one `--json`
  // document this command emits may still be queued when the signal lands;
  // exiting without waiting for it can cut that document in half. Chunks flush
  // in order, so a zero-length write's callback runs after every byte handed to
  // `write` before it.
  //
  // The bounded fallback beside the barrier is the other half. While this
  // handler is installed, SIGINT no longer terminates by default — so if stdout
  // is a pipe whose reader has stopped consuming, the callback never runs and
  // every further Ctrl-C just queues another empty write. The process becomes
  // unkillable by the operator sitting in front of it. Two seconds, and
  // `unref` so the timer cannot hold the event loop open on any other path.
  //
  // SIGTERM is handled the same way and for a plainer reason: `systemctl stop`,
  // a launchd `bootout` and a container stop all send SIGTERM, not SIGINT. Left
  // to the default disposition those killed the process with no flush and a
  // `--json` document that could be cut in half, which is the exact failure the
  // SIGINT handler was added to prevent. Both signals now take the same arm, so
  // both report the same code — see `runtime-spec` § 11, which had to gain that
  // fact before this line could be written.
  const onInterrupt = (): void => {
    setTimeout(() => process.exit(130), 2000).unref()
    process.stdout.write('', () => process.exit(130))
  }
  const INTERRUPTS = ['SIGINT', 'SIGTERM'] as const
  for (const sig of INTERRUPTS) process.on(sig, onInterrupt)

  try {
    let strict = false
    let json = false

    try {
      // Namespace import above so this call is the only line naming the parser.
      // Both flags are registered here and nowhere else: an argv inspection
      // beside this call would be a second way to read flags, and a second way is
      // a path by which a refused flag gets honoured.
      const { values } = nodeUtil.parseArgs({
        args: argv,
        options: { strict: { type: 'boolean' }, json: { type: 'boolean' } },
        // No positionals, because this verb takes none. `strict: true` refuses
        // an unregistered FLAG; a positional was accepted and thrown away, so
        // `warpline advance strict` — the obvious typo for `--strict`, and a
        // plausible one in a unit file written from memory — ran non-strict
        // and exited `0` on a fleet full of held gates. That is precisely the
        // report `--strict` exists to prevent.
        allowPositionals: false,
        strict: true,
      })
      strict = values.strict === true
      json = values.json === true
    } catch (err) {
      // The parser's own strict mode is what refuses an unregistered flag, and
      // `--yes` and `--force` are two of them. That refusal is worth more than a
      // hand-rolled one: it cannot be forgotten in review, and it stays correct as
      // flags are added. Surface the message, never a stack.
      process.stderr.write(
        `warpline advance: ${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`,
      )
      // `1` rather than a code of its own, and the table in `runtime-spec`
      // § 11 now names this as a third cause of `1` rather than enumerating
      // two. A new code is a contract change for a typo in a unit file; a
      // documented row is not. What tells the two apart from outside: a
      // failing advance under `--json` writes a document to stdout and this
      // path writes nothing there.
      return 1
    }

    // Above `runAdvance` because there is nowhere below it this could sit: home
    // resolution creates nothing, and the home comes into existence at whichever
    // writer reaches its own recursive mkdir first — the run log's or the
    // artifact store's. There is no single create-on-first-write site to guard,
    // so the guard goes where the decision is still one decision.
    const home = warplineHome()
    if (!existsSync(home) && !isInteractive(io.stdin)) {
      process.stderr.write(
        // Name the verb that does the thing. "Run this once from a terminal"
        // was the old advice and it creates nothing: with a terminal on stdin
        // this refusal is skipped, `runAdvance` reaches `loadPluginManifests`
        // and throws on the absent plugin root before any writer runs — a
        // second `75` with a different message, and the home still absent.
        // `warpline init` is the only verb that creates one, and it is safe to
        // run again.
        `warpline advance: no warpline home at ${home}, and stdin is not a terminal — refusing to ` +
          `create one. Set WARPLINE_HOME to the home you meant, or run \`warpline init\` once to ` +
          `create that home — this command never creates one.\n`,
      )
      return 75
    }

    await reportUnusablePreferences()

    let result: AdvanceResult
    try {
      result = await runAdvance({})
    } catch (err) {
      // Contention on the run lock is not a new exit code — the single catch
      // below already reports `75` for any throw out of the advance, and this is
      // one. What it is is a different SENTENCE. "Run lock at … is held by PID
      // 4213" leaves the operator to work out whether anything ran, whether the
      // next tick will clear it, and whether it clears on its own at all; those
      // three answers are the whole content of the mail they just received.
      //
      // Recognised by `name`, the way the dispatcher recognises its own typed
      // error, and for the same reason: an `instanceof` check would import the
      // runtime lock module into this file's graph to test a string that the
      // error already carries. The holder is named by the error's own message,
      // which has the two arms a nullable holder needs — a process id, or an
      // orchestrator session. Do not reconstruct either of them here.
      if (err instanceof Error && err.name === 'AdvanceLockedError') {
        process.stderr.write(
          `warpline advance: ${err.message} Nothing ran and nothing was written — another ` +
            `advance holds this home. The next scheduled tick retries, and a lock more than two ` +
            `hours old is broken automatically. Nothing breaks a lock a live process still ` +
            `holds; see docs/runtime-spec.md § 12.\n`,
        )
        return 75
      }
      // A stack under a scheduler lands in the operator's mail carrying absolute
      // paths, and none of it is actionable. The message alone, as everywhere else
      // in this CLI.
      process.stderr.write(`warpline advance: ${err instanceof Error ? err.message : String(err)}\n`)
      return 75
    }

    const exit_code = advanceExitCode(result, { strict })
    const { gated, pending_gates, failed, refused } = advanceCounts(result)

    // The one site anything reaches stdout from, past every refusal above it.
    process.stdout.write(
      render(
        {
          run_id: result.run_id,
          status: result.status,
          gated,
          pending_gates,
          failed,
          refused,
          // The structured array straight off the result, so a consumer gets
          // the reason and not only the count. No arithmetic here:
          // `advanceExitCode` above already carries the widened `--strict`
          // predicate, and a second count in this file is the second answer
          // `exit-codes.ts` exists to prevent.
          refused_plugins: result.refused_plugins,
          // Read off the result, where the prune's own return value was threaded
          // to. Counting removals a second time here would be a second answer.
          pruned: result.pruned,
          exit_code,
          plugins: [...result.plugin_states].map(([name, state]) => ({ name, state })),
        },
        json,
      ),
    )

    return exit_code
  } finally {
    // Both halves are load-bearing and for different reasons. Without this one,
    // every in-process test of this verb leaves a listener on the test runner,
    // and an interrupt during a suite run exits the runner 130 from inside a
    // library — a bug whose cause is nowhere near its symptom. One `off` per
    // `on`, off the same list, so a signal added above cannot be left behind
    // here.
    for (const sig of INTERRUPTS) process.off(sig, onInterrupt)
  }
}
