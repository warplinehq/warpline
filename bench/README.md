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
a provider credential and they spend real money on every run. A benchmark that
charges the project for every pull request gets switched off within a month, and
a switched-off benchmark is worse than none because nobody notices it stopped.

## Results

Eleven iterations on one host, one tool version, one model. **N is ten warm
passing runs per arm**, plus one cache-cold first run per arm that gets its own
row below and sits in no median and no rate. Every warm run passed the grader in
every arm, so each arm's warm passing count is its warm run count and no arm
gets a shortfall row.

Medians and interquartile ranges are type-7, over the warm passing runs only.
Token figures are transcribed as the harness prints them, half-values included:
a type-7 quantile over an even sample lands between two order statistics, and
rounding that away would hide which rule produced it. Wall-clock is
milliseconds. The arm figures are rounded to the nearest whole millisecond, and
the split figures below to two decimal places, because one of those segments
runs in under ten milliseconds and whole milliseconds would round it into noise.

### Tokens, by class

Median, with the interquartile range in brackets.

| Class | `warpline` | `agent-with-state` | `agent-from-scratch` |
|---|---|---|---|
| `input` | 16 (2) | 14 (2) | 14 (2) |
| `output` | 4556.5 (370.5) | 7178 (294.25) | 6471 (1062) |
| `cache_creation` | 15080 (1483) | 17804.5 (688.5) | 16298.5 (1291.5) |
| `cache_read` | 153725 (29626) | 141903 (23569.25) | 136970.5 (19399) |

Four classes, never summed. Input tokens and cache-read tokens aren't the same
thing, and adding them up would hide which classes moved.

`warpline`'s cache-read median is the highest of the three. Its consumer session
loads the runtime's two skills and neither control arm loads any, and § 9 of
[PRE-REGISTRATION.md](PRE-REGISTRATION.md) says every session also pays a
constant floor for the base system prompt and the built-in tools.

### Wall-clock

| Arm | Median (ms) | IQR (ms) |
|---|---|---|
| `warpline` | 77259 | 4126 |
| `agent-with-state` | 102023 | 10210 |
| `agent-from-scratch` | 96517 | 14314 |

### The deterministic-to-judgment split

The `warpline` arm alone, over the same ten warm passing runs, from the
`runtime_ms` and `consumer_ms` fields each record carries.

| Segment | Median (ms) | IQR (ms) |
|---|---|---|
| deterministic, the advance | 7.72 | 1.34 |
| judgment, the consumer session | 77250.83 | 4126.43 |

Ratio of the two medians, deterministic over judgment: `0.0000999`. That reads
as about one to ten thousand. The deterministic segment runs in-process and asks
the provider nothing, so it emits no tokens at all. It's here as its own row
because a reader who sees only the arm's total can't tell that.

What this row doesn't say: it isn't a claim about the whole workload. Two of the
four graded artifacts in this scenario need judgment by construction, and the
session that supplies it is almost all of the arm's wall-clock.

### The cache-cold first run

Each arm's first run, outside every median above and every rate below.

| Arm | Disposition | Wall-clock (ms) | `input` | `output` | `cache_creation` | `cache_read` |
|---|---|---|---|---|---|---|
| `warpline` | passed | 69902 | 14 | 4232 | 13833 | 130516 |
| `agent-with-state` | passed | 107035 | 16 | 7380 | 17602 | 163098 |
| `agent-from-scratch` | passed | 103510 | 16 | 7506 | 17760 | 162379 |

### Rates

Three rates, each over the warm set of ten, and none of them derived by
subtracting the others from one. A truncated run and a run that did the wrong
work are different facts, so they get different columns.

| Arm | Truncated | Grader failure | Schema failure |
|---|---|---|---|
| `warpline` | 0 of 10 | 0 of 10 | 0 of 10 |
| `agent-with-state` | 0 of 10 | 0 of 10 | 0 of 10 |
| `agent-from-scratch` | 0 of 10 | 0 of 10 | 0 of 10 |

### Reproducing these figures

Every figure in the per-arm tables is recomputable from the raw per-run records
committed under `results/`, beside this file. `bun run bench` over a complete set
spawns nothing and prints the summary those figures are transcribed from. The
split row is the one thing not in that output: it's the type-7 median of
`runtime_ms` and of `consumer_ms` across the `warpline` records in the same
directory.

Every run in the set carries the same four provenance strings, so a reader can
check that the set is one configuration rather than take it on trust: git SHA
`e6cd569`, package version `0.3.4`, tool version `2.1.269 (Claude Code)`, and
model `claude-opus-5`.
