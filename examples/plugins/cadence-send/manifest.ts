import { PluginManifestSchema } from 'warpline/schemas/plugin-manifest'

/**
 * cadence-send — example plugin.
 *
 * The last step of the cadence example, and the side effect: it sends exactly
 * the outbox `cadence-plan` produced, once per recipient, and nothing else.
 *
 * It is content class. An operator reads the outbox and approves those exact
 * bytes ahead of time with `warpline approve cadence-send --content
 * --not-after <when>`. A later advance may then send them unattended. If the
 * outbox moves by one byte, the approval stops applying and this plugin is
 * skipped. A session grant never makes it run, not even `approve --all`.
 *
 * It has no contacts input and no template input. Its only input is where the
 * mail API lives, so it can only send what the operator was shown.
 *
 * Each email is marked in `state/cadence-send.sent.json`, by email id and
 * recipient, straight after it goes out and before the next one is tried. A
 * crash between a send and its mark can send that one email twice. Nothing
 * narrower is possible without the mail API's help.
 *
 * It stops at the first failure. When some emails went out first, the run is
 * `partial` and the approval is spent. Re-approve the unchanged outbox and the
 * retry sends only what the ledger has not recorded. It fires on the first
 * advance after this plugin's one-hour TTL lapses, or sooner when cadence-plan
 * re-runs. A failure before any email went out, a rejected token for example,
 * leaves the approval `indeterminate`, and nothing clears that.
 *
 * It stops itself with a quarter of `timeout_ms` left, and a request still out
 * when the budget runs out is aborted. That run is `partial` too, so the retry
 * above applies, and the aborted email may already have gone and go again. It
 * stops early because the runtime's own timeout records the run `failed`,
 * whatever went out first, and that leaves the approval `indeterminate`.
 *
 * The credential is one environment variable, the name on `secrets`, sent as a
 * Bearer header and nowhere else. Refreshing it is the adopter's job.
 */
export const manifest = PluginManifestSchema.parse({
  name: 'cadence-send',
  version: '1.0.0',
  description: 'Sends exactly the outbox an operator approved, once per recipient, and nothing else',
  autonomy_level: 'autonomous',
  side_effects: ['sends_email'],
  approval_class: 'content',
  dependencies: ['cadence-plan'],
  secrets: ['CADENCE_MAIL_TOKEN'],
  ttl_hours: 1,
  schedule: 'on_run',
  timeout_ms: 60_000,
  inputs: {
    api_base: {
      type: 'string',
      required: true,
      default: 'https://mail.example.com/v1',
      description: 'Base URL of the mail API answering POST <api_base>/send with { to, subject, body }; authorised by CADENCE_MAIL_TOKEN',
    },
  },
  outputs: {
    sent: { type: 'number', description: 'Emails sent this run' },
  },
})
