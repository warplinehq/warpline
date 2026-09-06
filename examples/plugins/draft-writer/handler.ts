import { join } from 'node:path'
import type { PluginManifest } from 'warpline/schemas/plugin-manifest'
import { warplineHome } from 'warpline/lib/paths'
import type { CapabilityHandlerFn } from 'warpline/unstable-capabilities'
import { atomicWriteJson, readJsonOrNull } from 'warpline/unstable-fs'
import { skillFailure, skillHandoff, skillOk } from 'warpline/unstable-result'

/**
 * Checks the adopter's three reference files are where the config says, writes
 * a payload under the home that NAMES them, and hands the drafting off. No
 * rule, term or field from any of those files is read into this plugin's
 * result: the payload carries paths, and the skill that drafts opens them.
 *
 * Payload, `<home>/state/draft-writer.handoff.json`:
 * {
 *   "topics": ["..."],
 *   "draft_length_words": 800,
 *   "output_dir": "drafts/draft-writer",
 *   "references": {
 *     "voice_rules": "plugins/draft-writer/reference/voice-rules.example.md",
 *     "blocklist": "...",
 *     "frontmatter_schema": "..."
 *   }
 * }
 */

/** Every failure here is the plugin's own phase, high impact, and not retried. */
const FAILED = { phases_failed: ['draft-writer'], impact: 'HIGH' as const, retryable: false }

/**
 * A path under the home and nowhere else: no leading separator, no drive
 * letter, no `..` segment. The same rule the handoff contract applies to a
 * `[needs-llm]` payload path, applied here to the files the adopter names.
 */
export function isUnderHome(rel: string): boolean {
  if (rel === '' || /^[\\/]/.test(rel) || /^[A-Za-z]:/.test(rel)) return false
  return !rel.split(/[\\/]/).includes('..')
}

/**
 * A configured value, or the manifest's own default when the caller left it
 * out. The runtime merges defaults before a handler is called; a host that
 * calls the handler directly may not, and the default lives in ONE place.
 */
function configured(manifest: PluginManifest, args: Record<string, unknown>, key: string): unknown {
  return args[key] !== undefined ? args[key] : manifest.inputs[key]?.default
}

/**
 * Is the file there? The published `warpline/unstable-fs` surface reads JSON
 * and nothing else, and the voice rules are prose: `readJsonOrNull` returns
 * `null` for ENOENT alone and throws on everything else, so "not null, or
 * threw" is "present" — which is all this arm asks of a file it must not
 * read. ponytail: a published text reader or existence probe would replace
 * this; until one exists this is the whole of what an example may reach for.
 */
async function present(path: string): Promise<boolean> {
  try {
    return (await readJsonOrNull(path)) !== null
  } catch {
    return true
  }
}

export const handler: CapabilityHandlerFn = async (manifest, args, _signal, _capabilities) => {
  const home = warplineHome()

  // Shape first, before any read: a path is refused by the rule it broke,
  // named with its key. Neither the value nor where it pointed is repeated,
  // because this summary lands in the run log.
  const paths = {
    voice_rules: configured(manifest, args, 'voice_rules_path'),
    blocklist: configured(manifest, args, 'blocklist_path'),
    frontmatter_schema: configured(manifest, args, 'frontmatter_schema_path'),
  }
  for (const [name, value] of Object.entries(paths)) {
    if (typeof value !== 'string' || !isUnderHome(value)) {
      return skillFailure('parse_error', `${manifest.name}: input '${name}_path' must be a relative path under the warpline home with no '..' segment`, FAILED)
    }
  }
  const outputDir = configured(manifest, args, 'output_dir') ?? join('drafts', manifest.name)
  if (typeof outputDir !== 'string' || !isUnderHome(outputDir)) {
    return skillFailure('parse_error', `${manifest.name}: input 'output_dir' must be a relative path under the warpline home with no '..' segment`, FAILED)
  }

  // NOT a bare `skipped`: a prefix-less `skipped` is persisted as `failed`,
  // and a plugin with nothing configured to write about is not a red run.
  const topics = configured(manifest, args, 'topics')
  const wanted = (Array.isArray(topics) ? topics : []).filter((t): t is string => typeof t === 'string')
  if (wanted.length === 0) {
    return skillOk(`${manifest.name}: input 'topics' is empty — nothing to draft; run: warpline configure ${manifest.name}`, {
      phases_completed: [manifest.name],
    })
  }
  const length = configured(manifest, args, 'draft_length_words')

  // Each file is checked for presence and, where it is JSON, for the shape
  // the payload promises. Absent is a prefixed skip naming the key — an
  // adopter who has not pointed the input at their file yet is not broken.
  // Present-but-wrong is a failure, also by key, so the skill is never handed
  // a reference it cannot use.
  const rel = paths as Record<keyof typeof paths, string>
  if (!(await present(join(home, rel.voice_rules)))) return missing(manifest.name, 'voice_rules_path', 'your voice rules')

  let blocklist: { terms?: unknown } | null
  try {
    blocklist = await readJsonOrNull<{ terms?: unknown }>(join(home, rel.blocklist))
  } catch {
    return skillFailure('parse_error', `${manifest.name}: the file named by input 'blocklist_path' is not JSON`, FAILED)
  }
  if (blocklist === null) return missing(manifest.name, 'blocklist_path', 'your blocklist')
  if (!Array.isArray(blocklist.terms)) {
    return skillFailure('parse_error', `${manifest.name}: the file named by input 'blocklist_path' must hold { "terms": [...] }`, FAILED)
  }

  let schema: unknown
  try {
    schema = await readJsonOrNull<unknown>(join(home, rel.frontmatter_schema))
  } catch {
    return skillFailure('parse_error', `${manifest.name}: the file named by input 'frontmatter_schema_path' is not JSON`, FAILED)
  }
  if (schema === null) return missing(manifest.name, 'frontmatter_schema_path', 'your frontmatter schema')
  if (typeof schema !== 'object' || Array.isArray(schema)) {
    return skillFailure('parse_error', `${manifest.name}: the file named by input 'frontmatter_schema_path' must hold a JSON object`, FAILED)
  }

  // The payload names the files, relative to the home, and the skill reads
  // them there. Written under the home so the path after `Context:` is one
  // this plugin chose, never one it was configured with.
  const contextPath = `state/${manifest.name}.handoff.json`
  await atomicWriteJson(join(home, contextPath), {
    topics: wanted,
    draft_length_words: length,
    output_dir: outputDir,
    references: rel,
  })

  // `skillHandoff` resolves the path against the home itself, so the argument
  // stays RELATIVE. The task carries no full stop: the scanner splits on
  // `Context: `.
  return skillHandoff(`Draft ${wanted.length} ${wanted.length === 1 ? 'piece' : 'pieces'} under the configured voice rules`, contextPath, {
    phases_completed: [manifest.name],
    data_freshness: { handoff: new Date().toISOString() },
  })
}

/** A file the adopter has not pointed the plugin at yet: a prefixed success, by key. */
function missing(plugin: string, key: string, what: string) {
  return skillOk(`${plugin}: input '${key}' names no file under the warpline home — point it at ${what}, then run: warpline configure ${plugin}`, {
    phases_completed: [plugin],
  })
}
