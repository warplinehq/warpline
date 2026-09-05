/**
 * Public `warpline/unstable-fs` subpath.
 *
 * UNSTABLE, and the specifier says so rather than a changelog footnote: every
 * name behind it may change or disappear in any 0.x release. What you get is a
 * line in the release notes, and no deprecation window. Pin the version you
 * tested against.
 *
 * Why a subpath at all: a half-written state file is the failure `fs-atomic`
 * guards against, and a host that reimplements tmp-file-then-rename gets a
 * variant that skips a step and is indistinguishable from the real thing until
 * it does. One implementation, reachable, beats a helper copied into every
 * consumer.
 *
 * Why not `warpline/lib/fs-atomic`: the paragraph in `docs/runtime-spec.md`
 * that binds the root barrel and "the two narrow subpaths beneath it" to the
 * 0.1.0 promise would swallow a third `./lib/*` entry, which is three function
 * signatures owed semver in exchange for a nicer import. `unstable-` keeps the
 * stability marker in the import path, where it is greppable and where nobody
 * has to have read that paragraph to be warned.
 *
 * Deliberately narrow, and closed: the three functions below are the whole
 * surface. `tmpSuffix` and `bestEffortUnlink` stay internal, and not by
 * oversight — they are the two halves of the atomic write's own mechanism.
 * `tmpSuffix` is a naming convention the rename step depends on; publishing it
 * invites a caller to build the temp path itself and rename around our
 * cleanup. `bestEffortUnlink` swallows every error by design, which is correct
 * only inside a failure path that is about to rethrow and is a silent
 * data-losing `unlink` anywhere else.
 *
 * Named re-exports only, never a star re-export. The `exports` map is an
 * allowlist, and a star publishes whatever the source module exports next. The
 * exact-set assertion in `scripts/verify-tarball.sh` is what holds it: a
 * widened set reddens the release gate on the day it lands rather than after it
 * ships. That literal and this file are edited together, or the gate says so.
 *
 * Do not widen this re-export without a decision record.
 */

export {
  atomicWriteJson,
  atomicWriteText,
  readJsonOrNull,
} from './lib/fs-atomic.js'
