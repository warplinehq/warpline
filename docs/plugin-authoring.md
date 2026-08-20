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
import { PluginManifestSchema } from 'warpline/schemas/plugin-manifest'

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

**Nothing else belongs at the top level.** Importing this file *runs* it, and
that import happens during `warpline plan` — before any approval gate is
consulted. The imports and the `manifest` export are the whole file. See
[Runtime constraints](#runtime-constraints) §3.

**Declare every side effect.** The gate is only as honest as the declaration.
If your handler calls out to any external system — even read-only HTTP —
declare `external_api`. Undeclared side effects are the one unforgivable
plugin bug: they bypass the entire human-approval model.

### handler.ts

```typescript
import type { PluginManifest } from 'warpline/schemas/plugin-manifest'
import type { SkillResult } from 'warpline/schemas/skill-result'
import { manifest } from './manifest.ts'   // .ts, not .js — see Runtime constraints

export async function handler(
  _manifest: PluginManifest,
  _args: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<SkillResult> {
  // 1. Validate args — return a failed SkillResult with parse_error, don't throw
  // 2. Do the work. Forward `signal` to fetch()/spawn() so timeouts can cancel I/O
  // 3. Return a SkillResult
  return {
    status: 'success',           // success | partial | failed | skipped
    phases_completed: [manifest.name],
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

## Runtime constraints

Your manifest and handler are TypeScript that warpline imports **at runtime**.
Under Node that means [type stripping](https://nodejs.org/api/typescript.html):
Node erases the types and runs what is left — it does not compile. Three
consequences bind every plugin. Bun hides all three, so a green Bun-only test
run is not proof that your plugin loads.

### 1. Erasable syntax only

Syntax that would require Node to *generate* code is refused rather than
compiled. `enum`, a `namespace` containing runtime code, constructor parameter
properties (`constructor(private x: number)`), and `import x = require(...)`
aliases all throw:

```
ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX
```

Use a `const` object or a union type instead of `enum`, a plain module instead
of `namespace`, and ordinary field assignments instead of parameter properties.
`import type` and inline `type` modifiers erase cleanly and are fine.

A **different** error — do not conflate the two while debugging — means the
file is in the wrong place rather than the wrong shape:

```
ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING
```

Node refuses to strip types for any file under a `node_modules` directory, with
no opt-out flag. Keep plugins in `<home>/plugins/`, never inside an installed
package.

Warpline's own `tsconfig.json` sets `erasableSyntaxOnly: true`, which is the
compile-time half of this rule. Set it in your plugin project too and the
compiler tells you before Node does.

### 2. Relative specifiers need an explicit extension — and it is `.ts`

Node resolves the literal specifier with no remapping, so a handler importing
its sibling manifest must spell the extension, and it must be the extension of
the file that actually exists:

```typescript
import { manifest } from './manifest.ts'   // correct
import { manifest } from './manifest.js'   // ERR_MODULE_NOT_FOUND under Node
```

`warpline scaffold` generates the `.ts` form. The `.js` convention throughout
warpline's own `src/` is correct *there* and wrong here: that code is compiled
before it runs, yours is not. Bun remaps `.js` → `.ts` silently, which is
precisely why this defect survives a green Bun suite.

Bare `warpline/...` specifiers are the exception — they carry no extension and
resolve through the package's `exports` map. `warpline scaffold` also creates
`<home>/node_modules/warpline` as a symlink, which is what lets those
specifiers resolve from a plugin directory that sits outside any package.

### 3. Importing a manifest executes its module top level

This is how the engine reads a manifest and it is not going to change: a
dynamic `import()` runs the module. So a manifest must be **declarative** — the
imports and the manifest export, nothing else.

Concretely: code at a manifest's top level runs during `warpline plan`, before
any approval gate is consulted. `plan` reads and reports; a manifest that
writes a file or calls an API at import time breaks that guarantee on your
behalf, unapproved. Every side effect belongs in the handler, where the gate
can see it.

`src/cli/__tests__/manifest-declarative.test.ts` enforces this mechanically for
every shipped example manifest and for the text `warpline scaffold` generates.

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
