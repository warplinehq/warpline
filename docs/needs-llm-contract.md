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
   result as a successful *handoff*, not a failure, from a plugin whose
   manifest declares `llm_handoff: true`. The runtime maps it to the
   `delegated` run status, so dashboards and anomaly checks do not paint it
   red. A handoff from a plugin that does not declare the field is refused:
   the run is recorded `failed` with an error naming `llm_handoff`, and it is
   never retried.
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
successful result into a delegated one. Either arm is `delegated` only when the
plugin's manifest declares `llm_handoff: true`; from any other plugin it is
refused and recorded `failed`.

**Both arms are emitted together**, and `skillHandoff` from
`warpline/unstable-result` is what emits them. It sets `needs_llm` and prefixes
the summary in the same call. The scanner reads the Handoff record described
below, which takes `task` and `context_path` from the field when the result
carries it and from the summary otherwise, so a result carrying either arm
alone is found. The summary keeps the context path resolved against the home,
so a person reading a run log sees where the payload is.

## Declaring the handoff

A plugin that may return a handoff declares it in its manifest:

```typescript
export const manifest = PluginManifestSchema.parse({
  name: 'feed-triage',
  // ...
  llm_handoff: true,
})
```

The field is `false` by default, and it means *may*: a declaring plugin that
returns `success` records `success`. The free-text `capabilities` list never
counts as the declaration, whatever it holds. `skillHandoff` builds the result
but declares nothing, because the manifest does. Rule 1 above is where the
declaration enters the contract.

A handoff from a plugin that does not declare the field is refused. The run is
recorded `failed`, `errors[0]` is a `parse_error` naming `llm_handoff`, and it
carries `retryable: false`, so it is never retried. It is never `delegated`
either, so the scanner never sees it. Under `review_gate: true`, or for a
`supervised` plugin, the refused result is not parked, because no `failed`
result is. It reads `failed` there too, with the refusal in its summary. The
exact refusal is in
[runtime-spec.md](runtime-spec.md) § 3.

**A handoff from a plugin that declares no side effect never parks.** Under
`review_gate: true`, or for a `supervised` plugin, it is recorded `skipped`,
nothing is parked, and the advance goes on. Side effects stay gated wherever
they fire: a plugin that declares one still needs a grant before it runs, and
its handoff still parks. The rule is in
[runtime-spec.md](runtime-spec.md) § 9.

The declaration is also the pre-run half of the contract. `warpline plan`
prints it under the plugin, before anything runs:

```
    llm_handoff: may hand judgment to the LLM ([needs-llm])
```

## The Handoff record

Every declared handoff an advance or `warpline run` makes is written as one
JSON file, `<home>/handoffs/<run_id>.<plugin>.json`, by `writeHandoff` in
`handoffs.ts`. The record's `id` is that file's name without `.json`. A plugin
hands off at most once per run, so the run and the plugin name the record.

Its fields:

- `min_reader_version`: `1`. A reader refuses a record whose number is higher.
- `id`: `<run_id>.<plugin>`.
- `run_id`: the run that handed off.
- `plugin`: the plugin that handed off.
- `task`: what judgment is asked for.
- `context_path`: the payload's path, or `null` when the handoff names none.
- `created_at`: when the record was written.
- `state`: `open`, `superseded` or `withdrawn`.
- `closed_at`: `null` while the record is open, and the time it closed once it
  is not.

`task` and `context_path` come from the structured `needs_llm` field when the
result carries it. Otherwise they come from the summary: `task` is the text
after the `[needs-llm]` prefix up to `Context: `, with its final period
dropped, and `context_path` is the text after `Context: `. The path is copied
as written. It is never resolved or judged here, and a record never holds the
payload's bytes.

An advance writes the record right after the plugin returns and before the
review gate, so a handoff that parks is recorded too. `isHandoff` in
`invoke-plugin.ts` decides what is a handoff, and by then an undeclared handoff
has been refused, so it writes no record. A dry run writes none, and
`warpline plan` writes none.

`warpline run` writes the record before its `delegated` run artifact, which is
otherwise unchanged. A record it cannot write fails the run with the result an
advance gets, described below: `ok: false`, and the artifact reads `failed`. `warpline run` takes no lock, so
a manual run racing an advance of the same plugin can leave two open records
until that plugin's next handoff.

A newer handoff for the same plugin marks every older open record of that
plugin `superseded` and sets its `closed_at`. A superseded record never opens
again. The new record is written first, so a plugin never ends with no open
record. No lock is taken, so two writers racing can leave two open records
until that plugin's next handoff.

**A denied run's record is withdrawn.** `warpline deny` that discards a
plugin's live parked result marks that run's record `withdrawn` and sets
`closed_at` to the denial's time, through `withdrawHandoff` in `handoffs.ts`.
Only a plugin that declares a side effect parks a handoff. This happens under
the state lock with the denial, after its `denial.recorded` audit record and
before the state document is written, so a deny that succeeds never leaves the
denied run's record open. A record that exists but cannot be read or rewritten
stops the deny: it exits `1` and nothing is denied. A record already closed is
left as it is. If the state write fails after the close, the record stays
withdrawn and the gate stays parked, and denying again completes it. A record
withdrawn for an earlier plugin in the same command stays withdrawn when a
later one fails. Either way the run was denied partway, and until a deny
completes, `warpline approve` refuses to apply that gate. It reads the record
under the state lock, through `readHandoff` in `handoffs.ts`. It exits `1`,
applies nothing, and says the run was denied partway and to deny again. A
parked result whose run has no record applies as before, and one whose record
cannot be read is refused. A deny that discards no live parked result (none
was parked, or the gate is an applied marker) answers the plugin's standing
proposal, not a run, and closes no record. A withdrawn record never opens
again.

**A reader acts only on an open record.** Every other state is closed.
A state this build never writes is closed too, and a reader reads it as closed,
never as unreadable. Supersede and withdraw each move only an open record, so
two of them racing leave it closed in one state or the other.
`warpline approve` reads one closed state, `withdrawn`, and only to refuse.
Adding a closed state does not raise `min_reader_version`, because no reader
acts on a state it does not know.

The `needs-llm` scanner finds handoffs by listing this directory, and it keeps
only open records.

A record that cannot be written fails the plugin. Its result becomes
`status: 'failed'` with summary `<plugin>: handoff not recorded`, and
`errors[0]` is a `dependency_unavailable` with `retryable: false` naming the
error code. It is not parked, a plugin depending on it is skipped as
`dependency_failed`, and the exit code counts it. The `fire.outcome` audit
record of a plugin declaring a side effect still reads `skipped`, because it
records what the handler returned, and the record is warpline's act afterwards.
A content-class plugin whose Handoff record cannot be written is a failed fire,
so its approval is left `indeterminate`, as
[runtime-spec.md](runtime-spec.md) § 10 describes.

## Who consumes the handoff

A **companion skill** — a Claude Code skill (see `skills/needs-llm-template/`)
that an orchestrating Claude session runs. The loop:

1. Deterministic pass: the engine runs due plugins. The v0.1 entry point is
   programmatic — a host calls `runAdvance()`, exported from the package root.
   To see what a run *would* do without running it, `warpline plan` prints the
   same due-set read-only. Each declared handoff becomes an open Handoff
   record, and a `warpline run` artifact for one still reads `delegated`.
2. The orchestrating session (a human-invoked Claude Code session, a scheduled
   agent, or a skill that wraps the engine) scans for open Handoff records.
   That scanner ships as the `needs-llm` skill in the `warpline` Claude Code
   plugin: it globs `<home>/handoffs/*.json`, keeps the records whose `state`
   is `open`, and reads each one's `task` and `context_path`. A relative path
   joins the home and an absolute one is used as is. A missing `handoffs/`
   means there is nothing to do.
3. For each, it dispatches the matching companion skill with the payload. The
   skill does the judgment work (drafting, triage, synthesis) and writes its
   output through whatever gate the host requires.
4. Side effects still go through the approval gate. An LLM drafting an email
   is judgment; SENDING it is a side effect — the draft lands somewhere a
   `sends_email`-declaring plugin (or a human) picks up under approval.

A plugin with `approval_class: 'content'` that returns a declared handoff
spends its content approval, even though it shipped nothing. The operator
re-approves before it can fire again. `runtime-spec.md` § 10 says why that is
the safer of the two choices. An undeclared handoff is refused, which makes it a
failed fire, so the approval is left indeterminate, as `runtime-spec.md` § 10
describes. The handler ran before the handoff was refused, so check the sink
with the effect id as for any failed fire. When nothing arrived, answer it with
`warpline resolve <plugin> --not-shipped <effect-id>` and re-approve. Declaring
`llm_handoff: true` is the fix.

## Why the plugin does not call the model itself

That is a doctrine question, not a contract detail: see
[doctrine.md](doctrine.md#why-the-plugin-hands-off-instead-of-calling-a-model).

## Naming the companion skill

Convention: the skill is named after the plugin (`feed-triage` plugin →
`feed-triage` skill) and documents which `[needs-llm]` payload shape it
accepts. The template in `skills/needs-llm-template/` is the starting point.

## Two roles: scanner and consumer

The convention above names the **consumer** — the skill that does the judgment
for one plugin's handoffs. It sits under a **scanner**, and the two are not the
same thing:

- **`needs-llm`** is the generic scanner. One skill, plugin-agnostic: it finds
  every open Handoff record regardless of which plugin emitted it, and routes
  each handoff to the consumer named after the emitting plugin. It reads only
  paths resolving inside the warpline home.
- **`feed-triage`** is the shipped example of a consumer. It takes the payload
  the scanner resolved and writes its judgment to one declared path,
  `<warpline home>/state/feed-triage.judgment.md` — a file, not a side effect
  (rule 4 above still applies to anything that leaves the machine).

Both ship in the `warpline` Claude Code plugin, under `plugin/skills/` in the
repository:
[plugin/skills/](https://github.com/warplinehq/warpline/tree/main/plugin/skills).
The authoring template stays at `skills/needs-llm-template/`, outside the
plugin, so it is never installed into anyone's session.
