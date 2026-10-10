/**
 * Every shipped example resolves the home inside its handler call.
 *
 * `AdvanceOptions.home` reaches a handler's call and not its module scope: a
 * module is evaluated once per process, outside any advance (runtime-spec § 1,
 * plugin-authoring "Resolve the home inside the handler"). The examples are
 * what authors copy, so none may call `warplineHome()` on a line at column 0,
 * which is where a module-scope value is declared. An indented call sits
 * inside a function. The fixture half shows the scan red.
 */
import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

const FIND = '/usr/bin/find'
const EXAMPLES = join(import.meta.dir, '..', '..', 'examples', 'plugins')
const TOP_LEVEL_HOME = /^\S.*\bwarplineHome\s*\(/

/** `<file>:<line>` for every line that calls `warplineHome()` at column 0. */
function topLevelReads(files: string[], root: string): string[] {
  return files.flatMap((file) =>
    readFileSync(file, 'utf-8')
      .split('\n')
      .flatMap((text, i) => (TOP_LEVEL_HOME.test(text) ? [`${relative(root, file)}:${i + 1}`] : [])),
  )
}

describe('examples resolve the home inside the handler call', () => {
  test('no shipped example plugin module calls warplineHome() at module scope', () => {
    const out = execFileSync(FIND, [EXAMPLES, '-name', '*.ts', '-not', '-name', '*.test.ts'], { encoding: 'utf8' })
    const files = out.split('\n').filter(Boolean)
    expect(files.length).toBeGreaterThan(20)
    // The rule has something to hold: examples do resolve the home.
    expect(files.some((f) => /\bwarplineHome\s*\(/.test(readFileSync(f, 'utf-8')))).toBe(true)
    expect(topLevelReads(files, EXAMPLES)).toEqual([])
  })

  test('the scan reports a module-scope read and passes one inside a function', () => {
    const dir = mkdtempSync(join(tmpdir(), 'warpline-home-at-call-'))
    try {
      const file = join(dir, 'handler.ts')
      writeFileSync(
        file,
        "const dir = join(warplineHome(), 'state')\nexport async function handler() {\n  return join(warplineHome(), 'x')\n}\n",
      )
      expect(topLevelReads([file], dir)).toEqual(['handler.ts:1'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
