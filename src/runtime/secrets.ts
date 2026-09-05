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
 * The resolved map is returned rather than discarded because there is now a
 * caller with a place to hand it: `scrubSecrets` below, which `invokePlugin`
 * runs over every handler's output at the parse boundary. The values are read for
 * that and for nothing else — they are never handed to a writer, and a value
 * that reaches a run artifact, an event, a run log or `engine-state.json` is
 * the leak this module is shaped to avoid. The resolved NAMES go to the
 * capability handle; the resolved values go to the scrubber.
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

/**
 * What replaces a resolved credential value wherever a handler put one.
 *
 * Fixed length, and longer than plenty of real credentials — so this scrub
 * GROWS a result whenever a declared value is shorter than ten bytes. That is
 * not made safe by keeping the placeholder short, which is what this docstring
 * used to claim: a short placeholder is still longer than a four-character
 * token, and the hazard it named was reachable.
 *
 * What makes it safe is ordering. An Output's inline `body` is byte-capped by a
 * refinement inside `SkillResultSchema`, and `invokePlugin` scrubs the handler's
 * output BEFORE handing it to that schema, so the cap is measured on the bytes
 * that get written rather than on the bytes the handler returned. A body the
 * redaction pushes over the cap is refused at the parse boundary like any other
 * over-cap body, instead of being persisted into `engine-state.json` and
 * failing every later read of it.
 */
export const REDACTED = '[redacted]'

/**
 * Replace every occurrence of a resolved credential value in a handler's
 * returned result with a fixed placeholder.
 *
 * **It runs above the parse, not below it.** `invokePlugin` scrubs the raw
 * object and hands the scrubbed one to `SkillResultSchema.safeParse`. The
 * placeholder is ten bytes and can therefore make a result larger, and the
 * schema is where the Output body cap is enforced — so measuring that cap after
 * the scrub is the difference between a cap on what is written and a cap on
 * what was returned. See {@link REDACTED}.
 *
 * **This is not the heuristic the config channel refuses.**
 * `src/schemas/plugin-config.ts` states, about a problem string, that a value
 * is omitted and not redacted, "because a redaction heuristic is the thing that
 * goes stale and leaks the one value it did not recognise as a secret". The
 * objection there is to pattern-matching things that LOOK like secrets. This
 * matches nothing. It takes the exact string values that `resolveSecrets` just
 * read out of the environment for this invocation — a set of known cardinality,
 * known at the call — and replaces those and only those. There is no recogniser
 * to go stale. Read the two passages together or they read as contradictory.
 *
 * **The bound is declared secrets only.** A token an operator puts in
 * `config/<plugin>.json` and never names on `manifest.secrets` is outside this
 * set and will reach a run log unchanged. That is a limit, recorded here and in
 * `docs/plugin-authoring.md`, not a gap waiting to be discovered.
 *
 * **The capability handle does not make this unnecessary.** The handle exposes
 * resolved NAMES and no value getter, which bounds the sanctioned path a
 * handler has. It does not bound `process.env`, which an in-process handler
 * retains whatever warpline hands it. So the handle is where a well-behaved
 * plugin gets its list, and this function is what actually holds when one
 * interpolates a token into its summary anyway.
 *
 * **The set can never contain the empty string.** `resolveSecrets` counts an
 * empty-valued declared credential as ABSENT and fails the invocation before
 * the handler runs, so an empty value never reaches this function and it cannot
 * blank a whole document. That is asserted here rather than defended against
 * with a filter, so the two decisions stay visibly coupled instead of one
 * quietly outliving the other.
 *
 * **It scrubs string VALUES, not object KEYS.** `data_freshness` is a
 * `record<string, string>`, so a handler that used a token as a KEY there would
 * keep it. Stated rather than fixed: closing it means a walk that rewrites keys,
 * and that belongs behind a case watched failing first, not behind an argument.
 * Running above the parse shows that same bound from a second angle: a key also
 * appears in the `path` of a Zod issue, so a credential used as a key in a
 * result that FAILS to parse now reaches the fabricated `parse_error` message
 * as well. Measured, not assumed. It is the one place the reordering trades
 * away, and it trades a value that already reached disk on the success path.
 *
 * The walk is over EVERY string value in the object, not over a named field list.
 * `summary`, `errors[].message`, `undo_instruction` and
 * `artifacts_produced[].body` are the four a list would have named — and this
 * runtime's own `SkillResult` already carries a fifth, the structured
 * `[needs-llm]` handoff's `task` sentence, which is handler-authored free text
 * exactly like the others. A named list is a later writer's blind spot chosen
 * in advance.
 */
export function scrubSecrets<T>(value: T, secretValues: readonly string[]): T {
  const values = secretValues.filter((v) => v.length > 0)
  if (values.length !== secretValues.length) {
    throw new Error(
      'scrubSecrets: an empty credential value reached the scrub set. ' +
        'resolveSecrets counts an empty value as absent and fails the ' +
        'invocation before the handler runs, so this cannot happen without ' +
        'that rule having changed.',
    )
  }
  if (values.length === 0) return value
  // Longest first, and a COPY so the caller's array keeps its order. Replacing
  // in declaration order lets a short value that is a substring of a long one
  // insert the placeholder INTO the long one, which stops the long one matching
  // and leaves its remainder standing — `['DB_PASSWORD', 'DB_URL']` leaves the
  // host, user and database of the URL on disk. Consuming the longest match
  // first makes that unreachable, because no surviving value can contain one
  // already replaced.
  return walk(value, [...values].sort((a, b) => b.length - a.length)) as T
}

/**
 * Rebuild `node` with every string scrubbed.
 *
 * Structural: arrays and plain objects are rebuilt, everything else is returned
 * as it stands. `split`/`join` rather than a regular expression, because a
 * credential value is arbitrary text and would need escaping to be a safe
 * pattern — and an escaping mistake here is a silent no-op, which is the one
 * failure mode this function must not have.
 */
function walk(node: unknown, values: readonly string[]): unknown {
  if (typeof node === 'string') {
    let out = node
    for (const secret of values) out = out.split(secret).join(REDACTED)
    return out
  }
  if (Array.isArray(node)) return node.map((entry) => walk(entry, values))
  if (node !== null && typeof node === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(node)) out[key] = walk(entry, values)
    return out
  }
  return node
}
