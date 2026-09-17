---
title: The deterministic / LLM boundary
diataxis: explanation
---

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

- A plugin that hands judgment work to the LLM declares it in its manifest,
  with `llm_handoff: true`. The free-text `capabilities` list is informational
  and the runtime never reads it. Deterministic plugins MUST NOT spawn Claude.
- The runtime enforces the handoff half. A plugin that returns a `[needs-llm]`
  handoff without the declaration is refused: its run is recorded `failed` with
  an error naming the field, and it is never retried. The other half, that a
  plugin never calls a model inline, is convention. The runtime cannot see a
  model call inside a handler that returns `success`, so review, and reading
  the plugins you run, are what hold it.
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
23-hour ceiling is anchored at **first issue**, not at the latest grant.
Anchored at the latest, a loop calling `approve --ttl 4h` every hour would walk
the window forward forever and a "4-hour" approval would never expire. A second
absolute clock fixed at first issue is what every renewable-credential system
pairs with renewal (Kerberos `renew_till`, Vault `max_ttl`), and it is the only
part of the grant a renewal cannot move.

The corollary is a prohibition on warpline's own code: nothing reachable from a
run writes the grant file. `checkApproval` — the only function the engine calls
— opens it read-only, so neither the engine nor the scheduler renews a
permission on a plugin's behalf. That is a property of the call graph, not a
sandbox: handlers are imported in-process and run with the operator's full user
rights, so the gate bounds the effects a plugin *declares*, not what untrusted
code could do. Run plugins you have read.

Approval is session-scoped, not per-action: one decision covers the plugins you
name for a bounded window, instead of a prompt in front of every write. A
prompt per action looks stricter and is weaker — it trains the operator to
click through, and a gate that has trained its operator to click through is
worse than no gate at all, because it costs attention and buys a signature
nobody read. Deciding once, with the whole due-set in view, is the version that
stays meaningful, and the operator conclusion follows: a run can be
granted up front and left unattended.

What that costs you is a clock. The default expiry is four hours, which is the
shape of a working session — approve, watch the first cycle, get on with
something else. Renewing does not buy an unbounded window: every
`warpline approve` is capped at the 23-hour ceiling measured from the first
grant, unless a live grant already runs past it — the ceiling refuses to hand
out more time, it never takes back time you hold, so one earlier `--long` window
survives every later plain approve until it expires or you revoke.
Genuinely multi-day unattended operation is therefore something you have
to ask for, with `warpline approve <plugin> --ttl <dur> --long`, and the command
reports on stdout when a grant crosses the ceiling — the window you actually
hold is never something you have to infer.

Format and exact merge rules: `docs/runtime-spec.md` § 9.

## The ledger: legible before it runs

The run is legible before it happens, and the judgment work is legible before
it is picked up. Two surfaces carry that, at two moments:

| Surface | Moment | Shows |
|---|---|---|
| `warpline plan` | before the run | which plugins are due, in what order, their declared side effects and whether a grant covers them, and which plugins may hand judgment to the LLM |
| the `[needs-llm]` handoff | after the run, before an LLM picks it up | one task sentence plus a pre-resolved context payload |

Side-Effect Approval above rests on the first surface. Deciding once, with the
whole due-set in view, is possible only because the due-set is printed first.

These are enforced, not intended:

- `warpline plan` and an advance can disagree "in one direction only"
  ([runtime-spec.md](runtime-spec.md), § 10 `plugin_runs`). A preview may show
  a plugin due that the advance then skips. It never leaves out a plugin the
  advance runs, because a human approves side effects on the strength of what
  the preview showed. Pinned by `plan.test.ts` Test 2b.
- On the board, "What it will do is shown before the verb": no approve control
  renders without the plugin's declared side effects
  ([board-spec.md](https://github.com/warplinehq/warpline/blob/main/docs/board-spec.md)).
- The plugin pre-resolves everything computable before it hands off, so the
  LLM gets a decision to make and not a scavenger hunt
  ([needs-llm-contract.md](needs-llm-contract.md), rule 3).

The plan shows both halves. It lists side effects and their approval state,
and, under a plugin declaring `llm_handoff: true`, a line saying that plugin
may hand judgment to the LLM. The declaration is enforced: a handoff from a
plugin that did not declare it is refused.

The limit is what the ledger can see. It shows what a plugin declares and what
the runtime refuses. It cannot show a model call made inline inside a handler,
so "no inline model" stays convention, held by review.

## Why the plugin hands off instead of calling a model

- **The seam narrows the prompt-injection blast radius.** Plugins process
  untrusted input — feeds, mail, scraped pages. A model inside an unattended
  plugin is an injection surface holding that plugin's privileges: hostile
  content becomes instructions becomes action, on a schedule, with nobody
  watching. The handoff removes models from the unattended path entirely.
  Something still has to read the hostile text, and it is a model — that
  exposure is real and does not vanish. What the seam does is bound it: the
  scanner reads only in-home paths, and every warpline-mediated side effect
  still passes the approval gate, so the worst injection can achieve through
  warpline is a bad judgment file. What warpline cannot bound is the
  consumer session's own authority — that belongs to the harness it runs in.
  Run automated consumers least-privilege: read the home, write judgment
  files, nothing else. The claim is *relocates and narrows*, never
  *prevents*.
- **Determinism keeps the retry contract sound.** A delegated handoff is
  never retried; re-running the plugin re-derives it if the work is still
  outstanding. That is only safe because a re-run reproduces the same dedup
  keys, the same cadence math, the same item list. A model inside the plugin
  makes every re-run derive different work, and parked-work reconciliation
  quietly stops meaning anything.
- **Auditability** — deterministic plugins produce identical output for
  identical input; the judgment work is quarantined where it can be reviewed.
- **The boundary stays inspectable** — a plugin that hands off says so in its
  manifest (`llm_handoff: true`), and `warpline plan` prints that declaration
  before anything runs. A handoff from a plugin that did not declare it is
  refused. A model call inside a handler stays invisible to the runtime, so
  "no inline model" is a review convention, not a check. The handoff itself is
  visible in every run artifact.
- **The consumer is whoever you have.** The contract names a status and a
  payload path. Anything that reads them can consume the handoff: an
  interactive Claude Code session, a headless invocation under cron, an
  API-billed worker, another harness entirely. The runtime itself carries no
  model dependency, so the judgment half rides whatever the operator already
  pays for — a subscription session happens to be the cheapest for a solo
  operator, and nothing in the design assumes it.
