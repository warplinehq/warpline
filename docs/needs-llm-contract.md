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

`output_path` is optional. It names where `warpline consume` writes the
Judgment, and it is a path relative to the warpline home under the same rule as
`context_path`: an absolute path, a drive letter or a `..` segment is refused at
the parse boundary, by name and never by value. Warpline writes the file; the
model never does. A handoff without one is not answered by `consume`. It
reaches the Handoff record below, and only the structured arm carries it.

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
- `output_path`: where the Judgment is written, relative to the home, or
  `null` when the handoff names none.
- `tries`: every try at the record's judgment, oldest first, starting empty.
  A try is only appended and never rewritten. Each one carries `at`,
  `reservation_id`, `requested` (the model asked for), `served` (the model that
  answered, or `null`), `cost_micro_usd` (or `null`), `cost_basis`
  (`reported`, `computed` or `unknown`), `outcome` (`answered`, `failed`,
  `discarded`, `refused` or `recovered`) and `reason` (or `null`). A reader
  accepts any string as an `outcome` or a `cost_basis`, as it does for `state`.
- `created_at`: when the record was written.
- `state`: `open`, `superseded`, `withdrawn` or `answered`. A try closes an
  open record `answered`.
- `closed_at`: `null` while the record is open, and the time it closed once it
  is not.

A record written before `output_path` and `tries` existed has neither key, and
reads as it did.

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
record. Each record it rewrites is rewritten under that record's write lock,
described below, but the pass as a whole is not serialised, so two writers
racing can leave two open records until that plugin's next handoff.

**A denied run's record is withdrawn.** `warpline deny` that discards a
plugin's live parked result marks that run's record `withdrawn` and sets
`closed_at` to the denial's time, through `withdrawHandoff` in `handoffs.ts`.
Only a plugin that declares a side effect parks a handoff. This happens under
the state lock with the denial, after its `denial.recorded` audit record and
before the state document is written, so a deny that succeeds never leaves the
denied run's record open. First, `deny` reads the record of every run it
discards. A record that exists but cannot be read stops the deny there, before
any `denial.recorded` audit record: it exits `1`, no denial is recorded, and
the message names the file and says to deny again once it reads or is gone. A
record that cannot be rewritten stops the deny after its audit records: it
exits `1` and no denial is recorded. A record already closed is left as it is.
A deny that discards no live parked result (none was parked, or the gate is an
applied marker) answers the plugin's standing proposal, not a run, and closes
no record. A withdrawn record never opens again.

**The gate and the record answer different questions.** A parked result's
gate says whether the operator has accepted the run's outcome. Its Handoff
record says whether the run's judgment is still asked for. Each is read for its
own question: `warpline approve` reads the gate and never a record, and the
scanner reads the record and never the gate. A deny that stops between its two
writes leaves the record withdrawn and the gate parked. That happens when a
later plugin's record in the same command cannot be rewritten, or when the
state write fails after the close. `deny` then names each record it withdrew,
and each stays withdrawn. The gate is answered as any parked result is.
Approving it applies the outcome and routes no judgment for that run. Denying
it again records the denial.

**A reader acts only on an open record.** Every other state is closed.
A state this build never writes is closed too, and a reader reads it as closed,
never as unreadable. Adding a closed state does not raise
`min_reader_version`, because no reader acts on one.

**Every rewrite takes the record's write lock.** Supersede, withdraw and a
settling try each take `<home>/handoffs/<id>.lock`, read the record again under
it, and write only from what they read. So a try that settles while a
supersede is between its read and its write lands after it, and never writes
over it. The lock is held for one read and one write, plus the writer's one
audit record, never across a model call. A holder gone on this machine is
broken through `<id>.lock.break`. Any other holder is waited on, and a writer
that waits past its limit stops with `EBUSY`, which `deny` names. Three objects
have three locks: the spend lock `.consume.lock`, the claim `<id>.claim`, and
this record write lock. The claim never serialises writers. The lock order is
the state lock, then a record lock, then the audit lock.

A closed record's `state` is never rewritten. A try that arrives after it
closed is appended as `discarded`, and `state` and `closed_at` are left as
they are, so a withdrawn or superseded record never becomes `answered`.

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

## How `warpline consume` answers a record

`warpline consume` reads an open record, sends one prompt to the configured
provider, and writes the text that comes back as the Judgment. Each rule below
is checked by `consumePass` in `pass.ts`.

**The prompt.** With `context_path: null` the prompt is the `task` alone,
byte for byte. Otherwise it is the `task`, a blank line, then the context
file's text. The prompt is sent verbatim to the configured provider.

**The context file.** A relative `context_path` joins the home, and an
absolute one is used as written. Either way the path must resolve inside the
home on the filesystem, symbolic links included, and the file is read only
through that resolved path. The file must be UTF-8 and at most 8 MiB
(`CONTEXT_MAX_BYTES`, under the claude CLI's 10 MB stdin limit). Otherwise the
Handoff is refused by name, with no reservation and no model call, and the
record stays `open`:

- `the context path resolves outside the home`
- `the context file is missing`
- `the context file is not UTF-8`
- `the context file is over 8 MiB`
- `the context file could not be read (<code>)` for any other read error

**The output path.** `output_path` must resolve inside the home on the
filesystem, symbolic links included. Before a try is reserved, the deepest
part of `<home>/<output_path>`'s directory that exists must resolve inside the
home before any directory is made, and the directory is checked again once it
is made. A path that resolves elsewhere is refused with `output_path resolves
outside the home`, with no reservation and no model call, and nothing is made
outside the home. The directory is checked a third time right before the
write. If it has moved outside the home during the call, the try is `failed`
with the same reason and nothing is written. warpline writes the Judgment
there atomically, as the text's UTF-8 bytes.

**A successful try.** The text is an answer only when it is non-empty after
trimming and at most `consume.max_output_bytes` UTF-8 bytes. Text of exactly
that many bytes is an answer. Otherwise the try is `failed` with reason `the
text was empty` or `the text is over consume.max_output_bytes`, nothing is
written, the record stays `open`, and the try's `handoff.tried` line still
carries the text's byte count and sha256.

**Max tries.** A try counts against `consume.max_tries` when its `outcome` is
not `answered`, `recovered` or `discarded`. The count is read from the
record's `tries` and stored nowhere else. Once a record has
`consume.max_tries` counted tries, it is skipped with `the Handoff has used
consume.max_tries tries`, with no model call. It is checked before the claim
and again under it. The record stays `open`, and the pass exits `1` for it.

No refusal or skip above reserves anything or adds a try, and a claim it
took is released.

## Who consumes the handoff

Two consumers ship, and a record has exactly one of them:

- **`warpline consume`**, the headless one, answers the open records that name
  an `output_path`. It runs outside the engine, on a schedule or by hand, and
  writes the Judgment itself (above, and `runtime-spec.md` § 17).
- **The `needs-llm` skill**, the interactive one, takes the rest: the open
  records with no `output_path` and no `<id>.claim` beside them. It routes each
  one to a companion skill.

A **companion skill** is a Claude Code skill (see `skills/needs-llm-template/`)
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
   is `open`, drops the ones that name an `output_path` or have a `<id>.claim`
   beside them, since those are `warpline consume`'s, and reads each kept
   one's `task` and `context_path`. A relative path
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
  the open Handoff records regardless of which plugin emitted them, and routes
  each handoff to the consumer named after the emitting plugin. It skips a
  record that names an `output_path` or has a `<id>.claim` beside it: that one
  is answered by `warpline consume`, the headless consumer that ships with
  warpline, and the skill never races it. It reads only paths resolving inside
  the warpline home.
- **`feed-triage`** is the shipped example of a consumer. It takes the payload
  the scanner resolved and writes its judgment to one declared path,
  `<warpline home>/state/feed-triage.judgment.md` — a file, not a side effect
  (rule 4 above still applies to anything that leaves the machine).

Both ship in the `warpline` Claude Code plugin, under `plugin/skills/` in the
repository:
[plugin/skills/](https://github.com/warplinehq/warpline/tree/main/plugin/skills).
The authoring template stays at `skills/needs-llm-template/`, outside the
plugin, so it is never installed into anyone's session.
