/**
 * The credential shape, held out and proven over every token-carrying example
 * at once, through the runtime path an adopter's advance takes.
 *
 * The shape was decided before any of these examples was written, so the
 * examples answer to it and not the other way round. One environment variable
 * per carrier, its name on `secrets` and ending `_TOKEN`. Sent as a Bearer
 * header and nowhere else. No refresh: rewriting the variable is the adopter's
 * job. A 401 fails the run and names the secret by name. An unset or empty
 * secret refuses the run before the handler is ever called.
 *
 * Why `invokePlugin` and not the handler. Each carrier's own `handler.test.ts`
 * already calls its handler with the variable set. What that can't show is the
 * half the runtime owns: config resolution, the secret pre-flight, the
 * capability mint and the scrub, in the order an advance meets them. The
 * refusal cases only mean something here. Called directly, a handler has its
 * own fallback arm for a missing token, and a green there says nothing about
 * whether the runtime refused first. Zero requests at the stub does.
 *
 * Why the value check here is only a backstop. The runtime scrubs every
 * resolved secret value out of the result at the parse boundary, so a handler
 * that leaked its token would be redacted before this file saw it. The leak
 * check that can actually fail lives on the raw handler return, in each
 * carrier's own test. This one pins that nothing past the scrub carries it.
 *
 * Why never `runAdvance`. A failed fire of a content-class plugin latches its
 * approval, so a 401 driven through an advance would test the latch as much
 * as the credential. `invokePlugin` takes no spend mark.
 *
 * Two homes, both re-rooted per case. `_setHome` reaches the `src` instance of
 * the paths module, which is where `invokePlugin` resolves config. The
 * handlers import `warpline/lib/paths` through the exports map into `dist/`,
 * a different module instance that reads `WARPLINE_HOME` from the env. The
 * plugins directory is the shipped `examples/plugins` itself, and nothing is
 * written anywhere but the case's temp home.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _setHome } from '../lib/paths.js'
import type { CapabilityGrantWitness, DependencyRun } from '../runtime/capabilities.js'
import { invokePlugin } from '../runtime/invoke-plugin.js'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const EXAMPLES = join(REPO_ROOT, 'examples', 'plugins')

interface Carrier {
  /** The directory under examples/plugins. */
  readonly plugin: string
  /** The one name on its manifest's `secrets`. */
  readonly secret: string
  readonly args: Record<string, unknown>
  /** Whatever the handler needs under the home before its first request. */
  readonly seed?: (home: string) => void
  readonly dependencyRuns?: Readonly<Record<string, DependencyRun | null>>
  readonly witness: CapabilityGrantWitness
}

const CARRIERS: readonly Carrier[] = [
  {
    plugin: 'search-console',
    secret: 'SEARCH_CONSOLE_TOKEN',
    args: {},
    witness: { granted: false, reason: 'manual-run' },
  },
]

/** Run `fn` in a fresh temp home, both home instances pointed at it; restore both and remove it. */
async function inHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'warpline-credential-shape-'))
  const hadEnv = Object.hasOwn(process.env, 'WARPLINE_HOME')
  const priorEnv = process.env.WARPLINE_HOME
  _setHome(home)
  process.env.WARPLINE_HOME = home
  try {
    return await fn(home)
  } finally {
    _setHome(null)
    if (hadEnv) process.env.WARPLINE_HOME = priorEnv
    else delete process.env.WARPLINE_HOME
    rmSync(home, { recursive: true, force: true })
  }
}

/** Set `name` to `value`, or delete it when `value` is undefined; restore exactly afterwards. */
async function withSecret<T>(name: string, value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const had = Object.hasOwn(process.env, name)
  const prior = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
  try {
    return await fn()
  } finally {
    if (had) process.env[name] = prior
    else delete process.env[name]
  }
}

/**
 * A `fetch` that answers every request with `status` and records the
 * authorization header each one carried. The success body satisfies every
 * carrier at once: `rows` for search-console, `value` for ledger-runner, and
 * the other two read no body.
 */
function stub(status: 200 | 401) {
  const seen: (string | null)[] = []
  const impl = async (_input: unknown, init?: RequestInit) => {
    seen.push(new Headers(init?.headers).get('authorization'))
    return { ok: status === 200, status, json: async () => (status === 200 ? { rows: [], value: 1 } : {}), text: async () => '' }
  }
  return { seen, impl }
}

/** One invocation of `c` through the runtime, in `home`, under `status`, with the secret as given. */
async function invoke(c: Carrier, home: string, status: 200 | 401, value: string | undefined) {
  c.seed?.(home)
  const recorder = stub(status)
  const real = globalThis.fetch
  globalThis.fetch = recorder.impl as unknown as typeof fetch
  try {
    const res = await withSecret(c.secret, value, () =>
      invokePlugin(c.plugin, c.args, { pluginsDir: EXAMPLES, dependencyRuns: c.dependencyRuns }, c.witness))
    return { res, seen: recorder.seen }
  } finally {
    globalThis.fetch = real
  }
}

const tokenFor = (c: Carrier) => `credential-shape-${c.plugin}-5e1b`

describe('the credential shape, over every token-carrying example', () => {
  for (const c of CARRIERS) {
    test(`${c.plugin}: the declared secret reaches the API as a Bearer header`, async () => {
      await inHome(async (home) => {
        const { res, seen } = await invoke(c, home, 200, tokenFor(c))
        expect(res.result.status).toBe('success')
        // Non-empty first, so the header check below can't pass over no requests.
        expect(seen.length).toBeGreaterThan(0)
        for (const header of seen) expect(header).toBe(`Bearer ${tokenFor(c)}`)
      })
    })

    test(`${c.plugin}: a 401 fails the run naming the secret, never its value`, async () => {
      await inHome(async (home) => {
        const { res, seen } = await invoke(c, home, 401, tokenFor(c))
        expect(seen.length).toBeGreaterThan(0)
        expect(res.result.status).toBe('failed')
        expect(res.result.errors[0]?.code).toBe('auth_failure')
        expect(res.result.errors[0]?.message).toContain(c.secret)
        expect(JSON.stringify(res)).not.toContain(tokenFor(c))
      })
    })

    for (const [label, value] of [['unset', undefined], ['empty', '']] as const) {
      test(`${c.plugin}: an ${label} secret is refused by name before the handler runs`, async () => {
        await inHome(async (home) => {
          const { res, seen } = await invoke(c, home, 200, value)
          expect(res.result.status).toBe('failed')
          expect(res.result.errors[0]?.code).toBe('auth_failure')
          expect(res.result.errors[0]?.message).toContain(c.secret)
          expect(seen).toHaveLength(0)
        })
      })
    }
  }
})
