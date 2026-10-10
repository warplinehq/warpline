/**
 * The plugin-name admission rule: which names a plugin may have.
 *
 * One name is a directory under the plugin root, a key in `plugin_runs` and
 * `denials`, the `config/<name>.json` file name, a grant scope and an argument
 * the CLI joins into a path. Lowercase ASCII keeps all five the same string on
 * a case-insensitive filesystem, a leading letter keeps it off `*`, `-` and
 * `..`, and 64 characters keeps the config file name inside every filesystem's
 * limit.
 *
 * Admission only. The audit store and the gate carry a looser rule on purpose,
 * so a record or grant written under an older name stays readable: the
 * carriage rule, `CarriedPluginName` in lib/audit-log.ts. The frozen gate's
 * copy of it is `CARRIED_PLUGIN_NAME` / `isCarriedPluginName`.
 *
 * Import-free, so the published `warpline/schemas/plugin-name` subpath reaches
 * nothing else.
 */
export const PLUGIN_NAME = /^[a-z][a-z0-9-]{0,63}$/

/** Whether `v` is a name a plugin may have. */
export function isPluginName(v: unknown): v is string {
  return typeof v === 'string' && PLUGIN_NAME.test(v)
}
