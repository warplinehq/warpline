# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Mock artboards for the Board are static, self-contained HTML (throwaway,
gitignored under `.impeccable/`). The Board's production stack is deliberately
undecided until the 0.2 build plan; the runtime it serves is TypeScript on Bun
or Node 22+, and the Board must read the warpline home's files without a
database.

## Users

**Primary — the operator.** One person running a real fleet of warpline
plugins daily for a small business: recurring pulls, monitoring, content and
report generation, outreach sequencing. They open the Board for two reasons,
in this order: a plugin produced something they are about to use (read it,
lift it out, put it where it is used), and something is waiting on their
decision (see what it will *do*, say yes, no, or later). They are at a
keyboard, on the machine warpline runs on.

**Secondary — the fresh adopter.** Someone who has just installed warpline,
has no plugins, no state and no history, and is deciding whether to write a
first plugin. Their needs are staged after the operator's and never blended
in (docs/board-spec.md § 9).

## Product Purpose

Warpline is a deterministic plugin runtime with LLM-judgment dispatch and
side-effect approval gates. Deterministic work runs on a schedule and costs
nothing; judgment work is handed off as a typed contract; nothing with a
declared side effect executes without a human saying yes. The Board is the
operator surface over a running warpline home: where Outputs are consumed and
Asks are answered. Success for the Board is that the operator can truthfully
be told "nothing went out that you didn't sanction since *t*" and "*n* things
are waiting, oldest *y* old", and act on both in one place.

## Positioning

Autonomy levels in warpline are *dispatch* autonomy — whether the scheduler
may start a plugin unasked — never permission to act on the world. A plugin
with a declared side effect is gated at every autonomy level, including
`autonomous`, and a run cannot widen its own grant. Neighbouring schedulers
and agent frameworks treat approval as a mode; here it is the boundary.

## Operating Context

- Everything lives under one home directory (`WARPLINE_HOME` or `.warpline/`):
  `state/events.jsonl`, `state/acknowledgements.json`, engine state, `runs/`,
  `preferences.json`, `.session-approval`. The Board reads these files; the
  engine writes them; the two never share a process or stdout.
- The CLI is the incumbent surface: `warpline plan`, `warpline approve`,
  `warpline revoke`, `warpline scaffold`, plus the repo-only
  `src/cli/board-cli.ts` (`status`, `tasks`, `ack`, `ack-all`, `defer`).
- `[needs-llm]` handoffs are picked up by a Claude Code companion skill; the
  Board shows them as delegated Runs, it does not execute them.
- Quiet hours (default 22:00–07:00) suppress notification and execution.

## Capabilities and Constraints

- Objects and vocabulary are fixed by docs/board-spec.md § 2: Plugin, Run,
  Output, Ask (kinds `approval`, `decision`, `notice`, `chore`), Grant. The
  names *dashboard*, *noticeboard* and *task board* are retired.
- Five places, breadboarded in docs/board-spec.md § 3: Board, Ask, Output,
  Run, Plugin.
- The Board is web on loopback only (`127.0.0.1`), state changes are
  token-guarded POSTs, and there is no remote or multi-user story.
- A push channel (transport undecided) carries Asks and the truthful sentence
  to the operator when away; it never carries an approve action.
- Approval Asks expire with the grant ceiling (24h from first issue unless
  `--long`); defer options never outlive the expiry; answering an expired Ask
  is refused and said.
- Light and dark themes are both required at ship, not a later addition.
- Runtime gaps the Board depends on are listed in docs/board-spec.md § 7
  (no `denied` outcome, no run id on Asks, Output not yet data, gated →
  approved path unimplemented). Mocks may show these states; the build may
  not claim them until the runtime has them.

## Brand Commitments

- Name: **warpline**, lower-case, type-set only. No logo or wordmark exists;
  do not invent one.
- Voice: the README's register is binding for UI copy — terse, declarative,
  doctrine-forward, no marketing register. Copy says what the system did or
  will do, never what it "helps" with.
- Licence Apache-2.0; public repository; docs published at
  warplinehq.github.io/warpline.

## Evidence on Hand

- Six fresh-written example plugins in `examples/plugins/` — `feed-monitor`,
  `feed-triage`, `anomaly-watch`, `github-poll`, `metrics-rollup`,
  `anomaly-issue` — are the demonstration data source for mocks. Runs,
  Outputs and Asks shown in mocks are synthetic, derived from those
  manifests, and labelled as such.
- Real run artifacts, events and approval files are produced by the test
  suite (`src/**/__tests__`) and can be generated locally; none are checked in.
- No customers, testimonials, benchmarks or usage numbers exist. Do not
  fabricate any.

## Product Principles

1. The boundary holds: the surface never makes a side effect easier to
   sanction than the CLI does — one gate, one code path.
2. Say what it will do before offering the verb; never render an approve
   control without the declared side effects beside it.
3. Truthful states everywhere: computed sentences, honest empties, stated
   lag; a blank panel or an asserted "all clear" is a defect.
4. Operator-first, adopter staged: design from the one real daily user, list
   what the newcomer needs separately, never dilute the first for the second.
5. The output is the point: the thing a plugin produced is read and taken
   away in one move; everything else on the Board is in service of that or
   of the decision waiting.

## Accessibility & Inclusion

No external standard has been set. Product-derived requirements: every
answer verb (approve, deny, choose, seen, done, defer) is keyboard-reachable
and keyboard-completable; state is never conveyed by colour alone (severity
and Ask kind carry a glyph or label); both themes meet readable contrast for
long-form Output reading.
