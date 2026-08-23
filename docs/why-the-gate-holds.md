---
title: Why the gate holds
diataxis: explanation
---

# Why the gate holds

Warpline has an autonomy setting, and the first thing to say about it is the
thing that is easiest to get backwards. It describes
**dispatch autonomy, not effect autonomy**.
Marking a plugin `autonomous` decides whether the scheduler may start it without
asking me. It does not decide whether that plugin may act on the world without
asking me. Those are two permissions, not one, and warpline never collapses them
into each other.

Everything a plugin does that reaches outside its own process — sending mail,
filing an issue, writing to a database, calling somebody else's API — it has to
declare in its manifest. Anything it declares there waits on an approval I grant
by hand, for this session, or the run records that plugin skipped and carries on
without it. That is the gate. What follows is the argument for keeping it even
when it is in the way, which is the only condition under which a gate is ever
really tested.

## Where this came from

Warpline was extracted in August 2026 from the private automation engine that
has run one company's marketing operations since early 2026. I did not arrive at
the gate from a threat model. I arrived at it from watching scheduled work run
unattended for months and noticing which failures I could shrug at and which
ones I could not. A wrong summary is a wrong summary: you read it, you bin it,
you fix the prompt. A message that has already left the building is not a draft
any more. That asymmetry is the entire design. Reruns are cheap right up to the
moment something leaves, and after that they are not reruns at all.

## The boundary is the cheap half

The first rule is older than the gate and much duller: if you can write an
`if/else` for it, it is code. Fetching, aggregating, comparing timestamps,
working out what is due, moving a task from one state to the next — all
deterministic, and it should stay deterministic, because deterministic work is
reproducible, reviewable and close to free. Judgment — the writing, the triage
call, the read on whether a competitor's positioning has actually shifted — is
handed off as a typed contract instead of being performed inline. The full
version of that split, with the tables, is in [doctrine.md](doctrine.md).

The argument I care about here is what you give up by not making the split. A
plugin that reaches for a model in the middle of its own logic has quietly
turned every future rerun into an experiment. The deterministic half stops being
reproducible, the judgment half stops being reviewable, and you find out which
was which when the two disagree with each other. Keeping the boundary in the
manifest means you can read a plugin and know, before you run it, which kind of
thing you are looking at. That is not a purity argument. It is the reason a
two-line change to a scheduled job stays a two-line change.

## The gate, and exactly how far it goes

A claim about a safety property is worth nothing without its source, so here is
this one with line numbers attached.

Blanket approval exists. `approval-gate.ts:76` is the wildcard short-circuit: if
a live grant's scope is the wildcard, the check returns true without consulting
the plugin's name at all — read it at
[approval-gate.ts](https://github.com/warplinehq/warpline/blob/main/src/runtime/approval-gate.ts).
I would rather write that sentence myself than have somebody find it.

What matters is how such a grant comes to exist. From the CLI the wildcard is
reachable through exactly one route, `warpline approve --all`, typed by a
person; the command prints the coverage it is about to grant before it writes
anything, and it refuses to run if you also name plugins, so no plugin name,
glob or shell expansion can widen a grant past what you typed — see
[approve.ts](https://github.com/warplinehq/warpline/blob/main/src/cli/approve.ts).
Nothing on the advance path grants anything at all. A run can only ever spend
approval a human already gave it.

And it expires. The default lifetime of a grant is four hours. Grants are
additive, so renewing one is ordinary — but a clock that resets on every renewal
is not a clock, so there is a second one, absolute, anchored at the *first*
grant in the window rather than the most recent. That is the same shape Kerberos
calls `renew_till` and Vault calls `max_ttl`, and it puts a 24-hour ceiling on
how long a single window can run. The ceiling is not unliftable: `approve.ts:33`
is the line of the CLI's own help text offering `--long`, "Permit an expiry past
24h from the first grant." I state it that way round because a document claiming
an absolute ceiling would be contradicted by the program's own `--help` output,
and a safety claim a reader can falsify in one command is worse than no claim at
all.

## Seven objections, and what I would say back

I have argued this in enough rooms to know which seven come back. Here they are
in the form I find hardest to answer, not the form that is easiest to knock
down.

### "the wildcard grant looks like a bypass"

Put strongly: you spend three sections telling me nothing reaches the world
without a human, and the program ships a flag that approves everything at once.
A gate with an off switch is a default, not a property.

That is right about what the flag is and wrong about what it costs. Every
constraint in the section above still applies while a wildcard grant is live.
It is one command a person types. It refuses to run if you also name plugins,
so nothing you did not type can be folded into it. It prints the coverage it is
about to grant before it writes anything, so the blast radius is on your screen
while you can still hit ctrl-c. It dies on the same two clocks as every other
grant. What it is not is a mode: there is no manifest field, no autonomy level
and no environment variable that produces a wildcard, and nothing on the advance
path can write a grant of any kind. A run spends approval; it never issues it.
One more property, because it is the sort of thing that gets left out of an
honest disclosure: the grant file is written owner-only, on the reasoning that a
file listing exactly which side effects are currently permitted is a map of what
to abuse before the clock runs out.

### "calling a plugin autonomous is a contradiction"

If an `autonomous` plugin still has to ask me before it does anything that
matters, the word is marketing.

The word describes scheduling and nothing else, and the schema says so in its
own comment — read it at
[plugin-manifest.ts](https://github.com/warplinehq/warpline/blob/main/src/schemas/plugin-manifest.ts):
autonomy describes how a plugin is scheduled, never what it is permitted to
touch. A plugin marked `autonomous` that also sends mail is the highest-risk
combination in the system rather than the lowest, and it is gated for exactly
that reason.

I will admit the tension is real, and the file admits it too. An earlier version
of that same comment said the opposite — that side effects were gated in the
supervised and manual modes — which is wrong, and wrong in a plausible enough
way to have sent one debugging session toward re-honouring the autonomy level
inside the gate. That change would have quietly undone the rule. The correction
is recorded in the source next to the thing it corrects, so the next reader does
not have to rediscover it the same way. I would rather carry an awkward field
name with its history attached than rename it and lose the record.

### "the if/else boundary is a decomposition trick"

Any task crosses the boundary if you decompose it finely enough. "Draft the
outreach copy" is judgment; "fill this template with these three values" is
code — and the second is only the first, decomposed until a human had already
made the judgment and written it into the template. So the line is not a
property of the task at all.

I think that is correct, and I do not think it damages the claim, because the
claim was never that the split is decidable in the abstract. The grey-areas
section of [doctrine.md](doctrine.md) is an admission in writing that the line
is applied per plugin by a person: default to deterministic, keep an escape
hatch, record which path was taken. What warpline asserts is narrower and
mechanical — someone decides where a plugin sits, the decision is written into
the manifest, and the runtime enforces the decision that was made rather than
renegotiating it mid-run.

The part I would rather show than argue is what that enforcement looks like from
outside. `warpline plan` prints the run before the run happens, and the plugins
that declared side effects appear in it held out at the gate, each annotated
with the effect it would have had. There is a copy of that output in the
project's [README](https://github.com/warplinehq/warpline/blob/main/README.md).
A boundary you can see in a dry run is a different kind of object from a
boundary described in a document.

### "approval prompts get rubber-stamped"

This is the best-documented objection of the seven and the one I take most
seriously. Security-operations research is blunt about it: analysts drown in
alerts and investigate a small fraction of them, and by the three-hundredth
approval of a routine, benign action a human is fatigued and primed to keep
clicking yes. Several 2026 write-ups treat approval fatigue as the central
unsolved problem in human-in-the-loop design rather than a fringe worry, and
they are not wrong to.

The correction is the whole rebuttal, so it is worth being precise about. That
literature is about per-action prompting — a decision requested every time
something happens. Warpline does not prompt per action. Approval is granted once
for a session, against an explicit list of named scopes, with a lifetime, and
then spent by whatever runs inside that window. One decision covers a named set
of plugins for a bounded period. The thing that fatigues an operator is being
asked repeatedly about work they have already reasoned about, and that is
structurally not the shape of this gate.

That is a design answer, so here is the closest thing I have to an empirical one.
In a recent month of production runs on the private engine warpline was extracted from, the gate fired on roughly one run in seven — the other six completed without ever asking.
I publish the shape rather than the count on purpose: what matters to the
objection is that gate prompts are a minority of runs, not the arithmetic of one
deployment. And I would rather state low volume as what the boundary is for than
as a promise about your workload, which is not something this design can make on
your behalf.

### "the industry is moving the other way"

Enterprise adoption of agents that act with less human review climbs every
quarter. There are teams whose stated goal is to replace the human approval step
with an automated evaluation harness, because the human was capping the fleet's
throughput. Betting against that is betting against the direction of travel.

The trend is real and I am not going to claim warpline is where the industry is
going, because the evidence says the opposite and it is the easiest kind of
claim for a reader to check. This is counter-programming and I would rather say
so. What those systems automate away is the *cost* of the gate, and the cost of
the gate is not the problem the gate exists to solve. An evaluation harness that
decides whether an action is safe is a second system that can be wrong, sitting
where the accountable party used to be. I would rather pay the cost, keep the
number of times it is charged low by keeping the deterministic half
deterministic, and know who approved what.

### "this is workflow orchestration with a manifesto"

Mechanically: a scheduler, typed plugin invocation, retries, and a gate. That
description also fits Airflow, Temporal and Zapier, none of which needed a
doctrine to explain themselves.

The scheduling is commodity and I make no claim on it. Two things in that list
are not commodity. The first is that the handoff to judgment is a validated
contract rather than an API call buried inside a task: a plugin that reaches the
edge of what code should decide returns a result marked as a handoff, the
runtime records it as delegated rather than failed, and it is never retried as
if it had broken — the shape is specified in
[needs-llm-contract.md](needs-llm-contract.md). The second is that the gate is
not a step somebody remembers to add. It is derived from what the manifest
declares, applies at every autonomy level, and withholds the plugin rather than
aborting the run, which is what makes it survivable enough to leave switched on;
[runtime-spec.md](runtime-spec.md) has the read semantics. You can build both on
top of any orchestrator you like. That is rather the point — you would be
building them, per project, and they would be as good as your discipline was on
the day.

### "the economics claim depends on one vendor"

"Deterministic work is close to free" holds only while somebody else's inference
is priced where it is today. Prices move, capability moves, and an argument
resting on this quarter's rate card has an expiry date on it.

The direction is right and the conclusion does not follow, because the claim is
comparative rather than absolute. The same work costs less when it is not routed
through a model at all, and that ordering survives any price the market lands
on. If inference gets much cheaper the boundary buys less on cost and exactly as
much on reproducibility, which is the half I would keep if I could only keep
one: a deterministic step reruns to the same answer, and that is a property of
the code rather than of anyone's pricing page.

What I will not do is attach a figure to it. There is no benchmark, this is not
the place to imply one exists, and a launch essay quoting a number nobody has
measured is how a good argument gets retired early. Warpline does track
per-domain call volume and headroom — see
[api-budget.ts](https://github.com/warplinehq/warpline/blob/main/src/lib/api-budget.ts),
warn-only by design, because a tracker that blocks a call fails closed on its own
bookkeeping error — on the view that knowing what you spend is the prerequisite
for arguing about it. Until there is a benchmark, this section is an argument,
and I would rather label it as one.

## What this follows

None of this is new, and the load-bearing parts are not mine. Anthropic's
*Building Effective Agents* is where I would send anyone who wants the case for
composing small, predictable, well-scoped steps rather than handing a model an
open-ended loop and hoping; the boundary rule above is that argument applied to
a scheduler. *12-Factor Agents* is where the operational half comes from — own
your control flow, own your prompts, and treat contact with a human as a
first-class step in the flow instead of an error path bolted on afterwards.
Warpline's own contribution, if it has one, is narrow: it takes both as premises
and makes them structural for scheduled operations work, so that the gate is not
a setting somebody turns off once the demo has gone well.

## What I am actually claiming

Not that a plugin cannot do damage. Something narrower, and checkable: that the
decision to let it is a human one, that the decision is written down, that it
expires, and that no run can take that decision on its own behalf. Every one of
those is a line of code you can go and read, and the ones that carry weight are
linked above.

The gate holds because it is not a policy. It is the only path through.

<!--
Verification notes for the claims above. Each clause of "blanket approval is one
explicit human command that prints its coverage first, it expires, and no run
grants itself anything" is tied below to the search that established it. Run
2026-08-23 against this tree; re-run them rather than re-reasoning them.

1. "no run grants itself anything" — the engine imports the read path only.
   grep -n 'approval-gate' on the engine returns one import:
     22:import { checkApproval } from './approval-gate.js'
   (a second hit at :207 is prose inside a docstring, not an import). Neither
   write function is imported by the advance path.

2. "no run grants itself anything" — neither write function has a caller
   outside its own module and the approve CLI. Searching the source tree for
   grantApproval, excluding the tests directory and the approval-gate module
   itself, returns nothing at all: exit 1, no output. The same search for
   mergeGrant returns exactly two lines, both in the approve CLI:
     approve.ts:20  import { mergeGrant, MAX_GRANT_WINDOW_MS } from ...
     approve.ts:165 const result = await mergeGrant(
   One importer, one call site, and it is the command a person types.

3. "one explicit human command" / "prints its coverage first" — the wildcard is
   reachable from the CLI only through the explicit flag, which the guard at
   approve.ts:105 makes mutually exclusive with positional plugin names:
     105:  if (values.all && positionals.length > 0) {
   and the coverage line is written at approve.ts:156-163, ten lines before the
   grant is merged at :165. Reading order is the proof: nothing is on disk when
   the coverage is printed.

4. "it expires" — the two constants, quoted from the module that defines them:
     28:export const DEFAULT_TTL_MS = 4 * 60 * 60 * 1000
     39:export const MAX_GRANT_WINDOW_MS = 24 * 60 * 60 * 1000
   The second carries the docstring "Anchored at FIRST issue, not at the latest
   grant", which is why re-granting cannot walk the window forward.

5. "the ceiling is liftable" — the CLI's own help text, at approve.ts:33:
     33:  --long       Permit an expiry past 24h from the first grant.
   This is why no sentence above calls the ceiling absolute.
-->
