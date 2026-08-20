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
import { mkdtempSync, existsSync, lstatSync, readlinkSync, mkdirSync, symlinkSync } from 'node:fs'
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scaffoldPlugin } from '../scaffold.js'
import { _setHome, pluginsDir } from '../../lib/paths.js'

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

  test('handler.ts imports both schema types by package specifier and its sibling with .ts', async () => {
    freshHome()
    await scaffoldPlugin('demo')
    const { handler } = await generated('demo')
    const specs = specifiers(handler)
    expect(specs).toContain('warpline/schemas/plugin-manifest')
    expect(specs).toContain('warpline/schemas/skill-result')
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

    const result = await scaffoldPlugin('demo')
    expect(result.created).toBe(false)
    expect(result.message).toContain('already exists')
    expect(await readFile(join(dir, 'manifest.ts'), 'utf8')).toBe('PRIOR ART')
    expect(existsSync(join(dir, 'handler.ts'))).toBe(false)
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
