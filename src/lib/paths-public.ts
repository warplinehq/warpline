/**
 * Public `warpline/lib/paths` subpath.
 *
 * Deliberately narrow: `warplineHome` is the ONLY path accessor that
 * becomes public contract at 0.1.0. `_setHome`, `stateDir`, `runsDir`,
 * `pluginsDir`, `sessionApprovalPath`, `eventsJsonlPath`, `preferencesPath`
 * and `lockPath` stay internal — a plugin author who needs one of those is
 * reaching past a seam we would then owe semver on. Do not widen this
 * re-export without a decision record.
 */
export { warplineHome } from './paths.js'
