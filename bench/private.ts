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
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { copyFile, cp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AdvanceResult } from 'warpline'
import { RunLogSchema } from 'warpline/schemas/run-log'
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
 * What binds a private record to its input and its method: the snapshot digest
 * always, and the prereg commitment whenever the set is a measured one.
 */
export interface PrivateStamp {
  snapshot_sha256: string
  prereg_commitment?: string
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
 * Put each mapped deterministic output at its graded path, but only for a
 * plugin THIS advance's run log records as `completed`. The snapshot carries
 * the fleet's previous outputs, so a file that merely exists may be stale, and
 * grading it would credit this run with work it did not do.
 */
export function materializeCopyMap(home: string, advance: AdvanceResult, copyMap: PrivateConfig['copyMap']): void {
  const log = RunLogSchema.parse(JSON.parse(readFileSync(advance.run_log_path, 'utf8')))
  const completed = new Set(log.plugin_entries.filter((entry) => entry.status === 'completed').map((entry) => entry.plugin))
  for (const { plugin, from, to } of copyMap) {
    const source = join(home, from)
    if (!completed.has(plugin) || !existsSync(source)) continue
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
