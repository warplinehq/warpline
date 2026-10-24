/**
 * Doctrine and the scheduler recipe name `warpline consume`, the consumer that
 * ships outside the engine, and show how to run it with less privilege.
 *
 * These pins are positive on purpose. The sentence "the engine enforces no
 * inline model" was never in this repository, so a check that only asserts its
 * absence is green before any doc changes and proves nothing about them. The
 * absence check stays, as a completeness pin, beside the positive ones that do
 * the work.
 *
 * Doc prose wraps at any word, so every match runs on whitespace-collapsed
 * text. The recipe pins are scoped to the one section that documents the
 * consumer, found by its heading, so a phrase elsewhere in the page cannot
 * satisfy them; that heading is also pinned, because a renamed heading moves
 * the anchor other pages link to.
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf-8')
const flat = (s: string) => s.replace(/\s+/g, ' ')

const RECIPE_HEADING = '## Running the automated judgment consumer with less privilege'

/** The recipe's consumer section, heading to the next `## `. Throws when the heading is gone or doubled. */
function recipeSection(): string {
  const lines = read('docs/scheduler-recipe.md').split('\n')
  const hits = lines.flatMap((l, i) => (l === RECIPE_HEADING ? [i] : []))
  if (hits.length !== 1) throw new Error(`blind: ${hits.length} lines read "${RECIPE_HEADING}", expected exactly 1`)
  const start = hits[0] as number
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## '))
  return lines.slice(start, end === -1 ? undefined : end).join('\n')
}

describe('the docs name the shipped consumer', () => {
  test('doctrine names the consumer warpline ships outside the engine', () => {
    const text = flat(read('docs/doctrine.md'))
    expect(text).toContain('`warpline consume`')
    expect(text).toContain('outside the engine')
    // The guard file that turns the engine half into a check, by name.
    expect(text).toContain('`no-model-in-engine.test.ts`')
    // The review convention now covers a model call in a plugin handler, and no wider.
    expect(text).toContain('inside a plugin handler')
    expect(text).not.toContain('so "no inline model" stays convention, held by review')
    expect(text).not.toContain('"no inline model" is a review convention, not a check')
  })

  test('no doc carries the v0.1 inline-model sentence outside a retirement note', () => {
    const files = [
      ...readdirSync(join(REPO_ROOT, 'docs'))
        .filter((f) => f.endsWith('.md'))
        .map((f) => `docs/${f}`),
      'README.md',
    ]
    // Both essays sit in docs/; an enumeration that missed them would read clean without looking.
    expect(files).toContain('docs/why-the-gate-holds.md')
    expect(files).toContain('docs/derive-dont-store.md')
    expect(files).toContain('docs/doctrine.md')

    const offenders: string[] = []
    for (const file of files) {
      // A paragraph, not a line: a sentence wrapped across a line break is still the sentence.
      for (const para of read(file).split(/\n\s*\n/)) {
        const p = flat(para).toLowerCase()
        if (p.includes('the engine enforces no inline model') && !p.includes('retired')) offenders.push(file)
      }
    }
    expect(offenders).toEqual([])
  })

  test('the scheduler recipe shows the least-privilege consume run', () => {
    const raw = recipeSection()
    const text = flat(raw)
    expect(text).toContain('`warpline consume`')
    expect(text).toContain('verbatim to the configured provider')
    expect(text).toContain('exact served model id')

    // The home, and the operator's OS home, closed to the judge.
    expect(text).toContain('chmod 700')
    expect(text).toContain('chmod 700 ~')

    // Credentials: no subscription login under --bare, the two variables, a 0600 file, never argv.
    expect(text).toContain('--bare')
    expect(text).toContain('ANTHROPIC_API_KEY')
    expect(text).toContain('WARPLINE_CONSUME_API_KEY')
    expect(text).toContain('0600')
    expect(text).toContain('never on the command line')

    // The tool opt-in is a trust grant over the provider credential.
    expect(text).toContain('Opting a plugin into tools is a trust grant')
    expect(text).toContain('dedicated, spend-limited key')

    // The two sudoers rules: names passed with --preserve-env, SETENV on claude, plain on test.
    expect(text).toContain('--preserve-env')
    expect(text).toContain('NOPASSWD:SETENV:')
    const rules = raw.split('\n').filter((l) => l.includes('ALL=('))
    expect(rules.length).toBeGreaterThanOrEqual(2)
    for (const rule of rules) {
      // One absolute binary, no argument pattern, no wildcard, no env program.
      expect(rule.trim()).toMatch(/^\S+ ALL=\(\S+\) NOPASSWD:(SETENV:)? \/\S+$/)
      expect(rule).not.toContain('*')
      expect(rule).not.toMatch(/\/env$/)
    }
    expect(rules.filter((r) => r.includes('NOPASSWD:SETENV:') && /\/claude$/.test(r.trim()))).not.toEqual([])
    expect(rules.filter((r) => /NOPASSWD: \/(usr\/)?bin\/test$/.test(r.trim()))).not.toEqual([])
  })
})
