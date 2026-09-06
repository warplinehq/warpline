/**
 * Scaffold tests — the generated plugin's import specifiers are the contract.
 *
 * These assert on the BYTES scaffold writes, not on whether they import here.
 * The checkout can always resolve warpline's own source; a generated plugin
 * living under <warplineHome>/plugins cannot. That gap is why the two defects
 * this file guards survived a green suite:
 *
 *   1. an absolute filesystem path baked into every generated import
 *   2. a `./manifest.js` specifier pointing at a `.ts` file — fine under Bun,
 *      ERR_MODULE_NOT_FOUND under Node (RESEARCH probes A5/A6)
 *
 * The end-to-end proof (an installed tarball, Node importing the generated
 * files for real) lives in `scripts/verify-tarball.sh`, which is the only
 * place the bug reproduces. Keep both: this file fails fast, that script
 * fails honestly.
 */
import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, existsSync, lstatSync, readlinkSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs'
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scaffoldPlugin } from '../scaffold.js'
import { main } from '../warpline.js'
import { _setHome, pluginsDir } from '../../lib/paths.js'
import { PluginManifestSchema } from '../../schemas/plugin-manifest.js'
import { SkillResultSchema } from '../../schemas/skill-result.js'
import type { CapabilityContext } from '../../runtime/capabilities.js'
import type { CapabilityHandlerFn } from '../../runtime/invoke-plugin.js'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')

/**
 * The one handler declaration form: a const annotated with the published
 * four-parameter type, parameters inferred from it. Unused parameters may
 * carry an underscore prefix; the form is the same either way.
 */
const DECLARATION = /^export const handler: CapabilityHandlerFn = async \(_?manifest, _?args, _?signal, _?capabilities\) =>/m

const homes: string[] = []

/** A fresh throwaway home, wired into the path accessors via the _setHome seam. */
function freshHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'warpline-scaffold-'))
  homes.push(root)
  _setHome(root)
  return root
}

afterEach(async () => {
  _setHome(null)
  for (const home of homes.splice(0)) {
    await rm(home, { recursive: true, force: true })
  }
})

/** Every `from '<specifier>'` in a source string. */
function specifiers(source: string): string[] {
  return [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1] as string)
}

async function generated(name: string): Promise<{ manifest: string; handler: string }> {
  const dir = join(pluginsDir(), name)
  return {
    manifest: await readFile(join(dir, 'manifest.ts'), 'utf8'),
    handler: await readFile(join(dir, 'handler.ts'), 'utf8'),
  }
}

/** Every file directly under `dir`, name to bytes. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const names = (await readdir(dir)).sort()
  const entries = await Promise.all(names.map(async (f) => [f, await readFile(join(dir, f), 'utf8')] as const))
  return Object.fromEntries(entries)
}

describe('scaffoldPlugin — generated specifiers', () => {
  test('writes both files and bakes no absolute path into any import', async () => {
    freshHome()
    const result = await scaffoldPlugin('demo')
    expect(result.created).toBe(true)

    const { manifest, handler } = await generated('demo')
    const all = [...specifiers(manifest), ...specifiers(handler)]
    expect(all.length).toBeGreaterThan(0)
    expect(all.filter((s) => s.startsWith('/'))).toEqual([])
    // Belt and braces: no absolute path anywhere in the emitted text, even
    // outside an import (the old SCHEMAS_DIR leaked into three of them).
    expect(manifest + handler).not.toContain(process.cwd())
    expect(manifest + handler).not.toContain(tmpdir())
  })

  test('manifest.ts imports the schema by package specifier', async () => {
    freshHome()
    await scaffoldPlugin('demo')
    const { manifest } = await generated('demo')
    expect(specifiers(manifest)).toContain('warpline/schemas/plugin-manifest')
  })

  test('handler.ts imports the schema types, the handler type and the builders by package specifier, and its sibling with .ts', async () => {
    freshHome()
    await scaffoldPlugin('demo')
    const { handler } = await generated('demo')
    const specs = specifiers(handler)
    expect(specs).toContain('warpline/schemas/plugin-manifest')
    expect(specs).toContain('warpline/schemas/skill-result')
    expect(specs).toContain('warpline/unstable-capabilities')
    expect(specs).toContain('warpline/unstable-result')
    // `.ts`, never `.js`: Node's type stripping resolves the literal
    // specifier with no extension remapping.
    expect(specs).toContain('./manifest.ts')
    expect(specs).not.toContain('./manifest.js')
    expect(specs).not.toContain('./manifest')
  })

  test('refuses to overwrite an existing plugin directory, byte for byte', async () => {
    freshHome()
    const dir = join(pluginsDir(), 'demo')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'manifest.ts'), 'PRIOR ART')
    const before = await snapshot(dir)

    const result = await scaffoldPlugin('demo')
    expect(result.created).toBe(false)
    expect(result.message).toContain('already exists')
    expect(await readFile(join(dir, 'manifest.ts'), 'utf8')).toBe('PRIOR ART')
    expect(existsSync(join(dir, 'handler.ts'))).toBe(false)
    // The whole directory, not the one file: a partial overwrite that left
    // manifest.ts alone and wrote something else would pass the line above.
    expect(await snapshot(dir)).toEqual(before)
  })

  test.each([
    ['Demo', 'uppercase'],
    ['1demo', 'leading digit'],
    ['../escape', 'traversal'],
    ['de mo', 'whitespace'],
    ['demo.plugin', 'dot'],
    ['', 'empty'],
  ])('rejects the invalid name %p (%s) and writes nothing', async (name) => {
    const home = freshHome()
    const result = await scaffoldPlugin(name)
    expect(result.created).toBe(false)
    expect(result.path).toBe('')
    expect(result.message).toContain('Invalid plugin name')
    expect(existsSync(join(home, 'plugins'))).toBe(false)
  })
})

// ── The emitted plugin matches the published handler contract ────────────
//
// The scaffold is what a second author copies, so what it emits IS the
// authoring guidance. Three places answer "how do I declare a handler" — the
// guide, this template and the pinned `anomaly-issue` example — and the last
// two cases below hold them to one answer.
describe('scaffoldPlugin — the emitted plugin matches the published handler contract', () => {
  test('handler.ts declares four parameters typed by a type-only CapabilityHandlerFn import', async () => {
    freshHome()
    await scaffoldPlugin('demo')
    const { handler } = await generated('demo')
    // Type-only: `warpline/unstable-capabilities` carries no runtime value,
    // and the tarball gate asserts that set is empty.
    expect(handler).toContain("import type { CapabilityHandlerFn } from 'warpline/unstable-capabilities'")
    expect(handler).toMatch(DECLARATION)
    expect(handler).not.toContain('export async function handler')
  })

  test('handler.ts writes no schema_version of its own and builds its result', async () => {
    freshHome()
    await scaffoldPlugin('demo')
    const { handler } = await generated('demo')
    expect(handler).not.toContain('schema_version')
    expect(specifiers(handler)).toContain('warpline/unstable-result')
  })

  test('manifest.ts declares at least one input, each with a type, a description and a default', async () => {
    freshHome()
    await scaffoldPlugin('demo')
    // Imported for real from the temp home: the `<home>/node_modules/warpline`
    // symlink is what resolves its `warpline/schemas/*` specifier, exactly as
    // it would for an author. Parsed again here so the shape assertion runs
    // against this checkout's schema, not only the one behind the symlink.
    const mod = (await import(join(pluginsDir(), 'demo', 'manifest.ts'))) as { manifest: unknown }
    const manifest = PluginManifestSchema.parse(mod.manifest)
    const inputs = Object.entries(manifest.inputs)
    expect(inputs.length).toBeGreaterThan(0)
    for (const [, input] of inputs) {
      expect(['string', 'number', 'boolean', 'array', 'object']).toContain(input.type)
      expect(typeof input.description).toBe('string')
      expect(input.default).toBeDefined()
    }
  })

  test('the emitted pair loads and runs as a unit: the manifest parses, the handler is typed CapabilityHandlerFn, and its result passes the boundary', async () => {
    freshHome()
    await scaffoldPlugin('demo')
    const dir = join(pluginsDir(), 'demo')
    const { handler: handlerSource } = await generated('demo')
    // The declared type NAME, from the text: a type leaves no trace in the
    // loaded module, so the annotation is only checkable as bytes here. The
    // annotation's reachability from a global install is the tarball gate's
    // job (checks 5 and 6), not this file's.
    expect(handlerSource).toMatch(/^export const handler: CapabilityHandlerFn = /m)

    const { manifest } = (await import(join(dir, 'manifest.ts'))) as { manifest: unknown }
    const parsed = PluginManifestSchema.parse(manifest)
    const { handler } = (await import(join(dir, 'handler.ts'))) as { handler: CapabilityHandlerFn }
    // Tier 1 of the resolution order: every declared input at its default,
    // which is what the runtime hands a plugin nobody has configured yet.
    const args = Object.fromEntries(Object.entries(parsed.inputs).map(([k, v]) => [k, v.default]))
    const result = SkillResultSchema.parse(await handler(parsed, args, new AbortController().signal, {} as CapabilityContext))
    expect(result.status).toBe('success')
    expect(result.phases_completed).toEqual(['demo'])
    // The schema's own default, because the handler wrote no version field.
    expect(result.schema_version).toBe(2)
  })

  test('the authoring guide shows one declaration form, and it is the one the scaffold emits', async () => {
    freshHome()
    await scaffoldPlugin('demo')
    const { handler } = await generated('demo')
    const doc = await readFile(join(REPO_ROOT, 'docs', 'plugin-authoring.md'), 'utf8')
    expect(doc).not.toContain('export async function handler')
    const declarations = doc.match(/^export const handler:.*$/gm) ?? []
    expect(declarations.length).toBeGreaterThan(0)
    for (const line of declarations) expect(line).toMatch(DECLARATION)
    expect(handler).toMatch(DECLARATION)
  })

  test('the pinned example uses the same form and no longer carries the bare satisfies clause', async () => {
    const example = await readFile(join(REPO_ROOT, 'examples', 'plugins', 'anomaly-issue', 'handler.ts'), 'utf8')
    expect(example).not.toContain('satisfies HandlerFn')
    expect(example).toMatch(DECLARATION)
  })
})

describe('scaffoldPlugin — the home-level warpline symlink', () => {
  const linkPath = (home: string) => join(home, 'node_modules', 'warpline')

  test('creates a symlink at <home>/node_modules/warpline', async () => {
    const home = freshHome()
    await scaffoldPlugin('demo')
    const link = linkPath(home)
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    // It must point at a real directory holding warpline's package.json —
    // that is what makes `warpline/schemas/*` resolvable from the plugin.
    expect(existsSync(join(link, 'package.json'))).toBe(true)
  })

  test('is idempotent — a second scaffold leaves the same target', async () => {
    const home = freshHome()
    await scaffoldPlugin('one')
    const first = readlinkSync(linkPath(home))
    const second = await scaffoldPlugin('two')
    expect(second.created).toBe(true)
    expect(readlinkSync(linkPath(home))).toBe(first)
  })

  test('heals a dangling symlink instead of throwing', async () => {
    const home = freshHome()
    mkdirSync(join(home, 'node_modules'), { recursive: true })
    symlinkSync(join(home, 'nowhere-at-all'), linkPath(home))
    expect(existsSync(linkPath(home))).toBe(false) // dangling: existsSync follows

    const result = await scaffoldPlugin('demo')
    expect(result.created).toBe(true)
    expect(lstatSync(linkPath(home)).isSymbolicLink()).toBe(true)
    expect(existsSync(join(linkPath(home), 'package.json'))).toBe(true)
  })

  test('never replaces a real directory at that path, and says so', async () => {
    const home = freshHome()
    const link = linkPath(home)
    mkdirSync(link, { recursive: true })
    await writeFile(join(link, 'marker.txt'), 'operator content')

    const result = await scaffoldPlugin('demo')
    expect(result.created).toBe(true)
    expect(lstatSync(link).isSymbolicLink()).toBe(false)
    expect(lstatSync(link).isDirectory()).toBe(true)
    expect(await readFile(join(link, 'marker.txt'), 'utf8')).toBe('operator content')
    expect(result.message).toContain('not replaced')
  })
})

// ── The home-level ESM marker ────────────────────────────────────────────
//
// A scaffolded plugin is ESM. Node decides CJS-vs-ESM for a stripped .ts file
// from the nearest package.json, so without `"type": "module"` at the home it
// loads the manifest as CommonJS and dies on `Cannot use import statement
// outside a module` — at import, which the engine reports as a load failure,
// so `warpline plan` computes no plan at all.
//
// Bun assumes ESM and never reproduces this, so the assertions below check the
// marker rather than the symptom; the real Node import lives in
// scripts/verify-tarball.sh, which is the only place the symptom is visible.
describe('scaffoldPlugin — the home-level ESM marker', () => {
  test('writes package.json with type: module when the home has none', async () => {
    const home = freshHome()
    await scaffoldPlugin('my-plugin')

    const parsed = JSON.parse(await readFile(join(home, 'package.json'), 'utf8'))
    expect(parsed.type).toBe('module')
  })

  test('leaves an existing correct package.json alone and warns about nothing', async () => {
    const home = freshHome()
    const existing = JSON.stringify({ name: 'my-project', type: 'module' }, null, 2)
    await writeFile(join(home, 'package.json'), existing)

    const result = await scaffoldPlugin('my-plugin')

    expect(await readFile(join(home, 'package.json'), 'utf8')).toBe(existing)
    expect(result.message).not.toContain('⚠')
  })

  test('warns instead of overwriting when an existing package.json is not ESM', async () => {
    const home = freshHome()
    const existing = JSON.stringify({ name: 'my-project' }, null, 2)
    await writeFile(join(home, 'package.json'), existing)

    const result = await scaffoldPlugin('my-plugin')

    // Never clobber a real project manifest that happens to sit at the home.
    expect(await readFile(join(home, 'package.json'), 'utf8')).toBe(existing)
    expect(result.message).toContain('"type": "module"')
    expect(result.created).toBe(true)
  })

  test('a malformed package.json warns rather than throwing', async () => {
    const home = freshHome()
    await writeFile(join(home, 'package.json'), '{ not json')

    const result = await scaffoldPlugin('my-plugin')

    expect(result.created).toBe(true)
    expect(result.message).toContain('not valid JSON')
  })
})

// ── scaffold --from <example>: a copy of a shipped example ────────────────
//
// One code path with two sources. The same home preparation, the same name
// guard and the same directory creation run; only the file contents differ.
// The source is the package's own shipped `examples/plugins/` tree, so the
// registry is `package.json`'s `files` entry and nothing else: no remote
// registry, no verb that installs rather than copies, and no record anywhere
// of which copies exist. The copy diverges from day one, and that is the point.
//
// Two entry points reach scaffold, the dispatcher arm and this module's own
// `import.meta.main` tail, and both must honour the flag or one of them
// silently scaffolds the template for an author who asked for an example.

/** Run a CLI entry point with stdout/stderr captured, originals always restored. */
async function captured(fn: () => Promise<number>): Promise<{ code: number; stdout: string; stderr: string }> {
  const realOut = process.stdout.write
  const realErr = process.stderr.write
  let stdout = ''
  let stderr = ''
  process.stdout.write = ((chunk: string) => {
    stdout += chunk
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string) => {
    stderr += chunk
    return true
  }) as typeof process.stderr.write
  try {
    return { code: await fn(), stdout, stderr }
  } finally {
    process.stdout.write = realOut
    process.stderr.write = realErr
  }
}

const viaDispatcher = (argv: string[]) => captured(() => main(argv))

/**
 * The subcommand's own `run`, reached dynamically so a missing export is a
 * failed assertion in the case that needs it rather than a load failure that
 * takes the whole file down with it.
 */
async function scaffoldRun(): Promise<(argv: string[]) => Promise<number>> {
  const mod = (await import('../scaffold.js')) as { run?: unknown }
  expect(typeof mod.run).toBe('function')
  return mod.run as (argv: string[]) => Promise<number>
}

const EXAMPLE = join(REPO_ROOT, 'examples', 'plugins', 'anomaly-watch')

/** The specifier set the built-in template emits; the default path must not drift from it. */
const TEMPLATE_HANDLER_SPECIFIERS = [
  'warpline/schemas/plugin-manifest',
  'warpline/schemas/skill-result',
  'warpline/unstable-capabilities',
  'warpline/unstable-result',
  './manifest.ts',
]

describe('scaffold --from <example>', () => {
  test('copies the shipped example into the home with only the manifest name rewritten, and reaches nothing else', async () => {
    const home = freshHome()
    // A copy from the shipped tree has no reason to touch the network; a
    // fetch during it is a registry sneaking in.
    const realFetch = globalThis.fetch
    globalThis.fetch = (() => {
      throw new Error('scaffold --from must not reach the network')
    }) as unknown as typeof fetch
    let code: number
    try {
      ;({ code } = await viaDispatcher(['scaffold', 'my-copy', '--from', 'anomaly-watch']))
    } finally {
      globalThis.fetch = realFetch
    }
    expect(code).toBe(0)

    const dir = join(pluginsDir(), 'my-copy')
    const copy = await snapshot(dir)
    const source = await snapshot(EXAMPLE)
    expect(Object.keys(copy)).toEqual(Object.keys(source))
    expect(copy['handler.ts']).toBe(source['handler.ts'])
    expect(copy['handler.test.ts']).toBe(source['handler.test.ts'])
    // The one rewrite: the manifest's name, so the loader keys the copy on it
    // and the config path derives from it. Nothing else moves.
    expect(copy['manifest.ts']).toBe(source['manifest.ts'].replace("name: 'anomaly-watch'", "name: 'my-copy'"))
    const mod = (await import(join(dir, 'manifest.ts'))) as { manifest: unknown }
    expect(PluginManifestSchema.parse(mod.manifest).name).toBe('my-copy')

    // No manifest of copies and no registry file: the home holds exactly what
    // the home preparation and the copy wrote, and the plugins dir holds one entry.
    expect(readdirSync(home).sort()).toEqual(['node_modules', 'package.json', 'plugins'])
    expect(readdirSync(join(home, 'plugins'))).toEqual(['my-copy'])
  })

  test('refuses a --from that is not a shipped example, names the available ones, and creates nothing, not even the home', async () => {
    const home = freshHome()
    const { code, stdout, stderr } = await viaDispatcher(['scaffold', 'my-copy', '--from', 'does-not-exist'])
    expect(code).toBe(1)
    expect(stdout + stderr).toContain('--from')
    expect(stdout + stderr).toContain('anomaly-watch')
    expect(existsSync(join(home, 'plugins', 'my-copy'))).toBe(false)
    // Nothing at all: a refused source is decided before the home is prepared,
    // so the symlink and the ESM marker are not written either.
    expect(readdirSync(home)).toEqual([])
  })

  test.each([
    ['../../etc', 'traversal'],
    ['anomaly-watch/handler.ts', 'separator'],
    ['anomaly.watch', 'dot'],
    ['Anomaly-Watch', 'uppercase'],
    ['', 'empty'],
  ])('refuses the --from value %p (%s) on the same name guard as the plugin name, before any filesystem access', async (from) => {
    const home = freshHome()
    const run = await scaffoldRun()
    const { code, stdout, stderr } = await captured(() => run(['my-copy', '--from', from]))
    expect(code).toBe(1)
    expect(stdout + stderr).toContain('--from')
    expect(readdirSync(home)).toEqual([])
  })

  test('with no --from, the dispatcher path emits the built-in template byte for byte, with the pinned specifier set', async () => {
    const a = freshHome()
    expect((await viaDispatcher(['scaffold', 'demo'])).code).toBe(0)
    const viaMain = await snapshot(join(a, 'plugins', 'demo'))

    const b = freshHome()
    expect((await scaffoldPlugin('demo')).created).toBe(true)
    expect(await snapshot(join(b, 'plugins', 'demo'))).toEqual(viaMain)

    expect(Object.keys(viaMain)).toEqual(['handler.ts', 'manifest.ts'])
    expect(specifiers(viaMain['handler.ts'])).toEqual(TEMPLATE_HANDLER_SPECIFIERS)
    expect(specifiers(viaMain['manifest.ts'])).toEqual(['warpline/schemas/plugin-manifest'])
  })

  test('both entry points honour the flag: the dispatcher arm and run() write the same directory', async () => {
    const a = freshHome()
    expect((await viaDispatcher(['scaffold', 'my-copy', '--from', 'anomaly-watch'])).code).toBe(0)
    const viaMain = await snapshot(join(a, 'plugins', 'my-copy'))

    const b = freshHome()
    const run = await scaffoldRun()
    expect((await captured(() => run(['my-copy', '--from', 'anomaly-watch']))).code).toBe(0)
    expect(await snapshot(join(b, 'plugins', 'my-copy'))).toEqual(viaMain)
    expect(Object.keys(viaMain)).toContain('handler.test.ts')
  })

  test('the import.meta.main tail and the dispatcher arm both go through run(), so neither can drop a flag', async () => {
    // Structural, because the tail only executes as a process entry and the
    // repository budgets itself to one spawning test file.
    const source = await readFile(join(REPO_ROOT, 'src', 'cli', 'scaffold.ts'), 'utf8')
    const tail = source.slice(source.indexOf('import.meta.main'))
    expect(tail).toMatch(/\brun\(/)
    expect(tail).not.toContain('process.argv[2]')

    const dispatcher = await readFile(join(REPO_ROOT, 'src', 'cli', 'warpline.ts'), 'utf8')
    const arm = dispatcher.slice(dispatcher.indexOf("case 'scaffold':"), dispatcher.indexOf("case 'run':"))
    expect(arm).toContain('return await run(rest)')
    expect(arm).not.toContain('scaffoldPlugin(')
  })

  test('an unknown flag and a missing name are usage errors that write nothing', async () => {
    const home = freshHome()
    const run = await scaffoldRun()
    const bogus = await captured(() => run(['my-copy', '--bogus']))
    expect(bogus.code).toBe(1)
    expect(bogus.stderr).toContain('Usage: warpline scaffold')
    expect((await captured(() => run([]))).code).toBe(1)
    expect((await captured(() => run(['one', 'two']))).code).toBe(1)
    expect(readdirSync(home)).toEqual([])
  })
})
