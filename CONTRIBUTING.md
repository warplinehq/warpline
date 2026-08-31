# Contributing

## Setup

Bun ≥ 1.3. `bun install`, then:

```bash
bun run test               # builds, then runs the suite
bun test                   # fine bare — do NOT add --timeout. The 20s default
                           # is set by setDefaultTimeout in __test_preload.ts,
                           # because bunfig's [test] timeout key is silently
                           # ignored and bun's own 5s flakes under contention
bun run typecheck          # bun green ≠ tsc green: bun transpiles WITHOUT
                           # typechecking, so run both before calling done
bun run verify:tarball     # packs, installs into a throwaway prefix and
                           # scaffolds a plugin — the six things a checkout
                           # cannot prove. Slow. See "Release gates" below
```

`bun test` needs `dist/` to exist — the example plugins import `warpline/*`
through the package exports map, which is the path a real consumer hits. The
preload fails with one actionable error if you forget; `bun run test` builds
for you.

## Testing rules (hard-won upstream; do not relearn them)

- **Never `mock.module()`** — it mutates the process-global module registry
  and leaks across test files. Use `spyOn(obj, 'method')`.
- **Spies live in describe-level `beforeEach`/`afterEach`**, not per-test —
  per-test `mockRestore()` leaks into the next test.
- **Tests never write outside temp dirs.** The preload re-roots default
  state/runs paths; if you add a module with default paths, give it an
  injectable seam and use it in tests.

## Conventions

- **Specs are contract surface**: changing run statuses, board events,
  manifest fields, or the `[needs-llm]` protocol updates the matching
  `docs/*.md` in the same commit.
- **Closed enums stay closed**: don't add event/status literals ad hoc — an
  enum addition fans out into exhaustive switches and docs. For a board
  event that doesn't fit, use `type: 'notice'` + `summary`.
- **Absence of observation must never render as absence of change.** A
  check that can't fetch, a store nobody writes, a skipped mode — each must
  LOOK different from "checked and fine". This is the project's founding
  operational lesson; new surfaces are reviewed against it.

## Release gates

Two gates run in `.github/workflows/release.yml` before `npm publish`, and both
live in a script rather than inline so the same logic can be exercised without
cutting a release. A guard nobody has watched fail is not a guard.

- **`bash scripts/verify-tarball.sh`**, or `bun run verify:tarball` — packs the
  tarball, installs it into a throwaway prefix and scaffolds a plugin from the
  installed bin. The scaffold defects it catches do not reproduce from a
  checkout, where warpline's own source is always reachable.
- **`bash scripts/scan-public-surfaces.sh`** — reads text on stdin and exits
  non-zero if it names the closed deployment this runtime was extracted from.
  The workflow pipes the Release title and body through it, because neither is
  reachable from `git ls-files` and so the guard in
  `src/__tests__/no-private-planning-refs.test.ts` cannot see them. Commit
  messages are the third such surface, and that test now scans them directly.

**A `npm deprecate` message goes through the scanner before it is sent.** It is
published prose with no review step, so it is the one remaining surface with no
gate of its own:

```bash
MESSAGE='deprecated: see https://github.com/warplinehq/warpline/releases'
printf '%s\n' "$MESSAGE" | bash scripts/scan-public-surfaces.sh \
  && npm deprecate warpline@0.0.0 "$MESSAGE"
```

## Voice

Applies to the prose documents written in the first person — today that's
`docs/why-the-gate-holds.md`. Reference specs and the README are still in a
flatter register and are exempt until converted.

The measurable half is enforced by `src/__tests__/voice.test.ts`, so it fails in
CI rather than in review: no em dashes, no semicolons, median sentence at most
16 words, at most 22% of sentences over 25 words, at least 20 contractions per
1000 words. Those are a floor against drift, not a definition of good writing.

The half a test can't check:

- **Write it the way you'd say it.** If you wouldn't say "it is not", don't
  write it. This is the single biggest tell, and it's why the rate above is
  enforced rather than suggested.
- **Open on the claim, not on an article.** "The first rule is older than the
  gate and much duller: if you can write an `if/else` for it, it is code" buries
  the point behind a preamble. Lead with the rule, comment on it afterwards.
- **Skip the balanced antithesis.** "Recorded as delegated rather than failed",
  "the highest-risk combination rather than the lowest" — one is fine, six in a
  document reads as a rhetorical tic. Plain "not" usually does the same work.
- **No elided-verb comparatives.** "Older than the gate, and duller" is a
  written figure nobody says out loud.
- **Ground the abstract in the concrete immediately**, and prefer the plain word
  to the industry one.
- **State the limit before you're asked.** A claim that names what it doesn't
  cover is worth more than one that doesn't.

The point isn't stylistic preference. Accuracy review, spec review and code
review all pass a document that reads as though nobody wrote it, so voice is the
one property in this repo that no other gate catches.

## What to expect

- **Response** — you get an acknowledgement within a few days, on issues and
  pull requests alike. Security reports take priority over everything else;
  [SECURITY.md](SECURITY.md) says how to send one privately. That is the only
  window this project promises anywhere, deliberately: a stated response time
  that gets missed reads as abandonment, which is worse than the one commitment
  already in writing.
- **The plugin contract is pre-1.0** — it is best-effort and may change in any
  0.x release. Pin the version you tested against, and read the release notes
  for the version you move to. The mechanics — what is safe to add, what can
  break you, and why closed enums stay closed — are in
  [docs/runtime-spec.md](docs/runtime-spec.md#contract-stability). That warning
  is stated in both places on purpose: the published package ships `docs/` but
  not this file, so a plugin author who installed from npm never reads
  CONTRIBUTING, and a contributor who opens CONTRIBUTING may never open the
  spec.

## Licensing

Apache-2.0, inbound = outbound: submitting a PR certifies you may contribute
the code under the project license (Apache-2.0 §5). No CLA.
