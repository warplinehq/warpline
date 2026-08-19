# Writing a warpline plugin

## Before you write anything

Read [doctrine.md](doctrine.md). Then answer one question honestly:
**could this be a pure function over fetched data?** If yes, it is a
deterministic plugin. If part of it needs judgment, split it — deterministic
plugin + `[needs-llm]` handoff ([needs-llm-contract.md](needs-llm-contract.md)).
"A plugin that calls a model to format data" is a defect, not a plugin.

## Anatomy

```
<home>/plugins/my-plugin/
  manifest.ts
  handler.ts
```

### manifest.ts

```typescript
import { PluginManifestSchema } from '<warpline>/src/schemas/plugin-manifest'  // scaffold resolves this absolutely

export const manifest = PluginManifestSchema.parse({
  name: 'my-plugin',            // must equal the directory name
  version: '1.0.0',
  description: 'One line, present tense, says what it checks or produces',
  autonomy_level: 'autonomous', // autonomous | supervised | manual
  side_effects: [],             // sends_email | creates_issue | writes_db | external_api | modifies_file
  ttl_hours: 6,                 // engine skips re-runs while the last success is fresher than this
  schedule: 'on_run',           // on_run | daily | weekly | manual
  timeout_ms: 30_000,           // per-attempt budget; a timeout is fatal, never retried
  max_retries: 1,               // retries fire only on retryable:true failures
  inputs: { /* declared args */ },
  outputs: { /* declared outputs */ },
})
```

`PluginManifestSchema.parse()` at import time is deliberate: an invalid
manifest is a hard-stop. Never `safeParse` here — a misconfigured plugin must
not silently run.

**Declare every side effect.** The gate is only as honest as the declaration.
If your handler calls out to any external system — even read-only HTTP —
declare `external_api`. Undeclared side effects are the one unforgivable
plugin bug: they bypass the entire human-approval model.

### handler.ts

```typescript
import type { HandlerFn } from '<warpline>/src/runtime/invoke-plugin'  // scaffold resolves this absolutely

export const handler: HandlerFn = async (manifest, args, signal) => {
  // 1. Validate args — return a failed SkillResult with parse_error, don't throw
  // 2. Do the work. Forward `signal` to fetch()/spawn() so timeouts can cancel I/O
  // 3. Return a SkillResult
  return {
    status: 'success',           // success | partial | failed | skipped
    phases_completed: ['my-plugin'],
    phases_failed: [],
    errors: [],                  // makeSkillError(code, message, { impact, retryable })
    data_freshness: { source: new Date().toISOString() },
    summary: 'one line a human reads on the board',
    artifacts_produced: [],
    schema_version: 1,
  }
}
```

Rules the runtime holds you to:

- **Return failures, don't throw.** A thrown error becomes a failed run with
  no structure. A returned `failed` result with a typed error keeps
  retryability and impact machine-readable.
- **`retryable: true` means it** — the runtime will re-invoke you with backoff.
  Only mark transient faults (rate limits, 5xx) retryable.
- **Forward the `AbortSignal`.** Handlers that ignore it still get cut off by
  the runtime's `Promise.race`, but orphaned I/O keeps running — a residual
  DoS you should not add to.
- **Judgment work exits via `[needs-llm]`**, not via an API call: return
  `status: 'skipped'` with a `[needs-llm] ...` summary. The runtime records it
  as `delegated` and never retries it.

## Testing

Follow the example plugins: export the pure decision logic (the filter, the
parser, the summariser) as named functions and unit-test those directly with
`bun test`. Integration-test through `invokePlugin('name', args, { pluginsDir })`
pointing at a fixture directory — never at your live home. The repo's test
preload re-roots `WARPLINE_HOME` to a temp dir as a backstop, but explicit
fixture paths are the pattern.

Run everything: `bun test --timeout 20000` (the timeout flag matters — bun's
5s default flakes under CPU contention and `bunfig [test] timeout` is
silently ignored).

## Checklist before you ship one

- [ ] Could any part be a pure function it isn't? (doctrine review)
- [ ] Every external touch declared in `side_effects`?
- [ ] Args validated, failures returned as typed errors?
- [ ] `signal` forwarded to real I/O?
- [ ] Decision logic exported and unit-tested?
- [ ] `ttl_hours` set to how stale is genuinely acceptable, not a guess?
