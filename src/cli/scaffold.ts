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
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pluginsDir } from '../lib/paths.js'

export interface ScaffoldResult {
  created: boolean
  path: string
  message: string
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

  return {
    created: true,
    path: pluginDir,
    message: `Plugin '${name}' scaffolded at ${pluginDir}`,
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
