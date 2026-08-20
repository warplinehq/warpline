/**
 * Plugin scaffold command — generates a new plugin directory with a
 * typed manifest template and handler stub.
 *
 * Usage: warpline scaffold <plugin-name>
 *
 * Per D-10: Plugin names must be lowercase, hyphenated identifiers.
 * Name is validated against [a-z][a-z0-9-]* — no path traversal possible.
 *
 * ## Why the generated imports look the way they do
 *
 * Generated plugins live under <warplineHome>/plugins/, outside both this repo
 * and any node_modules — so nothing relative reaches warpline, and a bare
 * `warpline/...` specifier does not resolve on its own from a global install
 * either (D-08). Two mechanisms make it work, and BOTH are load-bearing:
 *
 *   1. the package's `exports` map, which publishes the schema subpaths
 *   2. the `<warplineHome>/node_modules/warpline` symlink this file creates
 *      (D-09) — ESM bare-specifier resolution walks node_modules upward from
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
import { mkdir, writeFile, symlink, unlink } from 'node:fs/promises'
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
 * importing file, and a global install prefix is not on that chain (D-08).
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

  if (existsSync(pluginDir)) {
    return {
      created: false,
      path: pluginDir,
      message: `Plugin '${name}' already exists at ${pluginDir}`,
    }
  }

  await mkdir(pluginDir, { recursive: true })

  // manifest.ts — validated against PluginManifestSchema at import time (D-09 hard-stop)
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

  // A failed link must not fail the scaffold: the files are already written and
  // correct, and a missing or dangling link surfaces later through the engine's
  // plugin load-failures reporting, which is the right place to see it.
  let warning: string | null
  try {
    warning = await linkWarplineIntoHome()
  } catch (err) {
    warning = `could not link warpline into ${warplineHome()}: ${err instanceof Error ? err.message : String(err)}`
  }

  return {
    created: true,
    path: pluginDir,
    message: warning
      ? `Plugin '${name}' scaffolded at ${pluginDir}\n⚠ ${warning}`
      : `Plugin '${name}' scaffolded at ${pluginDir}`,
  }
}

// CLI entry point — only runs when executed directly
if (import.meta.main) {
  const name = process.argv[2]
  if (!name) {
    console.error('Usage: bun run scripts/scaffold-plugin.ts <plugin-name>')
    process.exit(1)
  }
  const result = await scaffoldPlugin(name)
  console.log(result.message)
  process.exit(result.created ? 0 : 1)
}
