#!/usr/bin/env bash
#
# Refuse text that names the source runtime's closed deployment.
#
# Reads the text on STDIN and exits non-zero if any line of it names one of the
# committed patterns in `.github/private-names.txt`, or one of the local-only
# terms in gitignored `.private-terms`.
#
# Three public surfaces exist that `git ls-files` cannot reach, so the guard in
# `src/__tests__/no-private-planning-refs.test.ts` has never seen any of them:
#
#   1. commit messages — now scanned by that test, which reads git log directly
#   2. the GitHub Release title and body — scanned by this script, from the
#      release workflow, on the run that publishes them
#   3. an `npm deprecate` message — published prose with no review step, and
#      the reason this script has ONE mode and reads stdin: the same command
#      covers it with no second implementation
#
# Run it by hand before sending a deprecation message, or against any prose
# about to be published:
#
#   printf '%s\n' "$YOUR_MESSAGE" | bash scripts/scan-public-surfaces.sh
#
# Failure output is a line number and nothing else. CI logs are public, so
# reproducing a matched local term into one is itself the leak this exists to
# prevent — the same rule the test file's redaction invariant follows.
#
# Exits 0 on clean input, 1 on a hit or on an input it could not observe. It
# never exits 0 because it did not look: an absent or empty name list, empty
# stdin, and a grep that could not apply the patterns are all failures.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

NAMES=.github/private-names.txt
TERMS=.private-terms

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ── 1. The committed patterns ────────────────────────────────────────────

if [ ! -f "$NAMES" ]; then
  echo "blind: ${NAMES} is absent; it is the only coverage this gate has on a CI runner" >&2
  exit 1
fi

# Word-bounding, spelled out rather than written as the backslash escape.
# That escape is a GNU extension absent from POSIX ERE, BSD grep spells the
# same thing differently, and a bash script resolves `grep` through PATH
# rather than through any shell function — so it can degrade to a literal, in
# which case every pattern matches nothing and this gate is green forever.
#
# Bounding at all, rather than a bare substring match: the shortest entry in
# the committed list is three letters and is a whole word, and unbounded it
# fires inside an ordinary English word that merely contains those letters. A
# gate that reds on its first real release body is a gate that gets bypassed.
START='(^|[^A-Za-z0-9_])'
END='([^A-Za-z0-9_]|$)'

: > "$TMP/patterns"
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in '' | '#'*) continue ;; esac
  printf '%s(%s)%s\n' "$START" "$line" "$END" >> "$TMP/patterns"
done < "$NAMES"

if [ ! -s "$TMP/patterns" ]; then
  echo "blind: ${NAMES} yielded no patterns; an empty list matches nothing and passes everything" >&2
  exit 1
fi

# ── 2. The text under test ───────────────────────────────────────────────

cat > "$TMP/input"

if ! grep -q '[^[:space:]]' "$TMP/input"; then
  echo "blind: nothing on stdin" >&2
  exit 1
fi

: > "$TMP/hits"

set +e
grep -n -i -E -f "$TMP/patterns" "$TMP/input" >> "$TMP/hits" 2> "$TMP/err"
rc=$?
set -e
if [ "$rc" -gt 1 ]; then
  echo "blind: grep -E could not apply ${NAMES} (exit ${rc}): $(cat "$TMP/err")" >&2
  exit 1
fi

# ── 3. The local-only terms ──────────────────────────────────────────────
#
# Absent means an empty local list rather than an error: CI cannot have this
# file, and that is the documented trade the test file makes one level down.
# Whoever holds the file is the one who runs the fuller check.
#
# Matched as FIXED strings and deliberately NOT word-bounded, which is where
# this diverges from the test file's `bounded()` helper. A term written down by
# a holder is a domain, a handle or a path, so escaping it into a pattern is
# where that helper's three silent failure modes live; `-F` has none of them,
# and over-matching is the safe direction for a list nobody can review here.

if [ -f "$TERMS" ]; then
  grep -v -e '^[[:space:]]*$' -e '^#' "$TERMS" > "$TMP/terms" || true
  if [ -s "$TMP/terms" ]; then
    set +e
    grep -n -i -F -f "$TMP/terms" "$TMP/input" >> "$TMP/hits" 2> "$TMP/err"
    rc=$?
    set -e
    if [ "$rc" -gt 1 ]; then
      echo "blind: grep -F could not apply ${TERMS} (exit ${rc}): $(cat "$TMP/err")" >&2
      exit 1
    fi
  fi
fi

# ── 4. Report ────────────────────────────────────────────────────────────

SCANNED="$(awk 'END { print NR }' "$TMP/input")"

if [ -s "$TMP/hits" ]; then
  echo "FAIL: this text names the source runtime's closed deployment" >&2
  cut -d: -f1 "$TMP/hits" | sort -n -u | while IFS= read -r n; do
    echo "  line ${n}" >&2
  done
  echo "  (no matched text is reproduced here on purpose — CI logs are public)" >&2
  exit 1
fi

echo "OK: scanned ${SCANNED} lines, no private deployment name"
