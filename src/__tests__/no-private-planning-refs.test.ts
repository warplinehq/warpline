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
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..')

/** This file necessarily contains the patterns it searches for. */
const SELF = 'src/__tests__/no-private-planning-refs.test.ts'

/**
 * Launch copy: gitignored, so `scan()` — which asks `git ls-files` — can never
 * see it, while every word in it is written to be published. The sentinel below
 * builds its own coverage.
 *
 * Enumerated by NAME under the planning root, not named one file at a time. A
 * hard-coded phase directory made "clean" and "did not look" indistinguishable
 * one level out from where the docstring above rejects it: archiving or
 * renaming the phase turns the whole check green while the draft still exists
 * and is still about to be published, and a second asset beside it — a tweet
 * thread, a launch email — was never covered and nothing said so.
 *
 * `DOCTRINE` is in the alternation for that reason rather than for today's
 * coverage: the doctrine draft is already named to match `LAUNCH`, so the token
 * buys nothing until somebody renames it. That rename is exactly the case the
 * paragraph above describes, and this is the most publication-bound prose in
 * the repository to lose out of every check it has.
 */
/**
 * The planning ROOT, not `.planning/phases`. Milestone close moves every phase
 * directory to `.planning/milestones/<version>-phases/` — so an anchor one
 * level down goes blind the moment a milestone ships, which is precisely when
 * the drafts matter most, because that is when they get posted. This turned
 * red at the v0.1 close on 2026-08-28 rather than passing vacuously, which is
 * the arrangement the empty-enumeration assertion below exists to produce.
 */
const PLANNING_ROOT = '.planning'
const LAUNCH_DRAFT = /-(SHOW-HN|LAUNCH|ANNOUNCE|DOCTRINE)[^/]*\.md$/

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

/**
 * A term is a LITERAL, not a pattern, and `\b` only anchors where it can.
 *
 * Interpolating a term raw fails three ways, and the first is silent — the one
 * property this guard must never have. `\b` before a non-word character needs a
 * preceding word character, so `@handle` or a term ending in `.` or `-` never
 * matches at a line start and the scan reports clean over a live leak. A term
 * containing `|` binds looser than the boundaries, mis-anchoring both halves.
 * A stray `(` or `+` throws in the RegExp constructor at module load, taking
 * the whole file — including the tests that need no local terms — with it.
 * Domains, handles and paths are exactly what a holder writes down.
 */
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const bounded = (t: string) =>
  `${/^\w/.test(t) ? '\\b' : ''}${esc(t)}${/\w$/.test(t) ? '\\b' : ''}`

const LOCAL_NAME = LOCAL_TERMS.length
  ? new RegExp(LOCAL_TERMS.map(bounded).join('|'), 'i')
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
  // `esc` for the same reason as above, and more urgently: a term that reads as
  // a pattern here would redact the wrong span — or throw — on the one code
  // path whose job is to keep the term out of a public CI log. No boundaries:
  // redaction must cover every occurrence, including inside a longer word.
  return LOCAL_TERMS.reduce((acc, t) => acc.replace(new RegExp(esc(t), 'gi'), REDACTED), line)
}

function scan(): Map<string, string[]> {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
  const files = new Set(tracked.filter((f) => !BINARY.test(f)))
  files.delete(SELF)

  const hits = new Map<string, string[]>()
  for (const file of files) {
    const found: string[] = []

    // A filename is exactly as published as a line of content, is precisely
    // what survives a content sweep (rename-and-forget), and is already in
    // hand — the scan had it and never looked at it. Line 0 because there is
    // no line: the name itself is the offender. The redacted path is repeated
    // into the message body so the no-exceptions test below, which reads
    // everything after the first `: `, sees the hit too rather than the whole
    // finding resting on SWEEP_BACKLOG staying empty.
    if (PRIVATE_NAME.test(file) || LOCAL_NAME?.test(file)) {
      found.push(`${redact(file)}:0: private deployment name in the file path — ${redact(file)}`)
    }

    // `git ls-files` reports the INDEX, not the working tree. A file removed
    // with plain `rm`, a path not yet written during a conflicted merge or an
    // interrupted rebase, a skip-worktree/sparse-checkout entry, or a tracked
    // dangling symlink all give an index entry with nothing to read. This runs
    // in the describe body, so an ENOENT here took all six tests down with it
    // — the guard unavailable in precisely the mid-operation states where a
    // contributor is most likely to be moving files around. Loud, but the same
    // outcome as not looking. Any other error still throws.
    let text: string
    try {
      text = readFileSync(join(REPO_ROOT, file), 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      // The name is still an offender when the content is unreachable — do not
      // drop a path hit already found just because the body cannot be read.
      if (found.length > 0) hits.set(file, found)
      continue
    }

    const lines = text.split('\n')
    // `redact(file)` here too: a path carrying a local term would otherwise
    // print it verbatim into a public CI log, which is the one thing the
    // redaction invariant above exists to prevent.
    found.push(
      ...lines.flatMap((line, i) =>
        PLANNING_REF.test(line) || PRIVATE_NAME.test(line) || LOCAL_NAME?.test(line)
          ? [`${redact(file)}:${i + 1}: ${redact(line.trim())}`]
          : [],
      ),
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
   * The real term list is gitignored, so synthetic shapes are the only ones
   * this repo can check — and the shapes are the whole point: a holder writes
   * down domains, handles and paths, not tidy words. Raw `\b`-wrapping fails
   * every case below SILENTLY, which is the one way this guard must never
   * fail.
   */
  test('a term that is not a plain word is still matched, literally and whole', () => {
    // term, a line it must match, a line it must NOT match
    const CASES: [string, string, string][] = [
      ['@handle', 'ping @handle now', 'ping handles now'],
      ['acme.io', 'see acme.io for more', 'see acmexio for more'],
      ['a|b', 'x a|b y', 'x b y'],
      ['frob(', 'call frob( here', 'call frobs here'],
      ['plain', 'a plain word', 'plainly not'],
    ]
    const offenders = CASES.flatMap(([term, hit, miss]) => {
      // Throws here rather than asserting if `esc` stops escaping — which is
      // the import-time failure mode, so surfacing it as a test is the point.
      const re = new RegExp(bounded(term), 'i')
      return [
        ...(re.test(hit) ? [] : [`${term}: silently missed \`${hit}\``]),
        ...(re.test(miss) ? [`${term}: over-matched \`${miss}\``] : []),
      ]
    })
    expect(offenders).toEqual([])
  })

  /**
   * Launch drafts are gitignored, so `scan()` cannot reach them — and they are
   * the files written entirely for publication. A term that lands in one leaks
   * the moment it is pasted into a submission.
   *
   * The skip is anchored to the planning ROOT, and an empty enumeration under
   * it is a failure rather than a skip. That is the only arrangement in which
   * "clean" and "did not look" stay distinguishable: the root is absent exactly
   * when the check is meaningless (CI, a fresh clone — .gitignore excludes
   * `.planning/`) and present exactly when it is meaningful, while a holder
   * whose tree contains no draft at all has moved or renamed one, not cleaned
   * up. Matching by name rather than by path also covers the second asset
   * nobody thought to add here.
   *
   * `.private-terms` is asserted for the same reason one level down: LOCAL_TERMS
   * degrades silently to `[]` when the file is missing, so a holder with the
   * drafts and no terms file would get a green scan that checked nothing.
   *
   * Deliberately NOT applied: PLANNING_REF. It matches a phase number, and a
   * draft necessarily carries one — a guaranteed false red trains its reader to
   * ignore the guard, which is worse than no guard. Offenders report bare
   * `file:line` with no content at all, not `redact()`ed content: a draft is
   * unpublished prose that may contain anything, and CI logs are public.
   */
  test('every gitignored launch draft carries no private deployment name', () => {
    const root = join(REPO_ROOT, PLANNING_ROOT)
    if (!existsSync(root)) return

    const drafts = readdirSync(root, { recursive: true })
      .map(String)
      .filter((f) => LAUNCH_DRAFT.test(f))

    expect(drafts).not.toEqual([])
    expect(LOCAL_NAME).not.toBeNull()

    const offenders = drafts.flatMap((draft) =>
      readFileSync(join(root, draft), 'utf8')
        .split('\n')
        .flatMap((line, i) =>
          PRIVATE_NAME.test(line) || LOCAL_NAME?.test(line)
            ? [`${PLANNING_ROOT}/${draft}:${i + 1}`]
            : [],
        ),
    )
    expect(offenders).toEqual([])
  })

  test('the sweep backlog has no stale entries', () => {
    const stale = [...SWEEP_BACKLOG].filter((file) => !hits.has(file))
    expect(stale).toEqual([])
  })
})
