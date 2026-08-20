---
title: Your first plugin
diataxis: tutorial
---

# Your first plugin

By the end of this you will have written a plugin, run it, watched the approval
gate refuse to run it, and approved it. About ten minutes. Everything here has
been run exactly as written; if a command does something other than what this
page shows, that is a bug in warpline, not in you.

You need Node 22.18+ (or Bun 1.3+). Nothing else — no API key, no account, no
model. Warpline never calls an LLM.

## 1. Install

Make a scratch directory and install warpline into it:

```bash
mkdir warpline-tutorial && cd warpline-tutorial
npm init -y
npm i warpline
```

Check it landed:

```bash
npx warpline --help
```

You should see five commands: `plan`, `scaffold`, `run`, `approve`, `revoke`.

## 2. Scaffold

```bash
npx warpline scaffold hello-warpline
```

```
Plugin 'hello-warpline' scaffolded at .../warpline-tutorial/.warpline/plugins/hello-warpline
```

That created a home directory, `.warpline/`, and put your plugin inside it.
Everything warpline reads or writes lives under that one directory — there is
no global state, and deleting it undoes this entire tutorial.

Your plugin is two files. The **manifest** declares what the plugin is and what
it is allowed to do:

```typescript
export const manifest = PluginManifestSchema.parse({
  name: 'hello-warpline',
  version: '1.0.0',
  description: 'TODO: Describe what this plugin does',
  // ...
  autonomy_level: 'supervised',
  side_effects: [],
  ttl_hours: 24,
})
```

The **handler** does the work and returns a structured result. Note it takes no
network client, no database handle, and no model — a handler is a function from
inputs to a `SkillResult`, which is what makes it testable.

Notice `PluginManifestSchema.parse(...)`, not `.safeParse(...)`. An invalid
manifest is a hard stop at load: a misconfigured plugin never silently runs.

## 3. Run it

```bash
npx warpline run hello-warpline default
```

```
succeeded in 52 ms (1 attempt)
```

"1 attempt" is the retry machinery reporting that it did not need to retry.

## 4. Ask what *would* happen

`plan` previews the next engine advance and executes nothing:

```bash
npx warpline plan
```

```
warpline plan — preview only; nothing was executed.

Grant: none — plugins with side effects would be SKIPPED this run

Due (1):

  hello-warpline (level 0)
    (no declared side effects)
```

It is due, and it declares no side effects, so nothing stands in its way.

## 5. Now make it dangerous

Change one line in `.warpline/plugins/hello-warpline/manifest.ts`:

```diff
-  side_effects: [],
+  side_effects: ['creates_issue'],
```

You have changed nothing about what the handler *does* — it still returns the
same result. You have only declared what it is capable of. Ask again:

```bash
npx warpline plan
```

```
Nothing is due — no plugin passed the filter chain.

Not due (1):

  hello-warpline — skipped (unapproved): side effects require session approval
    creates_issue: ⚠ unapproved — would be SKIPPED this run
```

**That is the whole point of warpline.** The declaration alone was enough to
stop it. Note also what did *not* happen: the run was not blocked, and no error
was raised. The plugin is `skipped` and the run continues. A gate that halted
the pipeline would train you to disable it.

`autonomy_level` is still `supervised`, but change it to `autonomous` and try
again — you will get the same refusal. Autonomy describes how a plugin is
scheduled, never what it is permitted to touch.

## 6. Approve it

```bash
npx warpline approve hello-warpline
```

```
Approved 1 scope:
  hello-warpline
Expires ... (240m remaining).
```

Approval is a *session* grant, not a per-action prompt: one decision, scoped to
the plugins you name, expiring in four hours by default. You can grant once and
leave a long run unattended. There is deliberately no self-service renewal.

```bash
npx warpline plan
```

```
Due (1):

  hello-warpline (level 0)
    creates_issue: ✓ approved
```

Hand it back when you are done:

```bash
npx warpline revoke
```

```
Session approval cleared (.../.warpline/.session-approval).
```

## What you just learned

- A plugin is a manifest plus a handler, and the manifest is a **declaration of
  capability** that the runtime enforces.
- `plan` answers "what would happen" without doing it.
- Declared side effects require session approval at *every* autonomy level, and
  an unapproved plugin is skipped rather than fatal.

## Where to go next

- [plugin-authoring.md](plugin-authoring.md) — writing a real handler, the
  runtime constraints that bite, and testing
- [doctrine.md](doctrine.md) — why the deterministic/LLM boundary is drawn
  where it is
- [needs-llm-contract.md](needs-llm-contract.md) — how a plugin hands judgment
  work to a Claude Code session instead of calling a model
- [runtime-spec.md](runtime-spec.md) — every manifest field, and the
  retry/timeout/abort semantics
