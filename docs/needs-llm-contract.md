---
title: The [needs-llm] contract
diataxis: reference
---

# The `[needs-llm]` contract

Warpline's boundary doctrine (docs/doctrine.md) splits work into deterministic
code and LLM judgment. Plugins are the deterministic half. This document is
the seam between the two: how a plugin *requests* judgment work without ever
calling an LLM itself.

## The contract

A plugin that reaches the edge of what code should decide returns a
`SkillResult` shaped like this:

```jsonc
{
  "status": "skipped",
  "summary": "[needs-llm] Draft distribution posts for 2 articles. Context: <path>",
  // ...rest of the normal SkillResult fields
}
```

`Context:` names a **path**, not an inline payload. The scanner resolves it and
reads the file, and it will only read paths that resolve inside the warpline
home — an inline blob would be treated as a path, fail to resolve, and be
reported as out-of-home rather than consumed. The in-home restriction is the
point: the scanner runs in a session with the user's rights, so the set of
things a plugin can make it open is bounded by the home, not by the plugin.
Write the payload to a file under the home and name that.

Three rules, all enforced or honoured by the runtime:

1. **`status: 'skipped'` + a summary starting with `[needs-llm]`** marks the
   result as a successful *handoff*, not a failure. The runtime maps it to the
   `delegated` run status, so dashboards and anomaly checks do not paint it
   red.
2. **Never retried.** Retry logic acts on `retryable: true` failures; a
   delegated handoff is terminal for the plugin. Re-running the plugin later
   (TTL) re-derives the handoff if the work is still outstanding.
3. **The plugin computes everything computable before handing off.** Cadence
   defaults, file paths, dedup keys, the exact list of items needing judgment
   — all pre-resolved into the summary/context payload. The LLM gets a
   decision to make, not a scavenger hunt.

## The structured arm

A summary is a string, and a plugin that hands off has to assemble one
correctly or the handoff is not consumable. The same handoff can be declared as
a field, `needs_llm`, so an author constructs it instead of formatting it:

```jsonc
{
  "status": "skipped",
  "summary": "[needs-llm] Draft distribution posts for 2 articles. Context: <path>",
  "needs_llm": {
    "task": "Draft distribution posts for 2 articles",
    "context_path": "state/distribution-queue.json"
  }
}
```

The `task` field is the sentence a human reads — what judgment is being asked
for, with no terminating punctuation, since the summary supplies that. The
`context_path` field is the payload, and everything the `Context:` rule above
says about paths binds it here in its own right rather than by reference.

`context_path` names a **path** and never an inline payload, and it is a path
**relative to the warpline home**. Relative is what makes the restriction
enforceable: a schema cannot ask where the home is, but a relative path with no
parent-directory segment resolves inside whatever root it is joined to, so the
in-home rule holds by construction rather than by a check somebody has to
remember. An absolute path, a Windows drive letter, and any `..` segment are
refused at the parse boundary, and the whole result is refused with them. The
refusal names the key and the shape expected of it and never the offending
value — a path is exactly the kind of value that carries a secret, and a
refusal lands in the run log.

The reason is the same one the string arm has: the scanner runs in a session
with the operator's rights, so the set of files a plugin can make it open must
be bounded by the home and not by the plugin.

The runtime classifies a handoff on **either** arm — one predicate,
`isHandoff` in `invoke-plugin.ts`, reads the field or the prefix. `status:
'skipped'` is still required by both: the field alone does not turn a
successful result into a delegated one.

**Both arms are emitted together**, and `skillHandoff` from
`warpline/unstable-result` is what emits them. It sets `needs_llm` and prefixes
the summary in the same call, writing the context path into the summary
resolved against the home so the scanner has a path it can open. The string arm
is what the shipped scanner reads today; teaching it to read the field instead
is a change to the skill and to this document, and is deliberately not done
here. Until it is, a result that carried only the field would be one the runtime
calls `delegated` and the scanner never picks up.

## Who consumes the handoff

A **companion skill** — a Claude Code skill (see `skills/needs-llm-template/`)
that an orchestrating Claude session runs. The loop:

1. Deterministic pass: the engine runs due plugins. The v0.1 entry point is
   programmatic — a host calls `runAdvance()`, exported from the package root.
   To see what a run *would* do without running it, `warpline plan` prints the
   same due-set read-only. Some results come back `delegated`.
2. The orchestrating session (a human-invoked Claude Code session, a scheduled
   agent, or a skill that wraps the engine) scans run artifacts / board events
   for `[needs-llm]` summaries. That scanner ships as the `needs-llm` skill in
   the `warpline` Claude Code plugin: it globs the run artifacts under the
   warpline home, keeps the ones whose status is `delegated`, and reads the
   payload named after `Context:` in the summary.
3. For each, it dispatches the matching companion skill with the payload. The
   skill does the judgment work (drafting, triage, synthesis) and writes its
   output through whatever gate the host requires.
4. Side effects still go through the approval gate. An LLM drafting an email
   is judgment; SENDING it is a side effect — the draft lands somewhere a
   `sends_email`-declaring plugin (or a human) picks up under approval.

## Why the plugin does not call the model itself

That is a doctrine question, not a contract detail: see
[doctrine.md](doctrine.md#why-the-plugin-hands-off-instead-of-calling-a-model).

## Naming the companion skill

Convention: the skill is named after the plugin (`content-atomiser` plugin →
`content-atomiser` skill) and documents which `[needs-llm]` payload shape it
accepts. The template in `skills/needs-llm-template/` is the starting point.

## Two roles: scanner and consumer

The convention above names the **consumer** — the skill that does the judgment
for one plugin's handoffs. It sits under a **scanner**, and the two are not the
same thing:

- **`needs-llm`** is the generic scanner. One skill, plugin-agnostic: it finds
  every `delegated` run regardless of which plugin emitted it, and routes each
  handoff to the consumer named after the emitting plugin. It reads only paths
  resolving inside the warpline home.
- **`feed-triage`** is the shipped example of a consumer. It takes the payload
  the scanner resolved and writes its judgment to one declared path,
  `<warpline home>/state/feed-triage.judgment.md` — a file, not a side effect
  (rule 4 above still applies to anything that leaves the machine).

Both ship in the `warpline` Claude Code plugin, under `plugin/skills/` in the
repository:
[plugin/skills/](https://github.com/warplinehq/warpline/tree/main/plugin/skills).
The authoring template stays at `skills/needs-llm-template/`, outside the
plugin, so it is never installed into anyone's session.
