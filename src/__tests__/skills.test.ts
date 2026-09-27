/**
 * Every tracked `SKILL.md` conforms to the Agent Skills rules (ADOC-05).
 *
 * The files are enumerated from `git ls-files`, filtered to a basename of
 * exactly `SKILL.md`, and never from a list of skill roots. A root list is a
 * coverage list someone has to remember to extend: the skills already sit in
 * three roots, and a fourth added tomorrow would be invisible to a glob that
 * names the first three. Zero tracked skills throws, because "found nothing"
 * must never read as "found nothing wrong".
 *
 * The rules are the union of two sources, and each check cites the one it
 * comes from:
 *
 * - the open Agent Skills specification (`SPEC_URL`), for the allowed keys and
 *   the `name`, `description`, `compatibility` and `metadata` rules;
 * - Anthropic's API rules, for the reserved words and the XML-tag ban:
 *   https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview
 *   https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices
 *   https://raw.githubusercontent.com/anthropics/skills/main/skills/skill-creator/scripts/quick_validate.py
 *
 * All three were fetched on 2026-09-27. `RULES_COMMIT` is the agentskills
 * commit the open spec was read at. When the upstream drift guard fires, the
 * rules here are re-read and `RULES_COMMIT` is bumped together with the
 * upstream hashes, never one without the other.
 *
 * Lengths are Unicode code points (`[...s].length`), never UTF-16 units: the
 * spec counts characters, and `s.length` counts a non-BMP character twice. The
 * boundary fixtures below are built from one, so a UTF-16 count turns them red.
 *
 * Where this check diverges from the reference validator (agentskills
 * `skills-ref`), it is on purpose and ours is the stricter side:
 *
 * - skills-ref parses with strictyaml, where every scalar is a string, so
 *   `name: 123` passes there as `"123"`. Here it is a non-string name.
 * - skills-ref coerces `metadata` values with `str()`. Here a non-string value
 *   is an offender, as the spec's "string keys to string values" says.
 * - skills-ref NFKC-normalises `name` and accepts Unicode `isalnum()`. Here the
 *   name is lowercase ASCII, matching Anthropic's "lowercase letters, numbers,
 *   and hyphens" and quick_validate's `^[a-z0-9-]+$`.
 * - Duplicate top-level keys are closed. YAML keeps the last one silently, and
 *   a second `name:` hiding behind the first is exactly what this check exists
 *   to see.
 *
 * Every helper takes a root and returns offender strings, so the same code runs
 * against the real repository (must be `[]`) and against a git-init'd fixture
 * under `tmpdir()` that is removed in a `finally`. Tests never write inside the
 * repository.
 */
import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..')

/** The agentskills commit the open spec was read at, fetched 2026-09-27. */
const RULES_COMMIT = '69ef37e9424c0a7ea9dd2293b559e43ec8176379'
const SPEC_URL = `https://github.com/agentskills/agentskills/blob/${RULES_COMMIT}/docs/specification.mdx`

/** The spec's frontmatter fields. Anything else is an offender. */
const ALLOWED_KEYS = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'])
const RESERVED_WORDS = ['anthropic', 'claude']

/** Four skills in three roots today. Fewer means the enumerator went blind. */
const SKILL_FLOOR = 4

/** Code points, never UTF-16 units. */
const cp = (s: string) => [...s].length

const isMapping = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

/** A minimal repository tracking `files`, built under `tmpdir()`. */
function repoFixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'warpline-skills-'))
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, dirname(rel)), { recursive: true })
    writeFileSync(join(root, rel), body)
  }
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['add', '-A'], { cwd: root })
  return root
}

/** Every tracked file whose basename is exactly `SKILL.md`, sorted. */
function skillFiles(root: string = REPO_ROOT): string[] {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter((p) => p.split('/').at(-1) === 'SKILL.md')
    .sort()
  if (files.length === 0) throw new Error(`could not look: no tracked SKILL.md under ${root}`)
  return files
}

/**
 * The frontmatter block, or null. Only a file that opens with `---` has one,
 * so a `---` rule further down the body is never mistaken for it. One BOM and
 * CRLF line endings are tolerated.
 */
function frontmatterOf(text: string): string | null {
  const body = text.startsWith('﻿') ? text.slice(1) : text
  if (!body.startsWith('---\n') && !body.startsWith('---\r\n')) return null
  const lines = body.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
  const close = lines.indexOf('---', 1)
  return close === -1 ? null : lines.slice(1, close).join('\n')
}

/** `path: reason` for every rule a tracked skill breaks. Never throws per file. */
function skillOffenders(root: string = REPO_ROOT): string[] {
  const offenders: string[] = []
  for (const path of skillFiles(root)) {
    const bad = (reason: string) => offenders.push(`${path}: ${reason}`)
    const dir = path.split('/').at(-2)
    if (dir === undefined) bad('no parent directory, so there is no name to match')

    const fm = frontmatterOf(readFileSync(join(root, path), 'utf8'))
    if (fm === null) {
      bad('missing frontmatter (the file must open with a --- block)')
      continue
    }

    const seen = new Set<string>()
    for (const line of fm.split('\n')) {
      const key = /^([^\s#][^:]*):/.exec(line)?.[1]
      if (key === undefined) continue
      if (seen.has(key)) bad(`duplicate key '${key}' (YAML keeps the last one silently)`)
      seen.add(key)
    }

    let data: unknown
    try {
      data = Bun.YAML.parse(fm)
    } catch {
      bad('frontmatter is not valid YAML')
      continue
    }
    if (!isMapping(data)) {
      bad('frontmatter is not a mapping')
      continue
    }

    // Allowed keys: SPEC_URL, "Frontmatter".
    for (const key of Object.keys(data)) if (!ALLOWED_KEYS.has(key)) bad(`unknown key '${key}'`)

    // name: SPEC_URL, "name field". 1-64 characters, lowercase alphanumerics and
    // hyphens, no leading, trailing or doubled hyphen, equal to its directory.
    const { name } = data
    if (name === undefined) bad('missing name')
    else if (typeof name !== 'string') bad('name must be a string')
    else {
      if (cp(name) < 1 || cp(name) > 64) bad(`name is ${cp(name)} characters (1-64)`)
      if (!/^[a-z0-9-]+$/.test(name)) bad('name may only hold lowercase letters, digits and hyphens')
      if (name.startsWith('-') || name.endsWith('-')) bad('name starts or ends with a hyphen')
      if (name.includes('--')) bad('name holds a doubled hyphen')
      if (dir !== undefined && name !== dir) bad(`name '${name}' does not match its directory '${dir}'`)
      // Reserved words: https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview
      for (const word of RESERVED_WORDS) if (name.toLowerCase().includes(word)) bad(`name holds the reserved word '${word}'`)
      // "Cannot contain XML tags": the overview and
      // https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices.
      // quick_validate.py lines 79-81 (see header) bans angle brackets in the
      // description only. Applying it to name is this repo's extension, and the
      // charset rule above already implies it.
      if (/[<>]/.test(name)) bad('name holds an angle bracket')
    }

    // description: SPEC_URL, "description field". 1-1024 characters, non-empty.
    // Blank is rejected like skills-ref's `not description.strip()`.
    const { description } = data
    if (description === undefined) bad('missing description')
    else if (typeof description !== 'string') bad('description must be a string')
    else {
      if (description.trim() === '') bad('description is blank')
      if (cp(description) > 1024) bad(`description is ${cp(description)} characters (max 1024)`)
      // Angle brackets: quick_validate.py lines 79-81, and the XML-tag ban above.
      if (/[<>]/.test(description)) bad('description holds an angle bracket')
    }

    // compatibility: SPEC_URL, "compatibility field". 1-500 characters if present.
    const { compatibility } = data
    if (compatibility !== undefined) {
      if (typeof compatibility !== 'string') bad('compatibility must be a string')
      else if (cp(compatibility) < 1 || cp(compatibility) > 500)
        bad(`compatibility is ${cp(compatibility)} characters (1-500)`)
    }

    // metadata: SPEC_URL, "metadata field". A map of string keys to string values.
    const { metadata } = data
    if (metadata !== undefined) {
      if (!isMapping(metadata)) bad('metadata is not a mapping')
      else
        for (const [k, v] of Object.entries(metadata))
          if (typeof v !== 'string') bad(`metadata value '${k}' must be a string`)
    }
  }
  return offenders
}

describe('every tracked skill conforms to the Agent Skills rules', () => {
  test('the four skills are enumerated from git, in three roots', () => {
    const files = skillFiles()
    expect(files).toEqual([
      'plugin-examples/skills/approve-review/SKILL.md',
      'plugin/skills/feed-triage/SKILL.md',
      'plugin/skills/needs-llm/SKILL.md',
      'skills/needs-llm-template/SKILL.md',
    ])
    expect(files.length).toBeGreaterThanOrEqual(SKILL_FLOOR)
  })

  test('the real repository has no offenders', () => {
    expect(skillOffenders()).toEqual([])
  })
})

describe('the skill rules can fail', () => {
  test('only a basename of exactly SKILL.md is enumerated', () => {
    const root = repoFixture({
      'ok/SKILL.md': '---\nname: ok\ndescription: Fine.\n---\n',
      'ok/extra/FOOSKILL.md': 'no frontmatter here\n',
    })
    try {
      expect(skillFiles(root)).toEqual(['ok/SKILL.md'])
      expect(skillOffenders(root)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('zero tracked skills throws instead of reading as clean', () => {
    const root = repoFixture({ 'README.md': 'nothing\n' })
    try {
      expect(() => skillFiles(root)).toThrow(/could not look/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  /** One non-BMP character: one code point, two UTF-16 units. */
  const E = '\u{1F600}'
  const DESC = 'description: Fine.'
  /** A one-skill repository whose frontmatter is `fm`, under `dir`. */
  const one = (fm: string, dir = 'ok') => ({ [`${dir}/SKILL.md`]: `---\n${fm}\n---\n\nbody\n` })
  /** A skill named `name` in a directory of the same name unless `dir` says otherwise. */
  const named = (name: string, dir = name) => one(`name: ${JSON.stringify(name)}\n${DESC}`, dir)

  // null: no offenders. A RegExp: some offender matches it. Matching one
  // reason, never the whole list, lets a fixture carry more than one.
  const rows: [string, Record<string, string>, RegExp | null][] = [
    ['name of 64 characters passes', named('a'.repeat(64)), null],
    ['description of 1024 non-BMP characters passes', one(`name: ok\ndescription: ${E.repeat(1024)}`), null],
    ['compatibility of 500 non-BMP characters passes', one(`name: ok\n${DESC}\ncompatibility: ${E.repeat(500)}`), null],
    ['string metadata passes', one(`name: ok\n${DESC}\nmetadata:\n  owner: x`), null],
    [
      'a BOM, CRLF endings and all six keys pass',
      {
        'full/SKILL.md':
          '﻿---\r\nname: full\r\ndescription: All six.\r\nlicense: Apache-2.0\r\ncompatibility: Needs git.\r\n' +
          'metadata:\r\n  owner: x\r\nallowed-tools: Bash Read\r\n---\r\n\r\nbody\r\n',
      },
      null,
    ],
    ['name of 65 characters fails', named('a'.repeat(65)), /name is 65 characters/],
    ['description of 1025 non-BMP characters fails', one(`name: ok\ndescription: ${E.repeat(1025)}`), /description is 1025 characters/],
    ['compatibility of 501 non-BMP characters fails', one(`name: ok\n${DESC}\ncompatibility: ${E.repeat(501)}`), /compatibility is 501 characters/],
    ['empty compatibility fails', one(`name: ok\n${DESC}\ncompatibility: ""`), /compatibility is 0 characters/],
    ['non-string compatibility fails', one(`name: ok\n${DESC}\ncompatibility: 5`), /compatibility must be a string/],
    ['missing frontmatter fails', { 'ok/SKILL.md': '# ok\n\nno frontmatter\n' }, /missing frontmatter/],
    ['frontmatter never closed fails', { 'ok/SKILL.md': `---\nname: ok\n${DESC}\n` }, /missing frontmatter/],
    ['empty frontmatter fails', { 'ok/SKILL.md': '---\n---\n\nbody\n' }, /frontmatter is not a mapping/],
    ['top-level list frontmatter fails', one(`- name: ok\n- ${DESC}`), /frontmatter is not a mapping/],
    ['invalid YAML fails', one(`name: [unclosed\n${DESC}`), /frontmatter is not valid YAML/],
    ['missing name fails', one(DESC), /missing name/],
    ['missing description fails', one('name: ok'), /missing description/],
    ['non-string name fails', one(`name: 123\n${DESC}`, '123'), /name must be a string/],
    ['uppercase and underscore in name fail', named('My_Skill'), /lowercase letters, digits and hyphens/],
    ['leading hyphen fails', named('-lead'), /starts or ends with a hyphen/],
    ['trailing hyphen fails', named('trail-'), /starts or ends with a hyphen/],
    ['doubled hyphen fails', named('dou--ble'), /doubled hyphen/],
    ['name not equal to its directory fails', named('mine', 'other'), /does not match its directory/],
    ["reserved word 'claude' fails", named('claude-helper'), /reserved word 'claude'/],
    ["reserved word 'anthropic' fails", named('my-anthropic-skill'), /reserved word 'anthropic'/],
    ['angle bracket in name fails', named('a<b>'), /name holds an angle bracket/],
    ['angle bracket in description fails', one('name: ok\ndescription: use <b>this</b>'), /description holds an angle bracket/],
    ['whitespace-only description fails', one('name: ok\ndescription: "   "'), /description is blank/],
    ['non-string description fails', one('name: ok\ndescription: 42'), /description must be a string/],
    ['non-string metadata value fails', one(`name: ok\n${DESC}\nmetadata:\n  v: 1.0`), /metadata value 'v' must be a string/],
    ['metadata as a list fails', one(`name: ok\n${DESC}\nmetadata:\n  - x`), /metadata is not a mapping/],
    ['unknown key fails', one(`name: ok\n${DESC}\nwhen_to_use: always`), /unknown key 'when_to_use'/],
    ['duplicate name key fails', one(`name: ok\nname: ok\n${DESC}`), /duplicate key 'name'/],
    ['root-level SKILL.md fails', { 'SKILL.md': `---\nname: ok\n${DESC}\n---\n` }, /no parent directory/],
  ]

  for (const [label, files, expected] of rows) {
    test(label, () => {
      const root = repoFixture(files)
      try {
        const offenders = skillOffenders(root)
        if (expected === null) expect(offenders).toEqual([])
        else expect(offenders).toContainEqual(expect.stringMatching(expected))
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  }
})
