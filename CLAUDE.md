# Warpline

Deterministic plugin runtime with LLM-judgment dispatch and side-effect
approval gates. Apache-2.0. Bun runtime, TypeScript + Zod. This repo is
self-governed: work is tracked in GitHub issues/milestones/releases here —
NOT in any other repo's planning system.

## Commands

```bash
bun test --timeout 20000    # ALWAYS pass the flag: bun's 5s default flakes
                            # ~3% under CPU contention; bunfig [test] timeout
                            # is silently ignored. CI shards per src/ subdir.
bun run typecheck           # tsc --noEmit (strict; no noUncheckedIndexedAccess
                            # yet — raising strictness is a deliberate change)
```

## Layout

- `src/schemas/` — manifest, skill-result, board, run-log, lock, engine-state
- `src/runtime/` — invoke-plugin, run-artifacts, approval-gate, engine, tier, staleness
- `src/board/` — engine-events, state-manager, board-cli
- `src/lib/` — fs-atomic, lock-healing, jsonl-logger, api-budget, preferences, paths
- `docs/` — doctrine, runtime-spec, board-spec, needs-llm-contract, plugin-authoring
- `examples/plugins/` — fresh-written examples; never port private plugins here

## Rules

1. **Specs are contract surface.** A change to run statuses, board events,
   manifest fields, or the [needs-llm] protocol MUST update the matching
   `docs/*.md` in the same commit.
2. **Tests never write outside temp dirs.** `__test_preload.ts` re-roots
   state/runs via `WARPLINE_STATE_DIR`/`WARPLINE_RUNS_DIR`-style env before
   paths evaluate; its state-manager import is DYNAMIC on purpose (static
   imports hoist above the env set — do not "clean it up").
3. **`warplinehq/warpline-attic` is permanently private.** It holds the
   pre-rewrite object store. Never flip it, never pull from it, never push
   to it.
4. **`npm-stub/` reserves the bare npm name.** Delete it in the same change
   as the first real `npm publish` (flip `private`, add files whitelist +
   repository/bugs fields).
5. **History stays stable once public** — no force-pushes to main; the
   flip-day ruleset enforces it (see EXTRACTION-NOTES.md checklist).

## Release / launch

Flip-day checklist: EXTRACTION-NOTES.md. Launch tracking: the "v0.1 public
launch" GitHub milestone.
