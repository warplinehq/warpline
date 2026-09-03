/**
 * The plugin-root side-effect screen must actually go red.
 *
 * This exists because the screen's first implementation did NOT work and looked
 * like it did. It assigned to ESM module namespace objects inside a try/catch;
 * every assignment threw (a namespace's [[Set]] always fails under strict mode,
 * despite the property reporting `writable: true`) and the catch swallowed it.
 * The dirty fixtures still came back red — via Node's permission model, an
 * entirely different layer — so the output looked correct while the mechanism
 * the file described was absent. A screen nobody has watched fail is not a
 * screen, and one whose red comes from a layer other than the one it claims is
 * worse than none.
 *
 * The named-import case is the one that matters most, because a guard blind to
 * some import forms is a defect this repository has already shipped once. Note
 * what this test does NOT claim: removing `syncBuiltinESMExports()` from the
 * child does not fail it. That was checked by disabling every one of those
 * calls — the fixtures stayed red, because Node 24's ESM named bindings for
 * builtins are live views of the CJS object the child patches. The claim here
 * is only that the named form is detected, not which layer detects it.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const SCREEN = join(import.meta.dir, '..', '..', 'scripts', 'screen-plugin-root.mjs')

let root: string

async function plugin(name: string, source: string): Promise<void> {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'manifest.ts'), source)
}

/** Run the screen; it exits non-zero on any dirty or unscreenable manifest. */
async function runScreen(): Promise<{ code: number; out: string }> {
  try {
    const { stdout } = await execFileAsync(process.execPath, [SCREEN, root, '--json'], {
      maxBuffer: 8 * 1024 * 1024,
    })
    return { code: 0, out: stdout }
  } catch (err) {
    const e = err as { code?: number; stdout?: string }
    return { code: e.code ?? -1, out: e.stdout ?? '' }
  }
}

function verdictFor(out: string, name: string): string {
  const parsed = JSON.parse(out) as { results: Array<{ name: string; verdict: string }> }
  return parsed.results.find((r) => r.name === name)?.verdict ?? '(absent)'
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'warpline-screen-test-'))
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('screen-plugin-root', () => {
  test('a declarative manifest screens clean and a write through a NAMED import screens dirty', async () => {
    await plugin('clean-one', `export const manifest = { name: 'clean-one' }\n`)
    await plugin(
      'dirty-named',
      // The form that only `syncBuiltinESMExports()` reaches. If that call is
      // removed, this manifest screens clean and the test fails here.
      `import { writeFileSync } from 'node:fs'\n` +
        `writeFileSync('${join(root, 'should-not-exist.txt')}', 'x')\n` +
        `export const manifest = { name: 'dirty-named' }\n`,
    )

    const { code, out } = await runScreen()

    expect(verdictFor(out, 'clean-one')).toBe('declarative')
    expect(verdictFor(out, 'dirty-named')).toBe('dirty')
    // Non-zero, so the screen can gate something rather than merely narrate.
    expect(code).not.toBe(0)
  }, 60_000)

  test('a manifest that swallows the permission denial is still reported', async () => {
    // Prevention is not detection. The permission model stops the write either
    // way; a screen that reported this one clean would be describing the
    // machine it ran on rather than what the manifest would do in production,
    // where there is no permission model.
    await plugin(
      'dirty-swallowed',
      `import { writeFileSync } from 'node:fs'\n` +
        `try { writeFileSync('${join(root, 'nope.txt')}', 'x') } catch {}\n` +
        `export const manifest = { name: 'dirty-swallowed' }\n`,
    )

    const { out } = await runScreen()

    expect(verdictFor(out, 'dirty-swallowed')).toBe('dirty')
  }, 60_000)

  test('a manifest that fails to import is unscreenable, never clean', async () => {
    // The failure mode this whole file guards against: a screen reporting a
    // pass for a file it never actually loaded.
    await plugin('broken', `import 'node:definitely-not-a-real-builtin'\n`)

    const { code, out } = await runScreen()

    expect(verdictFor(out, 'broken')).toBe('unscreenable')
    expect(code).not.toBe(0)
  }, 60_000)
})
