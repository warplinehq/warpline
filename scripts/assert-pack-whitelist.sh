#!/usr/bin/env bash
#
# Assert the tarball npm would publish contains ONLY whitelisted paths.
#
# `npm pack --dry-run` decides the exact bytes that leave this repository
# forever. This script machine-checks that listing against the
# whitelist in BOTH directions, so a `files` regression is caught on the push
# that introduces it rather than on publish day:
#
#   1. DENYLIST — no source, tooling or planning directory, no bun-specific
#      config or lock file, no npm name-holding stub. These are the categories
#      the phase SPEC's acceptance line names explicitly.
#   2. ALLOWLIST — every listed path sits under one of the six whitelisted
#      roots, or is `package.json`, which npm always includes. This is the half
#      that catches a NEW `files` entry added without review; a denylist alone
#      cannot, because it does not know what it has not been told to reject.
#
# The allowlist is hardcoded here on purpose. Deriving it from `package.json`'s
# `files` array would make the script agree with any widening of that array —
# which is precisely the regression it exists to catch.
#
# Note on `examples/`: the shipped example plugins carry `handler.test.ts`
# files importing `bun:test` (RESEARCH A5). They ship, they are inert unless
# executed, and they are covered by the allowlist as ordinary members of the
# whitelisted `examples/` root — not by an exception. If that judgement ever
# changes, narrow the `files` entry; do not special-case it here.
#
# Runnable standalone from a developer machine as well as from CI: the
# ROADMAP's publish pre-flight names this review as a condition of the gate
# that the publish step reads, and a script beats a human reading a file listing.
# Every assertion is a hard failure, never a warning. `--dry-run` writes no
# tarball, so this leaves the working tree clean.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

fail() {
  echo "FAIL: $*" >&2
  echo >&2
  echo "Full pack listing:" >&2
  echo "$PACKED" | sed 's/^/  /' >&2
  exit 1
}

# `--json` on stdout, `prepack` chatter on stderr. Parsed with node rather than
# scraped out of the human `npm notice` block, whose format is not contract.
# `prepack` rebuilds dist/, so a stale build cannot be measured.
PACKED="$(
  npm pack --dry-run --json 2>/dev/null \
    | node -e 'for (const f of JSON.parse(require("fs").readFileSync(0, "utf8"))[0].files) console.log(f.path)'
)"
[ -n "$PACKED" ] || { echo "FAIL: npm pack --dry-run listed no files" >&2; exit 1; }

# ── 1. Denylist ──────────────────────────────────────────────────────────
#
# Kept deliberately in step with scripts/verify-tarball.sh's FORBIDDEN pattern
# so the two gates speak one vocabulary, widened by the tooling directories and
# build config that live at the repo root.

DENIED_RE='(^|/)(src|test-utils|npm-stub|scripts|skills|\.planning|\.github|\.claude|\.claude-plugin)/|(^|/)(bunfig\.toml|bun\.lock|__test_preload\.ts|tsconfig\.json|tsconfig\.build\.json)$'
DENIED="$(echo "$PACKED" | grep -E "$DENIED_RE" || true)"
[ -z "$DENIED" ] || fail "tarball would ship excluded paths:"$'\n'"$(echo "$DENIED" | sed 's/^/  /')"

# ── 2. Allowlist ─────────────────────────────────────────────────────────
#
# The six `files` roots, plus the package.json npm always adds.

ALLOWED_RE='^(dist|docs|examples)/|^(README\.md|LICENSE|NOTICE|package\.json)$'
STRAY="$(echo "$PACKED" | grep -vE "$ALLOWED_RE" || true)"
[ -z "$STRAY" ] || fail "tarball would ship paths outside the whitelisted roots:"$'\n'"$(echo "$STRAY" | sed 's/^/  /')"$'\n'"(whitelisted: dist/ docs/ examples/ README.md LICENSE NOTICE package.json)"

echo "OK: pack whitelist holds — $(echo "$PACKED" | wc -l | tr -d ' ') files, all within the whitelisted roots"
