/**
 * Public `warpline/unstable-result` subpath: constructing a plugin's own result.
 *
 * UNSTABLE, and the specifier says so rather than a changelog footnote: every
 * name behind it may change or disappear in any 0.x release. What you get is a
 * line in the release notes, and no deprecation window. Pin the version you
 * tested against.
 *
 * Why a subpath at all: a `SkillResult` is fifteen lines of which five are the
 * same five every time, and hand-writing it at every call site is how a
 * `schema_version` that disagrees with the schema's own default spreads across
 * a plugin fleet. The builders here are the one place those defaults are not
 * restated.
 *
 * **The builders, and nothing beside them.** This subpath once also carried a
 * reader for what a declared dependency produced. That reader took an
 * `EngineState` as its first argument and no published specifier could
 * construct one, so no plugin could ever call it — it was removed rather than
 * deprecated, and what replaced it is the `dependencies` capability member,
 * which a handler reaches on its fourth parameter without importing anything.
 * A subject is not two halves of one when one half was unreachable.
 *
 * Named re-exports only, never a star re-export. The `exports` map is an
 * allowlist, and a star publishes whatever the source module exports next.
 * `./runtime/result-builders.js` is a small module today and the next thing
 * added to it would ship without review. The exact-set assertion in
 * `scripts/verify-tarball.sh` is what holds the line: a widened set reddens the
 * release gate on the day it lands rather than after it ships. That literal and
 * this file are edited together, or the gate says so — this file's own removal
 * is the case in point.
 *
 * Do not widen this re-export without a decision record.
 */

export {
  skillOk,
  skillFailure,
  skillHandoff,
} from './runtime/result-builders.js'
