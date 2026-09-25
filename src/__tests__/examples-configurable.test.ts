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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
}

/** One run of the scaffolded copy through the runtime, config resolved by the runtime itself. */
async function run(home: string, name: string, opts: RunOptions = {}) {
  const real = globalThis.fetch
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
})
