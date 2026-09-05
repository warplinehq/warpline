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
 * Deliberately narrow, and closed: the ten runtime names below plus the
 * `TierName` type are the whole surface, decided by reading every call site in
 * the hosts being migrated rather than by guessing at what might be wanted. The
 * other eleven `engine-events` exports — `_trimEventsLog`, `GateDiscardReason`,
 * `emitRunStarted`, `emitRunCompleted`, `emitPluginStarted`, `emitPluginFailed`,
 * `emitPluginSkipped`, `emitGateInvalidated`, `emitDenialRecorded`,
 * `emitPluginDenied` and `emitPluginGated` — stay internal, as does everything
 * in `engine.ts`, `tier.ts` and `invoke-plugin.ts` not named here or on the root
 * barrel. Approval and run-artifact helpers are never published from any
 * specifier.
 *
 * Named re-exports only, never a star re-export. The `exports` map is an
 * allowlist, and a star publishes whatever the source module exports next — at
 * this commit that is eleven engine-events symbols nobody reviewed for a public
 * surface. The exact-set assertion in `scripts/verify-tarball.sh` is what holds
 * it: a widened set reddens the release gate on the day it lands rather than
 * after it ships. That literal and this file are edited together, or the gate
 * says so.
 *
 * `invokePlugin` takes a grant witness as a required fourth argument: a host
 * calling it must state whether it read the approval Grant, because a runtime
 * that mints authority for a handler on the strength of a check nobody made is
 * the deputy handing it out. That parameter's type is NOT re-exported here — it
 * lives behind `warpline/unstable-capabilities`, which is type-only, and this
 * barrel stays a list of runtime values. Import it from there.
 *
 * Do not widen this re-export without a decision record.
 */

export {
  emitAttemptFailed,
  emitBoardEvent,
  emitPluginCompleted,
  makeEvent,
} from './board/engine-events.js'

export { computeTier, formatIdleDuration, isEligibleForTier } from './runtime/tier.js'

export type { TierName } from './runtime/tier.js'

export { invokePlugin } from './runtime/invoke-plugin.js'

export { loadPluginManifests, RUN_PROFILES } from './runtime/engine.js'
