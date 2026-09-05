/**
 * Public `warpline/unstable-capabilities` subpath: the types a plugin author
 * needs to write the fourth handler parameter down, and the type a host needs
 * to call the runtime at all.
 *
 * UNSTABLE, and the specifier says so rather than a changelog footnote: every
 * name behind it may change or disappear in any 0.x release. What you get is a
 * line in the release notes, and no deprecation window. Pin the version you
 * tested against.
 *
 * **Type-only, and that is the whole promise.** Nothing here is a runtime
 * value, and nothing here is intended to become one. The mint function and the
 * capability registry stay internal: the registry is a table designed to grow,
 * and publishing it would owe semver on every row anybody adds. What a
 * consumer needs is the SHAPE of what it is handed and the shape of what it
 * must hand in, which is exactly the names below.
 *
 * The consequence is worth stating rather than leaving for a reader to
 * discover: `dist/unstable-capabilities.js` contains no exported value at all,
 * so the export-set assertion `scripts/verify-tarball.sh` runs against this
 * specifier is an assertion that the set is EMPTY. That assertion is not
 * ceremony — it is what reddens the day a runtime value leaks into a barrel
 * whose entire promise is that it carries none, and it is the only half of
 * this file a tarball can see. The types are proven reachable by a typecheck
 * that imports them through this specifier, because a type leaves no trace in
 * a `dist/*.js` file and only `tsc` against a consumer can check one.
 *
 * Why the grant witness is here and not merely internal: `invokePlugin` is
 * re-exported from `warpline/unstable-runtime`, and it now takes a witness as
 * a required parameter. A third-party host cannot call the runtime without
 * naming that type, so withholding it would publish a function nobody outside
 * this package could type a call to.
 *
 * Named re-exports only, never a star re-export. The `exports` map is an
 * allowlist, and a star publishes whatever the source module exports next —
 * `./runtime/capabilities.js` also holds the registry entry type and the
 * refusal record, neither of which is a consumer's business. The exact-set
 * assertion in `scripts/verify-tarball.sh` is what holds the runtime half; the
 * type probe under `src/runtime/__tests__/` is what holds this half.
 *
 * `CapabilityCaller` and `SecretsHandle` are here for the same reason the
 * witness is: every member takes a caller as its required first parameter, so
 * a plugin author calling one cannot name the argument's type without them.
 * Publishing the member's shape while withholding the type of what it demands
 * would be publishing a call nobody outside this package could write down.
 *
 * Do not widen this re-export without a decision record.
 */

export type {
  CapabilityCaller,
  CapabilityContext,
  CapabilityGrantWitness,
  SecretsHandle,
} from './runtime/capabilities.js'

export type {
  CapabilityHandlerFn,
} from './runtime/invoke-plugin.js'
