/**
 * Resolve the credential names a manifest declares, or fail naming them.
 *
 * Warpline holds no credential. There is no vault here, no `.env` file this
 * module reads and no file it writes: resolution is a read of the process
 * environment at invocation, and the values live exactly as long as the call.
 * That is the strongest form of protection at rest available to this runtime,
 * because it leaves nothing at rest — an operator who copies or syncs the
 * warpline home ships no declared credential with it.
 *
 * Three decisions a later reader would otherwise assume went the other way:
 *
 *   - **Exact key equality.** A declared name is looked up as written. No case
 *     folding, no trimming, no prefix convention. A convention would mean a
 *     manifest declaring `API_TOKEN` could be satisfied by a variable nobody
 *     declared, and the point of the declaration is that it is the whole list.
 *
 *   - **An empty string counts as ABSENT.** `FOO=` is a broken credential, not
 *     a present one. Admitting it hands the handler a token that cannot work
 *     and moves the failure to wherever that token is first used — which is
 *     precisely the "after" this check exists to get in front of.
 *
 *   - **The message names the key and never the value.** Same discipline the
 *     config channel carries for the same reason: this string lands in a run
 *     log, and a run log is a file people paste into issues. Omit the value; do
 *     not mask it. A masking heuristic is a list of things that look like
 *     secrets and it leaks the first one it fails to recognise.
 *
 * The resolved map is returned rather than discarded so a caller that has a
 * place to hand it has one. `invokePlugin` today reads only `ok`: nothing in
 * the runtime hands these values anywhere, and a value that reaches a run
 * artifact, an event or a `SkillResult` is the leak this whole module is shaped
 * to avoid.
 */
import type { PluginManifest } from '../schemas/plugin-manifest.js'

/** Every declared name resolved to a non-empty value. */
export interface SecretsResolved {
  ok: true
  /** Declared name to the value read. Never logged, never persisted. */
  values: Record<string, string>
}

/** At least one declared name did not resolve. */
export interface SecretsUnresolved {
  ok: false
  /**
   * The error taxonomy code this failure carries.
   *
   * `auth_failure`, and the classification belongs here rather than at the call
   * site: a credential the environment does not provide is an authentication
   * problem, not a malformed document, and the two arms of the pre-flight above
   * the retry loop would otherwise be one indistinguishable code. It also
   * carries the right retryability for free — `DEFAULT_RETRYABLE.auth_failure`
   * is already `false`, so `makeSkillError` needs no override.
   */
  code: 'auth_failure'
  /** The declared names that did not resolve, in declaration order. */
  missing: string[]
  /** Caller-ready failure text: names the keys and the field, never a value. */
  message: string
}

export type SecretsResolution = SecretsResolved | SecretsUnresolved

/**
 * Resolve every name in `manifest.secrets` against the environment.
 *
 * `manifest.secrets ?? []` because a manifest that bypassed zod parse has no
 * `secrets` key at all — the same tolerance the config resolution and the retry
 * defaults in `invoke-plugin.ts` already rely on. A manifest declaring nothing
 * and one declaring `[]` are the same call: the check runs and passes.
 *
 * @param manifest - The plugin's manifest, parsed or not.
 * @param env - The environment to resolve against. Defaults to `process.env`;
 *   the parameter exists so a caller can resolve against something else, not so
 *   this function can be tested without one.
 */
export function resolveSecrets(
  manifest: PluginManifest,
  env: Record<string, string | undefined> = process.env,
): SecretsResolution {
  const declared = manifest.secrets ?? []
  const values: Record<string, string> = {}
  const missing: string[] = []

  for (const name of declared) {
    const value = env[name]
    if (value === undefined || value === '') missing.push(name)
    else values[name] = value
  }

  if (missing.length === 0) return { ok: true, values }

  const plural = missing.length === 1 ? 'credential' : 'credentials'
  return {
    ok: false,
    code: 'auth_failure',
    missing,
    message:
      `declares ${plural} on \`secrets\` that the environment does not provide: ` +
      `${missing.join(', ')}. Set each one before the run — an environment ` +
      `variable set to the empty string counts as unset. Warpline resolves ` +
      `these names and stores no value.`,
  }
}
