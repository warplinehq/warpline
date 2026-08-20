# Warpline: the deterministic / LLM boundary

> This document defines which operations are deterministic code and which require LLM judgment.
> Consult this before adding any new plugin or capability.

## Deterministic Code (no LLM)

These operations MUST be implemented as pure TypeScript — never route through an LLM:

| Category | Examples |
|----------|----------|
| Data fetching | API calls to analytics, error trackers, public registries |
| Data aggregation | Summing metrics, computing averages, counting leads by status |
| State transitions | Moving task state (pending -> active -> completed -> deferred) |
| Registry lookup | Finding a script by key, resolving plugin dependencies |
| Scheduling | Determining which plugins are due based on TTL and last_run |
| File I/O | Reading/writing state, events.jsonl, acknowledgements.json |
| Validation | Zod schema parsing for manifests, state, board events |
| Freshness checking | Comparing timestamps against TTL thresholds |
| Filtering | Applying lead qualification rules (HRB criteria, scoring) |
| Formatting | Rendering reports, composing email templates with known data |

## LLM Judgment (requires Claude)

These operations require reasoning, creativity, or context that code cannot provide:

| Category | Examples |
|----------|----------|
| Content generation | Writing blog posts, outreach messages, newsletter copy |
| Hypothesis formation | Proposing A/B test ideas from performance data patterns |
| Triage recommendations | Suggesting which board items deserve attention first |
| Qualitative analysis | Interpreting competitor positioning, assessing content quality |
| Strategy adjustment | Recommending playbook changes based on experiment results |
| Novel classification | Categorizing leads when scoring rules don't cover the case |
| Synthesis | Combining data from multiple sources into an intelligence brief |

## The Rule

> If you can write `if/else` or a `switch` for it, it's deterministic.
> If it needs "understanding" or "judgment", it's LLM.

## Enforcement

- Plugin manifests declare capabilities. Deterministic plugins MUST NOT spawn Claude.
- The engine validates: a plugin with `autonomy_level: 'autonomous'` and no LLM capability runs without Claude.
- Plugin review checklist: "Could this be a pure function?" If yes, it must be.

## Grey Areas

When unsure, default to deterministic with an escape hatch:
1. Implement the deterministic version first
2. Add a `--with-llm` flag that enhances with LLM reasoning
3. Track which path was taken in the run log

## Anti-Patterns

These are common mistakes that violate this boundary:

1. **Calling Claude to format data** — use template strings instead
2. **Using LLM to filter a list** — write the filter predicate in code
3. **LLM for threshold decisions** — use config values and comparison operators
4. **Non-deterministic scheduling** — all timing decisions must be in code, not prompted

## Side-Effect Approval

The boundary above says which decisions a machine may make. This says which
ones it may *act* on. A plugin declaring side effects does not run until a human
has approved it for this session, at any autonomy level, `autonomous` included.

Grants are additive and bounded. A human typing `approve b` after `approve a`
is re-authorizing: they are present, they know what they asked for, and losing
the earlier grant to the later one would be the surprise. The hazard is the
other case — a background process extending a window nobody is watching. So the
24-hour ceiling is anchored at **first issue**, not at the latest grant.
Anchored at the latest, a loop calling `approve --ttl 4h` every hour would walk
the window forward forever and a "4-hour" approval would never expire. A second
absolute clock fixed at first issue is what every renewable-credential system
pairs with renewal (Kerberos `renew_till`, Vault `max_ttl`), and it is the only
part of the grant a renewal cannot move.

The corollary is a prohibition: nothing reachable from a run may write the
grant file. The run path reads it and only reads it — so a plugin cannot extend
its own permission, and neither can the engine on its behalf.

Format and exact merge rules: `docs/runtime-spec.md` § 9.
