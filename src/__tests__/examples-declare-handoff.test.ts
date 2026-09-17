/**
 * Every example plugin whose handler returns a `[needs-llm]` handoff declares
 * `llm_handoff: true` in its manifest.
 *
 * The runtime refuses a handoff from a plugin that does not declare the field,
 * so an undeclared example is a broken example: its handoff records `failed`.
 * This guard catches that at the file level, before anyone runs it.
 *
 * Structural, the way `example-test-hygiene.test.ts` is: read each handler as
 * text, and for the ones that hand off, import the manifest and read the bit.
 * One helper taking a root, run against the real tree (must be empty) and
 * against a planted fixture (must name the undeclared plugin and pass the
 * others), so the guard is provably non-vacuous. The census of handing-off
 * examples is pinned too, so a scan that quietly stops matching fails loudly
 * instead of reading as clean. A new handing-off example extends that census
 * in the same commit.
 *
 * The real manifests import `warpline/schemas/*`, which resolves through
 * `dist/`, so this needs `bun run build` first. A stale `dist/` whose schema
 * predates the field strips the key at parse time, and all three current
 * adopters show up as offenders, which is loud rather than silent.
 *
 * Known blind spot: a handler that hand-rolls a prefix-only result with no
 * field literal, or hands off through a helper in another file, does not match
 * the scan. The runtime refusal still catches that plugin the first time it
 * hands off. This guard is the early warning, not the enforcement.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO_ROOT = join(import.meta.dir, '..', '..')

/** A call to the builder, or a literal field. The paren and the colon keep a comment from counting. */
const HANDS_OFF = [/\bskillHandoff\s*\(/, /\bneeds_llm\s*:/]

/**
 * Scan `<root>/examples/plugins`. `offenders` names every handing-off plugin
 * that does not declare the field, `handingOff` is the census of plugins that
 * hand off, and `scanned` counts the handlers read. Rejects when no handler
 * was found, because an empty scan is a wrong root, not a clean tree.
 */
export async function offenders(
  root: string,
): Promise<{ offenders: string[]; handingOff: string[]; scanned: number }> {
  const pluginsRoot = join(root, 'examples', 'plugins')
  const out: string[] = []
  const handingOff: string[] = []
  let scanned = 0
  const dirs = readdirSync(pluginsRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
  for (const plugin of dirs) {
    const handlerPath = join(pluginsRoot, plugin, 'handler.ts')
    if (!existsSync(handlerPath)) continue
    scanned++
    const source = readFileSync(handlerPath, 'utf8')
    if (!HANDS_OFF.some((re) => re.test(source))) continue
    handingOff.push(plugin)
    let manifest: { llm_handoff?: unknown }
    try {
      const mod = (await import(pathToFileURL(join(pluginsRoot, plugin, 'manifest.ts')).href)) as {
        manifest: { llm_handoff?: unknown }
      }
      manifest = mod.manifest
    } catch {
      out.push(`${plugin}: manifest.ts failed to load`)
      continue
    }
    if (manifest?.llm_handoff !== true) {
      out.push(
        `${plugin}: handler returns a [needs-llm] handoff but manifest.ts does not declare llm_handoff: true`,
      )
    }
  }
  if (scanned === 0) throw new Error(`no example handler found under ${pluginsRoot}`)
  return { offenders: out, handingOff, scanned }
}

describe('example plugins that hand off declare llm_handoff', () => {
  test('the real examples tree has no offender', async () => {
    const result = await offenders(REPO_ROOT)
    expect(result.offenders).toEqual([])
  })

  test('the census names the handing-off examples, from a full scan', async () => {
    const result = await offenders(REPO_ROOT)
    expect(result.handingOff).toEqual(['announce-fanout', 'draft-writer', 'feed-triage'])
    expect(result.scanned).toBeGreaterThanOrEqual(12)
  })

  test('the guard names a planted undeclared plugin and passes the others', async () => {
    const root = mkdtempSync(join(tmpdir(), 'warpline-declare-handoff-'))
    try {
      const plant = (name: string, handler: string, manifest: Record<string, unknown>) => {
        const dir = join(root, 'examples', 'plugins', name)
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'handler.ts'), handler)
        writeFileSync(join(dir, 'manifest.ts'), `export const manifest = ${JSON.stringify(manifest)}\n`)
      }
      plant(
        'planted-undeclared',
        "export async function handler() {\n  return skillHandoff('Triage', 'state/x.json')\n}\n",
        { name: 'planted-undeclared' },
      )
      plant(
        'planted-declared',
        "export async function handler() {\n  return { status: 'skipped', summary: 'x', needs_llm: { task: 'x', context_path: 'state/x.json' } }\n}\n",
        { name: 'planted-declared', llm_handoff: true },
      )
      plant(
        'planted-comment-only',
        "// A [needs-llm] plugin would call skillHandoff here; this one does not.\nexport async function handler() {\n  return { status: 'success' }\n}\n",
        { name: 'planted-comment-only' },
      )

      const result = await offenders(root)
      expect(result.offenders).toEqual([
        'planted-undeclared: handler returns a [needs-llm] handoff but manifest.ts does not declare llm_handoff: true',
      ])
      expect(result.handingOff).toEqual(['planted-declared', 'planted-undeclared'])
      expect(result.scanned).toBe(3)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a root with no handler is refused, not read as clean', async () => {
    const root = mkdtempSync(join(tmpdir(), 'warpline-declare-handoff-empty-'))
    try {
      mkdirSync(join(root, 'examples', 'plugins', 'empty'), { recursive: true })
      await expect(offenders(root)).rejects.toThrow('no example handler found')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
