# Benchmark pre-registration

The method, written down before the first result exists.

This document describes a measurement that has not been taken yet. Every
mechanism it names is a mechanism in the harness beside it, and the whole point
of committing it first is that a reader can check the method before seeing the
number.

---

## 1. When this document freezes, and how that is enforced

This file is **editable until the first file exists under `bench/results/`**, and
**frozen from then on**.

The enforcement is two git facts, checked by a test:

1. The commit that first added this file is a git **ancestor** of every commit
   that adds a file under `bench/results/`.
2. This file's blob hash at the last commit before that first results commit is
   equal to its blob hash at the tip.

Ancestry and blob identity, never commit timestamps. A rebase or an amend
rewrites a date and leaves the topology alone, so a date comparison proves
nothing about ordering. Blob identity is what turns "committed first" into
"committed first and unchanged since", which is the claim that matters:
changing the pinned scenario, the arm definitions, N or the quartile method
after seeing a result is the oldest benchmarking crime, and this is the shape
of check that can catch it.

Editable until a result exists is deliberate. A pre-registration that has to be
right on its first draft gets written badly and defended afterwards.

**It was used.** This document was amended once, while `bench/results/` was still
empty, and the amendment was substantial: the isolation flags in § 4 and § 8, the
version pin in § 12, and everything § 9 and § 11 now say about what the counts and
the cost field mean. Each change is marked where it sits, with what was measured
and what the earlier draft said. That is the whole value of the ordering being
enforced by topology rather than asserted: a reader can see the amendment landed
before any result did.

---

## 2. Workload selection rule

Twelve example plugins ship in this repository. The scenario is the subset that
an unattended run can reproduce from a clean checkout:

- no outbound-request side effect,
- no declared secrets,
- a daily cadence.

That filter leaves four, and those four are the pinned set:

- `announce-fanout`
- `daily-digest`
- `draft-writer`
- `metrics-rollup`

**The set is frozen.** Later examples cannot join it and cannot move the number.
The harness refuses to run, naming the missing directory and its full path, if
any pinned example is absent from the example root.

### The scenario composition: five run, four graded

`daily-digest` folds what its declared producers last returned. With no producer
present it takes its no-data arm and withholds its Output, so there is no digest
for anyone to grade. The scenario therefore adds **one ungraded producer** to the
plugin root:

- `anomaly-watch` — runs, is not graded, declares no side effect, makes no
  network call, and reads the same plain JSON source data every arm reads.

So **five plugins run and four are graded**. Two consequences are stated here
rather than left for a reader to find:

- The plugin root holds five directories where the pinned graded set names four.
  The run/graded distinction is explicit for exactly that reason.
- The warpline arm carries one extra plugin's runtime work that the control arms
  do not pay. That is a small asymmetry **against** warpline, and it is not
  corrected for.

`daily-digest` declares a second producer, `github-poll`, and that one is
**deliberately absent**: it makes outbound requests, so it fails the selection
rule above. The digest therefore reports it as having no data — its `lines`
array carries an entry reading that `github-poll` has produced nothing yet. That
is the handler's designed behaviour and not a defect, and it is why a reader sees
a sixth plugin named inside an artifact produced by a five-plugin run.

---

## 3. The graded artifacts

Four relative paths, **identical for all three arms**, relative to each arm's
home:

| Artifact | Path |
|---|---|
| `announce-fanout` | `graded/announce-fanout.json` |
| `daily-digest` | `graded/daily-digest.json` |
| `draft-writer` | `graded/draft-writer.md` |
| `metrics-rollup` | `graded/metrics-rollup.json` |

The grader reads a filesystem. It imports no handler and no handler's test, and
nothing in it can tell which arm wrote the file it is reading. Every check is
existence plus a parsed value — never a string length, never a text equality,
never a normalisation compare. Three arms writing the same fact in three
different words are three passes.

The fan-out artifact is graded against **one frozen channel list that the
harness owns**, held outside every arm home. That is load-bearing: a grader
taking its key from a configuration file inside the home would be reading a
plugin-named file that only the warpline arm's home has any reason to carry, and
a control home without it would grade false for a reason nothing in the output
names.

### The two deterministic artifacts, and how they get there

For `daily-digest` and `metrics-rollup` the graded content is the plugin's own
declared output, **materialised into the graded path by the harness**. Two
different shapes, for two different reasons:

- `metrics-rollup` keeps its result in a retained state file, so the graded
  artifact is the **two integer counts** read off it — how many rows it holds
  and how many rollups it folded. It is not a copy of that file.
- `daily-digest` returns its digest as an inline body and writes no file at all,
  so the graded artifact is that body, read out of the engine's own state
  document where the runtime parked it.

**That materialisation runs inside the measured segment** — a state-file read, a
JSON read and two writes — so a reader is not surprised to find harness
bookkeeping inside the warpline arm's wall-clock. It is counted against warpline
rather than excused.

### The two handoff artifacts

For `draft-writer` and `announce-fanout` the graded content is the consumer
session's **resolved output**: the drafted piece, and the per-channel posts. Not
the handoff object. A handoff object is a request for judgment, and a request for
judgment is not the work.

---

## 4. The three arms

Arm identifiers, closed at three: `warpline`, `agent-with-state`,
`agent-from-scratch`.

**Arm order within an iteration is fixed** at `warpline`, then
`agent-with-state`, then `agent-from-scratch`, and each run records its own
position in that order. Fixed rather than rotated, because the cache-cold first
run is published as its own row and a rotation would make "first" mean a
different arm in different iterations.

All three arms are pinned to the same provider model and the same command-line
tool version. See § 12.

### `warpline`

Two segments.

1. **The advance.** `runAdvance`, imported from the package root by package
   self-reference through the exports map — the same specifier a consumer
   installing from the registry writes, never a relative path into the source
   tree. Called in-process.
2. **The consumer session**, which resolves the parked handoffs and writes the
   two handoff artifacts. It is the command-line tool in print mode, with:

   - `--print`
   - `--output-format json`
   - `--model` at the pinned id
   - `--plugin-dir` at the checkout's own plugin directory, given as an
     **absolute path**
   - `--setting-sources` at the **empty string**
   - `--strict-mcp-config`
   - `--no-session-persistence`
   - `--permission-mode bypassPermissions`
   - `--max-budget-usd` at the value in § 11

   **No minimal flag, and no configuration-directory variable.** Both were tried
   and both were measured to fail, on different halves of the same requirement,
   and the flag set above is the one that holds all three properties this method
   needs. § 8 gives the measurements.

   `--setting-sources` at the empty string is what suppresses the operator's own
   instruction file, their own skills, their settings and their hooks.
   `--strict-mcp-config` suppresses their servers. What remains in every session
   is the base system prompt and the built-in tool definitions, which every arm
   pays identically. § 9 puts a figure on it.

   `--plugin-dir` is the **warpline arm only**, and under this flag set it is
   live: a session given it can see the runtime's two skills, and a session
   without it cannot. That is checked rather than assumed — the two skill
   listings were taken in the same batch and were otherwise identical. So this
   arm runs with the runtime's own skills loaded, which is what a real user of
   the runtime has. The control arms have none of them and reach the graded
   paths by their own means. The runtime's own skills are the reference
   implementation of the thing being measured, and handing them to a control arm
   would be handing a control the answer.

**The consumer's discovery path**, stated because it is part of the arm
definition and it is not what a reader would assume: the consumer is handed the
absolute path of the run log the advance returned, and reads that log's
per-plugin entries for the handoff prefix. It does **not** glob the runs
directory looking for a delegated status. One log, named by the call that wrote
it.

### `agent-with-state`

The command-line tool with the **identical isolation flags** listed above and
**no** `--plugin-dir`, handed a fresh copy of the committed notes fixture at the
notes path named in § 6.

Freshly copied per measured run, never referenced in place. No measured run can
see a note a sibling run wrote.

### `agent-from-scratch`

The identical prompt, with **no file present at the notes path**.

---

## 5. Both control arms receive one prompt

The single prompt both control arms receive carries two clauses about the notes
path:

- read it first if a file is already there, and
- write or update it before finishing, with whatever would speed up doing this
  same work again.

**Both clauses are present for both control arms** — identical text, identical
instructions. The only difference between the two control arms is whether that
file exists when the session starts.

The prompt also names the fan-out channel list and the writer's topics directly.
It has to: those live in plugin-named configuration files in the warpline arm's
home, and a control home receives none of those (§ 7). Withholding the task
parameters as well as the reference implementation would be measuring a
different task.

---

## 6. Where the notes fixture comes from

`bench/fixtures/agent-notes.md` is produced by **one unmeasured warm-up pass of
the `agent-from-scratch` arm**, and committed before any measured run.

The from-scratch arm is the producer because it is the arm that starts with no
notes, which is the only state from which honest first-pass notes can be
written.

**The warm-up pass carries every isolation flag the measured runs carry** — the
flag set in § 4, the same caps, the same seeded home, the same prompt. A notes
file produced under the operator's ambient configuration is not the fixture a
stranger reproducing from a clean checkout would get: the ambient configuration is
instructions, hooks and skills that nobody else has, and it would be baked into
the committed fixture with no way to see it there.

**The pass has been taken, once, and the fixture is committed.** It ran before any
file existed under `bench/results/`, and the harness refuses to take it again once
one does — a fixture produced after the set began is state the measured runs never
had. If it ever has to be re-taken the previous notes are discarded rather than
merged, because merged notes are notes no single session wrote.

The harness **refuses by name** when the session produced no notes file, rather
than reporting a path or writing an empty one. That refusal is the one that
matters most here: a fixture committed empty would hand the with-state arm nothing,
both control arms would then receive an identical prompt over an identical home,
and the published pair would measure one thing twice while looking exactly like a
valid result.

The notes path inside a control home is `notes.md`.

---

## 7. Seeding, per arm

Seeding is **not one recipe applied three times**, and describing it as though it
were would misdescribe the measurement. Everything either arm's home contains is
arm definition, so the split is given literally.

### The `warpline` home receives

- The **six source fixture bodies**, each placed at the path read off the
  plugin's own manifest default through the same loader the engine uses, or —
  for the shared source metrics and the retained rollup state — at the literal
  state paths the handlers themselves use. Never at a hardcoded path chosen by
  the harness.
- A **copy of each of the five pinned example plugin directories** under the
  home's own plugin root, plus the one package symlink that lets a copied plugin
  resolve the runtime by package self-reference.
- The **two plugin configuration files**. These are load-bearing: both handoff
  plugins ship empty defaults for the inputs that decide whether they have
  anything to hand off, so without configuration both take a prefix-less skip and
  the run parks nothing at all.
- The **runtime's preferences file**, with the human review hold **off** and the
  quiet-hours window pinned **absent**. Also load-bearing, and invisible until
  the run is read: the shipped default holds every autonomous plugin's result for
  human review, so a bare home parks all five and the aggregate plugin never runs
  at all — its producer never reaches the completed state it folds from. The
  benchmark measures an unattended run. Quiet hours are pinned absent rather than
  defaulted so the scenario does not depend on the hour it was run.
- The **session grant**: four fields, owner-read-write only, written fresh inside
  each run's home.

**On the grant, the honest half.** All five pinned manifests declare an empty
side-effect list, and the gate consults a grant only for a plugin whose
side-effect list is non-empty. **The grant is therefore not load-bearing for this
scenario.** A reader must not infer from its presence that approval was required
here. It is written anyway so that a pinned manifest gaining a side effect later
turns into a visible failure instead of a silent zero-handoff abort, and a test
in the suite turns red on the day that happens.

One seeding fact that is easy to miss and changes what is measured: the retained
state for `metrics-rollup` is seeded with rows dated **well outside any retention
window**. Without it the retention fold has nothing to retire, the rollup count
is zero, and the graded artifact records a run in which the interesting
deterministic work did not happen. A fixed date in the distant past keeps that
true regardless of when the benchmark is run.

### Each control home receives

- The **six source fixture bodies only**, at a flat input directory the prompt
  names:

  | Fixture | Control path |
  |---|---|
  | voice rules | `inputs/voice-rules.md` |
  | blocklist | `inputs/blocklist.json` |
  | frontmatter schema | `inputs/frontmatter-schema.json` |
  | announcement draft | `inputs/announce-draft.json` |
  | source metrics | `inputs/metrics.json` |
  | retained rollup state | `inputs/metrics-rollup.json` |

- The **graded output directory**, `graded/`, created empty.
- For the `agent-with-state` arm alone: the fresh copy of the notes fixture at
  `notes.md`.

### A control home receives none of

Stated as a positive claim about the method, not as an omission:

- **no plugin source**,
- **no plugin root**,
- **no package symlink**,
- **no plugin-named configuration file**,
- **no runtime preferences file**,
- **no session grant**.

This is the same refusal that withholds `--plugin-dir` from the control arms, one
layer down. A control session runs with its working directory set to its own home
and with permission checks bypassed, so **anything in that home is readable by
it** — a home carrying the reference implementation would be a control arm handed
the answer.

### Why the two shapes read the same content from different locations

The six fixture **bodies are byte-identical across all three arms**. That is what
makes the arms comparable.

Their **locations differ**, and the reason is not a preference the harness
expressed. The runtime resolves each input from the declaring plugin's own
manifest default, and four of those defaults carry the runtime's own vocabulary
in the path: three sit under a plugin-named reference subdirectory, and a fourth
is a plugin-named filename. Reusing them for a control home would plant that
vocabulary inside the control. The control prompt therefore names a flat input
directory instead.

---

## 8. Isolation, and why it is measured rather than assumed

Each arm runs against **its own home**, selected by setting the home environment
variable immediately before the call.

- The harness **asks the public home accessor what it resolved**, immediately
  after assigning the variable, and aborts on a mismatch. That one comparison is
  what turns "isolated" from an assumption into a measurement.
- The three home paths are asserted **pairwise distinct absolute paths**. A
  collision aborts. A relative path is refused for the neighbouring reason: it
  resolves against whatever the working directory happens to be.
- A home that **cannot be created aborts the run**. There is deliberately no
  fallback to a default home; a fallback there writes the operator's live state.
- Homes are created **fresh per run and removed after**.

### The mechanism differs per arm, and that was a choice

- The **warpline** arm runs **in-process**, with the environment variable set and
  restored around the call. Handlers run in-process and resolve the home
  themselves through the built copy of the path resolver, so the environment
  variable is the only seam that reaches them.
- The **two control arms** are **one child process each**, because a spawned
  command-line tool has no other shape.

The accounting consequence, stated rather than buried: the warpline arm pays one
process spawn for its consumer session and each control arm pays one for its own,
so the spawn cost appears once per arm and cancels in the ratio.

### There is no per-run configuration-directory isolation, and that is measured

An earlier draft of this method gave each arm a fresh configuration directory.
That is not available on this tool, and the reason is worth stating plainly
because it is the kind of constraint a reader would otherwise assume was an
oversight.

**Setting the configuration-directory variable to any value at all suppresses the
subscription credential** — including setting it to the real default path. The
session then returns an unattributable provider error with all four token classes
present and equal to zero, which is a shape that satisfies neither the
genuine-zero branch nor the missing-class branch and would have been published as
a grader-failure rate blaming the arm. The mechanism is documented: the keychain
entry is keyed to that variable, so a session with a different value reads a
different entry. So the variable is **removed from every spawned environment**,
by the code rather than by whatever shell the harness was launched from.

The **minimal flag** fails for the neighbouring reason: it authenticates strictly
through an API key or a key helper and reads no subscription credential at all.

A third flag — the tool's own clean-room switch — authenticates, and it was the
recommendation this method carried for a while. It is **not used**, because it
also disables the plugin's skills, and it disables them however they are supplied:
both the plugin flag and the added-directory flag are inert under it. A measured
set taken under it would have been a warpline arm running without the runtime's
own skills, reported under an arm definition saying it had them.

So here is what is and is not isolated, stated as two lists rather than one claim:

**Isolated.** The operator's instruction files, their own skills, their settings
and their hooks, all by `--setting-sources ""`. Their servers, by
`--strict-mcp-config`. The session store, by `--no-session-persistence`. The
filesystem each arm can reach, by the per-run home. Every one of these was
checked by asking a session for a string it could not invent — a slug appearing
only in the operator's global instruction file — with an unsuppressed positive
control in the same batch that returned it. The control is what makes the absence
evidence rather than a confident denial.

**Not isolated.** The configuration directory, for the reason above. The
credential itself, which is the operator's ambient subscription login.

### Reproducing this without a keychain login

`claude setup-token` is present on the pinned version and mints a one-year
token, exported through `CLAUDE_CODE_OAUTH_TOKEN`. The documentation describes it
as the credential for pipelines and scripts where an interactive login is
unavailable, and it is what the official action takes for a subscription plan.
That is the reproduction path for a reader with no login on the machine.

**It is untested here, and specifically untested against a fresh configuration
directory.** An environment token plausibly bypasses the keychain namespacing
entirely, which would restore per-run configuration isolation for a reader who
has one — but nothing in this method measured that, and it is not claimed.

### Arms run sequentially

One arm at a time within an iteration. No two arms hold a home concurrently, and
the wall-clock carries no contention from a sibling arm on the one host.

Homes do not accumulate state across iterations. Each run gets a fresh home, and
the word **warm** in this document refers to the provider's prompt cache and
never to runtime state. The figure is taken against a runtime that has no run
lock, which is exactly why each arm needs its own home.

---

## 9. What is measured

### Tokens

Four classes, recorded **separately**, per arm per run:

`input`, `output`, `cache_creation`, `cache_read`.

- A class genuinely equal to zero is recorded as **zero**.
- A class **missing** from the result JSON is recorded as **null**, and the run is
  dispositioned a schema failure. It is never coerced to zero.
- No recorded field is a sum across classes. Aggregation happens over the raw
  integers, where a reader can see which classes went into it.

#### Two facts about these counts a reader must not be told wrongly

**The four classes are aggregates across every model a session used.** A session
that uses a tool spends a small auxiliary allocation on a cheaper model alongside
the pinned model's work, and the usage object sums them. In one probe that
auxiliary share was 912 input tokens and 16 output. Every arm pays it, so it is a
constant rather than a confound — but the published totals are not purely the
pinned model's, and this document will not say they are. The per-model breakdown
is what the model id is read back from, so the two models are visible in the same
object the counts come from.

**Every arm pays a constant floor**, and the consumer additionally pays the
plugin's two skills. Against roughly 31,550 `cache_creation` tokens for a session
with nothing suppressed, the flag set in § 4 measured between about 6,000 and
8,700 in adjacent batches. That is an order of magnitude, not a pin, and it is
deliberately stated as one: **`cache_creation` is not stable across runs**,
because the provider's prompt cache warms between them. An identical prompt
repeated came back 0. So only readings taken in the same batch compare, and a
reader who reproduces a single number here should not expect to hit it.

### Wall-clock

Float milliseconds from the high-resolution timer.

For the warpline arm the **two segments are recorded separately and summed**, and
**the published wall-clock is the sum**. Publishing the advance alone would repeat
on wall-clock the exact category error that counting the consumer session's
tokens exists to close.

### The split, and the handoff count

- The deterministic-to-judgment split is a **distinct published row**, with its
  ratio.
- The **parked-handoff count** per run, read from the run log the advance
  returned by counting entries whose summary carries the handoff prefix. By the
  prefix, which is already contract, and deliberately not by a status value — the
  run log's status enum has no member for a parked handoff, and widening a
  published enum to make a benchmark easier to write would be a contract change.
- A run that parks **zero handoffs aborts the harness** with a named error rather
  than publishing a zero judgment cost.

---

## 10. N, the statistics, and the dispositions

### N

**At least 10 warm graded-passing runs per arm**, plus **one cache-cold first run
per arm**, which is published as its own labelled row and excluded from every
warm median and every rate.

### Quartiles

Median and interquartile range by **type-7** linear interpolation — definition
seven of the nine catalogued by Hyndman and Fan, and the default in R's
`quantile`, NumPy's `quantile` and pandas' `Series.quantile`.

Named by its number, because "the median of an even-length sample" is not one
number: the nine definitions disagree about where to land between the two middle
order statistics. A reader reproducing the table in a different tool gets the same
figure only if the interpolation rule is pinned.

The rule, so the implementation can be checked against it: sort ascending, let
`h = p × (n − 1)`, and interpolate linearly between the order statistics at
`floor(h)` and `ceil(h)` by the fractional part of `h`.

### Below the threshold

An arm with fewer than **10** warm passing runs gets a **shortfall row** naming
the count it has and the threshold. Not a median of zero, not a blank, and not a
dash standing in for a figure that was quietly computed anyway.

### Dispositions

Four values: `passed`, `failed-grader`, `failed-schema`, `truncated`.

Resolved by a **single precedence, truncation first**: `truncated` over
`failed-schema` over `failed-grader` over `passed`. One value per run, so two
readers of the same record cannot disagree about what happened.

Truncation is published as **its own per-arm rate**, distinct from the
grader-failure rate and from the schema-failure rate. **All three rates take the
warm set as their denominator**, and none is derived by subtracting the others
from one.

---

## 11. The stop point

Two halves, and both are part of the method.

### The per-iteration half

The driver stops at an **iteration cap of 15**, even when an arm has not reached
its warm target.

A loop that runs until every arm passes has no stop point at all. It spends
without bound on an arm that never passes, and it makes the shortfall row
unreachable — nothing would ever trigger it. The cap is what gives the shortfall
row a trigger, which is why it is method rather than an implementation detail.
Fifteen iterations against a target of ten warm passing runs plus one cold run
leaves four spare iterations per arm.

### The per-session half

`--max-budget-usd 5` per session. When it trips, the command-line tool returns the
subtype `error_max_budget_usd`, and the run is dispositioned truncated.

The pinned tool version (§ 12) exposes **no turn-cap flag**. That was confirmed
twice, independently, against the tool's own help on this machine — and it is
worth saying explicitly, because **some current documentation still lists one**.
It is not there. So the turn ceiling is the tool's own internal default rather
than a value this document sets, and the spend cap is the only per-session stop
point this method chooses. A run truncated by the internal default returns the
subtype `error_max_turns` and is dispositioned truncated in the same way. Both
subtypes are recorded verbatim.

**A cap is a stop point, not a published figure.** That is why this document sits
outside the scan that forbids a currency figure in the published surfaces, and
why the published write-up carries no such flag.

### What the tool's own cost field is, if it is ever quoted

Nothing in this harness reads it: the scrubber removes every such key at the
record boundary, before the schema parse, so no record and no published figure
can carry one. Stated here anyway, because a reader running the harness will see
the field and may quote it.

It is a **client-side imputation at list price, not money charged.** The tool
computes it locally from the token counts, and the per-model usage block says so
in as many words — it reports a list basis. These runs are on a subscription, so
nobody was billed those amounts for them.

That makes it the right figure to publish **if** anyone publishes one, because a
reader can recompute it from the token counts in the committed records rather
than take it on trust. It is not a description of spend and must not be presented
as one.

---

## 12. Provenance pins

- **One host.** Every run in the published set comes from the same machine.
- **Model.** All arms pass the model flag explicitly, pinned to `claude-opus-5`.
  A mid-run default change would otherwise silently invalidate N samples. The
  **canonical model id is read back from the result JSON's per-model usage key**
  rather than echoed from the flag, so each record names the id that actually
  served the request. It must be one string across the whole published set; a
  change part-way through voids the set.

  **The canonical id, as returned, is `claude-opus-5` — undated.** The tool
  reports a dated form for some models and not for this one, and whichever form
  it returns is what the record carries verbatim.

  The read-back is by IDENTITY and not by position, which is a correction rather
  than a preference. A session that uses a tool reports two models and inserts the
  auxiliary one FIRST, so taking the first key stamped every record in a trial run
  with a model that did none of the work. A run the pinned model never served
  yields no id at all, and a record with no id is not publishable — so a silent
  substitution stops the set rather than entering it.
- **Command-line tool version**, pinned exactly: `2.1.269 (Claude Code)`.

  **This drifted while the method was being written.** An earlier draft of this
  section pinned `2.1.268`; the tool auto-updated between the isolation research
  and the harness being built, and the pin here is the version that runs the
  measured set rather than the one the research note was written against. Stated
  rather than quietly corrected, because a version pin that changes without
  comment is exactly the kind of edit this document's freeze exists to catch.

  An auto-update part-way through a set voids it the same way a model change
  does, so the driver **compares the version stamped on every record against the
  first one in the set and stops on a mismatch** rather than leaving it to be
  noticed afterwards.
- **Git SHA** and **package version**, stamped into every raw record. Without the
  SHA a raw record is unfalsifiable.

Every raw per-run record is committed under `bench/results/`, scrubbed of
operator paths, cost fields and free-text response bodies before it is validated,
so every published figure is recomputable from what is committed beside it.
