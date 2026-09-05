---
title: Writing a warpline plugin
diataxis: how-to
---

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

Typing that function is optional, and `import type { HandlerFn } from 'warpline'`
is how you do it if you want the compiler to check the signature for you. Its
return type is `SkillResultInput` rather than the `SkillResult` above — the
schema's input side, where defaulted fields are optional and a bare path string
is allowed in `artifacts_produced`. Annotating with `SkillResult`, as this
example does, still satisfies it.

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

### Where args come from

Your handler receives `args`. Your manifest declares `inputs`. This is the
channel between them, and it is the one part of a plugin that lives outside the
plugin directory: an operator configures one plugin by writing one file under
the warpline home.

```
<home>/config/<plugin>.json
```

A flat JSON object of input names to values:

```json
{ "repo": "oven-sh/bun" }
```

One file per plugin rather than one document for all of them, so a single bad
edit fails a single plugin instead of every plugin in the same advance.

**Warpline reads that file and never writes it.** There is no `warpline config
set` command today, so nothing in the runtime can make your edit atomic on your
behalf — that part is the operator's own responsibility. Write a temporary file
in the same directory and rename it over the target. A rename within one
filesystem is atomic, so an advance that reads the file mid-edit sees the old
contents rather than half the new ones; editing the target in place hands a
concurrent run a torn document instead.

Three tiers resolve every declared input, lowest precedence first:

| Tier | Source | Beats |
|---|---|---|
| 1 (lowest) | `inputs[].default` in your manifest | — |
| 2 | `<home>/config/<plugin>.json` | the declared default |
| 3 (highest) | per-invocation arguments | both |

The merge happens inside the runtime before your handler is called, so by the
time you hold `args` it is already done. § 1 of
[runtime-spec.md](runtime-spec.md) is the contract; this section is how to
write against it.

The bundled `github-poll` example is the worked case. Its manifest declares
`repo` as required *and* gives it a default, which is not the contradiction it
looks like: the default satisfies the requirement at tier 1. There is no
first-run setup step and no configuration wizard, so a fresh install has
nothing at tier 2 — a declared default is the only place a value can come from,
and without one the example would fail on every advance. An operator retargets
it by writing the file above. Declare a default for every input that has a
sensible one.

**A missing file is not an error.** It resolves to an empty config and every
input falls through to its declared default. A file that exists but is
unparseable, or leaves a required input with no value anywhere, or holds a
value of the wrong declared type, is a single `parse_error`: the run fails once
and is never retried, because a config an operator mistyped reads the same way
on the second attempt. The message names the file path and the offending input
key.

**Never put a resolved config value into a `SkillResult`.** Not in an error
message, not in a `summary`, not in anything that reaches a run log — a config
file is where an operator keeps an API token, and a run log is a file people
paste into issues. Name the key and the shape you expected instead:

```typescript
// good: names the key and the shape, and could be read aloud in public
"input 'repo' must be a string in owner/name form, e.g. oven-sh/bun"
// bad: the run log now holds whatever the operator configured
'invalid repo: ' + args.repo
```

Omit the value; do not mask it. A masking heuristic is a list of things that
look like secrets, and it leaks the first one it fails to recognise.

**Two exceptions, each one field wide.** The first: a `[needs-llm]` handoff summary
names a payload PATH after `Context:`, because
[needs-llm-contract.md](needs-llm-contract.md) defines that field as a path the
scanner resolves and reads — a key name there would leave the scanner nothing to
open, and the handoff would stop being consumable at all. A plugin that resolves
its payload path from a declared input therefore writes that input's value into
the run log by design. The bound comes from the same contract: the scanner only
reads paths that resolve inside the warpline home, so an input used this way
must name a payload file under the home, and must never be an input that carries
a secret. The bundled `feed-triage` is the worked case. Its other two summaries
name the key like every other example, and its test splits the handoff summary
on `Context: ` to assert the half a human reads is value-free — which is what
keeps the exception this one field wide instead of a precedent.

The second: an `undo_instruction` on a side effect that already happened names
what to undo, and naming it can require the value. The bundled `anomaly-issue`
is the worked case. It files GitHub issues, and a GitHub issue URL contains the
repository it was filed in — so the configured `repo` reaches the run log
through that field. Dropping the URL would leave an undo instruction nobody can
act on, which is worse than the disclosure. The bound is the same as the first
exception: one field. Its test asserts the URL is in `undo_instruction` and
that every other field of the result is free of the configured value. Reach for
this only where the side effect is irreversible and the operator has to finish
it by hand. An input whose value would be a secret does not belong in a plugin
that files anything.

**The name `action` is taken.** `warpline run` passes a mandatory `action`
positional as a per-invocation argument, which is tier 3 and beats both tiers
below it. An input you declare under that name therefore resolves to whatever
the operator typed on the command line, never to your default and never to the
config file. Pick another name.

**There is no environment-variable tier**, today. The file is the only channel
an *input* has, so an input carrying a secret is a secret sitting on disk under
the operator's home. That is a known limitation rather than an oversight, and it
is stated here so you meet it before you design around it. A credential does not
belong in that file: declare its name on `manifest.secrets` and read the value
from the environment inside your handler. The next section is how.

### Where credentials come from

The environment, and nowhere else.

A credential is not an input and gets no tier in the table above. Your manifest
declares the environment variable **keys** you need:

```typescript
secrets: ['GITHUB_TOKEN'],
```

Names only. **Warpline resolves the names and never stores the values.** There
is no vault, no `.env` file the runtime reads, and no secrets file under the
warpline home — so an operator who copies or `rsync`s that home ships no
declared credential, because there is nothing at rest to ship.

What the declaration buys you is a failure that happens **before** your handler
is called. Every declared name is looked up before the run starts, by exact key
equality — no case folding, no trimming, no prefix convention. A name that does
not resolve fails the run with a single `auth_failure` naming the key, and that
check sits above the retry loop, so it happens once and is never retried. A
credential absent on the first attempt is absent on the third.

**A key set to the empty string counts as absent** and fails by name. `FOO=` is
a broken credential, not a present one, and admitting it would only move the
same failure into your handler — which is the position the declaration exists to
get in front of.

Declaring nothing, and declaring `secrets: []`, are the same thing: the check
runs and passes. Read the value with `process.env.GITHUB_TOKEN` inside your
handler, at the point of use.

**Never put a resolved credential value into a `SkillResult`**, for the reason
the config channel above states at length: a run log is a file people paste into
issues. Name the key you expected.

The runtime does replace the exact values it resolved from `secrets` with
`[redacted]` at the parse boundary, before anything writes your result, so a
slip does not reach disk. Treat that as a backstop and not as permission. It
knows the values it was told about and nothing else, and the sentence below is
what "nothing else" covers.

**The replacement runs before validation, and it can cost you bytes.**
`[redacted]` is ten bytes, so a credential shorter than that makes your result
larger than you returned it. The Output body cap is measured on the redacted
bytes, because those are the bytes warpline writes — so an inline `body` within
ten bytes of the cap that carries a short credential fails validation even
though the body you assembled fits. Leave headroom. Better, keep the credential
out of the body.

**The known limit, stated as a limit.** The declared list bounds the sanctioned
path and nothing else. A token an operator puts in `<home>/config/<plugin>.json`
and never declares here is outside every mechanism warpline offers for
credentials — the redaction above included, because it can only act on what it
was told about. Declaring the name is what puts a credential inside the part
warpline can reason about.

## Capabilities

A capability is a member the runtime mints and hands to your handler, drawn from
what your own manifest declared. The rule is one sentence: a plugin that did not
declare an effect is never handed the member that performs it. The declaration
is what mints. The approval Grant is a separate question, read once by the
runtime before your handler is invoked and never again from inside a member.

**This is not the manifest's `capabilities` field.** `manifest.capabilities` is
a free-text array of informational tags describing what a plugin does. It grants
nothing, the mint never reads it, and no member is keyed off it. The table below
is keyed off `side_effects`.

Members reach a handler as a fourth parameter, after `signal`. The runtime calls
handlers with four arguments, and a handler declared with three keeps working
unchanged — the widening is on the parameter type, so a three-parameter function
is still assignable and JavaScript discards the argument it does not name.

`HandlerFn`, on the root barrel, still describes three parameters and will
continue to: it is public contract from 0.1.0 and renaming or widening it would
cost every installed plugin. To type the fourth parameter, import
`CapabilityHandlerFn` — or `CapabilityContext` for the parameter alone — from
`warpline/unstable-capabilities`, which is type-only and carries its instability
in the import path.

The context carries the members your manifest earned, plus `caller` — the
identity of this invocation, the plugin name and the run id. `caller` is not a
member: no effect keys it and it appears in no row of the table below. It is
there because every member takes a caller as its **required first parameter**,
and your handler is called with `(manifest, args, signal, capabilities)` and so
has no run id of its own to pass. Calling a member without it is a compile
error, not a convention.

<!-- generated: capability-effects -->

| Member | Requires `side_effects` entry | What it does |
|---|---|---|
| `secrets` | **ungated** | Lists the credential names this plugin declared and the runtime resolved. Names only — never a value. |

<!-- /generated -->

### Taking the fourth parameter

```typescript
import type { CapabilityHandlerFn } from 'warpline/unstable-capabilities'

export const handler: CapabilityHandlerFn = async (manifest, args, signal, capabilities) => {
  const declared = capabilities.secrets.resolvedNames(capabilities.caller)
  // ...
}
```

Three rules, and they are the whole model:

1. **The declaration is what mints.** A member appears on the context only when
   your manifest declares the `side_effects` entry the table above names for
   it. A member marked **ungated** names no entry and is minted for every
   plugin, on every run.
2. **The approval Grant is a separate question.** For a member that does name
   an entry, the declaration is necessary and not sufficient: the runtime reads
   the Grant once, before your handler is invoked, and a run carrying no
   approval receives no gated member. Nothing inside a member reads it again.
3. **Every member call names its caller.** The caller is the first argument of
   every member function, it is required, and omitting it is a compile error.
   Pass `capabilities.caller` — it is on the context for exactly this reason.

A member you were not entitled to is absent from the context rather than
present and throwing. Read that as the answer to "did my manifest declare
this?", which is the only question it is answering.

### The bound, stated plainly

**The capability context bounds the sanctioned path. It does not bound your
handler.** Your handler runs in the same process as the runtime and can reach
whatever that process can reach: the environment, the filesystem, the network.
The declaration decides what warpline hands you, not what you are able to
touch. Warpline offers no isolation here and claims none. What the declaration
buys is that the approval gate and the run record agree with each other about
what a plugin said it would do — which is why an undeclared side effect is the
one unforgivable plugin bug.

### Two things that do not exist yet

Both are deferred rather than refused, and both have a way to work today.

**There is no `warpline/unstable-http`, and no minted HTTP member.** Call
`fetch` directly from your handler and declare `external_api` on
`side_effects`. The gate reads your declaration, so a plugin calling out
through `fetch` is gated exactly as one calling through a member would be —
what a member would add later is a shared timeout and retry story, not
permission you do not already have.

**There is no snapshot store, and so no history, retention or diff.** Keep that
under the plugin's own channel meanwhile: write what you want to remember as a
declared output, and read your own prior state back the way your handler
already reads anything — from a path you control, named through your config
file. The runtime hands a handler no reader for its own past runs, so a plugin
that needs history owns that file today. What a store would add is retention
and comparison you would otherwise write per plugin, not permission you lack.

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

Warpline's own suite enforces this mechanically for every shipped example
manifest and for the text `warpline scaffold` generates — a manifest that does
work at module scope fails the build, it is not merely discouraged.

## Testing

Follow the example plugins: export the pure decision logic (the filter, the
parser, the summariser) as named functions and unit-test those directly with
`bun test`. Integration-test through `invokePlugin('name', args, { pluginsDir })`
pointing at a fixture directory — never at your live home. The repo's test
preload re-roots `WARPLINE_HOME` to a temp dir as a backstop, but explicit
fixture paths are the pattern.

Run everything: `bun run test` (builds first, then runs the suite). A bare
`bun test` is also correct — do NOT add `--timeout`. Bun's own 5s default does
flake under CPU contention, and `bunfig [test] timeout` is silently ignored,
but `__test_preload.ts` calls `setDefaultTimeout(20_000)` and bunfig preloads
it, so every invocation already gets 20s. An explicit `--timeout` still wins if
one case needs longer.

## Checklist before you ship one

- [ ] Could any part be a pure function it isn't? (doctrine review)
- [ ] Every external touch declared in `side_effects`?
- [ ] Every environment variable you read declared in `secrets`?
- [ ] Args validated, failures returned as typed errors?
- [ ] `signal` forwarded to real I/O?
- [ ] Decision logic exported and unit-tested?
- [ ] `ttl_hours` set to how stale is genuinely acceptable, not a guess?
