/**
 * `warpline plan` — preview the next engine advance without executing it.
 *
 * STUB. The signature below is the final one; plan 02-05 replaces the body
 * with the read-only evaluator view (D-18/D-19/D-21) behind an unchanged
 * `run(argv): Promise<number>`. The dispatcher arm that calls this does not
 * change when the body lands.
 */
export async function run(_argv: string[]): Promise<number> {
  process.stderr.write('warpline plan: not implemented in this build\n')
  return 1
}
