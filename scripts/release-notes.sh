#!/usr/bin/env bash
#
# Generate release notes for a version from the commits behind it.
#
# Why commits and not pull requests: GitHub's built-in note generator groups
# merged pull requests. This repository pushes to its default branch directly,
# so that generator has nothing to group and produces an empty body — a
# changelog that is technically automated and practically blank. Conventional
# commit subjects are what this history actually carries, so they are what this
# reads.
#
# Why a script and not an inline workflow step: the same reason the release-tag
# assertion is a script. Notes that are only ever produced inside a release run
# cannot be inspected before a release exists, and a generator nobody has
# watched run is a generator nobody can trust with the one body text that is
# permanent once published. Run it from a developer machine as:
#
#     scripts/release-notes.sh v0.1.0
#     scripts/release-notes.sh v0.2.0 v0.1.0
#
# With one argument the range starts at the previous tag, or at the root commit
# when no earlier tag exists. With two, the second is the explicit lower bound.
#
# Breaking changes are promoted to their own section ahead of everything else,
# detected two ways: the `!` marker before the colon, and a `BREAKING CHANGE:`
# footer in the body. Either alone is enough. A breaking change buried under
# "Fixes" is the failure this ordering exists to prevent — it is the one entry a
# reader must not miss, and the one most likely to be written as a fix.
#
# Output is Markdown on stdout. Nothing is written, tagged or uploaded.

set -u

usage() {
  echo "usage: scripts/release-notes.sh <version-tag> [previous-tag]" >&2
  echo "   eg: scripts/release-notes.sh v0.1.0" >&2
  exit 2
}

[ $# -ge 1 ] && [ $# -le 2 ] || usage
TAG="$1"

if [ $# -eq 2 ]; then
  FROM="$2"
  git rev-parse --verify --quiet "$FROM" >/dev/null \
    || { echo "FAIL: '$FROM' is not a ref in this repository" >&2; exit 1; }
else
  # The tag being released is usually not created yet, so exclude it when
  # looking for the one before it.
  FROM=$(git tag --sort=-v:refname | grep -v "^${TAG}$" | head -1)
fi

if [ -n "$FROM" ]; then
  RANGE="${FROM}..HEAD"
  FOOTER="**Full changelog:** \`${FROM}\`..\`${TAG}\`"
else
  RANGE="HEAD"
  FOOTER="**Full changelog:** everything up to \`${TAG}\`"
fi

# Subject lines only, oldest first so related entries read in the order they
# happened. Merge commits carry no conventional subject of their own and would
# appear as noise.
subjects() { git log --no-merges --reverse --pretty=%s "$RANGE"; }

# Subjects already printed under Breaking changes, so a type section can drop
# them. The `!` form needs no help — its `!` sits where `section`'s regex wants
# a colon, so `feat!:` never matches `^feat(\([^)]*\))?: ` in the first place.
# A footer-only breaking change is the case that does: its subject is an
# ordinary `refactor:`/`fix:` with nothing to exclude it, so it was printed
# under BREAKING and then again under its own type.
BREAKING_SUBJECTS=$(git log --no-merges --reverse --pretty=%s --grep='^BREAKING CHANGE:' "$RANGE")

# `grep -vFx` with a multi-line pattern treats each line as one fixed
# whole-line string. `|| true` because grep exits 1 when it filters everything
# out, which is a legitimate empty section and not an error.
drop_breaking() {
  if [ -n "$BREAKING_SUBJECTS" ]; then
    grep -vFx "$BREAKING_SUBJECTS" || true
  else
    cat
  fi
}

# A section per conventional type. `$1` is the type, `$2` the heading. Breaking
# subjects are excluded here because they are printed on their own above; a
# `feat!:` belongs under BREAKING, not under Features as well.
section() {
  local type="$1" heading="$2" body
  body=$(subjects \
    | grep -E "^${type}(\([^)]*\))?: " \
    | drop_breaking \
    | sed -E "s/^${type}(\([^)]*\))?: */- /" \
    | awk '!seen[$0]++')
  [ -n "$body" ] || return 0
  printf '## %s\n\n%s\n\n' "$heading" "$body"
}

# `!` before the colon, plus anything whose message body carries the footer.
# Both paths yield subject lines so they merge into one list, deduplicated for
# the common case of a commit that uses the marker AND the footer.
#
# The footer path uses git's own message search rather than parsing a delimited
# `--pretty` stream: a subject and a multi-line body cannot be split apart by a
# field delimiter without picking a byte neither may contain, and getting that
# wrong fails silently — it drops footer-only commits while the marker path
# keeps producing plausible output.
breaking() {
  {
    subjects | grep -E '^[a-z]+(\([^)]*\))?!: '
    git log --no-merges --reverse --pretty=%s --grep='^BREAKING CHANGE:' "$RANGE"
  } | awk 'NF' | awk '!seen[$0]++' | sed -E 's/^[a-z]+(\([^)]*\))?!?: */- /'
}

BREAKING_BODY=$(breaking)
if [ -n "$BREAKING_BODY" ]; then
  printf '## Breaking changes\n\n%s\n\n' "$BREAKING_BODY"
fi

section feat     'Features'
section fix      'Fixes'
section perf     'Performance'
section refactor 'Refactoring'
section docs     'Documentation'
section test     'Tests'
section ci       'CI'
section build    'Build'
section chore    'Chores'

printf '%s\n' "$FOOTER"
