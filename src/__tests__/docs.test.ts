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
import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_TTL_MS, MAX_GRANT_WINDOW_MS } from '../runtime/approval-gate.js'
import { PluginManifestSchema } from '../schemas/plugin-manifest.js'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8')

/**
 * What `npm publish` would actually ship, straight from npm.
 *
 * Asking npm beats reimplementing its `files` semantics — that array supports
 * globs and `!` negation (this package excludes docs/board-spec.md that way),
 * and a check that models the rules itself gets the answer wrong precisely
 * when the rules are being used for something interesting. `--ignore-scripts`
 * skips prepack: this needs the file list, not a fresh build.
 */
let packedCache: Set<string> | null = null
function packed(): Set<string> {
  if (!packedCache) {
    const out = execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const entries = JSON.parse(out)[0].files as { path: string }[]
    packedCache = new Set(entries.map((f) => f.path))
  }
  return packedCache
}

/** Markdown files that ship to consumers. */
function packedDocs(): string[] {
  return [...packed()].filter((f) => f.endsWith('.md'))
}

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
    const escaping: string[] = []
    for (const file of packedDocs()) {
      const dir = join(REPO_ROOT, file, '..')
      for (const m of read(file).matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        const href = (m[1] as string).split('#')[0] as string
        if (!href || /^([a-z]+:)?\/\//.test(href)) continue
        // join() preserves a trailing slash; the packed list has none.
        const resolved = join(dir, href).slice(REPO_ROOT.length + 1).replace(/\/+$/, '')
        // npm lists files, not directories, so a link to `examples/plugins/`
        // is satisfied by anything shipping beneath it.
        const shipped =
          packed().has(resolved) || [...packed()].some((f) => f.startsWith(`${resolved}/`))
        if (!shipped) {
          escaping.push(
            `${file} -> ${href}: ${resolved} is not in the tarball, so this 404s inside node_modules. Use an absolute GitHub URL.`,
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

// ── Exactly one markdown index source under docs/ ─────────────────────────
//
// Jekyll resolves the directory root to a single source, and more than one
// file can claim it: `index.md` and `README.md` both compete for it. Which one
// wins is a detail of the build we have deliberately not measured — needing to
// know is itself the defect. A second source appearing changes which page a
// reader lands on at the published docs root and nothing in the diff says so:
// "added a README" and "replaced the landing page" read alike. Scoped
// honestly to markdown index sources; a hand-written `index.html` dropped into
// docs/ is outside what this checks.

describe('docs index', () => {
  test('docs/ has exactly one markdown index source', () => {
    const sources = markdownFiles().filter((f) => {
      if (!f.startsWith('docs/')) return false
      const base = (f.split('/').pop() as string).replace(/\.md$/, '')
      return base === 'index' || base.toLowerCase() === 'readme'
    })
    // If this fails: docs/index.md is the published root. Rename or remove the
    // other candidate rather than leaving two files competing for one URL.
    expect(sources).toEqual(['docs/index.md'])
  })
})

// ── Issue forms must keep the shape GitHub silently requires ─────────────
//
// A malformed issue form does not error: GitHub drops it, and the chooser
// simply shows one fewer entry. That failure is indistinguishable from nobody
// having filed under that template yet, which is the one property a guard must
// not have.
//
// Text scrapes rather than a YAML parse, deliberately: zod is this package's
// only runtime dependency and three static files do not earn a parser. The
// unauthenticated chooser fetch is the real parse oracle; this block catches
// the shape mistakes before a push, and catches the one thing the chooser
// cannot see — what the form asks a stranger to type.
//
// That last check is the load-bearing one. Issue bodies are public, and this
// repository's secret-scanning push protection is pre-receive: it covers
// pushes, never an issue body. Once a field invites a paste, the wording of
// that field is the only control that exists.

describe('issue forms', () => {
  const FORMS = ['.github/ISSUE_TEMPLATE/bug_report.yml', '.github/ISSUE_TEMPLATE/plugin_question.yml']
  const CONFIG = '.github/ISSUE_TEMPLATE/config.yml'

  /** The element types GitHub's form schema accepts; anything else is dropped. */
  const ELEMENT_TYPES = new Set(['markdown', 'input', 'textarea', 'dropdown', 'checkboxes', 'upload'])

  /**
   * Terms that, in a field's `id:` or `label:`, mean the form is asking a
   * stranger for a secret in public. Scoped to those two keys on purpose: the
   * redaction instructions themselves have to name secrets, and scanning
   * descriptions too would report the mitigation as the defect.
   */
  const CREDENTIAL_TERMS = [
    'token', 'secret', 'credential', 'password', 'api[ _-]?key', '\\.env', 'env dump', 'environment dump',
  ]
  const CREDENTIAL_FIELD = new RegExp(
    `^\\s*(?:id|label):\\s.*(?<![a-z])(?:${CREDENTIAL_TERMS.join('|')})(?![a-z])`,
    'i',
  )

  /** A form body split into elements, each keeping its own `- type:` line. */
  function elements(text: string): string[] {
    return text.split(/^(?=[^\S\n]*- type: )/m).slice(1)
  }

  test('each form declares the keys GitHub requires, with a body of valid elements', () => {
    const offenders: string[] = []
    for (const file of FORMS) {
      const text = read(file)
      for (const key of ['name', 'description', 'body']) {
        if (!new RegExp(`^${key}:\\s*\\S?`, 'm').test(text)) {
          offenders.push(`${file}: no top-level \`${key}:\` — GitHub drops the whole form and the chooser just shows one fewer entry`)
        }
      }
      const types = [...text.matchAll(/^[^\S\n]*- type: (\S+)$/gm)].map((m) => m[1] as string)
      if (types.length < 2) {
        offenders.push(`${file}: ${types.length} body element(s) — a form asking less than two things is a blank issue with extra steps`)
      }
      for (const type of types) {
        if (!ELEMENT_TYPES.has(type)) {
          offenders.push(`${file}: element type '${type}' is outside the schema — use one of ${[...ELEMENT_TYPES].join(', ')}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  test('the chooser config sets the two keys it may set, and its contact entry is complete', () => {
    const text = read(CONFIG)
    const offenders: string[] = []
    if (!/^blank_issues_enabled: false$/m.test(text)) {
      offenders.push(`${CONFIG}: blank_issues_enabled is not false, so a blank body bypasses both forms and the security route with them`)
    }
    for (const m of text.matchAll(/^([A-Za-z_][\w-]*):/gm)) {
      const key = m[1] as string
      if (key !== 'blank_issues_enabled' && key !== 'contact_links') {
        offenders.push(`${CONFIG}: unknown top-level key '${key}' — this file accepts exactly those two`)
      }
    }
    const entries = text.split(/^ {2}- /m).slice(1)
    if (entries.length === 0) {
      offenders.push(`${CONFIG}: no contact_links entry, so the chooser offers no private route for a gate bypass`)
    }
    entries.forEach((entry, i) => {
      for (const key of ['name', 'url', 'about']) {
        if (!new RegExp(`^\\s*${key}:\\s*\\S`, 'm').test(entry)) {
          offenders.push(`${CONFIG}: contact_links[${i}] has no \`${key}:\` — all three are required and GitHub drops the entry without them`)
        }
      }
    })
    expect(offenders).toEqual([])
  })

  test('no field invites credential material, and every paste field says what to strip', () => {
    const offenders: string[] = []
    for (const file of FORMS) {
      for (const element of elements(read(file))) {
        const type = element.match(/^[^\S\n]*- type: (\S+)$/m)?.[1] as string
        const id = element.match(/^[^\S\n]*id: (\S+)$/m)?.[1] ?? type
        for (const line of element.split('\n')) {
          if (CREDENTIAL_FIELD.test(line)) {
            offenders.push(`${file}: field '${id}' asks for credential material (${line.trim()}) — an issue body is public and push protection is pre-receive, so it never sees this`)
          }
        }
        if (type === 'textarea' && !/^[^\S\n]*description:.*Redact/m.test(element)) {
          offenders.push(`${file}: textarea '${id}' has no \`description:\` naming what to Redact before pasting`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})

// ── Shipped docs must not point at code the tarball excludes ─────────────
//
// The link check above only sees markdown links. Seven references slipped
// through as prose — `src/lib/paths.ts`, `scripts/gen-manifest-table.ts` and
// friends — telling a reader inside node_modules to go look at files that are
// not there. This catches that class.
//
// Scoped to inline code spans, for the same reason the command check is: a
// sentence mentioning src/ in passing is not a defect, and a check that fires
// on prose gets an ignore-comment bolted to it rather than being obeyed.
//
// Opt-out is by SECTION, not by line: a `##` heading marked "repository-only"
// or "not in this repo" exempts everything under it until the next `##`. That
// keeps the exemption visible to the reader of the doc, not just to the test —
// the same marker that tells a human "this part isn't about your install" is
// the one that tells the check to stand down.

describe('shipped docs stay package-facing', () => {
  const REPO_ONLY_HEADING = /^##\s.*(repository-only|not in this repo)/i
  // A specific path INSIDE a non-shipped tree — `src/lib/paths.ts` sends the
  // reader somewhere that does not exist. A bare `src/` naming the tree in a
  // contrast ("warpline's own src/ is correct there and wrong here") points
  // nowhere and is not a defect.
  const NON_SHIPPED = /^(src|scripts|test-utils|npm-stub|\.github|\.planning)\/.+/

  test('no shipped doc references a path the tarball excludes', () => {
    const offenders: string[] = []
    for (const file of packedDocs()) {
      let exempt = false
      read(file)
        .split('\n')
        .forEach((line, i) => {
          if (line.startsWith('## ')) exempt = REPO_ONLY_HEADING.test(line)
          if (exempt) return
          for (const m of line.matchAll(/`([^`\n]+)`/g)) {
            const ref = m[1] as string
            if (NON_SHIPPED.test(ref)) offenders.push(`${file}:${i + 1}: \`${ref}\``)
          }
        })
    }
    expect(offenders).toEqual([])
  })
})

// ── The agent-instruction files must stay one document ───────────────────

describe('agent instructions', () => {
  test('CLAUDE.md is a symlink to AGENTS.md, not a copy of it', () => {
    // Claude Code reads CLAUDE.md and does not look for AGENTS.md; every other
    // harness reads AGENTS.md. A copy would satisfy both readers on the day it
    // was made and diverge quietly afterwards, which is the failure this repo
    // keeps finding in its own docs. git stores the link, so this holds on a
    // fresh clone too.
    const stat = lstatSync(join(REPO_ROOT, 'CLAUDE.md'))
    expect(stat.isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(REPO_ROOT, 'CLAUDE.md'))).toBe('AGENTS.md')
  })

  test('context7.json parses and excludes the trees that do not ship', () => {
    const cfg = JSON.parse(read('context7.json'))
    expect(cfg.folders).toContain('docs')
    // Context7 indexes the public repo, so it can reach src/ — but warpline's
    // docs are the answer to "how do I use this", and indexing implementation
    // alongside them buries it.
    for (const tree of ['src', 'scripts', 'test-utils']) {
      expect(cfg.excludeFolders).toContain(tree)
    }
  })
})

// ── Documented approval numbers must match the constants ─────────────────
//
// Two numbers — the default grant lifetime and the absolute ceiling — now
// live in three documents and in one module, and only the module is
// authoritative. `DEFAULT_TTL_MS` and `MAX_GRANT_WINDOW_MS` are what the gate
// enforces; the copies in doctrine, the spec and the tutorial are claims
// about them. Change a constant and every claim goes quietly wrong, with
// nothing in the diff saying so and no way for a reader to tell.
//
// So every expected string below is BUILT from the constant rather than typed
// out. A hard-coded `4 hours` here would just be one more copy of the number,
// which is the thing being prevented: nothing in this block may contain a
// numeric literal for either value.
//
// Each document is asserted against the rendering that document actually
// uses. The three spell the same number three different ways, and pinning one
// canonical spelling everywhere would pass vacuously in the two files that
// spell it otherwise — worse than not asserting at all, because it still
// looks like coverage.

describe('approval numbers stay true across the docs', () => {
  const HOUR_MS = 60 * 60 * 1000
  const defaultHours = DEFAULT_TTL_MS / HOUR_MS
  const ceilingHours = MAX_GRANT_WINDOW_MS / HOUR_MS

  /** Offenders for a list of file/expected-rendering pairs. */
  function missing(constant: string, value: string, pairs: [string, string][]): string[] {
    return pairs
      .filter(([file, expected]) => !read(file).includes(expected))
      .map(
        ([file, expected]) =>
          `${file}: expected to contain \`${expected}\`. ${constant} is ${value}, so either this document's wording is stale (fix the prose) or the constant moved deliberately (fix every document, then this list).`,
      )
  }

  test('every document states the default grant lifetime the gate uses', () => {
    const offenders = missing('DEFAULT_TTL_MS', `${defaultHours}h`, [
      ['docs/runtime-spec.md', `| Default TTL | ${defaultHours} hours. |`],
      ['docs/first-plugin.md', `${defaultHours * 60}m remaining`],
    ])
    expect(offenders).toEqual([])
  })

  test('every document states the ceiling the merge path enforces', () => {
    const offenders = missing('MAX_GRANT_WINDOW_MS', `${ceilingHours}h`, [
      ['docs/runtime-spec.md', `first_granted_at + ${ceilingHours}h`],
      ['docs/doctrine.md', `${ceilingHours}-hour ceiling`],
      ['docs/first-plugin.md', `${ceilingHours}-hour ceiling`],
    ])
    expect(offenders).toEqual([])
  })
})
