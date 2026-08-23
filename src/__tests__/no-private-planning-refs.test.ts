/**
 * Guards the repo against references to the private predecessor's planning
 * system and deployment.
 *
 * Two distinct classes, with different rules:
 *
 *   1. Opaque planning identifiers (decision IDs, threat IDs, phase numbers).
 *      They resolve to nothing a reader of this repo can reach. Harmless in
 *      isolation, corrosive in bulk. The tree is now clean, so SWEEP_BACKLOG is
 *      empty and must stay that way: it exists as a ratchet for a partial
 *      sweep, and adding an entry to it is how a regression gets normalised.
 *      This covers this repo's own `.planning/` identifiers too — that
 *      directory is gitignored and never ships, so `T-02-15` is exactly as
 *      unreachable to a reader as the predecessor's `D-14`.
 *
 *   2. Private deployment specifics — domain names, plugin names, skill names
 *      belonging to the closed-source deployment this runtime was extracted
 *      from. No backlog and no exceptions: these are a leak, not archaeology.
 *
 * Why this is a test and not a lint script: `bun test` is the command CI runs
 * and the one the contributor guide names, so the check cannot be skipped by
 * forgetting a second command. See .planning/notes/docs-automation-and-diataxis.md.
 */
import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..')

/** This file necessarily contains the patterns it searches for. */
const SELF = 'src/__tests__/no-private-planning-refs.test.ts'

/**
 * The launch-copy draft and the directory that vouches for it.
 *
 * The draft is gitignored, so `scan()` — which asks `git ls-files` — can never
 * see it, while every word in it is written to be published. The sentinel below
 * builds its own coverage.
 */
const PHASE_DIR = '.planning/phases/06-launch-assets'
const DRAFT = `${PHASE_DIR}/06-SHOW-HN.md`

/**
 * Scan EVERY tracked text file, from `git ls-files` rather than a glob list.
 *
 * This was a hand-maintained list of globs, and it silently under-covered:
 * .github/, scripts/ and test-utils/ were never scanned, so the test reported
 * green over 26 references it had simply not looked at. A check whose coverage
 * is a list someone has to remember to extend reads as "clean" when it means
 * "did not look" — the two are indistinguishable from the outside, which is the
 * one property a guard must not have. Asking git removes the choice.
 */
const BINARY = /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|pdf|zip|lock)$/i

/** Class 1 — opaque identifiers from the private planning system. */
const PLANNING_REF = /\b(?:D|T|INTG|OBS|EVD)-\d+(?:-\d+)*\b|\bPhase \d+\b/

/**
 * Class 2 — names belonging to the private deployment. `epc` is deliberately
 * matched only as a whole word: it is an Energy Performance Certificate feed,
 * not a generic term, and a substring match would fire on unrelated words.
 */
const PRIVATE_NAME = new RegExp(
  [
    // API feeds the closed deployment happened to call
    'companies-house', 'ch-client', 'epc', 'posthog', 'hogql', 'supabase', 'govuk',
    // its plugin and skill names
    'intel-(?:brief|scan|report)', 'today-aggregator', 'content-kanban',
    'outreach-(?:drafts|generator)', 'collateral-(?:import|discover)',
    'hypothesis-gen', 'experiment-checker', 'seo-audit',
    // its capability vocabulary, and the repos themselves
    'gsc_\\w+', 'graphify',
  ].map((p) => `\\b${p}\\b`).join('|'),
  'i',
)

/**
 * Class 2b — terms too sensitive to write down here. This file is tracked and
 * published, so a literal in the list above would itself be the thing it
 * guards against. Such terms live one per line in gitignored `.private-terms`,
 * read at runtime, never committed.
 *
 * Absent file means an empty list, so a fresh clone and CI stay green rather
 * than failing on something a contributor cannot supply. That is a real
 * coverage hole and it is the deliberate trade: the terms cannot be published
 * to close it. Whoever holds the file is the one who runs the check.
 */
const LOCAL_TERMS: string[] = (() => {
  try {
    return readFileSync(join(REPO_ROOT, '.private-terms'), 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('#'))
  } catch {
    return []
  }
})()

const LOCAL_NAME = LOCAL_TERMS.length
  ? new RegExp(LOCAL_TERMS.map((t) => `\\b${t}\\b`).join('|'), 'i')
  : null

/**
 * Empty, and meant to stay empty. Only ever populate this to ratchet down a
 * sweep already in progress; never to admit a new reference.
 */
const SWEEP_BACKLOG = new Set<string>([
])

/**
 * A failing assertion prints its offenders, and CI logs are public — so a local
 * term must never reach the message. Reporting `file:line` with the term masked
 * still tells whoever holds `.private-terms` exactly where to look.
 */
const REDACTED = '<redacted>'

function redact(line: string): string {
  return LOCAL_TERMS.reduce((acc, t) => acc.replace(new RegExp(t, 'gi'), REDACTED), line)
}

function scan(): Map<string, string[]> {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
  const files = new Set(tracked.filter((f) => !BINARY.test(f)))
  files.delete(SELF)

  const hits = new Map<string, string[]>()
  for (const file of files) {
    const lines = readFileSync(join(REPO_ROOT, file), 'utf8').split('\n')
    const found = lines.flatMap((line, i) =>
      PLANNING_REF.test(line) || PRIVATE_NAME.test(line) || LOCAL_NAME?.test(line)
        ? [`${file}:${i + 1}: ${redact(line.trim())}`]
        : [],
    )
    if (found.length > 0) hits.set(file, found)
  }
  return hits
}

describe('no private planning or deployment references', () => {
  const hits = scan()

  test('no file outside the sweep backlog carries a planning reference', () => {
    const offenders = [...hits].filter(([file]) => !SWEEP_BACKLOG.has(file)).flatMap(([, lines]) => lines)
    expect(offenders).toEqual([])
  })

  test('no file carries a private deployment name — no backlog, no exceptions', () => {
    const offenders = [...hits.values()]
      .flat()
      .filter((line) => {
        // The line is already redacted, so LOCAL_NAME can no longer match it —
        // the marker redact() left behind is what stands in for that hit.
        const text = line.slice(line.indexOf(': ') + 2)
        return PRIVATE_NAME.test(text) || text.includes(REDACTED)
      })
    expect(offenders).toEqual([])
  })

  /**
   * SELF is exempt from the scan above because it necessarily spells out every
   * pattern it hunts for — so anything placed here is invisible to the check
   * that lives here. LOCAL_TERMS is the one list with no business appearing in
   * this file, so it is checked against SELF too and the exemption cannot
   * swallow it.
   */
  test('this file does not itself carry a local private term', () => {
    if (LOCAL_NAME === null) return
    const offenders = readFileSync(join(REPO_ROOT, SELF), 'utf8')
      .split('\n')
      .flatMap((line, i) =>
        LOCAL_NAME.test(line) ? [`${SELF}:${i + 1}`] : [],
      )
    expect(offenders).toEqual([])
  })

  /**
   * The launch-copy draft is gitignored, so `scan()` cannot reach it — and it is
   * the one unpublished file written entirely for publication. A term that lands
   * in it leaks the moment it is pasted into a submission.
   *
   * The skip is anchored to the phase DIRECTORY, not to the draft's own absence.
   * Keyed on the draft, this block would read green precisely when the draft had
   * gone missing — "clean" and "did not look" would again be indistinguishable
   * from the outside, which is the failure the docstring above already argues
   * against for the old glob list. The directory is present exactly when the
   * check is meaningful: never on CI or a fresh clone (.gitignore excludes
   * `.planning/`), always on the machine holding the draft.
   *
   * `.private-terms` is asserted for the same reason one level down: LOCAL_TERMS
   * degrades silently to `[]` when the file is missing, so a holder with the
   * draft and no terms file would get a green scan that checked nothing.
   *
   * Deliberately NOT applied: PLANNING_REF. It matches a phase number, and the
   * draft necessarily carries one — a guaranteed false red trains its reader to
   * ignore the guard, which is worse than no guard. Offenders report bare
   * `file:line` with no content at all, not `redact()`ed content: the draft is
   * unpublished prose that may contain anything, and CI logs are public.
   */
  test('the launch-copy draft carries no private deployment name', () => {
    if (!existsSync(join(REPO_ROOT, PHASE_DIR))) return

    expect(existsSync(join(REPO_ROOT, DRAFT))).toBe(true)
    expect(LOCAL_NAME).not.toBeNull()

    const offenders = readFileSync(join(REPO_ROOT, DRAFT), 'utf8')
      .split('\n')
      .flatMap((line, i) =>
        PRIVATE_NAME.test(line) || LOCAL_NAME?.test(line) ? [`${DRAFT}:${i + 1}`] : [],
      )
    expect(offenders).toEqual([])
  })

  test('the sweep backlog has no stale entries', () => {
    const stale = [...SWEEP_BACKLOG].filter((file) => !hits.has(file))
    expect(stale).toEqual([])
  })
})
