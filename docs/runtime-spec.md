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
validated against `PluginManifestSchema` in `<home>/schemas/plugin-manifest.ts`.
adds three fields; everything else is pre-121.

```typescript
PluginManifestSchema = z.object({
  // ...existing fields (name, version, description, inputs, outputs,
  //   capabilities, schedule, autonomy_level, side_effects, ttl_hours,
  //   dependencies, max_parallelism, min_tier)...

  /** Per-attempt time budget in ms. */
  timeout_ms: z.number().int().positive().default(60_000),

  /** Maximum retry count on retryable failures. Bounded to prevent
   *  runaway retry loops. Total attempts = 1 + max_retries. */
  max_retries: z.number().int().min(0).max(10).default(1),

  /** Base delay in ms between retries. Actual delay uses exponential
   *  backoff with +/- 25% jitter, capped at 30s. */
  retry_delay_ms: z.number().int().min(0).max(60_000).default(2000),

  /** Optional action registry. Only surfaces in UI hosts when
   *  non-empty. Zero existing plugins declare it. */
  actions: z.record(z.string(), z.object({
    description: z.string(),
    is_default: z.boolean().optional(),
  })).optional(),
})
```

Defaults preserve pre-121 behaviour for all 22 existing plugins (zero drift
required to land the phase).

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

Timeout vs. retry interaction (D-12 / D-13):

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
- Shared helpers that accept signals: `posthogFetch`, `hogqlQuery`,
  `createExperiment` (all added in ).
- Graphify bridge: signal listener calls `child.kill('SIGTERM')` on abort.

Handlers without real I/O (pure compute, LLM stubs) may ignore the signal.
The runtime wraps each handler call in a `Promise.race` against a
signal-aborted fallback so ignorant handlers still honour the timeout /
cancel clock. This is documented as residual DoS (D-31) and accepted.

External abort sources:

1. An external `controller.abort()` from a host (e.g. a dashboard cancel button).
2. `SIGINT` to the CLI entry (`scripts/run-plugin.ts`) - propagated as an
   `AbortError` via the same controller.
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
runs are left alone (D-27); a one-shot cleanup is tracked as deferred work.

## 7. HTTP / SSE surface (not in this repo)

The source system exposes the runtime over HTTP + SSE from a local web
dashboard (run trigger, live attempt events, cancel via DELETE). The dashboard
was not extracted — it is a candidate for a later release. The runtime's
contract is API-first regardless: `invokePlugin()` accepts an external
`AbortController` and emits attempt events, so any host (CLI, dashboard,
another process) gets identical semantics.

## 8. Test Patterns

Per `CLAUDE.md` "bun:test gotchas", fixtures and mocks for plugin runtime
tests follow two rules:

1. NEVER use `mock.module` for plugin registry / engine / invokePlugin
   overrides. It is process-global and leaks across test files. A mock
   established in file A will silently apply to unrelated files B, C,
   D in the same `bun test` run.
2. Use `spyOn(obj, 'method')` with describe-level `beforeEach` / `afterEach`
   to set up / tear down mocks. Per-test `spyOn` + `mockRestore()` has
   leaked between tests in the same describe block (see Phase 116
   LEARNINGS).

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

Fixture plugins live under `<home>/test-utils/fixture-plugins/`:

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

**Path:** `<warplineHome>/.session-approval`, where `<warplineHome>` resolves
per `src/lib/paths.ts` — `WARPLINE_HOME` if set, else the nearest ancestor
directory containing a `.warpline/`, else `<cwd>/.warpline`.

### Shape

```json
{
  "granted_at": "2026-08-20T12:00:00.000Z",
  "first_granted_at": "2026-08-20T09:30:00.000Z",
  "expires_at": "2026-08-20T13:30:00.000Z",
  "scopes": ["render-issue", "outreach-generator"]
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
| `--replace` | Overwrites the scope list and resets `expires_at`; `first_granted_at` is preserved. |
| Expired grant | Not merged onto. The window has closed; the next grant restarts it, with a new `first_granted_at`. |
| Default TTL | 4 hours. |
| `--all` | The only path to `"*"`. No positional name is ever treated as a wildcard. It prints the number of side-effecting plugins and the total number of declared side effects it covers before granting. |

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
