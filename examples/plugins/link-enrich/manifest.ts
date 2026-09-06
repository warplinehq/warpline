import { PluginManifestSchema } from 'warpline/schemas/plugin-manifest'

/**
 * link-enrich — example plugin.
 *
 * The fan-in shape: take a set of links, look them up against SEVERAL
 * sources, and merge what comes back into one record — with each source
 * isolated from the others. One source refusing does not fail the run; the
 * result names which sources contributed and which were refused, the way
 * `warpline approve` reports what it applied and what it refused rather than
 * claiming all-or-nothing. Every source refusing IS a failure: a merge of
 * nothing returned as a success is the silent false-negative, and an example
 * is exactly where an author would copy that from.
 *
 * The sources are generic and declared entirely here: three endpoint URLs
 * with placeholder defaults, retargeted through `warpline configure
 * link-enrich`. Each takes one POST carrying the whole link set and answers
 * with a record keyed by link. No vendor adapter, nothing shaped like a
 * particular company's API.
 *
 * Credentials: the per-source names are declared in `secrets` and read from
 * the environment at run time. A value reaches the outbound authorization
 * header and nothing else — not a summary, not an error, not the written
 * file. Inside the handler a source whose credential is absent is DISABLED
 * and reported while the others still run. Note what sits in front of that:
 * the runtime resolves every name on `secrets` BEFORE the handler is called
 * and refuses the whole run when any is unset, so through `warpline run` or
 * an advance the per-source arm is reached only when all three are set. The
 * arm is real for a host that calls the handler directly and for the tests
 * beside it; the all-or-nothing pre-flight is the runtime's rule, recorded
 * here rather than loosened.
 */
export const manifest = PluginManifestSchema.parse({
  name: 'link-enrich',
  version: '1.0.0',
  description: 'Look a set of links up against three sources and merge what comes back, each source isolated from the others',
  autonomy_level: 'autonomous',
  side_effects: ['external_api'],
  ttl_hours: 6,
  schedule: 'daily',
  timeout_ms: 30_000,
  secrets: ['LINK_ENRICH_METADATA_TOKEN', 'LINK_ENRICH_PREVIEW_TOKEN', 'LINK_ENRICH_REPUTATION_TOKEN'],
  inputs: {
    // Required AND defaulted: a relative path resolves under the home, so a
    // clean install runs with no config file and finds nothing to enrich.
    links_path: {
      type: 'string',
      required: true,
      default: 'state/links.json',
      description: 'The links to enrich, as { "links": ["https://..."] }; a relative path resolves under the warpline home',
    },
    metadata_url: {
      type: 'string',
      required: true,
      default: 'https://metadata.example.com/lookup',
      description: 'Endpoint answering with a title and description per link; authorised by LINK_ENRICH_METADATA_TOKEN',
    },
    preview_url: {
      type: 'string',
      required: true,
      default: 'https://preview.example.com/lookup',
      description: 'Endpoint answering with a preview image per link; authorised by LINK_ENRICH_PREVIEW_TOKEN',
    },
    reputation_url: {
      type: 'string',
      required: true,
      default: 'https://reputation.example.com/lookup',
      description: 'Endpoint answering with a safety verdict per link; authorised by LINK_ENRICH_REPUTATION_TOKEN',
    },
  },
  outputs: {
    enriched: { type: 'object', description: 'One record per link, keyed by source, plus which sources contributed and which were refused' },
  },
})
