/**
 * Documentation checks that fail like tests.
 *
 * These live in `bun test` rather than a separate lint script on purpose: it is
 * the command CONTRIBUTING names, CI runs, and agents run, so a doc check
 * cannot be skipped by forgetting a second command. Everything here is
 * deterministic and offline — link *rot* is network-dependent and belongs in an
 * advisory CI job, not in a suite whose red must always mean "you broke
 * something".
 *
 * What motivated them: 0.1.0 published a README whose quickstart could not work
 * for anyone installing from npm — it documented `bun run src/cli/scaffold.ts`
 * (src/ is not shipped), advertised `board` subcommands the bin does not have,
 * and claimed Bun was required when Node alone is enough. None of that was
 * catchable by reading, only by checking the docs against the code.
 */
import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PluginManifestSchema } from '../schemas/plugin-manifest.js'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8')

/** Every tracked markdown file. */
function markdownFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z', '*.md'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
}

// ── The CLI surface has three descriptions; all three must agree ──────────
//
// The dispatcher's `case` labels are the only one that decides what actually
// runs. The USAGE string and the docs are claims about it, and each drifted
// independently before this existed.

const dispatcher = read('src/cli/warpline.ts')

/** What the dispatcher actually routes, minus the help flags. */
function dispatchedCommands(): Set<string> {
  const cases = [...dispatcher.matchAll(/^\s*case '([^']+)':/gm)].map((m) => m[1] as string)
  return new Set(cases.filter((c) => !c.startsWith('-')))
}

/** What `warpline --help` advertises. */
function advertisedCommands(): Set<string> {
  const usage = dispatcher.slice(dispatcher.indexOf('const USAGE'))
  const body = usage.slice(usage.indexOf('Commands:'), usage.indexOf('--help'))
  return new Set([...body.matchAll(/^ {2}(\w[\w-]*)\s{2,}\S/gm)].map((m) => m[1] as string))
}

describe('CLI surface', () => {
  test('every advertised command is actually dispatched', () => {
    const undeliverable = [...advertisedCommands()].filter((c) => !dispatchedCommands().has(c))
    expect(undeliverable).toEqual([])
  })

  test('every dispatched command is advertised in --help', () => {
    const undocumented = [...dispatchedCommands()].filter((c) => !advertisedCommands().has(c))
    expect(undocumented).toEqual([])
  })

  test('the built binary prints the same command list it dispatches', () => {
    if (!existsSync(join(REPO_ROOT, 'dist/bin/warpline.js'))) return // pre-build; the source checks above still ran
    const out = execFileSync('node', ['dist/bin/warpline.js', '--help'], { cwd: REPO_ROOT, encoding: 'utf8' })
    for (const cmd of dispatchedCommands()) expect(out).toContain(cmd)
  })
})

// ── Documented commands must exist ───────────────────────────────────────

describe('documented commands', () => {
  /**
   * Invocations only — inline code spans and fenced-block lines. Matching bare
   * prose finds ten "a warpline plugin" for every real defect, and a check that
   * cries wolf gets deleted rather than fixed.
   */
  function invocations(text: string): string[] {
    const found: string[] = []
    for (const m of text.matchAll(/`([^`\n]+)`/g)) found.push(m[1] as string)
    for (const block of text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
      found.push(...(block[1] as string).split('\n'))
    }
    return found
  }

  test('every documented `warpline <cmd>` invocation is a real subcommand', () => {
    const bogus: string[] = []
    for (const file of markdownFiles()) {
      for (const line of invocations(read(file))) {
        const m = line.trim().match(/^(?:npx |bunx )?warpline ([a-z][a-z-]*)/)
        const cmd = m?.[1]
        if (cmd && !dispatchedCommands().has(cmd)) bogus.push(`${file}: warpline ${cmd}`)
      }
    }
    expect(bogus).toEqual([])
  })

  test('every `bun run <path>` in the docs points at a file that exists', () => {
    const missing: string[] = []
    for (const file of markdownFiles()) {
      for (const m of read(file).matchAll(/bun run ([\w./-]+\.ts)/g)) {
        const target = m[1] as string
        if (!existsSync(join(REPO_ROOT, target))) missing.push(`${file}: ${target}`)
      }
    }
    expect(missing).toEqual([])
  })
})

// ── Links must resolve ───────────────────────────────────────────────────

describe('internal links', () => {
  test('every relative markdown link resolves to something that exists', () => {
    const broken: string[] = []
    for (const file of markdownFiles()) {
      const dir = join(REPO_ROOT, file, '..')
      for (const m of read(file).matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        const href = (m[1] as string).split('#')[0] as string
        if (!href || /^([a-z]+:)?\/\//.test(href) || href.startsWith('mailto:')) continue
        if (!existsSync(join(dir, href))) broken.push(`${file} -> ${href}`)
      }
    }
    expect(broken).toEqual([])
  })

  test('docs shipped in the tarball only link to things the tarball contains', () => {
    // `files` puts docs/ and examples/ in the package but not src/ or scripts/.
    // A docs link to src/foo.ts resolves on GitHub and 404s for anyone reading
    // the same file inside node_modules.
    const shipped = new Set(
      JSON.parse(read('package.json')).files.map((f: string) => f.replace(/\/$/, '')),
    )
    const escaping: string[] = []
    for (const file of markdownFiles().filter((f) => f.startsWith('docs/') || f === 'README.md')) {
      const dir = join(REPO_ROOT, file, '..')
      for (const m of read(file).matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        const href = (m[1] as string).split('#')[0] as string
        if (!href || /^([a-z]+:)?\/\//.test(href)) continue
        const resolved = join(dir, href).slice(REPO_ROOT.length + 1)
        const top = resolved.split('/')[0] as string
        if (!shipped.has(top)) {
          escaping.push(
            `${file} -> ${href}: ${top}/ is not in package.json files, so this 404s inside node_modules. Use an absolute GitHub URL.`,
          )
        }
      }
    }
    expect(escaping).toEqual([])
  })
})

// ── Generated reference must match the schema ────────────────────────────

describe('generated manifest table', () => {
  test('docs/runtime-spec.md matches what the schema generates today', async () => {
    const { manifestTable } = await import('../../scripts/gen-manifest-table.js')
    const doc = read('docs/runtime-spec.md')
    const begin = doc.indexOf('<!-- generated: manifest-fields -->')
    const end = doc.indexOf('<!-- /generated -->')
    expect(begin).toBeGreaterThan(-1)

    const inDoc = doc.slice(begin, end + '<!-- /generated -->'.length)
    // Regenerate with `bun run scripts/gen-manifest-table.ts --write`.
    expect(inDoc).toBe(manifestTable())
  })

  test('every schema field appears in the rendered table', () => {
    const doc = read('docs/runtime-spec.md')
    const missing = Object.keys(PluginManifestSchema.shape).filter((f) => !doc.includes(`| \`${f}\` |`))
    expect(missing).toEqual([])
  })
})

// ── Diataxis: each doc declares which kind it is ─────────────────────────
//
// Frontmatter only, deliberately no directory split: Diataxis' own guidance
// calls pre-created empty quadrant folders "horrible" and treats structure as
// an output of the writing, not an input to it. Declaring the type is enough to
// make a mixed document visible to its author, which is the whole benefit.

const DIATAXIS_TYPES = new Set(['tutorial', 'how-to', 'reference', 'explanation'])

describe('diataxis', () => {
  test('every docs/*.md declares exactly one valid diataxis type', () => {
    const bad: string[] = []
    for (const file of markdownFiles().filter((f) => f.startsWith('docs/'))) {
      const m = read(file).match(/^---\n([\s\S]*?)\n---/)
      const declared = m?.[1]?.match(/^diataxis:\s*(\S+)$/m)?.[1]
      if (!declared) bad.push(`${file}: no \`diataxis:\` field in frontmatter`)
      else if (!DIATAXIS_TYPES.has(declared)) bad.push(`${file}: unknown diataxis type '${declared}'`)
    }
    expect(bad).toEqual([])
  })
})
