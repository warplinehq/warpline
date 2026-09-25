import { PluginManifestSchema } from 'warpline/schemas/plugin-manifest'

/**
 * graph-sync — example plugin.
 *
 * Reads a declared JSON file of records and upserts each one to an API keyed
 * by its id. It is idempotent because every write is a PUT to
 * `<api_base>/records/<id>`, so a re-run overwrites what the last run wrote
 * and never duplicates it.
 *
 * Each record is isolated from the rest. One record failing does not fail the
 * run: the Output counts what was attempted, what succeeded and what failed,
 * and names each failing record with its reason. Every record failing does
 * fail the run, because a sync that wrote nothing is not a success. A
 * rejected token stops the run at once and names the secret, since every
 * record after it would be rejected the same way.
 *
 * The credential is one environment variable, the name on `secrets`, sent as
 * a Bearer header and nowhere else. Refreshing it is the adopter's job, for
 * example a job that rewrites the variable before an advance. The runtime
 * refuses a run without it before the handler is called. `handler.test.ts`
 * shows the handler working against a stub.
 */
export const manifest = PluginManifestSchema.parse({
  name: 'graph-sync',
  version: '1.0.0',
  description: 'Upsert each record from a declared file to an API by id, isolating a failing record from the rest',
  autonomy_level: 'autonomous',
  side_effects: ['external_api', 'writes_db'],
  ttl_hours: 24,
  schedule: 'daily',
  timeout_ms: 60_000,
  secrets: ['GRAPH_SYNC_TOKEN'],
  inputs: {
    records_path: {
      type: 'string',
      required: true,
      default: 'state/records.json',
      description: 'The records to sync, as { "records": [{ "id": "...", ... }] }; a relative path resolved under the warpline home',
    },
    api_base: {
      type: 'string',
      required: true,
      default: 'https://graph.example.com/v1',
      description: 'Base URL of the API that upserts a record with PUT <api_base>/records/<id>; authorised by GRAPH_SYNC_TOKEN',
    },
  },
  outputs: {
    sync: { type: 'object', description: 'Attempted, succeeded and failed counts, and the failing record ids with reasons' },
  },
})
