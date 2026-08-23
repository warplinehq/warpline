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
