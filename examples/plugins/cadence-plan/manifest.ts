import { PluginManifestSchema } from 'warpline/schemas/plugin-manifest'

/**
 * cadence-plan — example plugin.
 *
 * The middle of the cadence example. It works out which step is due for each
 * contact, stops a contact who replied, and outputs the exact emails to send
 * with one review task per reply. It sends nothing. `cadence-send` ships the
 * outbox, and only once an operator has approved these exact bytes.
 *
 * The step is worked out from time: the latest step whose `enrolled_at +
 * offset_days` has passed. Nothing here counts what was sent. Duplicates are
 * prevented by `cadence-send`'s own ledger, never here.
 *
 * A reply stops a contact for good. The stop is written to this plugin's own
 * state before the contacts and steps are read, so a contact whose reply
 * dropped off the replies list later stays stopped. The reply becomes a review
 * task in the body, as data for a person to act on. Nothing here hands off.
 *
 * A run with nothing to plan, a missing contacts or steps file for example,
 * outputs an empty outbox. It never outputs nothing: the runtime would carry
 * the last outbox forward, and one already approved would still be sent.
 *
 * The body carries no run timestamp and every list in it is sorted. Re-running
 * before the send fires reproduces the same bytes, so the approval stays live.
 *
 * Two costs, stated plainly. A step not approved before the contact's next step
 * falls due is superseded and never sends. And an email already sent keeps
 * appearing in the outbox while its step is the latest due. The send ledger
 * skips it, but it is still in the bytes an operator approves.
 */
export const manifest = PluginManifestSchema.parse({
  name: 'cadence-plan',
  version: '1.0.0',
  description: 'Works out which cadence step is due for each contact, stops a contact who replied, and outputs the exact emails to send with a review task per reply. Sends nothing',
  autonomy_level: 'autonomous',
  side_effects: [],
  dependencies: ['cadence-replies'],
  ttl_hours: 1,
  schedule: 'on_run',
  timeout_ms: 10_000,
  inputs: {
    contacts_path: {
      type: 'string',
      required: true,
      default: 'state/contacts.json',
      description: 'The contacts, as { "contacts": [{ "id", "email", "enrolled_at" }] }; a relative path under the warpline home',
    },
    steps_path: {
      type: 'string',
      required: true,
      default: 'state/steps.json',
      description: 'The steps, as { "steps": [{ "offset_days", "subject", "body" }] } in ascending offset order; a relative path under the warpline home',
    },
  },
  outputs: {
    outbox: {
      type: 'object',
      description: 'The emails due now and one review task per contact who replied; what cadence-send ships once an operator approves these exact bytes',
    },
  },
})
