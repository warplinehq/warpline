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
invalidates an existing plugin. `ttl_hours` must be positive — zero or negative
would disable caching rather than mean "always fresh". `max_retries` is capped
at 10 and `retry_delay_ms` at 60s; the backoff that uses them is described in
§2. `actions` is an optional registry that only surfaces in a host UI when
non-empty.

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
thrown `Error.message` — no stack trace. `failures` is sorted by `plugin` inside
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
