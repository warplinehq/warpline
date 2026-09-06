---
title: Derive, don't store
diataxis: explanation
---

# Derive, don't store

The question I get about state comes in three forms. A snapshot store, so a
plugin can keep what it saw last time. A diff engine, so it can ask what
changed. Or a cache of some remote resource, so it doesn't fetch the same page
twice. The ask always sounds reasonable. It's usually made by someone who's just
written their second plugin and noticed the first one has the same problem.

I say no to all three, and this page is why. It's also what I hand over
instead, because "no" on its own isn't an answer.

## Why it feels right

You've got a plugin that polls something. It runs, it reports, it runs again
six hours later and reports the same thing. What you actually wanted was the
difference. So the natural next thought is that the runtime should remember
the last run for you. Keep every result, and any plugin can look back. Add a
diff over that, and "what changed" is a one-liner. Add a cache, and the fetch
is free too.

Each step is small. That's what makes it feel right. None of them is small
once it's shipped.

## What a store costs

A store is a second source of truth. The remote you polled is the first. The
moment the runtime keeps a copy, every reader has to decide which one to
believe, and the answer changes depending on when you ask.

Then the copy needs looking after. How long is it kept? What gets evicted when
the disk fills? When the shape of a result changes, does the old data migrate?
Or does it get thrown away, or does every reader grow a branch for every
version that ever existed? Who's allowed to read another plugin's history, and
what stops a plugin from reading a run it wasn't part of?

Those aren't design questions I'd get to answer once. They're a support
surface. Every one of them is a bug report waiting for a Tuesday, and I'm one
person. The runtime already has state it must keep and can't get wrong: the
engine state document, the run logs, the approval grant. I'm not adding a
fourth thing to that list for a convenience.

There's a quieter cost too. A store makes it easy to write a plugin that only
works because of what the runtime happened to keep. That plugin can't be run
by hand, can't be tested in a fresh home, and can't be moved. The idea that a
plugin's inputs are declared in its manifest stops being true.

## What you do instead

The rule is in the name. When you want yesterday's value, compute today's from
a source you already have, and let staleness tell you whether that's worth
doing.

Two pieces do the work, and both already exist.

The first is `ttl_hours` on the manifest. It says how long a result stays
good. Six hours for a metrics check, twelve for a repository poll. The field is
documented with the rest in [runtime-spec.md](runtime-spec.md).

The second is the freshness predicate, `isPluginFresh` in
[staleness.ts](https://github.com/warplinehq/warpline/blob/main/src/runtime/staleness.ts).
On every advance, the engine asks it one question per plugin: is this result
still fresh, or should the plugin run? The answer comes from four checks, in
this order. A plugin that's never run, runs. A plugin whose declared dependency
ran more recently than it did also runs, even inside its own window. That's
what lets a refreshed upstream pull its downstream through. A plugin inside its
`ttl_hours` window is skipped. Anything else runs.

That's the whole mechanism. Nothing is kept. "Is it worth recomputing" is
answered from two timestamps the engine already writes, and the plugin's
result is derived fresh from the real source every time it's asked for.

The runtime holds itself to the same rule. The run log keeps one entry per
plugin and no aggregate. A host that wants telemetry derives it from those
entries, because the runtime doesn't know what an aggregate should mean for
plugins it's never seen. That's where the spec names this rule, in
[the run log section](runtime-spec.md#the-run-log), and it's the rule I'm
asking you to hold your plugin to.

## When you really do need to look back

Some plugins can't answer their question without knowing what they saw last
time. Did a new issue appear? Did a series cross its threshold since the last
check? "What changed" needs a before.

The shape for that is one file, one record, overwritten every run. The plugin
reads it, computes the new observation, compares the two, writes the new one
over the old, and reports the difference. No history. No retention window.
Nothing to migrate, because there's only ever one of it, and it's the plugin's
own.

The shipped example is
[anomaly-watch](../examples/plugins/anomaly-watch/handler.ts). It writes
`state/anomaly-watch.last.json` under the home, a record holding when it looked
and which series were breached. On the next run it reads that back and says
what's new and what's cleared since. The path is derived from the manifest
name, never from an argument, so nothing an operator configures can point it
somewhere else. The repository poll does the same thing with its own last
snapshot.

Notice what's not in there. The runtime didn't keep anything for it. The plugin
used `readJsonOrNull` and `atomicWriteJson` from `warpline/unstable-fs`, the
same two calls it'd use for any other file under the home.

## Where the line is

One question tells you which side of it you're on. If the plugin ran right now
in a fresh home with no prior file, would it still be correct, just less
informative?

If yes, you're deriving. The prior file is an optimisation on top of a result
that stands on its own. A first run reports "first observation" and the second
run reports a delta, and both are true.

If no, you're storing. The plugin's answer depends on data that only exists
because something kept it. Keeping one last observation is on the deriving
side. Keeping the last hundred and answering questions over them is on the
storing side. That's true whether the runtime does the keeping or the plugin
does.

One shipped example sits on the storing side on purpose, and it's worth looking
at what that costs. `metrics-rollup` appends a row per metric per day and
retires rows past a retention window into weekly rollups. If it can't read its
own state, it refuses to overwrite it. That's a real store. It's also entirely
the plugin's, in its own state file, with its own `retention_days` input and
its own migration problem. The runtime doesn't know it exists. That's the deal.
You can build a store inside a plugin, and when you do, you own it.

## When the answer really is a store

I don't want to pretend the case doesn't exist. It does. If you need to answer
questions across many past runs, for several plugins at once, with something
like a query language over them, then you need a store. A single overwritten
file won't get you there.

What would have to be true is that the questions can't be answered from the
source. Not "it's slow to ask the source" but "the source no longer has the
answer". A feed that drops old items. An API that only returns the current
state. A metric with no history endpoint. When the past is only in your copy,
your copy is the source of truth, and everything in the cost section above
applies with no discount.

That store isn't built, and I'm not building it into the runtime. If you're in
that position, the honest answer is that you're writing a plugin that owns a
database. Warpline's job is to schedule it, gate its side effects and hand it a
home to keep the file in. That's not a smaller job than it sounds. It's just a
different one from the one I keep being asked for.
