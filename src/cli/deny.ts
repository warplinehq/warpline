/**
 * `warpline deny` — record that a human said no, so the next advance stops
 * asking.
 *
 * Without this there is nowhere for "no" to land. A plugin is skipped for want
 * of a Grant or parked for supervision, and both re-raise on every advance, so
 * the only way to stop being asked is to grant something — which is the
 * opposite of the answer the operator wanted to give.
 *
 * **A denial answers a proposal, not a plugin.** The record carries a
 * fingerprint of what was proposed — the plugin's name, its declared side
 * effects and the Output it produced — and the evaluator recomputes it on every
 * advance. While it matches, the question is not asked. When it moves, the
 * plugin is due again and the returning Ask says a denial existed and the
 * proposal changed. A denial that outlived what it answered would suppress a
 * question nobody has answered.
 *
 * **No module on this path calls anything that writes the session grant file.**
 * That is the claim, and it is narrower than the one this comment used to make.
 * The grant module IS in the transitive graph: the route into
 * `../runtime/engine.js` used here is the manifest loader, the gate lookup and
 * the fingerprint, but `engine.ts` statically imports the approval gate for its
 * READER, and a static import evaluates the whole module. So the writers are
 * loaded. What nothing on the path does is call one.
 *
 * Saying no to an outcome must not move side-effect authority in either
 * direction. A test walks the whole import closure to hold that, because the
 * grep of this one file it replaced would not have seen a call added two
 * modules down — the prohibition would have gone false with every test green.
 * The whole-home snapshot in `deny.test.ts` is the backstop, not the guarantee.
 *
 * **No gesture mutes the fleet.** There is no `--all` and no wildcard: two
 * independent controls make one impossible. `parseArgs({strict: true})` rejects
 * an undeclared flag before any code here runs, and the denials record is keyed
 * by plugin name, so there is no key that could mean every plugin.
 *
 * The order of operations mirrors `approve.ts`, and for the same reason: EVERY
 * positional is validated before anything is written, and one unknown name
 * aborts the whole command with nothing on disk. A half-applied denial would
 * leave the operator believing they had silenced three plugins when they had
 * silenced one.
 *
 * Never terminates the process — it returns a code to the dispatcher.
 */
import { parseArgs } from 'node:util'
import { findPendingGate, loadPluginManifests, proposalFingerprint } from '../runtime/engine.js'
import { emitDenialRecorded, emitGateInvalidated } from '../board/engine-events.js'
import {
  EngineStateInvalidError,
  readEngineState,
  writeEngineState,
} from '../runtime/engine-state-store.js'
import { DenialSchema } from '../schemas/engine-state.js'
import type { Denial, EngineState } from '../schemas/engine-state.js'
import { engineStatePath, eventsJsonlPath, pluginsDir } from '../lib/paths.js'
import { suggest } from './suggest.js'

const USAGE = `Usage: warpline deny <plugin>... [options]
       warpline deny --list
       warpline deny --remove <plugin>...

Records that you said no to what a plugin proposed, so the next advance stops
asking. The answer is bound to the proposal: change the plugin's declared side
effects or the Output it produces and the question comes back, saying it was
denied before and that the proposal moved.

There is no blanket denial. A denial covers exactly the plugins you name.

Options:
  --list          Show the live denials and exit.
  --remove        Take the denial back for each named plugin.
  --note <text>   Record why, in your own words.
`

/**
 * Read the state document, or explain why not.
 *
 * Fail-closed on every path, `--list` included. The tolerant read would render
 * an unusable document as "no denials", which is the one wrong answer here: the
 * operator would conclude they had never denied anything and deny it again,
 * against a file that is about to be overwritten.
 */
/**
 * `announceDiscards: false` on a read that will not write. `--list` discards
 * stub gates like every other read, but it never persists the discard — so the
 * notice it emitted was re-emitted on the next `--list`, and the next, until
 * something else wrote state. The policy stays fail-closed: an unusable
 * document must stop this command, not come back as "No denials".
 */
async function loadState(
  statePath: string,
  opts: { announceDiscards?: boolean } = {},
): Promise<EngineState | null> {
  try {
    return await readEngineState(statePath, opts)
  } catch (err) {
    if (!(err instanceof EngineStateInvalidError)) throw err
    process.stderr.write(
      `Cannot read engine state: ${err.reason}\n` +
        `Nothing was written — with the document unreadable there is no way to tell what is ` +
        `already denied, and rewriting it would destroy whatever else it holds.\n`,
    )
    return null
  }
}

function describe(denial: Denial): string {
  const note = denial.note === null ? '' : `\n    note: ${denial.note}`
  return `  ${denial.plugin} — denied ${denial.denied_at}\n    ${denial.reason}${note}`
}

export async function run(argv: string[]): Promise<number> {
  let values: { list?: boolean; remove?: boolean; note?: string }
  let positionals: string[]
  try {
    // strict: true rejects an undeclared flag — an all-plugins wildcard among
    // them — and a missing or dash-leading --note value, with no hand-rolled
    // scan. The prohibition is delivered by the parser, not by a check of ours.
    const parsed = parseArgs({
      args: argv,
      options: {
        list: { type: 'boolean' },
        remove: { type: 'boolean' },
        note: { type: 'string' },
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

  if (values.list && (values.remove || positionals.length > 0)) {
    process.stderr.write('--list shows the denials and changes nothing; do not combine it.\n')
    return 1
  }
  if (!values.list && positionals.length === 0) {
    process.stderr.write(USAGE)
    return 1
  }

  const statePath = engineStatePath()

  // -- List: read, print, write nothing -----------------------------------
  if (values.list) {
    const state = await loadState(statePath, { announceDiscards: false })
    if (state === null) return 1
    const denials = Object.values(state.denials)
    if (denials.length === 0) {
      process.stdout.write('No denials — every plugin will be asked about normally.\n')
      return 0
    }
    process.stdout.write(`${denials.length === 1 ? '1 denial' : `${denials.length} denials`}:\n`)
    for (const denial of denials.sort((a, b) => (a.plugin < b.plugin ? -1 : 1))) {
      process.stdout.write(`${describe(denial)}\n`)
    }
    return 0
  }

  // -- Remove: validated against the denials record, not the manifests -----
  // A plugin uninstalled after it was denied must still be removable, or its
  // record would be unreachable from the CLI for good.
  if (values.remove) {
    const state = await loadState(statePath)
    if (state === null) return 1

    // `Object.hasOwn`, not `!== undefined`. These names come straight from the
    // operator and are deliberately NOT validated against the manifests, so
    // `--remove toString` arrives here — and on a plain-object record that
    // lookup answers with `Object.prototype.toString`. The guard would not
    // fire, the delete would remove nothing, the state document would be
    // rewritten anyway, and the operator would be told a denial they never had
    // was taken back.
    const missing = positionals.filter((name) => !Object.hasOwn(state.denials, name))
    if (missing.length > 0) {
      for (const name of missing) {
        process.stderr.write(`No denial recorded for ${name}.\n`)
      }
      process.stderr.write('Nothing was removed.\n')
      return 1
    }

    for (const name of positionals) delete state.denials[name]
    await writeEngineState(state, statePath)
    process.stdout.write(
      `Removed the denial for ${positionals.join(', ')}. ` +
        `${positionals.length === 1 ? 'It' : 'They'} will be asked about again on the next advance.\n`,
    )
    return 0
  }

  // -- Deny --------------------------------------------------------------
  const { manifests, failures } = await loadPluginManifests(pluginsDir())

  // Name validation, all of it, before any write.
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
    process.stderr.write('Nothing was denied.\n')
    return 1
  }

  const state = await loadState(statePath)
  if (state === null) return 1

  const denied_at = new Date().toISOString()
  const recorded: Denial[] = []
  const discarded: { plugin: string; runId: string }[] = []

  for (const plugin of positionals) {
    const fingerprint = proposalFingerprint(state, plugin, manifests.get(plugin)!)
    // Own-property lookup for the same reason as `--remove` above. The
    // manifest schema already refuses a name off `Object.prototype`, so this
    // holds independently of that rather than duplicating it.
    const existing = Object.hasOwn(state.denials, plugin) ? state.denials[plugin] : undefined

    // Denying twice against an unchanged proposal is a no-op, and observably
    // so: nothing is written, so the state document is byte-identical. The
    // record's key makes duplicates impossible; this makes re-answering
    // visible instead of silently restamping the clock.
    if (existing !== undefined && existing.fingerprint === fingerprint) {
      process.stdout.write(
        `${plugin} is already denied (${existing.denied_at}) and its proposal has not changed. ` +
          `Nothing was written.\n`,
      )
      continue
    }

    // A parked result is what a denial most often answers, so the reason says
    // which run it was. Without one, the operator is answering the standing
    // proposal rather than a specific outcome, and the reason says that.
    //
    // A LIVE gate, not merely a gate: `findPendingGate` returns already-applied
    // markers on purpose, and a marker means the operator ACCEPTED that result.
    // Recording that they declined it puts a false sentence somewhere it is
    // read back — `deny --list` prints it, `emitDenialRecorded` writes it into
    // `events.jsonl`, and the evaluator quotes it on every suppressed advance.
    // A marker now lives up to the gate ceiling, so the window is not a corner.
    const gate = findPendingGate(state, plugin)
    const live = gate !== undefined && gate.applied_at === null
    const reason = live
      ? `the operator declined the parked result from run ${gate.run_id}`
      : 'the operator declined this proposal'

    // **The denied gate is discarded, not merely outranked.** Answering a
    // parked result is what dequeues it, exactly as applying one does — the
    // sentence above says the operator declined that run, and leaving the run
    // sitting in `pending_gates` made that sentence describe something that had
    // not happened.
    //
    // It also cannot legitimately be applied afterwards. While the denial
    // holds, both `approve` arms refuse it. Once the denial is superseded the
    // proposal has moved, which means `plugin_runs.last_output` changed, which
    // means the plugin ran again and a newer gate exists — so the old one
    // answers a question nobody is asking. The only path that ever reached it
    // was `deny --remove`, which would hand back a stale result the operator
    // had already declined, in answer to a question they thought they were
    // re-opening.
    //
    // Nothing durable is lost: the run artifact holds the full SkillResult
    // (`RunLog.result`). The gate is the review queue, not the record.
    //
    // Only a LIVE gate. A marker is the trace of a result the operator
    // ACCEPTED, and a denial recorded later answers the standing proposal
    // rather than that outcome — discarding it would erase the one thing that
    // stops a second `approve` re-recording an applied result.
    if (live) {
      state.pending_gates = state.pending_gates.filter((g) => g !== gate)
      discarded.push({ plugin, runId: gate.run_id })
    }

    const denial = DenialSchema.parse({
      plugin,
      reason,
      denied_at,
      note: values.note ?? null,
      fingerprint,
    })
    state.denials[plugin] = denial
    recorded.push(denial)
  }

  if (recorded.length === 0) return 0

  await writeEngineState(state, statePath)

  const eventsPath = eventsJsonlPath()
  for (const denial of recorded) {
    // Best-effort: a notice that cannot be written must not fail a denial that
    // is already on disk.
    await emitDenialRecorded(denial.plugin, denial.reason, denial.fingerprint, eventsPath).catch(
      () => {},
    )
    // The gate discard is its own event, not an implication of the denial one.
    // Every other discard path emits it, and a parked result that vanishes with
    // no board trace is a state change only whoever was watching stdout can
    // know about — the operator tomorrow reads the board.
    const gone = discarded.find((d) => d.plugin === denial.plugin)
    if (gone !== undefined) {
      await emitGateInvalidated(gone.plugin, gone.runId, 'denied', eventsPath).catch(() => {})
    }
    // Say that the result is gone, because it is. The operator declined a
    // specific run and that run is no longer applyable by any gesture — a
    // consequence they cannot see from the state file and should not discover
    // later from a `deny --remove` that hands back nothing.
    const dropped = discarded.some((d) => d.plugin === denial.plugin)
      ? `The parked result was discarded — taking the denial back will let ${denial.plugin} be ` +
        `asked fresh, not re-offer that run. `
      : ''
    process.stdout.write(
      `Denied ${denial.plugin}: ${denial.reason}\n` +
        `It will not be asked about again while it proposes the same thing. ` +
        `${dropped}No grant was written or cleared.\n`,
    )
  }

  return 0
}
