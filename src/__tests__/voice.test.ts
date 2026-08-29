/**
 * Guards the register of the prose documents written in the first person.
 *
 * The problem this catches: a document can be factually correct, pass every
 * spec check and every code review, and still not sound like the person whose
 * name is on it. Accuracy review does not test voice, so voice regressions
 * survive every other gate in the project and surface only when a human reads
 * the published page. That happened once, to the whole of
 * `docs/why-the-gate-holds.md`, and re-fixing it by hand each time it drifts is
 * not a plan.
 *
 * What is asserted here is only the measurable part of the register — sentence
 * length, contraction rate, and two punctuation marks that pull prose toward a
 * formal written voice the author does not have. None of that adds up to "reads
 * well"; a document can satisfy every threshold below and still be lifeless.
 * The thresholds are a floor against silent drift, not a definition of good
 * writing, and CONTRIBUTING.md § Voice carries the parts a test cannot check.
 *
 * Why this is a test and not a lint script: same reason as
 * `no-private-planning-refs.test.ts` — `bun test` is the command CI runs and
 * the one the contributor guide names, so the check cannot be skipped by
 * forgetting a second command.
 *
 * Scope is an explicit allow-list, not a glob over `docs/`. The reference specs
 * and the README are deliberately still in the formal register and would fail
 * these thresholds today; widening this list is a separate piece of work, not
 * something to be done accidentally by a glob.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..')

/**
 * First-person prose held to the author's register.
 *
 * NOT included, on purpose: `README.md` and the reference specs
 * (`board-spec.md`, `runtime-spec.md`, `needs-llm-contract.md`,
 * `plugin-authoring.md`, `first-plugin.md`, `doctrine.md`). Reference material
 * arguably earns a flatter register, and converting them is tracked separately.
 * Add a file here only together with the edit that makes it pass.
 */
const VOICED_DOCS = ['docs/why-the-gate-holds.md']

/**
 * Thresholds sit deliberately loose of where the prose currently measures, so
 * an ordinary edit does not turn red. They catch drift back toward the
 * pre-pass register (median 19, 5.4 contractions per 1k, 20 em dashes), not
 * normal variation.
 */
const MAX_MEDIAN_SENTENCE_WORDS = 16
const MAX_LONG_SENTENCE_SHARE = 0.22
const LONG_SENTENCE_WORDS = 25
const MIN_CONTRACTIONS_PER_1K = 20

/**
 * Strips everything that is not authored prose: frontmatter, fenced code,
 * headings, HTML comments (the verification-notes block is reference material,
 * not prose), and link targets — a URL is not a sentence, and its punctuation
 * is not the author's.
 */
function prose(markdown: string): string {
  return markdown
    // `g` without `m`, deliberately. CodeQL reads a non-global multi-character
    // replace as an incomplete sanitizer (js/incomplete-multi-character-
    // sanitization), and the flag costs nothing here: `^` without `m` can only
    // match at index 0, so this still strips exactly one leading block and the
    // extracted prose is byte-identical either way.
    //
    // Adding `m` too would satisfy the same alert and quietly break the file:
    // `---` on its own line is also a markdown horizontal rule, so a doc with a
    // pair of them would have the prose BETWEEN them deleted before it was
    // measured. The voice numbers would stay green while measuring less text,
    // which is the one failure mode a register check must not have.
    .replace(/^---\n[\s\S]*?\n---\n/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^#{1,6} .*$/gm, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`[^`]*`/g, 'X')
}

function sentenceWordCounts(text: string): number[] {
  return text
    .replace(/\n/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1)
    .map((s) => s.split(/\s+/).length)
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

describe('voice register of first-person prose', () => {
  for (const rel of VOICED_DOCS) {
    describe(rel, () => {
      const text = prose(readFileSync(join(REPO_ROOT, rel), 'utf8'))
      const counts = sentenceWordCounts(text)
      const words = text.split(/\s+/).filter(Boolean).length

      test('sentences stay short enough to read as speech', () => {
        expect(median(counts)).toBeLessThanOrEqual(MAX_MEDIAN_SENTENCE_WORDS)
      })

      test('few sentences run past the point of losing the reader', () => {
        const long = counts.filter((n) => n > LONG_SENTENCE_WORDS).length
        expect(long / counts.length).toBeLessThanOrEqual(MAX_LONG_SENTENCE_SHARE)
      })

      test('contractions appear at the rate the author actually speaks', () => {
        const n = (text.match(/\b\w+['’](?:s|t|re|ve|ll|d|m)\b/g) ?? []).length
        expect((1000 * n) / words).toBeGreaterThanOrEqual(MIN_CONTRACTIONS_PER_1K)
      })

      /**
       * Both marks are absent from the author's own writing and dense in
       * LLM-drafted prose, which makes them the cheapest available signal that
       * a passage was generated rather than written. An em dash is nearly
       * always a comma, a full stop, or a rewrite.
       */
      test('no em dashes', () => {
        expect(text).not.toInclude('—')
      })

      test('no semicolons', () => {
        expect(text).not.toInclude(';')
      })
    })
  }
})
