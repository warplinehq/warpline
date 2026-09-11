# The benchmark

## What this measures, and what it can't

This harness measures **marginal per-run cost**. It runs one day's worth of
scheduled work three ways and counts the tokens and the wall-clock each way
spends. Authoring a plugin is a one-time investment that the harness cannot see
at all. Somebody sat down and wrote the manifest, the handler and the tests, and
none of that effort appears anywhere in these figures. If you run a plugin once,
the number here is not the number you'd pay. If you run it every day for a year,
the authoring shows up as a rounding error and the number here is close. I'd
rather say that in the first paragraph than have you work it out from a
footnote.

## Two things this scenario doesn't show

**It doesn't measure state carried between runs.** The pinned scenario has no
example that diffs today's data against what it saw yesterday. That's one of the
things the runtime is for, and this scenario doesn't exercise it. Don't infer
anything about it from the table below, because the table has nothing to say
about it.

**It's taken against a runtime with no run lock.** That's exactly why each arm
gets its own home. Two arms sharing a home would let one read the other's state,
and nothing in the runtime would stop them. Isolation here is the harness
asserting a fresh directory per run, not the runtime refusing a second run.

## The method, in brief

The full method is in [PRE-REGISTRATION.md](PRE-REGISTRATION.md), committed
before the first result existed and frozen once one did. That ordering is
checked by git ancestry and a blob hash, so you can verify it rather than
believe it.

The short version:

**Three arms**, run sequentially in a fixed order within each iteration.

- `warpline` runs one advance over the pinned scenario, plus the consumer session
  that resolves the parked handoffs. Both segments are counted. Counting the
  runtime alone would be a category error, because the runtime emits close to
  zero tokens by construction.
- `agent-with-state` gets the same work, starting from a notes file written
  during one unmeasured warm-up pass.
- `agent-from-scratch` gets the same work and the same prompt, with no notes file.

**Four graded artifacts**, at identical paths for all three arms. The grader
reads a filesystem. It can't tell which arm wrote what it's reading, and it
never imports a handler or a handler's test.

**N is at least ten warm passing runs per arm**, plus one cache-cold first run
per arm that gets its own labelled row. Below ten, an arm gets a shortfall row
naming the count it has. It doesn't get a median.

**Median and interquartile range by type-7 linear interpolation**, the default
in R, NumPy and pandas. The number is named because the nine standard quantile
definitions disagree about where to land between two middle values, and a reader
reproducing this in another tool needs to know which rule produced it.

**Every raw per-run record is committed beside this file**, under `results/`. So
every figure here is recomputable from what's in the repository, and if you think
a figure is wrong you can check it rather than argue about it.

**This harness never runs in continuous integration.** The two control arms need
a provider API key and they spend real money on every run. A benchmark that
charges the project for every pull request gets switched off within a month, and
a switched-off benchmark is worse than none because nobody notices it stopped.

## Results

The table lands with the measured set. Its source is the raw per-run records
under `results/`, which are committed alongside it.
