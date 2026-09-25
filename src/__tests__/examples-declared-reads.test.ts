/**
 * A bundled example handler reads only what its manifest declares: every
 * environment variable it names is on `manifest.secrets`, and every input key
 * it reads is a key of `manifest.inputs`. A value read from anywhere else is
 * configuration the approval gate never saw declared, and `scaffold --from`
 * copies the read verbatim into an adopter's home. Defaults live in the
 * manifest, so a key a handler invents for itself is a default hiding in code.
 *
 * Same shape as `example-defaults.test.ts`: one helper taking a root directory
 * and returning offender strings, run against the real repository (must be
 * empty) and against a temp-dir fixture holding planted undeclared reads (must
 * name each). The one existing exception is an exemption with a written
 * reason, and a test proves it is load-bearing, so nothing else hides behind
 * it.
 *
 * **Lexical, and the ceiling is stated.** The scan reads `handler.ts` as text:
 * `process.env.NAME`, `process.env['NAME']`, any quoted `*_TOKEN` literal,
 * `args.key`, `args['key']` and `configured(manifest, args, 'key')`. A dynamic
 * read (`process.env[variable]`, `args[variable]`) is invisible to it. The
 * known dynamic reads take their names from the manifest (`secrets[0]`) or from
 * a table whose `*_TOKEN` literals the quoted-literal pattern does see, so they
 * are declared by construction. ponytail: an AST pass that resolves those
 * variables is the upgrade if a dynamic read ever names something undeclared.
 *
 * Offender strings name the plugin directory and the env var NAME or input
 * key, never a value. This file's failure output lands in a public CI log.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const EXAMPLES = join('examples', 'plugins')

interface Exemption {
  readonly plugin: string
  /** The env var name or input key admitted for that plugin, and nothing else. */
  readonly read: string
  /** Why this read is held rather than fixed. Required. */
  readonly reason: string
}

const EXEMPTIONS: readonly Exemption[] = [
  {
    plugin: 'anomaly-issue',
    read: 'GITHUB_TOKEN',
    reason:
      'predates declared secrets; the six-examples spec names it and leaves the fix out of scope, so it is held here by name rather than hidden by a wider rule',
  },
]

const ENV_READS = [
  /process\.env\.([A-Z_][A-Z0-9_]*)/g,
  /process\.env\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\]/g,
  /['"]([A-Z][A-Z0-9_]*_TOKEN)['"]/g,
]
const INPUT_READS = [
  /\bargs\.([A-Za-z_]\w*)/g,
  /\bargs\[\s*['"]([^'"]+)['"]\s*\]/g,
  /configured\(\s*\w+\s*,\s*args\s*,\s*['"]([^'"]+)['"]/g,
]

const names = (source: string, patterns: RegExp[]): Set<string> =>
  new Set(patterns.flatMap((re) => [...source.matchAll(re)].map((m) => m[1]!)))

/**
 * Every undeclared read under `<root>/examples/plugins`, sorted and unique,
 * and how many plugins (a directory holding both `manifest.ts` and
 * `handler.ts`) were read. Rejects when there is no examples tree or no plugin
 * in it, because an empty scan is a wrong root, not a clean tree.
 */
export async function undeclaredReads(
  root: string,
  exemptions: readonly Exemption[] = EXEMPTIONS,
): Promise<{ offenders: string[]; scanned: number }> {
  const pluginsRoot = join(root, EXAMPLES)
  if (!existsSync(pluginsRoot)) throw new Error(`no examples tree under ${root}`)

  const offenders = new Set<string>()
  let scanned = 0
  const dirs = readdirSync(pluginsRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
  for (const plugin of dirs) {
    const manifestPath = join(pluginsRoot, plugin, 'manifest.ts')
    const handlerPath = join(pluginsRoot, plugin, 'handler.ts')
    if (!existsSync(manifestPath) || !existsSync(handlerPath)) continue
    const { manifest } = (await import(pathToFileURL(manifestPath).href)) as {
      manifest?: { secrets?: string[]; inputs?: object }
    }
    const source = readFileSync(handlerPath, 'utf8')
    scanned += 1

    const exempt = (read: string) => exemptions.some((e) => e.plugin === plugin && e.read === read)
    const secrets = new Set(manifest?.secrets ?? [])
    for (const name of names(source, ENV_READS)) {
      if (!secrets.has(name) && !exempt(name)) {
        offenders.add(`${plugin}: reads env '${name}', which manifest.secrets does not declare`)
      }
    }
    const inputs = manifest?.inputs ?? {}
    for (const key of names(source, INPUT_READS)) {
      if (!Object.hasOwn(inputs, key) && !exempt(key)) {
        offenders.add(`${plugin}: reads input '${key}', which manifest.inputs does not declare`)
      }
    }
  }
  if (scanned === 0) throw new Error(`no example plugin with a manifest.ts and a handler.ts under ${pluginsRoot}`)
  return { offenders: [...offenders].sort(), scanned }
}

// ── Fixtures ─────────────────────────────────────────────────────────────

/**
 * A temp root holding the given plugins, each a plain-object manifest (no
 * `warpline/...` import to resolve) beside a handler source, removed in a
 * `finally`. Tests never write inside the repository.
 */
async function withFixture(
  plugins: Record<string, { manifest: object; handler: string }>,
  assert: (root: string) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'warpline-reads-'))
  try {
    for (const [name, { manifest, handler }] of Object.entries(plugins)) {
      const dir = join(root, EXAMPLES, name)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'manifest.ts'), `export const manifest = ${JSON.stringify({ name, ...manifest })}\n`)
      writeFileSync(join(dir, 'handler.ts'), handler)
    }
    await assert(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const DECLARING = { secrets: ['DECLARED_TOKEN'], inputs: { declared_key: { type: 'string', required: true } } }

// ── The repository ───────────────────────────────────────────────────────

describe('example handlers read only what they declare', () => {
  test('no shipped example handler reads an env var or input its manifest does not declare', async () => {
    expect((await undeclaredReads(REPO_ROOT)).offenders).toEqual([])
  })

  test('at least three example directories were scanned, so the check above is not vacuous', async () => {
    expect((await undeclaredReads(REPO_ROOT)).scanned).toBeGreaterThanOrEqual(3)
  })

  test('the exemption is load-bearing: without it exactly the anomaly-issue read is an offender', async () => {
    expect((await undeclaredReads(REPO_ROOT, [])).offenders).toEqual([
      "anomaly-issue: reads env 'GITHUB_TOKEN', which manifest.secrets does not declare",
    ])
    for (const entry of EXEMPTIONS) expect(entry.reason.length).toBeGreaterThan(20)
  })
})

// ── The guard, watched going red ─────────────────────────────────────────

describe('the declared-reads guard goes red on a planted read', () => {
  test('each undeclared env name and input key is named, and a plugin reading only what it declares is not', async () => {
    await withFixture(
      {
        planted: {
          manifest: DECLARING,
          handler: [
            'export const handler = async (manifest, args) => {',
            '  const token = process.env.PLANTED_TOKEN',
            "  const other = 'OTHER_TOKEN'",
            '  const key = args.undeclared_key',
            "  const also = configured(manifest, args, 'also_missing')",
            '  return { token, other, key, also }',
            '}',
            '',
          ].join('\n'),
        },
        clean: {
          manifest: DECLARING,
          handler: [
            'export const handler = async (manifest, args) => {',
            "  const token = process.env['DECLARED_TOKEN']",
            "  const key = args['declared_key']",
            "  const same = configured(manifest, args, 'declared_key')",
            '  return { token, key, same, fallback: args.declared_key }',
            '}',
            '',
          ].join('\n'),
        },
      },
      async (root) => {
        expect(await undeclaredReads(root)).toEqual({
          offenders: [
            "planted: reads env 'OTHER_TOKEN', which manifest.secrets does not declare",
            "planted: reads env 'PLANTED_TOKEN', which manifest.secrets does not declare",
            "planted: reads input 'also_missing', which manifest.inputs does not declare",
            "planted: reads input 'undeclared_key', which manifest.inputs does not declare",
          ],
          scanned: 2,
        })
      },
    )
  })

  test('an absent examples tree rejects rather than reading clean', async () => {
    await withFixture({}, async (root) => {
      await expect(undeclaredReads(root)).rejects.toThrow(/no examples tree/)
    })
  })
})
