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

/**
 * This file necessarily contains the patterns it searches for, and so does the
 * committed list it now reads them from. Both are exempt from `scan()` for the
 * same reason: without the exemption each one matches every pattern it carries
 * and the guard goes permanently red on itself. Both are still checked against
 * LOCAL_TERMS by the test below, so the exemption cannot become the one place a
 * local term is free to sit.
 */
const SELF = 'src/__tests__/no-private-planning-refs.test.ts'
const PATTERN_FILE = '.github/private-names.txt'

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
 *
 * The list lives in `.github/private-names.txt` rather than inline here because
 * `scripts/scan-public-surfaces.sh` needs the identical set and reads it with
 * `grep -E`. Two hand-maintained copies drift and nothing says so; one tracked
 * file cannot. Entries are REGEX FRAGMENTS, not literals, so they never go
 * through `esc()` — the grouped alternations and the `gsc_` character class
 * have to keep working as patterns.
 *
 * An absent or empty list THROWS at module load rather than degrading to an
 * empty alternation. An empty pattern matches nothing, so the whole file would
 * report silently, perfectly green, which is the one thing this guard must
 * never be.
 */
const PRIVATE_NAME_PATTERNS: string[] = (() => {
  let text: string
  try {
    text = readFileSync(join(REPO_ROOT, PATTERN_FILE), 'utf8')
  } catch {
    throw new Error(
      `${PATTERN_FILE} is unreadable; it is the committed deployment-name list this guard scans for`,
    )
  }
  const patterns = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'))
  if (patterns.length === 0) {
    throw new Error(`${PATTERN_FILE} yielded no patterns; an empty list is a guard that cannot fail`)
  }
  return patterns
})()

const PRIVATE_NAME = new RegExp(PRIVATE_NAME_PATTERNS.map((p) => `\\b${p}\\b`).join('|'), 'i')

/**
 * Both forms below are legal in a JavaScript `RegExp` and fatal, or worse than
 * fatal, under the release workflow's `grep -E`. A non-capturing group makes
 * GNU grep error out, so the release gate is red on every invocation. A
 * backslash shorthand class is a GNU and JavaScript extension with no POSIX
 * equivalent, and a strict engine compiles it cleanly and then matches nothing
 * — the gate is green because it never looked.
 *
 * Plain string checks, deliberately, and never a shell-out to a regex engine:
 * the CI shards run a different `awk` and a different `grep` from a developer
 * machine, and each of those accepts at least one of the two forms, so a
 * delegated assertion passes vacuously on the exact defect it names.
 *
 * Takes lines rather than reading the file, so it can be pointed at a scratch
 * copy and watched to fail.
 */
function unportablePatterns(lines: string[]): string[] {
  return lines.flatMap((raw, i) => {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) return []
    return [
      ...(line.includes('(?') ? [`line ${i + 1}: a non-capturing group, which GNU grep -E rejects`] : []),
      ...(/\\[A-Za-z]/.test(line)
        ? [`line ${i + 1}: a backslash shorthand class, which POSIX ERE has no equivalent for`]
        : []),
    ]
  })
}

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
 * The two commits that spell out the deployment specifics in the act of
 * removing them. History is immutable here — CLAUDE.md rule 5 forbids a
 * force-push to main — so neither message can ever be corrected, and a scan
 * over the whole history has to exempt them by SHA or be red forever.
 *
 * By SHA, and exactly these two, rather than a range: a range would also
 * exempt every commit that happens to sit between them. The staleness test
 * below is what stops the ratchet outliving its cause. Like SWEEP_BACKLOG this
 * set exists to record a finished cleanup, never to admit a new reference — a
 * hit outside it is a finding to report, not an entry to add.
 */
const SCRUB_COMMITS = new Set<string>([
  '596599793c0ac3fc050670fbc25679bbe661c85a',
  '4a6aca3a6f49b58ba824bc6aaab4f43305490dbe',
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
  files.delete(PATTERN_FILE)

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

/**
 * Every commit reachable from HEAD, as `{ sha, message }` pairs.
 *
 * A NUL field separator rather than a line-based format: a commit body carries
 * newlines and blank lines of its own, so any newline-delimited format
 * re-splits the very message it is trying to deliver.
 *
 * A shallow clone THROWS. `git log` in a depth-1 checkout reports one commit
 * and exits 0, so the scan would report clean over history it never saw —
 * "did not look" rendering as "clean", which is the one property a guard in
 * this repository must not have. CI checks this repo out with `fetch-depth: 0`
 * for exactly this reason.
 */
function readCommits(): { sha: string; message: string }[] {
  const shallow = execFileSync('git', ['rev-parse', '--is-shallow-repository'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim()
  if (shallow !== 'false') {
    throw new Error(
      'shallow clone: the commit-message scan would report clean over history it cannot see. Run `git fetch --unshallow`, or check out with fetch-depth: 0.',
    )
  }

  const raw = execFileSync('git', ['log', '--format=%H%x00%B%x00'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })

  const parts = raw.split('\0')
  const commits: { sha: string; message: string }[] = []
  for (let i = 0; i + 1 < parts.length; i += 2) {
    // git separates records with a newline, so every field after the first
    // arrives with it attached.
    const sha = (parts[i] ?? '').trim()
    if (sha !== '') commits.push({ sha, message: parts[i + 1] ?? '' })
  }
  return commits
}

/**
 * Offenders as `<short sha>:<line number>` and NOTHING else. A commit message
 * may contain anything and CI logs are public, so no content reaches the
 * output — the same rule the gitignored-draft test follows one level down.
 *
 * PLANNING_REF is deliberately NOT applied here. It matches a bare phase
 * number, and 18 commit messages in this repository carry one, so applying it
 * would be a guaranteed false red. A guard that is red on arrival trains its
 * reader to ignore it, which is worse than no guard — the failure mode the
 * launch-draft test's own docstring already names.
 *
 * Takes the commits rather than reading them, so a synthetic message goes
 * through the identical code path the real scan uses.
 */
function commitMessageOffenders(commits: { sha: string; message: string }[]): string[] {
  return commits.flatMap(({ sha, message }) =>
    message
      .split('\n')
      .flatMap((line, i) =>
        PRIVATE_NAME.test(line) || LOCAL_NAME?.test(line) ? [`${sha.slice(0, 7)}:${i + 1}`] : [],
      ),
  )
}

describe('no private planning or deployment references', () => {
  const hits = scan()
  const commits = readCommits()

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
   * SELF and PATTERN_FILE are exempt from the scan above because each one
   * necessarily spells out every pattern it hunts for — so anything placed in
   * either is invisible to the check that lives here. LOCAL_TERMS is the one
   * list with no business appearing in either, so both are checked against it
   * and neither exemption can swallow a term written in by mistake.
   */
  test('neither exempted file itself carries a local private term', () => {
    if (LOCAL_NAME === null) return
    const offenders = [SELF, PATTERN_FILE].flatMap((rel) =>
      readFileSync(join(REPO_ROOT, rel), 'utf8')
        .split('\n')
        .flatMap((line, i) => (LOCAL_NAME.test(line) ? [`${rel}:${i + 1}`] : [])),
    )
    expect(offenders).toEqual([])
  })

  /**
   * The rule that stops the NEXT pattern added to the committed list from being
   * fine here and fatal in the release workflow. Without it the four entries
   * rewritten when the list moved out of this file are a one-time correction
   * rather than something enforced.
   */
  test('every committed pattern is portable to POSIX ERE', () => {
    const lines = readFileSync(join(REPO_ROOT, PATTERN_FILE), 'utf8').split('\n')
    expect(unportablePatterns(lines)).toEqual([])
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

  /**
   * Commit messages are published the moment they are pushed and `git ls-files`
   * cannot reach them, so `scan()` above has never seen one. This is the first
   * of the three surfaces 09-05's prohibition text names and nothing detected.
   */
  test('no commit message outside the scrub commits names the deployment', () => {
    const offenders = commitMessageOffenders(commits.filter((c) => !SCRUB_COMMITS.has(c.sha)))
    expect(offenders).toEqual([])
  })

  /**
   * The test above is green because the history is clean, and a helper that
   * never looked would be green in exactly the same way. This is the half that
   * tells the two apart. The sample is taken from the committed list rather
   * than written out here, so the proof moves with the list.
   */
  test('the commit-message helper reports a message that does name it', () => {
    const plain = PRIVATE_NAME_PATTERNS.find((p) => /^[a-z][a-z-]*$/.test(p))
    expect(plain).toBeDefined()
    const synthetic = [{ sha: '0'.repeat(40), message: `chore: a synthetic subject naming ${plain}` }]
    expect(commitMessageOffenders(synthetic)).toEqual(['0000000:1'])
  })

  test('the scrub-commit exemption has no stale entries', () => {
    const stale = [...SCRUB_COMMITS].filter((sha) => {
      const commit = commits.find((c) => c.sha === sha)
      return commit === undefined || commitMessageOffenders([commit]).length === 0
    })
    expect(stale).toEqual([])
  })

  /**
   * Release notes are written to be pasted into a GitHub Release, so they are
   * as publication-bound as any launch draft and live under the same
   * gitignored root. Asserted on the name rather than on a file that may not
   * exist yet: the next version's notes must be covered before they are
   * written, not after.
   */
  test('a release-notes draft is inside the gitignored-draft scan', () => {
    expect(LAUNCH_DRAFT.test('09-05-RELEASE-NOTES.md')).toBe(true)
  })
})
