# The work

Everything you need is in the directory you are running in. Every path named
below is relative to that directory, and nothing outside it is available to
you — there is no wider tree to search and nothing useful above this one, so
do not spend a turn looking.

Do the four pieces of work described below, and write each result to the exact
path given for it. The files at those paths are the whole of what is read
afterwards; anything you say in the session and do not write down is lost.

## What you are given

| Path | What it holds |
|---|---|
| `inputs/metrics.json` | `series`, each entry a `name`, its `latest` reading, a `threshold` and a `direction` of `above` or `below` |
| `inputs/metrics-rollup.json` | `rows`, the daily readings retained so far, each a `date`, a `name` and a `value`; and `rollups`, the weekly summaries already folded |
| `inputs/voice-rules.md` | the house style a written piece has to follow |
| `inputs/blocklist.json` | `terms`, words a written piece must not use |
| `inputs/frontmatter-schema.json` | `fields`, the front matter a written piece must carry and the type of each |
| `inputs/announce-draft.json` | `title` and `body`, one announcement draft |

## The notes file

If a file already exists at `notes.md`, read it before you start anything else
and use what it tells you: it was written by an earlier session doing this same
work, and those notes are yours to rely on rather than re-derive. Before you
finish, write or update `notes.md` with whatever you learned that would make
doing this same work again faster — where each input actually was, what shape
each output had to take, what you got wrong on the first attempt and what fixed
it. Those notes are read only by a later session and never by anything that
scores this work, so write what would genuinely help and nothing that would
not; padding them costs the next session reading time and earns nothing.

## What to produce

Four files, at exactly these four paths. No other path is read.

### `graded/daily-digest.json`

One digest of what the metrics say today. JSON, with two keys:

- `lines`: a non-empty array of short strings, one per series in
  `inputs/metrics.json`, each saying what that series reads and whether it has
  breached its threshold in its declared direction.
- `digest`: those same lines joined into one sentence, separated by `; `.

Both forms deliberately. The sentence is what a person reads; the array is what
something downstream consumes without having to split a string back apart.

### `graded/metrics-rollup.json`

Roll the daily readings forward, then report the two counts.

1. Append one row to the retained `rows` for each series in
   `inputs/metrics.json`, dated today in UTC as `YYYY-MM-DD`, carrying that
   series' `latest` as its `value`. Skip a series that already has a row for
   today.
2. Retire every row dated strictly earlier than 90 days before today. Rows on
   the cutoff date are kept.
3. Fold the retired rows into weekly summaries, keyed by the Monday of the week
   the row falls in and the series name, merging into an existing summary for
   that key where one is already present in `rollups`.

Then write the file: JSON with exactly two keys, `rows` and `rollups`, each an
integer — how many rows are retained after the retirement, and how many weekly
summaries exist after the fold. The counts only, not the data.

### `graded/draft-writer.md`

One drafted piece, around 400 words, on this topic:

> what the deterministic half of a run actually costs

Non-empty markdown. It follows the style in `inputs/voice-rules.md`, uses none
of the terms in `inputs/blocklist.json`, and opens with front matter carrying
every field named in `inputs/frontmatter-schema.json`, each of the type that
file gives it.

### `graded/announce-fanout.json`

Adapt the draft in `inputs/announce-draft.json` for two channels, each with its
own call to action:

| Channel | Call to action |
|---|---|
| `benchmark-channel-one` | Read the pre-registration before the numbers. |
| `benchmark-channel-two` | Run the harness against your own checkout. |

JSON, with exactly one key per channel above — those two channel names spelled
as they are here, no third key and neither one missing. Each value is an object
carrying the adapted `title`, the adapted `body`, and that channel's
`call_to_action`.

## When you are done

The four files exist at the four paths, and `notes.md` has been written or
updated. Nothing else in this directory needs to change.
