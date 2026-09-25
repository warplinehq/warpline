/**
 * A scaffolded example changes what it does on config alone.
 *
 * The promise `scaffold --from <example>` makes is that an adopter never has
 * to open a handler to point an example at their own world. Copy it into a
 * home, change only the values in `<home>/config/<name>.json`, and the plugin
 * behaves differently. Nothing else in the suite shows that end to end.
 * `configure.test.ts` shows the defaults parse, and `config-channel-e2e`
 * shows a config value reaching one older example through an advance. This
 * file shows it for every example that takes a choice from its adopter,
 * through the same scaffold and config-resolution code an adopter runs.
 *
 * Each case runs the plugin twice through `invokePlugin`: once with no config
 * file, which is the manifest defaults and the handler's own fallback, then
 * once after the config file is written and nothing else has moved. The
 * observable is compared between the two runs and against the configured
 * value. The copied `handler.ts` is asserted byte-identical to the shipped
 * one, so the only thing that changed between the runs is the config.
 *
 * Each case scaffolds under the example's own name. A dependency is looked up
 * by name and own state is keyed by the manifest name, so this is the home an
 * adopter who took the example as shipped would have.
 *
 * Two homes, both re-rooted per case. `_setHome` reaches the `src` instance of
 * the paths module, which is where scaffold and `invokePlugin` resolve the
 * plugins dir and the config file. The copied handler imports
 * `warpline/lib/paths` through the home's `node_modules/warpline` link into
 * `dist/`, a separate module instance that reads `WARPLINE_HOME` from the env.
 * Both are restored, and the home removed, in `finally`. `fetch` is stubbed in
 * every case that reaches the network, so no request leaves the process.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { scaffoldPlugin } from '../cli/scaffold.js'
import { _setHome } from '../lib/paths.js'
import type { CapabilityGrantWitness, DependencyRun } from '../runtime/capabilities.js'
import { invokePlugin } from '../runtime/invoke-plugin.js'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const EXAMPLES = join(REPO_ROOT, 'examples', 'plugins')

/** The copied handler, byte for byte the shipped one. */
function sameHandler(home: string, name: string): boolean {
  return readFileSync(join(home, 'plugins', name, 'handler.ts')).equals(readFileSync(join(EXAMPLES, name, 'handler.ts')))
}

/**
 * Scaffold `name` from its own example into a fresh temp home, both home
 * instances pointed at it, and run `fn`. Restore both and remove the home.
 */
async function scaffolded(name: string, fn: (home: string) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'warpline-configurable-'))
  const hadEnv = Object.hasOwn(process.env, 'WARPLINE_HOME')
  const priorEnv = process.env.WARPLINE_HOME
  _setHome(home)
  process.env.WARPLINE_HOME = home
  try {
    const res = await scaffoldPlugin(name, { from: name })
    expect(res.created).toBe(true)
    expect(sameHandler(home, name)).toBe(true)
    await fn(home)
    // Still untouched after both runs.
    expect(sameHandler(home, name)).toBe(true)
  } finally {
    _setHome(null)
    if (hadEnv) process.env.WARPLINE_HOME = priorEnv
    else delete process.env.WARPLINE_HOME
    rmSync(home, { recursive: true, force: true })
  }
}

/** Write `<home>/config/<name>.json`, the file `warpline configure` writes. */
function configure(home: string, name: string, values: Record<string, unknown>): void {
  mkdirSync(join(home, 'config'), { recursive: true })
  writeFileSync(join(home, 'config', `${name}.json`), JSON.stringify(values))
}

/** Write a JSON file under the home, parents included. */
function seed(home: string, rel: string, value: unknown): void {
  mkdirSync(dirname(join(home, rel)), { recursive: true })
  writeFileSync(join(home, rel), JSON.stringify(value))
}

interface Request { url: string; method: string; body: string | undefined }

/**
 * A `fetch` that records every request and answers each with `answer` as both
 * its JSON and its text. Swapped in by `run`, restored whatever happens.
 */
function recorder(answer: unknown = {}) {
  const requests: Request[] = []
  const impl = async (input: unknown, init?: RequestInit) => {
    requests.push({ url: String(input), method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : undefined })
    return { ok: true, status: 200, json: async () => answer, text: async () => JSON.stringify(answer) }
  }
  return { requests, impl }
}

interface RunOptions {
  readonly deps?: Readonly<Record<string, DependencyRun | null>>
  readonly witness?: CapabilityGrantWitness
  readonly fetch?: ReturnType<typeof recorder>
  /** The one name on the manifest's `secrets`, set for the run and restored after it. */
  readonly secret?: string
}

/** The witness an operator's `approve --content` produces, the one an advance hands a content-class plugin. */
const CONTENT: CapabilityGrantWitness = {
  granted: true,
  via: 'content-approval',
  fingerprint: 'examples-configurable',
  effectId: 'examples-configurable',
}

/** A dependency's last successful Output, as the engine would hand it over. */
function output(type: string, value: unknown): DependencyRun {
  return { status: 'success', last_output: { type, format: 'json', body: JSON.stringify(value) } }
}

/** The run's one inline Output, parsed, or undefined when it produced none. */
function outputOf<T>(res: Awaited<ReturnType<typeof run>>): T | undefined {
  const first = res.result.artifacts_produced[0]
  return first !== undefined && 'body' in first && typeof first.body === 'string' ? (JSON.parse(first.body) as T) : undefined
}

/** One run of the scaffolded copy through the runtime, config resolved by the runtime itself. */
async function run(home: string, name: string, opts: RunOptions = {}) {
  const real = globalThis.fetch
  const secret = opts.secret
  const hadSecret = secret !== undefined && Object.hasOwn(process.env, secret)
  const priorSecret = secret === undefined ? undefined : process.env[secret]
  if (secret !== undefined) process.env[secret] = 'examples-configurable-token'
  // Any request a case did not expect to make fails loudly instead of leaving the process.
  globalThis.fetch = (opts.fetch?.impl ?? (async () => {
    throw new Error(`${name}: unexpected request`)
  })) as unknown as typeof fetch
  try {
    return await invokePlugin(
      name,
      {},
      { pluginsDir: join(home, 'plugins'), dependencyRuns: opts.deps },
      opts.witness ?? { granted: false, reason: 'manual-run' },
    )
  } finally {
    globalThis.fetch = real
    if (secret !== undefined) {
      if (hadSecret) process.env[secret] = priorSecret
      else delete process.env[secret]
    }
  }
}

describe('a scaffolded example changes behaviour on config alone', () => {
  test('competitor-watch: changing only its config changes what it does', async () => {
    await scaffolded('competitor-watch', async (home) => {
      const before = recorder('a page')
      const first = await run(home, 'competitor-watch', { fetch: before })
      expect(first.result.status).toBe('success')
      expect(before.requests.map((r) => r.url)).toEqual([
        'https://github.com/nodejs/node/tags.atom',
        'https://github.com/oven-sh/bun/tags.atom',
        'https://github.com/denoland/deno/tags.atom',
      ])

      configure(home, 'competitor-watch', { targets: ['https://watch.example.test/configured'] })
      const after = recorder('a page')
      const second = await run(home, 'competitor-watch', { fetch: after })
      expect(second.result.status).toBe('success')
      expect(after.requests.map((r) => r.url)).toEqual(['https://watch.example.test/configured'])
    })
  })

  test('search-console: changing only its config changes what it does', async () => {
    await scaffolded('search-console', async (home) => {
      // Two rows for every request, so the default top 10 reports both and a top 1 reports one.
      const rows = { rows: [{ key: 'alpha', clicks: 5, impressions: 50 }, { key: 'beta', clicks: 3, impressions: 30 }] }
      const before = recorder(rows)
      const first = await run(home, 'search-console', { fetch: before, secret: 'SEARCH_CONSOLE_TOKEN' })
      expect(first.result.status).toBe('success')
      expect(before.requests).toHaveLength(4)
      for (const r of before.requests) expect(r.url).toBe('https://search.example.com/v1/query')
      expect(outputOf<{ queries: unknown[] }>(first)?.queries).toHaveLength(2)

      configure(home, 'search-console', { api_base: 'https://console.example.test/v2', top_n: 1 })
      const after = recorder(rows)
      const second = await run(home, 'search-console', { fetch: after, secret: 'SEARCH_CONSOLE_TOKEN' })
      expect(second.result.status).toBe('success')
      expect(after.requests).toHaveLength(4)
      for (const r of after.requests) expect(r.url.startsWith('https://console.example.test/v2/')).toBe(true)
      expect(outputOf<{ queries: unknown[] }>(second)?.queries).toHaveLength(1)
    })
  })

  test('graph-sync: changing only its config changes what it does', async () => {
    await scaffolded('graph-sync', async (home) => {
      // Nothing at the default records path, so the default run has nothing to send.
      const before = recorder()
      const first = await run(home, 'graph-sync', { fetch: before, secret: 'GRAPH_SYNC_TOKEN' })
      expect(first.result.status).toBe('success')
      expect(before.requests).toEqual([])

      seed(home, 'data/in.json', { records: [{ id: 'r-1', name: 'one' }, { id: 'r-2', name: 'two' }] })
      configure(home, 'graph-sync', { records_path: 'data/in.json', api_base: 'https://sync.example.test' })
      const after = recorder()
      const second = await run(home, 'graph-sync', { fetch: after, secret: 'GRAPH_SYNC_TOKEN' })
      expect(second.result.status).toBe('success')
      expect(after.requests.map((r) => [r.method, r.url])).toEqual([
        ['PUT', 'https://sync.example.test/records/r-1'],
        ['PUT', 'https://sync.example.test/records/r-2'],
      ])
    })
  })

  test('ledger-runner: changing only its config changes what it does', async () => {
    await scaffolded('ledger-runner', async (home) => {
      // No instruments by default, so the default run reads nothing and writes nothing.
      const before = recorder({ value: 7 })
      const first = await run(home, 'ledger-runner', { fetch: before, secret: 'LEDGER_QUOTES_TOKEN' })
      expect(first.result.status).toBe('success')
      expect(before.requests).toEqual([])

      configure(home, 'ledger-runner', {
        instruments: ['example-a', 'example-b'],
        ledger_path: 'data/out.json',
        api_base: 'https://quotes.example.test',
      })
      const after = recorder({ value: 7 })
      const second = await run(home, 'ledger-runner', { fetch: after, secret: 'LEDGER_QUOTES_TOKEN' })
      expect(second.result.status).toBe('success')
      expect(after.requests.map((r) => r.url)).toEqual([
        'https://quotes.example.test/quotes/example-a',
        'https://quotes.example.test/quotes/example-b',
      ])
      const ledger = JSON.parse(readFileSync(join(home, 'data', 'out.json'), 'utf8')) as { values: Record<string, { value: number }> }
      expect(Object.keys(ledger.values).sort()).toEqual(['example-a', 'example-b'])
      expect(ledger.values['example-a']?.value).toBe(7)
      expect(existsSync(join(home, 'state', 'ledger.json'))).toBe(false)
    })
  })

  test('cadence-replies: changing only its config changes what it does', async () => {
    await scaffolded('cadence-replies', async (home) => {
      const first = await run(home, 'cadence-replies')
      expect(first.result.status).toBe('success')
      expect(outputOf(first)).toBeUndefined()

      seed(home, 'data/replies-in.json', { replies: [{ contact_id: 'c-9' }] })
      configure(home, 'cadence-replies', { replies_path: 'data/replies-in.json' })
      const second = await run(home, 'cadence-replies')
      expect(second.result.status).toBe('success')
      expect(outputOf<{ replied: string[] }>(second)?.replied).toEqual(['c-9'])
    })
  })

  test('cadence-plan: changing only its config changes what it does', async () => {
    await scaffolded('cadence-plan', async (home) => {
      const deps = { 'cadence-replies': output('replies', { replied: [] }) }
      const first = await run(home, 'cadence-plan', { deps })
      expect(first.result.status).toBe('success')
      // An empty outbox, never no Output: no Output would leave an approved one live.
      expect(outputOf<{ outbox: unknown[]; review_tasks: unknown[] }>(first)).toEqual({ outbox: [], review_tasks: [] })

      seed(home, 'data/contacts-in.json', {
        contacts: [
          { id: 'c-1', email: 'c-1@example.com', enrolled_at: '2026-01-01T09:00:00.000Z' },
          { id: 'c-2', email: 'c-2@example.com', enrolled_at: '2026-01-01T09:00:00.000Z' },
        ],
      })
      seed(home, 'data/steps-in.json', { steps: [{ offset_days: 0, subject: 'Hello', body: 'First note' }] })
      configure(home, 'cadence-plan', { contacts_path: 'data/contacts-in.json', steps_path: 'data/steps-in.json' })
      const second = await run(home, 'cadence-plan', { deps })
      expect(second.result.status).toBe('success')
      const plan = outputOf<{ outbox: { contact_id: string; subject: string }[] }>(second)
      expect(plan?.outbox.map((e) => e.contact_id)).toEqual(['c-1', 'c-2'])
      expect(plan?.outbox.every((e) => e.subject === 'Hello')).toBe(true)
    })
  })

  test('cadence-send: changing only its config changes what it does', async () => {
    await scaffolded('cadence-send', async (home) => {
      // One email per run. The second run's has a new id: the first is in the
      // send ledger by then, and would be skipped without a request at all.
      const outbox = (id: string) => ({
        'cadence-plan': output('outbox', {
          outbox: [{ id, contact_id: 'c-1', step: 1, to: 'c-1@example.com', subject: 'Hello', body: 'First note', due_at: '2026-01-01T09:00:00.000Z' }],
          review_tasks: [],
        }),
      })
      const before = recorder()
      const first = await run(home, 'cadence-send', { fetch: before, secret: 'CADENCE_MAIL_TOKEN', witness: CONTENT, deps: outbox('c-1:1') })
      expect(first.result.status).toBe('success')
      expect(before.requests.map((r) => r.url)).toEqual(['https://mail.example.com/v1/send'])

      configure(home, 'cadence-send', { api_base: 'https://mailer.example.test' })
      const after = recorder()
      const second = await run(home, 'cadence-send', { fetch: after, secret: 'CADENCE_MAIL_TOKEN', witness: CONTENT, deps: outbox('c-1:2') })
      expect(second.result.status).toBe('success')
      expect(after.requests.map((r) => r.url)).toEqual(['https://mailer.example.test/send'])
    })
  })

  test('candidate-propose: changing only its config changes what it does', async () => {
    await scaffolded('candidate-propose', async (home) => {
      const first = await run(home, 'candidate-propose')
      expect(first.result.status).toBe('success')
      expect(outputOf<{ candidates: unknown[] }>(first)?.candidates).toEqual([])

      seed(home, 'data/pool-in.json', {
        candidates: [
          { id: 'cand-a', title: 'A', score: 1 },
          { id: 'cand-b', title: 'B', score: 4 },
          { id: 'cand-c', title: 'C', score: 3 },
          { id: 'cand-d', title: 'D', score: 2 },
        ],
      })
      configure(home, 'candidate-propose', { pool_path: 'data/pool-in.json' })
      const second = await run(home, 'candidate-propose')
      expect(second.result.status).toBe('success')
      expect(outputOf<{ candidates: { id: string }[] }>(second)?.candidates.map((c) => c.id)).toEqual(['cand-b', 'cand-c', 'cand-d'])
    })
  })

  test('candidate-promote: changing only its config changes what it does', async () => {
    await scaffolded('candidate-promote', async (home) => {
      const candidates = [{ id: 'cand-b', title: 'B', score: 4 }, { id: 'cand-c', title: 'C', score: 3 }]
      const deps = { 'candidate-propose': output('proposal', { candidates }) }
      const first = await run(home, 'candidate-promote', { witness: CONTENT, deps })
      expect(first.result.status).toBe('success')
      const defaultPath = join(home, 'state', 'promoted.json')
      const defaultBytes = readFileSync(defaultPath)
      expect(JSON.parse(defaultBytes.toString('utf8'))).toEqual({ promoted: candidates })

      configure(home, 'candidate-promote', { promoted_path: 'data/promoted-out.json' })
      const configuredPath = join(home, 'data', 'promoted-out.json')
      expect(existsSync(configuredPath)).toBe(false)
      const second = await run(home, 'candidate-promote', { witness: CONTENT, deps })
      expect(second.result.status).toBe('success')
      expect(JSON.parse(readFileSync(configuredPath, 'utf8'))).toEqual({ promoted: candidates })
      expect(readFileSync(defaultPath).equals(defaultBytes)).toBe(true)
    })
  })
})
