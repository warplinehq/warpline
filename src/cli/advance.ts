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
 */
import * as nodeUtil from 'node:util'
import { runAdvance } from '../runtime/engine.js'
import type { AdvanceResult, PluginFsmState } from '../runtime/engine.js'
import { advanceCounts, advanceExitCode } from '../runtime/exit-codes.js'

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

export async function run(argv: string[]): Promise<number> {
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
