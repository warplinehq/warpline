/**
 * Every place the shipped code deletes or renames a file, counted per file.
 *
 * The audit store's retention is never. Nothing may delete, move or rewrite a
 * file under `<home>/audit/`, and the way to keep a delete away from it is to
 * know every place that deletes at all. A new one anywhere turns this red, and
 * whoever adds it has to say which directory it reaches before the map moves.
 *
 * **Scope is what ships.** Every non-test `.ts` file under `src/` and
 * `examples/`. Tests are left out because they clean up their own temp dirs
 * all day, and none of that reaches a real home.
 *
 * **Counts per file, not line numbers.** An edit near a delete would churn a
 * line pin for nothing. A count only moves when a delete is added or removed.
 * Set equality on the whole map means a file that LOSES a site reddens too.
 *
 * **What counts.** A call named `unlink`, `rm`, `rmdir`, `rename`, `truncate`
 * or `ftruncate`, with or without `Sync`, and a `.delete()` with no argument,
 * which is Bun's file delete. A Map's `delete(key)` takes an argument and is
 * not counted. Lines whose text starts with `*` or `//` are dropped first, so
 * a comment that names a delete is not one.
 *
 * **What this cannot see.** A delete imported under another name
 * (`unlink as u`), reached through a computed property (`fs['unlink']`), or
 * written with a space before its paren. None appears here today.
 *
 * `/usr/bin/find` picks the files and `/usr/bin/grep` picks the lines, both
 * by absolute path. The bare names resolve to a tool here that honours ignore
 * files, and it has returned a false zero over this repository before.
 */
import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..')

const FIND = '/usr/bin/find'
const GREP = '/usr/bin/grep'

const DELETION = String.raw`\b(unlink|rm|rmdir|rename|truncate|ftruncate)(Sync)?\(|\.delete\([[:space:]]*\)`
const COMMENT = /^\s*(\*|\/\/)/

/** The measured budget. A change here is a decision about where a delete may live. */
const EXPECTED: Record<string, number> = {
  'src/board/state-manager.ts': 2,
  'src/cli/scaffold.ts': 2,
  'src/lib/audit-log.ts': 2,
  'src/lib/fs-atomic.ts': 3,
  'src/lib/jsonl-logger.ts': 1,
  'src/lib/preferences.ts': 1,
  'src/runtime/approval-gate.ts': 1,
  'src/runtime/lock.ts': 1,
  'src/runtime/run-artifacts.ts': 2,
  'src/runtime/run-log-store.ts': 2,
}

/**
 * Every non-test `.ts` file under `src/` and `examples/`. An empty result
 * throws: an enumeration that found nothing did not look, and an empty map
 * from it would be wrong in a way that only a careful reader would notice.
 */
function sourceFiles(): string[] {
  const out = execFileSync(
    FIND,
    [
      join(REPO_ROOT, 'src'),
      join(REPO_ROOT, 'examples'),
      '-name',
      '*.ts',
      '-not',
      '-path',
      '*__tests__*',
      '-not',
      '-name',
      '*.test.ts',
    ],
    { encoding: 'utf8' },
  )
  const files = out.split('\n').filter(Boolean)
  if (files.length === 0) throw new Error('blind: no non-test source file enumerated under src or examples')
  return files
}

/**
 * Deletion sites per file in `files`, keyed by path relative to `root`. Takes
 * the list rather than computing it, so the same code runs on the real tree
 * and on a temp-dir fixture.
 */
function deletionSites(files: string[], root: string): Record<string, number> {
  let out: string
  try {
    out = execFileSync(GREP, ['-H', '-n', '-E', DELETION, ...files], { encoding: 'utf8' })
  } catch (err) {
    // 1 is "no match", which is an empty map. Anything else is a real failure.
    if ((err as { status?: number }).status === 1) return {}
    throw err
  }
  const counts: Record<string, number> = {}
  for (const hit of out.split('\n').filter(Boolean)) {
    const m = /^(.*?):(\d+):(.*)$/.exec(hit)
    if (m === null) throw new Error(`unparsed grep line: ${hit}`)
    const [, file, , text] = m as unknown as [string, string, string, string]
    if (COMMENT.test(text)) continue
    const rel = file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file
    counts[rel] = (counts[rel] ?? 0) + 1
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
}

function fixture(files: Record<string, string>): { dir: string; paths: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'warpline-audit-deletion-'))
  const paths = Object.entries(files).map(([name, body]) => {
    const p = join(dir, name)
    writeFileSync(p, body)
    return p
  })
  return { dir, paths }
}

describe('every deletion site in shipped code is counted', () => {
  test('the real tree holds exactly the measured sites, file by file', () => {
    expect(deletionSites(sourceFiles(), REPO_ROOT)).toEqual(EXPECTED)
  })

  test('the enumeration reaches the store and the examples', () => {
    const enumerated = sourceFiles().map((f) => f.slice(REPO_ROOT.length + 1))
    expect(enumerated).toContain('src/lib/audit-log.ts')
    expect(enumerated.some((f) => f.startsWith('examples/'))).toBe(true)
  })

  test('the same helper names a planted delete, rmSync and a Bun file delete, and skips a comment', () => {
    const { dir, paths } = fixture({
      'kept.ts': 'await unlink(a)\nawait unlink(b)\n',
      'intruder.ts': 'export async function f(p: string) {\n  await unlink(p)\n}\n',
      'commented.ts': '// await unlink(p)\nconst m = new Map()\nm.delete(key)\n',
      'sync.ts': 'rmSync(p)\n',
      'bun.ts': 'await Bun.file(p).delete()\n',
    })
    try {
      expect(deletionSites(paths, dir)).toEqual({
        'bun.ts': 1,
        'intruder.ts': 1,
        'kept.ts': 2,
        'sync.ts': 1,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the same helper reports a file that lost a site', () => {
    const { dir, paths } = fixture({ 'kept.ts': 'await unlink(a)\n' })
    try {
      const found = deletionSites(paths, dir)
      expect(found).toEqual({ 'kept.ts': 1 })
      expect(found).not.toEqual({ 'kept.ts': 2 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the search binaries are absolute paths', () => {
    expect([FIND, GREP]).toEqual(['/usr/bin/find', '/usr/bin/grep'])
  })
})
