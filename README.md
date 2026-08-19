# Warpline

**A deterministic plugin runtime for operations automation, with LLM judgment
as a quarantined, dispatchable step — never an ambient capability.**

Warpline runs scheduled operational jobs (monitoring, data pulls, report
generation, lead qualification — anything) under one doctrine:

> If you can write an `if/else` for it, it is code.
> If it needs understanding or judgment, it is an LLM task — and the plugin
> *hands it off* instead of calling a model.

And one safety rule:

> A plugin that declares side effects — sending email, creating issues,
> writing to a database, calling external APIs, modifying files — does not
> run without explicit human session approval. At **every** autonomy level,
> `autonomous` included.

Read the full doctrine: [docs/doctrine.md](docs/doctrine.md).

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

## Quickstart

Requires [bun](https://bun.sh) ≥ 1.3.

```bash
bun install
bun test                      # 262 tests

# Create a home for your installation (or set WARPLINE_HOME)
mkdir -p .warpline/plugins

# Scaffold a plugin
bun run src/cli/scaffold.ts my-plugin

# Run one plugin
bun run src/cli/run-plugin.ts my-plugin default

# Run everything that is due (TTL + schedule + tier aware)
# → engine API: runAdvance() in src/runtime/engine.ts

# Board
bun run src/cli/board-cli.ts status
bun run src/cli/board-cli.ts tasks
```

Every file warpline reads or writes lives under one home directory: the
`WARPLINE_HOME` env var, else the nearest ancestor `.warpline/` directory,
else `<cwd>/.warpline`.

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
|---|---|
| `anomaly-watch` | A pure deterministic check — the baseline shape |
| `github-poll` | `external_api` side effect gating an autonomous plugin |
| `feed-monitor` | Deterministic fetch/parse with judgment deferred via `[needs-llm]` |

Authoring guide: [docs/plugin-authoring.md](docs/plugin-authoring.md).

## Where the LLM fits

Nowhere in this repo — that is the point. Plugins that reach a judgment step
return a `[needs-llm]` handoff (mapped to the `delegated` run status, never
retried). An orchestrating Claude Code session consumes those handoffs via
companion skills; a template lives in
[skills/needs-llm-template/](skills/needs-llm-template/). Side effects that
follow from judgment work still go through the approval gate.

## Docs

- [docs/doctrine.md](docs/doctrine.md) — the deterministic/LLM boundary
- [docs/runtime-spec.md](docs/runtime-spec.md) — manifest fields, retry/timeout/abort semantics, run artifacts
- [docs/board-spec.md](docs/board-spec.md) — event board, task states, file formats
- [docs/needs-llm-contract.md](docs/needs-llm-contract.md) — the LLM handoff protocol
- [docs/plugin-authoring.md](docs/plugin-authoring.md) — writing and testing plugins

## Provenance

Extracted from the automation engine that has run a real company's marketing
operations since early 2026. The domain plugins stayed behind; the runtime,
gates, board, and doctrine are what generalised.

## License

Apache-2.0
