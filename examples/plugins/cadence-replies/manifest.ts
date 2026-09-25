import { PluginManifestSchema } from 'warpline/schemas/plugin-manifest'

/**
 * cadence-replies — example plugin.
 *
 * The reply-detection seam of the cadence example, and the one piece of it an
 * adopter is expected to replace. This stub reads a declared file of who
 * replied. A real one reads an inbox. Keep the Output shape, `{ "replied":
 * ["<contact id>", ...] }` sorted and unique, and `cadence-plan` never knows
 * the difference.
 *
 * Its one-hour TTL is the reply-detection latency. A reply that lands just
 * after this plugin ran is not seen until it runs again, so a step that falls
 * due inside that hour can still be planned for a contact who has already
 * replied. Shorten the TTL if that hour matters to you.
 *
 * A missing file reports nothing. It does not report "no replies". That way
 * `cadence-plan` never plans against a reply list nobody could read. Create
 * `state/replies.json` holding `{ "replies": [] }` to say nobody replied.
 *
 * It writes nothing.
 */
export const manifest = PluginManifestSchema.parse({
  name: 'cadence-replies',
  version: '1.0.0',
  description: 'The reply-detection seam of the cadence example: reads a declared replies file and reports which contacts replied. Replace this handler with your own inbox reader',
  autonomy_level: 'autonomous',
  side_effects: [],
  ttl_hours: 1,
  schedule: 'on_run',
  timeout_ms: 10_000,
  inputs: {
    replies_path: {
      type: 'string',
      required: true,
      default: 'state/replies.json',
      description: 'Where this stub reads replies from, as { "replies": [{ "contact_id": "..." }] }; a relative path under the warpline home',
    },
  },
  outputs: {
    replies: { type: 'object', description: 'The ids of the contacts that replied, sorted' },
  },
})
