---
title: Plugin runtime spec
diataxis: reference
---

# Plugin Runtime Spec

> Runtime contract for warpline plugins. Covers the manifest schema
> additions, the `AbortSignal`-threaded `HandlerFn` signature, the retry /
> timeout semantics, run artifact shape + retention, and test patterns.
>
> Board-level invocation semantics (when the engine picks which plugins to
> run on a board pass) stay in `BOARD-SPEC.md`. This spec covers what
> happens once a plugin has been selected and the runtime starts invoking
> its handler.

---

## 1. Manifest Fields

Every plugin under `<plugin root>/<name>/manifest.ts` exports a value
validated against `PluginManifestSchema`, imported from
`warpline/schemas/plugin-manifest`.

The plugin root is resolved by exactly one rule: `AdvanceOptions.pluginsDir`
when the host supplies it, otherwise `<warplineHome()>/plugins`. It is a single
root, not a search-path list — nothing falls back to a second location when a
plugin is not found under the first.

The plugin root and the home are independent. A supplied root may sit outside
the home, inside it, or be exactly `<home>/plugins`; nothing requires the two to
be disjoint. What does not move is everything the home derives: `state/`,
`runs/`, `events.jsonl`, the session-approval grant, and `config/<plugin>.json`
all stay under `warplineHome()` whatever plugin root an advance is given. A
root that is absent, is not a directory, cannot be read, or is the empty string
is refused before the advance writes anything.

The table below is generated from that schema — `bun run docs:generate` in a
clone refreshes it, and CI regenerates and fails on a stale diff, so it cannot
drift from the code. Edit the schema, not the table.

<!-- generated: manifest-fields -->

| Field | Type | Required | Default |
|---|---|---|---|
| `name` | string | yes | — |
| `version` | string | yes | — |
| `description` | string | yes | — |
| `inputs` | object | no | `{}` |
| `outputs` | object | no | `{}` |
| `capabilities` | string[] | no | `[]` |
| `schedule` | `on_run` \| `daily` \| `weekly` \| `manual` | no | `"on_run"` |
| `autonomy_level` | `autonomous` \| `supervised` \| `manual` | yes | — |
| `approval_class` | `session` \| `content` | no | `"session"` |
| `side_effects` | (`sends_email` \| `creates_issue` \| `writes_db` \| `external_api` \| `modifies_file`)[] | no | `[]` |
| `secrets` | string[] | no | `[]` |
| `ttl_hours` | number | yes | — |
| `dependencies` | string[] | no | `[]` |
| `timeout_ms` | integer | no | `60000` |
| `max_retries` | integer | no | `1` |
| `retry_delay_ms` | integer | no | `2000` |
| `actions` | object | no | — |
| `max_parallelism` | integer | no | `1` |
| `min_tier` | `normal` \| `degraded` \| `extended` \| `suspended` | no | `"normal"` |

<!-- /generated -->

Every field with a default is optional in a manifest file, so adding one never
invalidates an existing plugin. `name` may not be a member of
`Object.prototype` — `__proto__`, `constructor`, `toString`, `valueOf` and the
rest are refused. The set is derived from the prototype, not listed, so it
cannot go stale.

**The key in the plain-object `plugin_runs` and `denials` records is the plugin
DIRECTORY name, not `manifest.name`,** and it carries the same refusal at the
loader — a directory named after a prototype member is a load failure with the
plugin absent from `manifests`. That is where the constraint has to bite:
`loadPluginManifests` keys its map by the directory entry, every downstream key
comes out of that map, and it casts the imported module rather than parsing it
through `PluginManifestSchema`, so the schema refinement above never runs on a
load. A `__proto__` key would invoke the prototype setter and drop the record on
write — no `plugin_runs` entry after a gated run, which is the re-firing defect
that record exists to close — and the others answer a lookup with an inherited
member rather than the absence that is the truth. The two refusals are
independent on purpose: the strings are not the same string, and `manifest.name`
is not today a record key anywhere. `ttl_hours` must be positive —
zero or negative would disable caching rather than mean "always fresh". `max_retries` is capped
at 10 and `retry_delay_ms` at 60s; the backoff that uses them is described in
§2. `actions` is an optional registry that only surfaces in a host UI when
non-empty.

### `inputs`

Each entry in `inputs` declares one parameter the plugin expects to receive as
an argument at invoke time, and it is a declaration the runtime enforces rather
than documentation nobody reads.

`inputs[].type` is a closed set — `string`, `number`, `boolean`, `array` or
`object`. A value outside it is a hard `.parse()` failure, not a fall back:
manifests are parsed at import time, so a misspelled type name stops the plugin
rather than letting it run unvalidated.

A declared name is checked against the value received, not merely accepted. The
`array` and `object` checks are predicates rather than `typeof` comparisons,
because `typeof` answers `object` for an array and for `null` alike.

`inputs[].default` is optional and holds the value the input takes when nobody
supplies one. It is the LOWEST of three precedence tiers, resolved inside
`invokePlugin`:

| Tier | Source | Beats |
|---|---|---|
| 1 (lowest) | `inputs[].default` in the manifest | — |
| 2 | `<home>/config/<plugin>.json` | the declared default |
| 3 (highest) | per-invocation arguments | both |

A name that also appears in `secrets` takes no tier in this table at all. It is
resolved from the process environment before the handler is called, so the
declared default is not applied to it and the required check does not run
against it. The entry stays legal and stays useful — it names the parameter for
whoever reads the manifest — but it describes a value this resolution order
never supplies.

A value for such a name supplied through tier 2 or tier 3 is refused rather than
used: the run fails once with a `parse_error` naming the key and the environment
variable to set instead, and never the value it received. That refusal sits
above the retry loop with the rest of the config resolution, so it happens once.

A missing config file is an empty config, not an error. A config file that
exists but is unparseable or the wrong shape is a `parse_error` that fails once
and never enters the retry loop; its message names the file and the offending
input key and the shape expected of it, and never the value it read.

A default declared here is data a resolver can act on. A default stated only in
a `description` is one the handler has to re-implement, and the two drift.

Both fields are nested inside the `inputs` record value, so neither appears in
the generated table above — that table lists top-level manifest fields only.
This prose is the documentation for them.

### `secrets`

`secrets` is a list of environment variable **keys** the plugin requires. It is
a list of names, and the names are the whole of it.

Warpline resolves the names and never stores the values. There is no vault, no
`.env` file the runtime reads and no secrets file under the warpline home, so a
copied home carries no declared credential — the strongest form of protection at
rest available, which is having nothing at rest.

Every declared name is looked up in the process environment before the handler
is called, by exact key equality: no case folding, no trimming and no prefix
convention. A name that does not resolve fails the run with a single
`auth_failure` error naming the key and this field. That failure sits above the
retry loop, so it happens once and is never retried — a credential absent on the
first attempt is absent on the third.

A key that is present but set to the empty string counts as **absent** and fails
by name. An empty token is a broken credential, and admitting it would only move
the same failure into the handler, which is the position this check exists to
get in front of.

`secrets: []`, and a manifest that declares nothing, both run the check and pass
it. Adding the field invalidates no manifest that already validated.

This is not `capabilities`, which is a free-text array of informational tags.
Those two fields do not read each other.

`inputs` is the field that does. Declaring one name in both records is legal,
and the runtime consults `secrets` while it resolves `inputs`: such a name is
excluded from the input resolution entirely and comes from the environment
alone. The `inputs` entry for it is documentation, and its `default` is not
applied — a placeholder written there cannot stand in for a credential.

### `schedule`

`schedule` says when an advance should consider the plugin at all. It is a
closed set of four values — `on_run`, `daily`, `weekly` and `manual` — declared
by the plugin itself rather than written by the operator somewhere else.

An advance may be requested with a run profile, and a profile admits a **tier**
of schedules rather than one. `daily` admits `on_run` and `daily`; `weekly`
admits `on_run`, `daily` and `weekly`; `manual` admits `manual` and nothing
else. A plugin whose schedule falls outside the requested tier is skipped, and
the skip names the profile and the schedule.

`manual` is the one schedule no scheduled tier reaches. The `manual` profile is
the only profile that admits it, so a plugin declaring it runs when that
profile is asked for, or when an operator invokes it by hand.

An advance requested with **no** profile applies no tier — and still excludes
`manual`. That is the plain reading of the word: a manual schedule runs when
something asks for it, and an advance that asked for nothing has not asked. The
other three schedules all run in that case, so an unprofiled advance is the
widest one available and is still not a route to a manual plugin. The skip is
reported like any other, naming the schedule and the profile that would admit
it.

This exclusion is a change, not a rule that always held. Earlier releases ran a
`manual` schedule on an unprofiled advance. They no longer do, and the change is
quiet where it lands: the advance still reports `complete`, the plugin is
recorded `skipped` with a `profile_schedule` reason, and nothing about the run
reads as wrong. A host whose only invocation path is an unprofiled `runAdvance`
should read that list once and ask for the `manual` profile where it meant to.

This is a different question from `autonomy_level`, which is a separate gate.
`schedule` decides whether the plugin is considered; `autonomy_level` decides
whether it may proceed once it has been. A plugin may declare
`schedule: 'manual'` alongside `autonomy_level: 'autonomous'` and mean exactly
that — nothing starts it unasked, and nothing supervises it once a human has.

### `outputs.temporality`

Each entry in `outputs` also declares `temporality`, which says what a re-run
does to that output:

| Value | Meaning |
|---|---|
| `versioned` | Each run yields a new Output instance. The latest is shown by default; older ones stay reachable. |
| `replace` | A run overwrites the previous Output. |

`replace` is the default, so an entry that declares no temporality is not
versioned and the Board says so. Reports and briefs are the versioning case;
snapshots and current-state summaries are the replacing one.

A value outside those two is a hard validation failure, not a silent fall back
to the default. Manifests are parsed at import time, so a plugin that misspells
its temporality stops rather than running under a policy nobody declared.

Versioned history is bounded by run retention, and the bound is not generous:
an older Output version is reachable exactly while its producing run log
survives, and run logs are pruned under the operator's configured retention
policy (§ 6).

`append` is a known deferred third value — a run adding to the previous Output
rather than replacing or superseding it. It is not implemented. It is recorded
here because the enum can grow additively, and a reader who needs it should
know it was considered rather than overlooked.

This field is nested inside the `outputs` record value, so it does not appear in
the generated table above — that table lists top-level manifest fields only.
This prose is the documentation for it.

### Contract stability

The manifest contract is best-effort and explicitly pre-1.0 — it
may change in any 0.x release. That is the whole promise, and it is
deliberately not a stronger one.

It is also the whole *subject*. The promise is made about the manifest contract
and by its own words about nothing else: the run-log schema, the board schema,
the engine-state schema and the capability schemas are outside it. Those shapes
are reachable through `warpline/schemas/*` because that specifier is how this
package publishes shapes, not because publishing them promised anything; a
release may change any of them without a deprecation window. Where a persisted
document does carry an undertaking, it is written beside the document and not
here — § 9's `first_granted_at` rule is the one such case, and it is stated
there because nothing above it covers the file. The negative half is stated
here rather than left to inference because a promise whose edges are unwritten
is read at its widest by whoever is relying on it.

Adding a field is already safe by construction, for the reason stated
immediately above — every field with a default is optional in a manifest file,
so a new one cannot invalidate a manifest that already validates. An older build
reading a manifest written for a newer one ignores what it does not know.

Removing or narrowing something is the case that can break you, and what limits
it is a convention that already exists rather than a promise invented here:
closed enums stay closed. Six sets are closed — the side-effect type, the
autonomy level, the schedule, the minimum tier, `inputs[].type` and the approval
class — and an addition to any of them fans out into exhaustive switches and into
this document, which is why they are not extended casually.

The side-effect type is closed at five — `sends_email`, `creates_issue`,
`writes_db`, `external_api` and `modifies_file` — and one of those five is not
like the others. `creates_issue` names an outcome where the other four name a
mechanism: writing a row, calling an API, sending mail, touching a file. Asked
once, answered, and recorded here so it is not asked again. The asymmetry is
known and it is not being corrected, because every value is a literal that
installed manifests declare and that the runtime hashes into a denial
fingerprint. Renaming one breaks every installed plugin's manifest and
invalidates the denials already recorded against it — a manifest-contract
break, which is the one thing the promise above actually covers. A cosmetic
gain is not worth spending that.

`inputs[].type` is the one of the five that was narrowed rather than born
closed. It accepted any string before 0.2, so a manifest outside this repo
declaring a name that is not in the set now fails at import time. That is a
breaking change, permitted by the pre-1.0 promise above and taken deliberately:
a type field nothing validates is a field that means nothing.

The same set gained `array` and `object` in 0.3.2. That direction is additive —
a manifest that validated before still validates — and it corrects a claim this
document made rather than granting a new liberty: the two were left out on the
stated premise that nothing declared them, and consumer manifests declare both.
The set is still closed at five, and a sixth name is still a hard failure.

Pin the version you tested against, and read the release notes for the version
you move to. The release notes are the record of what changed between two
versions; nothing else here claims to be.

### Published specifiers, and what each promises

Seven specifiers are published: `warpline`, `warpline/schemas/*`,
`warpline/lib/paths`, `warpline/unstable-runtime`, `warpline/unstable-fs`,
`warpline/unstable-result` — the three result builders `skillOk`,
`skillFailure` and `skillHandoff`, and nothing beside them — and
`warpline/unstable-capabilities`.
Nothing else in the package is reachable — the `exports` map is an allowlist,
and an import of any other subpath fails at resolution rather than resolving to
something internal.

The root barrel `warpline` and the two narrow subpaths beneath it are public
contract from 0.1.0 onward. They are governed by the stability promise stated
above and are deliberately small for that reason.

`warpline/unstable-runtime` is not. Any name behind a `warpline/unstable-*`
specifier may change, narrow or disappear in any 0.x release. What you get is a
line in that release's notes, and no deprecation window — the specifier carries
the warning so that nobody has to have read this paragraph to be warned. If you
depend on one of those names, pin the exact version you tested against.

That statement is scoped to the specifier and not to any list of symbols, which
is deliberate: what is behind an `unstable-*` specifier is expected to move, and
a later release that adds a specifier of that shape inherits this promise rather
than inventing its own.

`warpline/unstable-capabilities` is **type-only**. Every name behind it is
erased at build time, so the module it resolves to exports no runtime value at
all, and importing it for a value gets you nothing. It carries the shape of the
capability context a handler is handed, the shape of each member on it —
`SecretsHandle` and `DependenciesHandle` — the shape of the grant witness a
caller of the runtime must supply, and the four-parameter handler type that ties
them together. The mint and the capability registry are deliberately not behind
it: the registry is a table designed to grow, and publishing it would owe a
stability promise on every row anybody adds.

`DependenciesHandle` carries two member functions, both taking the caller and a
name the reading manifest declares:

- `lastOutput(caller, name)` returns that plugin's most recent Output record, or
  `null` when it has never produced one. See § `last_output` for why that is a
  fact about the plugin and not about its last run.
- `lastRun(caller, name)` returns that plugin's last run status — one of
  `success`, `partial`, `failed`, `skipped`, `gated` — or `null` when it has
  never run. It is the same enum § `plugin_runs` records, and it is the whole of
  what this member returns: the failure TEXT a run may carry is not part of it,
  and no field of the run record other than these two is delivered through this
  handle.

Both members answer from the dependency state the HOST supplied, and a host may
supply none: `invokePlugin`'s `dependencyRuns` is optional, and a caller that
omits it hands the handler a member reading `null` for every declared name
whatever `engine-state.json` holds. `warpline run` is such a caller — it invokes
one plugin standalone and reads no runtime state. So `null` distinguishes "never
run" from "produced nothing" only on an engine advance, and a handler that must
run correctly under both should not publish "has not run yet" on the strength of
a `null`.

An undeclared name throws from either member, through one shared refusal, and
the message names the reading plugin, the requested name and the manifest field
to add it to.

`InvokePluginOptions.dependencyRuns` is what a host fills to supply both facts.
It was briefly named `dependencyOutputs` and carried only the record; no
published release ever shipped that name. Renaming it would have been allowed
regardless, because the field rides `warpline/unstable-runtime`, whose promise
about any name behind it is stated above and is exactly nothing.

## 2. Retry Policy

Retries fire only on a first failure whose `SkillResult.retryable === true`.
Validation errors, non-retryable handler errors, timeouts, and cancellations
never retry. Total attempts equals `1 + max_retries`, capped by the manifest's
`max_retries` or by `?retries=N` / `--retries=N` at the call site.

Delay between attempts uses exponential backoff plus jitter, capped at 30s:

```typescript
const expBase = Math.min(baseDelay * Math.pow(2, attempt - 1), 30_000)
const jitterMult = 1 + (Math.random() * 0.5 - 0.25) // +/-25%
const delay = Math.round(expBase * jitterMult)
```

Each attempt emits a `run-attempt-started` SSE event and, on failure, a
`run-attempt-failed` event (with `data = error message`). Successful attempts
end the retry loop immediately.

## 3. Timeout Contract

`timeout_ms` applies per-attempt; every retry gets a fresh budget. A timeout
is always fatal. The runtime never retries after a timeout trip (`timed_out:
true` on the result). Enforcement is an `AbortController.signal.addEventListener(
'abort', ...)` plus a `setTimeout`-armed abort that races the handler
promise.

Timeout vs. retry interaction:

| Outcome                              | `status`    | `retried`                 | `timed_out` |
|--------------------------------------|-------------|---------------------------|-------------|
| handler resolves with success        | `success`   | `attempt_count > 1`       | `false`     |
| handler returns `retryable: true`    | loop        | (final attempt determines)| `false`     |
| handler returns `retryable: false`   | `failed`    | `false`                   | `false`     |
| handler throws                       | `failed`    | `false`                   | `false`     |
| per-attempt timeout trips            | `failed`    | `false`                   | `true`      |
| external `controller.abort()`        | `cancelled` | `false`                   | `false`     |
| handler returns `skipped` + `[needs-llm]` summary prefix | `delegated` | `false` | `false`     |
| handler returns `skipped` + a `needs_llm` field          | `delegated` | `false` | `false`     |

`delegated` (2026-08-19): a `[needs-llm]` handoff is a successful dispatch to a
companion LLM skill, not a failure. `deriveRunStatus()` in `invoke-plugin.ts` is
the single mapping shared by the persisted run artifact, any live run bus,
and the board event (severity `info`). A plain `skipped` without the prefix still
maps to `failed` — widen deliberately if a persisted-run path ever produces one.

The two handoff rows are one predicate, not two. `isHandoff()` reads the
structured `needs_llm` field or the `[needs-llm]` summary prefix, and both rows
still require `skipped`. A result carrying both arms is classified once. See
[needs-llm-contract.md](needs-llm-contract.md) for the field's shape and for
why the prefix arm is emitted alongside it rather than replaced by it.

### Attempt status

Each entry in `attempts[]` carries its own terminal status, from a five-value
set: `success | failed | cancelled | timeout | delegated`.

`delegated` joined it on 2026-08-28. Until then the attempt classifier had four
values and collapsed everything that was not `success` into `failed`, so a
handoff produced a run artifact that contradicted itself — `status: "delegated"`
at the run level, `attempts[0].status: "failed"` one field below. Nothing
behaved wrongly, because `deriveRunStatus` and the CLI both read the result
rather than the attempt, but anyone reading `attempts[]` directly was told the
dispatch failed.

Both levels now classify a handoff through one shared predicate, so the run and
its attempts cannot disagree. A `delegated` attempt also carries `error: null`
and contributes no `final_error`, even when the handoff result populates
`errors[]`: the dispatch succeeded, so there is no failure to attribute.

Consumers should treat the set as open and not assume four members. The
persisted artifact types this field as a plain string for that reason.

## 4. AbortSignal Contract

`HandlerFn` gained a third parameter in :

```typescript
export type HandlerFn = (
  manifest: PluginManifest,
  args: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<SkillResultInput>
```

The return type is `SkillResultInput`, not `SkillResult`. A handler writes a
result; it never reads one back. `SkillResult` is the schema's OUTPUT type —
what a caller holds after `.parse()` — so a handler typed against it can only
write the already-normalized shape, and the bare-string `artifacts_produced` arm
that § Output records below documents as valid until 1.0 was unreachable through
the only path a plugin has. `SkillResultInput` is the same schema's input side:
defaulted fields optional, the string arm allowed. Both types come from
`warpline/schemas/skill-result`.

Everything assignable to `SkillResult` is assignable to `SkillResultInput`, so a
handler already annotated with the output type keeps typechecking unchanged.

Handlers with real I/O should forward `signal` to their I/O primitives:

- `fetch(url, { signal })`
- `Bun.spawn({ signal })` / `child_process.spawn({ signal })` equivalents
- Any shared I/O helper of your own that accepts an `AbortSignal` — thread it
  through rather than re-deriving a deadline.
- Subprocess bridges: register a signal listener that calls
  `child.kill('SIGTERM')` on abort.

Handlers without real I/O (pure compute, LLM stubs) may ignore the signal.
The runtime wraps each handler call in a `Promise.race` against a
signal-aborted fallback so ignorant handlers still honour the timeout /
cancel clock. This is documented as residual DoS and accepted.

External abort sources:

1. An external `controller.abort()` from a host (e.g. a dashboard cancel button).
2. `SIGINT` to the `warpline run` CLI entry - propagated as an `AbortError`
   via the same controller.
3. Per-attempt timeout - internal, handled inside `invokePlugin`.

## 5. Run Artifact and Run Log Shapes

Warpline keeps **three records of a run**, in three formats, in two
directories. They answer different questions, and reading one as another is
the mistake this section used to make.

| Written by | Document | Files | Answers |
|---|---|---|---|
| `warpline run <plugin>` — one plugin, invoked directly | `RunArtifact` | `<home>/runs/<run_id>.json` and a `<run_id>.log` transcript | what happened on each retry attempt of one invocation |
| an engine advance — every due plugin in one pass | `RunLog` | `<home>/runs/<run_id>.json` | what the whole pass did, plugin by plugin, as one document |
| an engine advance, additionally | JSONL run log | `<home>/logs/runs/YYYY-MM-DD.jsonl` | what happened across many runs on one day, as a stream to tail or grep |

The first two share a directory and a filename pattern and are not the same
shape. The third shares neither, on purpose — see below.

**No transcript is written today.** Nothing in this runtime produces a
`<run_id>.log`. A plugin's output is redirected to stderr for the length of its
invocation (§ 11) rather than captured, and nothing else writes one — so the
first row above, the layout below it, and every sentence about a transcript in
§ 6 describe a file no home currently contains. They are kept rather than
deleted because the prune already enumerates and deletes the pair correctly, and
because giving that file a writer is planned rather than abandoned. Read all of
them as conditional on that landing, and do not build a reader that expects the
file to be there.

§ 6 turns on that distinction: the 20-newest trim only ever sees a
`RunArtifact`, only `pruneRunLogs` deletes an advance's `RunLog`, and the JSONL
stream prunes itself on the same window from the same constant.

### The run artifact

One plugin, invoked directly, writes one file today and is specified for two:

- `<run_id>.json` - structured summary, including every retry attempt. Written.
- `<run_id>.log` - captured stdout + stderr, with `=== Attempt N ===`
  delimiters between retries. **Not written today** — see the note above.

JSON schema:

```json
{
  "run_id": "<uuid>",
  "plugin": "<plugin-name>",
  "started_at": "<iso>",
  "completed_at": "<iso>",
  "status": "success | failed | cancelled | timeout | running | delegated",
  "summary": "<final result summary>",
  "user_initiated": true,
  "attempts": [
    {
      "attempt": 1,
      "started_at": "<iso>",
      "elapsed_ms": 1234,
      "status": "failed",
      "error": "rate limited"
    },
    {
      "attempt": 2,
      "started_at": "<iso>",
      "elapsed_ms": 987,
      "status": "success",
      "error": null
    }
  ],
  "final_error": null,
  "cancelled": false,
  "timed_out": false,
  "retried": true
}
```

Log file, as specified — and again, nothing writes one today:

```
=== Attempt 1 ===
<captured stdout + stderr for attempt 1>
=== Attempt 2 ===
<captured stdout + stderr for attempt 2>
```

Cancelled runs persist with `status: 'cancelled'` and partial attempts. The
transcript is where whatever the handler emitted before the abort would go,
once there is one.

A `RunArtifact` also carries an optional `plugin_entries`, kept only for
backward compatibility with an older combined engine-run shape. Nothing writes
it. The `plugin_entries` an advance fills belongs to the run log below, and the
two are unrelated.

### The run log

An engine advance writes one `RunLog` for the whole pass, and no `.log`
sibling — the transcript file belongs to the direct-invocation path.

```json
{
  "run_id": "<run-id>",
  "started_at": "<iso>",
  "completed_at": "<iso>",
  "status": "complete | partial | failed | interrupted",
  "resumed_from": null,
  "summary": "Engine run <run-id>: 3 plugins processed",
  "plugin_entries": [],
  "manifests_loaded": 3
}
```

`completed_at` is null for a run that was interrupted. `resumed_from` names the
run this one continued, and is null for a fresh advance.

`status` is `failed` when the advance loaded no plugin manifests at all: a
readable plugin root holding nothing importable, or one whose every manifest
threw on import. That is a distinct outcome from `partial`, which means some
plugins ran and others did not — a root that loaded manifests and executed them
never reports `failed`, however many of them failed individually. A root that
cannot be read at all is a third thing again, and is refused before the run
starts, so it writes no run log to carry a status.

The quiet-hours skip reports the same status a normal advance would for that
root. A skipped cycle over a root that loaded no manifests is still a cycle
over a root that loaded no manifests, so it reports `failed` and calls
`onRunFailure` from that path — it writes no run log, because it did no work.
The same holds one step up: a root that loaded some of its manifests and failed
on others reports `partial` on this path too, and calls `onRunFailure` naming
the plugins that did not load. No plugin runs during a skip, so a load failure
is the only way to be partial here — but a quiet hour is not a reason to stop
reporting one.

Only the plugin root's own directories are candidates. A stray file in the root
is not a plugin and is not a failure, because there is no plugin there to fail;
a symlink resolving to a directory is a plugin like any other. A directory that
holds no loadable manifest IS reported as a failure — that is a
misconfiguration an operator can act on, not a stray file.
Quiet hours suppresses the work, not the verdict on the root.

`plugin_entries` is the only accumulated field, and it is deliberately the only
one. **A host that wants run telemetry derives it from the per-plugin entries.**
The runtime does not compute aggregates, does not store them, and does not
define what an aggregate should mean for a host whose plugins it has never
seen — the same "derive, don't store" rule the rest of this runtime follows.

`manifests_loaded` sits beside it without contradicting that rule, because it
is not derived from anything. It is how many plugin manifests the loader found
for this run — an input to the advance, not a value computed from its outcome.
It is also not derivable from `plugin_entries`: a run that stops at a gate
never reaches the later levels, so it holds entries for fewer plugins than it
loaded, and reading the entry count as the manifest count would under-report on
the ordinary gated path. The field is optional, never defaulted, so a run log
written before it existed reads back as absent rather than as a run that loaded
nothing — and zero, which is the signature of the empty root, keeps meaning
exactly that.

Before 0.2 this document also declared six fields nothing here ever wrote and no
document ever described: an optional aggregate metrics object, a per-mode array
with its own two sibling schemas, and four task-board counters that were written
as literal constants and read by nothing. They came across with the extraction
and were public API through `warpline/schemas/*` from 0.1.0. All six were
removed in 0.2, along with the two stranded schemas and their inferred types.

A run log written by 0.1.x still parses against the current schema: unknown keys
are stripped rather than rejected, so no migration exists and none is needed.
The break is compile-time only, for a consumer that named one of the removed
types.

### Plugin entry status

Each entry in `plugin_entries` records how one plugin ended in that run. The
set is closed — an unlisted value fails validation rather than being dropped.

| Status | Meaning |
|--------|---------|
| `completed` | The handler ran and returned a result the engine accepted |
| `failed` | The handler threw, returned a failed result, or the plugin's manifest never loaded |
| `skipped` | The plugin was not due — fresh, filtered, locked, without a session Grant, or holding a declared dependency whose last run failed |
| `gated` | Supervised: the handler ran and its result was parked pending a human answer |
| `denied` | A human answered no, and the answer still applies to what is being proposed |
| `refused` | A human answered yes, and the conditions that yes was bound to no longer hold |

`plugin_entries` therefore no longer means "the plugins the engine attempted".
A plugin whose `manifest.ts` failed to import gets a `failed` entry too,
carrying the loader's error text as its `result_summary` and a zero
`elapsed_ms` — nothing ran. Without those entries a root whose every manifest
was broken and a root that was simply empty would write the same log, and
telling those two apart is the whole diagnosis.

`gated` and `denied` are the two outcomes of supervision, which is why they sit
together and apart from `skipped`. A denial recorded as `skipped` would land in
the same bucket as "no Grant" and "still fresh", and the log could no longer
tell an unanswered question from an answered one.

`refused` sits beside them on the same argument one step over. It is the
outcome of a content approval that existed and stopped applying, and recording
it as `skipped` would put a lapsed authority in the same bucket as "no Grant"
and "still fresh" — so the log could no longer tell an authority that lapsed
from one that was never asked for. A `refused` entry carries a `reason`, the
closed-set cause below; every other status leaves it absent. The field is
optional and never defaulted, so a run log written before it existed reads back
as what it says rather than as a refusal with a placeholder cause.

Adding a member fans out into this table and into every run log written
afterwards, so the set is not extended casually.

### Refusal reasons

A content approval that exists and does not authorise a fire refuses for
exactly one of three reasons. The set is closed and validated on parse, because
this is the value an unattended scheduler switches on: an open-ended reason
string would let something the runtime did not author reach that switch, and a
consumer parsing prose breaks the first time the wording changes.

| Reason | Meaning |
|--------|---------|
| `indeterminate` | A fire was marked and never confirmed, so the runtime cannot tell whether the bytes already shipped |
| `outside_window` | The approval window has closed, or its zone no longer resolves on this host |
| `content_moved` | The approved bytes are no longer what would ship |

They are decided in that order, and the order is not arbitrary. An
`indeterminate` mark outranks both of the others because neither "the window
closed" nor "the bytes moved" can be answered honestly while the runtime does
not know whether the fire already happened.

`already_spent` is deliberately **not** among them. A spent approval is no live
authority and no operator error — the runtime already fired those bytes, which
is the instruction having been carried out. It is a state report, and there is
nothing in it for a consumer to act on.

An approval that has not opened yet is likewise no refusal: it is the
operator's own instruction arriving on time, and the plugin is ordinary
not-due.

A refusal also reaches the board, as a `notice` carrying
`metadata_json.event = "plugin_refused"` and the same closed `reason`. It is
not filed as a skip: the run log's `refused` exists to tell an authority that
lapsed from one that was never asked for, and a skip event would lose that
distinction one log over. The event's summary is built from the plugin name and
the reason value alone — never from the approved bytes, and never from the
gate's own detail string, so each persisted string keeps exactly one author.

### Output records

`SkillResult.artifacts_produced` is an array of Output records — a thing the
plugin produced that an operator will read and take away. `SkillResult.schema_version`
defaults to `2` to mark the change.

A handler may also write a bare path string here. It normalizes at the parse
boundary to `{ type: 'artifact', format: 'markdown', path: <the string> }`, so
nothing downstream branches on which arm an entry arrived through. That arm is
the pre-0.2 shape, it stays valid until 1.0, and it is reachable only because
`HandlerFn` returns the schema's input type — see § 4.

| Field | Type | Required | Notes |
|---|---|---|---|
| `type` | string | yes | Semantic kind, chosen by the plugin — `report`, `brief`, `artifact` |
| `format` | `markdown` \| `json` \| `html` \| `text` | no, defaults `markdown` | Rendering key |
| `run_id` | string | stamped | The run that produced it |
| `produced_at` | ISO 8601 | stamped | When the producing run accepted it |
| `body` | string | exactly one of | Inline content, capped at 16384 UTF-8 bytes |
| `path` | string | exactly one of | Filesystem path to the content |

Exactly one of `body` and `path`. Declaring both fails validation and declaring
neither fails validation, so a reader never has to decide which one wins.

The inline cap is **16384 UTF-8 bytes**, and the unit is the point. It is
enforced with `Buffer.byteLength`, not with a string length: a string length
counts UTF-16 code units, so `'😀'.repeat(5)` measures 10 against a limit of 10
while costing 20 bytes on disk. The constraint being bounded is not the number
of characters an operator typed, it is the size of `engine-state.json`, which is
reparsed and rewritten whole on every advance and every `warpline plan` — an
inline body sits inside a parked gate in that document.

The cap is measured **after** credential redaction. `invokePlugin` replaces
every value it resolved from `secrets` with `[redacted]` before handing the
result to this schema, so the bytes counted here are the bytes that get
written. `[redacted]` is ten bytes, so a declared credential shorter than that
makes a result larger than the handler returned it — an inline body within ten
bytes of the cap carrying a short credential is refused at the parse boundary
rather than persisted. Refusing it there is the point: `engine-state.json`
embeds this same schema, it is reparsed whole on every read, and an over-cap
body written into it makes every later read of the document fail.

`run_id` and `produced_at` are stamped by the runtime at the point it accepts a
result, never by the plugin. A plugin that could stamp its own provenance could
claim a run it did not come from, so whatever a handler puts in those two fields
is overwritten rather than preferred. Both are optional in the schema for
exactly that reason: a handler must be able to return an Output without them.

`format` is a closed enum. An unrecognised value fails validation rather than
being dropped; an undeclared one reads `markdown`. A format the renderer does
not understand is shown as preformatted text, never hidden.

An Output record is persisted only for an attempt that actually produced one.
Nothing synthesizes an empty Output for a run that produced none.

The runtime never deletes a path Output's target, but nothing stops the operator
or the producing plugin from doing so. A path that no longer resolves is a
defined missing state that renders as such — not an error.

The pre-0.2 bare-string form still validates. A string normalizes at the parse
boundary to `{type: 'artifact', format: 'markdown', path: <the string>}`, so
nothing downstream branches on which form an entry arrived through. The string
form stays valid until 1.0 and is removed then with an announcement.

### The JSONL run log

An advance also appends a line per event to a daily file at
`<home>/logs/runs/YYYY-MM-DD.jsonl`. One file per day, one JSON object per line.
The audience is a headless scheduled cycle nobody watched: the run artifact and
the run log each describe one run, and this is the format you tail or grep when
the question spans several.

The path is **`<home>/logs/runs/`, not `<home>/runs/`**, and the two are easier
to confuse than they look. The logger joins its configured logs directory with
its own `runs/` segment, so pointing it at the warpline home root would land the
daily files in `<home>/runs/` — the directory `pruneRunLogs` and
`trimPluginHistory` scan for the two `<run_id>.json` shapes above. The literal
path is what this spec fixes.

A line carries:

| Field | Type | Notes |
|---|---|---|
| `ts` | ISO 8601 | when the line was appended |
| `run_id` | string | the advance that emitted it; shared by every line of one run |
| `level` | `info` \| `warn` \| `error` | `error` for a failed plugin, `warn` for a run that did not complete cleanly |
| `event` | string | `run_start`, `plugin_result`, `run_end` |
| `plugin` | string, optional | present on `plugin_result` |
| `status` | string, optional | the plugin's outcome, or the run's |
| `elapsed_ms` | number, optional | the plugin's duration |
| `detail` | string, optional | the plugin's result summary, or the run's |

The first line is written after the plugin root has been loaded and accepted, so
an advance refused for an unreadable root leaves the home byte-identical, as it
did before this format existed.

Retention is the **same window** as `pruneRunLogs`, read from the **same
preferences key** (`retention.days`, § 6) rather than restated — a daily file
whose mtime is older than that window is unlinked at the start of the next
advance **that runs**. An advance skipped for quiet hours returns above this
prune and reclaims nothing (§ 13), so a long quiet window is a stretch of hours
during which nothing here is reclaimed at all. Three formats pruned on three
literals would be three retention rules that agree until somebody tunes one.

## 6. Retention

Three bounds, all of them the operator's, set under `retention` in
`<home>/preferences.json`:

| Key | Default | What it bounds |
|---|---|---|
| `retention.days` | `30` | how long a record survives, by mtime |
| `retention.keep_per_plugin` | `20` | how many records survive, per plugin |
| `retention.max_bytes` | `104857600` | the total size of `<home>/runs/` |

One policy object, read by every path that deletes. Three record formats pruned
on three literals would be three retention rules that agree until somebody tunes
one.

### The two deletion paths

Two things delete out of `<home>/runs/`, and reading this section as though
either were the only one will mislead you about what survives.

`trimPluginHistory` runs after the terminal write of any invocation that
completes with `persistArtifact: true`. The manual path, `warpline run`, passes
it. **An engine advance does not, deliberately** — an advance writes a `RunLog`
rather than a per-plugin `RunArtifact`, so this trim never sees an advance's
output at all. It reads every `<run_id>.json` in the runs directory, filters by
plugin, sorts by `started_at` DESC, and keeps the `retention.keep_per_plugin`
newest.

`pruneRunLogs` runs at the top of every advance **that runs**, over the whole
runs directory. An advance skipped for quiet hours returns above it and prunes
nothing — § 13 says the same thing about the `pruned` count that advance
reports, which is always `0`. So a nightly quiet window does not reclaim disk;
it is the stretch of hours during which none is reclaimed.
It deletes **runs, not files**: a run id is enumerated from the union of the
`.json` and `.log` stems of one directory listing, so a transcript whose
document is already gone is reachable rather than immortal, and is reclaimed on
the first advance after this rule shipped.

Two kinds of record are removed from its candidate set before any bound applies,
and a third is never a candidate at all:

- a run whose document reports the `delegated` status — a result parked pending
  a human's approval;
- a run named by a pending approval gate;
- a run named by a content approval **whose fire window is still open** (§ 10,
  `approvals`). The bytes an operator froze live in the producer's run log, and
  reclaiming that log while their yes is outstanding would leave an approval
  bound to nothing. A stored `run_id` that is neither a pending gate's nor an
  open approval's does **not** protect: a `last_output` pointer and a versioned
  Output's history are documented to dangle (§ 10), and treating a dangling
  pointer as protective would be retain-forever by accident;
- a document that will not parse, which is left on disk so an operator can
  inspect it by hand.

**An approval's protection ENDS when its window closes**, and that is the
deletion path for the approved payload. From the first advance after
`not_after`, the referenced run is an ordinary candidate again and the three
bounds below reclaim it with no new mechanism — automated, and running inside
every advance rather than waiting on operator hygiene. A frozen batch is
recipient data; a carve-out that never released would be retain-forever with a
carve-out's name on it. The binding that named the run is swept in the same
advance (§ 10, "Expiry and deletion"), and both decisions read one predicate, so
a released run and a retained binding cannot come apart. Protection does not
depend on the mark: an approval already spent still protects its run while its
window is open, and a marked-unconfirmed one stops protecting when the window
closes exactly as an unmarked one does.

The three bounds then apply, in this order, to what is left: days, then count,
then bytes. The count bound is applied **within one plugin**, not across the
directory — applied across it, it would evict artifacts `trimPluginHistory` had
just decided to keep. An advance's run log names no plugin, and neither does an
orphan transcript, so all of them share one bucket: on a frequently scheduled
advance `retention.keep_per_plugin` is the bound that binds, well before
`retention.days` does. The byte bound is a per-home total with oldest-first eviction, and
the size counted for a run is its document **plus** its transcript. Where a
transcript exists it is normally the larger of the two, which is why a budget
counting only the document would not bound this directory; no transcript exists
today (§ 5), so today that arithmetic reduces to the document alone. Runs at equal ages are ordered by run
id, never by the order the directory happened to list them.

Exempt and unparseable records count toward the total even though nothing can
evict them. That has a consequence worth stating rather than discovering: a home
whose exempt records alone exceed `retention.max_bytes` evicts every ordinary
run and is still over budget. A single large legitimate record can likewise
evict several small ones. The prune's own test suite in this repository is what
holds all of the above — its byte-bound case carries a `delegated` run and a
gate-referenced run as the two oldest and largest records in its fixture, which
is the case an eviction loop written over the raw directory listing gets wrong
while passing.

**Both paths unlink the pair.** A run's `<run_id>.json` and its `<run_id>.log`
are deleted together on either path, so neither can strand a transcript. That
rule is in place ahead of the file it protects: with no transcript written today
(§ 5), it has nothing to strand yet.

**Confirming a retention setting took effect is still an observation, not a
read.** Unknown keys in `preferences.json` are stripped rather than refused, so a
misspelled key parses successfully and nothing warns.

What an advance reports is how many runs it removed, not why. Removed means
gone from the directory and not merely selected: a run whose files survive the
unlink — a permission error, a file something else holds open — is not in the
count. `warpline advance
--json` carries a `pruned` count for the advance that just ran, and the dead-man
file (§ 13) carries the same number for the last advance that returned. Read it
for what it is: one integer standing for all three bounds, which cannot say
which of them bound, over a prune that runs with the built-in defaults when your
key was stripped. So a non-zero count does not attribute the eviction to the
setting you just made, and a `0` says only that nothing was eligible. The count
also covers one of the two deletion paths — `trimPluginHistory` runs after
`warpline run` and never during an advance, so nothing it removes is in there.

To confirm a bound: set it, run an advance, and list `<home>/runs/`. The count
is what tells you whether looking is worth it.

## 7. HTTP / SSE surface (not in this repo)

The source system exposes the runtime over HTTP + SSE from a local web
dashboard (run trigger, live attempt events, cancel via DELETE). The dashboard
was not extracted — it is a candidate for a later release. The runtime's
contract is API-first regardless: `invokePlugin()` accepts an external
`AbortController` and emits attempt events, so any host (CLI, dashboard,
another process) gets identical semantics.

## 8. Test Patterns (repository-only)

> These patterns govern warpline's own suite, which is written against
> `bun:test` and does not ship in the package. They are recorded here because
> they are runtime behaviour, not test trivia — but if you installed warpline
> rather than cloned it, nothing in this section applies to you.

Fixtures and mocks for plugin runtime tests follow two rules:

1. NEVER use `mock.module` for plugin registry / engine / invokePlugin
   overrides. It is process-global and leaks across test files. A mock
   established in file A will silently apply to unrelated files B, C,
   D in the same `bun test` run.
2. Use `spyOn(obj, 'method')` with describe-level `beforeEach` / `afterEach`
   to set up / tear down mocks. Per-test `spyOn` + `mockRestore()` has
   leaked between tests in the same describe block.

Pattern:

```typescript
describe('my route', () => {
  let spy: ReturnType<typeof spyOn>
  beforeEach(() => {
    spy = spyOn(engine, 'loadPluginManifests').mockResolvedValue({
      manifests: fixtureMap(),
      failures: [],
    })
  })
  afterEach(() => {
    spy.mockRestore()
  })
  test('...', async () => { /* ... */ })
})
```

`loadPluginManifests(pluginsDir)` resolves to
`{ manifests: Map<string, PluginManifest>, failures: LoadFailure[], root_error?: { path, code } }`.
A plugin
directory whose `manifest.ts` cannot be imported is absent from `manifests` and
present in `failures` as `{ plugin, error }`, where `plugin` is the directory
name (a broken manifest has no trustworthy `name` field) and `error` is the
thrown `Error.message` — no stack trace. A directory whose name is a member of
`Object.prototype` fails the same way, without being imported at all.

A manifest that imports cleanly is then **validated against
`PluginManifestSchema`**, and one that does not satisfy it is a load failure of
the same shape — absent from `manifests`, present in `failures`. The loader
validates rather than asserts: it previously cast the imported value, which made
every invariant the schema states decorative at runtime. That is load-bearing
for the content approval class, whose `approval_class` and `dependencies` fields
together decide whether the bytes a human reviewed are the bytes that fire — a
content-class manifest declaring two dependencies would bind its approval to the
first while shipping the second's unreviewed Output to the handler. Refusing the
manifest at load is the fail-closed outcome: the plugin never enters the map, so
nothing runs it, and `warpline plan` exits 1 naming the directory.

The failure text for an invalid manifest names the field path and the issue
code. It deliberately does **not** carry Zod's own `issue.message`, for the
reason `lib/plugin-config.ts` gives: that message is upstream prose which may
begin quoting the received value in any minor release, and a manifest is
hand-written, so the received value is author input — while this string is
rendered by `warpline plan`, which operators read and share.

`failures` is sorted by `plugin` inside
the loader, so alphabetical ordering is a property of the data rather than of
whichever surface renders it, and it stays an array in every case.

A plugin root that is missing, is not a directory, or cannot be read is a
different thing from a per-plugin failure: there is no plugin to attribute it
to. It is reported on the return as `root_error`, carrying the resolved `path`
and the errno `code`, and `manifests` and `failures` are both empty. The loader
still never throws. `runAdvance` turns `root_error` into a rejection, before
any write; `warpline plan` renders the result without failing, because a
preview of a home that has no plugins directory is a legitimate question with a
legitimate answer. A mock that returns a bare `Map` no
longer satisfies the signature.

Fixture plugins live under `test-utils/fixture-plugins/` in a clone:

| Fixture                    | Purpose                                                 |
|----------------------------|---------------------------------------------------------|
| `success-plugin`           | Always succeeds on attempt 1.                           |
| `retryable-fail-plugin`    | Always retryable failure - exhaust-retries tests.       |
| `retry-then-succeed-plugin`| Fails once, succeeds on attempt 2.                      |
| `nonretryable-fail-plugin` | `retryable: false` - never loops.                       |
| `timeout-plugin`           | Sleeps past `timeout_ms` - verifies fatality.           |
| `abort-aware-plugin`       | Polls `signal.aborted` and exits early.                 |
| `abort-unaware-plugin`     | Ignores signal - verifies `Promise.race` fallback.      |

(The source system's HTTP-layer test patterns — Hono `app.request()` instead
of a real server, per-test registry resets — travel with the dashboard if it
is ever extracted.)

## 9. Session Approval File

A plugin whose manifest declares a non-empty `side_effects` array may not run
until an operator has approved it for this session. The approval is a single
JSON file; there is no daemon, no keyring and no server.

**Path:** `<warplineHome>/.session-approval`, where `<warplineHome>` is
`WARPLINE_HOME` if set, else the nearest ancestor directory containing a
`.warpline/`, else `<cwd>/.warpline`.

### Shape

```json
{
  "granted_at": "2026-08-20T12:00:00.000Z",
  "first_granted_at": "2026-08-20T09:30:00.000Z",
  "expires_at": "2026-08-20T13:30:00.000Z",
  "scopes": ["issue-render", "digest-sender"]
}
```

| Field              | Type               | Meaning |
|--------------------|--------------------|---------|
| `granted_at`       | ISO 8601 string    | When the most recent grant was written. |
| `first_granted_at` | ISO 8601 string    | When the FIRST grant in this window was written — the anchor for the 23-hour ceiling below. Optional on read, always written. |
| `expires_at`       | ISO 8601 string    | When the grant stops being honoured. |
| `scopes`           | `"*"` or `string[]` | `"*"` approves every plugin. An array approves exactly the plugin **directory** names it lists — the same key the engine passes to the gate, not `manifest.name`. Always written sorted, so both the file and its diff are stable. |

The file is written with `JSON.stringify(payload, null, 2)`. It is a plain
TypeScript `interface`, not a Zod schema, and carries no `schema_version`: the
only compatibility rule it needs is the one below.

**Compatibility.** `first_granted_at` was added in 0.1.0. Every read is
`first_granted_at ?? granted_at`, so a file written without the field still
loads and its single grant time serves as its own anchor. An older build
reading a newer file ignores the field. Removing the field later would silently
reset every ceiling anchor to the latest grant, which is the failure the field
exists to prevent — treat it as permanent.

**Approving a parked result never writes this file.** `warpline approve` answers
whichever gate is waiting, and when a parked result is waiting it records that
result and touches the session approval file not at all — not its scopes, not
its expiry, not its mtime. The gate-apply path reaches no symbol in the module
that owns this file, so there is no code path from an outcome review to a grant
write.

The two clocks stay separate for that reason. The 23-hour ceiling below bounds
how long side-effect AUTHORITY lives, anchored at `first_granted_at`. The gate
ceiling in § 10 bounds how long an OBSERVED OUTCOME stays acceptable, anchored
at the gated run's completion. They read the same number and answer different
questions; neither is derived from the other.

### Read semantics

Reads are **fail-closed and never throw.** A missing, expired, corrupt,
truncated or unreadable file is treated as *unapproved*; an exception here
would surface as an error a caller could catch and mistake for a recoverable
condition, which is the one failure mode a gate must not have.

A grant whose `expires_at` **equals** the current instant is still valid — the
comparison is `now > expires_at`, not `>=`.

A grant whose `expires_at` is **not a parseable date** is corrupt, and so
*unapproved*. It is called out because the comparison alone does not reach that
answer: `new Date('nonsense').getTime()` is `NaN`, and `now > NaN` is false, so
an unguarded read treats a garbage expiry as an expiry infinitely far away. The
same holds for an absent `expires_at`. Both are refused before the scope list
is consulted.

An unapproved side-effecting plugin is recorded `skipped` and the run
continues. The gate withholds execution from one plugin; it does not abort the
run.

A plugin whose `side_effects` array is **empty** is never gated. The engine
tests for a non-empty array before it consults the gate at all, so
`checkApproval` is never called for such a plugin and it runs whether or not a
grant exists — always, including with no grant file on disk at all. This is
worth stating because everything above reads like a universal rule: it is not.
The gate covers the effects a plugin *declares*. A plugin that performs an
effect it did not declare is a plugin bug, and no approval state changes that.

**`warpline plan`'s `approved:` column is rendered from whichever mechanism
authorises that plugin's class**, not from this file for every plugin. A
content-class plugin's column reads its content approval's standing (§ 10,
`approvals`); every other plugin's reads this grant, unchanged. Rendered from
the grant for all of them the column was wrong in both directions at once — a
plugin with a live approval and no grant previewed as blocked while it was
authorised, and one under a live `scopes: '*'` grant and no approval previewed
as ready while it was refused. The preview exists to tell an operator whether a
frozen batch will go out, so a column answering with the wrong file is a worse
failure than the disagreement-by-one-comparison the preview is otherwise built
to avoid. Reading the record here decides nothing: previewing is not firing, and
the fire decision is still read at exactly one call site inside the engine.

### Who reads the grant, and who mints a capability

Two invariants, and they read like a contradiction until you notice they are
about different files.

**The declaration mints; the engine checks.** A capability member reaches a
handler only when the plugin's manifest declared the effect that member
performs — the declaration is what mints. Whether the run carries approval for
that effect is a separate question, and it is answered ONCE, by the engine,
before invocation. One of each, in different files. So "no capability re-reads
the grant" and "authority flows only from a checked grant" are both true at the
same time: the capability layer imports nothing that reads the grant file and
calls no read function, and the answer it works from is handed in by the caller
that did read it.

**The mint is called from exactly one place.** `invokePlugin` is the only
function that mints a context, so there is no path from `warpline approve` —
the verb that WRITES the grant — to a capability. The verb that grants
authority and the code that hands authority out do not meet. That is not a
convention. A test in this repository asserts set equality over every non-test
source file that names the mint, so a third one reddens on the day it lands,
and a lost one reddens too.

**A content-class plugin does not consult this grant at all.** A manifest
declaring `approval_class: 'content'` (§ 1) is answered by its own approval
record in § 10 and by nothing else — the runtime branches on the declared class
ABOVE the grant read, so the grant is not even consulted. That is what keeps a
live `scopes: '*'` grant from composing additively with an approved batch and
rendering the approval decorative. Disjointness is a stronger property than
ordering, and it is the one being claimed here.

A content-approved plugin also declares `autonomy_level: 'autonomous'`, and that
is doctrine rather than a convenience: a content approval IS the review,
performed before the bytes shipped rather than after. A plugin asking for a
human at fire time as well would ask the same human the same question twice.
The manifest schema enforces it at parse time, so the two cannot come apart.

A caller that reads no grant at all — `warpline run`, which starts a plugin by
hand — says so explicitly rather than by omission. It passes the witness arm
naming a manual run, and receives only the members that need no approval. The
obligation is fixed at the signature: the witness is a required parameter of
`invokePlugin`, so a caller cannot be added without answering. Within one
package that witness can of course be constructed by hand; this runtime does
not sandbox its handlers, and nothing here claims otherwise. What is bought is
that the question cannot be skipped, not that the answer cannot be written.

### The review gate, and why the content class is exempt

`review_gate` is an operator preference, `true` by default. On that default the
engine treats every `autonomous` plugin as `supervised` AFTER invocation: it
runs, its result is parked in `pending_gates`, it is recorded `gated`, and the
advance stops after its level. This is independent of the side-effect gate
above — it applies whether or not the plugin declares any side effect.

**A plugin declaring `approval_class: 'content'` is not promoted.** One conjunct
on the promotion condition, and nothing else about it changes: every other
plugin behaves exactly as before, `review_gate: false` included.

The argument is that a content approval IS the review. The operator read the
exact bytes and said yes before they shipped, rather than being shown the result
after. Promoting a content-class plugin would ask the same person the same
question twice — and because a parked gate stops the level loop, a plugin doing
what it was approved to do would fire, park, and halt the rest of the fleet
behind itself on every single advance.

What makes the exemption safe rather than a hole is the manifest's own
cross-field rule (§ 1): a content-class manifest is validated
`autonomy_level: 'autonomous'` at `.parse()` time, and an invalid manifest is a
hard stop at import. So the exemption cannot be reached by a `supervised` plugin
— a manifest declaring both does not load at all.

### Merge semantics (`warpline approve`)

Grants are **additive by default.** An operator typing `approve b` after
`approve a` means "and b", not "instead of a" — losing an earlier grant to a
later one is the failure this behaviour exists to prevent.

| Rule | Behaviour |
|------|-----------|
| Scopes | Unioned with the live grant and written sorted. A `"*"` on either side absorbs the other. |
| `expires_at` | **Preserved** from the live grant. An explicit `--ttl` may extend it, never shorten it. |
| Ceiling | `expires_at` is capped at `first_granted_at + 23h`. A capped grant reports the cap on stdout. |
| `--long` | Permits an expiry past the ceiling, and prints that it did. |
| Prior `--long` grant | The ceiling never shortens time already held. `mergeGrant` caps at `max(first_granted_at + 23h, live expires_at)`, so a window opened by an earlier `--long` survives every later plain `approve` unchanged, and `capped` is false. Revoke to close it early. |
| `--replace` | Overwrites the scope list and resets `expires_at`; `first_granted_at` is preserved. |
| Unparseable `first_granted_at` | The grant is **not merged onto**. The anchor is what the ceiling is measured from, so an anchor that will not parse is a ceiling that cannot be computed. `mergeGrant` starts a fresh window instead, which costs the operator scopes they re-grant in one command rather than handing out a window nobody authorised. |
| Expired grant | Not merged onto. The window has closed; the next grant restarts it, with a new `first_granted_at`. |
| Default TTL | 4 hours. |
| `--all` | The only path to `"*"`. No positional name is ever treated as a wildcard. It prints the number of side-effecting plugins and the total number of declared side effects it covers before granting. |
| Concurrent approve | The file is not locked, and the outcome is last-write-wins: each invocation reads the live grant, merges in memory and writes the whole result, so of two overlapping invocations the later write wins outright and the earlier one's scopes are lost. |
| Zero duration | Rejected before anything is written. `--ttl` takes a positive integer followed by `m`, `h` or `d`; a bare `0` fails the grammar and `0h` fails the positive-value check. The command exits 1 and the file is untouched. |
| Empty scope list | Reachable only from the library path, which writes an empty `scopes` array. It approves nothing — an empty list is not a synonym for `"*"`. The command cannot produce one: `approve` with no plugin name and no `--all` prints usage and exits 1. |

The 23-hour ceiling belongs to the merge path, not to the file. `mergeGrant`,
behind `warpline approve`, is the only code that computes it; `grantApproval`,
the programmatic pre-grant, writes the lifetime it was handed with no ceiling
logic in it at all. An embedder calling the library directly can therefore hold
a grant well past 23 hours, and a grant file's expiry is not evidence that any
ceiling was ever applied. Read "capped at 23h" as a property of the command,
never of the format.

An unknown plugin name aborts the whole command, writes nothing, and exits 1 —
partial application is not a state the file is ever left in.

`warpline revoke` deletes the file and exits 0, including when no grant exists.
After a revoke, every side-effecting plugin reads as unapproved.

**Nothing reachable from a run writes this file.** `checkApproval` — the only
function the engine calls — opens it read-only, and the write path
(`grantApproval` / `mergeGrant` / `revokeApproval`) has no caller inside
`runAdvance`. That is a property of the call graph, verifiable by inspection,
and a test pins it: a full advance over side-effecting plugins leaves the file
byte- and mtime-identical.

---

## 10. Engine state

`~/.warpline/state/engine-state.json` is the single JSON document the engine
persists between runs. It is operator-owned and hand-editable, which is the
whole reason the read policy below is written down rather than inferred.

### Read policy

There are two reads and they behave differently on purpose.

| Read | Used by | Missing file | Unusable file |
|------|---------|--------------|---------------|
| Write-capable | Anything that may go on to write state — an advance, the task board | Defaults | Refuses: names the path and the reason, exits non-zero, changes nothing on disk |
| Read-only | Commands contracted never to write, `warpline plan` above all | Defaults | Defaults |

One refusal is shared by both, and it is the only one: a **format version this
build does not understand**. See [Format versions](#format-versions) below.

The write-capable read fails closed because the alternative is worse than a
failure. Returning defaults from an unreadable document means the next write
persists those defaults, and the operator's task history, deferrals and
completed tasks are gone with nothing to recover them from. A document we
cannot read is a document we must not overwrite.

Nothing on either read path writes. There is no `{path}.corrupt` copy any
more — that backup existed only to preserve evidence before defaults destroyed
it, and refusing preserves the original in place instead. A read-only command
that hits an unusable document degrades its output; it does not leave a file
behind in the operator's home.

A missing file is not an unusable one. A fresh install has no state document
and both reads return defaults, so failing closed does not break first run.

### Format versions

There are two, and they answer two different questions.

| Version | Where | Question it answers |
|---------|-------|---------------------|
| `schema_version` | a field inside `engine-state.json` | what SHAPE is this document |
| the home layout version | `~/.warpline/version` | what LAYOUT is this home |

Both are currently **2**. The layout version is stored at the home root rather
than under `state/`, because a layout-level fact filed inside `state/` would be
covered by the per-file versioning it exists to describe.

#### `schema_version`

Read tolerantly: any non-negative integer parses, so a build reading a file
one version behind still loads it.

One version is refused. A `schema_version` above the newest this build knows
is reported as *your build is older than this file* — a distinct message from
the corrupt-document one, because the operator's fix is different. Upgrade
warpline rather than letting an older build rewrite a newer document down to
the fields it happens to understand.

A `schema_version` that is not a non-negative integer — a fraction, a negative
number — is not a version at all and is refused as an unreadable document, never
treated as an older one to load tolerantly.

#### `~/.warpline/version`

A bare integer and nothing else. Exactly one trailing newline is trimmed before
the format is checked, so `2` and `2\n` are the same file; ` 2`, `2.0`, `2a`
and `two` are not versions and are refused as **unreadable**.

Unreadable is a different outcome from **older**, deliberately. An unreadable
version file is not treated as version 1 and migrated over — migrating over it
would destroy whatever the file was trying to say, and a file the runtime
cannot interpret is the last thing it should overwrite.

**A missing file means version 1.** Every home written before this file existed
is a version 1 home, and there is nothing to migrate to make that true.

#### Refuse-newer, on both read policies

A format version above the newest this build knows — either one — aborts with a
non-zero exit and a message naming the version found and the highest version
understood. It never degrades to defaults, and it never skips.

This is the one place the read-only policy does not return defaults, and the
asymmetry is the point. Defaults are an honest answer about a document this
build cannot READ: the preview says so and shows nothing. They are a dishonest
answer about a document a NEWER build wrote, because that home is not empty —
it holds state this binary is too old to see. `warpline plan` rendering such a
home as empty and healthy would tell an operator that an approval they granted
does not exist.

**`warpline plan` aborts here too, and it is the only thing it aborts on.** The
preview degrades around every other failure — a plugin directory that will not
load, a state document it cannot parse — because a partial answer about a home
it can read beats no answer. It exits `1` on a format version it does not
understand, with the same message on stderr and nothing on stdout, so a script
reading the exit code is not handed a plan-shaped document describing a home
this build cannot see. That `1` is the usage-error row of the exit-code table in
[§ 11](#11-exit-codes): the command ran nothing and wrote no plan.

The refusal carries its own error type, separate from the unusable-document
one. `warpline approve` and `warpline deny` report an unusable document as
*"Cannot read engine state"*; reusing that type would have them report a
perfectly well-formed newer home as corrupt, sending the operator to the wrong
remedy.

#### Migrate-on-write, and the backward-compatibility promise

An advance stamps the current version on both files — the document's
`schema_version` and `~/.warpline/version` — in the same locked region as the
end-of-run state write. That is the only migration site; the board's state
writes never stamp a version, because they never read the layout one.

The promise runs one way. A build reads any format version at or below its own
and refuses anything above it. So an older home upgrades silently, and a newer
home stops an older build instead of being quietly rewritten down to the fields
that build happens to know.

**The consequence is a one-way door, stated plainly:** once an upgraded build
has completed a single advance against a home, every earlier build refuses that
home from then on. There is no supported rollback, and that is the intended
behaviour rather than a gap. Corrections are forward only — a deprecation plus
a patch version, never an unpublish.

`~/.warpline/version`'s format is a permanent on-disk contract. It cannot be
changed later without a third version mechanism, which is why it is the
narrowest thing that could work.

### Unknown top-level keys

Unknown top-level keys round-trip. A field a newer build wrote survives being
read and rewritten by an older one, so a rollback does not silently delete it.

The accepted cost: a typo'd top-level key round-trips silently instead of
failing validation loudly. The named fields stay strict, so a typo surfaces as
a missing value rather than as a rejected file.

### `plugin_runs`

A record keyed by plugin name, holding the last run of each. It is what the
TTL staleness check reads, and the only field that check consults is
`last_run_at`.

The dueness evaluator is a second reader of the record, and the first reader for
which `status` decides whether a plugin runs at all. A plugin holding a declared
dependency whose entry here records `failed` is not due, for the reason
`dependency_failed`, and is recorded `skipped` with a summary naming every such
dependency in manifest-declared order. Until that gate existed, the dependent ran
and read whatever the failed producer had left behind on an earlier cycle — a
diff-against-history consumer then reported "no change" for a cycle in which
nothing was observed, and no field distinguished the two.

There is no data migration. The field is read, never written or reshaped, and no
schema changed. What does change on upgrade: an existing home already carrying a
`failed` status for a scheduled dependency begins gating that dependency's
dependents on the first advance afterwards. That is the correct behaviour and it
arrives without a migration step, so it arrives unannounced.

| Field | Type | Meaning |
|-------|------|---------|
| `last_run_at` | ISO 8601 string | When the run ended |
| `status` | `success` \| `partial` \| `failed` \| `skipped` \| `gated` | How it ended |
| `duration_ms` | integer, optional | Wall time for the run |
| `last_output` | Output record, optional | The most recent Output this plugin produced |

`gated` records a supervised plugin that ran and was parked pending approval.
It is written when the plugin is parked, anchored at the gate's completion
time — a later approval is a separate event and does not move when the work
happened.

It is recorded as a run because it is one. The handler is invoked, and its
declared side effects fire, before the supervision gate sees the result at
all; the gate decides what happens to the result, not whether the work
happened. A parked run that recorded nothing left the plugin due on the next
advance, so its side effects fired again — every advance, for the whole grant
window, on one approval.

`skipped` records a run whose handler returned `skipped` — in practice every
dispatched `[needs-llm]` handoff, since that is the only path producing one
today. The plugin's own terminal status is written through unnarrowed, so a
handoff is not folded into `success`: a consumer reading `lastRun` beside a
carried-forward `last_output` would otherwise be told "produced, and its latest
run is healthy" about a plugin that handed its work to an LLM and produced
nothing. This is not the `delegated` of `deriveRunStatus`, which answers a
different question for the run artifact and the board events; a plain `skipped`
and a handoff lead a consumer to the same action, so this field does not
distinguish them.

A run whose invocation threw is recorded here too, as `failed`. Only
`invokePlugin` throwing out of itself reaches that path — a handler that throws
is caught inside and returns a `failed` result through the ordinary write — and
the reachable cause is a config file that exists but cannot be read. Recording
it is what keeps `status` a fact about the last run: without the write, the
previous run's entry stayed and `lastRun` named a run two advances back.

The status set is closed. Adding a member fans out into this document, and
into every operator state file written afterwards, which is why it is not
extended casually.

#### What the dependency gate does not cover

Five limitations, written down here rather than left for a reader to discover.

**The latch, and how it clears.** The gate reads the LAST run's status, so a
dependency whose last run failed gates its dependents until it runs again
without failing. In the ordinary case it self-clears on the very next advance:
the dependency is due, it runs, its entry is overwritten, and its dependents are
due again. It cannot be cleared by hand — `warpline run` invokes one plugin
standalone and writes no run record, so a manual run of the failed dependency
leaves the latch exactly where it was. It is genuinely sticky only for a
dependency that has stopped being scheduled at all: a `manual` dependency nobody
invokes under an advance, one filtered out by the active profile or tier, and —
the worst case — one deleted from the plugin directory outright, whose stale
`failed` record outlives its manifest and can never be overwritten. A dependent
declaring a dropped dependency is then gated permanently. Editing
`engine-state.json` is the only way out.

**One hop only.** In a chain A → B → C, a B gated by this reason writes no run
record, so B's own recorded status stays whatever it last was — very likely
`success`. C is therefore not gated, and once C's own freshness window expires it
runs against B's stale data, which is exactly the failure the gate closes one
level up. Every one-hop edge is covered; the second hop is not.

**A manifest that never loaded is a blind spot.** A plugin whose `manifest.ts`
fails to import is recorded as a `failed` run-log entry and a failed engine
state, but it writes no `plugin_runs` record at all — nothing ran. Its dependents
are therefore not gated. Fixing it here would mean writing a run record for a
plugin that never ran, moving a `last_run_at` for a run that did not happen, so
the gap is named rather than closed.

**A declared dependency that is not installed does not gate.** A name in
`dependencies` with no plugin behind it has no run record, and an absent record
is not a failed one. The engine warns about the unresolved name at load time and
`topoSort` ignores it for ordering; the gate deliberately adds no second roster
check of its own, because that would be a second dependency signal answering the
same question.

**`warpline plan` and an advance can disagree, in one direction only.** The gate
reads a run outcome, and a preview does not run anything. `plan` walks levels
against the state document as it sits on disk; an advance evaluates against a
`plugin_runs` its own level loop is overwriting as it goes. To keep the preview
from publishing a skip for every dependent on the self-clearing path above, the
evaluator takes an optional `dueAtEarlierLevel` set — the plugins an earlier
level of the same preview already found due — and does not gate on a dependency
in it. Only `plan` supplies one; an advance leaves it undefined, because its
state is already the answer.

That assumes a due producer clears its latch, which `plan` cannot know. A
producer that is due and fails again leaves `plan` reporting a dependent **due**
where the advance skips it. The reverse can no longer happen: the set only ever
removes a `dependency_failed` verdict, never adds one. The direction is the
point. This runtime asks a human to approve side effects on the strength of what
the preview showed, so a preview that under-states an advance is the input to a
wrong answer, and one that over-states it is only a plugin that did not run.
Pinned by `plan.test.ts` Test 2b.

### `pending_gates`

A supervised plugin's result parked pending a human answer. One entry per
plugin gated by the most recent advance.

| Field | Type | Meaning |
|-------|------|---------|
| `plugin` | string | The gated plugin |
| `run_id` | string | The advance that parked it |
| `created_at` | ISO 8601 string | When the gate was written |
| `payload_summary` | string | The result's summary, for a one-line render |
| `plugin_result` | Skill result | The REAL result the handler returned, Outputs and all |
| `run_started_at` | ISO 8601 string or null | When the gated run started |
| `run_completed_at` | ISO 8601 string or null | When the gated run ended |
| `applied_at` | ISO 8601 string or null | When the gate was applied; null while live |

`plugin_result` is the result the plugin actually returned. Earlier builds
stored a fabrication here — `status: 'partial'`, an empty `artifacts_produced`
— and dropped the real thing. Approval is acceptance of an observed outcome, so
a gate that does not carry the outcome cannot be approved in any meaningful
sense.

`run_completed_at` is written from the same string as the `plugin_runs` entry
the engine writes on the same branch, not from a second clock read. The two
must not disagree by a millisecond: the approve verb anchors
`plugin_runs.last_run_at` at the gate's copy.

**Both clocks null means the gate is unusable.** A gate written by a build
older than this one carries neither, and no real result behind them. Such a
gate is discarded when the state document is read — on the write-capable read,
with a `notice` naming the plugin appended to `events.jsonl`; on the read-only
read, silently, because a command contracted to write nothing may not append to
a log. It is never applied. This is the one deliberate data drop in the format:
there is nothing to migrate, because the real result was never recorded.

#### Applying a gate

`warpline approve <plugin>` applies the parked gate when one is live. What that
does, in order, all decided before anything is written:

0. **Already denied** — `denials[plugin]` exists and its fingerprint still
   matches the live proposal. Refused, and nothing is written. `deny` and
   `approve` answer the same proposal, so applying a result the operator
   explicitly refused is the one gesture the denial record exists to make
   impossible; without this check it succeeded silently and left a live denial
   and an applied outcome for the same proposal in the same document. A
   superseded denial does not block — it is already stale everywhere else. The
   refusal names the denial and says to take it back with
   `warpline deny --remove <plugin>`.
1. **Already applied** (`applied_at` is set) — there is no *live* gate, so the
   verb does not enter this list at all. It prints a note naming the run whose
   result was already applied and then answers the Grant gate, granting the
   plugin permission to run again. **A result is still recorded exactly once**:
   `applyPendingGate` checks `applied_at` itself and refuses a second apply, and
   the verb simply never reaches it. The refusal narrows to a second *apply*;
   the verb's answer to a spent marker is a Grant that says so.

   The branch is chosen on "is there a live gate", not "is there a gate".
   Branching on mere existence locked the Grant verb out for as long as the
   marker lived — up to 23 hours — so an operator whose Grant expired after an
   apply saw the plugin skipped as `unapproved` on every advance and could not
   renew by name, with only the far wider `--all` still working.

   The gate is marked rather than deleted so the note has a run to name and so
   `deny` can tell an accepted result from a pending one. **A gate survives the
   next advance, applied or not**, and is dropped only when it passes the
   23-hour gate ceiling or when the plugin gates again and the new parked gate
   supersedes it. One rule covers the whole array; the clock differs because the
   question does. A marker ages from `applied_at`, the moment the result was
   accepted. An unapplied gate ages from `run_completed_at`, the moment the run
   produced it — the same clock the expiry check uses. A gate carrying no
   `run_completed_at` never survives, since it is refused at apply time anyway.

   Both halves were once overwritten wholesale, and the split that replaced it
   kept markers while still discarding parked results. Nothing chose that: a
   daily engine destroyed the previous day's proposal before anyone could review
   it, and the 23-hour ceiling was unreachable in live operation — a limit only
   a seeded clock could observe.
2. **A dependency moved** — some dependency's `plugin_runs.last_run_at` is newer
   than `run_started_at`. The parked result was computed against inputs that
   have since changed, so it is refused, the gate is discarded, and a `notice`
   naming the plugin is written.
3. **Expired** — the gate is older than the earlier of the plugin's `ttl_hours`
   and 23 hours, measured from `run_completed_at`. Refused and discarded, with a
   `notice`. **This is a state transition the approve verb makes, not something
   a renderer infers**, which is what stops an approval and an expiry racing
   into a double apply.
4. **Otherwise applied.** The `gated` `plugin_runs` entry is overwritten in
   place: `last_run_at` stays at `run_completed_at`, the status becomes the
   result's real terminal status, and `last_output` carries the Output the run
   already produced. `applied_at` is stamped on the gate.

On either refusal the plugin's `plugin_runs` entry is deleted, which leaves it
due on the next advance. The parked result was never accepted, so there is no
accepted run to hold the work back; the `gated` entry existed to stop the
effects re-firing during the hold, and the hold is over.

The delete takes `last_output` with it, and that loss is permanent. The pointer
lives inside the entry, and the carry-forward described in § `last_output` works
by reading the entry it is about to overwrite — with no entry there is nothing
to carry, so the key returns only from a fresh Output on a later advance, never
as the record that was deleted. The plugin being due again is a re-run
opportunity and not a repair: a re-run that also produces no Output leaves the
plugin reading as having run and never produced. What IS bounded is the trigger.
This path fires only on the two refusals above — a dependency moved, or the gate
expired — and the delete is skipped entirely while **either** a denial **or** a
content approval is live against the plugin.

**The `plugin_runs` entry is kept while a denial is live, and the denial is left
exactly as it was.** Deleting the entry is what makes a plugin due again after
its inputs moved, and `proposalFingerprint` reads that entry's Output — so the
delete moves the fingerprint the denial is bound to, the answer stops matching,
and the plugin runs again on the next advance, re-firing the side effects the
operator refused. Silently, under a live Grant: the superseded-denial note only
rides the `unapproved` arm, which a denied plugin never reaches.

The delete is also pointless in that case. A denied plugin does not run, so
making it due achieves nothing; breaking the binding is the only thing it does.

Keeping the entry means the denial stays bound to the **real** proposal. It
lapses on its own if the plugin ever genuinely re-runs with a different Output,
which is what a proposal-bound answer is for. An earlier design re-bound the
denial to `hash(plugin, side_effects, [])` instead — a value nothing can move,
since a suppressed plugin can never produce a new Output — which made the denial
permanent by name and required rewriting its `reason` to say so. Neither the
permanence nor the rewrite is needed once the entry survives.

**The entry is kept while a live content approval references the plugin, on the
identical argument.** An approval is a standing yes to specific bytes, and those
bytes are a `last_output`. Delete the entry that holds them and the fingerprint
the operator's yes was bound to can never be recomputed: the record survives,
matches nothing, and the answer becomes unhonourable — permanently, because the
destroyed Output never returns. A gate belonging to one question would have
silently voided the answer to another.

The reference runs **both ways**, so this is a scan and not a lookup. An
approval is keyed by the CONSUMER and the bytes belong to the PRODUCER, and the
plugin whose gate is being discarded is protected when it is named as either.
The producer case is the one the delete actually destroys.

Only a **live** approval protects. One whose window has closed, whose bytes have
moved, or which is already spent leaves the delete to go ahead exactly as before
— a stale answer protects nothing, here for the same reason a superseded denial
does not. The standing is read through the same function the gate reads it
through; nothing here re-derives the predicate, and nothing here decides whether
anything fires.

The protection lives in `applyPendingGate` rather than in its caller,
deliberately. `approve` refuses on a live denial before reaching that call, so
no CLI gesture arrives here with one standing — which is precisely why a guard
placed in the caller would protect nothing today while being the thing a second
caller tomorrow silently depends on.

`applyPendingGate` takes the plugin manifest map as a required argument for this
reason: the approval names a producer, and that producer's manifest is what the
fingerprint is computed over. It is required rather than defaulted because an
absent map answers "no approval" for every record, which is the destructive
direction.

**The apply runs inside the state document's lock.** `warpline approve`'s named
path takes that lock around its whole read-modify-write — the state read, the
gate dispatch, and the apply loop — using the same derived lock path the
`--content` branch uses. It wraps the loop rather than each call because
`applyPendingGate` writes state per call, so several gated plugins are several
read-modify-writes over one in-memory document and a lock released between them
reopens the window. `applyPendingGate` itself takes no lock; the acquire is
non-reentrant, so one there would nest and deadlock. Without this, a
`warpline approve --content` landing from a second attachment between the read
and the apply was overwritten.

A **superseded** denial does not hold the entry. It is already stale, so the
plugin becoming due again is the correct outcome and the delete goes ahead.

#### Denying a parked result discards it

`warpline deny <plugin>` discards the plugin's **live** parked gate as it
records the denial. Answering a parked result is what dequeues it, exactly as
applying one does. The denial's `reason` says the operator declined that run, and
leaving the run in `pending_gates` made that sentence describe something that had
not happened.

It could not legitimately be applied afterwards either. While the denial holds,
both `approve` arms refuse it. Once the denial is superseded the proposal has
moved — which means `plugin_runs.last_output` changed, which means the plugin ran
again and a newer gate exists — so the old one answers a question nobody is
asking. The only path that ever reached it was `deny --remove`, which would hand
back a stale result the operator had already declined, in answer to a question
they believed they were re-opening.

Nothing durable is lost. The run artifact holds the full `SkillResult` in
`RunLog.result`; `pending_gates` is the review queue, not the record.

An **applied marker** is left alone. It is the trace of a result the operator
accepted, and it is the only thing stopping a second `approve` from re-recording
that result — so a later denial, which answers the standing proposal rather than
that outcome, must not erase it.

`deny` says so on stdout, because the consequence is not visible in the state
file: taking the denial back re-opens the question rather than re-offering the
run.

The handler is never re-invoked. Its declared side effects fired at invocation,
long before the supervision gate saw the result, so re-running would double
effects that already happened. Downstream dependents run on the next advance
under the normal guard chain, not from inside the CLI command.

#### Granting a plugin that is denied

**Both arms refuse on a live denial.** Step 0 above refuses an *apply*; the
**Grant** path refuses too. `approve <plugin>` writes nothing, exits 1, and
names the denial's timestamp, its reason, and `warpline deny --remove <plugin>`.

The denial check in `evaluatePlugin` sits *before* the approval gate, so a
denied plugin is skipped as `denied` on the next advance no matter what is
granted. A grant written here buys the operator nothing and widens side-effect
authority to get it, and reporting exit 0 and `Approved 1 scope` for a plugin
that will not run is the gate claiming a success it did not achieve.

The two arms answering the same standing differently was itself the defect:
one denial produced exit 1 on a parked result and exit 0 without one.

This is a refusal with a way out, not a lockout — `warpline deny --remove`
retires the answer standing in the way, and the refusal names it. Every name is
checked before anything is written, so a refusal leaves nothing on disk. When
several names are denied, all of them are reported and the command refuses once.

A superseded denial does not refuse — it is already stale everywhere else, and
refusing on it would strand the operator behind a question that no longer
exists.

`--all` **narrates rather than refuses.** It is a breadth gesture — the operator
did not name the denied plugin — so refusing the whole command over one denial
would answer a question they did not ask. The blanket grant is written, the
coverage line counts only plugins that can actually run, and a note names each
plugin that stays denied along with `warpline deny --remove`.

That check takes a READ-ONLY, tolerant read of the engine state, unlike the
write-capable read on the named path. `--all` cannot park a result, so an
unreadable state document is not the wrong-gesture hazard it is there. The note
is advisory: a read that fails costs a sentence, not the command, and `--all`
grants exactly as it did before.

#### Grant-clock flags on an apply

`--ttl`, `--replace` and `--long` set a Grant clock. Applying a parked result
records an outcome and writes no grant, so there is no clock for them to set.
They are reported as ignored, named individually, on stderr. Nothing about the
apply changes — the note describes what happened rather than altering it.

### `denials`

Where a human's "no" lands, so the next advance reads it instead of asking
again. A record keyed by plugin name, sibling to `plugin_runs`.

| Field | Type | Meaning |
|-------|------|---------|
| `plugin` | string | The denied plugin, stored as a field as well as being the key |
| `reason` | string | Why the engine is not asking, rendered on the next plan |
| `denied_at` | ISO 8601 string | When the answer was given |
| `note` | string or null | The operator's own words, if they gave any |
| `fingerprint` | hex sha256 string | The proposal this answered, whole and untruncated |

**A record, not an array.** That gives one live denial per plugin by
construction: denying the same plugin again lands on the same key, so there is
nothing to accumulate and no de-dupe scan to get wrong. It also makes a
fleet-wide denial inexpressible — there is no key that means every plugin.
`deferrals` is an array because a task can carry several; a denial cannot.

**A denial is bound to a proposal, not to a plugin.** The fingerprint is hex
sha256 over the plugin's name, its declared side effects, and the Outputs it
produced. Each Output enters as its semantic `type` plus either its path or a
hash of its inline body — `type` included, because turning the file at
`report.md` from a `draft` into a `report` is a change of proposal, and without
it a denial recorded against the draft went on silently suppressing the report. It is recomputed on every advance and compared: while it matches, the
plugin is not due and the question is not asked; when it moves, the plugin is
due again and the answer that comes back says a denial existed and that the
proposal changed. A denial that outlived what it was answering would suppress a
question nobody has answered.

Both hashed sets are sorted before hashing, so reordering the `side_effects`
array in a manifest — an editing accident, not a change of proposal — does not
re-raise an answered Ask. The plugin name is inside the hashed object as well
as being the record key, so two plugins with byte-identical payloads produce
different values and no denial can answer for another plugin's proposal. An
inline Output enters by a hash of its body rather than by the body itself,
which bounds the fingerprint whatever the inline cap allows and keeps Output
content out of the record.

The Outputs hashed are the ones in `plugin_runs[plugin].last_output`, not the
ones in a parked gate. A gate now outlives the advance that parked it, so the
original reason — that one would vanish a day later — no longer holds as
stated; the choice does. A gate is still the shorter-lived record of the two:
it is discarded on apply, on denial, when superseded, and at the ceiling, while
`plugin_runs` outlives all four. Binding an answer to the longer-lived record is
what keeps a denial from expiring for a reason the operator never sees. The narrowing that buys: `last_output` is the last Output of the
run, so a change confined to an earlier Output of a multi-Output result does not
re-raise.

A plugin with no declared side effects and no recorded Output hashes the empty
sets. That is a stable value scoped by its name — it is denied by name — not an
error.

A run that produces no Output no longer moves the fingerprint. It leaves
`last_output` as it was (§ `last_output`), so a denial recorded against a real
proposal stays bound to it across a producer's failed run, rather than being
superseded by the empty-set hash the same plugin would otherwise fall back to.

### `approvals`

Live content approvals, keyed by plugin name. Each one is a standing yes to
SPECIFIC BYTES a producer has already written: the operator read them, approved
them, and a later unattended advance may ship exactly those and nothing else.

A record and not an array, for the reason `denials` gives one section up. One
live approval per plugin by construction, so re-approving lands on the same key
rather than accumulating, and there is no de-dupe scan to get wrong. It also
makes a fleet-wide approval inexpressible — no key means every plugin, and
blanket authority is precisely what a content approval is not. A document
written before approvals existed loads and reads as none.

An approval applies only to a plugin whose manifest declares
`approval_class: 'content'`. For every other plugin the record is not consulted
at all, and the session grant of § 9 decides. The two are disjoint, not
additive.

The fields:

- `plugin` — the consumer whose side effect this authorises. Stored as a field
  as well as being the key, on the same argument `denials` makes: the key is how
  the record is looked up, the field is what survives being read out of the
  record on its own.
- `producer` — the declared dependency whose Output the fingerprint covers. It
  is checked against the consumer manifest's current single declared dependency
  at fire time, not merely recorded: rewriting that dependency after approving
  leaves the stored fingerprint matching a producer whose bytes are no longer the
  ones that would ship.
- `fingerprint` — hex sha256 of the producer's proposal, whole and untruncated,
  produced by the same entry point a denial uses. If those bytes move, the
  approval stops applying; it is not renewed and nothing re-asks.
- `run_id` — the producer run the approved bytes came from, and the reference a
  retention carve-out protects so the log behind an approval is not pruned out
  from under it. Nullable, because an Output may carry no run id: null says the
  run cannot be named, where an empty string would read as a real id and protect
  nothing.
- `approved_at` — ISO instant the approval was recorded.
- `not_before` — the wall clock the window opens, or null meaning the approval
  instant.
- `not_after` — the wall clock the window closes. Required, with no default and
  no ceiling: a window that never closes is ambient authority wearing a bound.
- `zone` — the IANA zone both bounds are read in.
- `effect_id` — the identity of the fire this approval was spent on. Null until
  the runtime marks.
- `marked_at` / `confirmed_at` — the two-field mark. `marked_at` set with
  `confirmed_at` still null is the indeterminate state: the runtime began firing
  and cannot prove it finished. It is deliberately representable rather than
  collapsed into one boolean, because "we do not know" is a different answer from
  "it did not happen".

`not_before` and `not_after` are naked wall clocks — `YYYY-MM-DDTHH:mm[:ss]`,
no trailing `Z` and no numeric offset — resolved against `zone` at fire time,
not at approval time. The host tz database is read live and no snapshot is
pinned, so a tzdb update between approval and fire changes the resolved instant;
pinning would make the runtime wrong about the world. A zone the host cannot
resolve is refused when the approval is written, and if it becomes unresolvable
afterwards the window reads as closed rather than open — the conservative
direction, never a fire and never a throw.

A lapsed window does not auto-approve, does not extend and does not degrade to
an ordinary send. It stops applying, and the operator is the only one who can
write another.

#### Expiry and deletion

A record whose window has closed is **removed from this subtree** at the
end-of-run state write, unless it is marked-unconfirmed. Nothing an operator
does is required, and the sweep runs inside every advance.

This is the second half of one deletion policy. The first half is retention: an
approval stops protecting its producer's run the moment its window closes (§ 6),
so the approved bytes are reclaimed by the ordinary prune. This half removes what
is left — a fingerprint, a producer name, a run id and some timestamps — once
there is nothing for it to bind to. Both halves read the **same** window
predicate over the **same** instant, which is what stops a run being released
while its binding is retained, or the reverse.

The one exception:

| state at expiry | what happens |
|---|---|
| `marked_at` null | dropped |
| `marked_at` set, `confirmed_at` null | **kept** — this is the did-it-ship evidence |
| `confirmed_at` set | dropped |

A marked-unconfirmed record is never replaced by absence. It is the runtime's
account of a fire it began and cannot prove it finished, and deleting it would
destroy that account for a send that may well have landed. Keeping it is safe
because it holds no payload — those bytes went with the run log. The operator
settles it at the sink using the effect id.

A **confirmed** record past its window is dropped, and one consequence is worth
stating rather than discovering: the ordinary not-due report naming a spent
approval and the instant it fired stops being rendered once the window closes.
The plugin simply reads as having no approval, which it no longer has.

Two ceilings this does not reach:

- `plugin_runs[producer].last_output` is **not** deleted by the sweep. It is the
  producer's own record, carried forward across a run that produced nothing and
  overwritten by that producer's next Output; its lifetime is bound to the
  producer, not to any approval, and shortening it here would break a contract
  the approval never opened.
- There is **no operator gesture that resolves an `indeterminate` record**. A
  marked-unconfirmed approval therefore survives the sweep indefinitely, by
  design and for want of a verb. It authorises nothing — every advance refuses
  it with `indeterminate` — but it does not go away on its own.

A zone the host tz database can no longer resolve **retains** the record rather
than sweeping it, and does not fail the advance. Deleting recipient-bound data
because the host forgot a timezone is not a deletion policy. Note that this is
the opposite direction from the fire decision, which reads an unresolvable zone
as a closed window and refuses: both are the conservative answer to their own
question — never fire on a window you cannot read, never delete on one either.

#### The spend mark

`effect_id`, `marked_at` and `confirmed_at` are written by the ADVANCE and by
nothing else. No operator command sets any of the three.

`marked_at` and `effect_id` are written together, **before the handler is
invoked** — the only mark-before-effect in the runtime besides the run lock.
`marked_at` IS the instant the fire was decided on, which is what makes the
effect id recomputable: a reader holding `(plugin, fingerprint, marked_at)` can
check an id they were handed, without the runtime having to promise that a retry
regenerates one. `confirmed_at` is written at the single end-of-run state write
and nowhere else.

Two fields rather than one, because one timestamp cannot express both post-fire
states. Written before the handler, a single field makes every successful send
read as unfinished forever and turns a content-approved plugin into a one-shot;
written after, it loses the crash case entirely. The three states and their
predicates:

| state | predicate | what the next advance does |
|---|---|---|
| not yet fired | `marked_at` null | fires, if the window and the fingerprint still agree |
| indeterminate | `marked_at` set, `confirmed_at` null | refuses with `indeterminate` — never fires |
| spent | `confirmed_at` set | ordinary not-due, naming the instant it fired |

A handler that returns `failed` leaves the record **indeterminate**, not
un-marked. The mark is not cleared on that path: a failed return does not prove
the sink never received the bytes, and clearing it would re-arm a send that may
already have gone out.

The mark is taken under the state document's own lock, with the document re-read
inside it, so two content-class plugins in one execution level and a concurrent
`warpline approve --content` are serialised by one mechanism. The write persists
only the `approvals` subtree merged onto that fresh read — never the advance's
in-flight `plugin_runs`, which are not durable until the run returns. If the
record has gone, its fingerprint has moved, or it is already marked by the time
the lock is held, the fire is refused rather than taken: no mark, no invocation.

**The durability ceiling, stated rather than claimed away.** The guarantee is
against **process crash**, not power loss: the state document is written with
rename atomicity and no `fsync`. The outcome is also not durable until the
end-of-run write, so a crash after a successful send but before that write reads
`indeterminate` on the next advance too. That is the conservative and correct
reading — the runtime genuinely does not know — and the effect id is the remedy:
the operator resolves it at the sink rather than guessing here.

#### Writing and withdrawing one (`warpline approve --content`)

`warpline approve <plugin> --content --not-after <wall> [--not-before <wall>]
[--zone <iana>]` writes the record above for one plugin, and
`warpline approve <plugin> --content --remove` takes it back. Both validate
everything inside a single state-lock critical section before mutating anything,
so a refused command leaves the document byte-unchanged.

**The command prints the bytes it is asking about.** The whole guarantee rests
on the operator having read them, so the producer's inline body is written to
stdout between two delimiters, preceded by the whole untruncated fingerprint and
by the window both as it was typed and as it resolves to instants — a zone
mistake is invisible in a wall clock and obvious in the instant it lands on.
Every C0 control character except LF and TAB, DEL, and every C1 control
character render as a visible `\xNN` escape. They are escaped and never
stripped: a stripping renderer removes the evidence that an ANSI repaint was
attempted, and repainting is how a screen is made to disagree with the record.
Nothing is ever truncated — the Output schema's 16 KiB inline cap is the only
bound, and cutting would hide the tail, which is where a long batch's surprises
sit.

**An Output declaring `path` rather than `body` is refused, not read.** The
runtime does not resolve, normalise or stat the path, and does not repeat it in
the refusal. Approving by content means the operator saw the exact bytes; a path
is a promise about a file that may say something else by the time it is read,
and refusing outright is how the verb sidesteps path traversal entirely rather
than defending against it.

**Withdrawal is validated against the record, not against what is installed.**
A plugin uninstalled after it was approved is still reachable by name from
`--remove`; were it checked against the loaded manifests, its record would be
stranded in the state document with no gesture that reaches it. `--remove` is
not `revoke`, which retires a session grant, and not `deny`, which answers a
proposal with a no — it is the yes to specific bytes taken back, and it leaves
the plugin reported as ordinary unapproved rather than as refused.

**Two refusals protect a marked-unconfirmed record.** For a record with
`marked_at` set and `confirmed_at` still null, both a fresh approval and a
`--remove` are refused, naming the plugin, the `effect_id` and the `marked_at`
instant. A fresh approval would erase the open question rather than answer it,
and re-arm a send that may already have gone out; a removal would destroy the
only evidence that a send may have landed. A record whose `confirmed_at` is set
is a state report rather than an open question, and removes normally.

**The gap that leaves, stated rather than closed.** There is no operator command
today that resolves an indeterminate record, so such a record is currently
permanent: it can be neither re-approved nor removed. That is the conservative
direction and it is deliberate — the record holds a fingerprint, a producer
name, a run id and three timestamps, and no payload, so what persists is a
reference rather than content. The resolution gesture is a later addition made
on purpose, not something to reach by loosening either refusal.

### `last_output`

A pointer to the most recent Output a plugin produced, so a reader can name it
without scanning the runs directory. It is the Output record shape from § 5,
reused rather than restated — a second shape would be a second thing that could
disagree with the first.

Every write of a `plugin_runs` entry decides this key — the autonomous
completion, the supervised park, the approve verb applying a gate, and the
invocation that threw. A gated run produced its Outputs before the gate ever
saw them, so it carries a pointer like any other run. A run that threw has no
result to read one from, which is the strongest form of "produced nothing" and
takes the same carry-forward as the rest.

What each write records is the run's own most recent Output when the run
produced one, and otherwise the pointer the entry already held. The field is a
fact about the PLUGIN — the most recent Output it produced — not about its last
run, so a run that produced nothing has said nothing about it and does not
clear it.

**Status-blind.** What survives is keyed on the run producing no Output, never
on how the run ended. A run that threw, a run that returned `failed`, and a run
that succeeded carrying an empty `artifacts_produced` are one case here. The
consequence for a reader: this field cannot be read as a health signal for the
plugin that produced it, and a consumer that needs to know how its dependency's
latest run went asks `capabilities.dependencies.lastRun` for it instead. The two
answers come from one projection of this same entry, so they cannot disagree
about which run they describe.

**Absent, not null.** A plugin that has never produced an Output has no
`last_output` key at all — not `null`, not `{}`. Reading a missing key is
unambiguous; reading an empty object means guessing whether the plugin produced
nothing or the writer failed.

The pointer may dangle. Its `run_id` names a run log, and run logs are pruned
under the operator's configured retention policy (§ 6), so a pointer can outlive
the run it names. A pointer is not protective — § 6 says why. That resolves
to "run no longer retained" rather than an error, and nothing deletes the
pointer to avoid the case — the pointer is the only remaining record that the
Output existed.

## 11. Exit codes

`warpline advance` is the unattended entry point, and its exit code is the
machine interface a scheduler keys on: this runtime ships no HTTP surface and no
alerting hook. Two things carry detail a code has no room for, and neither
replaces it — `warpline advance --json` writes one JSON document to stdout
describing the advance that just ran, and the dead-man file (§ 13) records the
last one that returned. Both have to be parsed before they can say whether
anything ran; the code says it without being read. The codes below are contract
surface. A scheduler unit, a monitoring check or a wrapper script may key on
them.

| Code | Meaning |
|------|---------|
| `0` | The advance ran and nothing failed. Every plugin completed, nothing was due, a plugin is holding at an approval gate, or a content approval declined to authorise a fire. |
| `1` | At least one plugin failed, the plugin root loaded no manifests at all, or the command line was not valid. |
| `75` | Could not finish. Often nothing ran and nothing was written, but not always — see below before treating it as a free retry. |
| `130` | Interrupted by SIGINT or SIGTERM. The process stopped; the work may not have. |

**A `1` before the advance starts is a usage error.** An unregistered flag and a
positional argument are both refused by the argument parser: the command writes
the parser's message plus its usage text to stderr, writes nothing to stdout,
and exits `1` without running anything. `warpline advance strict` — the typo for
`--strict` — is refused there rather than quietly running non-strict. That is a
third cause of `1` and this table is a closed enumeration, so it is named here
rather than left for a monitor to discover as "a plugin failed". What tells the
three apart from outside: under `--json` a plugin failure and an empty plugin
root each write a document to stdout, and a usage error writes none.

`130` is the conventional code for a process ended by SIGINT, and this command
reports it deliberately rather than by default: it installs a handler for the
length of the run, and the handler flushes whatever is queued on stdout before
terminating, so an interrupt arriving between the document being written and the
command returning cannot cut that document in half.

That window is the honest size of the claim, and it is small. The document is
the last thing the command writes and it returns a few statements later, at
which point the handler comes off — so the barrier covers the tail of a run that
lasted seconds or minutes, and an interrupt landing anywhere earlier finds
nothing queued because nothing has been written. It is free and it is correct
and it is not a general promise about this stream: a command that exits without
draining a pipe can truncate on the ordinary path too, with no signal involved
at all.

**SIGTERM takes the same handler and reports the same code.** That is the signal
a scheduler sends — `systemctl stop`, a launchd `bootout` and a container stop
are all SIGTERM, and none of them is a SIGINT. Left to the default disposition
they killed the process with no flush and no exit code at all, which is the
failure the SIGINT handler existed to prevent, reached by the route an operator
is far likelier to take. Everything the rest of this section says about an
interrupt now reads for both signals. What your scheduler makes of a `130`
afterwards is its own question and `scheduler-recipe.md` is where it is asked.

The handler also puts a ceiling on itself. It exits as soon as stdout has
drained, and after two seconds it exits anyway. Without that, a stdout pipe
whose reader has stopped consuming left the process unkillable by further
signals — the default disposition is gone while the handler is installed, so
each one only queued another write.

Read `130` as "the process stopped", never as "the work stopped". The advance is
not interruptible — no abort is threaded into a plugin invocation — so the plugin
that was in flight may run to completion in a process the operator believes is
dead. Two consequences follow, and both are bounded rather than open:

- Side effects already begun continue. An interrupt is not a cancellation, and
  there is no code that means "cancelled cleanly" because there is no such
  outcome to report.
- The run lock is left behind: the interrupt ends the process before the
  release runs. The next advance heals it, because the lock names a process id
  that is gone (§ 12). So an interrupted advance is recoverable without any flag
  that breaks a held lock, which is why no such flag exists.

### What reaches stdout

The document is the only thing on that stream, and the runtime holds that
against the plugins as well as against itself. While a plugin is being loaded
and while its handler runs, anything it prints through `process.stdout.write`,
`console.log`, `console.info` or `console.debug` is redirected to stderr.
`warpline run --json` gets the same protection from the same place: both verbs
invoke a handler through one function, and the redirect lives there rather than
in either verb.

Redirected, not discarded. A plugin author's debug line still reaches them, on
the stream every other diagnostic in this runtime already uses. It carries no
label naming the plugin that wrote it, and a level runs its plugins
concurrently, so two chatty plugins interleave.

Three writes are outside that reach and can still put bytes on stdout:

- A write that reaches file descriptor 1 without going through either of the
  two paths above — `Bun.write(Bun.stdout, …)`, `fs.writeSync(1, …)`.
- A child process a handler spawns with stdio inherited from its parent. No
  in-process redirect covers another process's file descriptors.
- Anything a handler prints after its timeout or its cancellation fired, once
  the advance has stopped waiting for that handler and no other plugin is still
  running. The advance is not interruptible, so an abandoned handler keeps
  going; the redirect comes off when the last live invocation returns.

The first two are a plugin doing something unusual, and the third only happens
on a run that already timed out or was cancelled. None of them is ruled out, so
a consumer that cannot tolerate a corrupt document at all should key on the exit
code, which reaches it without being parsed.

### The code comes from the run's own state, never from its status

The code is computed from exactly three fields of the advance result:
`plugin_states`, `gated_plugins` and `refused_plugins`. It never reads
`AdvanceResult.status`, and
that distinction is the point. A run that stops at an
approval gate reports `partial`, because it did not get through the fleet — but a
held gate is the runtime doing exactly what it is for. Reporting it as a failure
would train an operator to ignore the code, which is the one outcome that makes
every other code in this table worthless.

Two consequences worth stating plainly:

- A plugin still in `pending` does not make the code non-zero. The engine stops
  at the level that gated, so every plugin in a later level is still `pending`
  when the advance returns. That is the ordinary gated shape, not an error state.
- `1` for "no manifests loaded" means exactly that: the plugin root held nothing
  importable, or every manifest in it threw. It is not a count of failures, and a
  consumer must not read it as one.

### `--strict`

`warpline advance --strict` promotes a gated **or refused** advance to `1`. Use
it where a gate waiting on a human is itself the thing you want paged about — a
fleet that is supposed to be running fully autonomously, for instance.

A content refusal is `0` on its own. A content approval that no longer
authorises the fire — the window closed, the approved bytes moved, a marked fire
never confirmed (§ 5) — is the same gate holding for a different reason, and a
held gate is the runtime doing its job. Without `--strict` the code says so, and
the count is what tells you it happened: `warpline advance --json` carries
`refused` and the structured reason for each refusal, and the dead-man file
(§ 13) carries the count. That pair is deliberate. A fleet can refuse every send
on every advance for a week, and nothing about the exit code alone would
distinguish that from a fleet with nothing to do.

`--strict` changes none of the `1` cases. A plugin failure is `1` with it or
without it, and a plugin root that loaded no manifests is `1` with it or without
it. The flag moves the gated and refused cases and nothing else — and it moves
them together, as one `1`: an advance with both is not two failures.

### `75`

`75` means the advance could not finish. Read it as "could not look", never as
"looked and it was fine" — but do not read it as "nothing happened" either. Two
of the three causes below leave the home untouched. The third does not, and it
is the one a monitor is most likely to meet.

There are three causes, and all three have code behind them.

The first is a throw out of the advance itself — which includes an
`engine-state.json` that fails validation, since that read happens inside the
advance. Treat this one as "retry later" rather than as a fault to page on:
under a fifteen-minute timer the retry costs nothing.

**This cause is not free of side effects, and the distinction matters to
anything that retries automatically.** One arm of it is: a plugin root that
cannot be read is refused above every writer in the advance, including the run
lock, so that one does leave the home byte-identical. The rest do not.
`warpline advance` maps *any* throw out of the advance to `75`, deliberately
and with no chain of special cases, so a
state write that hits a full disk, a run-log write that fails, or an append to
`events.jsonl` that fails all arrive here. Those writes happen after the fleet
has run, and a plugin that has already sent has already sent. Even a throw from
the retention prune, which runs before the first plugin, arrives after run logs
have been deleted. A wrapper that reads `75` as "safe, nothing happened, retry"
will retry a fleet that already acted.

What discriminates, if you need to know: a `run_started` event in
`events.jsonl` with no matching `run_completed` for the same `run_id` means the
advance reached the fleet and did not get out of it. Its absence is weaker than
it looks — the retention prune runs above that event, so a throw there leaves no
`run_started` and has still deleted files. The dead-man file (§ 13) does not
help here at all: it is written only by an advance that returns, so a `75`
leaves it reading whatever the last completed advance left, and its age cannot
tell the two apart.

The second is a refusal raised before the advance starts. With no warpline home
at the resolved path **and** no terminal on standard input, `warpline advance`
will not create one. Under a scheduler an unset `WARPLINE_HOME` resolves against
the working directory the scheduler happened to give the job, so a missing home
means a second empty home is invented, the fleet runs nothing, and the command
exits `0` reporting healthy. This refusal repeats until the operator sets the
variable or creates the directory, and the message names both. Nothing is
written on this arm: it is decided before the advance is called at all.

The refusal is narrow on purpose: it refuses to **create** a home, never to
**run** unattended. An existing home with no terminal on standard input is the
ordinary scheduled case and it proceeds, which is the entire point of running
this command from a timer.

The third is contention on the run lock: another advance is already running
against this home. The message names the holder and says that nothing ran, which
holds: the lock is taken above every writer in the advance, so the loser never
reaches one. This one is also "retry later" — the next tick is the retry, and no flag exists to
break a lock somebody else is holding. § 12 is the whole of it.

### Unknown codes

New codes may be added over time. A consumer MUST treat any unknown non-zero code
as failure. Do not read the table above as a closed set: a wrapper that
special-cases `0`, `1` and `75` and falls through to success on everything else
will report a green fleet on the first code this document adds.

## 12. The run lock

Two advances against one warpline home must not both write it. `warpline advance`
takes a lock for the length of the run, and refuses rather than waits.

**The file is `.lock`, beside `engine-state.json` in the home's state
directory.** It is JSON, and it records when it was taken, the run id that took
it, the mode (`advance`), the holding process id — which is `null` when the
holder is an orchestrator session rather than a long-lived process — and the
`host` identifier of the machine that took it, which is `null` when that machine
could not identify itself. `host` is **nullable and optional** (§ The host
identifier, below).

**Acquisition is an exclusive create, not a check followed by a write.** There
is no window in which two processes both see an absent lock and both proceed.

**A stale lock heals; a live one does not.** A lock is stale when it is more
than two hours old, or when it names a process id that is no longer running **on
the machine that took it**. The process-id test is reached only when the lock's
`host` and the reading machine's `host` are both known and equal; in every other
combination it is skipped and only the two-hour window expires the lock. On
contention the acquire reads the holder back, and if it is stale it breaks it and
retries exactly once. A holder that is neither — and a lock file that cannot be
read back as a lock at all — is refused rather than broken. `lock.test.ts` in
this repository holds every arm of that, including the two that refuse to unlink
a file they could not parse.

### The host identifier

A home can be attached from more than one machine. A process id is only
meaningful against the kernel that issued it, and the liveness test asks the
**local** kernel whatever the lock says — so without a host identifier, machine
B reads machine A's live lock as a dead process, heals it, and two advances run
against one home. That is the single way to get two writers, which is what the
lock exists to prevent.

**Known and known and equal, or no process-id test at all.** Either side `null`,
either side absent, or the two known and different: the lock expires only by the
two-hour window.

**`null` never compares equal to `null`.** A machine that could not identify
itself stores `null`, and two such machines are not the same machine. No literal
placeholder string is ever written in place of an unknown host — that is the
shape Git's `gc.pid` has, and it makes two unidentified machines compare equal.

**The field is nullable and optional, and the optionality is load-bearing.** A
required field would make every in-flight lock written by an older build
unparseable, and an unparseable lock is refused rather than broken — so the
upgrade would strand every home that had an advance running when it happened. A
record carrying no `host` key behaves exactly as the `null` case.

**The stored value is not the machine's identifier.** It is an HMAC over the
machine id, keyed by the id and taking a fixed warpline application UUID as the
message — the remedy `machine-id(5)` prescribes for its own *"must not be used
directly"* and *"must not be exposed ... on the network"*. A warpline home may
sit on a network mount, so the raw identifier must not be written there. What
that buys is precisely that the stored value cannot be used **as** a machine id
anywhere else. It does not buy unguessability. The identifier is derived from
`/etc/machine-id`, then `/var/lib/dbus/machine-id`, then the macOS
`IOPlatformUUID`, then `null`. The machine's operator-facing name is never
consulted: it is operator-chosen, routinely duplicated across a fleet, and
changes without the machine changing.

**The honest ceiling.** The host field makes the lock honest across machines; it
does not make it correct. Where a container image bakes in a machine id, or two
containers bind-mount one, the identifier lies **in the dangerous direction** —
two machines look like one — and warpline cannot detect it. A
PID-namespace-based identity is the named upgrade path and is not implemented.

**A release removes only the lock it took.** Both unlinks in the lock module
read the file back and compare the run id before deleting anything. Without
that, an advance whose own lock was healed out from under it — the two-hour
window expired while the run was still going — deletes the *next* advance's
live lock on its way out, and the tick after that acquires cleanly while two
advances are still running. The narrowing is real and it is not a guarantee: a
read followed by an unlink is not atomic, and there is no portable
compare-and-delete to make it one.

**Contention exits `75` and names the holder** (§ 11). The message says a
process id, or says an orchestrator session, and it says that nothing ran. It
never says the word for an absent value in place of a process id. `advance.test.ts`
holds both arms, and asserts in each that the holder's lock is still on disk and
that no run appeared under the home.

**The lock is taken below the plugin-root refusal and above the state read, and
released in a single `finally` below the return.** That placement is what keeps
two promises at once: a plugin root that cannot be read is refused before any
lock exists, and every write the advance makes happens while it holds one. The
release covers every way out, including the quiet-hours early return and a throw
from inside the span. `engine-lock.test.ts` holds all three of those arms, and
the one that matters most is the quiet-hours one: a lock leaked there is
unhealable for two hours, which under a fifteen-minute timer is eight
consecutive advances reporting "retry later" to a monitor that reads them as
merely busy.

### What the lock is and is not for

The lock is **not** what stops a scheduler starting a second copy of the job.
Two of the three schedulers this runtime is deployed under already do that
themselves, and their own documentation says so.

- **systemd does not double-fire.** `systemd.timer(5)`: "in case the unit to
  activate is already active at the time the timer elapses it is not restarted,
  but simply left running. There is no concept of spawning new service instances
  in this case."
- **launchd does not double-fire under `StartInterval`.** `launchd.plist(5)`:
  "If the job is running during an interval firing, that interval firing will
  likewise be missed."
- **cron makes no such statement, in either direction.** Neither `crontab(5)` nor
  `cron(8)` says anything about skipping a firing while a previous instance of
  the same job is still running. Treat cron as able to overlap.

So the lock is load-bearing for **cron**, where it is the only protection an
operator has, and for a **manual advance racing a scheduled one** on all three
platforms — nothing in any scheduler knows about a human at a terminal. Read it
that way rather than as a guarantee about schedulers in general, which is a
guarantee this runtime cannot cash.

### Two locks, and neither moves

There are two lock files in the state directory and they are not the same thing.

`.lock` is the one this section is about: one advance at a time, per home.
`.state.lock` serialises read-modify-writes of the engine state document, and
its holders are the board and the `deny` verb. They have different lifetimes and
different holders.

Neither collapses into the other. The state lock is non-reentrant, and the board
takes it around a call that writes the state document, so the run lock cannot be
moved down into that writer without deadlocking against a lock the same process
already holds. An advance holds its own lock across its state write, which fixes
the acquisition order as run-lock-first. That order is a fact about the code as
it stands, not a lock hierarchy the runtime enforces.

### The accepted cost

**No flag breaks a lock another process is holding.** There is no `--force` and
there will not be one: it is the single way to get two writers onto one home,
which is the failure the lock exists to prevent. The cost, stated rather than
discovered: a genuinely wedged live process blocks every advance against that
home until the two-hour window expires. That is the choice, and the two-hour
window and the dead-process check are what bound it — and for a lock taken on a
different machine, only the two-hour window bounds it. An operator who knows the
holder is gone can delete `.lock` by hand; an operator who is not sure should
wait for the window.

**An interrupted advance can leave a plugin running.** An advance interrupted by
SIGINT or SIGTERM exits `130` (§ 11) as soon as its stdout has drained, or after
two seconds if it has not, which ends the process and not the work: the plugin that was in flight may run to completion in a process
the operator believes is dead. The lock that interruption leaves behind is
reclaimed by the heal described above — on the next advance if the holder's process is gone and the
lock was taken on this same machine, and at the two-hour window if the lock was orchestrator-held,
names no process, or came from another machine.
The two facts belong beside each other because the second is what bounds the
first.

### What this does not close: issue #25

**The run lock serialises advance against advance, and nothing more.** It does
not close issue #25. An advance reads the engine state document at the top and
writes it at the end, a window that spans plugin execution, and it holds no state
lock across that window — holding one there would block the board for the length
of a run. Closing #25 means applying the advance's changes as deltas onto a fresh
read taken inside the state lock, which this runtime does not do for
`plugin_runs`, `pending_gates` or `last_run_id`, and which is tracked as future
work rather than implied here to be done.

**`approvals` is the one subtree that window no longer spans.** Both of the
advance's writes to it — the spend mark taken before a content-approved handler
runs, and the single end-of-run write — take the state lock, re-read the document
inside it, and merge that subtree per key. The two regions are sequential and
never nested. `approvals` gets this and the rest of the document does not because
it is the only part another attachment writes: one home can be attached from
several machines, so a `warpline approve --content` lands at an instant the
advance cannot predict.

**Which file each writer writes, since this has been recorded wrongly before.**
The `deny` verb and the board write the engine state document, under the state
lock. So does `approve --content`, which records the approval, and `approve
--content --remove`, which withdraws it — both under the same lock. `approve`'s
other modes write the session-approval file instead, `.session-approval` at the
root of the home, and write no state document at all. The run lock guards none
of them.

## 13. The dead-man file

An advance leaves a record of itself at `last-successful-advance`, beside
`engine-state.json` in the home's state directory. It is JSON, it is rewritten
in full on every advance that returns, and nothing in this runtime ever reads it
back.

It exists because this runtime has no other way to tell you it is alive. There is
no HTTP surface in this repository — § 7 — and no alerting hook of any kind, and
a warpline that has stopped cannot alert you that it has stopped. The exit code
of § 11 reaches you
only when the command runs; if the timer never fires, no code is ever produced.
So the interface is a file, and the signal an outside detector reads is the
file's own age.

### The fields

| Field | Type | Meaning |
|-------|------|---------|
| `run_id` | string | The advance's own run id. Names the run log this advance wrote — but only when it ran: an advance skipped for quiet hours still gets a run id and writes no log. |
| `completed_at` | string | ISO 8601 UTC, the moment this file was written. Use the file's mtime for age checks; this field is for a human reading the file. |
| `status` | `"complete"` \| `"partial"` \| `"failed"` | The advance's own status. **Not the exit code.** |
| `skipped_reason` | string \| null | `null` when the advance ran. `"quiet_hours"` when it returned early because a quiet window was active. |
| `gated` | integer | How many plugins are holding at an approval gate. |
| `failed` | integer | How many plugins ended failed, manifests that would not load included. |
| `refused` | integer | How many plugins a content approval declined to authorise — the window closed, the approved bytes moved, or a marked fire was never confirmed (§ 5). The **count only**: the reasons are plugin-derived and reach a reader through `warpline advance --json`, never through this file. |
| `pruned` | integer | How many run records this advance's retention prune removed. Always `0` on a skipped advance, which returns above the prune. |

Those eight keys are the whole document, and `dead-man.test.ts` enumerates them
so that adding a ninth has to be a deliberate act. Nothing else belongs here:
no plugin summary, no plugin output, no value read out of your configuration and
no path. A field carrying free text would make this file a channel for content it
was never meant to carry.

**Three values, not four.** The shared status union this field is typed from
has a fourth member, `"interrupted"`, and no advance can put it here. The engine
assigns only `complete`, `partial` and `failed`, and an interrupted advance
exits from its signal handler without reaching this writer at all — which is
what the paragraph two down says about a throw, and holds for the same reason. A
detector that branches on `"interrupted"` here gets dead code.

**`status` is the advance's status and not the exit code, and the difference
matters most on the case you will hit most.** An advance that stops at an
approval gate reports `partial` here and exits `0` there, because a held gate is
the runtime doing its job. A detector that treats `status` as a pass/fail verdict
will page you every time a plugin waits for a human. Read `gated`, `refused` and
`failed` for the verdict, and read `status` for what the run did.

### When it is written, and when it is not

It is written on **every advance that returns**, whatever that advance found. A
complete run writes it, a run holding at a gate writes it, a run with a failed
plugin writes it, a plugin root that loaded nothing writes it, and an advance
that returned early because quiet hours were configured writes it. Each of those
arms has a case in `dead-man.test.ts`. The gated arm is the one the file exists
for: a fleet whose only news is a waiting approval is a healthy fleet, and a
switch that fired on it would be a switch you learn to ignore.

The quiet-hours arm is written for a reason worth stating. A configured quiet
window is hours wide. If a skipped advance wrote nothing, every threshold you set
would have to be wider than that window, and the resolution a fifteen-minute
timer buys you would be gone. Writing it with `skipped_reason: "quiet_hours"` is
what lets a detector tell an asleep fleet from a stopped one. Quiet hours are
opt-in — the window is off until you configure one — so on a home without one
this field is always `null`.

**It is not written when the advance throws.** This is deliberate and it is the
requirement most easily implemented backwards. An advance that cannot take the
run lock, cannot find the home, or cannot read the state document is exactly the
situation in which you need the last good file left standing, going stale, saying
what the last successful run was and how long ago it finished. A writer that ran
on the failure path would overwrite that signal with a fresh timestamp and report
a wedged runtime as a healthy one. `dead-man.test.ts` proves this by writing a
file from a real advance, forcing the next advance to throw, and asserting that
the file's contents and its modification time are both unchanged.

The write is atomic — a temp file and a rename — so a detector reading the file
while an advance writes it sees either the old document or the new one, never
half of either. It happens after the run log is written and before the run lock
is released, which gives you two guarantees: when the advance ran, the run log
named by `run_id` is already on disk by the time you can see this file, and two
advances against one home cannot interleave writes to it. The first guarantee is
about ordering, not existence — a skipped advance writes this file and no run
log, and `skipped_reason` is how you know which you are looking at.

### Reading it

Check the file's age first, then its contents. Five outcomes, in the order you
should test them:

1. **Stopped.** The file is older than a few times your advance interval, or it
   does not exist at all on a home that has run before. Nothing is writing it.
   This is the case no code inside this runtime can report to you, and it is the
   reason the file exists. A fifteen-minute timer with a one-hour threshold gives
   three missed ticks of tolerance before it pages.
2. **Asleep.** `skipped_reason` is `"quiet_hours"`. The advance returned early on
   purpose, so it is recent and it is not stopped. No plugin ran, so `gated` is
   always `0` here — but `failed` is not: a manifest that would not load is
   counted on this arm too, which is what lets a broken plugin root show through
   a quiet night instead of waiting for morning. Check this step before the next
   one so that a skipped advance with a load failure reads as broken and asleep
   rather than as broken and awake.
3. **Broken.** `failed` is greater than zero. At least one plugin failed or one
   manifest would not load. Read the run log named by `run_id` — unless
   `skipped_reason` is set, in which case there is no log and the failure is a
   manifest that would not import.
4. **Waiting.** `gated` or `refused` is greater than zero and `failed` is zero.
   Plugins are holding — at a session approval gate, or on a content approval
   that no longer authorises the fire. Whether that pages you is your call — it
   is the same distinction `warpline advance --strict` makes at the exit code,
   and it covers both fields for the same reason.

   Read `refused` on its own terms. A non-zero `gated` usually means a human has
   not answered yet; a non-zero `refused` means a human already did, and the
   answer stopped applying — the window closed, or the approved bytes moved. A
   fleet that refuses every send on every advance for a week is a fleet doing
   nothing, and `failed` and `gated` both stay `0` throughout. This field is the
   only thing in the document that shows it. `warpline advance --json` carries
   the reason for each refusal; this file carries the count.
5. **Healthy.** Recent, `failed` is zero, `gated` is zero, `refused` is zero,
   `skipped_reason` is `null`.

A healthy file, an all-gated file and an all-refused file differ in `gated` and
`refused` and nowhere else, which is what makes the three tellable apart by
those two fields alone.

Two operator notes. Set your staleness threshold from your own timer interval,
not from a number in this document — the runtime does not know how often you run
it. And do not write to this file yourself: nothing here reads it back, so a file
you author misleads only your own detector, but it will do that silently.
