/**
 * `warpline init` — RED stub. Exports the names the tests import and does
 * nothing, so the file loads and the failures land on assertions.
 */
export const SEED_EXAMPLE = 'metrics-rollup'

const USAGE = 'Usage: warpline init\n'

export async function run(_argv: string[]): Promise<number> {
  process.stderr.write(USAGE)
  return 1
}
