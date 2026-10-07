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
when the host supplies it, otherwise the `WARPLINE_PLUGINS_DIR` env var when it
is set and non-empty, otherwise `<warplineHome()>/plugins`. It is a single
root, not a search-path list — nothing falls back to a second location when a
plugin is not found under the first.

The env var is how a host that supplies its own root reaches the CLI verbs that
validate plugin names against it — `approve`, `deny`, `resolve`, `configure`,
`plan` — and `advance`, `init` and `scaffold`, all of which run in a process the
host's `AdvanceOptions` never touch. Set it wherever `WARPLINE_HOME` is set.
`approve` prints the grant file it wrote (`Grant file: <path>`), so a grant
written into a home no scheduled run reads is visible at the moment it is made.

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
| `llm_handoff` | boolean | no | `false` |
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

`llm_handoff` declares that the handler MAY return a `[needs-llm]` handoff. It
is permission, not a promise: a declaring plugin that returns `success` records
`success`. A handoff from a plugin that does not declare it is refused, and the
run is recorded `failed` with an error naming the field (see § 3). The
free-text `capabilities` array never counts as this declaration, whatever it
holds.

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

`llm_handoff` is the one addition that is not safe for every existing plugin. A
manifest that validated still validates, but a plugin that hands off without
declaring the field is now refused, so its runs record `failed` where they used
to record `delegated`. That is a breaking change under the pre-1.0 promise,
taken deliberately, and the fix is one manifest line: `llm_handoff: true`.

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
  fact about the plugin and not about its last run. A producer whose content was
  erased still returns its record, which carries `erased_at` and no `body`.
  `null` still means never produced.
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

`timeout_ms` bounds **awake** time: the time the plugin could actually run. A
system sleep does not count against it. A `setTimeout` counts a sleep and fires
on wake, while `performance.now()` stops for the duration (measured under Bun on
macOS: 124 s asleep read as 131.2 s of wall time and 9.9 s of
`performance.now()`). So when the timer fires with awake budget left, it re-arms
for the remainder rather than failing the attempt. `elapsed_ms` stays wall
time, how long the attempt took end to end, and can therefore exceed
`timeout_ms` on an attempt that did not time out.

A timeout whose awake deadline passed by more than `max(timeout_ms, 1s)` before
the timer could run is still a timeout, but its summary and error say why:
`<plugin>: timeout (timer fired <n>s late against timeout_ms=<ms>: the event
loop was blocked)`. That tells a handler that held the event loop apart from
one that was merely slow.

Timeout vs. retry interaction:

| Outcome                              | `status`    | `retried`                 | `timed_out` |
|--------------------------------------|-------------|---------------------------|-------------|
| handler resolves with success        | `success`   | `attempt_count > 1`       | `false`     |
| handler returns `retryable: true`    | loop        | (final attempt determines)| `false`     |
| handler returns `retryable: false`   | `failed`    | `false`                   | `false`     |
| handler throws                       | `failed`    | `false`                   | `false`     |
| per-attempt timeout trips            | `failed`    | `false`                   | `true`      |
| external `controller.abort()`        | `cancelled` | `false`                   | `false`     |
| handler returns `skipped` + `[needs-llm]` summary prefix, from a plugin declaring `llm_handoff: true` | `delegated` | `false` | `false` |
| handler returns `skipped` + a `needs_llm` field, from a plugin declaring `llm_handoff: true`          | `delegated` | `false` | `false` |
| handler returns either handoff, from a plugin that does not declare `llm_handoff`                    | `failed`    | `false` | `false` |

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

A handoff from a plugin whose manifest does not declare `llm_handoff: true` is
refused. The refusal happens at one site, in the retry loop, where that
predicate meets the manifest bit, and it runs before either classifier. The
manifest there is the module as exported, so any value other than the boolean
`true` counts as undeclared. The handler's result is replaced by a fresh one:
`status: 'failed'`, `phases_failed` naming the plugin, `summary`
`<name>: undeclared handoff`, and an empty `artifacts_produced`, so the
plugin's prior `last_output` carries forward and nothing the handler wrote is
published. `errors[0]` is a `parse_error` with `retryable: false` and the
message `Plugin '<name>' returned a [needs-llm] handoff but its manifest does
not declare llm_handoff: true`. The refusal is never retried, so the run has
one attempt and emits no `attempt_failed` notice. Timeout and cancellation
still take precedence at the status level: an attempt aborted after the
handler returned reports `timeout` or `cancelled`, while its result body
carries the refusal. Under the default preferences (`review_gate: true`), or
for a plugin with `autonomy_level: 'supervised'`, the refused result is not
parked, because a `failed` result never is (§ 9). The plugin entry and
`plugin_runs` read `failed` there too, with the refusal in the summary. It is
never `delegated`.

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
`errors[]`: the dispatch succeeded, so there is no failure to attribute. A
handoff from a plugin that does not declare `llm_handoff` is rewritten before
either level classifies it, so both read `failed`, and the attempt's `error`
carries the refusal message.

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

A run whose plugin returned a `[needs-llm]` handoff without declaring
`llm_handoff: true` persists with `status: 'failed'`, one attempt, and a
`final_error` naming the field. It never persists as `delegated`, so nothing
that selects run artifacts by the `delegated` status picks it up. § 3
describes the refusal.

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
  "manifests_loaded": 3,
  "trigger": "scheduled"
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

`trigger` is what started the advance, `scheduled` or `manual`, as the host
asserts it. warpline cannot tell a scheduler tick from a person at a terminal,
so it records only what it is told: `AdvanceOptions.trigger` from a library
host, or the `WARPLINE_TRIGGER` env var from `warpline advance`, which refuses
any other value with `1` before running (§ 11). The env var is read by the CLI
alone: `runAdvance()` never reads it, so a library host that sets it and not the
option records no `trigger`. The field is optional and never
defaulted, like `manifests_loaded`: absent means nobody said, which is also what
every run log written before the field existed reads as. A host counting
consecutive scheduled advances counts only `"trigger": "scheduled"`, so a hand
run cannot stand in for a tick that failed or never fired. It is not
`RunArtifact.user_initiated`, which sits on the single-plugin `run` verb's
artifact and says nothing about an advance.

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
| `failed` | The handler threw, returned a failed result, returned a `[needs-llm]` handoff its manifest does not declare (`llm_handoff`), or the plugin's manifest never loaded |
| `skipped` | The plugin was not due — fresh, filtered, locked, without a session Grant, or holding a declared dependency whose last run failed |
| `gated` | Supervised: the handler ran, its result did not fail, and the result was parked pending a human answer |
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
exactly one of five reasons. Two points can refuse. The gate can produce three
of them, and the spend mark, reached later, can produce four. They overlap, so
the "Decided by" column below is not a partition. The set is closed and
validated on parse, because this is the value an unattended scheduler switches
on: an open-ended reason string would let something the runtime did not author
reach that switch, and a consumer parsing prose breaks the first time the
wording changes.

| Reason | Decided by | Meaning |
|--------|------------|---------|
| `indeterminate` | the gate, or the spend mark | A fire was marked and never confirmed, so the runtime cannot tell whether the bytes already shipped |
| `outside_window` | the gate | The approval window has closed, its zone no longer resolves on this host, or its approval instant cannot be parsed |
| `content_moved` | the gate, or the spend mark | The approved bytes are no longer what would ship, or the producer's Output that held them has been erased, or the producer's latest run produced no Output (§ 10, `last_output`) |
| `mark_unavailable` | the spend mark | The mark could not be attempted at all — the state document could not be locked or could not be read, or the fire intent could not be recorded (§ 14) — so nothing was written and nothing was sent |
| `mark_uncertain` | the spend mark | The mark's own write failed, so whether it landed is unknown; nothing was sent either way |

At the gate the first three are decided in that order, and the order is not
arbitrary. An `indeterminate` mark outranks both of the others because neither
"the window closed" nor "the bytes moved" can be answered honestly while the
runtime does not know whether the fire already happened.

**That precedence covers the gate and nothing else.** The spend mark is a
second decision, taken after the gate has already said fire, and a refusal from
one is never a candidate for the other's decision. The mark re-reads the record
under the state document's lock as its own precondition, so it can answer
`content_moved` when the record has gone, its fingerprint moved, the
producer's Output was erased since the advance read the document, or a run of
the producer that produced no Output was written since the gate read it, and
`indeterminate` when something else has marked it since. An erased record the
advance read, ran the producer over and produced again is not refused: the
gate read the bytes that run produced, and the end-of-run write puts them over
the erased record. It checks
`content_moved` first. A consumer holding either of those two reasons cannot
tell from the reason alone which point refused; the entry's `result_summary`
says so in prose. `outside_window` is the one reason the mark never produces.
`mark_unavailable` and `mark_uncertain` come only from the mark, and they are
two members rather than one because they leave the operator in different places: after `mark_unavailable` the record on disk is untouched
and the next advance retries cleanly, while after `mark_uncertain` the record
may be marked and the next advance may refuse with `indeterminate`. Neither maps
onto `indeterminate` itself, which means the runtime cannot tell whether the
BYTES SHIPPED — on both mark reasons they definitely did not, because the
handler is never invoked.

The underlying I/O error is deliberately not carried into the refusal string.
Its message embeds the state document's path and the parser's quotation of the
document's own bytes, and these strings reach the run log, the JSONL rows and
the board. The diagnostic is deferred rather than lost: the next advance's
top-of-run read raises the same error to stderr with a non-zero exit.

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
| `erased_at` | ISO 8601, UTC (`Z`) | stored only | Set by the runtime when it erased `body` (§ 10, `last_output`). Never accepted from a handler |
| `body_sha256` | 64 lowercase hex characters | stored only | The sha256 of the erased body, so a fingerprint does not move across erasure |

A handler's Output declares exactly one of `body` and `path`. Declaring both
fails validation and declaring neither fails validation, so a reader never has
to decide which one wins.

The record the state document stores, `StoredOutputRecordSchema` (exported from
`warpline/schemas/skill-result` beside `OutputRecordSchema`), adds one state:
erased. An erased record declares neither `body` nor `path`, carries
`erased_at`, and must carry `body_sha256`. A record that is not erased carries
no `body_sha256`, and the stored read refuses one that does. The two stored-only
keys are the runtime's, never a handler's. A handler that returns either one has it stripped
when its Output has a body or a path, and is refused as an invalid result when
its Output has neither. So no plugin can hand the runtime a bodiless Output.
An applied gate stores its result's Outputs in the same shape.
`StoredSkillResultSchema`, exported beside `SkillResultSchema`, is the skill
result with stored Outputs,
used only at `pending_gates[].plugin_result`. Handlers are still parsed
against `SkillResultSchema`.

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

`preferences.json` is read strictly. An unknown key at the top level or inside
`quiet_hours` or `retention` is refused, and so are a wrong type, an
out-of-range value, a bad `HH:MM` and malformed JSON. An advance refuses before
any write, exiting `75` with the home byte-identical (§ 11). `warpline run`
refuses before the plugin runs, exiting `1` with `ok: false`. The message names
the file, the key path and the expected shape, and never a value read out of
the file. A missing file is the built-in defaults. The strictness has one
accepted cost: a key added by a later release is refused by an earlier one, so
remove it before downgrading.

Every production read of `preferences.json` is checked against the audit store
(§ 14): an advance, once it holds the run lock and before it uses any value, and
`warpline run`, before the plugin runs. Only a file that parsed is checked. The
sha256 of the exact bytes parsed is compared with the last digest the store
holds for the file. A difference appends `preferences.observed` naming the two
digests, and neither what changed nor who changed it. A hand edit is a
difference, so is a file the store has not seen and a file that was deleted.
Bytes are compared, not values, so re-spacing the file is recorded too. A
failed append refuses the read: `advance` exits `75` with nothing fired, and
`run` exits `1` with `ok: false` and the plugin not run. An invalid file is
refused before the comparison, as above, and is never digested. A missing file
the store has never seen records nothing.

`warpline prefs set <dotted.key> <json-value>` is the audited writer of
`preferences.json`. It reads the file as above, records a pending hand edit
first, then appends `preference.set` naming the key path, the sha256 of the old
file bytes (`null` when there was no file) and the sha256 of the bytes it is
about to write, and only then writes those bytes through the same atomic write
as every state file. The record never carries the value. Because the new digest
is over the exact bytes written, the next read finds the file matching the store
and records nothing. A value already in effect writes nothing and records
nothing. An unknown key, a value that is not JSON or a value the schema refuses
exits `1` with nothing written and nothing recorded, and so does a failed
append. No message repeats the typed value. A hand edit is still allowed, and is
still recorded on the next read. The read, the record and the write happen under
the state lock (§ 10), so two sets at once never read the same file and lose
one of their writes.

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
  `approvals`). That run's log holds a summary of the run, not the content. The
  approved content is `plugin_runs[producer].last_output.body` in the state
  document. Keeping the log while the yes is outstanding keeps the record of
  the run an approval names. A stored `run_id` that is neither a pending gate's nor an
  open approval's does **not** protect: a `last_output` pointer and a versioned
  Output's history are documented to dangle (§ 10), and treating a dangling
  pointer as protective would be retain-forever by accident;
- a document that will not parse, which is left on disk so an operator can
  inspect it by hand.

**An approval's protection ENDS when its window closes.** From the first
advance after `not_after`, the referenced run's log is an ordinary candidate
again, unless a pending gate or another open approval names the same run, and
the three bounds below reclaim it with no new mechanism. That log
holds a summary, not the content. The content a frozen batch carries is
recipient data. The end-of-run write of the same advance erases it, with
`body` deleted and `erased_at` and `body_sha256` stamped, and sweeps the
binding that named the run, by the rules § 10, "Expiry and deletion", states.
That section
names the cases this paragraph does not reach. Three
readers share one predicate: prune protection, the content erasure and the
binding sweep. They share the window test, not one set: a run log covers every
plugin in its advance, so any open approval naming the run protects it, while
content belongs to one producer's Output, so
only an open approval for that producer holds it. So the three
never disagree about whether a window has closed. Protection does not
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
read.** A misspelled key no longer passes: it refuses the advance, as above.
What a correctly spelled key did is another question, and the file cannot
answer it.

What an advance reports is how many runs it removed, not why. Removed means
gone from the directory and not merely selected: a run whose files survive the
unlink — a permission error, a file something else holds open — is not in the
count. `warpline advance
--json` carries a `pruned` count for the advance that just ran, and the dead-man
file (§ 13) carries the same number for the last advance that returned. Read it
for what it is: one integer standing for all three bounds, which cannot say
which of them bound. So a non-zero count does not attribute the eviction to the
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

A `manifest.ts` that imports cleanly but has no `manifest` export is a load
failure of the same shape, reported as `manifest.ts has no 'manifest' export`.
That text is fixed, so it carries no value the manifest author wrote.

A broken manifest is reported on **every call** within one process, with the
error it threw the first time, because both supported runtimes re-throw a
module's cached evaluation error on a later import of the same file. Bun does
so from 1.4.2, which is why `engines.bun` names it. The loader keeps no memo of
its own. A `manifest.ts` written after a call that found none loads on the next
call. A `manifest.ts` fixed in place after it failed, whether it threw or had no
`manifest` export, keeps reporting that first failure for the rest of the
process, because both runtimes serve the file's URL from their module cache. A
new process loads the fixed file.

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
  "scopes": ["digest-sender", "issue-render"],
  "scope_windows": {
    "digest-sender": {
      "first_granted_at": "2026-08-20T12:00:00.000Z",
      "expires_at": "2026-08-20T16:00:00.000Z"
    },
    "issue-render": {
      "first_granted_at": "2026-08-20T09:30:00.000Z",
      "expires_at": "2026-08-20T13:30:00.000Z"
    }
  }
}
```

| Field              | Type               | Meaning |
|--------------------|--------------------|---------|
| `granted_at`       | ISO 8601 string    | When the most recent grant was written. |
| `first_granted_at` | ISO 8601 string    | The earliest `first_granted_at` across `scope_windows`. On a file without `scope_windows`, when the FIRST grant in this window was written — the anchor for the 23-hour ceiling below. Optional on read, always written. |
| `expires_at`       | ISO 8601 string    | The earliest expiry across `scope_windows`. On a file without `scope_windows`, when the grant stops being honoured for every scope. Always written, and a file whose `expires_at` will not parse is corrupt. |
| `scopes`           | `"*"` or `string[]` | `"*"` approves every plugin. An array approves exactly the plugin **directory** names it lists — the same key the engine passes to the gate, not `manifest.name`. Always written sorted, so both the file and its diff are stable. |
| `min_reader_version` | integer, optional | The oldest reader that may interpret the file. A reader whose own version (`GRANT_READER_VERSION`, 1 in this build) is lower refuses the whole file, and so does any value that is not a finite number. Nothing writes it yet. |
| `scope_windows`    | object, optional   | One window per scope key (a plugin name, or `"*"`), each with its own `first_granted_at` and `expires_at`. Each scope expires on its own clock and is capped at its own ceiling. Written by `warpline approve`; `grantApproval` does not write it. |

The file is written with `JSON.stringify(payload, null, 2)`. It is a plain
TypeScript `interface`, not a Zod schema, and carries no `schema_version`: the
only compatibility rule it needs is the one below.

**Compatibility.** `first_granted_at` was added in 0.1.0. Every read is
`first_granted_at ?? granted_at`, so a file written without the field still
loads and its single grant time serves as its own anchor. An older build
reading a newer file ignores the field. Removing the field later would silently
reset every ceiling anchor to the latest grant, which is the failure the field
exists to prevent — treat it as permanent.

`scope_windows` was added in 0.5.0. Before it, one `expires_at` covered every
scope, so `approve b --ttl 1h` after `approve a --long --ttl 30d` gave `b`
thirty days. A file without it is read as one window over every listed scope,
which is what it meant when it was written. The top-level `expires_at` and
`first_granted_at` are written as the EARLIEST window's, so an older build,
which ignores `scope_windows`, expires every scope at the soonest window's
expiry. A rollback narrows authority and never widens it. An older build's
`approve` rewrites the file without `scope_windows`, and the file then reads
the old way again.

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

A file with `scope_windows` is decided per scope: a plugin is approved when the
file lists it and its own window is live, or when a `"*"` window is live. One
scope's window never approves another, and a window for a scope the file does
not list approves nothing. A window whose `expires_at` will not parse is not
live.

A file carrying a `min_reader_version` above this build's is refused outright,
before anything else in it is read: every scope reads unapproved. This is the
X.509 critical-extension rule applied to one file. A reader that cannot see a
field must not guess at what it grants. No build writes the field yet. It
exists so the next format change that an older reader could misread as more
authority can set it, and every reader from this build on already refuses.
`warpline approve` over such a file starts a fresh grant, which narrows.

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

**A `failed` result is never parked.** This holds for a promoted plugin and for
one declaring `autonomy_level: 'supervised'` alike, and in a dry run too. The
result is recorded `failed` exactly as an `autonomous` failure is: in the run
log, in `plugin_runs`, in the board events, the exit code (§ 11) and the
dead-man file. The advance does not stop after its level, and a plugin that
declares it as a dependency is skipped with `dependency_failed`. There is
nothing to review. The handler's side effects fired before any gate, and a park
would have published the result's Output to `plugin_runs` all the same.

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
| Scopes | Unioned with the live grant and written sorted. A `"*"` on either side absorbs the other in `scopes`; the named windows stay in `scope_windows`. |
| Windows | **One per scope.** A requested scope that holds a live window keeps its `expires_at`; a scope without one opens its own window from now, with its own `first_granted_at`. Every scope the command did not name keeps its window unchanged, so a later `approve b --ttl 1h` gives `b` one hour and neither shortens nor lends a standing `--long` window on `a`. |
| `expires_at` | **Preserved** per scope. An explicit `--ttl` may extend a scope's window, never shorten it. |
| Ceiling | Each window's expiry is capped at its own `first_granted_at + 23h`. A capped scope reports the cap on its stdout line. |
| `--long` | Permits an expiry past the ceiling for the scopes named, and prints that it did. |
| Prior `--long` window | The ceiling never shortens time a scope already holds. `mergeGrant` caps at `max(first_granted_at + 23h, live expires_at)` for that scope, so a window opened by an earlier `--long` survives every later plain `approve` of it unchanged, and `capped` is false. Revoke to close it early. |
| `--replace` | Drops every other scope and resets the requested scopes' expiries. It never restarts a live scope's ceiling: a requested scope that holds a live window keeps its own `first_granted_at`, or repeating `--replace` would walk the window forward. A requested scope with no live window starts fresh, as on any approve. It never borrows another scope's anchor, which could hand it a ceiling already in the past. |
| Unparseable `first_granted_at` | That window is **not merged onto**. The anchor is what the ceiling is measured from, so an anchor that will not parse is a ceiling that cannot be computed. `mergeGrant` drops the window and starts that scope fresh, which costs the operator a scope they re-grant in one command rather than handing out a window nobody authorised. |
| Expired window | Not merged onto. That scope's window has closed; the next grant of it restarts it, with a new `first_granted_at`. Other scopes are unaffected. |
| Output | One line per live scope, each with its own expiry, then `Grant file: <path>`. |
| Default TTL | 4 hours. |
| `--all` | The only path to `"*"`. No positional name is ever treated as a wildcard. It prints the number of side-effecting plugins and the total number of declared side effects it covers before granting. |
| Concurrent approve | The file is not locked, and the outcome is last-write-wins: each invocation reads the live grant, merges in memory and writes the whole result, so of two overlapping invocations the later write wins outright and the earlier one's scopes are lost. |
| Zero duration | Rejected before anything is written. `--ttl` takes a positive integer followed by `m`, `h` or `d`; a bare `0` fails the grammar and `0h` fails the positive-value check. The command exits 1 and the file is untouched. |
| Empty scope list | Reachable only from the library path, which writes an empty `scopes` array. It approves nothing — an empty list is not a synonym for `"*"`. The command cannot produce one: `approve` with no plugin name and no `--all` prints usage and exits 1. |

`warpline approve` appends a `grant.issued` record (§ 14) after every refusal
check and before it merges, carrying the scopes asked for (`["*"]` for
`--all`), the requested TTL in milliseconds or null, and the `--replace` and
`--long` flags. When that record cannot be written, it says so on stderr,
grants nothing and exits 1.

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
After a revoke, every side-effecting plugin reads as unapproved. When a grant
file exists, revoke first appends a `grant.revoked` record (§ 14) naming its
live scopes. A revoke only narrows authority, so it removes the file even when
that append fails, then exits `70` with a stderr line saying no audit record of
the revoke was written. With no grant file it writes no record.

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
TTL staleness check reads. That check consults `last_run_at`, and `status` for
one rule: an entry recording `failed` is not fresh, so the plugin is due at the
next advance whatever its `ttl_hours`. `ttl_hours` is how long a success stays
fresh, and a timeout is recorded `failed` like any other failure. `partial`,
`skipped` and `gated` entries age by `last_run_at` as before. A plugin that
keeps failing is therefore retried on every advance; the scheduler's interval
is the backoff.

The dueness evaluator is a second reader of the record, and the first reader for
which `status` decides whether a plugin runs at all. A plugin holding a declared
dependency whose entry here records `failed` is not due, for the reason
`dependency_failed`, and is recorded `skipped` with a summary naming every such
dependency in manifest-declared order. A plugin whose declared dependency an
earlier level of the same advance held back for this reason is held back too.
That dependency is named `'<name>' held back by a failed dependency`, after any
that recorded `failed`, separated by `; `:
`dependency failed — 'a' last recorded status 'failed'; 'b' held back by a failed dependency`.
A plugin whose dependencies only recorded `failed` reads exactly as before. Until
that gate existed, the dependent ran
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
| `last_output` | Output record, optional | The most recent Output this plugin produced. Its content may have been erased; see § `last_output` |
| `run_id` | string, optional | The run that wrote the entry; for an applied gate, the run that parked it. A `last_output` whose `run_id` differs was carried forward from an earlier run, because the latest one produced no Output (§ `last_output`). An entry without it, written before the field existed, reads as produced |

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

A supervised run whose result is `failed` is not parked, and records `failed`
(§ 9).

`skipped` records a run whose handler returned `skipped` — in practice every
dispatched handoff from a plugin declaring `llm_handoff: true`, since that is
the only path producing one today. A handoff from a plugin that does not
declare it is refused and records `failed`. The plugin's own terminal status is written through unnarrowed, so a
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

**Transitive within an advance.** In a chain A → B → C, a B held back writes no
run record, so the hold is not stored. B's own recorded status stays whatever it
last was, very likely `success`. The hold is derived again on every advance,
level by level, from A's failed record: B is held because A recorded `failed`,
and C is held because this advance held B. This holds for every consumer class.
A chain member that is still fresh is not due, holds nothing, and its dependents
read its fresh Output, which is what its TTL promises. On upgrade, more plugins
read `dependency_failed` than before, in every fleet: a scheduler or dashboard
keyed on skip counts sees the change. No field, status or board event changed.

Four limitations, written down here rather than left for a reader to discover.

**The latch, and how it clears.** The gate reads the LAST run's status, so a
dependency whose last run failed gates its dependents until it runs again
without failing. In the ordinary case it self-clears on the very next advance:
a failed run is never fresh (§ `plugin_runs`), so the dependency is due, it
runs, its entry is overwritten, and its dependents are due again. It cannot be cleared by hand — `warpline run` invokes one plugin
standalone and writes no run record, so a manual run of the failed dependency
leaves the latch exactly where it was. It is genuinely sticky only for a
dependency that has stopped being scheduled at all: a `manual` dependency nobody
invokes under an advance, one filtered out by the active profile or tier, and —
the worst case — one deleted from the plugin directory outright, whose stale
`failed` record outlives its manifest and can never be overwritten. A dependent
declaring a dropped dependency is then gated permanently. Editing
`engine-state.json` is the only way out.

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
state is already the answer. The preview derives the second hop from its own
`dependency_failed` verdicts, so it reports one only where it already reported
the first, and the direction below is unchanged.

That assumes a due producer clears its latch, which `plan` cannot know. A
producer that is due and fails again leaves `plan` reporting a dependent **due**
where the advance skips it, and reports that dependent's own dependents due
where the advance holds them too. The reverse can no longer happen: the due set
only ever removes a `dependency_failed` verdict, and the held set adds one only
behind a verdict the advance also reaches. The direction is the
point. This runtime asks a human to approve side effects on the strength of what
the preview showed, so a preview that under-states an advance is the input to a
wrong answer, and one that over-states it is only a plugin that did not run.
Pinned by `plan.test.ts` Test 2b.

The content gate over-states the same way. A content-class consumer whose
approval reads `content_moved`, for carried, erased or moved bytes, while its
declared producer is due at an earlier level of the preview, is listed due with
the line `may fire if '<producer>' re-produces the approved bytes this advance`.
The producer's run decides the standing, and a preview cannot know what that
run will produce. The evaluator's verdict stays not-due and carries a hint that
only `plan` reads, so an advance never fires on it without a content authority.
A producer that produces other bytes, or none, leaves `plan` reporting the
consumer due where the advance refuses it `content_moved`. Pinned by
`plan.test.ts` Tests 2d to 2f.

### `pending_gates`

A supervised plugin's result parked pending a human answer. There is at most
one entry per plugin, and a fresh park replaces it. An advance that parks
nothing for the plugin leaves its entry in place, for example when the plugin
was not due, its result failed, or its invocation threw. So the entry can come
from an earlier advance than the most recent one, and such an older gate is
refused as superseded when applied (§ 10, "Applying a gate", step 2). An entry
another writer applied or discarded while an advance ran stays as that writer
left it (§ 12).

| Field | Type | Meaning |
|-------|------|---------|
| `plugin` | string | The gated plugin |
| `run_id` | string | The advance that parked it |
| `created_at` | ISO 8601 string | When the gate was written |
| `payload_summary` | string | The result's summary, for a one-line render |
| `plugin_result` | Stored skill result | The REAL result the handler returned, Outputs and all. An applied gate's copy of released content is erased, not removed (§ 10) |
| `run_started_at` | ISO 8601 string or null | When the gated run started |
| `run_completed_at` | ISO 8601 string or null | When the gated run ended |
| `applied_at` | ISO 8601 string or null | When the gate was applied; null while live |

`plugin_result` is the result the plugin actually returned. Earlier builds
stored a fabrication here — `status: 'partial'`, an empty `artifacts_produced`
— and dropped the real thing. Approval is acceptance of an observed outcome, so
a gate that does not carry the outcome cannot be approved in any meaningful
sense.
Its Outputs are stored records (§ 5). When erasure releases content an applied
gate recorded, the gate's copy is erased in the same write and kept as a record
marked `erased_at`, so the gate still says what the run produced. A gate still
pending keeps its copy.

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
   `deny` can tell an accepted result from a pending one.
   Neither needs the bytes. When erasure releases the content the gate recorded,
   the same write erases the marker's copy of it (§ 10, "Expiry and deletion"),
   and the marker stays. **A gate survives the next advance, applied or not**,
   and is dropped only when it passes the
   23-hour gate ceiling or when the plugin gates again and the new parked gate
   supersedes it. One rule covers the whole array; the clock differs because the
   question does. A marker ages from `applied_at`, the moment the result was
   accepted. An unapplied gate ages from `run_completed_at`, the moment the run
   produced it — the same clock the expiry check uses. A gate carrying no
   `run_completed_at` never survives, since it is refused at apply time anyway.
   The advance applies this rule to the gates the document holds when it
   writes, not to the ones it read at its start. A gate applied while it ran
   survives as a marker, and a gate discarded while it ran stays discarded.

   Both halves were once overwritten wholesale, and the split that replaced it
   kept markers while still discarding parked results. Nothing chose that: a
   daily engine destroyed the previous day's proposal before anyone could review
   it, and the 23-hour ceiling was unreachable in live operation — a limit only
   a seeded clock could observe.
2. **Superseded** — the plugin's `plugin_runs` entry names a run other than the
   one that parked this gate, so the plugin ran again after the park. A failed
   run, or one whose invocation threw, parks nothing, so it does not replace the
   older gate, but its entry is the plugin's latest record. Refused, the gate is
   discarded with a `notice` (`gate_invalidated`, reason `superseded`), and the
   entry is kept as the later run wrote it. Checked before the next two because
   both delete the entry. Only identity is compared, never order (§ `last_output`).
   An entry with no `run_id`, written before the field existed, and no entry at
   all are applied as before.
3. **A dependency moved** — some dependency's `plugin_runs.last_run_at` is newer
   than `run_started_at`. The parked result was computed against inputs that
   have since changed, so it is refused, the gate is discarded, and a `notice`
   naming the plugin is written.
4. **Expired** — the gate is older than the earlier of the plugin's `ttl_hours`
   and 23 hours, measured from `run_completed_at`. Refused and discarded, with a
   `notice`. **This is a state transition the approve verb makes, not something
   a renderer infers**, which is what stops an approval and an expiry racing
   into a double apply.
5. **Otherwise applied.** The plugin's `plugin_runs` entry is overwritten in
   place: `last_run_at` stays at `run_completed_at`, the status becomes the
   result's real terminal status, `run_id` is the run that parked it, and
   `last_output` carries the Output the run already produced. `applied_at` is
   stamped on the gate. If that Output's
   content was erased while the gate was pending,
   the erased record stays, because erasure is one-way
   and the binding that released it is gone. The same write erases the gate's
   copy of those bytes.

   The entry overwritten is always the one the parking run wrote, because step 2
   refused any other.

On a moved dependency or an expiry (steps 3 and 4) the plugin's `plugin_runs`
entry is deleted, which leaves it due on the next advance. The parked result was
never accepted, so there is no accepted run to hold the work back; the `gated`
entry existed to stop the effects re-firing during the hold, and the hold is
over.

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
does not. A binding that still holds over erased content does protect the
entry, although the gate refuses to fire it (`content_moved`): deleting the
entry would make the producer read as never having produced (§ 10,
`last_output`). The carve-out reads the binding through the function the gate's
own read is built on, so nothing re-derives the predicate, and nothing here
decides whether anything fires.

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

Nothing a reader depends on is lost. Whatever the park wrote to
`plugin_runs[plugin]` stays, `last_output` included, and
the run log keeps a summary of the run, never its result.
`pending_gates` is the review queue, not the record.

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
content out of the record. An erased Output enters by the `body_sha256` stored
when its body was erased. That is the same digest, so erasure never moves a
fingerprint and never re-raises an answered Ask.

The Outputs hashed are the ones in `plugin_runs[plugin].last_output`, not the
ones in a parked gate. A gate now outlives the advance that parked it, so the
original reason — that one would vanish a day later — no longer holds as
stated; the choice does. A gate is still the shorter-lived record of the two:
it is marked spent on apply, and discarded on denial, when superseded, and at
the ceiling, while `plugin_runs` outlives all four. Binding an answer to the longer-lived record is
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

Both directions are on the audit record (§ 14) before this table changes.
`warpline deny` appends one `denial.recorded` per plugin with its fingerprint,
and `warpline deny --remove` appends one `denial.lifted` per plugin, in the
order named, with the stored fingerprint (null when it is not a hex sha256).
Either refuses with the state document unchanged when an append fails.

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

`warpline approve <consumer> --content` appends a `content_approval.issued`
record (§ 14) inside the state lock, before the state write, with the consumer,
the producer, the fingerprint, the producer's run id and the window as the two
ISO instants it resolved to. The typed wall clocks and the zone stay out. A
re-approve that replaces a record carries the replaced fingerprint in
`replaced_fingerprint` and writes no separate withdrawal. `--content --remove`
appends a `content_approval.withdrawn` record with the stored fingerprint
before the record is deleted. Either refuses with the state document unchanged
when its append fails.

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
  approval stops applying; it is not renewed and nothing re-asks. The
  fingerprint does not move when the producer's content is erased (the stored
  `body_sha256` keeps it equal, see `denials`), so the gate reads `erased_at`
  itself, and an approval over erased content refuses with `content_moved`
  rather than firing on a record with no bytes. A producer whose latest run
  produced no Output refuses with `content_moved` too: the runtime carries its
  last Output forward, so the bytes and the fingerprint are unchanged, but the
  producer is no longer proposing them. The check reads the producer's
  `plugin_runs` entry, whose `run_id` differs from its Output's, rather than
  anything the advance that ran it noticed, because that producer is usually
  still fresh on the next advance and is not re-run to say so again.
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
  `confirmed_at` still null and neither `shipped_at` nor `not_shipped_at` set is
  the indeterminate state: the runtime began firing and cannot prove it finished, and nobody has
  answered for the sink. It is deliberately representable rather than collapsed
  into one boolean, because "we do not know" is a different answer from "it did
  not happen".
- `not_shipped_at` — ISO instant the operator, having checked the sink with the
  effect id, answered the marked fire as not shipped
  (`warpline resolve <plugin> --not-shipped <effect-id>`, § "Answering an
  indeterminate fire"). Written by that one command and nothing else, only over
  a fire marked and never confirmed. From then on the record reads `spent` and
  fires nothing; a fresh approval retries. Absent otherwise, and on every record
  written before the field existed. Validated as an ISO instant on read, so a
  hand-edited value that is not one fails the read closed.
- `shipped_at` — ISO instant the operator, having checked the sink with the
  effect id, answered the marked fire as shipped
  (`warpline resolve <plugin> --shipped <effect-id>`, § "Answering an
  indeterminate fire"). Written by that one command and nothing else, only over
  a fire marked and never confirmed. From then on the record reads `spent` and
  fires nothing; a fresh approval fires again. It is not a confirmation:
  `confirmed_at` stays the advance's. Absent otherwise. Validated as an ISO
  instant on read, so a hand-edited value that is not one fails the read
  closed.

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
end-of-run state write,
unless its fire is marked and unanswered or the last row of the table below keeps it.
Nothing an operator does is required, and the sweep runs inside every advance.

This is the last of three steps in one deletion policy. All three read the
**same** window predicate over the **same** instant:

1. **The run log stops being protected.** An approval stops protecting the run
   it names the moment its window closes (§ 6), so the log is an ordinary
   prune candidate again unless a pending gate or another open approval names
   the same run. It holds a summary of the run, not the content.
2. **The content is erased.** The end-of-run write erases the content of every
   Output that a closed approval for that producer binds, once no open approval
   for that producer still binds it: `body` is deleted, and `erased_at` and
   `body_sha256` are stamped. The record stays (§ `last_output`). An approval
   for that producer binds its Output when it names the Output's `run_id`, or
   when its `fingerprint` equals the one the Output's bytes produce, because
   the gate decides authority by fingerprint: a producer that re-produced
   byte-identical content under a later run leaves an approval naming the
   earlier run `live`, and erasing under it would void that yes.
   Binding is not the same question as being `live`. A confirmed approval can
   never fire again, but
   it binds by fingerprint until its window closes: bytes it shipped under a
   later run than it names, and byte-identical bytes the producer makes again
   after the fire, are held while its window is open and erased when it
   closes. The fire does not rewrite its `run_id`, which stays the run the
   operator read. Two limits are stated, not closed.
   A marked approval whose fire is neither confirmed nor answered binds by
   `run_id` only: the sweep keeps it until the operator answers it, and
   binding by fingerprint would erase every later identical
   Output at the write that produced it, so bytes it would match only by
   fingerprint are neither held nor released by it. And the fingerprint is
   computed over the producer's manifest as it is now: when the producer is
   uninstalled,
   its manifest failed to load, or its `side_effects` changed before the
   window closes, content bound only by fingerprint is not erased, and stays
   until the producer's next Output replaces it, for as long as that condition
   lasts. Should the manifest load again, or its `side_effects` change back,
   while a closed binding still matches the body by fingerprint, that binding
   releases it then. This step erases the body at that advance's end-of-run
   write, unless the producer's own Output in that advance has already replaced
   it with different bytes. A `run_id` is the advance's
   id, shared by every plugin that ran in that advance, so
   an approval for another producer neither holds nor releases this content: it
   never reads these bytes. Withdrawing an approval with `approve --content --remove`, or
   replacing it by re-approving the same consumer, is a closure too: that
   command erases the content the old record bound in its own locked write, by
   this same rule, when no other open approval for that producer still binds it
   (§ "Writing and withdrawing one").
   Whichever write erases the content also erases the copy an applied gate
   of that producer holds of those bytes, with the same `erased_at` and
   `body_sha256`, and the gate stays as a marker (§ `pending_gates`).
   A gate still pending keeps its copy, because the operator has not answered
   it yet.
3. **The binding is swept.** This removes what is left of the approval — a
   fingerprint, a producer name, a run id and some timestamps — once there is
   nothing for it to bind to.

Sharing one predicate and one instant is what keeps the three steps from
disagreeing about whether a window has closed, and what stops content being
erased while an open window still binds it. The reverse, content kept after
every window that bound it has closed, is stopped as far as the binds rule
reaches, and
the two limits in step 2 are where it does not. Nor is it stopped for an
approval in a zone the host can no longer resolve: the shared predicate never
reads that window as closed, so the record is kept, and so is the content it
binds (the last paragraph of this section). A binding the table below keeps
after its window closes
is retained after it stops protecting its run.

The one exception:

| state at expiry | what happens |
|---|---|
| `marked_at` null | dropped |
| `marked_at` set, `confirmed_at` null, no answer | **kept** — this is the did-it-ship evidence |
| `marked_at` set, `confirmed_at` null, `not_shipped_at` set | dropped — the operator answered it not shipped |
| `marked_at` set, `confirmed_at` null, `shipped_at` set | dropped — the operator answered it shipped |
| `confirmed_at` set | dropped |
| still binds its producer's `last_output`, which keeps its body | **kept** — its erasure was deferred |

The last row is the one that is not an exception to deletion, and it takes
precedence over the rows above it, so a confirmed record in that role is kept
too. When an open approval for the same producer still binds the content a
closed one binds, the erasure leaves the body and the sweep keeps the closed
binding, so the content still has a binding to release it once the holder
closes. The sweep asks this by the erasure's own binds rule, by run or by
fingerprint, because a holder that binds by fingerprint
stops binding if its fire is left unconfirmed, and the closed binding must
still be there then. It is dropped on the first sweep after its content is
erased or replaced by the producer's next Output.
Until then the gate reports an unmarked one `outside_window`, which is true,
and that has a cost: each advance that evaluates its consumer records
one `refused_plugins` entry and one `plugin_refused` event for it.
A confirmed one reads `spent` and is not counted. A confirmed approval binds
by fingerprint until its window closes, so a closed, confirmed record is kept
this way whenever an open approval for the same producer still holds the bytes
it shipped.

A marked-unconfirmed record is never replaced by absence. It is the runtime's
account of a fire it began and cannot prove it finished, and deleting it would
destroy that account for a send that may well have landed. Keeping it is safe
because its bound content is erased by the same rule, and it binds by `run_id`
only, so identical bytes the producer makes later are not erased on its account
(step 2). The evidence it keeps is the fingerprint and the effect id, never the
bytes. The operator settles it at the sink using the effect id, and answers it
with `warpline resolve` once they know whether anything arrived there. An
answered record is swept
when its window closes, and binds its content by fingerprint as a confirmed one
does.

A **confirmed** record past its window is dropped, unless the last row of the
table above keeps it. While that row keeps it, it reads `spent`, and the
ordinary not-due report naming the spent approval and the instant it fired is
still rendered. Once the record is dropped, that report stops being rendered,
and the plugin reads as having no approval, which it no longer has.

Ceilings this does not reach, besides the two limits in step 2 and the zone
case in the last paragraph of this section:

- `plugin_runs[producer].last_output` is **kept** as a record. It is a fact
  about the producer, carried forward across a run that produced nothing and
  overwritten by that producer's next Output. Only its content is erased, and
  the record says so with `erased_at`.
- A marked, unanswered record **survives the sweep until the operator answers
  it** with `warpline resolve`. It authorises nothing — every advance refuses
  it with `indeterminate` — and it does not go away on its own, because the
  runtime never clears a mark on a handler's word. An answered record is swept
  when its window closes, and binds its content by fingerprint as a confirmed
  one does.

Erasure reaches inline content in the state document and nothing else. What it
does **not** erase:

- a `path` Output. The runtime holds no bytes for it, only a pointer, and
  `approve --content` refuses such Outputs, so no content approval names one.
- a home whose bindings an earlier build `swept`. Nothing records which Output
  was approved, so nothing says what to erase. The producer's next Output
  replaces it.
- the copy a gate still pending holds in `pending_gates[].plugin_result`.
  The operator has not answered it yet, and it has its own lifetime
  (§ `pending_gates`).
  Applying it after its content was erased keeps the Output erased
  and erases that copy (§ "Applying a gate", step 5).
- anything an applied gate holds that erasure has not released: its other
  Outputs, which no approval binds because a content approval binds only the
  producer's last Output, and
  bytes the producer has since replaced without gating again. They stay until
  the gate is superseded or ages out, 23 hours after it was applied.
- a plugin's own `summary` text, which is the plugin's to write.

A zone the host tz database can no longer resolve **retains** the record rather
than sweeping it, and does not fail the advance.
The content it binds is kept with it, and
the run it names stays protected, because the content erasure and prune
protection read the same predicate. Deleting recipient-bound data
because the host forgot a timezone is not a deletion policy. Note that this is
the opposite direction from the fire decision, which reads an unresolvable zone
as a closed window and refuses: both are the conservative answer to their own
question — never fire on a window you cannot read, never delete on one either.

#### The spend mark

`effect_id`, `marked_at` and `confirmed_at` are written by the ADVANCE and by
nothing else. No operator command sets any of the three. The operator's answer
is a field of its own, `shipped_at` or `not_shipped_at`, written by one
operator command, `warpline resolve` (§ "Answering an indeterminate fire"), and
never by the advance. A shipped answer is still not a confirmation.

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
written after, it loses the crash case entirely. The five states and their
predicates:

| state | predicate | what the next advance does |
|---|---|---|
| not yet fired | `marked_at` null | fires, if the window and the fingerprint still agree |
| indeterminate | `marked_at` set, `confirmed_at` null, no answer | refuses with `indeterminate` — never fires |
| answered not shipped | `marked_at` set, `confirmed_at` null, `not_shipped_at` set | ordinary not-due, like spent, naming the answer; approve again to fire |
| answered shipped | `marked_at` set, `confirmed_at` null, `shipped_at` set | ordinary not-due, like spent, naming the answer; approve again to fire |
| spent | `confirmed_at` set | ordinary not-due, naming the instant it fired |

A handler that returns `failed` leaves the record **indeterminate**, not
un-marked. The mark is not cleared on that path: a failed return does not prove
the sink never received the bytes, and clearing it would re-arm a send that may
already have gone out.

Every other handler status confirms the spend: `success`, `partial` and
`skipped`. `partial` confirms because some bytes went out and cannot be unsent.
`skipped` confirms too, and that includes a `[needs-llm]` handoff that shipped
nothing, so a handoff consumes the content approval and the operator
re-approves to fire again. This is deliberate. The mark is taken before the
handler runs, so leaving `skipped` unconfirmed would not leave the approval
live. It would leave the record marked and unconfirmed, which is
`indeterminate`, the same as `failed`: a refusal on every later advance, a trip
to the sink to look for bytes the runtime knows never left, and an answer with
`warpline resolve` before a re-approval is even accepted. Handing the approval back would mean clearing the mark on the
handler's word that nothing shipped, which is the trust refused for `failed`
above.

A handoff from a content-class plugin that does not declare `llm_handoff`
reaches this rule already rewritten to `failed`, so it leaves the record
indeterminate like any other failed return. Declaring the field is the fix.

The mark is taken under the state document's own lock, with the document re-read
inside it, so two content-class plugins in one execution level and a concurrent
`warpline approve --content` are serialised by one mechanism. The write persists
only the `approvals` subtree merged onto that fresh read — never the advance's
in-flight `plugin_runs`, which are not durable until the run returns. If the
record has gone, its fingerprint has moved, or it is already marked by the time
the lock is held, the fire is refused rather than taken: no mark, no invocation.

**The fire intent is recorded inside the same lock.** After that re-check and
before the mark is written, the spend mark appends a `fire.intent` (§ 14) for
the fire: the plugin, the run id, the class `content`, the effect id and the
approval's fingerprint. So when the mark lands, its intent is already on disk,
and the record and the mark share one window. An intent the audit store cannot
take stops the mark before anything is written, and the fire is refused
`mark_unavailable`. A mark that fails after its intent landed is refused
`mark_uncertain`, and that refusal's `fire.refused` carries the intent's seq,
which closes it. A fire whose mark lands is closed by its `fire.outcome` once
the handler returns, as a session fire is.

**The durability ceiling, stated rather than claimed away.** The guarantee is
against **process crash**, not power loss: the state document is written with
rename atomicity and no `fsync`. The outcome is also not durable until the
end-of-run write, so a crash after a successful send but before that write reads
`indeterminate` on the next advance too. That is the conservative and correct
reading — the runtime genuinely does not know — and the effect id is the remedy:
the operator checks the sink with it and, when nothing arrived, answers the fire
with `warpline resolve`, rather than the runtime guessing here.

**When the mark's own I/O fails.** The mark sits between a gate that has already
said fire and a handler that has not been invoked, so its own failure is a
refusal with a reason of its own rather than an error that ends the advance. On
either arm there is **no invocation**: the level loop continues, and
the advance still writes its run log, its JSONL rows and its dead-man file, with
the refused plugin carried on all of them. The two arms are split by where the
failure happened, not by which error class arrived. A lock that could not be
acquired, a document that could not be read, or a fire intent the audit store
could not take is `mark_unavailable`, because all three sit above the write and
nothing can have been written. A write that threw
is `mark_uncertain`, because the rename may have landed.

On the `mark_uncertain` arm the in-memory record is restored to the value it
held before the mark, and the plugin is not among those the advance marked, so
the disk wins in the merge (§ 12, "`approvals` is merged per key"). The disk
then decides: a write that landed reads `indeterminate` on the next advance, and
one that did not is retried and fires. Left marked instead, the end-of-run merge
would promote a mark this process never observed land, which is the runtime
asserting a fact it does not have.

#### Writing and withdrawing one (`warpline approve --content`)

`warpline approve <plugin> --content --not-after <wall> [--not-before <wall>]
[--zone <iana>]` writes the record above for one plugin, and
`warpline approve <plugin> --content --remove` takes it back. Both validate
everything inside a single state-lock critical section before mutating anything,
so a refused command leaves the document byte-unchanged.
A `--not-after` that has already passed is refused before anything is written,
on a first approval and on a re-approve alike: the record would be
`outside_window` from the moment it was written, and a re-approve would erase
in the same write the bytes it had just printed.

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

**An Output whose content was erased is refused by name.** When the producer's
`last_output` carries `erased_at`, there are no bytes for the operator to read,
so the command says the content was erased when the approval that bound it
closed or was withdrawn, tells the operator to run the producer again, and exits `1`. This is
checked before the file check above. The refusal for a producer that has never
produced is unchanged, and in both cases nothing is written.

**A carried Output is refused by name.** When the producer's latest run
produced no Output, the `last_output` on file was carried forward from an
earlier run (§ `last_output`), and it is not what the producer proposes now. The
gate would refuse to ship it, so the command refuses to bind it: it says the
producer's latest run produced no Output, tells the operator to run the producer
again, and exits `1` with nothing written. Checked after the erased refusal and
before the file check. Only the two plugin names are interpolated.

**Withdrawal is validated against the record, not against what is installed.**
A plugin uninstalled after it was approved is still reachable by name from
`--remove`; were it checked against the loaded manifests, its record would be
stranded in the state document with no gesture that reaches it. `--remove` is
not `revoke`, which retires a session grant, and not `deny`, which answers a
proposal with a no — it is the yes to specific bytes taken back, and it leaves
the plugin reported as ordinary unapproved rather than as refused.

**Withdrawal releases the content.** Removed, the record no longer names its
run, so no later advance could tell which content it bound. The same locked
write therefore erases the producer's `last_output` content as a window closing
would (§ "Expiry and deletion"), unless another open approval for the same
producer still binds it. Content left to such a holder is erased when that
holder closes or is withdrawn, as long as it still binds the content then.
A holder that has fired and confirmed still binds by fingerprint until its window closes.
The two limits in § "Expiry and deletion" step 2 apply here too: a holder whose
fire is marked, unconfirmed and unanswered binds by `run_id` only, and content bound only
by fingerprint is not erased once the producer is uninstalled,
its manifest failed to load, or its `side_effects` changed.
Re-approving a consumer over an existing record withdraws the old record the
same way, in the same write. When the new record names the same producer, it binds that
producer's current Output and holds it.
A re-approve onto a different producer says so. Right after the
`Answering the content gate:` line it prints
`Withdrew the earlier content approval for <plugin>, which named a different producer.`
and, only when that withdrawal erased the earlier producer's bytes,
`The bytes it held were erased, since no open approval still holds them.`
Both lines come before the bytes. It never names the earlier producer, which may
no longer be the consumer's dependency. A re-approve onto the same producer is a
renewal and prints nothing new.

**Two refusals protect a marked-unconfirmed record.** For a record with
`marked_at` set, `confirmed_at` still null and no answer, both a fresh
approval and a `--remove` are refused, naming the plugin, the `effect_id` and
the `marked_at` instant, and pointing at `warpline resolve`, the one gesture
that answers it. A fresh approval would erase the open question rather than
answer it, and re-arm a send that may already have gone out; a removal would
destroy the only evidence that a send may have landed. For a record with no
`effect_id`, marked by a build that recorded none, both refusals say instead
that nothing can answer it and only a hand edit of the state document clears it.
A record whose
`confirmed_at` is set, or that was answered, is a state report
rather than an open question, and re-approves and removes normally.

**Answering an indeterminate fire (`warpline resolve`).**
`warpline resolve <plugin> --shipped <effect-id>` or
`warpline resolve <plugin> --not-shipped <effect-id>` answers a fire that was
marked and never confirmed, after the operator checked the sink with its effect
id: shipped when the bytes reached it, not shipped when nothing did. It is its
own verb and not a mode of
`approve`, because it answers a claim about a past fire and grants nothing.

- It answers only a record whose standing (`approvalStanding`) is
  `indeterminate`, and only when the typed effect id equals the record's
  `effect_id` exactly. The answer binds to that one fire.
- It refuses while an advance is running. A run lock (§ 12) held by a live
  advance means the fire that advance marked may still be in flight, because
  the mark reaches the disk before the handler runs and the advance's own write
  comes after it. An answer given in between would be overwritten by that write
  if the fire failed, dropped if it succeeded, and turned into a double send by
  a re-approval if the process died after the send landed. The lock is read
  inside the state lock and before the record, and an advance marks a fire only
  while holding both, so no fire can be marked between the check and the write.
  A lock file that cannot be read back as a lock is refused too, because whether
  an advance is firing cannot be told. A stale lock (§ 12) does not block: that
  is the crashed advance the verb exists for. The exception is a stale lock this
  machine can see is still held by a live process. Handlers run in-process, so
  an advance suspended mid-send, blocked in a handler or asleep with the machine
  stops its heartbeat while its fire can still land. So when the lock names this
  machine's host and its pid is alive, `resolve` refuses whatever the lock's
  age. The cost is waiting for the running advance to end, and after a crash on
  a machine that cannot identify itself, for the two-hour window. `resolve`
  never writes, heals or removes the lock.
- Before it writes, it reads the audit store for
  an earlier `fire.resolved` with this plugin and effect id (the next bullets
  say what that changes).
  Only a line that is a record counts, and not one that a `segment.opened` names in `passed_over` at its position while its bytes still hash as that entry records: that answer is lost to the walk as § 14 says.
  Position is as § 14 Segments defines it, whatever seq the line claims.
  With none there, it appends `fire.resolved` (§ 14):
  the plugin, the effect id, the seq of the `fire.intent` with that plugin and
  effect id when one is still open, else null, and `answer: shipped` or
  `not_shipped`. That record closes the intent.
  The open-intent lookup only names the seq.
  A store that cannot take the record refuses the answer with exit `1`, and
  nothing is written.
- It writes `shipped_at` or `not_shipped_at`, the instant of the answer, and
  keeps `marked_at` and `effect_id` as they were. It never writes
  `confirmed_at`, which stays the advance's account of a fire it saw finish.
- A record that already holds an answer is not `indeterminate`, so a second
  answer is refused, either way round. An answer whose state write did not land
  is on the audit record and found there by the lookup above, while the record
  still reads `indeterminate`. So the other answer is refused, naming the one on
  the record, and the same answer appends nothing and writes only the state
  document. Either way the record never holds two answers for one effect id.
  The lookup only refuses an answer or skips a duplicate record. It never lets
  anything fire.
- When the state write fails after the answer is on the audit record,
  `resolve` exits `1`, says the answer is on the audit record and the approval
  still reads `indeterminate`, and says to
  run the same command again to finish it, naming that command with the
  recorded effect id. It prints nothing from the error.
- The answered record reads `spent`: it fires nothing, it is not a refusal, and
  its not-due detail names when the fire was marked and when it was answered.
  To fire those bytes again, the operator re-approves them with
  `approve --content`, over bytes they read again. A re-approval replaces the
  answered record whole, as it replaces a spent one, and `--remove` withdraws
  it normally.
- Every other case is refused with exit `1` and the document byte-unchanged:
  a run lock held by a live advance, or one that cannot be read back as a lock;
  no record for the plugin (looked up as an own property, and the refusal does
  not repeat the name given), a record that is not
  `indeterminate` (unmarked, confirmed, or already answered), a record marked
  by a build that recorded no effect id (only a hand edit of the state document
  clears such a record, and the refusal says so), an effect id that does not
  match (the
  refusal prints the recorded id and never echoes the typed one), an answer
  the audit record already holds the other way for that effect id (the refusal
  names the one on the record), an audit store that cannot be read for that
  lookup, neither answer or both, other than exactly one plugin, or any other
  flag.
  Every check that reads the document runs inside the state lock, before any
  mutation.
- Like `--remove`, it is validated against the record, not against the
  installed manifests, so the fire of a plugin uninstalled since is still
  answerable.
- It writes no board event and no run-log entry. The answer lives in the
  state document, beside the mark it answers, and on the audit record.

The answer is the operator's word about a sink the runtime cannot see, and the
runtime cannot check it. That is why it is recorded as its own field rather
than as a confirmation, and why it does not re-arm anything: an answer that
turns out wrong has cost a retry the operator chose, never a fire the runtime
chose for them. It erases no content. An answered record binds its producer's
content by fingerprint until its window closes, as a confirmed one does, and
the release rule (§ "Expiry and deletion") lets it go then.

**Answering any open fire intent (`warpline resolve --intent`).**
`warpline resolve --intent <seq> --shipped` or `--not-shipped` answers any
`fire.intent` the audit store lists as open (§ 14), session-class or
content-class, after the operator checked whether its effect happened. An
intent is left open by a process that died between it and its outcome, or by
an outcome that could not be written, and this is how it is closed.

- It refuses while an advance is running, for the reason above and by the same
  check, made first inside the state lock.
- It refuses a seq that is not an open intent, and a malformed form: a plugin
  name, both answers or neither, more than one seq, or a seq that is not a
  positive decimal integer. No refusal repeats the typed seq.
- It reads the audit store, because the open intent is what it answers. It
  authorises no fire and never writes the state document.
- A content fire still marked and unconfirmed under the intent's effect id is
  answered only by the form above, either way, which writes the state document
  too and closes the same intent. So the by-seq form refuses both answers for
  it, and the refusal names that command. Telling this case apart is still the
  one read of the state document the form makes, and a document that cannot be
  read refuses.
- It appends `fire.resolved` with the intent's plugin and effect id (null for a
  session-class fire), its seq and `answer`, and writes nothing else. A store
  that cannot take the record refuses with exit `1`, and nothing is written.

### `last_output`

A pointer to the most recent Output a plugin produced, so a reader can name it
without scanning the runs directory. It is the § 5 Output record plus one
stored-only state, erased. That makes it a second shape on purpose, and its only
difference from the handler's shape is `erased_at` and `body_sha256`
(`StoredOutputRecordSchema`, § 5).

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
clear it. For the advance, the entry already held is the one the document holds
when the advance writes, not the one it read at its start (§ 12). So a run that
produced nothing carries an Output another advance wrote while it ran, or an
erased record, which stays erased. A dependent later in the same advance reads
the advance's own copy, so it can have read an older pointer than the one
written. One write keeps an erased record instead: applying a gate whose run's
Output was erased while it was pending (§ "Applying a gate", step 5). Erasure is
one-way.

**Carried, and never shipped.** A carried Output still serves `lastOutput`
readers, for the reason above. The entry says it is carried: its `run_id` is the
run that wrote the entry, and it differs from `last_output.run_id` exactly when
that run produced no Output. A content-class consumer never ships a carried
Output, and `approve --content` never binds one (§ `approvals`), because the
producer's latest run proposed nothing and an approval is a yes to its current
proposal. The gate, the spend mark and `approve --content` read one predicate
for it. The spend mark reads it on the entry it re-reads under its lock, and
refuses only an entry written since the advance read the document: the entry
the advance started from can read carried while the advance has already run the
producer again and produced, and the end-of-run write replaces it. It treats an
erased entry the same way, by the erasure the advance saw when it read the
document, since erasure keeps the entry's run and the run alone cannot tell the
two apart. Every writer
of the entry decides `run_id` and `last_output` in one place, so neither can be
written without the other.

**Only a run's own write moves `run_id`.** An entry's `run_id` changes
only when a run writes its own result, so no write moves it back to an earlier
run's. An advance stamps the run it is. The gate apply stamps the run that parked the
gate, which finishes that run's own write, so it lands only on the entry that
run left. An entry naming any other run means a later run wrote it, and the
apply is refused as `superseded` (§ "Applying a gate"). An earlier run's result
over a later run's would make a carried Output current again and re-arm a
content approval over bytes the producer no longer proposes. Order is never
compared, only identity, since § 12 already rejected ordering runs by clocks
that can come from different hosts. The one place a later write carries the
older run is § 12's overlap, where each advance still stamps its own run.
`plugin-run-writers.test.ts` holds every writer to the run its row says it
stamps.

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

**Erased, not absent.** Once the last approval for its producer that binds it
has closed, been withdrawn or been replaced by a re-approve, the content is
erased and the record kept: `body` is gone, and `erased_at` and
`body_sha256` are set (§ `approvals`, "Expiry and deletion",
which names the cases this does not reach). So
`capabilities.dependencies.lastOutput` still returns the record, and `null`
still means never produced. The producer's next Output replaces it.

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
anything ran; the code says it without being read. The document also carries
`audit`, the audit store as this advance's Checkpoint left it, with every fire
whose outcome never arrived (§ 14). The codes below are contract
surface. A scheduler unit, a monitoring check or a wrapper script may key on
them.

| Code | Meaning |
|------|---------|
| `0` | The advance ran and nothing failed. Every plugin completed, nothing was due, a plugin is holding at an approval gate, or a content approval declined to authorise a fire. |
| `1` | At least one plugin failed, the plugin root loaded no manifests at all, or the command line was not valid. Or, under `--strict`, an approval gate is still waiting or a content approval refused a fire. Or a write to stdout or stderr failed for a reason other than a reader that has gone away. Output a plugin prints after the drain has begun is dropped, and does not count as a failed write. |
| `70` | The audit store failed during this run: a fire intent, a fire outcome, a fire refusal or the advance's Checkpoint could not be recorded, or the advance's Checkpoint was written but the store could not be read back after it (§ 14). |
| `75` | Could not finish. Often nothing ran and nothing was written, but not always — see below before treating it as a free retry. |
| `130` | Interrupted by a SIGINT or SIGTERM that warpline caught. The process stopped; the work may not have. |

**A `1` before the advance starts is a usage error.** An unregistered flag and a
positional argument are both refused by the argument parser: the command writes
the parser's message plus its usage text to stderr, writes nothing to stdout,
and exits `1` without running anything. `warpline advance strict` — the typo for
`--strict` — is refused there rather than quietly running non-strict. A
`WARPLINE_TRIGGER` that is set to anything but `scheduled` or `manual` is refused
the same way, with one line naming the value. That is a
cause of `1` in its own right and this table is a closed enumeration, so it is
named here rather than left for a monitor to discover as "a plugin failed". What
tells them apart from outside: under `--json` a plugin failure, an empty plugin
root and a `--strict` promotion each write a document to stdout, the last with
`pending_gates` or `refused` above zero, and a usage error writes none.

**`70` means a fire or a refusal has no audit record.** A plugin whose fire
intent could not be recorded did not fire. It is recorded `failed` in the run
log, and it gets no run record, because no run happened. A plugin whose outcome
could not be recorded did fire. It keeps its run record like any other, and its
intent stays open in the store for the next advance to list. A refusal whose
record could not be written still stands: the plugin did not fire. stderr names
each plugin, and for an outcome the seq of the intent left open. Nothing
retries an append. The run finishes and writes its document to stdout with
`exit_code: 70`. `70` outranks `1` and `--strict`, so a run that also had a
plugin failure or a held gate still reports `70`. An advance whose Checkpoint
could not be written exits `70` as well: its document carries `audit: null`,
stderr says the Checkpoint was not recorded, and the dead-man file is still
written, because the advance itself finished. An advance whose Checkpoint was
written but whose store could not be read back after it exits `70` too: its
document carries the Checkpoint's seq with `indeterminate: null`, never an empty
list, and stderr points at `warpline audit verify` for the reason.
`warpline revoke` exits `70` too, when the grant was removed but its record
could not be written (§ 9).

`130` is the conventional code for a process ended by SIGINT, and this command
reports it deliberately rather than by default: it installs a handler for the
length of the run, and `130` is what a signal warpline catches reports. A signal
before the run starts or after it returns kills the process outright, and a
shell shows that as 143 or 130. A death by signal is not an exit code, so the
table above stays a closed enumeration. After the run returns, the advance has
finished and released its lock, so a signal there costs only the tail of the
output.

The handler ends stdout and stderr, and exits `130` once both have drained.
A plugin still printing after the signal loses only what it prints from then
on. What it printed before still drains, and the code is still `130`.
What it drains is plugin output: while a handler runs, its prints go to stderr
(§ What reaches stdout), and an interrupted plugin can leave them queued. The
document is never queued while the handler can run. It is written and the
handler comes off in one synchronous stretch, and a signal can't land between
the two.

On the ordinary path the promise is general: every verb drains stdout and
stderr before the process exits, so a piped `--json` document reaches a slow
reader whole. There is no ceiling there. A reader that stops reading blocks the
writer, as it would any Unix writer. A reader that has gone away (`| head`)
ends the command quietly, with its own exit code. A plugin still printing when
the drain begins keeps the command's own code too. Only what it prints after
that point is lost, and everything queued before it still drains. Any other
write error on either stream is not quiet. The process ends with a stack trace
and exit `1`, whatever the command would have returned, a caught signal
included.

**SIGTERM takes the same handler and reports the same code.** That is the signal
a scheduler sends — `systemctl stop`, a launchd `bootout` and a container stop
are all SIGTERM, and none of them is a SIGINT. Left to the default disposition
they killed the process with no flush and no exit code at all, which is the
failure the SIGINT handler existed to prevent, reached by the route an operator
is far likelier to take. Everything the rest of this section says about an
interrupt now reads for both signals. What your scheduler makes of a `130`
afterwards is its own question and `scheduler-recipe.md` is where it is asked.

The handler also puts a ceiling on itself. It exits once stdout and stderr have
drained, and after two seconds it exits anyway. Without that, a pipe whose
reader has stopped consuming would leave the process unkillable by further
signals — the default disposition is gone while the handler is installed, so
each further signal only asks for the same drain.

Read `130` as "the process stopped", never as "the work stopped". The advance is
not interruptible — no abort is threaded into a plugin invocation — so the plugin
that was in flight may run to completion in a process the operator believes is
dead. Two consequences follow, and both are bounded rather than open:

- Side effects already begun continue. An interrupt is not a cancellation, and
  there is no code that means "cancelled cleanly" because there is no such
  outcome to report.
- The run lock is left behind: the interrupt ends the process before the
  release runs. The next advance heals it only when the lock names a process id
  that is gone and the lock's `host` and this machine's are both known and
  equal. Otherwise it waits out the two-hour window, measured from the lock's
  last heartbeat, or from when it was taken if it carries none it can use
  (§ 12). Either way an interrupted advance is recoverable without any flag
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

The code is computed from exactly four fields of the advance result:
`plugin_states`, `gated_plugins`, `refused_plugins` and `pending_gates`, the
count of gates still waiting (§ 13). It never reads `AdvanceResult.status`,
and
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

`warpline advance --strict` promotes an advance to `1` while any approval gate
is still waiting on a human, **or** when a content approval refused a fire. A
waiting gate is one the state document still holds unapplied for a plugin the
advance loaded (`pending_gates`, § 13), whichever advance parked it: the advance
that parks it counts it, and so does every later advance until it is applied or
dropped. Use it where a gate
waiting on a human is itself the thing you want paged about — a fleet that is
supposed to be running fully autonomously, for instance.

A content refusal is `0` on its own, for all five reasons in § 5. Three of them
say the approval stopped applying: `indeterminate` (a marked fire was never
confirmed), `outside_window` (the window closed) and `content_moved` (the
approved bytes moved). That is the same gate holding for a different reason, and
a held gate is the runtime doing its job. The other two, `mark_unavailable` and
`mark_uncertain`, are not the gate holding. They are the spend mark's own
state-document I/O failing, and they exit `0` too.

That second half is a decision, and it is safe only because of what surrounds
the mark. A full disk, a read-only home or a lock that cannot be broken fails
the mark and then fails the advance's end-of-run state write the same way, so
the advance exits `75`. A state document too corrupt to read fails the next
advance's first read with `75`. A lock that was only busy leaves nothing marked
and nothing sent, and the next tick retries and fires, which is the right
outcome. One case stays quiet and leaves stuck state: a mark write that fails
after its rename landed. That advance exits `0`, and the next one refuses with
`indeterminate`, which the operator answers with `warpline resolve` once the
sink shows nothing shipped (§ 10). If the end-of-run write ever stops failing
the advance on a storage fault, this decision has to be made again.

Without `--strict` the code says `0`, and the count is what tells you a refusal
happened: `warpline advance --json` carries `refused` and the structured reason
for each refusal, and the dead-man file (§ 13) carries the count. That pair is
deliberate. A fleet can refuse every send on every advance for a week, and
nothing about the exit code alone would distinguish that from a fleet with
nothing to do.

`--strict` changes none of the `1` cases. A plugin failure is `1` with it or
without it, and a plugin root that loaded no manifests is `1` with it or without
it. The flag moves the waiting-gate and refused cases and nothing else — and it moves
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
anything that retries automatically.** Two arms of it are: a plugin root that
cannot be read, and a `preferences.json` that fails validation (§ 6), are both
refused above every writer in the advance, including the run lock, so those two
do leave the home byte-identical. The rest do not.

**The preferences arm does not clear on its own.** Every tick refuses until the
file is fixed or removed, and the dead-man file (§ 13) goes stale meanwhile.
"Retry later" is the wrong reading for it: read the stderr line, which names
the file, the key path and the expected shape.
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
holder is an orchestrator session rather than a long-lived process — the
`host` identifier of the machine that took it, which is `null` when that machine
could not identify itself, and `heartbeat_at`, when the holder last said it is
still running. `host` is **nullable and optional** (§ The host identifier,
below). `heartbeat_at` is **optional** (§ The heartbeat, below).

**Acquisition is an exclusive create, not a check followed by a write.** There
is no window in which two processes both see an absent lock and both proceed.

**A stale lock heals; a live one does not.** A lock is stale when its holder has
not refreshed it for more than two hours, or when it names a process id that is
no longer running **on the machine that took it**. The process-id test is
reached only when the lock's `host` and the reading machine's `host` are both
known and equal; in every other combination it is skipped and only the two-hour
window expires the lock. On
contention the acquire reads the holder back, and if it is stale it breaks it and
retries exactly once. A holder that is neither — and a lock file that cannot be
read back as a lock at all — is refused rather than broken. `lock.test.ts` in
this repository holds every arm of that, including the two that refuse to unlink
a file they could not parse.

### The heartbeat

**The two-hour window is measured from the holder's last heartbeat.** The
advance writes `heartbeat_at` when it takes the lock, equal to `acquired_at`, and
refreshes it every minute while it runs. So a holder that is alive is never
healed, however long its advance runs: a plugin's `timeout_ms` has no upper
bound, and healing a long advance let a second one run beside it and fire
session-class side effects again. A holder that stops refreshing, wedged, asleep
or gone, is healed two hours after its last refresh. A lock with no
`heartbeat_at` is measured from `acquired_at`. So is one whose `heartbeat_at` is
not a date, or lies more than two hours ahead of the reading machine's clock:
that is a wrong value, not a clock that runs fast, and trusting it would keep
the lock from ever healing. A holder whose clock runs ahead by less than that
keeps its lease, and is healed that much later. Only an advance refreshes the
heartbeat. A lock an orchestrator session takes through a short-lived process
is never refreshed, so it expires two hours after `acquired_at`, however long
the session runs.

**The refresh never writes a lock this run does not hold.** It reads the lock
back, compares the run id, and renames a new copy into place, so a reader never
sees a torn lock. The first time the lock is not this run's, the heartbeat stops
for good and the advance carries on. Not this run's means the file is gone, or
it reads back as a lock with another run id, and nothing else. A read that fails,
or a file that does not read back as a lock, writes nothing, and the next
refresh tries again: stopping there would let one failed read on a flaky mount
heal a live holder two hours later. The read and the rename are not atomic,
like the release below: a second process can heal and acquire in between, and
the rename then writes over its lock. That is reachable only when this holder's
heartbeat is already two hours old.

**The release waits for the heartbeat.** The advance stops the heartbeat, and
waits for a refresh already in flight, before it releases the lock. A refresh
landing after the release would put the lock back, held by a run that has ended.

**The field is optional, and an older build ignores it.** A lock written by an
older build has no `heartbeat_at`. An older build reading a lock this one wrote
drops the field, so it measures the window from `acquired_at`, as it always
did. A home attached from both builds can therefore still heal a healthy advance
two hours after it started, until every attached build writes the field.

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
that, an advance whose own lock was healed out from under it — its heartbeat
stopped for two hours while the run was still going — deletes the *next*
advance's live lock on its way out, and the tick after that acquires cleanly while two
advances are still running. The narrowing is real and it is not a guarantee: a
read followed by an unlink is not atomic, and there is no portable
compare-and-delete to make it one.

**Contention exits `75` and names the holder** (§ 11). The message says a
process id, or says an orchestrator session, and it says that nothing ran. It
never says the word for an absent value in place of a process id. `advance.test.ts`
holds both arms, and asserts in each that the holder's lock is still on disk and
that no run appeared under the home.

**The lock is taken below the plugin-root and preferences refusals and above the
state read, and released in a single `finally` below the return.** That
placement is what keeps two promises at once: a plugin root that cannot be read
and a `preferences.json` that fails validation are both refused before any lock
exists, and every write the advance makes happens while it holds one. The
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
its holders are every writer of that document: the board, `deny`, `approve` when
it writes state, and the advance's spend mark and end-of-run write. They have
different lifetimes and different holders.

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
home until two hours after its last heartbeat. That is the choice, and the
two-hour window and the dead-process check are what bound it — and for a lock
taken on a different machine, only the two-hour window bounds it. An operator
who knows the holder is gone can delete `.lock` by hand; an operator who is not
sure should wait for the window.

**A process whose event loop is alive keeps its lock, however stuck its advance.** The heartbeat runs on the
process's event loop, not in the advance's steps. A loop blocked by a
synchronous plugin, or a mount that never answers, stops the refresh, and the
lock heals. A process whose loop is alive while the advance waits forever
outside a plugin's `timeout_ms` keeps refreshing, and nothing heals it. Every
plugin call is bounded by its `timeout_ms`, so that takes a fault in the runtime
itself. An operator who finds one deletes `.lock` by hand.

**An interrupted advance can leave a plugin running.** An advance interrupted by
SIGINT or SIGTERM exits `130` (§ 11) once its stdout and stderr have drained, or
after two seconds if they have not, which ends the process and not the work: the plugin that was in flight may run to completion in a process
the operator believes is dead. The lock that interruption leaves behind is
reclaimed by the heal described above: on the next advance if the holder's
process is gone and the lock's `host` and this machine's are both known and
equal, and in every other case at the two-hour window, measured from the last
heartbeat or from when it was taken if it carries none it can use: none at all,
one that is not a date, or one more than two hours ahead (§ The heartbeat). That
covers a lock that was orchestrator-held, names no process, came from another
machine, or carries no `host` or a `null` one, and any lock read on a machine
that cannot identify itself. The two facts belong beside each other because the second is what bounds the
first.

### What the end-of-run write merges: issue #25

**The run lock serialises advance against advance, and nothing more.** An
advance reads the engine state document at the top and writes it at the end, a
window that spans plugin execution, and it holds no state lock across that
window — holding one there would block the board for the length of a run. Every
other writer of the document takes the state lock, so it can land inside that
window. Issue #25 was that the advance's write erased what those writers wrote.

**So the end-of-run write merges.** It takes the state lock, re-reads the
document inside it, and writes the advance's own changes onto that fresh read,
field by field. Every field the advance did not change is written as the fresh
read holds it: `denials`, `completed_tasks`, `extensions`, and any other
top-level key. What the advance did change goes on top, each by its own rule.

| Field | The advance's change | What is written |
|-------|----------------------|-----------------|
| `schema_version`, `last_run_id`, `last_run_at`, `last_interaction_at` | set by the advance | the advance's |
| `plugin_runs` | the entry of each plugin it ran | the advance's entry for each plugin it ran, and the fresh read's for every other plugin, absence included. `last_output` is decided again against the fresh entry, and `run_id` is the advance's (§ `last_output`) |
| `pending_gates` | the gates it parked | the fresh read's gates that survive (§ 10, "Applying a gate", step 1), then the gates it parked |
| `approvals` | the marks and confirmations of its content fires | merged per key (below) |
| `task_aging`, `deferrals` | the tasks its tier archived or auto-deferred | changed by task id, and only while the fresh read still holds the task open, not archived. An auto-deferral also needs the task to have no deferral of its own |

The release rule (§ `approvals`, "Expiry and deletion") then runs over the
merged document, and the expiry sweep after it.

**So a write that lands while the advance runs is kept.** A denial, and the gate
it discarded. A `deny --remove`. An apply, with the entry it wrote and its spent
marker. A refused apply, with the gate it discarded and the entry it deleted. A
withdrawal or a re-approve, with the content it erased. A board write. The
advance tells the plugins it ran from the rest by where it wrote their entries,
never by a timestamp: another advance's entries post-date its start too, and an
apply's entry is dated at its gated run.

**`approvals` is merged per key.** Both of the advance's writes to it — the
spend mark taken before a content-approved handler runs, and the single
end-of-run write — take the state lock, re-read the document inside it, and
merge that subtree per key. The two regions are sequential and never nested.
`approvals` gets a per-key rule rather than the fresh read because the advance
writes it too, and so does another attachment: one home can be attached from
several machines, so a `warpline approve --content` lands at an instant the
advance cannot predict.

The rule is the one `plugin_runs` follows: the advance's copy wins only for what
the advance itself wrote. For `approvals` that is the records whose spend mark
this advance took and saw land.

| Key | Marked by this advance | What is written |
|-----|------------------------|-----------------|
| on disk only | — | the disk record (another attachment approved mid-advance) |
| in the advance's copy | yes | the advance's record, over the disk and over absence |
| in the advance's copy | no | the disk record, absence included |

The advance's copy of a record it did not mark is a read taken at its start, so
it can only be older than the disk. That holds for a record an earlier advance
marked, too. So an operator's re-approval (`warpline approve <plugin>
--content`) or removal (`warpline approve <plugin> --content --remove`) that
lands mid-advance on a record this advance did not mark is kept. An answer does
not land mid-advance, because `warpline resolve` refuses while a live advance
holds the run lock (§ 10). The record it would answer and the advance could
still overwrite is the one that advance marked, whose fire may still be in
flight. Only the overlap below lets an answer land while an advance runs, and
then the merge rule keeps it for any record that advance did not mark.
A record this advance marked is never replaced by absence:
it is the runtime's account of a fire it began, and with `confirmed_at` it is
the evidence that the fire finished.

**The accepted cost: two advances after a TTL heal.** If an advance's run lock is
healed by the two-hour window while the advance is still running, a second
advance can run beside it. The heartbeat makes that reachable only when the
holder stopped refreshing for two hours, or when an older build that ignores
the heartbeat is attached to the same home. Each writes under the state lock,
so neither erases what the other wrote for a plugin it did not run, or a gate it
did not supersede. While the older advance runs on without its lock, `resolve`
cannot see it, which is the same residual.
For a plugin both ran, the advance that writes last wins, even when its run is
the older one, and a gate either one parks supersedes the other's gate for the
same plugin. Only a parked gate supersedes. A run one advance recorded does not,
so a gate the other parked for that plugin stays pending beside it, and an
`approve` of that gate later is refused as superseded, because the entry names
the other advance's run.
Keeping the newer run was rejected: the two runs' clocks can come from different
hosts.

**Which file each writer writes, since this has been recorded wrongly before.**
The `deny` verb and the board write the engine state document, under the state
lock. So does `approve --content`, which records the approval, and `approve
--content --remove`, which withdraws it — both under the same lock.
So does `approve <plugin>` when it answers a parked gate, applying it or
discarding it, under the same lock. So does `warpline resolve <plugin>
--shipped|--not-shipped`, which answers an indeterminate fire, under the same
lock. Its
`--intent` form takes the same lock and writes no state document. So does the advance itself, twice, under
the same lock: its spend mark and its end-of-run write. `approve`'s Grant path
writes the session-approval file instead, `.session-approval` at the root of the
home, and writes no state document at all. The state lock serialises all of
them. The run lock only keeps a second advance out, and makes `resolve` wait (§ 10).

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
| `gated` | integer | How many plugins this advance parked at an approval gate. `0` on every later advance while the same gate still waits: `pending_gates` counts that. |
| `pending_gates` | integer | How many approval gates are waiting on a human: entries in the state document's `pending_gates` (§ 10) with no `applied_at`, whichever advance parked them. A gate applied and kept as a spent marker is not counted. Nor is a gate for a plugin this advance did not load, one uninstalled or renamed since it parked: `approve` and `deny` both refuse a name with no loaded manifest, so no command can clear it, and it would page `--strict` on every tick until the ceiling drops it. Counted from the document this advance wrote, or on a skipped advance from the one it read, since that advance writes none. Either way a gate past the gate ceiling (§ 10, `pending_gates`) is not counted, because the next write drops it. |
| `failed` | integer | How many plugins ended failed, manifests that would not load included. |
| `refused` | integer | How many plugins holding a content approval were not fired: the approval stopped applying (`indeterminate`, `outside_window`, `content_moved`), or the spend mark's own state I/O failed and nothing was sent (`mark_unavailable`, `mark_uncertain`) (§ 5). The **count only**: the reasons are plugin-derived and reach a reader through `warpline advance --json`, never through this file. An unmarked closed binding the sweep keeps because its content is still held (§ 10, "Expiry and deletion") counts here on every advance until that content is erased. A confirmed one reads `spent` and is not counted. |
| `pruned` | integer | How many run records this advance's retention prune removed. Always `0` on a skipped advance, which returns above the prune. |

Those nine keys are the whole document, and `dead-man.test.ts` enumerates them
so that adding a tenth has to be a deliberate act. Nothing else belongs here:
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
will page you every time a plugin waits for a human. Read `pending_gates`,
`refused` and `failed` for the verdict, and read `status` for what the run did.

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
   a quiet night instead of waiting for morning. `pending_gates` is not always
   `0` either: a gate still waiting overnight is counted from the state document
   the skipped advance read. Check this step before the next
   one so that a skipped advance with a load failure reads as broken and asleep
   rather than as broken and awake.
3. **Broken.** `failed` is greater than zero. At least one plugin failed or one
   manifest would not load. Read the run log named by `run_id` — unless
   `skipped_reason` is set, in which case there is no log and the failure is a
   manifest that would not import.
4. **Waiting.** `pending_gates` or `refused` is greater than zero and `failed`
   is zero.
   Plugins are holding — at a session approval gate, or on a content approval
   the runtime declined to fire. Whether that pages you is your call — it
   is the same distinction `warpline advance --strict` makes at the exit code,
   and it covers both fields for the same reason. `gated` is not the field to
   key on here: it counts only what this advance parked, so it reads `0` on
   every later tick while the same gate waits.

   Read `refused` on its own terms. A non-zero `pending_gates` means a human has
   not answered yet; a non-zero `refused` means a human already did, and the
   send still did not happen. Either the answer stopped applying (a marked fire
   never confirmed, `indeterminate`; the window closed, `outside_window`; the
   approved bytes moved or were erased, `content_moved`), or the runtime could not record the
   send in its own state and so did not make it (`mark_unavailable`,
   `mark_uncertain`). A fleet that refuses every send on every advance for a week is a fleet doing
   nothing, and `failed` and `pending_gates` both stay `0` throughout. This field is the
   only thing in the document that shows it. `warpline advance --json` carries
   the reason for each refusal; this file carries the count.
5. **Healthy.** Recent, `failed`, `pending_gates` and `refused` are zero, and
   `skipped_reason` is `null`. `gated` is then zero too.

A healthy file, an all-gated file and an all-refused file are told apart by
`pending_gates` and `refused` on every tick. `gated` and `status` tell an
all-gated file apart only on the tick that parked its gates. On every later tick
while they wait, both read as a healthy file's do.

Two operator notes. Set your staleness threshold from your own timer interval,
not from a number in this document — the runtime does not know how often you run
it. And do not write to this file yourself: nothing here reads it back, so a file
you author misleads only your own detector, but it will do that silently.

## 14. The audit store

Every change to who may act, and every side effect that fires, is appended to
an audit record under `<home>/audit/` before it takes effect. The store is
append-only and has one writer, the runtime's audit module. Nothing in this
runtime prunes it, rotates it away or rewrites a line in it. Retention (§ 6) never
reaches it. The operator archives it by export.

The record is tamper-evident relative to the last head you exported and kept off
the box. A local writer that can write the home can still edit, insert, reorder
or truncate lines and re-link the chain behind them. What it cannot do is make
the result agree with a head it never saw. Nothing stronger than that is
claimed.

### Record format

Each line the writer writes is one CloudEvents 1.0 structured-mode JSON object followed by a newline.
CloudEvents defines a single object and a JSON array batch but no
line-delimited format, so one object per line is warpline's own convention.
Such a line is called an audit record.

The keys are written in this order, and a reader may rely on it:

| Key | Value |
|-----|-------|
| `specversion` | `"1.0"` |
| `id` | The record's `warplineseq`, as a decimal string. |
| `source` | The home id: a `urn:uuid:` minted when the store's first line is written. Never the home path, which carries the operator's username. |
| `type` | `warpline.audit.<kind>`, one of the kinds below. |
| `time` | RFC 3339 UTC, when the record was appended. |
| `datacontenttype` | `"application/json"` |
| `warplineseq` | An integer, `1` for the first line, and the previous record's plus one after that. Contiguous across the whole store. |
| `warplineprev` | The lowercase hex sha256 of the previous record, or 64 `0`s on the first line. |
| `data` | The kind's own fields. See below. |

**The byte rule.** The hash input is the exact bytes of a line as stored, with
its trailing newline excluded.
`warplineprev` is the hash of the previous record under that rule.
Nothing is re-serialized to compute or check it, so a verifier
needs no canonical JSON form and compares bytes.
A record's own hash is never stored in that record.
It is stored in the next record's `warplineprev`, or nowhere if there is none.

`warplineseq` is a CloudEvents Integer, so it is valid up to 2,147,483,647
records. `source` plus `id` is unique per record, as CloudEvents requires,
because the seq is contiguous within one home.

`data` holds identifiers, closed enums, lowercase hex sha256 digests and ISO
times. It never holds approved content, a secret value or a configuration
value. Each kind's fields are a strict schema: an unknown key, a malformed
digest or a line longer than 16384 bytes is refused, nothing is written, and the
refusal's message names the kind and a fixed reason, never a value from the
data.

### Record kinds

The set is closed. A kind outside it cannot be written.

| Kind | What it records |
|------|-----------------|
| `grant.issued` | `warpline approve` is about to write a session grant: the scopes, duration and flags asked for. |
| `grant.renewed` | A session grant renewed. |
| `grant.revoked` | `warpline revoke` is about to clear the session grant. |
| `content_approval.issued` | A content approval is about to be bound to an Output's fingerprint. |
| `content_approval.withdrawn` | A content approval is about to be removed. |
| `denial.recorded` | `warpline deny` is about to record a denial: the plugin, the proposal's fingerprint, and the run id of any parked gate it discards. |
| `denial.lifted` | `warpline deny --remove` is about to take a denial back. |
| `fire.intent` | A plugin holding side-effect authority is about to be invoked. |
| `fire.outcome` | The invocation that intent announced returned or threw. |
| `fire.refused` | A plugin holding a content approval was not fired, and why (§ 5). |
| `fire.resolved` | `warpline resolve` recorded the operator's answer to an open fire intent: `shipped` or `not_shipped`. |
| `principal.added` | A principal is about to be added to the registry. |
| `principal.disabled` | A principal is about to be disabled. |
| `principal_registry.observed` | The principal registry changed without a warpline command. |
| `preference.set` | A preference key is about to be set by a warpline command. |
| `preferences.observed` | The preferences file changed without a warpline command. |
| `ask.raised` | An Ask raised. |
| `ask.answered` | An Ask answered. |
| `handoff.tried` | A handoff tried. |
| `segment.opened` | The first line of a segment file. One opened by `warpline audit pass-over` names each line it passed over, by its position and sha256, as `passed_over`. |
| `segment.sealed` | The last line of a segment file that is full or old. |
| `checkpoint.recorded` | The head as it stood, so it can be exported and checked later. |

Nothing writes `grant.renewed`, `ask.raised`, `ask.answered` or `handoff.tried`
yet. Their schema admits nothing, so an append under any of them is refused
until the work that writes them lands and defines their fields. The last three
kinds in the table are written by the store itself, never by a caller.

The two observed kinds come from comparing an authority file's bytes with the
last digest the store holds for it, never from a warpline command.
`preferences.observed` carries `old` and `new`, the whole file's sha256 before
and after (null for a file the store had not seen, or one now missing), and
`changed` and `editor`, which are always `unknown`. No value, key path or
per-key digest is recorded. `principal_registry.observed` carries `old`, `new`
and `editor` the same way, `changed_ids`: every id added, removed or whose
entry digest differs from the map the store carries, sorted, and
`changed_entries`, which maps each of those ids to its new entry digest, or to
null when the id left the file. It does not carry the whole map. Records
written before this change carried the whole map as `entries` in place of
`changed_entries`, and `principal.added` and `principal.disabled` did too
(§ 15). Those are still read. The comparison and the append happen in one hold
of the audit lock, against the active segment and the authority it carried
forward (§ 14 Segments).

Three kinds close a `fire.intent`: a `fire.outcome`, a `fire.refused` or a
`fire.resolved` whose `intent_seq` is that intent's seq. One whose `intent_seq`
is null closes nothing. An intent none of them has closed is open. A
`fire.resolved` carries the operator's `answer`, `shipped` or `not_shipped`,
and its `effect_id` is null for a session-class fire.

### Genesis and the head

The store's first line is a `segment.opened` record at seq `1` with 64 `0`s in
`warplineprev`. Its data names the home id, which is also every record's
`source`, and the warpline version that wrote it. There is no separate genesis
kind. Segment files are named by the seq of their first line, zero-padded to 16
digits, so the first is `0000000000000001.jsonl` and name order is seq order.

`warpline audit head` prints the head as `<seq> <hex>` on one line: the last
record's seq and the sha256 of its bytes under the byte rule. Before the first
record it prints `0` and 64 `0`s, exits `0`, and creates nothing. It takes no
lock and writes nothing, so it can be run at any time. Keeping its output off
the box is what makes a later check of the store mean something.

`warpline audit head --c2sp` prints the same head as an unsigned note body
shaped like a C2SP checkpoint, three lines: the home id as the origin, the head
seq as the size, and the standard base64 of the 32-byte head hash as the root.
It is not a valid C2SP checkpoint. It carries no signature line, and the root
is the head of a hash chain, not a Merkle root. On an empty store it refuses
with exit `1` and prints nothing, because there is no home id yet to name.

When the active segment's last complete line is not a record, or the segment
holds no complete line, there is no head to print. `audit head` exits `1`,
prints nothing on stdout, and names `warpline audit verify` and
`warpline audit pass-over` on stderr. `--c2sp` does the same.

### Writing

One writer appends at a time. Within a process, appends queue behind each
other. Across processes, writers take the audit lock, `audit/.lock`, a
symbolic link made in one step whose text names the holder: a random token,
the holder's process id, the machine identifier § 12 derives, and the time it
was taken, which is for people and judges nothing. Making the link either
creates it with that text or fails because it exists, so a lock is never empty
and never half-written. So the home's filesystem must be able to hold a
symbolic link. On one that cannot, every append refuses with
`audit lock not acquired: the filesystem under the home cannot hold a symbolic link`,
and nothing is written. On Linux the identifier also carries the holder's pid
namespace and the kernel's boot id. So containers that share a machine id, and
clones of one machine image, are not taken for one machine, and a process id
from before a reboot is never tested after it. When either cannot be read, the
holder names no machine. A writer waits for the lock, polling every 50 ms, for
up to 10 seconds.

A lock is broken only when its holder is provably gone on this machine: it
names a process id and a machine, that machine is this one, and no such
process runs. A process that belongs to another user counts as running.
No lock is broken for its age. A lock whose holder still runs, however long it
has held the lock, or that names another machine, one that cannot be told, or
no process, or that cannot be read as a holder at all, stays until its holder
removes it or someone removes it by hand.

One writer at a time breaks a lock. It makes `audit/.lock.break` the same way,
reads the lock again, judges it again, and removes it only while it still
names the token it was judged by and its holder is still gone. Then it removes
its own break file. The break runs without a wait, and a gone holder cannot
release, so the lock cannot change between that second judgment and the
removal. A lock replaced in between is kept until it is judged itself.
A break file is never removed by another writer, whatever it names and however
old it is. While one is there no lock is broken, and an append that can only
go on past a gone holder refuses in time, naming `.lock.break`.

A writer removes its own lock only while it still names that writer's token.
It does so at the end of its hold, and from an exit hook when the process ends
through `process.exit` while holding it, as `advance` does on SIGINT and
SIGTERM. A holder killed outright, by SIGKILL or by a signal to a command with
no handler, runs no exit hook. On a machine that identifies itself, the next
writer breaks its lock at once. A lock that cannot be taken in time is an
append failure, whatever is at the lock's path. The refusal names the holder's process id and
whether it is on this machine, or says the holder names no process. It says to
remove the lock by hand only once that process is gone. When its holder is gone
but its lock could not be removed, the refusal says so, and says to remove the
lock by hand.

Four cases stay open.

A holder that hangs while it runs blocks every append until it is killed, as
§ 12 chooses for the run lock.

A holder that died on another machine that shares the home, on one that cannot
identify itself, or, on Linux, before a reboot leaves its lock for removal by
hand. So does a breaker killed outright inside its break, for its break file.
Elsewhere the machine identifier outlives a reboot, so a process id from
before it is tested after it: a free one reads gone and its lock is broken at
once, and a reused one reads as running, as the next case says.

A dead holder whose process id was reused reads as running. Its lock stays,
and the refusal names that pid. If it is not a warpline process, the lock can
be removed by hand. A process start time in the identifier is the upgrade path.

There is no fence on the store itself. A holder judged gone that is not,
through an identifier two machines share that the boot id does not tell apart,
or a write still in flight when the exit hook removed its lock (a window of
microseconds), can interleave with the next holder's write, and `audit verify`
reports it.

When appends keep refusing, read the refusal. Once the process it names is
gone, or no warpline process runs on any machine that shares the home, remove
`audit/.lock` by hand, and `audit/.lock.break` when the refusal names it.
Remove a break file only once no warpline process runs. One removed while its
breaker is still inside the break, a window of a few milliseconds,
lets a second breaker in, and the first breaker then removes the second one's
break file without checking whose it is. So two breaks can overlap, and one
can remove a lock a new holder has just taken. Warpline never removes a lock
or break file it cannot read as a holder, such as a directory or a plain file.

The state lock (§ 12) is always taken first. A command that holds the state
lock may append, and the store never takes the state lock, so the two are
never taken in the other order.

Each record is one write of the whole line on a file opened for append,
checked for length, followed by `datasync`. Creating a segment file also syncs
the directory. The append resolves only after both.

**A limit on macOS under Bun.** Bun's `datasync` on macOS does not issue
`F_FULLFSYNC`. A record written there survives a process or OS crash, but not
a power loss while the drive's write cache still holds it. Under Node, and on
Linux under either runtime, the call flushes. The upgrade path is
`fcntl(F_FULLFSYNC)` through `bun:ffi`. Until then this is a stated limit, not
a guarantee.

### Segments

The store is a run of segment files. Each is named by the seq of its first
line, zero-padded to 16 digits, so name order is seq order and the last name
is the active segment. No line spans two files, and the chain runs straight
across them.

Before each append the writer checks the active segment. It rotates when the
segment is 64 MiB or larger, or when 30 days have passed since the time on its
`segment.opened` line. Both are constants in the code. Neither is a preference
or an environment setting.

A rotation writes, in order:

1. `segment.sealed` as the old file's last line. Its data holds the reason,
   `size` or `age`, and the file's length in bytes before the sealed line.
2. A new file whose first line is `segment.opened`, with `warplineprev` the
   hash of the sealed line.
3. `checkpoint.recorded`, covering every line up to that `segment.opened`. Its
   data holds the home id as `origin`, the opened line's seq as `size`, and the
   opened line's hash as `root`.
4. The record being appended.

Each is its own write and `datasync`, and the directory is synced once the new
file exists.

Every `segment.opened` after the first carries forward what a reader would
otherwise have to look for in an earlier file:

- `authority`: the last audited sha256 of `preferences.json`, and of
  `principals.json` with each principal id's digest. A file never audited is
  `null`.
- `open_intents`: every `fire.intent` that no `fire.outcome`, `fire.refused`
  or `fire.resolved` has closed, by seq, plugin, run id and effect id. An
  intent stays open across as many segments as it takes to close it.

So a reader that needs the current authority digests or the open intents reads
the active segment and nothing else, and it walks only what it carries. That is
each line's type, and for `fire.intent`, `fire.outcome`, `fire.refused`,
`fire.resolved`, `preference.set`, `preferences.observed`, `principal.added`,
`principal.disabled` and `principal_registry.observed` the fields it carries:
the plugin, run id and effect id of an intent, the intent seq a closing record
names, the authority digests and the principal entries. Each is checked by its
own field rule, the one the writer uses. A principal record is folded into the
carried map in either shape: one that carries the whole map in `entries`
replaces it, and one that names a change sets that id's digest, or for
`changed_entries` removes an id whose digest is null. A principal record that
holds both shapes at once stops the walk, since no writer writes one. The `segment.opened` that opens the
active segment is held to the same rules for the authority and open intents it
carries. Every other kind, and any key a field rule does not name, is passed
over, so a record a later build writes, or a field it adds, does not stop an
older reader. A line that is not a record, a first line that is not a
`segment.opened` it can carry, or a carried field no writer would write stops
the walk, so no such value reaches a reader's output.

**A walk that stops.** `audit verify` reports `unreadable` and names the seq,
and every command that needs the walk refuses: an `advance`, `prefs set`,
`principal`, `resolve`, and any append that rotates. `advance`, `prefs set`,
`principal` and `resolve` print the same reason, which names the seq and the kind and nothing
from the line, and ends by saying to pass the line over with `warpline audit pass-over`:
`; pass it over with warpline audit pass-over (docs/runtime-spec.md § 14)`.
Verify's `open intents unreadable` line carries the same reason. A walk that
stops at the active segment's first line says no such thing, because that line
cannot be passed over (below). No warpline build writes such a line. Keep an export of the
store, then run `warpline audit pass-over <seq>...`, naming every line the walk
stops on. If another line still stops the walk, it refuses and names that one.

Pass-over edits no line. It opens a new segment after the active one as it
stands. The new segment's `segment.opened` carries forward the state reached by
a walk that skips exactly the named lines, and names each one in `passed_over`,
by its position and the sha256 of its bytes under the byte rule. Whatever a passed-over
line said is lost to the walk.
Its bytes stay where they are and `--after 0` exports them (§ Export), but the new `segment.opened` keeps only its position and sha256, so an
intent it opened is not carried and one it closed stays open. Verify checks
each entry against the segment
before it (§ Verify), so every anchor taken before or after the pass-over still
holds. A partial last line is acknowledged in `fragment` beside it, as any
rotation does. When a size or age rotation is due, it seals first and writes
that rotation's Checkpoint, as any append does. Otherwise it writes no seal and
no Checkpoint. Apart from a due rotation's seal and Checkpoint, it writes
nothing but the new `segment.opened`, as the heal of a lost successor writes
only that.

The position of a line is the seq its segment is named for, plus the lines before it in that file.
The `warplineseq` a line carries is what the line claims about its position, and
verify reports a record whose claim is not its position `tampered`.
A `segment.opened` names lines of the segment before it by position.
The walk, `resolve` and verify take a line as passed over only at that position,
and only while its bytes still hash as the entry records.
A pass-over opens the new segment at the position after the active segment's last record,
whatever seq that record claims, so a pass-over carries no claimed seq forward.
When lines that are not records end the active segment, the first of them therefore shares its position with the new segment's opening line.

It refuses with exit `1`, and writes nothing, for a seq outside the active
segment (a sealed segment's line, or past the head), a line the walk carries, a
store where another line it was not given still stops the walk, an active
segment that holds no complete line, or only a partial one (§ A torn tail), and
a home with no store, where it creates nothing. A build that predates
`passed_over` still reads the segment, because the walk strips keys it does not
carry.

The active segment's first line has its own refusal, `seq N opens the active segment and cannot be passed over`.
That line holds the state the walk starts from, and a pass-over has nothing to
carry forward without it. A walk that stops there refuses with `seq N opens the
active segment and is not a segment.opened the walk can carry`, whether the line
is a `segment.opened` this build cannot carry or not a record at all. The first
case is a line only a later build writes, so run the build that wrote it, or a
later one. A first line that is not a record has no recovery in this build.
An active segment with no complete line has no first line, and
has its own refusal and recovery (§ A torn tail).

A line that is not a record is passed over the same way. When it ends the
active segment, as a write that went wrong leaves it, the new segment opens
after the last record before it: its `segment.opened` takes the position after that record,
links to that record's hash, and names the line in `passed_over` by
its position and the sha256 of its bytes.
Verify reports `tampered` at that line until the pass-over, and no longer after it, against anchors taken before and after.
No size or age seal is written past such a line, as none is
written past a partial one. One with records after it in its segment can only
be put there by hand, and it breaks the chain where it sits, so verify keeps
reporting it `tampered` after a pass-over, which is the true account.
The pass-over still lets the walk go on past it.

**A torn tail.** A write that stops part way leaves a partial last line. The
writer never writes past it and never removes it. The next append seals
nothing, because a partial line can't be sealed past. It opens a new segment
after the last complete line, whose `segment.opened` records the fragment's
length in bytes and its sha256 as `fragment`, and then writes the record.
Every byte of the torn file stays as it was. An active segment that holds no
complete line, empty as a crash between creating it and its first write leaves,
or holding only a partial line, can't be followed, because its successor would
need the same name, and it has no opening line for the walk to start from.
Every append, pass-over and walk refuses with
`segment <name> holds no complete line; move it aside by hand (docs/runtime-spec.md § 14)`,
naming the file, and verify reports `unreadable` with that reason.
Move the file out of `audit/` by hand. It holds no record, so nothing on the
chain is lost, and the next append goes after the last line of the segment
before it.

**A lost successor.** A crash between the sealed line and the new file leaves
an active segment that ends in `segment.sealed`. The next append heals it. It
opens the successor with `segment.opened` and writes the record, and it writes
no Checkpoint.

Nothing in this runtime moves, prunes or deletes a segment. The store only
grows, and the operator archives by export.

### Before the effect

A record is written before its effect, and an effect whose record cannot be
written does not happen. The record says what was about to happen, not what
did.

`warpline deny` appends one `denial.recorded` per plugin, in the order named,
inside the state lock and before it writes the state document. The `--note`
text is the operator's own words and never enters a record. If any append
fails, `deny` writes nothing, says on stderr that nothing was denied, and exits
`1`. A record already appended for an earlier plugin in the same command stands
when a later one cannot be written: it records what was about to happen, and
the store never takes a line back.

The same rule covers every other authority change a verb makes. `warpline
approve` appends `grant.issued` before it merges a grant (§ 9), and
`content_approval.issued` or `content_approval.withdrawn` inside the state lock
before the state write (§ 10). `warpline deny --remove` appends one
`denial.lifted` per plugin before the state write. Each of these refuses with
exit `1` and nothing changed when its append fails.

`warpline revoke` is the one exception. It appends `grant.revoked` before it
removes the grant file, but a revoke only narrows authority, and a failing
store must never leave authority wider than the operator chose. So when that
append fails the file is removed anyway, and the command exits `70` with a
stderr line saying no audit record of the revoke was written.

A fire is written ahead the same way. When `warpline advance` fires a
session-class plugin that declares side effects, it appends `fire.intent`
immediately before the handler runs, and `fire.outcome` naming that intent's
seq once the handler returns, with the result's status, or `threw` when the
invocation threw. An intent that cannot be written stops the fire. A
content-class fire's intent is written by its spend mark, inside the state lock
after the re-check and before the mark (§ 10), and its outcome closes it the
same way. A refused fire gets `fire.refused` with its closed-set reason and no
intent, because nothing fired, except when the spend mark's write failed after
its intent landed: that refusal carries the intent's seq and closes it.
`warpline resolve` has its `fire.resolved` on the record before it writes
anything: appended then, or found there from a run whose state write did not
land (§ 10). Its `--intent` form writes nothing else (§ 10). A plugin with no declared side effects gets no record, and
neither does `warpline run`. An outcome or refusal that cannot be written does
not undo what already happened; the advance exits `70` (§ 11).

### Checkpoints

A `checkpoint.recorded` record anchors the chain. Its data is
`{ origin, size, root }`: `origin` is the home id, `size` the seq of the line
before it, and `root` that line's hash under the byte rule, in lowercase hex.
It covers every line up to and including that one, and nothing after.

Every `warpline advance` that returns writes exactly one, quiet hours included,
immediately before the dead-man file (§ 13). Three advances add three. A
rotation writes one after the new segment's `segment.opened` (§ Segments), so
an advance that rotates the store writes two. An advance refused before the run
lock, by an invalid `preferences.json` or an unreadable plugin root, writes
none and adds no byte to the store. Neither does an advance that throws after
the lock. `warpline audit export`, `audit head` and every other reader write
none.

It is shaped like a C2SP tlog checkpoint and is not one. There is
no Merkle tree, so `size` counts records in a linear chain and `root` is the hash
of the last one, not a tree root. There is no signature either. A witness tool or a
C2SP verifier cannot check it. What it gives you is a head to export and keep
off the box, inside the record itself, at the cadence of your scheduler.

### The audit object in `advance --json`

`warpline advance --json` carries `audit` on every advance that returns, gated,
failing and quiet-hours ones included. It is the Checkpoint append's own return
value, computed in the same hold of the audit lock that wrote the Checkpoint,
and passed through unchanged:

| Field | Meaning |
|-------|---------|
| `seq` | The head seq, which is the Checkpoint's own seq. |
| `bytes` | The summed size of every segment file, in bytes. Null when the Checkpoint landed but the store could not be read back after it. |
| `segments` | How many segment files the store holds. Null when the Checkpoint landed but the store could not be read back after it. |
| `checkpoint_seq` | The Checkpoint's seq. |
| `indeterminate` | Every `fire.intent` no `fire.outcome`, `fire.refused` or `fire.resolved` has closed, in seq order, each `{ seq, plugin, run_id, effect_id }`. `effect_id` is null for a session-class fire. Null, never `[]`, when the Checkpoint landed but the store could not be read back after it. |

An intent is indeterminate when the process died between it and its outcome,
or when its outcome could not be written (§ 11). The fire may or may not have
happened, and the store cannot say which. It is surfaced and never held: the
plugin fires again when it is next due, and the advance's exit code does not
change on its account. Once you have checked whether the effect happened,
answer it with `warpline resolve --intent <seq> --shipped` or `--not-shipped`,
which closes it, and the next advance no longer lists it. A content fire still
marked and unconfirmed is answered with `warpline resolve <plugin> --shipped
<effect-id>` or `--not-shipped <effect-id>`, which closes its intent too, and
the by-seq form refuses it (§ 10).

`audit` is `null` only when the Checkpoint could not be written. Its three
read-back fields, `bytes`, `segments` and `indeterminate`, are `null` when the
Checkpoint was written but the store could not be read back after it, and `seq`
and `checkpoint_seq` still name the Checkpoint. Either way the advance exits
`70` (§ 11). The object holds integers and identifiers only. The
dead-man file does not carry it.

### Export

`warpline audit export --after <seq>` starts at the last segment whose name is at or below that seq plus one.
From there it prints, segment by segment in name order, every complete line whose position is after that seq, with its bytes unchanged, a record as one CloudEvents structured-mode object per line.
One object per line is warpline's own
convention (§ Record format). Checkpoints are records, so they travel with the
stream.
`--after` takes `0` or a positive integer up to 9007199254740991, nothing else: `-1`, `01`, `1e3`, a larger integer and a missing `--after` are usage errors with exit `1`.
`--after 0` prints every complete line in the store, and on a store with no partial line its output equals the segment files concatenated in name order, byte for byte.
At the head it prints nothing and exits `0`.
Past the head it prints nothing, names the head on stderr as `beyond head`, and exits `1`.

What this section says export prints, and what `audit head` prints (§ Genesis and the head), is promised only on a store `audit verify` reports `clean`, `torn` or `unreadable`.
On a tampered store verify's verdict is the true account, and export still prints only complete lines, segment by segment in name order.

Export prints a line that is not a record, passed over at the end of a segment, exactly when `--after` is below the position of the last record before it, as `--after 0` is.

When the active segment's last complete line is not a record, there is no head
to hold `--after` against.
Export prints by the rule above, that line included, and exits `0`,
so an export can be kept before a pass-over.

A partial line is never exported.
When a `segment.opened` follows it, that line records its length and digest (§ Segments), and stands in for it.

Export reads only. It takes no lock, writes no Checkpoint and adds no byte to
the store. It reads each segment a chunk at a time and waits for the reader
before it writes more, so a 64 MiB segment is never held in memory. A reader
that goes away (`| head`) ends it quietly with exit `0`. The store is archived
this way, by export, and never moved.

### Verify

`warpline audit verify --checkpoint <file|->` checks the store against a head
you kept off the box.
The store is tamper-evident relative to the last exported Checkpoint, and this
is the check that makes it so. The anchor is read from the file, or from stdin
with `-`, up to 64 KiB, in either form:

- `<seq> <hex>` on one line, as `audit head` prints it, seq up to 9007199254740991.
- The note body `audit head --c2sp` prints: origin, size up to 9007199254740991 and base64 root, read
  up to the first empty line.

There is no unanchored check. Without `--checkpoint`, or with an anchor that is
neither form, verify is a usage error with exit `1`. A check with nothing to
compare against would read as fine when it could not look.

| Verdict | Exit | Meaning |
|---------|------|---------|
| `clean` | `0` | Every record links to the previous record's hash (64 `0`s for the first record). The record at the anchored seq hashes to the anchor, or the anchor is `0` with 64 `0`s. |
| `torn` | `3` | As clean, except the store ends in a partial line, keeps a partial line that a later `segment.opened` acknowledges, or its last segment ends in `segment.sealed` with no successor. A crash leaves these. |
| `tampered` | `4` | A complete line does not parse, other than the last complete lines of a segment that the next `segment.opened` names in `passed_over` by position (a next segment that holds no record names nothing), a record's `warplineseq` is not its position, its `warplineprev` is not the previous record's hash (64 `0`s for the first record), a segment is not named by its first seq, a partial line anywhere but the very end goes unacknowledged, a `segment.opened` has a `passed_over` that names a position not in the segment before it or a line that does not hash as recorded, the anchored seq is beyond the head, or the record at the anchored seq does not hash to the anchor. |
| `wrong log` | `5` | The anchor's origin is another home's id. |
| `unreadable` | `6` | The chain checks clean or torn, but the active segment holds a line the walk cannot carry (§ 14 Segments), or no complete line at all, as a crash between creating a segment and its first write leaves, so the open intents cannot be listed. The reason names its seq, or, for an active segment with no complete line, names the file and says to move it aside by hand (§ 14 Segments). |

When more than one applies, wrong log wins, then tampered, then unreadable,
then torn. None of the codes is `70`, `75` or `130`.

A writer that can write the home can edit, reorder, insert or drop lines and
re-link every `warplineprev` behind them, and every link then checks. Only the
anchor catches that: the line at its seq no longer hashes to it, or the seq is
gone.

Verify prints `verdict`, the anchor, the head when there is one, how stale the anchor is, a
`reason` naming a seq or a file and the rule it broke when the verdict is not
clean, and one `open intent` line per fire intent nothing has closed, each with
its seq, plugin and run id. When the open intents cannot be read, it prints one
`open intents unreadable` line naming why in their place, under any verdict,
and never an empty list.
Staleness is the seq of the last record minus the anchored seq in records,
and the time since the anchored record's `time` in seconds, the second
only once that record's hash has matched. An anchor at the head is `0 records`
stale. Verify never prints a record's data or the anchor file's text.

Verify reads only. It takes no lock, writes no Checkpoint and adds no byte to
the store.

## 15. The principal registry

`<home>/principals.json` names who may act. It is owner-only: mode `0600`
after every write, a file that was looser beforehand included. A missing file
is an empty registry.

```json
{
  "principals": [
    { "id": "ops", "type": "human", "status": "active" },
    { "id": "ci-bot", "type": "machine", "status": "disabled", "key": "ssh-ed25519 AAAA..." }
  ]
}
```

| Field | Value |
|-------|-------|
| `id` | 1 to 64 characters of `a-z`, `0-9`, `.`, `_` and `-`, starting with a letter or digit. Unique in the file. |
| `type` | `human` or `machine`. |
| `status` | `active` or `disabled`. |
| `key` | Optional. One key, 1 to 8192 characters with no control character. Stored here and nowhere else. |

The file has one writer, `warpline principal`:

- `warpline principal add <id> --type human|machine [--key <key>]` adds an
  active entry at the end of the file.
- `warpline principal disable <id>` sets an active entry's status to
  `disabled`.
- `warpline principal list` prints one tab-separated line per entry, in file
  order: the id, the type, the status, and `key` or `no key`. It never prints
  the key. With no file it prints nothing and exits `0`.

Each add appends `principal.added`, and each disable `principal.disabled`, to
the audit store (§ 14) before the file changes. The record carries the id, the
sha256 of the exact bytes about to be written, and `entry_sha256`, the sha256
of that one entry as it will be written (`id`, `type`, `status`, then `key`
when set, as JSON in that order). `principal.added` also carries the type and
`key_sha256`, the key's sha256 or null. The key itself is never on the record.
No record names the other entries, so no record grows with the registry, and
there is no limit on how many principals it holds. The whole map of id to
entry digest rides each `segment.opened` instead (§ 14 Segments). When the append
fails, nothing is written and the verb exits `1`. An add or a disable reads the
file, checks it, records the change and writes it under the state lock (§ 10),
so two adds of one id at once register it once, and two adds of different ids
keep both.

Ids are never deleted or reused. Disable is the only way out of the registry.
Adding an id that is already in the file, active or disabled, is refused with
exit `1` and no record, and so is disabling an entry that is already disabled or
an id that is not there. No principal is ever inferred from the account running
the command. An id comes from the operator's argument and from nowhere else, and
`add` with no id is a usage error.

The file may still be edited by hand. Every read by `warpline principal`
compares its bytes with the last digest the store holds, before the verb acts on
what it read, and a difference is recorded as `principal_registry.observed`
naming the ids whose entry digests changed (§ 14). When that record cannot be
written the verb refuses with exit `1`. That record must fit in one 16384-byte
line, and it names every changed id twice, so one edit can change at most 78
entries with 64-character ids, more with shorter ones. An edit that changes
more at once is refused by every `warpline principal` verb with a sentence
saying it is more than one audit record can name, and nothing is written. To
record it, put part of the change back, run `warpline principal list`, then
make the rest. A file that will not parse, or that
fails the schema, is refused with a message naming key paths and schema facts,
never a value from the file.
