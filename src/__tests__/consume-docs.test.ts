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

const pamAdd = (who: string, env: string) =>
  `On Linux, sudo's PAM session for ${who} may set names from machine-wide files such as \`/etc/environment\` and \`/etc/default/locale\`. Two cases change what the judge runs with. A file can add a name consume did not pass, such as an \`ANTHROPIC_BASE_URL\` that ${env} does not set. And for a name not in sudo's \`env_keep\`, a file can replace the value consume passed, even for the three \`CLAUDE_CODE_DISABLE_*\` settings consume sets to \`1\`. For the three settings and the provider, cloud and proxy variables consume may pass on, keeping the names out of those files stops both. A file can add any name, not only these, and the judge reads more than consume passes, such as \`CLAUDE_CODE_USE_FOUNDRY\` or a lowercase \`https_proxy\`. Keep every name \`claude\` reads out of those files.`
const pamKeep = (whose: string) =>
  `\`env_keep\` stops only the second case, because for a name in it sudo keeps the value consume passed but still adds the name when consume did not pass it. The three settings are always passed, so this line in ${whose} \`env_keep\` keeps each at \`1\`. It covers no other name`
const SETTINGS = 'CLAUDE_CODE_DISABLE_MODEL_ACCESS_FALLBACK CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'

/** No sentence offers both remedies as alternatives: none names `env_keep`, a file and `or` together, however it is worded. */
function joinedRemedies(text: string): string[] {
  return text.split(/(?<=[.:])\s+/).filter((s) => s.includes('env_keep') && /\bfiles?\b/.test(s) && /\bor\b/.test(s))
}

describe('the PAM paragraphs say which remedy stops which case', () => {
  test('§ 17 The command. carries both paragraphs, its fence unchanged, and no joined remedy', () => {
    const raw = specRegion('### Tools and run_as', '### Running it')
    const text = flat(raw)
    expect(text).toContain(pamAdd('`run_as`', "consume's environment"))
    expect(text).toContain(`${pamKeep("the operator's")}:`)
    expect(text).not.toContain('the ones consume passes')
    expect(text).not.toContain('so sudo keeps the passed value')
    expect(joinedRemedies(text)).toEqual([])
    // The line is unchanged, matched as a whole line.
    expect(raw.split('\n')).toContain(`Defaults:<operator> env_keep += "${SETTINGS}"`)
    // Each paragraph starts after a blank line, which collapsing would hide.
    expect(raw).toContain("\n\nOn Linux, sudo's PAM session for `run_as` may set")
    expect(raw).toContain('\n\n`env_keep` stops only the second case,')
  })

  test('recipe step 4 carries both paragraphs, says the line is optional, its fence unchanged', () => {
    const raw = recipeStep4()
    const text = flat(raw)
    expect(text).toContain(pamAdd('the judge', "the unit's environment"))
    expect(text).toContain(`${pamKeep('your')}. The line is optional and is not a sudoers rule:`)
    expect(text).not.toContain('the ones consume passes')
    expect(joinedRemedies(text)).toEqual([])
    expect(raw.split('\n')).toContain(`   Defaults:operator env_keep += "${SETTINGS}"`)
    expect(raw).toContain("\n\n   On Linux, sudo's PAM session for the judge may set")
    expect(raw).toContain('\n\n   `env_keep` stops only the second case,')
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
      "- **`--bare` never reads the `claude` login.** The `claude-code` renderer runs `claude -p --bare`, which never reads the keychain or the login `claude` stores. So `consume` needs `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or Bedrock or Vertex credentials (`CLAUDE_CODE_USE_BEDROCK` or `CLAUDE_CODE_USE_VERTEX` with that cloud's own variables), in its environment. Put an `ANTHROPIC_AUTH_TOKEN` in the 0600 file, as you would the key. An OAuth access token expires, so you supply a current one.",
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
