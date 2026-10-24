/**
 * `warpline consume` — answer the open Handoff records once each, outside the
 * engine, and report what happened as an exit code.
 *
 * This is a command a scheduler calls, so its exit code is the interface:
 * `0` nothing needs eyes, `1` something does or the pass could not run, `2` a
 * usage error. `--json` writes one document carrying the detail a code has no
 * room for. The landmines `advance` names apply here too:
 *
 *   1. The exit codes are contract surface, carried in `docs/runtime-spec.md`
 *      § 17. The mapping lives in `exitCodeFor` beside the pass.
 *   2. Nothing executes at module scope: the dispatcher reaches this file
 *      through `await import`, including inside the test runner.
 *   3. This module never terminates the process. It returns a code, and
 *      `src/bin/warpline.ts` turns it into an exit.
 *   4. Nothing reaches stdout on a path where the pass could not run, under
 *      `--json` too. Every refusal writes its sentence to stderr and returns;
 *      the single emission site is past all of them.
 *
 * This is the one place `process.env` reaches the pass. The pass builds every
 * child env from it through allowlists. The output carries record ids, fixed
 * reasons and counts, never Judgment text or a configured value.
 */
import * as nodeUtil from 'node:util'
import { consumePass, exitCodeFor, type PassResult } from '../consume/pass.js'
import { isPluginName } from '../schemas/plugin-name.js'

export const USAGE = `Usage: warpline consume [--plugin <name>]... [--json]

Answer each open Handoff record once, then exit.

Options:
  --plugin <name>  Only this plugin's Handoffs. Repeat it for more than one
  --json           Print one JSON document on stdout

Exit codes:
  0  every claimed Handoff was answered, or there was nothing to do
  1  a try failed, a Handoff was refused, discarded or skipped, a record was unreadable,
     a mismatch notice could not be written, or the pass could not run
  2  a usage error
`

function errnoCode(err: unknown): string {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined
  return typeof code === 'string' ? code : 'unknown'
}

/** One result, two renderings, both newline-terminated. */
function render(r: PassResult, json: boolean): string {
  if (json) return `${JSON.stringify(r)}\n`
  const lines = [
    ...r.answered.map((id) => `answered ${id}`),
    ...r.failed.map((e) => `failed ${e.id}: ${e.reason}`),
    ...r.refused.map((e) => `refused ${e.id}: ${e.reason}`),
    ...r.skipped.map((e) => `skipped ${e.id}: ${e.reason}`),
    ...r.discarded.map((id) => `discarded ${id}`),
    ...r.held.map((id) => `held ${id}`),
    ...r.unreadable.map((name) => `unreadable ${name}`),
    ...r.unannounced.map((id) => `unannounced ${id}: the mismatch notice could not be written`),
  ]
  return `${lines.length === 0 ? 'Nothing to do.' : lines.join('\n')}\n`
}

export async function run(argv: string[]): Promise<number> {
  let plugins: string[] | null
  let json: boolean
  try {
    // The only line naming the parser. No positionals: this verb takes none.
    const { values } = nodeUtil.parseArgs({
      args: argv,
      options: { plugin: { type: 'string', multiple: true }, json: { type: 'boolean' } },
      allowPositionals: false,
      strict: true,
    })
    plugins = values.plugin ?? null
    json = values.json === true
  } catch (err) {
    process.stderr.write(`warpline consume: ${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`)
    return 2
  }
  // Never echo the refused value: it came from a unit file, and it is not a name.
  if (plugins !== null && !plugins.every(isPluginName)) {
    process.stderr.write(`warpline consume: --plugin takes a plugin name\n\n${USAGE}`)
    return 2
  }

  let result: PassResult
  try {
    result = await consumePass({ plugins, parentEnv: process.env })
  } catch (err) {
    process.stderr.write(`warpline consume: the pass stopped (${errnoCode(err)})\n`)
    return 1
  }
  if (result.refusal !== null) {
    process.stderr.write(`warpline consume: ${result.refusal}\n`)
    return 1
  }

  process.stdout.write(render(result, json))
  return exitCodeFor(result)
}
