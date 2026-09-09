#!/usr/bin/env bash
#
# Assert this commit is safe to publish under the given release tag.
#
# Two conditions, both fatal:
#
#   1. TAG == VERSION — the release tag, with a leading `v` stripped, equals
#      `package.json`'s version. A tag that disagrees with the manifest means
#      the bytes being uploaded are not the ones the tag names, and nothing
#      downstream can tell the difference afterwards.
#   2. NO NAME-HOLDING STUB — the directory that reserves the bare registry
#      name is absent. It exists only until the first real upload and must be
#      deleted in the same change (see CLAUDE.md); shipping while it is still
#      present means the repository is in a half-migrated state.
#   3. EVERY VERSION-BEARING MANIFEST AGREES with package.json. There are two
#      besides it, and they ship to a different place by a different route:
#      the marketplace entry and the plugin manifest are read by Claude Code,
#      not by npm, so a release can be correct on the registry and wrong in
#      the marketplace with nothing to say so. The marketplace `version` is
#      what decides whether an installed user receives an update at all —
#      without it they track the commit SHA and take every push with no
#      rollback — so a stale one is worse than a missing one: it pins users to
#      a number that no longer describes what they get.
#
# Why this runs before every upload-adjacent step and not after: the upload is
# irreversible. The correction path is `npm deprecate` plus a new version
# number — never an unpublish — and a version number is never reused. An
# assertion placed after the upload is decoration.
#
# Both conditions are evaluated before either can exit, so a commit that is
# wrong in both ways reports both rather than sending someone round the loop
# twice. Each failure names the values it compared, because "assertion failed"
# on a release run tells you nothing you can act on.
#
# A separate script rather than an inline workflow step so the same logic can
# be exercised without cutting a release — which is the only way to know the
# guard fires at all. A guard nobody has watched fail is not a guard. Run it
# from a developer machine as:
#
#   bash scripts/assert-release-tag.sh "v$(node -p "require('./package.json').version")"
#
# Exits 0 on success, 1 on a failed assertion, 2 on a usage error.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

TAG="${1:-}"
if [ -z "$TAG" ]; then
  echo "usage: ${BASH_SOURCE[0]} <release-tag>    (for example: v0.1.0)" >&2
  exit 2
fi

# The directory reserving the bare registry name. Named once, in a variable, so
# the string exists in exactly one place in this script.
STUB=npm-stub

VERSION="$(node -p "require('./package.json').version")"
TAG_VERSION="${TAG#v}"

rc=0

if [ "$TAG_VERSION" != "$VERSION" ]; then
  echo "FAIL: release tag '${TAG}' (version part '${TAG_VERSION}') does not equal package.json version '${VERSION}'" >&2
  rc=1
fi

if [ -d "$STUB" ]; then
  echo "FAIL: '${STUB}/' is still present at this commit; the directory reserving the bare registry name must be deleted before a real release (see CLAUDE.md)" >&2
  rc=1
fi

# Read with node rather than a grep, because both are JSON and the marketplace
# one nests its version inside `plugins[]` — a line-oriented match would find
# the wrong field the moment either file gains another. A file that is absent
# or unparseable reports as such and fails: "could not look" is not "agrees".
check_manifest_version() {
  local path="$1" expr="$2" found
  if [ ! -f "$path" ]; then
    echo "FAIL: '${path}' is missing; it must carry a version matching package.json '${VERSION}'" >&2
    rc=1
    return
  fi
  if ! found="$(node -p "try{const v=$expr;typeof v==='string'?v:''}catch(e){''}" 2>/dev/null)" || [ -z "$found" ]; then
    echo "FAIL: could not read a version string from '${path}'" >&2
    rc=1
    return
  fi
  if [ "$found" != "$VERSION" ]; then
    echo "FAIL: '${path}' version '${found}' does not equal package.json version '${VERSION}'" >&2
    rc=1
  fi
}

check_manifest_version ".claude-plugin/marketplace.json" \
  "require('./.claude-plugin/marketplace.json').plugins.find(p=>p.name==='warpline').version"
check_manifest_version "plugin/.claude-plugin/plugin.json" \
  "require('./plugin/.claude-plugin/plugin.json').version"

if [ "$rc" -ne 0 ]; then
  exit 1
fi

echo "OK: tag '${TAG}' matches package.json version '${VERSION}', the marketplace and plugin manifests agree, and '${STUB}/' is absent"
