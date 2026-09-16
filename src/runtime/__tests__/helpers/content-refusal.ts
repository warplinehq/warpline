/**
 * The smallest fixture that makes a real advance report a content refusal.
 *
 * Three test files need one — the exit code's, the dead-man file's and the
 * CLI's — and each of them already owns a `writePlugin` tuned to its own
 * assertions. What none of them owns is the approval record, and a record
 * hand-built three times is three chances for one of them to describe a
 * standing the runtime does not actually reach. So the record is here, once,
 * and the plugin each file writes stays that file's own.
 *
 * The standing is `outside_window`, reached by a `not_after` wall clock in the
 * past. Deliberately the cheapest of the three refusals: `approvalStanding`
 * answers it from the window bounds alone and never reads `last_output`, so no
 * producer plugin, no seeded Output and no fingerprint arithmetic is involved.
 * A refusal is a refusal to everything downstream of the gate, and these files
 * assert counts.
 *
 * **That cheapness is exactly why it must not be used for a leak assertion.**
 * Nothing here ever puts approved bytes anywhere the runtime reads, so a
 * sentinel planted on this fixture is absent from every output for the reason
 * that it was never present — this repository's recorded failure shape, a guard
 * green over something outside its reach. A no-leak case wants
 * `content_moved`, where the approved bytes really are on the path.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defaultEngineState } from '../../../schemas/engine-state.js'
import type { EngineState } from '../../../schemas/engine-state.js'

/**
 * A content approval whose window closed long ago.
 *
 * `producer` names nothing that exists, and it does not have to: the window
 * check returns above the producer-manifest read. A `fingerprint` is required
 * by the schema and is never compared on this arm.
 */
export function expiredContentApproval(plugin: string): EngineState['approvals'][string] {
  return {
    plugin,
    producer: `${plugin}-producer`,
    fingerprint: 'not-compared-on-the-window-arm',
    run_id: 'run-the-operator-read',
    approved_at: '2000-01-01T00:00:00.000Z',
    not_before: null,
    // A wall clock, resolved in `zone` — the shape `warpline approve --content`
    // stores. Far enough back that no host clock skew reaches it.
    not_after: '2000-01-02T00:00',
    zone: 'UTC',
    effect_id: null,
    marked_at: null,
    confirmed_at: null,
  }
}

/**
 * Write `names` as due content-class plugins and seed the state document with
 * an expired approval for each.
 *
 * The state document is written whole from `defaultEngineState()`, so it is
 * valid by construction rather than by a literal this helper keeps in step.
 * Callers that need other state seeded pass `base`.
 */
export async function seedContentRefusals(opts: {
  pluginsDir: string
  statePath: string
  names: readonly string[]
  base?: EngineState
}): Promise<void> {
  for (const name of opts.names) {
    const dir = join(opts.pluginsDir, name)
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'manifest.ts'),
      `export const manifest = ${JSON.stringify({
        name,
        version: '1.0.0',
        description: `${name} content-refusal fixture`,
        inputs: {},
        outputs: {},
        capabilities: [],
        schedule: 'on_run',
        autonomy_level: 'autonomous',
        side_effects: ['sends_email'],
        approval_class: 'content',
        // Near zero so the plugin is always stale and therefore due. A fresh
        // plugin is skipped above the approval gate and refused by nothing.
        ttl_hours: 0.001,
        // The ONE dependency the content class requires, and it is not an
        // arbitrary one: `expiredContentApproval` already records
        // `${name}-producer` as the approval's producer, so this names the same
        // plugin the seeded record binds to. The fixture was declaring none,
        // which the schema refuses — a content approval covers exactly one
        // producer's Output, and zero dependencies leaves that subject
        // ambiguous. It went unnoticed while the loader cast instead of parsed.
        dependencies: [`${name}-producer`],
        timeout_ms: 5000,
        max_parallelism: 1,
      })}`,
    )
    // The handler exists and must never run. Nothing asserts on its result;
    // the gate is what these fixtures are about.
    await writeFile(
      join(dir, 'handler.ts'),
      `
export async function handler() {
  return {
    status: 'success',
    phases_completed: ['${name}'],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: '${name} completed',
    artifacts_produced: [],
    schema_version: 1,
  }
}
`,
    )
  }

  const state = opts.base ?? defaultEngineState()
  for (const name of opts.names) state.approvals[name] = expiredContentApproval(name)
  await writeFile(opts.statePath, JSON.stringify(state))
}
