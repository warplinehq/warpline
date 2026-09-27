/**
 * Emit docs/llms.txt from docs/index.md and package.json.
 *
 * The docs index is the one hand-maintained list of published docs, in reading
 * order. This turns it into an llmstxt.org file: an H1, a blockquote taken from
 * package.json's `description`, a `## Docs` section in the index's order, and a
 * `## Optional` section holding whatever the index files under
 * `## Background`. Each link line keeps the index's note, with the leading
 * ` — ` turned into `: `. Nothing else is written by hand, so the file cannot
 * say anything the index and package.json do not.
 *
 * Every link is an absolute raw URL pinned to `v{version}`. An agent reading the
 * file out of an older install must be handed the docs for that install, not
 * whatever `main` says today. The tag only exists once the release that ships
 * this file is published, so a link can 404 between the version bump and the
 * release, and never after.
 *
 * `## Optional` is spelled exactly because tools that trim context match the
 * heading case-sensitively. Newer revisions of the format stopped giving the
 * heading a mechanical meaning, so each entry under it also says itself that it
 * is not needed to use warpline. A reader that ignores the heading still gets
 * the message.
 *
 * The roster is checked against the tracked docs, not the index alone: a
 * tracked doc missing from the index throws, a bullet pointing at a doc that is
 * not tracked throws, and an H2 in the index other than `## Background` throws.
 * Only `node:*` is imported, so the script runs from a bare copy of the repo.
 *
 * Usage:
 *   bun run scripts/gen-llms-txt.ts           # print the file
 *   bun run scripts/gen-llms-txt.ts --write   # write docs/llms.txt
 *   bun run scripts/gen-llms-txt.ts --check   # exit 1 if docs/llms.txt is stale or missing
 *
 * CI's docs-generated job runs `bun run docs:generate` and then
 * `git diff --exit-code -- docs/`, and the release workflow runs --check before
 * it packs, so a stale file fails before it merges and again before it ships.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const REPO = 'warplinehq/warpline'
const OPTIONAL_SOURCE = 'Background'
const OPTIONAL_SUFFIX = ' (background: not needed to use warpline)'
const BLOB_PREFIX = `https://github.com/${REPO}/blob/main/`

type Entry = { target: string; text: string; optional: boolean }

/** Map an index link to its repo-relative path, or throw on a shape we do not know. */
function normalise(href: string): string {
  if (/^[^/:#?]+\.md$/.test(href)) return `docs/${href}`
  if (href.startsWith(BLOB_PREFIX) && /^docs\/[^/:#?]+\.md$/.test(href.slice(BLOB_PREFIX.length))) {
    return href.slice(BLOB_PREFIX.length)
  }
  throw new Error(`docs/index.md: cannot map link '${href}' to a tracked doc`)
}

export function llmsTxt(
  indexMd: string,
  version: string,
  trackedDocs: readonly string[],
  description: string,
): string {
  let lines = indexMd.split('\n')
  if (lines[0] === '---') {
    const close = lines.indexOf('---', 1)
    if (close !== -1) lines = lines.slice(close + 1)
  }

  const entries: Entry[] = []
  let optional = false
  let open: Entry | null = null
  for (const line of lines) {
    if (line.startsWith('## ')) {
      open = null
      if (line.slice(3).trim() !== OPTIONAL_SOURCE) {
        throw new Error(`docs/index.md: unknown section '${line.trim()}'; only '## ${OPTIONAL_SOURCE}' maps into llms.txt`)
      }
      optional = true
      continue
    }
    const bullet = line.match(/^- \[([^\]]+)\]\(([^)]+)\)(.*)$/)
    if (bullet) {
      open = { target: normalise(bullet[2] as string), text: bullet[3] as string, optional }
      entries.push(open)
      continue
    }
    if (open && line.startsWith('  ') && line.trim() !== '') {
      open.text += ` ${line.trim()}`
      continue
    }
    open = null
  }

  const tracked = new Set(trackedDocs)
  const seen = new Set<string>()
  for (const { target } of entries) {
    if (!tracked.has(target)) throw new Error(`${target} is listed in docs/index.md but is not a tracked doc`)
    if (seen.has(target)) throw new Error(`${target} is listed twice in docs/index.md`)
    seen.add(target)
  }
  for (const doc of trackedDocs) {
    if (doc !== 'docs/index.md' && !seen.has(doc)) {
      throw new Error(`${doc} is tracked but not listed in docs/index.md`)
    }
  }

  const render = ({ target, text, optional: opt }: Entry): string => {
    let note = text.replace(/^\s*— /, '').trim()
    if (opt) note = note ? note + OPTIONAL_SUFFIX : OPTIONAL_SUFFIX.trim().slice(1, -1)
    const url = `https://raw.githubusercontent.com/${REPO}/v${version}/${target}`
    return `- [${basename(target)}](${url})${note ? `: ${note}` : ''}`
  }

  const docs = entries.filter((e) => !e.optional).map(render)
  const extra = entries.filter((e) => e.optional).map(render)
  const out = ['# warpline', '', `> ${description}`, '', '## Docs', '', ...docs]
  if (extra.length > 0) out.push('', '## Optional', '', ...extra)
  return `${out.join('\n')}\n`
}

if (import.meta.main) {
  const ROOT = join(import.meta.dir, '..')
  const OUT = join(ROOT, 'docs', 'llms.txt')
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    version: string
    description: string
  }
  const trackedDocs = execFileSync('git', ['ls-files', '-z', '--', 'docs/'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter((f) => f.endsWith('.md'))
  const text = llmsTxt(readFileSync(join(ROOT, 'docs', 'index.md'), 'utf8'), pkg.version, trackedDocs, pkg.description)

  if (process.argv.includes('--check')) {
    if (!existsSync(OUT) || readFileSync(OUT, 'utf8') !== text) {
      console.error('FAIL: docs/llms.txt is stale or missing; run bun run docs:generate')
      process.exit(1)
    }
    console.log(`OK: docs/llms.txt is current for v${pkg.version}`)
  } else if (process.argv.includes('--write')) {
    writeFileSync(OUT, text)
    const links = text.split('\n').filter((l) => l.startsWith('- [')).length
    console.log(`wrote docs/llms.txt (${links} links, v${pkg.version})`)
  } else {
    process.stdout.write(text)
  }
}
