/**
 * Read a plugin's `<home>/config/<plugin>.json` off disk.
 *
 * Shaped like `readPreferences` and split from it on one point. That loader
 * returns defaults on a missing file, on invalid JSON and on a failed
 * `safeParse` alike. Half of that is right: a missing config file is an empty
 * config, because a plugin that needs nothing configured should not have to
 * ship an empty document to say so. The other half is how a plugin runs against
 * the wrong target with a green board — an operator edits the config, fat-fingers
 * a brace, and the run proceeds on defaults nobody chose. A malformed config is
 * a hard failure here.
 */
import { readFile } from 'node:fs/promises'
import { PluginConfigSchema, type PluginConfig } from '../schemas/plugin-config.js'

/**
 * A config file exists but cannot be used.
 *
 * Carries the path so the caller can name it to the operator — telling someone
 * their config is invalid without saying which file is the difference between a
 * fixable error and a scavenger hunt.
 *
 * The `reason` describes the SHAPE of the problem and never a value read out of
 * the file. Config files are the channel operators put API tokens in, and an
 * error message is written to a run log.
 */
export class PluginConfigError extends Error {
  readonly configPath: string
  readonly reason: string

  constructor(configPath: string, reason: string) {
    super(`Invalid plugin config at ${configPath}: ${reason}`)
    this.name = 'PluginConfigError'
    this.configPath = configPath
    this.reason = reason
  }
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT'
}

/**
 * Load a plugin config file.
 *
 * @param configPath - Absolute path, normally from `pluginConfigPath(name)`.
 * @returns The parsed config, or `{}` when the file does not exist.
 * @throws PluginConfigError when the file exists but is unparseable or the
 *   wrong shape.
 */
export async function loadPluginConfig(configPath: string): Promise<PluginConfig> {
  let content: string
  try {
    content = await readFile(configPath, 'utf-8')
  } catch (err: unknown) {
    if (isEnoent(err)) return {}
    throw err
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    // The thrown SyntaxError is not forwarded: engines quote the offending
    // source text in it, which would put a config value into the message this
    // class exists to keep values out of.
    throw new PluginConfigError(configPath, 'file is not valid JSON')
  }

  const result = PluginConfigSchema.safeParse(parsed)
  if (!result.success) {
    throw new PluginConfigError(configPath, describeIssues(result.error))
  }
  return result.data
}

/**
 * Turn a ZodError into a reason string built from key paths and issue codes.
 *
 * Zod's own `issue.message` is not passed through. It is well behaved today,
 * but it is upstream prose that can start quoting received values in any minor
 * release, and this string is written to a run log.
 */
function describeIssues(error: { issues: readonly { code: string; path: PropertyKey[] }[] }): string {
  const seen = new Set<string>()
  for (const issue of error.issues) {
    const key = issue.path.map(String).join('.')
    seen.add(
      key
        ? `key '${key}' is not valid here (${issue.code})`
        : `expected a JSON object mapping input names to values (${issue.code})`,
    )
  }
  return [...seen].join('; ')
}
