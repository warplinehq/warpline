/**
 * Public `warpline/unstable-result` subpath: constructing a plugin's own result
 * and reading a declared dependency's.
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
 * **One entry, not two.** The reader below returns an `OutputRecord`, which is
 * the same schema family the builders construct — producing a result and
 * reading one are two halves of one subject. A second exports-map entry needs a
 * naming argument, which is the precedent this repository set when it chose one
 * `unstable-runtime` subpath over several, and no such argument exists here.
 *
 * Named re-exports only, never a star re-export. The `exports` map is an
 * allowlist, and a star publishes whatever the source module exports next.
 * `./runtime/outputs.js` is a small module today and the next thing added to it
 * would ship without review. The exact-set assertion in
 * `scripts/verify-tarball.sh` is what holds the line: a widened set reddens the
 * release gate on the day it lands rather than after it ships. That literal and
 * this file are edited together, or the gate says so.
 *
 * Do not widen this re-export without a decision record.
 */

export {
  skillOk,
  skillFailure,
} from './runtime/result-builders.js'

export {
  readDependencyOutput,
} from './runtime/outputs.js'
