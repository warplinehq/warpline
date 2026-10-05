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
 *      because no in-process capture can observe it. The interrupt handler
 *      writes nothing at all: it ends the stream, which adds no bytes to it
 *      and cannot be mistaken for a document. The third writer on
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
 * dead-holder heal on the next advance only when the lock and this machine
 * carry the same known host identifier. For a lock taken on another machine,
 * or where either side could not name its host, it waits two hours from the
 * lock's last heartbeat, or from when it was taken if it carries none it can
 * use. Either way an interrupted advance stays recoverable without a flag that
 * breaks a held lock.
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
 * `70` is computed here, outside `advanceExitCode`, the way `75` and `130` are
 * produced outside it: it comes from the result's audit failures, a field that
 * function does not read. It outranks `1` and `--strict`. A document is still
 * written to stdout, because the run completed; stderr says which plugin's
 * record is missing and, for an outcome, which intent stays open.
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
 *   7. A preferences file that exists and cannot be used refuses the advance.
 *      This file does not read it: the engine's own read sits above the run
 *      lock, so a bad file reaches the single catch as a throw, exits `75` with
 *      its one stderr line naming the file and the key path, writes nothing to
 *      stdout and leaves the home byte-identical. It keeps refusing every tick
 *      until the file is fixed or removed, and the dead-man file goes stale
 *      meanwhile. Fail closed because running on defaults ran retention on the
 *      30-day rule and deleted evidence the operator kept, and one bad field
 *      discarded every sibling guardrail with it. This reverses the earlier
 *      report-only choice, by operator decision on 2026-09-30.
 */
import * as nodeUtil from 'node:util'
import { existsSync } from 'node:fs'
import { warplineHome } from '../lib/paths.js'
import { runAdvance } from '../runtime/engine.js'
import type { AdvanceResult, PluginFsmState } from '../runtime/engine.js'
import { advanceCounts, advanceExitCode, EXIT_AUDIT_FAILED } from '../runtime/exit-codes.js'
import { isInteractive } from './prompt.js'
import { exitAfterFlush } from '../lib/exit-after-flush.js'
import { RunTriggerSchema, type RunTrigger } from '../schemas/run-log.js'

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
   * here. It says how many runs went, not which retention bound removed
   * them.
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
  exit_code: 0 | 1 | 70
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
  // The handler ends stdout and stderr through the same helper the bin exits
  // by, and exits once both have drained. Under a scheduler both streams are
  // pipes, writes to a pipe are asynchronous, and exiting without waiting can
  // cut off whatever is still queued. What is queued when a signal lands is
  // never the `--json` document: it is written and this handler removed in one
  // synchronous stretch, so no signal can arrive between the two. It is plugin
  // output. While a handler runs, `invokePlugin` sends its stdout to stderr, so
  // a chatty plugin interrupted mid-run has its lines queued on stderr, and
  // that is why stderr is drained too.
  //
  // The bounded fallback beside the drain is the other half. While this
  // handler is installed, SIGINT no longer terminates by default — so if either
  // stream is a pipe whose reader has stopped consuming, the drain never
  // finishes and every further Ctrl-C only asks for the same drain again. The
  // process becomes unkillable by the operator sitting in front of it. Two
  // seconds, and `unref` so the timer cannot hold the event loop open on any
  // other path.
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
    void exitAfterFlush(130)
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

    // What started this advance (#31), for the run log. Warpline cannot tell a
    // scheduler from a person, so the unit file says so. Refused on a value
    // it does not know, like a mistyped flag: recording nothing would make a
    // typo'd `scheduled` indistinguishable from a host that never said.
    const rawTrigger = process.env.WARPLINE_TRIGGER
    let trigger: RunTrigger | undefined
    if (rawTrigger) {
      const parsed = RunTriggerSchema.safeParse(rawTrigger)
      if (!parsed.success) {
        process.stderr.write(
          `warpline advance: WARPLINE_TRIGGER='${rawTrigger}' is not one of ` +
            `${RunTriggerSchema.options.join(', ')}. Nothing ran.\n`,
        )
        return 1
      }
      trigger = parsed.data
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

      let result: AdvanceResult
    try {
      result = await runAdvance({ trigger })
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
      //
      // An unreadable holder gets its own tail. The acquire refuses such a file
      // and never breaks it, so the heal wording would send the operator to
      // wait for a tick that never clears it.
      if (err instanceof Error && err.name === 'AdvanceLockedError' && (err as { unreadable?: unknown }).unreadable === true) {
        process.stderr.write(
          `warpline advance: ${err.message} Nothing ran and nothing was written. An ` +
            `advance never breaks it, so no later tick clears it. Delete it by hand once ` +
            `you know no advance is running; see docs/runtime-spec.md § 12.\n`,
        )
        return 75
      }
      if (err instanceof Error && err.name === 'AdvanceLockedError') {
        process.stderr.write(
          `warpline advance: ${err.message} Nothing ran and nothing was written — another ` +
            `advance holds this home. The next scheduled tick retries. The lock is broken ` +
            `automatically two hours after its holder's last heartbeat, or two hours ` +
            `from when it was taken if it carries none it can use, or on the next ` +
            `tick if its process has exited and the lock and this machine carry the ` +
            `same known host identifier. Nothing breaks a lock its holder is still ` +
            `refreshing; see docs/runtime-spec.md § 12.\n`,
        )
        return 75
      }
      // A stack under a scheduler lands in the operator's mail carrying absolute
      // paths, and none of it is actionable. The message alone, as everywhere else
      // in this CLI.
      process.stderr.write(`warpline advance: ${err instanceof Error ? err.message : String(err)}\n`)
      return 75
    }

    // `70` first: a fire or refusal with no record outranks every code the
    // mapper returns, `--strict` included.
    const exit_code = result.audit_failures.length > 0 ? EXIT_AUDIT_FAILED : advanceExitCode(result, { strict })
    const { gated, pending_gates, failed, refused } = advanceCounts(result)

    // One line per missing record, then the code's line, all before the
    // document. Built from the plugin name, a fixed phrase and a seq only.
    for (const f of result.audit_failures) {
      if (f.kind === 'fire.intent') {
        process.stderr.write(`warpline advance: ${f.plugin} did not fire: the audit store could not record its intent.\n`)
      } else if (f.kind === 'fire.outcome') {
        process.stderr.write(
          `warpline advance: ${f.plugin} fired, but the audit store could not record its outcome ` +
            `(intent seq ${f.intent_seq}). The intent stays open and the next advance lists it.\n`,
        )
      } else {
        process.stderr.write(`warpline advance: ${f.plugin} was refused, and the audit store could not record the refusal.\n`)
      }
    }
    if (exit_code === EXIT_AUDIT_FAILED) {
      process.stderr.write('Exit 70: the audit store failed during this run; see docs/runtime-spec.md § 11.\n')
    }

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
