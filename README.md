# Warpline

> A deterministic plugin runtime where the LLM is a step you dispatch, not a
> capability the code carries around.

[![npm](https://img.shields.io/npm/v/warpline)](https://www.npmjs.com/package/warpline)
[![CI](https://github.com/warplinehq/warpline/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/warplinehq/warpline/actions/workflows/ci.yml)
[![Secret scan](https://github.com/warplinehq/warpline/actions/workflows/gitleaks.yml/badge.svg?branch=main)](https://github.com/warplinehq/warpline/actions/workflows/gitleaks.yml)
[![License](https://img.shields.io/github/license/warplinehq/warpline)](LICENSE)

Warpline runs the recurring work that keeps a business going, on a schedule.
Outbound sequencing, market research pulls, content pipelines, competitor
monitoring, lead qualification, report generation.

A plugin that declares a side effect (sending email, creating issues, writing
to a database, calling external APIs, modifying files) doesn't run without
explicit human session approval. That includes at `autonomous`, because the
autonomy level is *dispatch* autonomy. It decides whether the scheduler can
start a plugin without asking. It never decides whether that plugin can act on
the world without asking.

Blanket approval exists and it's deliberate. `warpline approve --all` writes a
wildcard grant. What it covers, what it prints before writing anything, when it
expires, and why a run can't widen its own scope:
[Can the gate be bypassed?](#can-the-gate-be-bypassed).

Published docs: [warplinehq.github.io/warpline](https://warplinehq.github.io/warpline/).

<!-- generated: plan-demo -->
```
warpline plan — preview only; nothing was executed.

Grant: none — plugins with side effects would be SKIPPED this run
Plugins: /tmp/warpline-demo/plugins

Due (8):

  announce-fanout (level 0)
    (no declared side effects)
  anomaly-watch (level 0)
    (no declared side effects)
  derived-summary (level 0)
    (no declared side effects)
  draft-writer (level 0)
    (no declared side effects)
  feed-triage (level 0)
    (no declared side effects)
  metrics-rollup (level 0)
    (no declared side effects)
  note-intake (level 0)
    (no declared side effects)
  daily-digest (level 1)
    (no declared side effects)

Not due (4):

  feed-monitor — skipped (unapproved): side effects require session approval
    external_api: ⚠ unapproved — would be SKIPPED this run
  github-poll — skipped (unapproved): side effects require session approval
    external_api: ⚠ unapproved — would be SKIPPED this run
  link-enrich — skipped (unapproved): side effects require session approval
    external_api: ⚠ unapproved — would be SKIPPED this run
  anomaly-issue — skipped (unapproved): side effects require session approval
    creates_issue: ⚠ unapproved — would be SKIPPED this run
    external_api: ⚠ unapproved — would be SKIPPED this run
```
<!-- /generated -->

## Quickstart

```bash
npm i warpline          # or: bun add warpline
npx warpline --help
```

Runs on Node 22.18+ or 23.6+ (`engines.node` excludes 23.0–23.5), or Bun ≥ 1.3.
Node alone is enough. You don't need Bun to use warpline. v0.1 supports POSIX
systems (macOS, Linux). Windows is untested and unclaimed.

Every file warpline reads or writes lives under one home directory: the
`WARPLINE_HOME` env var, else the nearest ancestor `.warpline/` directory,
else `<cwd>/.warpline`.

## What you get

- **Plugin runtime** — Zod-validated manifests; per-attempt timeouts; bounded
  retries with exponential backoff + jitter; `AbortSignal` threaded into your
  I/O; per-run artifacts (`runs/<id>.json` + captured log with attempt
  delimiters).
- **Side-effect approval gate** — a closed enum of side-effect types declared
  per plugin; declared effects gate execution behind `warpline approve`-style
  session approval, regardless of autonomy level.
- **Engine** — TTL freshness (skip work that is still fresh), dependency
  topological ordering, quiet hours, review gate, and idle-based degradation
  tiers (`normal → degraded → extended → suspended`).
- **Event board** — append-only `events.jsonl` + acknowledgements; tasks
  with ack / defer / complete states and severity-FIFO ordering.
- **The `[needs-llm]` contract** — plugins emit judgment work as a typed
  handoff; a Claude Code companion skill picks it up. Deterministic work costs
  nothing to run; judgment work uses your existing Claude subscription. See
  [docs/needs-llm-contract.md](docs/needs-llm-contract.md).

## Writing a plugin

A plugin is a directory under `<home>/plugins/<name>/` with two files:

```
my-plugin/
  manifest.ts   # export const manifest = PluginManifestSchema.parse({...})
  handler.ts    # export const handler: HandlerFn = async (manifest, args, signal) => SkillResult
```

The manifest declares what the plugin is allowed to do (side effects,
schedule, TTL, timeout, retries, minimum degradation tier). The handler does
the work and returns a structured `SkillResult`. Invalid manifests are a
hard-stop at load, so a misconfigured plugin never silently runs.

Worked examples in [examples/plugins/](examples/plugins/):

| Example | Demonstrates |
| --- | --- |
| `anomaly-watch` | Compare against a prior observation — reads the record it wrote last run, reports what newly breached and what cleared, and returns the breached set as an Output |
| `github-poll` | `external_api` side effect gating an autonomous plugin; writes one snapshot of what it polled and reports the delta on the next run |
| `feed-monitor` | Deterministic fetch/parse that reports new entries — the producer half of the feed chain; the judgment handoff is `feed-triage`'s, not this one's |
| `feed-triage` | The `on_run` consumer half — per-entry judgment handed off via `[needs-llm]` through `skillHandoff`, the payload written under the home; no declared side effects |
| `metrics-rollup` | `daily` schedule with retained state — append-only rows, a retention window, weekly rollups; writes only under the home |
| `anomaly-issue` | `dependencies` ordering after `anomaly-watch`, `supervised` autonomy, and a `creates_issue` side effect through the gate — irreversible, so the result says how to undo it |
| `daily-digest` | Aggregate — declares two producers, lets the engine order them, and folds what they last reported into one digest Output |
| `derived-summary` | Derive, don't store — reads a source under the home, returns the summary, writes nothing; `ttl_hours` decides whether recomputing is worth it |
| `note-intake` | Operator text for one run — `schedule: 'manual'` plus a required input supplied with `warpline run note-intake default --input note=<text>`, routed whole to a file under the home |
| `link-enrich` | Fan in from three sources with per-source isolation — one refused source is a `partial` run that names it, every source refused is a failure; credentials are names on `secrets` |
| `draft-writer` | Config-heavy writer — every adopter choice is a declared input with a placeholder default, three reference files named by path and refused outside the home, the drafting handed off |
| `announce-fanout` | Config-heavy fan-out — channels, calls to action and a cadence as declared inputs, per-channel isolation, the per-channel rewrite handed off |

Copy any of them into your own home as a starting point:
`npx warpline scaffold my-plugin --from <example>` copies the directory with
only the manifest's name rewritten.

Authoring guide: [docs/plugin-authoring.md](docs/plugin-authoring.md).

```bash
# First run: create the home, copy one example plugin in, write its config.
# Asks for each input the plugin declares on a terminal; writes the declared
# defaults when stdin is not one. Safe to run again.
npx warpline init

# Scaffold a plugin — also prepares the home directory
npx warpline scaffold my-plugin

# Write a plugin's config from the inputs its manifest declares. Prompts on a
# terminal; takes --from '<json>' when stdin is not one. Never writes a secret.
# Safe to run again: a value already in the file is kept unless you replace it.
npx warpline configure my-plugin

# Preview what the next engine advance would do. Executes nothing.
npx warpline plan

# Invoke one plugin handler directly
npx warpline run my-plugin default

# Answer whichever gate is waiting — record a parked result, or grant a
# side-effecting plugin permission to run for this session
npx warpline approve my-plugin

# Say no to what a plugin proposed. The answer is bound to the proposal, so
# the question comes back if what it proposes changes.
npx warpline deny my-plugin

# Clear the session approval
npx warpline revoke
```

Those eight subcommands are the whole CLI surface. Running everything
that's due on a schedule is a library call, not a command. It's `runAdvance()`
from the package root:

```typescript
import { runAdvance } from 'warpline'

const result = await runAdvance()
```

## Where the LLM fits

> If you can write an `if/else` for it, it's code.
> If it needs understanding or judgment, it's an LLM task, and the plugin
> *hands it off* instead of calling a model.

Read the full doctrine: [docs/doctrine.md](docs/doctrine.md).

Nowhere in this repo. That's the point. Plugins that reach a judgment step
return a `[needs-llm]` handoff (mapped to the `delegated` run status, never
retried). An orchestrating Claude Code session consumes those handoffs via
companion skills, and a template lives in
[skills/needs-llm-template/](https://github.com/warplinehq/warpline/tree/main/skills/needs-llm-template).
That directory is deliberately not shipped in the package, so the link is
absolute. It resolves the same from npm, from GitHub, and from node_modules.
Side effects that follow from judgment work still go through the approval
gate.

## FAQ

### Can the gate be bypassed?

Only deliberately, and only by a human at a keyboard. `warpline approve --all`
is the one route to a wildcard `scopes: '*'` grant, and it refuses to run if you
also name plugins, so no plugin name, glob or shell expansion can widen a grant
past what you typed. It prints the coverage it's about to grant before it writes
anything. The grant is session-scoped and it expires. See
[the session approval file](docs/runtime-spec.md#9-session-approval-file) for
the default lifetime and the ceiling from first grant. And nothing inside a run
can widen its own scope. The grant helpers have no caller on the advance path,
so a run can only ever spend approval a human already gave.

### Why not just let the plugin call a model?

Because a plugin that calls a model has quietly made every future rerun an
experiment. The deterministic half stops being reproducible, the judgment half
stops being reviewable, and you find out which was which when they disagree
with each other. If you can write an `if/else` for it, it's code. If it needs
understanding, it's a handoff. Keep the boundary in the manifest and you can
read a plugin and know which one you're looking at.

### Do I need Bun / a Claude subscription?

No to both, in different ways. Node 22.18+ or 23.6+ is enough to install and
run warpline. 23.0–23.5 is excluded by `engines.node`, and npm reports
`EBADENGINE` there (a hard failure wherever `engine-strict` is set). Bun is the
development runtime for this repository's own test suite, not a user
requirement. The `[needs-llm]` half is a handoff, not an API call. It uses
whatever Claude Code session you already have, and if nobody ever picks a
handoff up, the deterministic work carries on running without it.

## Docs

- [docs/first-plugin.md](docs/first-plugin.md) — **start here**: build, run and gate a plugin in ten minutes
- [docs/doctrine.md](docs/doctrine.md) — the deterministic/LLM boundary
- [docs/runtime-spec.md](docs/runtime-spec.md) — manifest fields, retry/timeout/abort semantics, run artifacts
- [docs/derive-dont-store.md](docs/derive-dont-store.md) — why there is no snapshot store, diff engine or resource cache, and what `ttl_hours` plus one overwritten file does instead
- [docs/board-spec.md](https://github.com/warplinehq/warpline/blob/main/docs/board-spec.md)
  — the Board: objects, Ask lifecycle, places, form, file formats. The board is a repo-only surface
  at 0.1, so this spec is not shipped in the package and the link is absolute.
- [docs/needs-llm-contract.md](docs/needs-llm-contract.md) — the LLM handoff protocol
- [docs/plugin-authoring.md](docs/plugin-authoring.md) — writing and testing plugins
- [docs/why-the-gate-holds.md](docs/why-the-gate-holds.md) — the long argument: why the gate holds, and the objections it has to survive

## From source

Cloning gets you the test suite and the board, neither of which ships in the
package:

```bash
git clone https://github.com/warplinehq/warpline
cd warpline
bun install
bun run test                  # builds, then runs the full suite
```

Requires [bun](https://bun.sh) ≥ 1.3. This is the one place it's genuinely
required, because the suite is written against `bun:test`.

```bash
# The board — a repo-only surface at 0.1, not wired into the published bin
bun run src/cli/board-cli.ts status
bun run src/cli/board-cli.ts tasks
```

## Provenance

Warpline was extracted in August 2026 from the private automation engine
that's run one company's marketing operations since early 2026. The domain
plugins stayed behind. The runtime, gates, board, and doctrine are what
generalised.

## License

Apache-2.0
