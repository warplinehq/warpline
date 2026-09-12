/**
 * `warpline advance` — execute everything the engine finds due, unattended, and
 * report what happened as an exit code.
 *
 * This is the command a scheduler calls. Nothing about it is interactive, and
 * its exit code is the whole machine interface: there is no HTTP surface and no
 * alerting hook anywhere in this runtime.
 *
 * Four read-path landmines this file exists to respect:
 *
 *   1. The exit-code table is PUBLISHED CONTRACT SURFACE, carried in
 *      `docs/runtime-spec.md` § 11. The mapping itself lives in
 *      `src/runtime/exit-codes.ts` rather than inline here, so this command and
 *      the suite compute it at one call site instead of two that can disagree
 *      about the same run.
 *   2. Any throw out of `runAdvance` is `75`, never `1`. A throw there means
 *      nothing ran and nothing was written — the engine promises a refused
 *      advance leaves the home byte-identical — which is the definition of
 *      "could not look", and "could not look" must never read as "looked and it
 *      was fine". One catch rather than a growing `instanceof` chain, so a
 *      refusal added later cannot silently fall through to `1`. The accepted
 *      cost, named rather than hidden: a genuine internal fault inside
 *      `runAdvance` also reports `75`, i.e. "retry later". Under a fifteen-minute
 *      timer that retry is free, and the alternative is a chain somebody has to
 *      keep complete forever.
 *   3. Nothing executes at module scope. The dispatcher reaches this file
 *      through `await import`, so module scope runs ON IMPORT — including inside
 *      `main(['advance'])` under `bun test`. A signal handler or a
 *      `process.exit` installed out here would register on the test runner, and
 *      a Ctrl-C during the suite would exit it from inside a library.
 *   4. This module NEVER terminates the process. `run` returns a number and
 *      `src/bin/warpline.ts` is the only place a number becomes an exit.
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

export const USAGE = `Usage: warpline advance [--strict]

Executes every plugin the engine finds due and exits with a code a scheduler can
read. The codes are published in docs/runtime-spec.md § 11.

  --strict   Report a held approval gate as a failure (exit 1) rather than 0.
`

/**
 * One advance, as the single object every rendering is built from.
 *
 * One payload and one emission site, even though only the human rendering
 * exists today: a second site added later for `--json` is a second chance for
 * the two records of one advance to disagree, which is the argument the engine
 * already makes about its own run log.
 */
export interface AdvancePayload {
  run_id: string
  status: AdvanceResult['status']
  gated: number
  failed: number
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

  lines.push(`Gated: ${payload.gated}  Failed: ${payload.failed}  Exit: ${payload.exit_code}`)
  return `${lines.join('\n')}\n`
}

/** One payload, one rendering today and two once `--json` lands. */
function render(payload: AdvancePayload, json?: boolean): string {
  return json === true ? JSON.stringify(payload) : renderHuman(payload)
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
  let strict = false

  try {
    // Namespace import above so this call is the only line naming the parser.
    const { values } = nodeUtil.parseArgs({
      args: argv,
      options: { strict: { type: 'boolean' } },
      allowPositionals: true,
      strict: true,
    })
    strict = values.strict === true
  } catch (err) {
    // The parser's own strict mode is what refuses an unregistered flag, and
    // `--yes` and `--force` are two of them. That refusal is worth more than a
    // hand-rolled one: it cannot be forgotten in review, and it stays correct as
    // flags are added. Surface the message, never a stack.
    process.stderr.write(
      `warpline advance: ${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`,
    )
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
      `warpline advance: no warpline home at ${home}, and stdin is not a terminal — refusing to ` +
        `create one. Set WARPLINE_HOME to the home you meant, or run this once from a terminal ` +
        `to create that path.\n`,
    )
    return 75
  }

  await reportUnusablePreferences()

  let result: AdvanceResult
  try {
    result = await runAdvance({})
  } catch (err) {
    // A stack under a scheduler lands in the operator's mail carrying absolute
    // paths, and none of it is actionable. The message alone, as everywhere else
    // in this CLI.
    process.stderr.write(`warpline advance: ${err instanceof Error ? err.message : String(err)}\n`)
    return 75
  }

  const exit_code = advanceExitCode(result, { strict })
  const { gated, failed } = advanceCounts(result)

  process.stdout.write(
    render({
      run_id: result.run_id,
      status: result.status,
      gated,
      failed,
      exit_code,
      plugins: [...result.plugin_states].map(([name, state]) => ({ name, state })),
    }),
  )

  return exit_code
}
