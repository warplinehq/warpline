/**
 * `warpline configure <plugin>` — turn a manifest's declared inputs into
 * `<home>/config/<plugin>.json`, so an operator never hand-authors that file.
 *
 * Two ways in, one write. The TTY walk asks for each declared input in the
 * order the manifest declares them; `--from <json>` takes some or all of the
 * values at once and never prompts. Both route through `writePluginConfig`,
 * which is exported for exactly that reason: a later verb that needs "write
 * this plugin's config" calls it in-process, and the secrets rule below then
 * has one implementation rather than two that drift.
 *
 * A RE-RUN STARTS FROM THE FILE, not from the manifest. Every value already
 * on disk is kept unless this run replaces it: Enter at a prompt keeps the
 * current value (shown beside the prompt), and a `--from` body is a patch
 * over the file rather than the whole record. The verb's own "Still needed"
 * line sends an operator back here, and that advice must not cost them the
 * inputs they answered last time. A key the file holds that the manifest no
 * longer declares is carried over as it is.
 *
 * SECRETS are never persisted. A name in `manifest.secrets` is skipped by the
 * walk and refused by `--from`; the message names the environment variable
 * the runtime reads instead. The key is ABSENT from the written file, not
 * present-and-empty. An operator who copies the home ships no credential.
 *
 * VALIDATION goes through `resolvePluginArgs`, the same resolver the runtime
 * applies to the file it is about to write. It validates and never coerces,
 * so a typed answer for a `number` input is parsed as JSON at this boundary
 * first and then checked; the shared schema module is untouched, because a
 * change there would alter the config-file tier too.
 *
 * ORDERING, copied from `approve.ts`: everything that can refuse runs BEFORE
 * anything is written. The whole walk completes, or the body fully validates,
 * and only then does a single atomic write run — so a refusal partway leaves
 * no half-written config, and a concurrent reader never observes a partial
 * file.
 *
 * ERROR TEXT names the key and the shape expected of it, never the value
 * received. These strings land in a terminal an operator may paste.
 *
 * Never terminates the process — it returns a code to the dispatcher.
 */
import { parseArgs } from 'node:util'
import * as fsAtomic from '../lib/fs-atomic.js'
import { pluginConfigPath, pluginsDir } from '../lib/paths.js'
import { loadPluginConfig, PluginConfigError } from '../lib/plugin-config.js'
import { loadPluginManifests } from '../runtime/engine.js'
import { resolvePluginArgs, type DeclaredInput } from '../schemas/plugin-config.js'
import type { PluginManifest } from '../schemas/plugin-manifest.js'
import { isInteractive, lineReader, type LineReader } from './prompt.js'
import { IDENT } from './scaffold.js'
import { suggest } from './suggest.js'

const USAGE = `Usage: warpline configure <plugin> [--from <json>]

Walks the inputs the plugin's manifest declares and writes
<home>/config/<plugin>.json. Names declared in the manifest's secrets are
never written; set them in the environment instead. Safe to run again: a
value already in the file is kept unless you replace it, and Enter at a
prompt keeps it.

Options:
  --from <json>  A JSON object of input names to values, some or all of them.
                 Patches the same file with no prompts, for a stdin that is
                 not a terminal; keys left out keep what the file holds.
`

/** The streams a walk prompts on. Parameters, so a test can inject them. */
export interface ConfigureIo {
  input: NodeJS.ReadableStream & { isTTY?: boolean }
  output: NodeJS.WritableStream
}

/** A refusal: the problems, each naming a key and a shape and never a value. */
export class ConfigureError extends Error {
  readonly problems: string[]
  constructor(problems: string[]) {
    super(problems.join('\n'))
    this.name = 'ConfigureError'
    this.problems = problems
  }
}

/** What `writePluginConfig` did: the keys it wrote, the required keys still without a value, the secrets it skipped. */
export interface WriteResult {
  written: string[]
  needed: string[]
  secrets: string[]
}

/**
 * The lead sentence of a mid-walk refusal. A property of the walk, which has
 * one implementation in `walkPluginInputs`, so it lives beside it; each verb
 * appends its own tail saying what it did not write.
 */
export const WALK_ENDED = 'Input ended before every input was answered.'

const secretNote = (key: string): string =>
  `${key}: declared in secrets, so it is read at run time as the ${key} environment ` +
  `variable and never written to the config file.\n`

/** The same guard scaffold applies, run before any path is built from the name. */
function assertPluginName(pluginName: string): void {
  if (!IDENT.test(pluginName)) {
    throw new ConfigureError([
      `Invalid plugin name '${pluginName}'. Use lowercase letters, numbers, hyphens. Must start with a letter.`,
    ])
  }
}

/** Resolve a plugin by name, or refuse naming it and where it was looked for. */
async function resolvePlugin(pluginName: string): Promise<PluginManifest> {
  assertPluginName(pluginName)
  const root = pluginsDir()
  const { manifests, failures } = await loadPluginManifests(root)
  const manifest = manifests.get(pluginName)
  if (manifest) return manifest
  const broken = failures.find((f) => f.plugin === pluginName)
  if (broken) {
    throw new ConfigureError([`Plugin '${pluginName}' exists but its manifest failed to load: ${broken.error}`])
  }
  const hint = suggest(pluginName, [...manifests.keys()])
  throw new ConfigureError([
    `Plugin '${pluginName}' not found under ${root}.${hint ? ` Did you mean '${hint}'?` : ''}`,
  ])
}

/**
 * The config already on disk, or `{}` when there is none.
 *
 * A file that exists and cannot be parsed is a refusal, not a blank slate:
 * writing over it would discard whatever the operator meant it to hold. The
 * path is named because it is what they need to fix it; the reason describes
 * the shape of the problem and never a value, by `PluginConfigError`'s own
 * contract.
 */
async function currentConfig(pluginName: string): Promise<Record<string, unknown>> {
  const path = pluginConfigPath(pluginName)
  try {
    return await loadPluginConfig(path)
  } catch (err) {
    if (!(err instanceof PluginConfigError)) throw err
    throw new ConfigureError([`The config already at ${path} cannot be read: ${err.reason}. Fix it or remove it, then run again.`])
  }
}

/**
 * The non-interactive core: validate everything, then write once.
 *
 * Each declared key takes the first of: the caller's value, the value the
 * file already holds, the manifest default. So a call with `{}` over no file
 * writes exactly what the manifest defaults, and the same call over a
 * configured file writes it back unchanged. A required key with none of the
 * three is reported in `needed` and omitted from the file — the file stays
 * valid and the runtime names the gap at run time — rather than refused,
 * because the caller may be a first-run setup that never asked.
 *
 * A key the file holds that the manifest does not declare is carried over as
 * it is, after the declared keys. The one exception is a name the manifest
 * now declares in `secrets`: that is never written, whoever put it there.
 *
 * Refuses, with nothing written: a key the manifest does not declare in
 * `values`, a key that is an `Object.prototype` member, a value for a
 * declared secret, an existing file that cannot be parsed, and any value the
 * resolver rejects — including one already on disk, so a file the manifest
 * has moved away from is named rather than silently rewritten.
 */
export async function writePluginConfig(
  pluginName: string,
  values: Record<string, unknown>,
): Promise<WriteResult> {
  const manifest = await resolvePlugin(pluginName)
  const current = await currentConfig(pluginName)
  const declared: Record<string, DeclaredInput> = manifest.inputs ?? {}
  const secretNames = new Set(manifest.secrets ?? [])

  const problems: string[] = []
  for (const key of Object.keys(values)) {
    if (key in Object.prototype) {
      problems.push('a config key may not be an Object.prototype member')
    } else if (secretNames.has(key)) {
      problems.push(
        `'${key}' is a declared secret; set the ${key} environment variable instead of writing it to the config file`,
      )
    } else if (!Object.hasOwn(declared, key)) {
      problems.push(`'${key}' is not an input ${pluginName} declares`)
    }
  }

  // Null prototype, built in DECLARATION order, so the written key order is
  // the manifest's and a key that gets through is an own property.
  const config: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  const checked: Record<string, DeclaredInput> = {}
  const written: string[] = []
  const needed: string[] = []
  const secrets: string[] = []
  for (const [key, input] of Object.entries(declared)) {
    if (secretNames.has(key)) {
      secrets.push(key)
      continue
    }
    const value = Object.hasOwn(values, key) && values[key] !== undefined
      ? values[key]
      : Object.hasOwn(current, key) && current[key] !== undefined
        ? current[key]
        : input.default
    if (value === undefined) {
      if (input.required ?? true) needed.push(key)
      continue
    }
    config[key] = value
    checked[key] = input
    written.push(key)
  }
  // What the file holds beyond the declaration, kept as it is: a re-run must
  // not be the thing that loses it. `current` came through the config
  // schema, so none of these keys is an `Object.prototype` member.
  for (const [key, value] of Object.entries(current)) {
    if (Object.hasOwn(declared, key) || secretNames.has(key)) continue
    config[key] = value
    written.push(key)
  }

  const resolution = resolvePluginArgs(checked, {}, config)
  if (!resolution.ok) problems.push(...resolution.problems)
  if (problems.length > 0) throw new ConfigureError(problems)

  await fsAtomic.atomicWriteJson(pluginConfigPath(pluginName), config)
  return { written, needed, secrets }
}

/**
 * The line shown above each prompt: key, type, whether it is required, the
 * value the file already holds if any, the default if any. The current value
 * is shown because Enter keeps it, and an operator must see what Enter does.
 */
function describeInput(key: string, input: DeclaredInput, current: unknown): string {
  const facts = [
    input.type ?? 'value',
    (input.required ?? true) ? 'required' : 'optional',
    ...(current !== undefined ? [`current ${JSON.stringify(current)}`] : []),
    ...(input.default !== undefined ? [`default ${JSON.stringify(input.default)}`] : []),
  ]
  const description = input.description ? `  ${input.description}\n` : ''
  return `\n${key}  ${facts.join(', ')}\n${description}`
}

/**
 * Parse one typed answer against the declared type. A `string` input takes
 * the line as typed, so nothing is normalised on the way in; every other type
 * is entered as JSON. The result is then checked by the resolver.
 */
function parseAnswer(answer: string, input: DeclaredInput): { ok: true; value: unknown } | { ok: false } {
  if (input.type === undefined || input.type === 'string') return { ok: true, value: answer }
  try {
    return { ok: true, value: JSON.parse(answer) as unknown }
  } catch {
    return { ok: false }
  }
}

/**
 * Ask for each declared input in declaration order. Returns the answered
 * values, or `null` when the input ended before the walk did — a refusal, so
 * the caller writes nothing. `current` is what the file already holds, shown
 * beside each prompt; the write is what keeps it.
 */
async function walk(
  manifest: PluginManifest,
  reader: LineReader,
  output: NodeJS.WritableStream,
  current: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const secretNames = new Set(manifest.secrets ?? [])
  const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const [key, input] of Object.entries(manifest.inputs ?? {})) {
    if (secretNames.has(key)) {
      output.write(`\n${secretNote(key)}`)
      continue
    }
    output.write(describeInput(key, input, Object.hasOwn(current, key) ? current[key] : undefined))
    for (;;) {
      const answer = await reader.ask(`${key}> `)
      if (answer === null) return null
      // Empty: no value from this walk, so the write keeps the current one,
      // else the default, else reports the key as still needed.
      if (answer === '') break
      const parsed = parseAnswer(answer, input)
      if (!parsed.ok) {
        output.write(`input '${key}' must be a ${input.type}; enter it as JSON\n`)
        continue
      }
      const resolution = resolvePluginArgs({ [key]: input }, {}, { [key]: parsed.value })
      if (!resolution.ok) {
        output.write(`${resolution.problems.join('; ')}\n`)
        continue
      }
      values[key] = parsed.value
      break
    }
  }
  return values
}

/**
 * The walk for one plugin, from resolving its manifest to closing the reader.
 * Returns the answered values, or `null` when the input ended before the walk
 * did — a refusal, so the caller writes nothing.
 *
 * Exported because a second verb runs the same walk in-process: `init` asks
 * for the seed's inputs on a terminal, and reaching this function is how the
 * prompt format and the secrets rule keep one implementation rather than two
 * that drift. Two things stay with the callers: the terminal check, because
 * each falls back differently when stdin is not one, and the write, because
 * each says something different about what it wrote.
 */
export async function walkPluginInputs(pluginName: string, io: ConfigureIo): Promise<Record<string, unknown> | null> {
  const manifest = await resolvePlugin(pluginName)
  // Before the first prompt: a file that cannot be read refuses the whole
  // walk, rather than asking every question and refusing at the write.
  const current = await currentConfig(pluginName)
  const reader = lineReader(io.input, io.output)
  try {
    return await walk(manifest, reader, io.output, current)
  } finally {
    reader.close()
  }
}

/** The `--from` body as a null-prototype record, or the refusal. */
function parseBody(body: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    // The SyntaxError is not forwarded: engines quote the offending text.
    throw new ConfigureError(['--from expects a JSON object mapping input names to values; the body is not valid JSON'])
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigureError(['--from expects a JSON object mapping input names to values'])
  }
  // Checked here, before the record is built: JSON.parse creates an own
  // `__proto__` property, and a schema record parser drops it silently.
  for (const key of Object.keys(parsed)) {
    if (key in Object.prototype) {
      throw new ConfigureError(['a config key may not be an Object.prototype member'])
    }
  }
  return Object.assign(Object.create(null) as Record<string, unknown>, parsed)
}

export async function run(
  argv: string[],
  io: ConfigureIo = { input: process.stdin, output: process.stdout },
): Promise<number> {
  let values: { from?: string }
  let positionals: string[]
  try {
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

  try {
    assertPluginName(name)
    let body: Record<string, unknown>
    if (values.from !== undefined) {
      body = parseBody(values.from)
    } else {
      if (!isInteractive(io.input)) {
        process.stderr.write(
          `stdin is not a terminal, so there is nothing to ask on. ` +
            `Pass --from <json> to write the config without prompts.\n`,
        )
        return 1
      }
      const walked = await walkPluginInputs(name, io)
      if (walked === null) {
        process.stderr.write(`${WALK_ENDED} Nothing was written.\n`)
        return 1
      }
      body = walked
    }

    const result = await writePluginConfig(name, body)
    // The walk already said this beside the prompt it skipped.
    if (values.from !== undefined) for (const key of result.secrets) process.stdout.write(secretNote(key))
    process.stdout.write(
      `Wrote ${pluginConfigPath(name)}` +
        (result.written.length > 0 ? ` (${result.written.join(', ')})\n` : ' (no inputs declared)\n'),
    )
    if (result.needed.length > 0) {
      process.stdout.write(
        `Still needed before ${name} can run: ${result.needed.join(', ')}. ` +
          `Run warpline configure ${name} again, or edit the file.\n`,
      )
    }
    return 0
  } catch (err) {
    if (!(err instanceof ConfigureError)) throw err
    process.stderr.write(`${err.message}\nNothing was written.\n`)
    return 1
  }
}
