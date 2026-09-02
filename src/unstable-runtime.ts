/**
 * Public `warpline/unstable-runtime` subpath.
 *
 * UNSTABLE, and the specifier says so rather than a changelog footnote: every
 * name behind it may change or disappear in any 0.x release. What you get is a
 * line in the release notes, and no deprecation window. Pin the version you
 * tested against. The root barrel is the surface with a promise on it; this one
 * exists so a host can reach the runtime before we know which parts of it we
 * are willing to owe semver on.
 *
 * Deliberately narrow: `makeEvent` is the only name published here today. The
 * other eleven `engine-events` exports — `_trimEventsLog`, `GateDiscardReason`,
 * `emitRunStarted`, `emitRunCompleted`, `emitPluginStarted`, `emitPluginFailed`,
 * `emitPluginSkipped`, `emitGateInvalidated`, `emitDenialRecorded`,
 * `emitPluginDenied` and `emitPluginGated` — stay internal for now, as does
 * everything in `engine.ts` and `invoke-plugin.ts` that the root barrel does not
 * already name.
 *
 * Named re-exports only, never a star re-export. The `exports` map is an
 * allowlist, and a star publishes whatever the source module exports next — at
 * this commit that is eleven symbols nobody reviewed for a public surface. The
 * exact-set assertion in `scripts/verify-tarball.sh` is what holds it: a widened
 * set reddens the release gate on the day it lands rather than after it ships.
 *
 * This barrel grows to the full decided symbol set in a later 0.x release, so
 * one export is a tracer through the export-publish-consume path and not the
 * final surface. Do not widen this re-export without a decision record.
 */
export { makeEvent } from './board/engine-events.js'
