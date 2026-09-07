/**
 * The two-advance harness: one fixture home, two `runAdvance` calls, and a
 * marker file deciding what the producer does on the second one.
 *
 * The marker is the mechanism and it is not incidental. `import()` caches the
 * module, so rewriting `handler.ts` between advances is never re-read — a
 * producer whose behaviour must CHANGE between the two advances has to branch
 * on something outside the module, and a file on disk is the cheapest such
 * thing.
 *
 *   Advance 1: no marker  → the producer succeeds and records a `last_output`.
 *   Advance 2: marker set → the producer takes the mode it was built with.
 *
 * Extracted here on its second caller, not its first: `dependency-output-
 * preservation.test.ts` drives it for the preservation invariant and
 * `dependency-run-status-leak.test.ts` drives it for the leak constraint. One
 * caller is a local function; two is a helper.
 *
 * What is deliberately NOT here: the consumer handler. The two callers read
 * different members through it and serialise different things, so a shared
 * consumer would be a parameterised string that neither file could read.
 */
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTestHome, type TestHome } from './create-test-home.js'

/** What the producer does once the marker exists. */
export type ProducerMode = 'throw' | 'failed' | 'success-with-nothing'

/** A `plugin_entries` row from a persisted run log. */
export interface RunLogEntry {
  readonly plugin: string
  readonly status: string
  readonly result_summary: string
  readonly [key: string]: unknown
}

export interface TwoAdvanceHome {
  readonly root: string
  readonly pluginsDir: string
  readonly statePath: string
  readonly runsDir: string
  readonly eventsPath: string
  /** The file whose existence flips the producer into its mode. */
  readonly marker: string
  writePlugin(
    name: string,
    opts: { dependencies?: string[]; outputs?: Record<string, unknown>; handlerBody: string },
  ): Promise<void>
  /**
   * The producer source. `thrownMessage` is a parameter rather than a constant
   * because the two callers need different ones: preservation needs any
   * message, and the leak test needs a specific sentinel it can search for.
   */
  producer(mode: ProducerMode, thrownMessage?: string): string
  /** Write the marker, so the next advance takes the producer's mode arm. */
  setMarker(): Promise<void>
  advance(): Promise<{ run_log_path: string }>
  /** One plugin's row in a persisted run log, or `null` when it did not run. */
  entryFor(runLogPath: string, plugin: string): Promise<RunLogEntry | null>
  /** One plugin's persisted `plugin_runs` entry, straight from the state file. */
  persistedRun(plugin: string): Promise<Record<string, unknown> | undefined>
  cleanup(): Promise<void>
}

export async function createTwoAdvanceHome(): Promise<TwoAdvanceHome> {
  const ctx: TestHome = await createTestHome()
  const pluginsDir = ctx.pluginsDir
  const statePath = join(ctx.stateDir, 'engine-state.json')
  // Redirected deliberately: runAdvance's eventsPath DEFAULTS to the real
  // live events.jsonl, and omitting it appends fixture events to live state.
  const eventsPath = join(ctx.runsDir, 'events.jsonl')
  const marker = join(ctx.root, 'PRODUCE_NOTHING_NOW')

  return {
    root: ctx.root,
    pluginsDir,
    statePath,
    runsDir: ctx.runsDir,
    eventsPath,
    marker,

    async writePlugin(name, opts) {
      const dir = join(pluginsDir, name)
      await mkdir(dir, { recursive: true })
      const manifest = {
        name,
        version: '1.0.0',
        description: `${name} two-advance fixture`,
        inputs: {},
        outputs: opts.outputs ?? {},
        capabilities: [],
        schedule: 'on_run',
        autonomy_level: 'autonomous',
        side_effects: [],
        // Near-zero, so the second advance finds every plugin due again. A TTL
        // that held them fresh would make every arm pass for a reason that has
        // nothing to do with what is under test.
        ttl_hours: 0.0000001,
        dependencies: opts.dependencies ?? [],
        timeout_ms: 5000,
        max_parallelism: 1,
      }
      await writeFile(
        join(dir, 'manifest.ts'),
        `export const manifest = ${JSON.stringify(manifest)}`,
      )
      await writeFile(join(dir, 'handler.ts'), opts.handlerBody)
    },

    producer(mode, thrownMessage = 'producer blew up on advance 2') {
      const onMarker =
        mode === 'throw'
          ? `throw new Error(${JSON.stringify(thrownMessage)})`
          : mode === 'failed'
            ? `return {
      status: 'failed',
      phases_completed: [],
      phases_failed: ['prod'],
      errors: [{ code: 'dependency_unavailable', message: 'declined', impact: 'HIGH', retryable: false }],
      data_freshness: {},
      summary: 'prod returned failed',
      artifacts_produced: [],
      schema_version: 1,
    }`
            : `return {
      status: 'success',
      phases_completed: ['prod'],
      phases_failed: [],
      errors: [],
      data_freshness: {},
      summary: 'prod succeeded and produced nothing',
      artifacts_produced: [],
      schema_version: 1,
    }`
      return `
import { existsSync } from 'node:fs'
export async function handler(manifest, args, signal, capabilities) {
  if (existsSync(${JSON.stringify(marker)})) {
    ${onMarker}
  }
  return {
    status: 'success',
    phases_completed: ['prod'],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: 'prod produced',
    artifacts_produced: [{ type: 'brief', format: 'json', body: '{"advance":1}' }],
    schema_version: 1,
  }
}
`
    },

    async setMarker() {
      await writeFile(marker, 'x')
    },

    async advance() {
      const { runAdvance } = await import('../../engine.js')
      return runAdvance({ pluginsDir, stateDir: statePath, runsDir: ctx.runsDir, eventsPath })
    },

    async entryFor(runLogPath, plugin) {
      const log = JSON.parse(await readFile(runLogPath, 'utf-8')) as {
        plugin_entries: RunLogEntry[]
      }
      return log.plugin_entries.find((e) => e.plugin === plugin) ?? null
    },

    async persistedRun(plugin) {
      const state = JSON.parse(await readFile(statePath, 'utf-8')) as {
        plugin_runs: Record<string, Record<string, unknown>>
      }
      return state.plugin_runs[plugin]
    },

    cleanup: ctx.cleanup,
  }
}
