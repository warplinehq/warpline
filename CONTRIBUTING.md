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

## Licensing

Apache-2.0, inbound = outbound: submitting a PR certifies you may contribute
the code under the project license (Apache-2.0 §5). No CLA.
