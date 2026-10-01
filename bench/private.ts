/**
 * The name-free pieces of the private-scale benchmark mode.
 *
 * Every private value reaches this mode through a gitignored config, and
 * nothing in this module names a fleet plugin, a fleet path or a fleet
 * variable. What IS public is the commitments ledger: an append-only file of
 * salted digests that lets anyone check, from git history alone, that the
 * private method was fixed before its results existed, without learning what
 * either says.
 *
 * The ledger's line format is a one-way door. Once a `prereg` line is
 * committed, the freeze test forbids removing it, so the format can never be
 * changed after that without the history saying so.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs'
import { copyFile, cp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AdvanceResult } from 'warpline'
import { warplineHome } from 'warpline/lib/paths'
import { EngineStateSchema } from 'warpline/schemas/engine-state'
import { loadPluginManifests } from 'warpline/unstable-runtime'
import { z } from 'zod'
import { GradeCheckSchema } from './grade.js'
import { ControlSeedError, GRADED_DIR, NOTES_PATH, writeSessionGrant } from './seed.js'

/** The tracked ledger, relative to the repository root. */
export const COMMITMENTS_FILE = 'bench/private-commitments'

/**
 * The only legal ledger line. Lowercase hex and nothing around it: a trailing
 * space or a carriage return is a malformed line, never a tolerated one, since
 * a tolerant parser is how two different files come to read as the same list.
 */
export const COMMITMENT_LINE = /^(prereg|results) ([0-9a-f]{64})$/

export type CommitmentKind = 'prereg' | 'results'

export interface CommitmentLine {
  kind: CommitmentKind
  hex: string
}

/**
 * Every line of the ledger, in file order.
 *
 * A single trailing newline is allowed, and nothing else is skipped: a blank
 * line in the middle is malformed. The error names the 1-based line number and
 * never the line itself, because this runs in public CI logs.
 */
export function parseCommitments(text: string): CommitmentLine[] {
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.map((line, i) => {
    const m = COMMITMENT_LINE.exec(line)
    if (!m) throw new Error(`commitments: line ${i + 1} is not a prereg or results entry of 64 lowercase hex`)
    return { kind: m[1] as CommitmentKind, hex: m[2]! }
  })
}

/**
 * The public digest of a private document: sha256 over the salt, then the
 * document. The salt is what stops a short or guessable document from being
 * recovered by hashing candidates, so anything but 32 bytes of it is refused.
 */
export function commitment(salt: Uint8Array, doc: Uint8Array): string {
  if (salt.length !== 32) throw new Error(`commitment: the salt must be 32 bytes, got ${salt.length}`)
  return createHash('sha256').update(salt).update(doc).digest('hex')
}

const sha256hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/**
 * One digest for a whole directory: sha256 over one `relpath\0sha256(bytes)\n`
 * line per regular file, sorted. Names and bytes only, never an archive, whose
 * timestamps and modes would make the same tree hash two ways.
 *
 * A symlink throws rather than being followed or skipped: followed, the digest
 * binds whatever the link points at today; skipped, it binds less than the
 * tree. An empty tree throws, because a digest over nothing binds nothing.
 * Empty directories contribute no line, so they are not bound.
 */
export function treeDigest(root: string): string {
  const files: string[] = []
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      const child = rel === '' ? entry.name : `${rel}/${entry.name}`
      const stat = lstatSync(join(root, child))
      if (stat.isDirectory()) walk(child)
      else if (stat.isFile()) files.push(child)
      else throw new Error(`treeDigest: '${child}' is not a regular file — a digest cannot bind what a link points at`)
    }
  }
  walk('')
  if (files.length === 0) {
    throw new Error(`treeDigest: no regular file under '${root}' — a digest over nothing binds nothing`)
  }
  // Default sort, by UTF-16 code unit, never localeCompare: the engine's
  // plugin loader makes the same choice so its ordering cannot vary by locale,
  // and a digest that did would not be a digest.
  files.sort()
  return sha256hex(Buffer.from(files.map((rel) => `${rel}\0${sha256hex(readFileSync(join(root, rel)))}\n`).join('')))
}

/**
 * The six digests that bind a measured record to the method that was frozen:
 * the snapshot it was seeded from, the build that ran, both prompts, the notes
 * and the config, which carries the checks. Their order is the order of the
 * bind lines in the private pre-registration.
 */
export const BIND_KEYS = [
  'snapshot_sha256',
  'build_sha256',
  'agent_prompt_sha256',
  'consumer_prompt_sha256',
  'notes_sha256',
  'config_sha256',
] as const
export type BindKey = (typeof BIND_KEYS)[number]

/** One 64-hex digest per bound input. */
export type MethodBindings = Record<BindKey, string>

/**
 * What binds a private record to its input and its method: the snapshot digest
 * always, and on a measured record the prereg commitment and the other five
 * digests as well.
 */
export interface PrivateStamp extends Partial<Omit<MethodBindings, 'snapshot_sha256'>> {
  snapshot_sha256: string
  prereg_commitment?: string
}

/**
 * The method a measured set is bound to, read from the committed private
 * pre-registration: its six digests, its public commitment, the commit that
 * froze it, and the check ids every record must be graded on.
 */
export interface FrozenMethod extends MethodBindings {
  prereg_commitment: string
  freeze_commit: string
  check_ids: readonly string[]
}

/**
 * What a measured record is stamped with: the six digests and the commitment,
 * and nothing else. The freeze commit reaches a record as its `git_sha`, and
 * the check ids as its graded keys, so neither is copied in a second time.
 */
export function recordStamp(frozen: FrozenMethod): PrivateStamp {
  const stamp: PrivateStamp = { snapshot_sha256: frozen.snapshot_sha256, prereg_commitment: frozen.prereg_commitment }
  for (const key of BIND_KEYS) stamp[key] = frozen[key]
  return stamp
}

/** One `bind <key> <hex>` line per key, in key order, each newline-terminated. */
export function formatBindings(bindings: MethodBindings): string {
  return BIND_KEYS.map((key) => `bind ${key} ${bindings[key]}\n`).join('')
}

const BIND_LINE = /^bind ([a-z0-9_]+) ([0-9a-f]{64})$/

/**
 * The bindings a pre-registration states. A line that starts with the word
 * `bind` is a binding and must be well formed; every other line is prose.
 * Exactly one line per key: a missing, duplicate or unknown key is refused, as
 * is a malformed binding line, which is named by its 1-based number and never
 * by its text.
 */
export function parseBindings(text: string): MethodBindings {
  const found = new Map<string, string>()
  text.split('\n').forEach((line, i) => {
    if (!/^bind(\s|$)/.test(line)) return
    const m = BIND_LINE.exec(line)
    if (!m) throw new Error(`bindings: line ${i + 1} is not a bind line of a key and 64 lowercase hex`)
    const [, key, hex] = m as unknown as [string, string, string]
    if (!(BIND_KEYS as readonly string[]).includes(key)) throw new Error(`bindings: line ${i + 1} binds the unknown key '${key}'`)
    if (found.has(key)) throw new Error(`bindings: '${key}' is bound twice — a method binds each input once`)
    found.set(key, hex)
  })
  for (const key of BIND_KEYS) {
    if (!found.has(key)) throw new Error(`bindings: no bind line for '${key}', so that input is unbound`)
  }
  return Object.fromEntries(BIND_KEYS.map((key) => [key, found.get(key)!])) as MethodBindings
}

/** The checkout root, which is also the package root a seeded fleet resolves `warpline` to. */
const REPO_ROOT = resolve(import.meta.dir, '..')

/**
 * A path relative to a home or a snapshot: not empty, not absolute, and no
 * empty, `.` or `..` segment. Normalised by construction, so a plain string
 * prefix test at a `/` boundary is a sound containment test between two of them.
 */
const isRelativePath = (p: string): boolean =>
  p !== '' && !isAbsolute(p) && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..')

/** `path` is `dir` or sits under it. Both are relative paths in the form above. */
const within = (path: string, dir: string): boolean => path === dir || path.startsWith(`${dir}/`)

const RelativePath = z.string().refine(isRelativePath, 'must be a relative path with no empty, . or .. segment')
const AbsolutePath = z.string().refine(isAbsolute, 'must be an absolute path')
const Segment = z
  .string()
  .refine((s) => s !== '' && s !== '.' && s !== '..' && !/[\\/]/.test(s), 'must be a single path segment')


/**
 * Everything private about a fleet, in one gitignored document.
 *
 * Tracked code names no plugin, no directory and no variable of the fleet it
 * measures; each of them arrives here. The copy list is one uniform `entries`
 * array: each entry is a live source, a path inside an arm home, and which arms
 * receive it. The snapshot directory mirrors an arm home exactly, so seeding is
 * copying snapshot paths into a home and never reading a live source.
 */
export const PrivateConfigSchema = z
  .strictObject({
    plugins: z
      .array(z.string().regex(/^[a-z0-9][a-z0-9_-]*$/))
      .min(1)
      .refine((names) => new Set(names).size === names.length, 'plugin names must be unique'),
    fleetDir: Segment,
    warplineHomeDir: Segment,
    snapshot: z.strictObject({
      dir: AbsolutePath,
      sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    }),
    entries: z
      .array(z.strictObject({ from: AbsolutePath, to: RelativePath, scope: z.enum(['warpline', 'every-arm']) }))
      .min(1),
    links: z.strictObject({
      from: AbsolutePath,
      packages: z.array(RelativePath.refine((p) => p !== 'warpline', "'warpline' is linked to this checkout, never to the fleet's install")),
    }),
    pathsSeam: z.strictObject({ module: RelativePath, exports: z.array(z.string().min(1)).min(1) }),
    envScrub: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/)),
    fleetInstall: AbsolutePath,
    prompts: z.strictObject({ agent: AbsolutePath, consumer: AbsolutePath }),
    notes: AbsolutePath,
    copyMap: z.array(
      z.strictObject({
        plugin: z.string(),
        from: RelativePath,
        to: RelativePath.refine((p) => p.startsWith(`${GRADED_DIR}/`), `a copy target must sit under ${GRADED_DIR}/`),
      }),
    ),
    checks: z.array(GradeCheckSchema).min(1),
    resultsDir: AbsolutePath,
    /**
     * The private pre-registration and its salt, both outside this repository.
     * The measured gate re-derives the committed prereg digest from this pair
     * before it reads a binding. The block is inside the config digest, so it
     * is set before the bindings are printed.
     */
    prereg: z.strictObject({ doc: AbsolutePath, salt: AbsolutePath }).optional(),
  })
  .superRefine((config, ctx) => {
    const issue = (message: string): void => ctx.addIssue({ code: 'custom', message })
    if (config.fleetDir === config.warplineHomeDir) issue('fleetDir and warplineHomeDir must differ')
    const plugins = new Set(config.plugins)
    for (const { plugin } of config.copyMap) {
      if (!plugins.has(plugin)) issue(`copyMap names '${plugin}', which is not a configured plugin`)
    }
    const ids = config.checks.map((check) => check.id)
    if (new Set(ids).size !== ids.length) issue('check ids must be unique')
    const pluginRoot = `${config.fleetDir}/plugins`
    config.entries.forEach(({ to, scope }, i) => {
      // One owner per path: overlapping entries would make the snapshot's
      // bytes depend on copy order, and the manifest flip on a guess.
      config.entries.forEach((other, j) => {
        if (i !== j && within(to, other.to)) issue(`entry '${to}' overlaps entry '${other.to}'`)
      })
      // graded/ starts empty in every arm, or an arm is graded on bytes it was handed.
      if (within(to, GRADED_DIR) || within(GRADED_DIR, to)) issue(`entry '${to}' reaches the graded directory`)
      if (scope !== 'every-arm') return
      // A control arm is handed data. Code and the warpline home would hand it the implementation.
      for (const dir of [pluginRoot, config.warplineHomeDir]) {
        if (within(to, dir) || within(dir, to)) issue(`every-arm entry '${to}' reaches '${dir}', which a control arm must not see`)
      }
      if (to === NOTES_PATH) issue(`every-arm entry '${to}' is the notes path, which only the with-state arm receives`)
    })
  })
export type PrivateConfig = z.infer<typeof PrivateConfigSchema>

/** Read and parse the private config. A relative path would depend on the working directory. */
export function loadPrivateConfig(path: string): PrivateConfig {
  if (!isAbsolute(path)) throw new Error(`the private config path must be absolute, got '${path}'`)
  return PrivateConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
}

/**
 * The one line of a manifest object that sets its autonomy: anchored, a single
 * quoted lowercase word, a trailing comma. A docstring that mentions the field
 * starts with ` * ` and never matches.
 */
const AUTONOMY_LINES = /^([ \t]*autonomy_level:[ \t]*)'[a-z]+'(,[ \t]*)$/gm

/**
 * Rewrite a manifest's autonomy to `autonomous`, so an unattended advance runs
 * it. Exactly one matching line or a throw: none means the flip would silently
 * do nothing, and two means it cannot know which one the object uses.
 */
export function flipAutonomy(text: string): string {
  const found = text.match(AUTONOMY_LINES)?.length ?? 0
  if (found !== 1) {
    throw new Error(`flipAutonomy: expected exactly one autonomy_level line in the manifest object, found ${found}`)
  }
  return text.replace(AUTONOMY_LINES, "$1'autonomous'$2")
}

/** Refuse unless `flipped` is `live` with at most its one autonomy line changed, to `autonomous`. */
function assertOneLineFlip(name: string, path: string, live: string, flipped: string): void {
  const a = live.split('\n')
  const b = flipped.split('\n')
  const differing = a.flatMap((line, i) => (line === b[i] ? [] : [i]))
  const anchored = new RegExp(AUTONOMY_LINES.source)
  const ok =
    a.length === b.length &&
    differing.length <= 1 &&
    differing.every((i) => anchored.test(a[i]!) && anchored.test(b[i]!)) &&
    // Idempotent only when the one line already reads `autonomous`.
    flipAutonomy(flipped) === flipped
  if (!ok) {
    throw new Error(`takeSnapshot: the snapshot manifest of '${name}' at ${path} is not its live manifest with one autonomy line flipped`)
  }
}

/**
 * Copy every configured entry into a fresh snapshot directory, once, flip each
 * configured manifest there to `autonomous`, and return the tree's digest.
 *
 * The only function in this mode that reads a live source, and it only reads.
 * Every arm is seeded from the snapshot afterwards, so the fleet can change or
 * run while a set is in progress without any arm seeing it.
 */
export async function takeSnapshot(config: PrivateConfig): Promise<string> {
  const dir = config.snapshot.dir
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    throw new Error(`takeSnapshot: '${dir}' is not empty — a snapshot is taken once, and a second copy would bind a different fleet to the same set`)
  }
  for (const entry of config.entries) {
    if (!existsSync(entry.from)) throw new Error(`takeSnapshot: entry '${entry.to}' has no source — expected ${entry.from}`)
    const destination = join(dir, entry.to)
    await mkdir(dirname(destination), { recursive: true })
    await cp(entry.from, destination, { recursive: true })
  }
  for (const name of config.plugins) {
    const rel = `${config.fleetDir}/plugins/${name}/manifest.ts`
    const snapshotPath = join(dir, rel)
    const source = config.entries.find((entry) => within(rel, entry.to))
    if (!source || !existsSync(snapshotPath)) {
      throw new Error(`takeSnapshot: configured plugin '${name}' is absent from the snapshot — expected ${snapshotPath}`)
    }
    const live = await readFile(join(source.from, rel.slice(source.to.length)), 'utf8')
    await writeFile(snapshotPath, flipAutonomy(live))
    assertOneLineFlip(name, snapshotPath, live, await readFile(snapshotPath, 'utf8'))
  }
  return treeDigest(dir)
}

/** The plugin root inside an arm home. */
export function privatePluginsDir(home: string, config: PrivateConfig): string {
  return join(home, config.fleetDir, 'plugins')
}

/** The warpline home inside an arm home: a sibling of the fleet dir, never the arm home itself. */
export function privateWarplineHome(home: string, config: PrivateConfig): string {
  return join(home, config.warplineHomeDir)
}

/** Refuse unless every configured plugin is a directory under the plugin root of `root`. */
export function assertPluginsPresent(root: string, config: PrivateConfig): void {
  for (const name of config.plugins) {
    const path = join(privatePluginsDir(root, config), name)
    if (!existsSync(path) || !statSync(path).isDirectory()) {
      throw new Error(`configured plugin '${name}' is absent from the plugin root — expected a directory at ${path}`)
    }
  }
}

/** Copy one snapshot path into a home. The snapshot is the only source a seed ever reads. */
async function placeFromSnapshot(home: string, config: PrivateConfig, to: string): Promise<void> {
  const source = join(config.snapshot.dir, to)
  if (!existsSync(source)) {
    throw new Error(`the snapshot has no '${to}' — expected ${source}; seed only from a snapshot taken with this config`)
  }
  const destination = join(home, to)
  await mkdir(dirname(destination), { recursive: true })
  await cp(source, destination, { recursive: true })
}

/** What a seeded warpline home may hold. Engine state or runs seeded here would be a warm start. */
const WARPLINE_HOME_SEEDS = new Set(['preferences.json', 'config', '.session-approval'])

/**
 * Seed the warpline arm's home and return its warpline home.
 *
 * The fleet layout is mirrored from the snapshot, `node_modules/warpline` in
 * the fleet dir points at this checkout so there is one engine module instance,
 * and each configured package points at the fleet's installed copy. The
 * warpline home is a sibling directory, so the engine's state and runs never
 * land inside the fleet dir a handler reads. The loaded plugin set must EQUAL
 * the configured one: an extra directory is a plugin the method never named.
 */
export async function seedPrivateHome(home: string, config: PrivateConfig): Promise<string> {
  for (const entry of config.entries) await placeFromSnapshot(home, config, entry.to)

  const modules = join(home, config.fleetDir, 'node_modules')
  await mkdir(modules, { recursive: true })
  await symlink(REPO_ROOT, join(modules, 'warpline'), 'dir')
  for (const pkg of config.links.packages) {
    const source = join(config.links.from, pkg)
    if (!existsSync(source)) throw new Error(`the linked package '${pkg}' is absent from the fleet install — expected ${source}`)
    await mkdir(dirname(join(modules, pkg)), { recursive: true })
    await symlink(source, join(modules, pkg), 'dir')
  }

  const wh = privateWarplineHome(home, config)
  await mkdir(wh, { recursive: true })
  await writeSessionGrant(wh)
  await mkdir(join(home, GRADED_DIR), { recursive: true })

  assertPluginsPresent(home, config)
  const { manifests, failures, root_error } = await loadPluginManifests(privatePluginsDir(home, config))
  const loaded = [...manifests.keys()].sort()
  const configured = [...config.plugins].sort()
  if (root_error || failures.length > 0 || loaded.join('\0') !== configured.join('\0')) {
    const failed = failures.map((f) => f.plugin).sort()
    throw new Error(
      `the seeded plugin root loaded [${loaded.join(', ')}] and failed [${failed.join(', ')}] where [${configured.join(', ')}] are configured`,
    )
  }

  const extra = readdirSync(wh).filter((name) => !WARPLINE_HOME_SEEDS.has(name))
  if (extra.length > 0) {
    throw new Error(`the seeded warpline home holds [${extra.sort().join(', ')}] — only preferences.json, config and the session grant are seeded`)
  }
  return wh
}

/** Delete each named variable, so a fleet override cannot point a handler at live state. */
export function scrubEnv(names: readonly string[], env: Record<string, string | undefined> = process.env): void {
  for (const name of names) delete env[name]
}

/**
 * The fleet's own path seam, measured.
 *
 * Imports the fleet's paths module from inside the arm home and resolves each
 * configured export, calling it when it is a function. Every one must land
 * under the arm home. Run after the scrub and after `WARPLINE_HOME` is set: a
 * leftover override or an unset home resolves into live state, and this is the
 * last point where that is a refusal rather than a write.
 */
export async function assertPrivateSeam(home: string, config: PrivateConfig): Promise<void> {
  const path = join(home, config.pathsSeam.module)
  if (!existsSync(path)) throw new Error(`the fleet path seam module is absent from the arm home — expected ${path}`)
  const mod = (await import(pathToFileURL(path).href)) as Record<string, unknown>
  // The module loader reports a file by its real path, so a home under a
  // linked temp dir is accepted under either spelling of the same directory.
  const roots = [...new Set([resolve(home), realpathSync(home)])]
  for (const name of config.pathsSeam.exports) {
    if (!(name in mod)) throw new Error(`the fleet path seam has no export '${name}' in ${path}`)
    const raw = mod[name]
    const value = typeof raw === 'function' ? (raw as () => unknown)() : raw
    if (typeof value !== 'string') throw new Error(`the fleet path seam export '${name}' is not a path string`)
    const at = resolve(value)
    if (!roots.some((root) => at === root || at.startsWith(root + sep))) {
      throw new Error(
        `the fleet path seam resolves export '${name}' to '${value}', outside the arm home '${home}' — a write through it would land in live state`,
      )
    }
  }
}

/**
 * The modification time of each copy-map source that exists in `home`, keyed
 * by the entry's `from`. Taken before an advance, so the copy decision after
 * it can tell a file this advance wrote from one it was handed.
 */
export function copyMapMtimes(home: string, copyMap: PrivateConfig['copyMap']): Map<string, number> {
  const mtimes = new Map<string, number>()
  for (const { from } of copyMap) {
    const source = join(home, from)
    if (existsSync(source)) mtimes.set(from, statSync(source).mtimeMs)
  }
  return mtimes
}

/**
 * Put each mapped deterministic output at its graded path, but only for a
 * plugin the engine's own record says ran in THIS advance and succeeded, and
 * only when the file itself was written during that advance.
 *
 * The run log is not that record. It writes `completed` for every handler that
 * returned without failing, which includes one that skipped itself behind its
 * own gate and wrote nothing. The engine state keeps the handler's own status
 * and the run that wrote it, so a `skipped` plugin, or one this advance never
 * wrote, leaves its graded file absent, and its check fails.
 *
 * A success proves the handler ran, not that it wrote this file. The snapshot
 * carries the previous run's output at the same path, so a handler that
 * succeeds on a no-op path (nothing new, a dedupe hit, an idempotent early
 * return) leaves a stale file that would pass its check. The signal is the
 * file's own timestamp across the advance: `before` is `copyMapMtimes` taken
 * before it, and a source is fresh when it was absent then or its timestamp
 * has moved since. No clock is compared. An equal timestamp withholds credit,
 * so the rule fails closed.
 *
 * The engine state lives under the warpline home the advance just ran in,
 * which is the one `warplineHome()` names until the caller changes it.
 */
export function materializeCopyMap(
  home: string,
  advance: AdvanceResult,
  copyMap: PrivateConfig['copyMap'],
  before: ReadonlyMap<string, number>,
): void {
  const statePath = join(warplineHome(), 'state', 'engine-state.json')
  if (!existsSync(statePath)) return
  const runs = EngineStateSchema.parse(JSON.parse(readFileSync(statePath, 'utf8'))).plugin_runs
  const ran = (plugin: string): boolean => {
    const run = Object.hasOwn(runs, plugin) ? runs[plugin] : undefined
    return run?.run_id === advance.run_id && (run.status === 'success' || run.status === 'partial')
  }
  for (const { plugin, from, to } of copyMap) {
    const source = join(home, from)
    if (!ran(plugin) || !existsSync(source)) continue
    const prior = before.get(from)
    if (prior !== undefined && statSync(source).mtimeMs === prior) continue
    const destination = join(home, to)
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(source, destination)
  }
}

/**
 * Seed one CONTROL arm home from the snapshot: the every-arm data, an empty
 * graded directory, and, for the with-state arm alone, a byte copy of the
 * configured notes.
 *
 * What a control home carries is stated as a property of the method: the same
 * data every arm reads, the directory its deliverables go in, and nothing else.
 * No plugin, no shared code, no package link, no warpline home and no prompt.
 * A control session can read everything in its home, so a home carrying the
 * implementation would be a control arm handed the answer. The config schema
 * refuses an every-arm entry that reaches the plugin root or the warpline home,
 * which is what makes "every-arm" mean "data".
 *
 * Both refusals run BEFORE anything is written, so a refused seed leaves no
 * half-built home behind.
 */
export async function seedPrivateControl(
  home: string,
  arm: 'agent-with-state' | 'agent-from-scratch',
  config: PrivateConfig,
): Promise<void> {
  if (arm !== 'agent-with-state' && arm !== 'agent-from-scratch') {
    throw new ControlSeedError(`arm '${String(arm)}' is not a control arm — it is seeded by seedPrivateHome, and the control recipe would publish a contaminated measurement`)
  }
  if (arm === 'agent-with-state' && !existsSync(config.notes)) {
    throw new ControlSeedError(`arm 'agent-with-state' has no notes source at '${config.notes}' — a with-state run without state is not the arm the method defines`)
  }
  for (const entry of config.entries) {
    if (entry.scope === 'every-arm') await placeFromSnapshot(home, config, entry.to)
  }
  await mkdir(join(home, GRADED_DIR), { recursive: true })
  // A byte COPY and never a link: a link would let a measured run's edits reach the live notes.
  if (arm === 'agent-with-state') await copyFile(config.notes, join(home, NOTES_PATH))
}

/**
 * The commit the private set's engine is pinned to.
 *
 * 0.5.0 was released from the commit tagged `v0.5.0`. This base is the one
 * commit after it, which changes only a JSDoc comment in the runtime source,
 * and `package.json` still reads 0.5.0. So the engine under test is the release
 * plus one comment, and the private pre-registration names that difference.
 * Moving this constant moves what every private record measures, so it moves
 * only on a recorded operator decision.
 */
export const ENGINE_BASE_SHA = '3363c0c136443b2a29cf591e30315dc0ac4c1e43'

/** The package version the private set measures, in this checkout and in the fleet's install. */
export const PINNED_PACKAGE_VERSION = '0.5.0'

/**
 * What counts as the engine: the runtime source, the package manifest and the
 * build config, and not the tests.
 *
 * The test exclusion is the build config's own exclude pattern, and it needs
 * git's `glob` magic to mean the same thing there. Without it git's `**` is two
 * plain wildcards, which cannot match zero directories, so a change under
 * `src/__tests__` itself would stay in the diff and this set's own test commits
 * would refuse it.
 */
export const ENGINE_PATHSPEC = ['src', ':(exclude,glob)src/**/__tests__/**', 'package.json', 'tsconfig.build.json'] as const

const short = (sha: string): string => sha.slice(0, 7)

/**
 * Refuse unless no commit since `base` touches the engine.
 *
 * Exit 1 from the diff is a moved engine. Any other failure, such as a base
 * a shallow clone cannot reach or a mistyped one, is red too and never clean,
 * because a check that could not look has not looked.
 */
export function assertEngineUnchanged(repoRoot: string, base: string = ENGINE_BASE_SHA): void {
  try {
    execFileSync('git', ['diff', '--quiet', '--no-ext-diff', base, 'HEAD', '--', ...ENGINE_PATHSPEC], {
      cwd: repoRoot,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
  } catch (error) {
    if ((error as { status?: number }).status === 1) {
      throw new Error(
        `the engine under test changed since ${short(base)}: a commit after it touches the runtime source, the package manifest or the build config — the private set must run the pinned engine`,
      )
    }
    throw new Error(`could not compare the engine against ${short(base)} — an unreachable base is a refusal, never a pass`, { cause: error })
  }
}

/** The `version` a package manifest declares. */
function manifestVersion(path: string): unknown {
  return (JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }).version
}

/** Refuse unless this checkout's package manifest reads the pinned version. */
export function assertPackageVersion(repoRoot: string, expected: string = PINNED_PACKAGE_VERSION): void {
  const version = manifestVersion(join(repoRoot, 'package.json'))
  if (version !== expected) {
    throw new Error(`package.json reads ${String(version)}, and the private set is pinned to ${expected}`)
  }
}

/**
 * Refuse unless the fleet's installed engine reads the pinned version. The
 * fleet's own handlers import from that install, so a fleet on an older
 * engine is measured on the old engine whatever this checkout says.
 */
export function assertFleetInstall(packageJsonPath: string, expected: string = PINNED_PACKAGE_VERSION): void {
  if (!existsSync(packageJsonPath)) {
    throw new Error(`the fleet install has no package manifest at the configured path — the fleet's engine version cannot be read`)
  }
  const version = manifestVersion(packageJsonPath)
  if (version !== expected) {
    throw new Error(`the fleet install reads ${String(version)}, and the private set is pinned to ${expected} — update the fleet before measuring it`)
  }
}

/**
 * The one prereg commitment a measured set is bound to.
 *
 * Exactly one prereg line and no results line: none means the method is not
 * frozen, two means there is no single method, and a results line means the
 * measured set is closed. The ledger is read from the checkout, so it is the
 * committed ledger only when the tree is clean, which the entry point refuses
 * to start without.
 */
export function readPreregCommitment(repoRoot: string): string {
  const entries = parseCommitments(readFileSync(join(repoRoot, COMMITMENTS_FILE), 'utf8'))
  if (entries.some((entry) => entry.kind === 'results')) {
    throw new Error(`a results commitment already exists in ${COMMITMENTS_FILE} — the measured set is closed`)
  }
  const prereg = entries.filter((entry) => entry.kind === 'prereg')
  if (prereg.length === 0) throw new Error(`no prereg commitment in ${COMMITMENTS_FILE} — the method is not frozen, so no set may start`)
  if (prereg.length > 1) throw new Error(`${COMMITMENTS_FILE} holds ${prereg.length} prereg commitments — a set is bound to exactly one method`)
  return prereg[0]!.hex
}

/**
 * Refuse unless the config records the snapshot's digest and the snapshot on
 * disk still has it. Returns the digest, which every record then carries.
 */
export function assertSnapshotDigest(config: PrivateConfig): string {
  const frozen = config.snapshot.sha256
  if (frozen === undefined) {
    throw new Error('the config records no frozen snapshot digest — take the snapshot once and record its digest before any set')
  }
  const actual = treeDigest(config.snapshot.dir)
  if (actual !== frozen) {
    throw new Error(`the snapshot digests to ${short(actual)} where the config froze ${short(frozen)} — the snapshot changed after it was taken`)
  }
  return actual
}

/** git in `repoRoot`, stdout trimmed, stderr kept off the terminal. */
function git(repoRoot: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** The ledger as committed at `commit`. A commit without the file has an empty ledger. */
function ledgerAt(repoRoot: string, commit: string): CommitmentLine[] {
  let blob: string
  try {
    blob = git(repoRoot, ['rev-parse', '--verify', '--quiet', `${commit}:${COMMITMENTS_FILE}`])
  } catch {
    return []
  }
  return parseCommitments(execFileSync('git', ['cat-file', 'blob', blob], { cwd: repoRoot, encoding: 'utf8' }))
}

/**
 * The freeze commit: the first commit, over full history, whose ledger holds
 * the line `prereg <prereg>`. The ledger is append-only, so that is the commit
 * that introduced it.
 *
 * A shallow clone is refused, because a walk over history it cannot see would
 * name a later commit or none. No commit holding the line is refused too: a
 * line in the checkout that history never recorded has no freeze to bind to.
 */
export function freezeCommit(repoRoot: string, prereg: string): string {
  if (git(repoRoot, ['rev-parse', '--is-shallow-repository']) !== 'false') {
    throw new Error('shallow clone: the freeze commit cannot be found over history this checkout cannot see — a refusal, never a pass')
  }
  const touching = [
    ...new Set(
      git(repoRoot, ['-c', 'log.showSignature=false', 'log', '--full-history', '-m', '--topo-order', '--reverse', '--format=%H', '--', COMMITMENTS_FILE])
        .split('\n')
        .filter(Boolean),
    ),
  ]
  const found = touching.find((c) => ledgerAt(repoRoot, c).some((entry) => entry.kind === 'prereg' && entry.hex === prereg))
  if (found === undefined) throw new Error(`blind: no commit introduces the committed prereg line in ${COMMITMENTS_FILE}`)
  return found
}

/**
 * The digest of what a measured run executes, refused unless `dist/` is a
 * fresh build of this checkout.
 *
 * `warpline` resolves through the package's exports map into the gitignored
 * `dist/`: the arms import it, and so, through the seeded link, do the fleet's
 * handlers. The consumer's skills load from `plugin/`. Neither is seen by the
 * engine diff or the clean-tree check, so the checkout is built again into a
 * temp dir and `dist/` must match it byte for byte. The build emits no source
 * maps, so a build into another dir changes no byte. The digest covers both
 * trees.
 *
 * `build` is a fixture seam. Absent, it is this checkout's own compiler.
 */
export function freshBuildDigest(repoRoot: string, build?: (outDir: string) => void): string {
  const out = mkdtempSync(join(tmpdir(), 'warpline-bench-build-'))
  try {
    try {
      ;(build ??
        ((dir: string) =>
          execFileSync(join(repoRoot, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.build.json', '--outDir', dir], {
            cwd: repoRoot,
            stdio: 'pipe',
          })))(out)
    } catch (error) {
      throw new Error('the checkout could not be built, so what a measured run executes cannot be bound', { cause: error })
    }
    const dist = join(repoRoot, 'dist')
    if (!existsSync(dist) || treeDigest(out) !== treeDigest(dist)) {
      throw new Error('dist/ is not a fresh build of this checkout — run `bun run build` and start again')
    }
    return sha256hex(Buffer.from(`dist ${treeDigest(dist)}\nplugin ${treeDigest(join(repoRoot, 'plugin'))}\n`))
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}

/**
 * The six digests of the method as it stands: the snapshot (refused unless it
 * still has the config's frozen digest), the fresh build, both prompts, the
 * notes, and the parsed config, which binds every check, entry, path and the
 * prereg block itself.
 */
export function methodBindings(config: PrivateConfig, repoRoot: string, build?: (outDir: string) => void): MethodBindings {
  return {
    snapshot_sha256: assertSnapshotDigest(config),
    build_sha256: freshBuildDigest(repoRoot, build),
    agent_prompt_sha256: sha256hex(readFileSync(config.prompts.agent)),
    consumer_prompt_sha256: sha256hex(readFileSync(config.prompts.consumer)),
    notes_sha256: sha256hex(readFileSync(config.notes)),
    config_sha256: sha256hex(Buffer.from(JSON.stringify(config))),
  }
}

/**
 * The method the committed pre-registration states, read only after the
 * configured document and salt re-derive the committed prereg digest, so the
 * gate enforces the frozen document and never an editable stand-in.
 *
 * `check_ids` come from the live config, not from the document, and that is
 * safe. The config is bound by `config_sha256`: the measured gate compares that
 * digest before any check id is used, and every record's `config_sha256` is
 * compared with the document's at summary, so an edited config fails closed.
 * It never widens what counts.
 */
export function readFrozenMethod(config: PrivateConfig, repoRoot: string): FrozenMethod {
  const hex = readPreregCommitment(repoRoot)
  if (config.prereg === undefined) {
    throw new Error('the config names no private pre-registration (prereg), so the frozen method cannot be read')
  }
  const doc = readFileSync(config.prereg.doc)
  if (commitment(readFileSync(config.prereg.salt), doc) !== hex) {
    throw new Error('the configured pre-registration does not reproduce the committed prereg commitment, so it is not the document that was frozen')
  }
  return {
    ...parseBindings(doc.toString('utf8')),
    prereg_commitment: hex,
    freeze_commit: freezeCommit(repoRoot, hex),
    check_ids: config.checks.map((check) => check.id),
  }
}

/**
 * Every precondition of a private set, checked before the first spend, in a
 * pinned order:
 *
 *   1. every configured plugin is in the snapshot;
 *   2. the snapshot has its frozen digest;
 *   3. this checkout's package version;
 *   4. the engine unchanged since the pinned base;
 *   5. the fleet install's version;
 *   6. exactly one prereg commitment, when the set is a measured one;
 *   7. the configured pre-registration reproduces it, and its bindings are read;
 *   8. HEAD is the commit that froze it;
 *   9. every input digests to its frozen value, the fresh build included.
 *
 * Plugin presence is first because a missing plugin also changes the digest,
 * and the operator must be told which plugin, not that a hash moved.
 *
 * `engineBase` and `build` are fixture seams: a fixture repository cannot
 * contain the pinned commit, and builds without a compiler. The private entry
 * point never passes either.
 */
export function assertPrivatePreconditions(
  config: PrivateConfig,
  repoRoot: string,
  options: { requirePrereg: true; engineBase?: string; build?: (outDir: string) => void },
): FrozenMethod
export function assertPrivatePreconditions(
  config: PrivateConfig,
  repoRoot: string,
  options: { requirePrereg: false; engineBase?: string; build?: (outDir: string) => void },
): PrivateStamp
export function assertPrivatePreconditions(
  config: PrivateConfig,
  repoRoot: string,
  options: { requirePrereg: boolean; engineBase?: string; build?: (outDir: string) => void },
): PrivateStamp | FrozenMethod
export function assertPrivatePreconditions(
  config: PrivateConfig,
  repoRoot: string,
  options: { requirePrereg: boolean; engineBase?: string; build?: (outDir: string) => void },
): PrivateStamp | FrozenMethod {
  assertPluginsPresent(config.snapshot.dir, config)
  const snapshot_sha256 = assertSnapshotDigest(config)
  assertPackageVersion(repoRoot)
  assertEngineUnchanged(repoRoot, options.engineBase)
  assertFleetInstall(config.fleetInstall)
  if (!options.requirePrereg) return { snapshot_sha256 }

  const frozen = readFrozenMethod(config, repoRoot)
  const head = git(repoRoot, ['rev-parse', 'HEAD'])
  if (head !== frozen.freeze_commit) {
    throw new Error(
      `HEAD is ${short(head)} where the method was frozen at ${short(frozen.freeze_commit)} — a measured set runs the freeze commit and nothing after it`,
    )
  }
  const now = methodBindings(config, repoRoot, options.build)
  for (const key of BIND_KEYS) {
    if (now[key] !== frozen[key]) {
      throw new Error(`${key} is ${short(now[key])} where the method froze ${short(frozen[key])} — that input moved after the freeze`)
    }
  }
  return frozen
}
