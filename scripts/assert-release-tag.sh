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

if [ "$rc" -ne 0 ]; then
  exit 1
fi

echo "OK: tag '${TAG}' matches package.json version '${VERSION}', and '${STUB}/' is absent"
