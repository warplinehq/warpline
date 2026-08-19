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
