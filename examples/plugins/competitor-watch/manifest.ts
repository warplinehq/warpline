import { PluginManifestSchema } from 'warpline/schemas/plugin-manifest'

/**
 * competitor-watch — example plugin.
 *
 * Watch a short list of pages and say what moved since the last run. Each run
 * fetches every declared target, one at a time and in the order declared,
 * reduces the body to normalised text, and compares that with the snapshot the
 * previous run kept. Every target is reported by its position in the list:
 * `new` the first time it is seen, `changed` with a capped line diff,
 * `unchanged`, or `failed` with a reason. One target failing does not fail the
 * run; every target failing does.
 *
 * The defaults are the tag feeds of three upstream runtimes a project like
 * this one plausibly depends on, so a first run against a clean install shows
 * real data. They are release feeds you consume, never rivals, and the example
 * names no company as one. Replace them with the pages you care about through
 * `warpline configure competitor-watch`.
 *
 * It fetches the declared targets and nothing else. No link found in a body is
 * followed, and every request refuses a redirect, so a target that moves is
 * reported `failed` rather than quietly swapped for wherever it went.
 *
 * The snapshot is this plugin's own state, `state/competitor-watch.last.json`
 * under the warpline home, keyed by target. A first run has none, which is why
 * it reports every target `new`. A snapshot that is not in the shape this
 * plugin writes is refused rather than read as empty.
 *
 * It declares `external_api` because it reaches the network. It reads public
 * pages and needs no secret.
 */
export const manifest = PluginManifestSchema.parse({
  name: 'competitor-watch',
  version: '1.0.0',
  description: 'Fetch each declared target, keep a normalised snapshot of its text, and report what changed since the last run: new, changed with a capped line diff, unchanged, or failed',
  autonomy_level: 'autonomous',
  side_effects: ['external_api'],
  ttl_hours: 24,
  schedule: 'daily',
  timeout_ms: 60_000,
  inputs: {
    // An `array` input, so its value comes from the config file `warpline
    // configure` writes or from this default, never from a command-line flag.
    targets: {
      type: 'array',
      required: true,
      default: [
        'https://github.com/nodejs/node/tags.atom',
        'https://github.com/oven-sh/bun/tags.atom',
        'https://github.com/denoland/deno/tags.atom',
      ],
      description: 'The pages to watch, as http(s) URLs, reported by position in this order. The defaults are the tag feeds of three upstream runtimes you may depend on; replace them with your own',
    },
    max_diff_lines: {
      type: 'number',
      required: false,
      default: 20,
      description: 'The most diff lines reported for one changed target; the rest is marked truncated',
    },
  },
  outputs: {
    report: { type: 'object', description: 'One entry per declared target, by position: new, changed with its diff, unchanged, or failed with a reason' },
  },
})
