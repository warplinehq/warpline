import { PluginManifestSchema } from 'warpline/schemas/plugin-manifest'

/**
 * search-console — example plugin.
 *
 * Week over week, for one declared site: the clicks and impressions of the top
 * queries and the top pages this week, the same keys last week, and the delta
 * per key. "This week" is the 7 complete UTC days ending yesterday, and "last
 * week" is the 7 days before those. The top is ranked by this week's clicks,
 * and a tie goes to the key that sorts first. A key with no row last week is
 * reported `new`, with last week read as 0.
 *
 * The request contract is this example's own, not a vendor's. It is written
 * out at the top of `handler.ts`: one POST per week and dimension to
 * `<api_base>/query`. Point `api_base` at an adapter that speaks it.
 *
 * The credential is one environment variable, the name on `secrets`, and it is
 * sent as a Bearer header and nowhere else. Refreshing it is the adopter's
 * job, for example a job that rewrites the variable before an advance. No
 * example implements a refresh. A first run without the variable is refused by
 * name before the handler runs, and that refusal is the demo. `handler.test.ts`
 * shows the handler working against a stub.
 *
 * It persists nothing. Every run asks the API again, so `ttl_hours` alone
 * decides whether recomputing is worth it.
 */
export const manifest = PluginManifestSchema.parse({
  name: 'search-console',
  version: '1.0.0',
  description: 'Week-over-week clicks and impressions for the top queries and pages of a declared site, from a search-analytics API behind one Bearer token',
  autonomy_level: 'autonomous',
  side_effects: ['external_api'],
  ttl_hours: 24,
  schedule: 'daily',
  timeout_ms: 30_000,
  secrets: ['SEARCH_CONSOLE_TOKEN'],
  inputs: {
    site_url: {
      type: 'string',
      required: true,
      default: 'https://your-site.example.com/',
      description: 'The property to report on; sent to the API in each request and never written into the result',
    },
    api_base: {
      type: 'string',
      required: true,
      default: 'https://search.example.com/v1',
      description: 'Base URL of a search-analytics API speaking the contract at the top of handler.ts; authorised by SEARCH_CONSOLE_TOKEN',
    },
    top_n: {
      type: 'number',
      required: false,
      default: 10,
      description: 'How many queries and how many pages to report, ranked by this week\'s clicks',
    },
  },
  outputs: {
    report: { type: 'object', description: 'This week and last week for the top queries and pages, with the delta per key' },
  },
})
