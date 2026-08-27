---
title: Board spec
diataxis: reference
---

# Warpline Board: Design Specification

> **Scope.** The Board is the operator surface over a running warpline home.
> At 0.1 the only implementation is `src/cli/board-cli.ts` — a headless CLI
> that runs from a clone and is not wired into the published `warpline`
> binary, so `npm i warpline` does not get it. This document is the contract
> for the **0.2 Board**. Each section says whether it describes what exists
> today or what 0.2 must build; nothing here is a description of a shipped
> UI.

> **Doctrine.** Nothing with a declared side effect executes without a human
> saying yes. The Board moves *where* that yes is said — from a terminal to a
> browser on the same machine — and nothing else. It never moves the yes off
> the machine. See [why-the-gate-holds.md](why-the-gate-holds.md).

## 1. Who it is for

The Board is designed **operator-first**: one person running a real fleet of
plugins daily, who opens the Board for two reasons, in this order:

1. **A plugin produced something they are going to use.** Read it rendered,
   lift it out in one move, put it where it is used.
2. **Something is waiting on their decision.** See what it is and what it
   will *do*, and say yes, no, or later — so nothing with a side effect
   happens without them, and nothing waits on them unnoticed.

Two further needs are served but are not the spine: knowing what changed
since they were last here, and seeing how plugins relate (what feeds what,
what a run cascades into).

Someone installing warpline fresh (no plugins, no state, no history) is the
second audience; §9 lists what they need that the operator does not. Their
needs are staged after the operator's, never blended in.

## 2. Objects and vocabulary

One name per concept, one concept per name — in the UI, this spec, and the
code. Names that this spec retires: *dashboard*, *noticeboard*, *task board*.

| Object | One sentence | Exists today as |
|---|---|---|
| **Plugin** | A unit of deterministic work with a manifest: schedule, tier, dependencies, declared inputs, outputs and side effects. | `PluginManifestSchema` |
| **Run** | One execution of one Plugin: status, attempts, elapsed, error, and what it produced or raised. | `RunArtifact` (`runs/`), `PluginLogEntry` in the run log |
| **Output** | A thing a Plugin produced that the operator will read and take away. Has a producing Run, a type, a body or path, and a time. | Not an object. Only `artifacts_produced: string[]` on a result. **0.2 introduces it.** |
| **Ask** | Something waiting on the operator, with a kind, a severity, a source, what answering it will *do*, when it was raised and when it expires. | Three objects: `TaskItem`, a `gated`/`skipped` plugin entry, a `BoardEvent`. **0.2 unifies them.** |
| **Grant** | A live session approval: which plugins may exercise their declared side effects, until when. | The session approval file — [runtime-spec.md § 9](runtime-spec.md) |

Relationships: a Run belongs to one Plugin; an Output belongs to one Run; an
Ask is raised by one Run *or* by the engine (source = `engine`); a Grant
covers one or more Plugins. A Plugin depends on zero or more Plugins
(`dependencies`, static) — the engine's topological sort turns that into
execution levels.

**Not an object at 0.2:** *lineage* (Run X consumed Run Y's Output). The
static dependency graph covers "what feeds what" for orientation and
authoring. Dynamic lineage is a hypothesis until a flow needs it.

### 2.1 Ask kinds and verbs

| Kind | Raised when | Answer verbs | What the answer does |
|---|---|---|---|
| `approval` | A plugin with declared side effects was recorded `skipped` for want of a Grant, or a supervised plugin ran and was `gated`. | **approve** · **deny** | approve = merge a Grant for that plugin (exactly `warpline approve <plugin>`); the next advance runs it. deny = record the answer; no Grant; the plugin stays skipped until raised again. |
| `decision` | A guided task (`action_type: 'guided'`) offers options. | **choose** | Runs the option's handler; the task completes. |
| `notice` | An event the operator should see and need not act on. | **seen** | Acknowledged: leaves the open list, kept in history. |
| `chore` | A self-directed task (`action_type: 'self_directed'`): work done outside warpline. | **done** | Asserts the outside work happened; the task completes. |

*seen* and *done* are deliberately distinct verbs: *done* claims something
happened in the world, *seen* never does.

### 2.2 Ask lifecycle

```
open ──answered──▶ closed        (approve | deny | choose | seen | done)
 │ ▲
 │ └── expiry of the deferral ──┐
 └────defer(1h|4h|1d|1w)──▶ deferred
open ──expiry──▶ expired         (approval kind only; see below)
```

Rules that follow from the runtime, not from taste:

- **An approval Ask expires with the Grant ceiling.** Grants live at most
  24 hours from first issue unless `--long` is passed
  (`MAX_GRANT_WINDOW_MS`). The Ask shows `expires_at`; **defer options that
  would outlive it are not offered.**
- **Answering an expired Ask is refused and said.** If the operator opened
  the Ask before expiry and answers after, the Board reports "this expired
  at *t*" and does nothing. It never silently re-raises.
- **Severity orders, age tie-breaks.** `critical` > `warning` > `info`;
  within a severity, oldest first. Unchanged from 0.1.
- **What it will do is shown before the verb.** An approval Ask lists the
  plugin's declared `side_effects` and, when the run recorded them,
  `reversible` and `undo_instruction`. No approve control renders without
  that list.

### 2.3 Output temporality

Whether a re-run replaces the previous Output or versions it is declared by
the Plugin, per output type, in the manifest's `outputs` record
(**0.2 manifest field**, to be specified in runtime-spec § 1 when it lands).
Reports and briefs version — a new Output instance per Run, latest shown by
default, older reachable. Snapshots and state replace. **Undeclared defaults
to replace**, and the Output says "not versioned".

## 3. Places

Five places. Each object's attributes and actions live together in one place;
every relationship in §2 is navigable. Text breadboard: `- affordance →
destination`, `[ content ]`.

```
Board
- open an Ask → Ask
- open an Output → Output
- run a plugin now → Run
- all Asks / all Outputs / all Plugins → the same places, filtered
[ open Asks by kind, oldest age
  Outputs since last visit
  "Nothing went out that you didn't sanction since <t>."   ← §3.1
  running now ]

Ask
- approve / deny · choose · seen · done → Board (post-action: the Ask leaves
                                                 the open list; on approve, its
                                                 Plugin's next Run shows as running)
- defer 1h / 4h / 1d / 1w (capped at expires_at) → Board
- open source Run → Run
[ kind · severity · what it will DO · options or context · raised_at · expires_at ]

Output
- copy — whole, or one section → stays here; visible feedback that it copied
- open producing Run → Run
- previous version → Output (older), when versioned
[ rendered body · type · Plugin · Run · produced_at · "version n of m" or "not versioned" ]

Run
- cancel (while running) → Run
- re-run → Run (new)
- open Plugin → Plugin
[ status · attempts with elapsed and error · live stream while running ·
  Outputs produced · Asks raised · final error ]

Plugin
- run now → Run
- open a Run → Run
[ manifest · schedule · tier · dependencies and dependents · side_effects ·
  recent Runs · last Output ]
```

The "how plugins relate" need is served by **Plugin** (static dependencies and
dependents, drawn from the same graph the engine sorts) and by **Run →
Outputs / Asks raised** (dynamic). A whole-fleet view is Plugin with no
filter, not a sixth place.

### 3.1 The truthful sentence

The Board's first line states the latest time up to which every
side-effecting plugin entry in the run log executed under a live Grant. The
gate's own invariant makes this derivable from the run log alone: an entry
with declared side effects is `completed` only when `checkApproval` passed
immediately before invocation, else it is `skipped` or `gated`. It is
computed, never asserted; if the Board cannot compute it (no run log, an
unreadable entry) it says that instead. This sentence is what the Board
exists to be able to say.

### 3.2 Empty, loading and lagging states

| Place | Empty | Notes |
|---|---|---|
| Board | The truthful sentence, then "Nothing waiting." | For a fresh install: §9. |
| Ask list | "Nothing waiting." | Never a blank panel. |
| Output | "No Outputs yet — *plugin* has not run." | Links to Plugin. |
| Run | Attempt list with the live stream; on `running` with no output yet: "started *t*, no output yet". | |
| Plugin | Manifest only; "never run". | |

The Board reads files the engine writes. A new Ask raised while the operator
is looking must appear without a manual reload: live push (SSE) or a stated
poll cadence. **Which, and the maximum lag, is an engineering decision
recorded in this spec when made** — the requirement is only that the lag is
stated, not hidden.

## 4. Form

**Web, on loopback, plus an off-Board push channel.**

- **Web.** The five places are a local web app served by a process that reads
  the warpline home. Long-form Outputs render as markdown (headings, tables,
  code, images); copy is one action with feedback; a Run streams live and can
  be cancelled; the dependency graph draws as a graph. A terminal serves none
  of the first three well, and the first is the operator's top job.
- **Loopback only.** The server binds `127.0.0.1` and refuses any other bind
  address. Every state-changing request (answer, defer, run, cancel) is a
  `POST` carrying a per-process token the page received at load; requests
  without it are rejected. There is no authentication story because there is
  no remote story — exposing the port is out of contract.
- **Push.** A channel that reaches the operator when they are away from the
  Board — OS notification, email or webhook; the transport is chosen in a
  later plan. It carries **Asks and the truthful sentence, and nothing else.
  It never carries an approve action.** The gate is answered on the Board or
  at the CLI, on the machine, and nowhere else.
- **CLI.** `src/cli/board-cli.ts` remains the headless, scriptable path
  (`status`, `tasks`, `ack`, `ack-all`, `defer`), and `warpline approve` /
  `warpline revoke` remain the only way to change a Grant from a shell. The
  Board's approve verb calls the same code path as `warpline approve`; there
  is no second gate.

## 5. Data files (implemented today)

| File | Format | Writer | Reader |
|------|--------|--------|--------|
| `<home>/state/events.jsonl` | JSON Lines, one `BoardEvent` per line; size-capped — `emitBoardEvent` trims to the newest 20,000 lines once past cap + 2,000 slack, atomic tmp+rename | Engine | Board |
| `<home>/state/acknowledgements.json` | JSON object, `event_id → { acknowledged_at, action_taken }` | Board | Board, Engine |
| `<home>/state/` engine state | `EngineStateSchema`: tasks, deferrals, per-plugin last run | Engine | Board |
| `<home>/runs/` | one `RunArtifact` per run — [runtime-spec.md § 5](runtime-spec.md) | Engine | Board |
| `<home>/.session-approval` | the Grant — [runtime-spec.md § 9](runtime-spec.md) | `warpline approve` / Board approve | Engine, Board |

IPC is file-based only: the engine and the Board are separate processes and
share no stdout. `acknowledgements.json` survives across sessions.

`BoardEvent.summary` is capped at 200 characters and `metadata_json` is a
serialised string, never a nested object. Both are schema facts the Board
relies on: a list row renders one line, and anything richer is opened, not
inlined.

## 6. Guardrails (implemented today)

Stored in `<home>/preferences.json`, validated by `PreferencesSchema`. There is
no `config` subcommand at 0.1 — edit the file directly; an invalid one fails
validation on read rather than being silently ignored.

| Field | Default | Meaning |
|---|---|---|
| `max_sends_per_day` | `20` | Cap on side-effecting sends per day |
| `review_gate` | `true` | Require approval before any side-effect execution |
| `quiet_hours` | `22:00`–`07:00` | Window in which nothing notifies or executes |

Quiet hours bind the push channel too: nothing is pushed inside the window;
it is delivered when the window ends.

## 7. What 0.2 requires of the runtime

Each of these is a contract change and lands with its own spec edit in the
same commit (CLAUDE.md rule 1). Listed here so the Board is not built on
objects that do not exist.

1. **A `denied` outcome.** Today a plugin entry is `skipped` (no Grant) or
   `gated` (supervised) and nothing records a human saying no. The `deny`
   verb needs somewhere to land — an engine-state record the next advance
   reads, so a denied plugin is not re-raised every run.
2. **Run linkage on Asks.** `BoardEvent` carries `task_id` but no run id;
   `TaskItem` carries `source_check` but no run id. An Ask must be able to
   name the Run that raised it.
3. **Output as data.** `artifacts_produced: string[]` becomes a record with
   type, path or body, and the producing run id, so the Board can render and
   version it.
4. **Output temporality on the manifest** (§2.3).
5. **A per-plugin "last Output"** in engine state, so Plugin can show it
   without scanning `runs/`.
6. **The gated → approved path.** `PluginFsmState` has an `'approved'` state
   that no transition reaches: once a supervised plugin is `gated`, nothing
   un-gates it, and a re-run on the next advance may be skipped by the
   staleness TTL. The approve verb on a `gated` Ask needs a defined effect
   before the Board can offer it.

## 8. Schema references

| Schema | Used by | Purpose |
|--------|---------|---------|
| `BoardEventSchema` | Ask (`notice`), Run | One line of `events.jsonl`, validated on read |
| `TaskItemSchema` / `TaskDisplaySchema` | Ask (`decision`, `chore`) | Tasks and their `pending → active → completed / deferred` states |
| `AcknowledgementsSchema` | Ask | Persists answers across sessions |
| `ActionType` | Ask | `acknowledge`, `action`, `defer`, `mark_done` — the 0.1 verbs the 0.2 verbs map onto |
| `RunArtifact` | Run, Output | `runs/` entries |
| `PluginManifestSchema` | Plugin | Manifest, dependencies, side effects |

## 9. Fresh-install delta

What someone with no plugins and no history needs that the operator does not.
Staged after the operator design; none of it changes §2–§4.

1. A Board with zero plugins points at `warpline scaffold`, once.
2. Every place's empty state is truthful (§3.2) — no blank panels on a home
   that has never run.
3. No push channel configured: the Board says so once, and does not nag.
4. The whole-fleet Plugin graph matters more here than to the operator, who
   already holds it in their head.
5. Plugin links out to [plugin-authoring.md](plugin-authoring.md).
