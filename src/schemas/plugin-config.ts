/**
 * Per-plugin configuration: the schema, and the pure precedence merge.
 *
 * This module is filesystem-free by construction. `"./schemas/*"` is a wildcard
 * export in package.json, so this file became `warpline/schemas/plugin-config`
 * the moment it existed — and shipping disk I/O on a `schemas/*` subpath is a
 * defect this same release removes elsewhere. The disk read lives one layer up
 * in `src/lib/plugin-config.ts`; everything here is data in, data out.
 */
import { z } from 'zod'

/**
 * A config key may not be an `Object.prototype` member.
 *
 * The same refusal `plugin-manifest.ts` applies to `name`, and for the same
 * reason: resolved args are a plain record, and a key inherited from the
 * prototype answers a lookup with a member instead of the absence that is the
 * truth. Derived from the prototype rather than listed, so it cannot go stale
 * against a future addition.
 */
const ConfigKey = z
  .string()
  .min(1)
  .refine((k) => !(k in Object.prototype), {
    message: 'collides with an Object.prototype member and cannot be a config key',
  })

/**
 * The on-disk shape of `<home>/config/<plugin>.json`: input names to values.
 *
 * Values are `unknown` here on purpose. What a value is ALLOWED to be depends
 * on what the plugin's manifest declares, and this schema does not know the
 * manifest. Type checking happens in `resolvePluginArgs`, where both halves are
 * in hand.
 */
export const PluginConfigSchema = z.record(ConfigKey, z.unknown())
export type PluginConfig = z.infer<typeof PluginConfigSchema>

/**
 * Where a resolved input value can come from, LOWEST precedence first.
 *
 * Declared defaults are the floor: they are what the plugin author said the
 * input means when nobody says otherwise. The operator's config file overrides
 * that. Per-invocation args win over both, which is what keeps a positional
 * passed to `warpline run` behaving the way an operator typing it expects.
 */
export const PLUGIN_CONFIG_PRECEDENCE = [
  'manifest_default',
  'config_file',
  'invocation_args',
] as const
export type PluginConfigSource = (typeof PLUGIN_CONFIG_PRECEDENCE)[number]

/** One declared input, as it appears in a manifest's `inputs` record. */
export interface DeclaredInput {
  type?: string
  required?: boolean
  default?: unknown
  description?: string
}

/** Outcome of a resolution: the merged args, or the reasons it cannot be done. */
export type ResolvedArgs =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; problems: string[] }

const TYPEOF_CHECKED = new Set(['string', 'number', 'boolean'])

/**
 * Merge declared defaults, the config file and the caller's args into the
 * arguments a handler receives, then validate them against what the manifest
 * declared.
 *
 * Two things this deliberately does NOT do:
 *
 * It does not filter the result down to the declared inputs. `warpline run`
 * passes a mandatory `action` positional that no manifest declares, and a
 * whitelisting merge would drop it while every test written for declared
 * inputs stayed green.
 *
 * It never names a received value in a problem string. A problem names the key
 * and the shape expected of it; the value is omitted, not redacted, because a
 * redaction heuristic is the thing that goes stale and leaks the one value it
 * did not recognise as a secret.
 */
export function resolvePluginArgs(
  inputs: Record<string, DeclaredInput> | undefined,
  fileConfig: Record<string, unknown>,
  callerArgs: Record<string, unknown>,
): ResolvedArgs {
  // `?? {}`, never a bare `Object.entries(inputs)`: invokePlugin deliberately
  // tolerates manifests that never went through Zod, and the suite is full of
  // bare-object fixtures with no `inputs` key at all.
  const declared = inputs ?? {}

  // Null prototype, and `Object.assign` rather than a spread — a spread
  // re-attaches Object.prototype to the result.
  const merged: Record<string, unknown> = Object.assign(
    Object.create(null) as Record<string, unknown>,
    declaredDefaults(declared),
    fileConfig,
    callerArgs,
  )

  const problems: string[] = []
  for (const [key, input] of Object.entries(declared)) {
    const present = merged[key] !== undefined
    if (!present) {
      if (input.required ?? true) {
        problems.push(`required input '${key}' has no value (expected ${input.type ?? 'a value'})`)
      }
      continue
    }
    if (input.type && TYPEOF_CHECKED.has(input.type) && typeof merged[key] !== input.type) {
      problems.push(`input '${key}' must be a ${input.type}`)
    }
  }

  return problems.length > 0 ? { ok: false, problems } : { ok: true, args: merged }
}

/**
 * The lowest precedence tier: what each input declares for itself.
 *
 * Split out so the merge above reads as `PLUGIN_CONFIG_PRECEDENCE` in order.
 */
function declaredDefaults(declared: Record<string, DeclaredInput>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, input] of Object.entries(declared)) {
    if (input.default !== undefined) out[key] = input.default
  }
  return out
}
