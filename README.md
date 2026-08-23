# Warpline

> A deterministic plugin runtime where the LLM is a step you dispatch, not a
> capability the code carries around.

[![npm](https://img.shields.io/npm/v/warpline)](https://www.npmjs.com/package/warpline)
[![CI](https://github.com/warplinehq/warpline/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/warplinehq/warpline/actions/workflows/ci.yml)
[![Secret scan](https://github.com/warplinehq/warpline/actions/workflows/gitleaks.yml/badge.svg?branch=main)](https://github.com/warplinehq/warpline/actions/workflows/gitleaks.yml)
[![License](https://img.shields.io/github/license/warplinehq/warpline)](LICENSE)

Warpline runs the recurring work that keeps a business going —
outbound sequencing, market research pulls, content pipelines,
competitor monitoring, lead qualification, report generation — on a schedule.
A plugin that declares a side effect (sending email, creating issues, writing
to a database, calling external APIs, modifying files) does not run without
explicit human session approval, at every autonomy level, `autonomous`
included.

Blanket approval exists and is deliberate — `warpline approve --all`. What it
grants, what it prints before writing anything, when it expires, and why a run
cannot widen its own scope:
[Can the gate be bypassed?](#can-the-gate-be-bypassed).

Published docs: [warplinehq.github.io/warpline](https://warplinehq.github.io/warpline/).

<!-- generated: plan-demo -->
```
warpline plan — preview only; nothing was executed.

Grant: none — plugins with side effects would be SKIPPED this run
Plugins: /tmp/warpline-demo/plugins

Due (2):

  anomaly-watch (level 0)
    (no declared side effects)
  feed-triage (level 0)
    (no declared side effects)

Not due (2):

  feed-monitor — skipped (unapproved): side effects require session approval
    external_api: ⚠ unapproved — would be SKIPPED this run
  github-poll — skipped (unapproved): side effects require session approval
    external_api: ⚠ unapproved — would be SKIPPED this run
```
<!-- /generated -->

## Quickstart

```bash
npm i warpline          # or: bun add warpline
npx warpline --help
```

Runs on Node 22.18+ or 23.6+ (`engines.node` excludes 23.0–23.5), or Bun ≥ 1.3
— Node alone is enough, Bun is not required to use warpline. v0.1 supports
POSIX systems (macOS, Linux); Windows is untested and unclaimed.

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
- **Event board** — append-only `events.jsonl` + acknowledgements; a task
  board with ack / defer / complete states and severity-FIFO ordering.
- **The `[needs-llm]` contract** — plugins emit judgment work as a typed
  handoff; a Claude Code companion skill picks it up. Deterministic work costs
  nothing to run; judgment work rides your existing Claude subscription. See
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
hard-stop at load — a misconfigured plugin never silently runs.

Worked examples in [examples/plugins/](examples/plugins/):

| Example | Demonstrates |
| --- | --- |
| `anomaly-watch` | A pure deterministic check — the baseline shape |
| `github-poll` | `external_api` side effect gating an autonomous plugin |
| `feed-monitor` | Deterministic fetch/parse that emits the handoff — the producer half of the feed chain |
| `feed-triage` | The `on_run` consumer half — per-entry judgment handed off via `[needs-llm]`, no declared side effects |

Authoring guide: [docs/plugin-authoring.md](docs/plugin-authoring.md).

```bash
# Scaffold a plugin — also prepares the home directory
npx warpline scaffold my-plugin

# Preview what the next engine advance would do. Executes nothing.
npx warpline plan

# Invoke one plugin handler directly
npx warpline run my-plugin default

# Grant / clear a side-effect approval for this session
npx warpline approve my-plugin
npx warpline revoke
```

Those five subcommands are the whole CLI surface at 0.1. Running everything
that is due on a schedule is a library call, not a command — `runAdvance()`
from the package root:

```typescript
import { runAdvance } from 'warpline'

const result = await runAdvance()
```

## Where the LLM fits

> If you can write an `if/else` for it, it is code.
> If it needs understanding or judgment, it is an LLM task — and the plugin
> *hands it off* instead of calling a model.

Read the full doctrine: [docs/doctrine.md](docs/doctrine.md).

Nowhere in this repo — that is the point. Plugins that reach a judgment step
return a `[needs-llm]` handoff (mapped to the `delegated` run status, never
retried). An orchestrating Claude Code session consumes those handoffs via
companion skills; a template lives in
[skills/needs-llm-template/](https://github.com/warplinehq/warpline/tree/main/skills/needs-llm-template).
That directory is deliberately not shipped in the package, so the link is
absolute — it resolves the same from npm, from GitHub, and from node_modules.
Side effects that
follow from judgment work still go through the approval gate.

## FAQ

### Can the gate be bypassed?

Only deliberately, and only by a human at a keyboard. `warpline approve --all`
is the one route to a wildcard `scopes: '*'` grant, and it refuses to run if you
also name plugins, so no plugin name, glob or shell expansion can widen a grant
past what you typed. It prints the coverage it is about to grant before it
writes anything. The grant is session-scoped and it expires — see
[the session approval file](docs/runtime-spec.md#9-session-approval-file) for
the default lifetime and the ceiling from first grant. And nothing inside a run
can widen its own scope: the grant helpers have no caller on the advance path,
so a run can only ever spend approval a human already gave.

### Why not just let the plugin call a model?

Because a plugin that calls a model has quietly made every future rerun an
experiment. The deterministic half stops being reproducible, the judgment half
stops being reviewable, and you find out which was which when they disagree
with each other. If you can write an `if/else` for it, it is code; if it needs
understanding, it is a handoff. Keeping the boundary in the manifest means you
can read a plugin and know which one you are looking at.

### Do I need Bun / a Claude subscription?

No to both, in different ways. Node 22.18+ or 23.6+ is enough to install and
run warpline — 23.0–23.5 is excluded by `engines.node`, and npm reports
`EBADENGINE` there (a hard failure wherever `engine-strict` is set). Bun is the
development runtime for this repository's own test suite, not a user
requirement. The `[needs-llm]` half is a handoff rather than an API
call — it rides whatever Claude Code session you already have, and if nobody
ever picks a handoff up, the deterministic work carries on running without it.

## Docs

- [docs/first-plugin.md](docs/first-plugin.md) — **start here**: build, run and gate a plugin in ten minutes
- [docs/doctrine.md](docs/doctrine.md) — the deterministic/LLM boundary
- [docs/runtime-spec.md](docs/runtime-spec.md) — manifest fields, retry/timeout/abort semantics, run artifacts
- [docs/board-spec.md](https://github.com/warplinehq/warpline/blob/main/docs/board-spec.md)
  — event board, task states, file formats. The board is a repo-only surface
  at 0.1, so this spec is not shipped in the package and the link is absolute.
- [docs/needs-llm-contract.md](docs/needs-llm-contract.md) — the LLM handoff protocol
- [docs/plugin-authoring.md](docs/plugin-authoring.md) — writing and testing plugins

## From source

Cloning gets you the test suite and the board, neither of which ships in the
package:

```bash
git clone https://github.com/warplinehq/warpline
cd warpline
bun install
bun run test                  # builds, then runs the full suite
```

Requires [bun](https://bun.sh) ≥ 1.3 — this is the one place it is genuinely
required, because the suite is written against `bun:test`.

```bash
# The board — a repo-only surface at 0.1, not wired into the published bin
bun run src/cli/board-cli.ts status
bun run src/cli/board-cli.ts tasks
```

## Provenance

Warpline was extracted in August 2026 from the private automation engine
that has run one company's marketing operations since early 2026. The domain
plugins stayed behind; the runtime, gates, board, and doctrine are what
generalised.

## License

Apache-2.0
