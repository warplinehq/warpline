/**
 * `warpline init` — the first-run verb: create the home, seed one plugin,
 * write that plugin's config from the defaults its manifest declares, and
 * say what is still missing. The next `warpline plan` then has something to
 * show.
 *
 * Nothing here is new machinery. The home is prepared by the same
 * `prepareHome()` that `scaffold` runs — the `node_modules/warpline` link and
 * the `"type": "module"` marker, without which no plugin under the home loads
 * under Node at all. The seed is copied by the same path `scaffold --from`
 * uses. The config is written by the exported core of `configure`, in
 * process. Reinventing any of the three is how a first-run verb produces a
 * home `plan` cannot load from, or a config the runtime reads differently
 * from the one `configure` writes.
 *
 * IDEMPOTENT and never destructive. A second `init` leaves the home
 * byte-identical: nothing is stamped with a time, a seed directory already
 * present is left as it is, and a config file already present — which an
 * operator may have edited — is not touched. Nothing is ever deleted.
 *
 * NON-INTERACTIVE by design, and it does not fail over what it cannot fill.
 * The defaults the seed's manifest declares are written; a required input
 * with no default is NAMED on stdout with the verb that fills it. `plan`
 * renders without a complete config and the runtime names the gap at run
 * time, so failing here over a plugin the operator has not chosen to
 * configure yet would be worse than the message.
 *
 * Never terminates the process — it returns a code to the dispatcher.
 */
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { pluginConfigPath, pluginsDir, warplineHome } from '../lib/paths.js'
import { ConfigureError, type ConfigureIo, writePluginConfig } from './configure.js'
import { prepareHome, scaffoldPlugin } from './scaffold.js'

/**
 * The one bundled example `init` copies into the home, chosen so a clean
 * install renders a non-empty plan with no config file and no gate:
 *
 *   - it declares NO side effect, so a beginner's first plan does not open
 *     with an approval question. `github-poll` declares `external_api` and
 *     lands in the not-due set until approved — measured, not assumed.
 *   - every input it declares is optional or defaulted, so the config
 *     written from its manifest is complete and the plugin is due on the
 *     first advance.
 *   - it is `daily` and `autonomous`, the shape a scheduled runtime exists
 *     for, and it writes only under the home.
 *
 * The copy forks from the package on the day it is made: a later fix to the
 * shipped example does not reach it. That is the documented cost of
 * `scaffold --from`, accepted here for the same reason.
 */
export const SEED_EXAMPLE = 'metrics-rollup'

const USAGE = `Usage: warpline init

Creates the warpline home (WARPLINE_HOME, else the nearest .warpline/, else
<cwd>/.warpline), copies the '${SEED_EXAMPLE}' example into its plugins
directory, and writes that plugin's config from the defaults its manifest
declares. Safe to run again: nothing already present is changed.
`

export async function run(
  argv: string[],
  io: ConfigureIo = { input: process.stdin, output: process.stdout },
): Promise<number> {
  try {
    const { positionals } = parseArgs({ args: argv, options: {}, allowPositionals: true, strict: true })
    if (positionals.length > 0) {
      process.stderr.write(USAGE)
      return 1
    }
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`)
    return 1
  }

  const home = warplineHome()
  const lines: string[] = [`Home: ${home}`]

  // The link and the ESM marker are properties of the home, not of any one
  // plugin, so they are prepared whether or not the seed gets copied below.
  const warnings = await prepareHome()
  await mkdir(join(home, 'config'), { recursive: true })
  await mkdir(pluginsDir(), { recursive: true })

  const seedDir = join(pluginsDir(), SEED_EXAMPLE)
  if (existsSync(seedDir)) {
    lines.push(`Plugin '${SEED_EXAMPLE}' already present at ${seedDir}; left as it is`)
  } else {
    const copied = await scaffoldPlugin(SEED_EXAMPLE, { from: SEED_EXAMPLE })
    if (!copied.created) {
      process.stderr.write(`${copied.message}\n`)
      return 1
    }
    // First line only: the copy prepares the same home and would repeat the
    // warnings collected above.
    lines.push(copied.message.split('\n')[0] as string)
  }

  const configPath = pluginConfigPath(SEED_EXAMPLE)
  if (existsSync(configPath)) {
    lines.push(`Config ${configPath} already exists; left as it is`)
  } else {
    let written: string[]
    let needed: string[]
    try {
      ;({ written, needed } = await writePluginConfig(SEED_EXAMPLE, {}))
    } catch (err) {
      if (!(err instanceof ConfigureError)) throw err
      process.stderr.write(`${err.message}\nNo config was written.\n`)
      return 1
    }
    lines.push(`Wrote ${configPath}` + (written.length > 0 ? ` (${written.join(', ')})` : ' (no inputs declared)'))
    if (needed.length > 0) {
      lines.push(
        `Still needed before ${SEED_EXAMPLE} can run: ${needed.join(', ')}. ` +
          `Run: warpline configure ${SEED_EXAMPLE}`,
      )
    }
  }

  for (const w of warnings) lines.push(`⚠ ${w}`)
  lines.push('', 'Next: warpline plan')
  process.stdout.write(`${lines.join('\n')}\n`)
  return 0
}
