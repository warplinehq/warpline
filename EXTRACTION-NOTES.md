# Extraction notes

Warpline was extracted in August 2026 from the private automation engine that
has run one company's marketing operations since early 2026. The extraction
was fresh-history: files were copied and genericised, never migrated, and the
source system's operational data (its intel, outreach, and state directories)
never entered this repository.

What made the cut — and what deliberately did not:

- **Extracted:** the plugin runtime (manifests, retry/timeout/AbortSignal, run
  artifacts), the side-effect approval gate, the engine (TTL freshness,
  dependency ordering, degradation tiers, quiet hours, review gate), the event
  board and task state manager, the hygiene layer (atomic writes, lock/state
  healing, JSONL logging, API budgets), and the boundary doctrine.
- **Left behind:** every domain plugin, the web dashboard (a candidate for a
  later release), and all operational data.
- **Fixed rather than ported:** the source engine resolved its default paths
  relative to its own source file, and its "derive preferences from the state
  directory" comment was never implemented (its tests silently read live
  preferences). Both are corrected here; both were reported back upstream.
- **Designed fresh at extraction:** the slim `EngineState` schema — derived
  from what the engine measurably uses, with strict per-entity `extensions`
  records instead of the source's domain fields — and the three example
  plugins, written from scratch against the public API.

The `[needs-llm]` contract, the `delegated` run status, and the
side-effects-gate-at-every-autonomy-level rule are behaviours the source
system earned operationally; docs/doctrine.md and docs/needs-llm-contract.md
carry the reasoning.

## Flip-day checklist (step 8, in order)

1. `gh repo edit warplinehq/warpline --visibility public --accept-visibility-change-consequences`
2. Immediately apply the history-stability ruleset (blocked on private repos —
   403 "make this repository public"): POST /repos/warplinehq/warpline/rulesets
   with non_fast_forward + deletion rules on refs/heads/main.
3. Enable private vulnerability reporting (Security tab) — SECURITY.md points
   people there.
4. Test `/plugin marketplace add warplinehq/warpline` from a clean Claude Code
   session.
5. `warplinehq/warpline-attic` (private) holds the pre-rewrite object store —
   NEVER flip it; delete it whenever (needs delete_repo scope:
   `gh auth refresh -h github.com -s delete_repo`).
6. First real npm release replaces the 0.0.0 name-stub: flip package.json
   `private`, add files whitelist + repository/bugs fields, delete npm-stub/.
