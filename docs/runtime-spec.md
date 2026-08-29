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

Every plugin under `<home>/plugins/<name>/manifest.ts` exports a value
validated against `PluginManifestSchema`, imported from
`warpline/schemas/plugin-manifest`.

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
| `side_effects` | (`sends_email` \| `creates_issue` \| `writes_db` \| `external_api` \| `modifies_file`)[] | no | `[]` |
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
survives, and run logs are pruned when their mtime is older than 30 days.

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

Adding a field is already safe by construction, for the reason stated
immediately above — every field with a default is optional in a manifest file,
so a new one cannot invalidate a manifest that already validates. An older build
reading a manifest written for a newer one ignores what it does not know.

Removing or narrowing something is the case that can break you, and what limits
it is a convention that already exists rather than a promise invented here:
closed enums stay closed. Four sets are closed — the side-effect type, the
autonomy level, the schedule and the minimum tier — and an addition to any of
them fans out into exhaustive switches and into this document, which is why they
are not extended casually.

Pin the version you tested against, and read the release notes for the version
you move to. The release notes are the record of what changed between two
versions; nothing else here claims to be.

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

`delegated` (2026-08-19): a `[needs-llm]` handoff is a successful dispatch to a
companion LLM skill, not a failure. `deriveRunStatus()` in `invoke-plugin.ts` is
the single mapping shared by the persisted run artifact, any live run bus,
and the board event (severity `info`). A plain `skipped` without the prefix still
maps to `failed` — widen deliberately if a persisted-run path ever produces one.

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
) => Promise<SkillResult>
```

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

## 5. Run Artifact Shape

Each run writes two sibling files under `<home>/runs/`:

- `<run_id>.json` - structured summary.
- `<run_id>.log` - captured stdout + stderr, with `=== Attempt N ===`
  delimiters between retries.

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
  "retried": true,
  "plugin_entries": []
}
```

Log file:

```
=== Attempt 1 ===
<captured stdout + stderr for attempt 1>
=== Attempt 2 ===
<captured stdout + stderr for attempt 2>
```

Cancelled runs persist with `status: 'cancelled'` and partial attempts; the
log captures whatever the handler emitted before abort.

### Plugin entry status

Each entry in `plugin_entries` records how one plugin ended in that run. The
set is closed — an unlisted value fails validation rather than being dropped.

| Status | Meaning |
|--------|---------|
| `completed` | The handler ran and returned a result the engine accepted |
| `failed` | The handler threw, or returned a failed result |
| `skipped` | The plugin was not due — fresh, filtered, locked, or without a session Grant |
| `gated` | Supervised: the handler ran and its result was parked pending a human answer |
| `denied` | A human answered no, and the answer still applies to what is being proposed |

`gated` and `denied` are the two outcomes of supervision, which is why they sit
together and apart from `skipped`. A denial recorded as `skipped` would land in
the same bucket as "no Grant" and "still fresh", and the log could no longer
tell an unanswered question from an answered one.

Adding a member fans out into this table and into every run log written
afterwards, so the set is not extended casually.

### Output records

`SkillResult.artifacts_produced` is an array of Output records — a thing the
plugin produced that an operator will read and take away. `SkillResult.schema_version`
defaults to `2` to mark the change.

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

## 6. Retention

Last 20 artifacts per plugin. On every invocation that completes with
`persistArtifact: true`, `trimPluginHistory(pluginName, 20)` runs after the
terminal write. It reads every `<run_id>.json` in the runs directory,
filters by plugin, sorts by `started_at` DESC, and deletes both the JSON
and its `.log` sibling for anything past the 20 newest. Deletion is atomic
per-run (the JSON and log are unlinked together) so no orphaned `.log` files
accumulate.

Applies to NEW runs only. The 51 pre-existing artifacts from pre-121 engine
runs are left alone; a one-shot cleanup is tracked as deferred work.

### The other deletion path

The 20-newest trim is not the only thing that deletes out of `<home>/runs/`,
and reading this section as though it were will mislead you about what survives.

`trimPluginHistory` runs only under `persistArtifact: true`. The manual path,
`warpline run`, passes it. **An engine advance does not, deliberately** — an
advance writes a `RunLog` rather than a per-plugin `RunArtifact`, so the
20-newest trim never sees an advance's output at all.

What deletes an advance's run log is `pruneRunLogs`, and its rule is different:
any `<run_id>.json` in the runs directory whose **mtime is older than 30 days**,
regardless of plugin or count. That is the retention bound anything holding a
`run_id` is subject to — a versioned Output's history, and a `last_output`
pointer both.

The two also differ in what they leave behind. The 20-newest trim unlinks the
JSON and its `.log` sibling together. `pruneRunLogs` unlinks the JSON only, so
a pruned run can strand its own transcript.

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
`{ manifests: Map<string, PluginManifest>, failures: LoadFailure[] }`. A plugin
directory whose `manifest.ts` cannot be imported is absent from `manifests` and
present in `failures` as `{ plugin, error }`, where `plugin` is the directory
name (a broken manifest has no trustworthy `name` field) and `error` is the
thrown `Error.message` — no stack trace. A directory whose name is a member of
`Object.prototype` fails the same way, without being imported at all. `failures` is sorted by `plugin` inside
the loader, so alphabetical ordering is a property of the data rather than of
whichever surface renders it, and it is always an array: an all-valid directory
and a missing directory both yield `[]`. A mock that returns a bare `Map` no
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
| `first_granted_at` | ISO 8601 string    | When the FIRST grant in this window was written — the anchor for the 24-hour ceiling below. Optional on read, always written. |
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

The two clocks stay separate for that reason. The 24-hour ceiling below bounds
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

### Merge semantics (`warpline approve`)

Grants are **additive by default.** An operator typing `approve b` after
`approve a` means "and b", not "instead of a" — losing an earlier grant to a
later one is the failure this behaviour exists to prevent.

| Rule | Behaviour |
|------|-----------|
| Scopes | Unioned with the live grant and written sorted. A `"*"` on either side absorbs the other. |
| `expires_at` | **Preserved** from the live grant. An explicit `--ttl` may extend it, never shorten it. |
| Ceiling | `expires_at` is capped at `first_granted_at + 24h`. A capped grant reports the cap on stdout. |
| `--long` | Permits an expiry past the ceiling, and prints that it did. |
| Prior `--long` grant | The ceiling never shortens time already held. `mergeGrant` caps at `max(first_granted_at + 24h, live expires_at)`, so a window opened by an earlier `--long` survives every later plain `approve` unchanged, and `capped` is false. Revoke to close it early. |
| `--replace` | Overwrites the scope list and resets `expires_at`; `first_granted_at` is preserved. |
| Expired grant | Not merged onto. The window has closed; the next grant restarts it, with a new `first_granted_at`. |
| Default TTL | 4 hours. |
| `--all` | The only path to `"*"`. No positional name is ever treated as a wildcard. It prints the number of side-effecting plugins and the total number of declared side effects it covers before granting. |
| Concurrent approve | The file is not locked, and the outcome is last-write-wins: each invocation reads the live grant, merges in memory and writes the whole result, so of two overlapping invocations the later write wins outright and the earlier one's scopes are lost. |
| Zero duration | Rejected before anything is written. `--ttl` takes a positive integer followed by `m`, `h` or `d`; a bare `0` fails the grammar and `0h` fails the positive-value check. The command exits 1 and the file is untouched. |
| Empty scope list | Reachable only from the library path, which writes an empty `scopes` array. It approves nothing — an empty list is not a synonym for `"*"`. The command cannot produce one: `approve` with no plugin name and no `--all` prints usage and exits 1. |

The 24-hour ceiling belongs to the merge path, not to the file. `mergeGrant`,
behind `warpline approve`, is the only code that computes it; `grantApproval`,
the programmatic pre-grant, writes the lifetime it was handed with no ceiling
logic in it at all. An embedder calling the library directly can therefore hold
a grant well past 24 hours, and a grant file's expiry is not evidence that any
ceiling was ever applied. Read "capped at 24h" as a property of the command,
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

### `schema_version`

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

The status set is closed. Adding a member fans out into this document, and
into every operator state file written afterwards, which is why it is not
extended casually.

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
   marker lived — up to 24 hours — so an operator whose Grant expired after an
   apply saw the plugin skipped as `unapproved` on every advance and could not
   renew by name, with only the far wider `--all` still working.

   The gate is marked rather than deleted so the note has a run to name and so
   `deny` can tell an accepted result from a pending one. **An applied gate
   survives the next advance**: the marker lives inside `pending_gates`, and
   overwriting the array wholesale destroyed it. An applied marker is dropped
   when it passes the 24-hour gate ceiling, or when the plugin gates again and
   the new parked gate supersedes it.
2. **A dependency moved** — some dependency's `plugin_runs.last_run_at` is newer
   than `run_started_at`. The parked result was computed against inputs that
   have since changed, so it is refused, the gate is discarded, and a `notice`
   naming the plugin is written.
3. **Expired** — the gate is older than the earlier of the plugin's `ttl_hours`
   and 24 hours, measured from `run_completed_at`. Refused and discarded, with a
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

**A denial that was live at the moment of the refusal is re-fingerprinted, not
stranded.** The fingerprint is read out of `plugin_runs[plugin].last_output`, so
deleting the entry moves it, and a denial recorded against the parked result
would stop matching — the plugin would be due again and re-fire the side effects
the operator said no to, silently, since the superseded-denial note only rides
the unapproved arm. So the fingerprint is measured before the delete and, if it
still matched, recomputed after it. The denial then answers the plugin's
Output-less proposal: it is denied by name until the operator takes it back.
A denial that was already stale is left alone — re-stamping it would revive an
answer to a proposal that no longer exists.

The handler is never re-invoked. Its declared side effects fired at invocation,
long before the supervision gate saw the result, so re-running would double
effects that already happened. Downstream dependents run on the next advance
under the normal guard chain, not from inside the CLI command.

#### Granting a plugin that is denied

Step 0 above refuses an *apply* on a live denial. The **Grant** path narrates
one instead of refusing it: pre-staging a Grant for when the proposal moves is a
legitimate gesture, so `approve` writes the grant, exits 0, and says that the
plugin will still be skipped as `denied` on the next advance because the denial
check in `evaluatePlugin` sits *before* the approval gate. The note names the
denial's timestamp and gives `warpline deny --remove <plugin>`. Silence here
told the operator, with exit 0 and no qualification, that they had approved
something that would not run, and widened side-effect authority for nothing.
A superseded denial is not narrated — it is already stale everywhere else.

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
produced. It is recomputed on every advance and compared: while it matches, the
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
ones in a parked gate. `pending_gates` is overwritten on every advance and only
an applied gate survives it, so an unapplied gate does not outlive the advance
that follows it, and a fingerprint drawing on one would change a day later and
re-raise an answered question for a reason the operator could not see. The narrowing that buys: `last_output` is the last Output of the
run, so a change confined to an earlier Output of a multi-Output result does not
re-raise.

A plugin with no declared side effects and no recorded Output hashes the empty
sets. That is a stable value scoped by its name — it is denied by name — not an
error.

### `last_output`

A pointer to the most recent Output a plugin produced, so a reader can name it
without scanning the runs directory. It is the Output record shape from § 5,
reused rather than restated — a second shape would be a second thing that could
disagree with the first.

It is written wherever `plugin_runs` is written, which is both the autonomous
completion and the supervised park. A gated run produced its Outputs before the
gate ever saw them, so it carries a pointer like any other run.

**Absent, not null.** A run that produced no Output writes no `last_output` key
at all — not `null`, not `{}`. Reading a missing key is unambiguous; reading an
empty object means guessing whether the run produced nothing or the writer
failed.

The pointer may dangle. Its `run_id` names a run log, and run logs are pruned at
30 days by mtime (§ 6), so a pointer can outlive the run it names. That resolves
to "run no longer retained" rather than an error, and nothing deletes the
pointer to avoid the case — the pointer is the only remaining record that the
Output existed.
