/**
 * END-TO-END: the bundled `github-poll` example works on a clean install.
 *
 * Every other config-channel test in this suite runs a fixture plugin written
 * for the occasion. This one runs the real shipped example through the real
 * `runAdvance`, because the defect it closes was invisible to fixtures: the
 * example declared `repo` as a required input, its handler read `args.repo`,
 * and nothing on the advance path ever supplied one. The handler's own unit
 * test covers a pure helper, so the quickstart could fail on every advance
 * forever with the suite green.
 *
 * Two disciplines this file keeps, both load-bearing:
 *
 * The un-granted case is asserted FIRST and separately. `github-poll` declares
 * `external_api`, so the approval gate refuses it before `invokePlugin` is
 * reached — an advance without a session grant proves nothing about config
 * resolution at all, and would look exactly as green as one that proves
 * everything.
 *
 * `globalThis.fetch` is captured before the swap and restored in a `finally`.
 * A leaked global breaks unrelated tests non-deterministically, which is the
 * kind of failure nobody attributes back to the file that caused it.
 *
 * Only the `github-poll` directory is symlinked into the temp home, not the
 * whole `examples/plugins` tree: a symlink of the tree would make the
 * no-inputs fixture below a write into the repository, and every other bundled
 * example would execute against a stub shaped like an issues payload. A copy
 * is not an option either — each example manifest opens with a `warpline/...`
 * package self-reference resolved by walking up from the file's REAL location.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { symlinkSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runAdvance } from '../engine.js'
import { grantApproval } from '../approval-gate.js'
import { createTestHome, type TestHome } from './helpers/create-test-home.js'
import { _setHome } from '../../lib/paths.js'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')

/** What the manifest declares when nobody configures anything. */
const MANIFEST_DEFAULT_REPO = 'warplinehq/warpline'
/** What an operator writes into the config file to retarget the example. */
const CONFIGURED_REPO = 'acme/widgets'

/** The unguessable half of the sentinel — what a leak would leave in the log. */
const SENTINEL_SECRET = 'do-not-echo-4b1e7c'
/**
 * A sentinel repo in valid owner/name form, so it PASSES the handler's input
 * guard and reaches the success arm. A sentinel that fails that regex can only
 * ever prove something about the invalid-input arm, which is how the leak below
 * shipped with a green suite.
 */
const SENTINEL_REPO = `sentinel-owner/${SENTINEL_SECRET}`

/** Two issues and one pull request — the PR is filtered, so the count is 2. */
const ISSUES_PAYLOAD = [
  { title: 'first', labels: [{ name: 'bug' }] },
  { title: 'second', labels: [] },
  { title: 'a pull request', labels: [], pull_request: { url: 'https://example.invalid/1' } },
]
const EXPECTED_OPEN_COUNT = 2

let ctx: TestHome
let approvalPath: string
let eventsPath: string

beforeEach(async () => {
  // A fresh home per case, deliberately. `github-poll` declares `ttl_hours: 12`,
  // so a second advance in a home where the first one succeeded would be
  // skipped as FRESH rather than run — and the override case would assert
  // nothing while passing.
  ctx = await createTestHome()
  _setHome(ctx.root)
  approvalPath = join(ctx.root, '.session-approval')
  eventsPath = join(ctx.stateDir, 'events.jsonl')
  symlinkSync(
    join(REPO_ROOT, 'examples', 'plugins', 'github-poll'),
    join(ctx.pluginsDir, 'github-poll'),
  )
})

afterEach(async () => {
  _setHome(null)
  await ctx.cleanup()
})

function advance() {
  return runAdvance({
    pluginsDir: ctx.pluginsDir,
    // Full path to the state document, despite the option's name.
    stateDir: join(ctx.stateDir, 'engine-state.json'),
    runsDir: ctx.runsDir,
    eventsPath,
    approvalPath,
  })
}

/**
 * Swap `globalThis.fetch` for a recorder returning a fixed issues payload, run
 * `body`, and restore the real one whatever happens.
 *
 * The recorded URLs are the assertion surface for precedence: the summary the
 * handler returns names the plugin and the count, never the repo, so the
 * request it built is the only place the resolved value is observable at all.
 *
 * That the value went nowhere else is a separate assertion with its own case
 * below, and it reads the raw text of the run-log file rather than any field of
 * the in-memory result — the engine writes `result.summary` into
 * `plugin_entries[].result_summary` on every run, and that file is what people
 * paste into issues.
 */
async function withStubbedFetch(body: (urls: string[]) => Promise<void>): Promise<void> {
  const realFetch = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = (async (input: unknown) => {
    urls.push(String(input))
    return { ok: true, status: 200, json: async () => ISSUES_PAYLOAD }
  }) as unknown as typeof fetch
  try {
    await body(urls)
  } finally {
    globalThis.fetch = realFetch
  }
}

/** The run-log entry for one plugin, read back off disk. */
async function entryFor(runLogPath: string, plugin: string) {
  const log = JSON.parse(await readFile(runLogPath, 'utf-8')) as {
    plugin_entries: { plugin: string; status: string; result_summary: string }[]
  }
  return log.plugin_entries.find((e) => e.plugin === plugin)
}

/** The persisted `plugin_runs` record — where the literal `success` lives. */
async function pluginRun(plugin: string) {
  const state = JSON.parse(await readFile(join(ctx.stateDir, 'engine-state.json'), 'utf-8')) as {
    plugin_runs: Record<string, { status: string }>
  }
  return state.plugin_runs[plugin]
}

describe('github-poll under runAdvance', () => {
  test('without a session grant the handler is never reached', async () => {
    await withStubbedFetch(async (urls) => {
      const result = await advance()

      expect(result.plugin_states.get('github-poll')).toBe('skipped')
      const entry = await entryFor(result.run_log_path, 'github-poll')
      expect(entry?.status).toBe('skipped')
      expect(entry?.result_summary).toContain('unapproved')
      // The load-bearing assertion of the whole file: no grant, no invocation.
      // Every success below is only meaningful because this one holds.
      expect(urls).toEqual([])
    })
  })

  test('a clean install succeeds, its repo arriving from the manifest default', async () => {
    await grantApproval('github-poll', 4 * 60 * 60 * 1000, approvalPath)

    await withStubbedFetch(async (urls) => {
      const result = await advance()

      expect(await pluginRun('github-poll')).toMatchObject({ status: 'success' })
      const entry = await entryFor(result.run_log_path, 'github-poll')
      expect(entry?.status).toBe('completed')

      // The example declares `open_count` as an output but a SkillResult has no
      // `data` field to carry it, so the count is read from the one-line summary
      // the board shows — the only place the run reports it today.
      const count = entry?.result_summary.match(/(\d+) open issues/)?.[1]
      expect(Number(count)).toBe(EXPECTED_OPEN_COUNT)

      expect(urls).toHaveLength(1)
      expect(urls[0]).toContain(MANIFEST_DEFAULT_REPO)
    })
  })

  test('a config file overrides the manifest default', async () => {
    await grantApproval('github-poll', 4 * 60 * 60 * 1000, approvalPath)
    await mkdir(join(ctx.root, 'config'), { recursive: true })
    await writeFile(
      join(ctx.root, 'config', 'github-poll.json'),
      JSON.stringify({ repo: CONFIGURED_REPO }),
    )

    await withStubbedFetch(async (urls) => {
      const result = await advance()

      expect(await pluginRun('github-poll')).toMatchObject({ status: 'success' })
      expect(urls).toHaveLength(1)
      expect(urls[0]).toContain(CONFIGURED_REPO)
      expect(urls[0]).not.toContain(MANIFEST_DEFAULT_REPO)
    })
  })

  test('a configured repo reaches the request and never the run log, on the success path', async () => {
    await grantApproval('github-poll', 4 * 60 * 60 * 1000, approvalPath)
    await mkdir(join(ctx.root, 'config'), { recursive: true })
    await writeFile(
      join(ctx.root, 'config', 'github-poll.json'),
      JSON.stringify({ repo: SENTINEL_REPO }),
    )

    await withStubbedFetch(async (urls) => {
      const result = await advance()

      // Ordered so a failure here reads as a leak and not as a setup miss. The
      // value really flowed, and the run really succeeded — this is the normal
      // path, not an error edge.
      expect(urls[0]).toContain(SENTINEL_SECRET)
      expect(await pluginRun('github-poll')).toMatchObject({ status: 'success' })

      // The raw file text, not one parsed field: `errors[].message` lands in the
      // same document, and so does whatever a later edit adds beside it. The run
      // log is the artifact people paste into issues, so the file is what has to
      // be clean — not the in-memory result.
      const runLog = await readFile(result.run_log_path, 'utf-8')
      expect(runLog).not.toContain(SENTINEL_SECRET)
    })
  })

  test('a plugin declaring no inputs still receives an empty argument object', async () => {
    // Succeeds ONLY on `{}`. A handler that merely ignored its args would pass
    // a test asserting success, and would go on passing if resolution started
    // handing every plugin the previous one's values.
    const dir = join(ctx.pluginsDir, 'no-inputs')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'manifest.ts'),
      `export const manifest = ${JSON.stringify({
        name: 'no-inputs',
        version: '1.0.0',
        description: 'declares nothing and expects nothing',
        outputs: {},
        capabilities: [],
        schedule: 'on_run',
        autonomy_level: 'autonomous',
        side_effects: [],
        ttl_hours: 24,
        dependencies: [],
        timeout_ms: 5000,
        max_parallelism: 1,
        max_retries: 0,
        retry_delay_ms: 1,
        min_tier: 'normal',
      })}`,
    )
    await writeFile(
      join(dir, 'handler.ts'),
      `export async function handler(manifest, args) {
        const empty = args !== null && typeof args === 'object' && Object.keys(args).length === 0
        return {
          status: empty ? 'success' : 'failed',
          phases_completed: empty ? ['no-inputs'] : [],
          phases_failed: empty ? [] : ['no-inputs'],
          errors: empty ? [] : [{ code: 'data_missing', message: 'handler was handed arguments it never declared', impact: 'MEDIUM', retryable: false }],
          data_freshness: {},
          summary: 'no-inputs: ' + (empty ? 'received {}' : 'received keys it never declared'),
          artifacts_produced: [],
          schema_version: 1,
        }
      }`,
    )

    await withStubbedFetch(async () => {
      const result = await advance()

      expect(await pluginRun('no-inputs')).toMatchObject({ status: 'success' })
      const entry = await entryFor(result.run_log_path, 'no-inputs')
      expect(entry?.status).toBe('completed')
    })
  })
})
