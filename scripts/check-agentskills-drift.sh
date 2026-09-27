#!/usr/bin/env bash
#
# Assert the upstream Agent Skills rule sources still hash to the values
# committed in .github/agentskills-upstream.sha256.
#
# `src/__tests__/skills.test.ts` copies the SKILL.md frontmatter rules out of
# the Agent Skills specification, the skills-ref validator and parser, and
# Anthropic's skill-creator quick_validate.py. A copy goes stale silently:
# upstream tightens a rule, the vendored test keeps passing, and a skill this
# repository ships stops loading in a stricter client. This script is the
# tripwire. It fetches each upstream file, hashes it, and compares
# the hash to the committed one.
#
# The URLs are the `main` raw URLs on purpose. A raw URL pinned to a commit is
# content-addressed and can never change, so hashing one could never report
# drift. The commit the rules were read at is cited in `skills.test.ts`, and it
# is bumped together with these hashes after the rules are re-read.
#
# Exit contract, the only thing callers read:
#
#   0  every file matches its committed hash
#   1  drift: a hash changed, the hash file is missing, empty or malformed, a
#      URL is outside https://raw.githubusercontent.com/, or the server answered
#      with any status other than 200 (a 404 counts as drift: the file moved)
#   3  network failure: curl itself exited non-zero (DNS, connect, timeout)
#
# The status is read with `-w '%{http_code}'`, never from curl's exit code. With
# its fail-on-error flag, curl over HTTP/2 reports a 404 as exit 56, which is
# indistinguishable from a dropped connection, and a moved file would then pass
# as a network blip. For the same reason curl is never piped into the hasher:
# under pipefail a transport failure would surface as a hash mismatch.
#
# Fetched bytes land in a mktemp file and are only hashed. They are never
# executed, sourced or parsed. URLs come from a tracked data file, are passed to
# curl quoted and literally, and are prefix-checked before any fetch.
#
# This is network-bound, so it lives outside `bun test`. A weekly workflow runs
# it, and an opt-in pre-push hook runs it with exit 3 downgraded to a warning.
# bash 3.2-safe: /bin/bash on macOS is 3.2.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HASHES="$ROOT/.github/agentskills-upstream.sha256"

[ -s "$HASHES" ] || { echo "drift: $HASHES is missing or empty" >&2; exit 1; }

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

if command -v sha256sum >/dev/null 2>&1; then
  hasher() { sha256sum "$1"; }
else
  hasher() { shasum -a 256 "$1"; }
fi

n=0
lineno=0
while read -r want url || [ -n "${want:-}" ]; do
  lineno=$((lineno + 1))
  case "$want" in
    *[!0-9a-f]*) bad=1 ;;
    *) bad=0 ;;
  esac
  if [ "$bad" -ne 0 ] || [ "${#want}" -ne 64 ] || [ -z "${url:-}" ]; then
    echo "drift: line $lineno of $HASHES is not '<64 lowercase hex>  <url>'" >&2
    exit 1
  fi
  case "$url" in
    https://raw.githubusercontent.com/*) ;;
    *) echo "drift: refusing a URL outside https://raw.githubusercontent.com/ on line $lineno" >&2; exit 1 ;;
  esac

  rc=0
  code="$(curl -sS --connect-timeout 10 --max-time 30 -o "$tmp" -w '%{http_code}' "$url")" || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "drift: network failure (curl exit $rc) for $url" >&2
    exit 3
  fi
  if [ "$code" != "200" ]; then
    echo "drift: HTTP $code for $url" >&2
    exit 1
  fi

  got="$(hasher "$tmp" | cut -d' ' -f1)"
  if [ "$got" != "$want" ]; then
    echo "drift: $url changed (got $got, committed $want)" >&2
    exit 1
  fi
  n=$((n + 1))
  want=""
  url=""
done < "$HASHES"

[ "$n" -gt 0 ] || { echo "drift: no entries read from $HASHES" >&2; exit 1; }

echo "OK: $n upstream files match their committed hashes"
