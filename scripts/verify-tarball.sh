#!/usr/bin/env bash
#
# Verify the packaged artifact end to end, from a checkout, before publish.
#
# Packs the tarball, installs it into a throwaway --prefix (never the real
# global root), and asserts the four things a checkout cannot prove:
#
#   1. the `files` whitelist shipped no source, tests or planning artifacts
#   2. `warpline --help` runs under Node with the tarball's bytes
#   3. the `exports` map resolves the published specifiers and REFUSES an
#      unmapped one (ERR_PACKAGE_PATH_NOT_EXPORTED)
#   4. the bin's Node floor gate prints required-vs-found and exits 1 without
#      an ERR_UNKNOWN_FILE_EXTENSION trace
#
# Check 4 lives here in bash rather than in a *.test.ts on purpose: plan 02-08
# budgets the repository to exactly one spawning test file, and a Node-version
# test must spawn (D-27).
#
# Plans 02-03, 02-10 and 02-12 reuse this script rather than re-deriving the
# checks. Exits non-zero on the first failure.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PREFIX="$(mktemp -d)"
CONSUMER="$(mktemp -d)"
TARBALL=""

cleanup() {
  rm -rf "$PREFIX" "$CONSUMER"
  [ -n "$TARBALL" ] && rm -f "$REPO_ROOT/$TARBALL"
  return 0
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# ── 1. Pack, and assert the whitelist held ───────────────────────────────

echo "== npm pack"
# `prepack` rebuilds dist/, so a stale build cannot be packed (T-02-04).
TARBALL="$(npm pack --silent | tail -1)"
[ -f "$TARBALL" ] || fail "npm pack produced no tarball"

FORBIDDEN='(^|/)(src|test-utils|npm-stub|\.planning)/|(^|/)(bunfig\.toml|bun\.lock|__test_preload\.ts)$'
LEAKED="$(tar -tzf "$TARBALL" | sed 's|^package/||' | grep -E "$FORBIDDEN" || true)"
[ -z "$LEAKED" ] || fail "tarball contains excluded paths:"$'\n'"$LEAKED"

# ── 2. Install into a throwaway prefix and run the bin ───────────────────

echo "== install into $PREFIX"
npm i -g --silent --prefix "$PREFIX" "./$TARBALL"
BIN="$PREFIX/bin/warpline"
[ -x "$BIN" ] || fail "$BIN is not executable"

HELP_OUT="$("$BIN" --help)" || fail "warpline --help exited non-zero"
for cmd in plan scaffold run approve revoke; do
  echo "$HELP_OUT" | grep -qE "^  $cmd " || fail "--help does not list '$cmd'"
done

# Unknown subcommand: stderr only, exit 1.
BOGUS_OUT="$("$BIN" bogus 2>"$CONSUMER/bogus.err")" && fail "warpline bogus exited 0"
[ -z "$BOGUS_OUT" ] || fail "warpline bogus wrote to stdout: $BOGUS_OUT"
grep -q 'Unknown command' "$CONSUMER/bogus.err" \
  || fail "warpline bogus wrote no error to stderr"

# ── 3. The exports map, from a consumer that only sees the install ───────

echo "== exports map"
mkdir -p "$CONSUMER/node_modules"
ln -sfn "$PREFIX/lib/node_modules/warpline" "$CONSUMER/node_modules/warpline"

( cd "$CONSUMER" && node --input-type=module -e "
  const { runAdvance } = await import('warpline')
  if (typeof runAdvance !== 'function') { console.error('runAdvance missing'); process.exit(1) }
  const { PluginManifestSchema } = await import('warpline/schemas/plugin-manifest')
  if (!PluginManifestSchema) { console.error('PluginManifestSchema missing'); process.exit(1) }
  const { warplineHome } = await import('warpline/lib/paths')
  if (typeof warplineHome !== 'function') { console.error('warplineHome missing'); process.exit(1) }
  try {
    await import('warpline/src/runtime/engine')
    console.error('warpline/src/runtime/engine resolved; the exports map is not an allowlist')
    process.exit(1)
  } catch (err) {
    if (err.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
      console.error('expected ERR_PACKAGE_PATH_NOT_EXPORTED, got ' + err.code)
      process.exit(1)
    }
  }
" ) || fail "exports map did not behave as specified"

# ── 4. The Node floor gate (D-15) ────────────────────────────────────────

echo "== node floor gate"
SHIM="$PREFIX/lib/node_modules/warpline/dist/bin/warpline.js"
[ -f "$SHIM" ] || fail "$SHIM missing"

# process.versions.node is non-writable but configurable, and the shim reads
# it before resolving any module — so redefining it here exercises the real
# below-floor branch on a supported Node.
set +e
GATE_OUT="$(node --input-type=module -e "
  Object.defineProperty(process.versions, 'node', { value: '20.11.0' })
  await import('file://$SHIM')
" 2>&1)"
GATE_CODE=$?
set -e

[ "$GATE_CODE" -eq 1 ] || fail "below-floor gate exited $GATE_CODE, expected 1"
echo "$GATE_OUT" | grep -q '\^22\.18\.0 || >=23\.6\.0' \
  || fail "gate output omits the required range: $GATE_OUT"
echo "$GATE_OUT" | grep -q '20\.11\.0' \
  || fail "gate output omits the found version: $GATE_OUT"
if echo "$GATE_OUT" | grep -q 'ERR_UNKNOWN_FILE_EXTENSION'; then
  fail "gate leaked a resolver trace: $GATE_OUT"
fi

echo "OK: $TARBALL installs and runs under Node alone"
