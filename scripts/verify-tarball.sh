#!/usr/bin/env bash
#
# Verify the packaged artifact end to end, from a checkout, before publish.
#
# Packs the tarball, installs it into a throwaway --prefix (never the real
# global root), and asserts the six things a checkout cannot prove:
#
#   1. the `files` whitelist shipped no source, tests or planning artifacts
#   2. `warpline --help` runs under Node with the tarball's bytes
#   3. the `exports` map resolves every published specifier — under Node AND
#      Bun — exposes exactly one path accessor, ships no filesystem helper and
#      no removed field behind `schemas/run-log`, exposes exactly the decided
#      symbol set behind `unstable-runtime` and no never-published name, and
#      REFUSES an unmapped subpath (ERR_PACKAGE_PATH_NOT_EXPORTED)
#   4. the bin's Node floor gate prints required-vs-found and exits 1 without
#      an ERR_UNKNOWN_FILE_EXTENSION trace
#   5. `warpline scaffold` writes a plugin carrying no absolute path, and a
#      `<warplineHome>/node_modules/warpline` symlink into the install
#   6. Node can import BOTH generated files for real — the assertion that
#      fails with ERR_MODULE_NOT_FOUND without that symlink
#
# Checks 5 and 6 are the whole reason this script exists rather than a test:
# the scaffold defects do not reproduce from a checkout, where warpline's own
# source is always reachable. Check 4 lives here in bash rather than in a
# *.test.ts because the repository budgets itself to exactly one spawning
# test file, and a Node-version test must spawn.
#
# Two things run this, so it is not a gate anybody has to remember. The release
# workflow runs it after the whitelist check and before `npm publish`, which is
# the last point at which a broken install is still correctable. On a developer
# machine it is `bun run verify:tarball`.
#
# Its exit status is read as evidence by the release workflow, so every
# assertion here is a hard failure and never a warning. Exits non-zero on the
# first one.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PREFIX="$(mktemp -d)"
CONSUMER="$(mktemp -d)"
WL_HOME="$(mktemp -d)"
TARBALL=""

cleanup() {
  rm -rf "$PREFIX" "$CONSUMER" "$WL_HOME"
  [ -n "$TARBALL" ] && rm -f "$REPO_ROOT/$TARBALL"
  return 0
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# ── 0. Make sure nothing shadows the prefix under test ───────────────────
#
# A stale global install from an earlier tarball is the documented way this
# script silently passes against the wrong bytes. Removing it is a no-op (exit
# 0) when absent.
npm rm -g warpline >/dev/null 2>&1 || true

# ── 1. Pack, and assert the whitelist held ───────────────────────────────

echo "== npm pack"
# `prepack` rebuilds dist/, so a stale build cannot be packed.
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
#
# Every published specifier must resolve to ONE target, from the packed bytes,
# under both runtimes — the invariant that replaced the earlier `bun` export
# condition (which Bun resolves to a path the tarball does not contain, and
# then errors instead of falling through to `default`).
#
# The consumer is a scratch directory rather than the install itself because
# Node refuses type stripping under a `node_modules` directory, so the
# shipped example `.ts` files cannot be imported from inside the install at all.

echo "== exports map"
mkdir -p "$CONSUMER/node_modules"
ln -sfn "$PREFIX/lib/node_modules/warpline" "$CONSUMER/node_modules/warpline"

# `.mjs`, and no package.json in the consumer: the module type must not depend
# on anything the consumer happens to have.
cat > "$CONSUMER/specifiers.mjs" <<'SPECIFIERS'
const { runAdvance } = await import('warpline')
if (typeof runAdvance !== 'function') { console.error('runAdvance missing'); process.exit(1) }

const { PluginManifestSchema } = await import('warpline/schemas/plugin-manifest')
if (!PluginManifestSchema) { console.error('PluginManifestSchema missing'); process.exit(1) }

// `warpline/schemas/skill-result` ships shapes and nothing else from 0.3.0. One
// helper left it, `resolveOutput`, because `./schemas/*` is a wildcard export
// and a helper under that directory is public API for disk I/O by accident —
// here a single synchronous existence check, inside a function small enough to
// look free, behind a specifier whose name promises declarative shapes. Nothing
// verified what this subpath exported before this probe, which is how it
// survived a release.
const skillResult = await import('warpline/schemas/skill-result')

// Defined BEFORE enumerate, and the ordering is the whole assertion:
// enumerating keys off an undefined export finds none of the moved names and
// reports success. That vacuous pass is what this probe exists to refuse.
for (const name of ['SkillResultSchema', 'OutputRecordSchema']) {
  if (!(name in skillResult) || !skillResult[name]) {
    console.error('warpline/schemas/skill-result did not export ' + name)
    process.exit(1)
  }
}

// Enumerated off `SkillResultSchema`, the plain object schema, and off nothing
// else. `OutputRecordSchema` carries a refinement, so whether it exposes
// `.shape` is a zod-version detail; reading it here would turn a version bump
// into a throw inside the probe that reads as a probe bug rather than a
// finding. Existence is all this probe needs from it.
const resultShape = skillResult.SkillResultSchema.shape
if (!resultShape || Object.keys(resultShape).length === 0) {
  console.error('warpline/schemas/skill-result: SkillResultSchema exposes no shape to enumerate')
  process.exit(1)
}

// The subpath resolves, so this is not the allowlist-refusal shape: the module
// is there and the name must not be on it. `in` rather than `typeof`, so a
// re-export that resolves to `undefined` still trips it.
const SR_MOVED = ['resolveOutput']
const srReachable = SR_MOVED.filter((n) => n in skillResult)
if (srReachable.length) {
  console.error('warpline/schemas/skill-result still reaches filesystem helpers: ' + srReachable.join(', '))
  process.exit(1)
}
console.log('   warpline/schemas/skill-result: ' + Object.keys(resultShape).length + ' fields, no helper')

// `warpline/schemas/run-log` ships shapes and nothing else from 0.2.0. Six
// fields left it — nothing wrote them and no document described them — and
// seven filesystem helpers left with them, because `./schemas/*` is a wildcard
// export and a helper under that directory is public API for disk I/O by
// accident. Nothing verified what this subpath exported before this probe,
// which is how both survived a release.
const runLog = await import('warpline/schemas/run-log')

// Defined BEFORE shape, and the ordering is the whole assertion: enumerating
// keys off an undefined export finds none of the removed names and reports
// success. That vacuous pass is what this probe exists to refuse.
for (const name of ['RunLogSchema', 'PluginLogEntrySchema']) {
  if (!(name in runLog) || !runLog[name]) {
    console.error('warpline/schemas/run-log did not export ' + name)
    process.exit(1)
  }
}

const shape = runLog.RunLogSchema.shape
if (!shape || Object.keys(shape).length === 0) {
  console.error('warpline/schemas/run-log: RunLogSchema exposes no shape to enumerate')
  process.exit(1)
}

const REMOVED = [
  'metrics_summary', 'modes_run', 'tasks_surfaced',
  'tasks_resolved', 'deferrals_active', 'verification_results',
]
const stillShipped = REMOVED.filter((f) => f in shape)
if (stillShipped.length) {
  console.error('warpline/schemas/run-log still ships removed fields: ' + stillShipped.join(', '))
  process.exit(1)
}

// The subpath resolves, so this is not the allowlist-refusal shape: the module
// is there and the names must not be on it.
const MOVED = [
  'ensureRunDir', 'runLogFilename', 'writeRunLog', 'pruneRunLogs',
  'isRunLogRetained', 'resolveRunRef', 'describeRunRef',
]
const reachable = MOVED.filter((n) => n in runLog)
if (reachable.length) {
  console.error('warpline/schemas/run-log still reaches filesystem helpers: ' + reachable.join(', '))
  process.exit(1)
}
// The mirror of the absence list above. That one catches a removed field that
// came back; this one catches a field this runtime writes and this document
// describes that never reached the published shape — a schema edit left in the
// working tree ships as a silently absent field, and every reader of the
// artifact sees undefined where it should see a count.
const REQUIRED = ['manifests_loaded']
const missingRequired = REQUIRED.filter((f) => !(f in shape))
if (missingRequired.length) {
  console.error('warpline/schemas/run-log does not ship required fields: ' + missingRequired.join(', '))
  process.exit(1)
}

console.log('   warpline/schemas/run-log: ' + Object.keys(shape).length + ' fields, no removed name, no helper')
console.log('   warpline/schemas/run-log: required field present: ' + REQUIRED.join(', '))

// `warpline/schemas/engine-state` ships shapes and nothing else from 0.3.0.
// Five persistence exports left it, because `./schemas/*` is a wildcard export
// and a helper under that directory is public API for disk I/O by accident —
// here, read and write access to the engine's own state document behind a
// specifier whose name promises declarative shapes. Nothing verified what this
// subpath exported before this probe, which is how it survived a release.
const engineState = await import('warpline/schemas/engine-state')

// Defined BEFORE enumerate, and the ordering is the whole assertion:
// enumerating keys off an undefined export finds none of the moved names and
// reports success. That vacuous pass is what this probe exists to refuse.
for (const name of ['EngineStateSchema', 'PendingGateSchema']) {
  if (!(name in engineState) || !engineState[name]) {
    console.error('warpline/schemas/engine-state did not export ' + name)
    process.exit(1)
  }
}

const stateShape = engineState.EngineStateSchema.shape
if (!stateShape || Object.keys(stateShape).length === 0) {
  console.error('warpline/schemas/engine-state: EngineStateSchema exposes no shape to enumerate')
  process.exit(1)
}

// The subpath resolves, so this is not the allowlist-refusal shape: the module
// is there and the names must not be on it. `in` rather than `typeof`, so a
// re-export that resolves to `undefined` still trips it.
const STATE_MOVED = [
  'readEngineState', 'readEngineStateReadOnly', 'writeEngineState',
  'withoutStateBackups', 'EngineStateInvalidError',
]
const stateReachable = STATE_MOVED.filter((n) => n in engineState)
if (stateReachable.length) {
  console.error('warpline/schemas/engine-state still reaches filesystem helpers: ' + stateReachable.join(', '))
  process.exit(1)
}
console.log('   warpline/schemas/engine-state: ' + Object.keys(stateShape).length + ' fields, no helper')

// Exactly one path accessor is public contract at 0.1.0. A wider export
// list here means something internal acquired a semver obligation by accident.
const paths = await import('warpline/lib/paths')
const exported = Object.keys(paths).filter((k) => k !== 'default').sort().join(',')
console.log('   warpline/lib/paths exports: ' + exported)
if (exported !== 'warplineHome') {
  console.error('expected exactly warplineHome, got ' + exported)
  process.exit(1)
}
if (typeof paths.warplineHome !== 'function') { console.error('warplineHome is not callable'); process.exit(1) }

// `warpline/unstable-runtime` is the deliberately-unstable subpath: every name
// behind it may change or vanish in any 0.x release, with a release-note line
// and no deprecation window. An exact set rather than a presence check, so an
// accidental `export *` in the barrel — which would publish eleven unreviewed
// engine-events symbols — reddens this on the day it lands.
//
// `TierName` and every other erased type are correctly ABSENT from this set. A
// type leaves no trace in `dist/unstable-runtime.js`, so a reader must not
// "fix" one into the literal below; `bun run typecheck` against an example is
// the only check that can see those.
//
// The set below is CLOSED. It is the whole runtime surface the hosts being cut
// over reach, decided from a read of every consuming call site rather than from
// a guess about what might be wanted, and it is not a floor to grow past
// casually. A wider observed set is an unrecorded export, which is what the
// `!==` refuses; the literal and the barrel are edited together or this reddens.
const unstable = await import('warpline/unstable-runtime')

// Defined BEFORE the export set is enumerated, and the ordering is the whole
// assertion: enumerating keys off an undefined export finds none of the
// never-published names and reports success. That vacuous pass is what this
// probe exists to refuse. `in` rather than `typeof`, so a re-export that
// resolves to `undefined` still trips it.
const NEVER_PUBLISHED = [
  'checkApproval', 'grantApproval', 'revokeApproval',
  'writeRunArtifact', 'getRunsDir', 'trimPluginHistory',
]

const UNSTABLE_EXPECTED = 'RUN_PROFILES,computeTier,emitAttemptFailed,emitBoardEvent,emitPluginCompleted,formatIdleDuration,invokePlugin,isEligibleForTier,loadPluginManifests,makeEvent'

const unstableExports = Object.keys(unstable).filter((k) => k !== 'default').sort().join(',')
console.log('   warpline/unstable-runtime exports: ' + unstableExports)
if (unstableExports !== UNSTABLE_EXPECTED) {
  console.error('expected exactly ' + UNSTABLE_EXPECTED + ', got ' + unstableExports)
  process.exit(1)
}

const neverReachable = NEVER_PUBLISHED.filter((n) => n in unstable)
if (neverReachable.length) {
  console.error('warpline/unstable-runtime reaches never-published names: ' + neverReachable.join(', '))
  process.exit(1)
}

// Every other check in this file is a shape assertion: a name is exported, a
// specifier resolves, a set matches. An artifact that shipped the documentation
// for the plugin-root refusal and none of the behaviour would pass all of them.
// So this one calls the thing and reads what comes back.
//
// The rejection precedes every write in `runAdvance`, so there is no home to
// set up here and nothing to clean up afterwards. That is itself part of what
// is being proven.
//
// The message is checked for BOTH the path and the errno, not merely for a
// rejection: a `TypeError` out of a botched build rejects too, and a bare
// rejection check would call that a pass.
const { join } = await import('node:path')
const { tmpdir } = await import('node:os')

const absentRoot = join(tmpdir(), 'warpline-verify-tarball-absent-plugin-root-' + Date.now())
let refused = null
try {
  await runAdvance({ pluginsDir: absentRoot })
} catch (err) {
  refused = err
}
if (refused === null) {
  console.error('runAdvance resolved for an absent plugin root: ' + absentRoot)
  process.exit(1)
}
if (!(refused instanceof Error)) {
  console.error('runAdvance rejected with a non-Error for an absent plugin root')
  process.exit(1)
}
if (!refused.message.includes(absentRoot) || !refused.message.includes('ENOENT')) {
  console.error('refusal names neither the path nor the errno: ' + refused.message)
  process.exit(1)
}
console.log('   plugin-root refusal: absent root rejects naming the path and ENOENT')

// The empty string is the arm that looks free. It reaches readdir unchanged
// and rejects on its own, so a build with no explicit branch for it still
// rejects here — with an errno, against the RESOLVED empty string, which is
// the working directory. Requiring the empty-string message rather than merely
// a rejection is what tells "refused" apart from "resolved to the cwd and
// happened to fail".
let emptyRefused = null
try {
  await runAdvance({ pluginsDir: '' })
} catch (err) {
  emptyRefused = err
}
if (emptyRefused === null) {
  console.error('runAdvance resolved for an empty plugin root')
  process.exit(1)
}
if (!(emptyRefused instanceof Error)) {
  console.error('runAdvance rejected with a non-Error for an empty plugin root')
  process.exit(1)
}
if (!emptyRefused.message.includes('plugin root is an empty string')) {
  console.error('empty plugin root was resolved rather than refused: ' + emptyRefused.message)
  process.exit(1)
}
console.log('   plugin-root refusal: empty root is refused, not resolved to the working directory')
SPECIFIERS

( cd "$CONSUMER" && node specifiers.mjs ) || fail "published specifiers did not resolve under node"

if command -v bun >/dev/null 2>&1; then
  ( cd "$CONSUMER" && bun specifiers.mjs ) || fail "published specifiers did not resolve under bun"
else
  echo "   SKIP: bun is not on PATH — the bun leg of the specifier check did not run"
fi

# The allowlist refusal is Node-specific (the error code is Node's), so it stays
# out of the shared script above.
( cd "$CONSUMER" && node --input-type=module -e "
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
" ) || fail "the exports map is not an allowlist"

# ── 4. The Node floor gate ───────────────────────────────────────────────

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

# ── 5. Scaffold from the install, into a throwaway warpline home ─────────
#
# This is the check that cannot exist as a *.test.ts: from a checkout, every
# specifier scaffold could possibly emit resolves, so both of the defects here
# are invisible. Run against the installed bin with WARPLINE_HOME outside the
# install, they are the first thing that breaks.

echo "== scaffold from the install"
WARPLINE_HOME="$WL_HOME" "$BIN" scaffold demo || fail "warpline scaffold demo exited non-zero"

GEN="$WL_HOME/plugins/demo"
[ -f "$GEN/manifest.ts" ] || fail "$GEN/manifest.ts was not written"
[ -f "$GEN/handler.ts" ] || fail "$GEN/handler.ts was not written"

ABSOLUTE="$(grep -hoE "from '[^']+'" "$GEN/manifest.ts" "$GEN/handler.ts" | grep -F "from '/" || true)"
[ -z "$ABSOLUTE" ] || fail "generated files carry an absolute import specifier:"$'\n'"$ABSOLUTE"

# `.ts`, never `.js`: Node's type stripping resolves the literal specifier with
# no extension remapping, so `./manifest.js` at a `.ts` file is
# ERR_MODULE_NOT_FOUND. Bun remaps it, hiding the bug from the suite.
grep -q "from '\./manifest\.ts'" "$GEN/handler.ts" \
  || fail "handler.ts does not import its sibling manifest with the .ts extension"

LINK="$WL_HOME/node_modules/warpline"
[ -L "$LINK" ] || fail "$LINK is not a symlink"
LINK_TARGET="$(cd "$LINK" && pwd -P)"
PREFIX_REAL="$(cd "$PREFIX" && pwd -P)"
echo "   symlink target: $LINK_TARGET"
case "$LINK_TARGET/" in
  "$PREFIX_REAL"/*) ;;
  *) fail "symlink resolves to $LINK_TARGET, outside the throwaway prefix $PREFIX_REAL" ;;
esac
[ -f "$LINK_TARGET/package.json" ] || fail "$LINK_TARGET holds no package.json"

# ── 6. Node imports both generated files for real ────────────────────────
#
# Both, not just the manifest: invoke-plugin.ts imports the pair, so a
# manifest-only check would miss a broken sibling specifier. Without the
# section-5 symlink these fail with ERR_MODULE_NOT_FOUND.

echo "== node imports the generated plugin"
for f in manifest handler; do
  node -e "
    import('$GEN/$f.ts')
      .then(() => console.log('   imported $f.ts'))
      .catch((err) => { console.error('   ' + (err.code || '') + ' ' + err.message); process.exit(1) })
  " || fail "node could not import the generated $f.ts"
done

echo "OK: $TARBALL installs, runs and scaffolds a working plugin under Node alone"
