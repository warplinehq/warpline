# Notes for the next session

Run date of this pass: 2026-09-12 (UTC). Everything is in the CWD; `inputs/`
holds all six inputs, `graded/` is where the four outputs go and starts empty.
There is no wider tree — don't go looking.

## Inputs (all small, just `cat inputs/*` in one shot)

`metrics.json` (3 series), `metrics-rollup.json` (3 rows all dated 2020-01,
`rollups: []`), `voice-rules.md`, `blocklist.json` (4 terms),
`frontmatter-schema.json` (title/summary/published_at strings + tags array),
`announce-draft.json`.

## What each output had to be

**`graded/daily-digest.json`** — `{"lines": [...], "digest": "..."}` and nothing
else. One line per series, `digest` must be *exactly* `"; ".join(lines)` — build
it that way in code, never retype the sentence. Breach test: `above` →
`latest > threshold`, `below` → `latest < threshold`. 2026-09-12 result:
signup_rate 3/5 breached, error_count 42/10 breached, queue_depth 7/25 not.

**`graded/metrics-rollup.json`** — the two *counts only*, as integers, keys
`rows` and `rollups`. Easy trap: it's tempting to write out the rolled data.
Don't. On 2026-09-12 the answer was `{"rows": 3, "rollups": 2}` — cutoff
2026-06-14, all 3 seed rows retired, only the 3 rows appended for today survive.
The 2 rollups come from key = (Monday of week, series name): 2020-01-06 is
itself a Monday and 2020-01-07 folds back to it, so signup_rate's two rows merge
into one summary and error_count makes the second. Monday via
`d - timedelta(days=d.weekday())`. Cutoff is `>= today - 90d` (on-cutoff rows
are kept, so use `>=`, not `>`).

**`graded/draft-writer.md`** — YAML frontmatter with all four schema fields,
`tags` as a real array literal, then ~400 words (380 body words landed fine) on
what the deterministic half of a run costs. Voice rules that actually bite:
second person, one idea per paragraph, and the **closing line must name the
reader's next action** — easy to forget. Also prefer concrete numbers to
qualifiers, so seed the prose with real figures.

**`graded/announce-fanout.json`** — exactly two keys, the channel names spelled
verbatim (`benchmark-channel-one`, `benchmark-channel-two`), each an object with
`title`/`body`/`call_to_action`. The CTAs must match the prompt's strings
character for character including the trailing period. Adapt title *and* body
per channel — channel one leans pre-registration, channel two leans reproduce-it
— don't just paste the source draft twice with different CTAs.

## Method that worked

Two python3 heredocs (one for digest+rollup, one for fanout) plus a heredoc for
the markdown, then a single validation script asserting every structural
requirement: exact key sets, integer types, digest-join identity, frontmatter
fields, blocklist substring scan, exact CTA match, bodies differ. That caught
nothing this pass, but it's ~30 seconds and it's the only way to be sure the
key-set and CTA requirements are literally met. Nothing needed a second attempt.
