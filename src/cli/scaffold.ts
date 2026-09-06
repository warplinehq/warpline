/**
 * Plugin scaffold command — generates a new plugin directory with a
 * typed manifest template and handler stub.
 *
 * Usage: warpline scaffold <plugin-name> [--from <example>]
 *
 * Plugin names must be lowercase, hyphenated identifiers.
 * Name is validated against [a-z][a-z0-9-]* — no path traversal possible.
 * The `--from` value is held to the SAME regex, then must name a directory
 * under the package's own shipped `examples/plugins/`, before any filesystem
 * access; a refused source leaves the home untouched.
 *
 * ## `--from` is a copy, and only a copy
 *
 * `--from <example>` copies a shipped example out of the install in place of
 * the built-in template, rewriting one thing: the manifest's `name`. It is
 * one code path with two sources — the same home preparation, the same name
 * guard, the same directory creation — not a second generator. The registry
 * is `package.json`'s `files` entry, which already ships `examples`
 * wholesale, so there is no service, no package and no version to support.
 *
 * Refused, deliberately: a remote registry, a verb that installs rather than
 * copies, and any record of which copies exist. The copy diverges from the
 * day it is made, and nothing here tracks it afterwards. An author who wants
 * a later fix to the source example reads the diff and takes it by hand.
 *
 * ## Why the generated imports look the way they do
 *
 * Generated plugins live under <warplineHome>/plugins/, outside both this repo
 * and any node_modules — so nothing relative reaches warpline, and a bare
 * `warpline/...` specifier does not resolve on its own from a global install
 * either. Two mechanisms make it work, and BOTH are load-bearing:
 *
 *   1. the package's `exports` map, which publishes the schema subpaths
 *   2. the `<warplineHome>/node_modules/warpline` symlink this file creates
 * — ESM bare-specifier resolution walks node_modules upward from
 *      the *importing* file, and the install prefix is not on that chain
 *
 * The generated sibling import carries a .ts extension and must never be
 * "normalized" to .js like the rest of the repo. Everything under src/ is
 * compiled, so .js is right there; a generated plugin is executed by Node as
 * TypeScript, and Node's type stripping resolves the literal specifier with no
 * extension remapping. A .js specifier at a .ts file is ERR_MODULE_NOT_FOUND
 * under Node (RESEARCH P-1, probe A5). Bun remaps it, which is exactly why a
 * Bun-only test suite cannot see the bug — hence the byte-level assertions in
 * __tests__/scaffold.test.ts and the real Node import in
 * scripts/verify-tarball.sh.
 */
import { cp, mkdir, readdir, rm, writeFile, symlink, unlink, readFile } from 'node:fs/promises'
import { existsSync, lstatSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { pluginsDir, warplineHome } from '../lib/paths.js'

export interface ScaffoldResult {
  created: boolean
  path: string
  message: string
}

export interface ScaffoldOptions {
  /** Copy this shipped example (a directory name under `examples/plugins/`) instead of emitting the template. */
  from?: string
}

/**
 * One guard for both the plugin name and the `--from` value: lowercase
 * letters, digits, hyphens, leading letter. Forward slashes, dots, spaces and
 * an empty string are all rejected, so neither value can traverse anywhere.
 */
const IDENT = /^[a-z][a-z0-9-]*$/

const USAGE = 'Usage: warpline scaffold <plugin-name> [--from <example>]\n'

/**
 * Warpline's own installed package root — the nearest ancestor of THIS module
 * holding a package.json.
 *
 * Derived from the running module's location, never from a configured path:
 * from dist/cli/scaffold.js in a global install that is the installed package
 * root; from src/cli/scaffold.ts in a checkout it is the repo root. Both are
 * correct link targets.
 */
function packageRoot(): string | null {
  let dir = import.meta.dirname
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * Create or refresh <warplineHome>/node_modules/warpline -> the package root.
 *
 * Without this link a generated plugin's `warpline/...` import resolves to
 * nothing: ESM bare-specifier resolution walks node_modules upward from the
 * importing file, and a global install prefix is not on that chain.
 * NODE_PATH is no help — it is CJS-only. A symlink works under both Node and
 * Bun and carries warpline's transitive zod, because Node realpaths it.
 *
 * Self-healing but never destructive: an existing SYMLINK is replaced
 * unconditionally (that heals a link left dangling by reinstalling warpline at
 * a different prefix), while a real file or directory is left exactly as it is.
 *
 * @returns a warning to surface in the scaffold result, or null on success.
 */
async function linkWarplineIntoHome(): Promise<string | null> {
  const target = packageRoot()
  if (!target) return 'could not locate the warpline package root; skipped the node_modules link'

  const link = join(warplineHome(), 'node_modules', 'warpline')
  await mkdir(dirname(link), { recursive: true })

  let existing: ReturnType<typeof lstatSync> | null = null
  try {
    existing = lstatSync(link)
  } catch {
    existing = null // nothing there yet — the common path
  }

  if (existing && !existing.isSymbolicLink()) {
    return `${link} already exists and is not a symlink — not replaced. Plugin imports of 'warpline/...' will resolve through it, not through this install.`
  }
  if (existing) await unlink(link)

  await symlink(target, link, 'dir')
  return null
}

/**
 * Ensure <warplineHome>/package.json marks the tree as ESM.
 *
 * Without it, Node's type stripping loads a generated `manifest.ts` as CJS and
 * the plugin dies on `Cannot use import statement outside a module` — at load,
 * so `warpline plan` reports every plugin as a load failure and can compute no
 * plan at all. Bun assumes ESM and never sees it, which is why a Bun-only
 * suite cannot catch this; it is the same blind spot the `.ts` specifier
 * comment above describes, one directory higher.
 *
 * Same discipline as the symlink: create what is missing, never overwrite what
 * the user put there. An existing package.json is left alone and only warned
 * about, since it may be a real project manifest that happens to sit here.
 */
async function ensureHomeIsEsm(): Promise<string | null> {
  const home = warplineHome()
  const manifestPath = join(home, 'package.json')
  await mkdir(home, { recursive: true })

  if (existsSync(manifestPath)) {
    try {
      const parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as { type?: string }
      if (parsed.type === 'module') return null
      return `${manifestPath} exists without "type": "module" — Node will load generated plugins as CommonJS and they will fail at import. Add it, or run under Bun.`
    } catch {
      return `${manifestPath} exists but is not valid JSON — left untouched. Generated plugins may fail to load under Node.`
    }
  }

  await writeFile(manifestPath, `${JSON.stringify({ type: 'module' }, null, 2)}\n`)
  return null
}

/**
 * Run every home-level preparation step, collecting warnings rather than
 * throwing. A failed step must not fail the scaffold: the plugin files are
 * still correct, and a missing link or marker surfaces later through the
 * engine's load-failure reporting, which is where it is actionable.
 */
async function prepareHome(): Promise<string[]> {
  const warnings: string[] = []
  for (const step of [linkWarplineIntoHome, ensureHomeIsEsm]) {
    try {
      const w = await step()
      if (w) warnings.push(w)
    } catch (err) {
      warnings.push(`${step.name} failed for ${warplineHome()}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return warnings
}

/**
 * The shipped examples tree, beside this module's package root: from
 * dist/cli/scaffold.js in an install that is `<install>/examples/plugins`,
 * from src/cli/scaffold.ts in a checkout it is the repository's own.
 */
function examplesRoot(): string | null {
  const root = packageRoot()
  return root ? join(root, 'examples', 'plugins') : null
}

/**
 * Resolve a `--from` value to a shipped example directory, or explain why
 * not. The regex runs first, so a separator, a dot or a `..` segment is
 * refused before any path is joined; only then is the tree read.
 */
async function resolveExample(from: string): Promise<{ dir: string } | { refused: string }> {
  if (!IDENT.test(from)) {
    return { refused: `Invalid --from '${from}'. Name a shipped example: lowercase letters, numbers, hyphens.` }
  }
  const root = examplesRoot()
  if (!root || !existsSync(root)) {
    return { refused: 'could not locate the shipped examples tree; --from is unavailable from this install' }
  }
  const dir = join(root, from)
  if (existsSync(join(dir, 'manifest.ts')) && existsSync(join(dir, 'handler.ts'))) return { dir }
  const available = (await readdir(root, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
  return { refused: `--from '${from}' is not a shipped example. Available: ${available.join(', ')}` }
}

export async function scaffoldPlugin(name: string, options: ScaffoldOptions = {}): Promise<ScaffoldResult> {
  // Validate name: lowercase letters, numbers, hyphens. Must start with a letter.
  // No path traversal possible with this regex — forward slashes, dots, spaces all rejected.
  if (!IDENT.test(name)) {
    return {
      created: false,
      path: '',
      message: `Invalid plugin name '${name}'. Use lowercase letters, numbers, hyphens. Must start with a letter.`,
    }
  }

  // The source is decided BEFORE the home is prepared: a refused --from must
  // create nothing, and the symlink and ESM marker count as something.
  let source: string | null = null
  if (options.from !== undefined) {
    const resolved = await resolveExample(options.from)
    if ('refused' in resolved) return { created: false, path: '', message: resolved.refused }
    source = resolved.dir
  }

  const pluginDir = join(pluginsDir(), name)

  // Prepare the HOME before deciding anything about this plugin. Both steps
  // are properties of the home, not of the plugin being created: the symlink
  // is what makes any plugin's `warpline/...` import resolve, and the ESM
  // marker is what makes Node load any plugin as a module. Running them only
  // on the create path meant a home left unmarked by warpline 0.1.0 could not
  // be healed by scaffolding at all — the obvious remedy, re-running scaffold
  // for the plugin you already have, returned here and did nothing.
  const warnings = await prepareHome()

  if (existsSync(pluginDir)) {
    return {
      created: false,
      path: pluginDir,
      message: [`Plugin '${name}' already exists at ${pluginDir}`, ...warnings.map((w) => `⚠ ${w}`)].join('\n'),
    }
  }

  await mkdir(pluginDir, { recursive: true })

  if (source) {
    // The whole example directory, so an example that ships a reference file
    // beside its three sources arrives intact. One rewrite afterwards: the
    // manifest's name, which the loader keys on and the config path derives
    // from. Everything else is left as shipped — the copy is expected to
    // diverge, and rewriting more would only hide where it started.
    try {
      await cp(source, pluginDir, { recursive: true })
      const manifestPath = join(pluginDir, 'manifest.ts')
      const shipped = await readFile(manifestPath, 'utf8')
      const nameLine = /^(\s*name:\s*)'[^']*'/m
      if (!nameLine.test(shipped)) throw new Error(`the shipped manifest for '${options.from}' has no name field to rewrite`)
      await writeFile(manifestPath, shipped.replace(nameLine, `$1'${name}'`))
    } catch (err) {
      // The directory did not exist a moment ago, so removing it leaves the
      // home exactly as it was: no half-copied plugin for the loader to trip on.
      await rm(pluginDir, { recursive: true, force: true })
      throw err
    }
    return {
      created: true,
      path: pluginDir,
      message: [`Plugin '${name}' copied from example '${options.from}' at ${pluginDir}`, ...warnings.map((w) => `⚠ ${w}`)].join('\n'),
    }
  }

  // manifest.ts — validated against PluginManifestSchema at import time.
  // Declarative: imports and the export, nothing else, because importing it
  // runs it (during `warpline plan`, before any gate). One declared input, so
  // the plugin has real config from its first run; the default is a
  // placeholder, recognisably, and carries nothing from anywhere.
  const manifestContent = `import { PluginManifestSchema } from 'warpline/schemas/plugin-manifest'

export const manifest = PluginManifestSchema.parse({
  name: '${name}',
  version: '1.0.0',
  description: 'TODO: Describe what this plugin does',
  inputs: {
    // Required AND defaulted: the default satisfies the requirement at the
    // lowest precedence tier, so the plugin runs on a clean install. Replace
    // the placeholder, or set a value in <home>/config/${name}.json.
    target: {
      type: 'string',
      required: true,
      default: 'example',
      description: 'TODO: what this plugin acts on. Replace the placeholder default.',
    },
  },
  outputs: {},
  capabilities: [],
  schedule: 'on_run',
  autonomy_level: 'supervised',
  side_effects: [],
  ttl_hours: 24,
  dependencies: [],
  timeout_ms: 60_000,
  max_parallelism: 1,
})
`

  // handler.ts — the four-parameter form docs/plugin-authoring.md shows. The
  // handler type is a TYPE-only import: `warpline/unstable-capabilities`
  // carries no runtime value, and the tarball gate asserts that set is empty.
  // The result goes through a builder so the schema's own defaults apply; the
  // handler writes no version field of its own.
  const handlerContent = `import type { PluginManifest } from 'warpline/schemas/plugin-manifest'
import type { SkillResultInput } from 'warpline/schemas/skill-result'
import type { CapabilityHandlerFn } from 'warpline/unstable-capabilities'
import { skillFailure, skillOk } from 'warpline/unstable-result'
import { manifest } from './manifest.ts'

export const handler: CapabilityHandlerFn = async (_manifest, args, _signal, _capabilities) => {
  const target = args.target
  if (typeof target !== 'string') {
    // Name the key and the shape, never the value: this message reaches the run log.
    return skillFailure('parse_error', "input 'target' must be a string")
  }
  // TODO: Implement plugin logic. Take \`_signal\` as \`signal\` and forward it to fetch()/spawn().
  return skillOk(\`\${manifest.name} executed successfully\`, {
    phases_completed: [manifest.name],
  })
}
`

  await writeFile(join(pluginDir, 'manifest.ts'), manifestContent)
  await writeFile(join(pluginDir, 'handler.ts'), handlerContent)

  return {
    created: true,
    path: pluginDir,
    message: [`Plugin '${name}' scaffolded at ${pluginDir}`, ...warnings.map((w) => `⚠ ${w}`)].join('\n'),
  }
}

/**
 * The subcommand arm: parse, scaffold, return a code. Both ways into
 * scaffold — the dispatcher's `case 'scaffold'` and the process-entry tail
 * below — go through here, so a flag one of them honoured and the other
 * dropped cannot happen.
 */
export async function run(argv: string[]): Promise<number> {
  let values: { from?: string }
  let positionals: string[]
  try {
    // strict: true rejects an unknown flag and a dash-leading --from value
    // with no hand-rolled scan.
    const parsed = parseArgs({
      args: argv,
      options: { from: { type: 'string' } },
      allowPositionals: true,
      strict: true,
    })
    values = parsed.values
    positionals = parsed.positionals
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`)
    return 1
  }

  const [name, ...extra] = positionals
  if (!name || extra.length > 0) {
    process.stderr.write(USAGE)
    return 1
  }

  const result = await scaffoldPlugin(name, { from: values.from })
  process.stdout.write(`${result.message}\n`)
  return result.created ? 0 : 1
}

// CLI entry point — only runs when executed directly
if (import.meta.main) {
  process.exit(await run(process.argv.slice(2)))
}
