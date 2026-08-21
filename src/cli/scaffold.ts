/**
 * Plugin scaffold command — generates a new plugin directory with a
 * typed manifest template and handler stub.
 *
 * Usage: warpline scaffold <plugin-name>
 *
 * Plugin names must be lowercase, hyphenated identifiers.
 * Name is validated against [a-z][a-z0-9-]* — no path traversal possible.
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
import { mkdir, writeFile, symlink, unlink, readFile } from 'node:fs/promises'
import { existsSync, lstatSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pluginsDir, warplineHome } from '../lib/paths.js'

export interface ScaffoldResult {
  created: boolean
  path: string
  message: string
}

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

export async function scaffoldPlugin(name: string): Promise<ScaffoldResult> {
  // Validate name: lowercase letters, numbers, hyphens. Must start with a letter.
  // No path traversal possible with this regex — forward slashes, dots, spaces all rejected.
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    return {
      created: false,
      path: '',
      message: `Invalid plugin name '${name}'. Use lowercase letters, numbers, hyphens. Must start with a letter.`,
    }
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

  // manifest.ts — validated against PluginManifestSchema at import time
  const manifestContent = `import { PluginManifestSchema } from 'warpline/schemas/plugin-manifest'

export const manifest = PluginManifestSchema.parse({
  name: '${name}',
  version: '1.0.0',
  description: 'TODO: Describe what this plugin does',
  inputs: {},
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

  // handler.ts — stub returning SkillResult shape
  const handlerContent = `import type { PluginManifest } from 'warpline/schemas/plugin-manifest'
import type { SkillResult } from 'warpline/schemas/skill-result'
import { manifest } from './manifest.ts'

export async function handler(
  _manifest: PluginManifest,
  _args: Record<string, unknown> = {},
): Promise<SkillResult> {
  // TODO: Implement plugin logic
  return {
    status: 'success',
    phases_completed: [manifest.name],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: \`\${manifest.name} executed successfully\`,
    artifacts_produced: [],
    schema_version: 1,
  }
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

// CLI entry point — only runs when executed directly
if (import.meta.main) {
  const name = process.argv[2]
  if (!name) {
    console.error('Usage: warpline scaffold <plugin-name>')
    process.exit(1)
  }
  const result = await scaffoldPlugin(name)
  console.log(result.message)
  process.exit(result.created ? 0 : 1)
}
