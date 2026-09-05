/**
 * The type half of `warpline/unstable-capabilities`, checked where a consumer
 * would find it broken.
 *
 * `scripts/verify-tarball.sh` can prove the specifier resolves and that it
 * carries no runtime value. It cannot prove the types are there: a type leaves
 * no trace in a `dist/*.js` file, the script's temp directory has no
 * TypeScript in it, and its own comment records exactly that. So the runtime
 * half is asserted there and the type half is asserted here, by the compiler
 * that already runs over this tree.
 *
 * The import below is the BARE published specifier, not a relative path. It
 * resolves by package self-reference through `package.json`'s `exports` map
 * into `dist/`, which is the same path a stranger with the tarball installed
 * takes — so this fails if the `exports` entry is missing, if the `.d.ts` was
 * not emitted, or if a name behind the barrel was renamed without the barrel
 * being updated. A relative import would check none of those three.
 *
 * **`.types.ts`, deliberately, and not `.test.ts`.** `tsconfig.json` includes
 * `src/**\/*.ts`, so `tsc --noEmit` reads this file; `tsconfig.build.json`
 * excludes `src/**\/__tests__/**`, so nothing here is emitted. The runner
 * matches `*.test.ts` and never opens this file, which is what it should do
 * with a file that contains no test — a `.test.ts` carrying only type
 * declarations is a file the runner reports as having found nothing.
 *
 * There is no assertion to read below because there is nothing to assert at
 * run time. Each name is used in a position where a wrong or absent type is a
 * compile error, and that IS the check.
 */
import type {
  CapabilityCaller,
  CapabilityContext,
  CapabilityGrantWitness,
  CapabilityHandlerFn,
  SecretsHandle,
} from 'warpline/unstable-capabilities'

/**
 * The object a handler is handed. The two named keys are what an author can
 * reach without a cast, and writing them out is what pins them: an empty
 * literal no longer satisfies this type, which is the point — a context
 * missing `secrets` or `caller` is one production cannot produce.
 */
const _caller: CapabilityCaller = { plugin: 'some-plugin', runId: 'some-run' }
const _handle: SecretsHandle = { resolvedNames: (_c: CapabilityCaller) => ['SOME_TOKEN'] }
const context: CapabilityContext = { caller: _caller, secrets: _handle }
const _members: readonly string[] = Object.keys(context)

/** The caller argument, supplied the way a plugin author would supply it. */
const _names: readonly string[] = context.secrets.resolvedNames(context.caller)

/**
 * Both arms of the witness, written out. A union narrowed to one arm would
 * still compile if the other were removed, which is the drift this pins.
 */
const _granted: CapabilityGrantWitness = { granted: true, scope: 'some-plugin' }
const _manual: CapabilityGrantWitness = { granted: false, reason: 'manual-run' }
const _ungated: CapabilityGrantWitness = { granted: false, reason: 'no-declared-side-effects' }

/**
 * A handler written the way a plugin author would write one against the
 * published surface: four parameters, the fourth typed from the specifier.
 * The parameters are inferred from the type rather than annotated, so a
 * changed arity or a changed fourth parameter is a compile error here.
 */
const _handler: CapabilityHandlerFn = async (manifest, args, signal, capabilities) => ({
  status: 'success',
  phases_completed: [manifest.name],
  phases_failed: [],
  data_freshness: {},
  summary: `${Object.keys(args).length} args, ${signal.aborted}, ${Object.keys(capabilities).length} members`,
  artifacts_produced: [],
})

export type {
  CapabilityCaller,
  CapabilityContext,
  CapabilityGrantWitness,
  CapabilityHandlerFn,
  SecretsHandle,
}
export { context, _caller, _handle, _members, _names, _granted, _manual, _ungated, _handler }
