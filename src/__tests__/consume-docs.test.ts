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

/** A runtime-spec region, from one exact heading line to the next. Throws when either is gone or doubled. */
function specRegion(from: string, to: string): string {
  const lines = read('docs/runtime-spec.md').split('\n')
  const at = (h: string) => {
    const hits = lines.flatMap((l, i) => (l === h ? [i] : []))
    if (hits.length !== 1) throw new Error(`blind: ${hits.length} lines read "${h}", expected exactly 1`)
    return hits[0] as number
  }
  return lines.slice(at(from), at(to)).join('\n')
}

/** Recipe step 4, from its heading to step 5. */
function recipeStep4(): string {
  const s = recipeSection()
  const start = s.indexOf('4. **Add exactly two sudoers rules**')
  const end = s.indexOf('5. **Turn it on.**')
  if (start === -1 || end <= start) throw new Error('blind: recipe step 4 or step 5 heading is gone')
  return s.slice(start, end)
}

const pamTrusted = (who: string) =>
  `On Linux, sudo's PAM session for ${who} may set names from machine-wide files such as \`/etc/environment\` and \`/etc/default/locale\`. A file can add a name consume did not pass, or replace a value consume passed. PAM env files are trusted input to the judge, like sudoers, and consume cannot filter them.`

/** Every paragraph in `raw` that opens the PAM statement, whitespace-collapsed. */
function pamParagraphs(raw: string): string[] {
  return raw
    .split(/\n\s*\n/)
    .map((p) => flat(p).trim())
    .filter((p) => p.startsWith("On Linux, sudo's PAM session for"))
}

describe('the PAM paragraphs say the files are trusted input and name no remedy', () => {
  test('§ 17 The command. says the PAM env files are trusted input, in one paragraph and no more', () => {
    expect(pamParagraphs(specRegion('### Tools and run_as', '### Running it'))).toEqual([pamTrusted('`run_as`')])
  })

  test('recipe step 4 says the PAM env files are trusted input, in one paragraph and no more', () => {
    expect(pamParagraphs(recipeStep4())).toEqual([pamTrusted('the judge')])
  })

  test('§ 17 Tools and run_as carries no env_keep and no Defaults line', () => {
    const raw = specRegion('### Tools and run_as', '### Running it')
    expect(raw).toContain("sudo's PAM session for `run_as`")
    expect(raw).not.toContain('env_keep')
    expect(raw.split('\n').filter((l) => /^\s*Defaults\b/.test(l))).toEqual([])
  })

  test('the recipe consumer section carries no env_keep and no Defaults line', () => {
    const raw = recipeSection()
    expect(raw).toContain("sudo's PAM session for the judge")
    expect(raw).not.toContain('env_keep')
    expect(raw.split('\n').filter((l) => /^\s*Defaults\b/.test(l))).toEqual([])
  })

  test('§ 17 step 4 states its early-exit outcome once, without the deleted gloss', () => {
    const text = flat(specRegion('### The pass', '### Three locks'))
    expect(text.split('decided as for any other exit').length - 1).toBe(1)
    expect(text).toContain(
      'by then are decided as for any other exit. A process the child started is not signalled by consume and may outlive the try, even an answered one.',
    )
    expect(text).not.toContain('So a complete answer')
  })
})

describe('the --bare credential names ANTHROPIC_AUTH_TOKEN where it is promised', () => {
  test('the recipe --bare bullet names the token and keeps no-keychain', () => {
    const text = flat(recipeSection())
    expect(text).toContain(
      "- **`--bare` never reads the `claude` login.** The `claude-code` renderer runs `claude -p --bare`, which never reads the keychain or the login `claude` stores. So `consume` needs `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or Bedrock or Vertex credentials (`CLAUDE_CODE_USE_BEDROCK` or `CLAUDE_CODE_USE_VERTEX` with that cloud's own variables), in its environment. Put an `ANTHROPIC_AUTH_TOKEN` in the 0600 file, as you would the key. If the token is an OAuth access token, it expires, and the file needs a current one before each run.",
    )
    expect(text).toContain('The environment file holds the credential and nothing else:')
    expect(text).not.toContain('cannot use a subscription login')
  })

  test("doctrine's consume paragraph names the token beside the API key", () => {
    const text = flat(read('docs/doctrine.md'))
    expect(text).toContain(
      'Its headless call never reads the keychain or the `claude` login, so it needs a credential in its environment: an API key, an `ANTHROPIC_AUTH_TOKEN` or cloud provider credentials.',
    )
    expect(text).not.toContain('cannot use a subscription login')
  })

  test('llms.txt makes no ANTHROPIC_AUTH_TOKEN credential claim', () => {
    expect(read('docs/llms.txt')).not.toContain('ANTHROPIC_AUTH_TOKEN')
  })
})
