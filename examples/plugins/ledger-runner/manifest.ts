import { PluginManifestSchema } from 'warpline/schemas/plugin-manifest'

/**
 * ledger-runner — example plugin.
 *
 * Reads a current value for each declared instrument from a quote API and
 * writes them to a declared ledger file, reporting what it attempted against
 * what it did.
 *
 * It declares `modifies_file` because the ledger is a product file the
 * adopter names, not state this plugin keeps for itself. The write is atomic:
 * a temp file renamed over the target, so a crash leaves the old ledger
 * rather than half of a new one. An instrument that fails keeps its previous
 * value with its previous `as_of`, so the ledger never loses a number it had.
 *
 * Each instrument is isolated from the rest. One failing does not fail the
 * run: the Output counts what was attempted, what succeeded and what failed,
 * and names each failure by its position in the list. Every instrument
 * failing does fail the run, and nothing is written. A rejected token stops
 * the run at once and names the secret, with the ledger untouched.
 *
 * The credential is one environment variable, the name on `secrets`, sent as
 * a Bearer header and nowhere else. Refreshing it is the adopter's job, for
 * example a job that rewrites the variable before an advance. The runtime
 * refuses a run without it before the handler is called. `handler.test.ts`
 * shows the handler working against a stub.
 */
export const manifest = PluginManifestSchema.parse({
  name: 'ledger-runner',
  version: '1.0.0',
  description: 'Read a current value for each declared instrument from a quote API and write them to a declared ledger file, reporting attempted against succeeded',
  autonomy_level: 'autonomous',
  side_effects: ['external_api', 'modifies_file'],
  ttl_hours: 24,
  schedule: 'daily',
  timeout_ms: 60_000,
  secrets: ['LEDGER_QUOTES_TOKEN'],
  inputs: {
    instruments: {
      type: 'array',
      required: true,
      default: [],
      description: 'The instrument identifiers to read, in the order the report counts them; set with warpline configure ledger-runner',
    },
    api_base: {
      type: 'string',
      required: true,
      default: 'https://quotes.example.com/v1',
      description: 'Base URL of the quote API answering GET <api_base>/quotes/<instrument> with { "value": number }; authorised by LEDGER_QUOTES_TOKEN',
    },
    ledger_path: {
      type: 'string',
      required: true,
      default: 'state/ledger.json',
      description: 'The ledger file this plugin rewrites, as { "values": { "<instrument>": { "value": n, "as_of": "..." } } }; a relative path resolved under the warpline home',
    },
  },
  outputs: {
    run: { type: 'object', description: 'Attempted, succeeded and failed counts, and the positions of the instruments that failed with reasons' },
  },
})
