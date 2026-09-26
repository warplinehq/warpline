/**
 * The credential shape, held out and proven over every single-token example at
 * once, through the runtime path an adopter's advance takes. A census over the
 * examples directory holds every other example to a list: no credential, or
 * excluded here with its reason.
 *
 * The shape was decided before any of these examples was written, so the
 * examples answer to it and not the other way round. One environment variable
 * per carrier, its name on `secrets` and ending `_TOKEN`. Sent as a Bearer
 * header and nowhere else. No refresh: rewriting the variable is the adopter's
 * job. A 401 fails the run with an `auth_failure` naming the secret, in every
 * carrier. An unset or empty secret refuses the run before the handler is
 * ever called.
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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  /** A file under the home the handler writes on success, which a 401 must leave unwritten. */
  readonly ledger?: string
}

const CARRIERS: readonly Carrier[] = [
  {
    plugin: 'search-console',
    secret: 'SEARCH_CONSOLE_TOKEN',
    args: {},
    witness: { granted: false, reason: 'manual-run' },
  },
  {
    plugin: 'graph-sync',
    secret: 'GRAPH_SYNC_TOKEN',
    args: {},
    seed: (home) => {
      mkdirSync(join(home, 'state'), { recursive: true })
      writeFileSync(join(home, 'state', 'records.json'), JSON.stringify({ records: [{ id: 'r-1' }] }))
    },
    witness: { granted: false, reason: 'manual-run' },
  },
  {
    plugin: 'ledger-runner',
    secret: 'LEDGER_QUOTES_TOKEN',
    args: { instruments: ['example-instrument'] },
    witness: { granted: false, reason: 'manual-run' },
    ledger: 'state/ledger.json',
  },
  {
    plugin: 'cadence-send',
    secret: 'CADENCE_MAIL_TOKEN',
    args: {},
    // The content witness, the arm an operator's `approve --content` produces,
    // because it is the one an advance hands this plugin. The dependency
    // member is ungated, so the outbox reaches the handler under any witness.
    dependencyRuns: {
      'cadence-plan': {
        status: 'success',
        last_output: {
          type: 'outbox',
          format: 'json',
          body: JSON.stringify({
            outbox: [{
              id: 'c-1:1',
              contact_id: 'c-1',
              step: 1,
              to: 'c-1@example.com',
              subject: 'Hello',
              body: 'First note',
              due_at: '2026-01-01T09:00:00.000Z',
            }],
            review_tasks: [],
          }),
        },
      },
    },
    witness: { granted: true, via: 'content-approval', fingerprint: 'credential-shape', effectId: 'credential-shape' },
    ledger: 'state/cadence-send.sent.json',
  },
]

/**
 * The examples that read no credential, pinned so a token added to one is a
 * decision someone saw: each declares no secret and its handler reads no env.
 */
const NON_CARRIERS = [
  'announce-fanout', 'anomaly-watch', 'cadence-plan', 'cadence-replies', 'candidate-promote', 'candidate-propose',
  'competitor-watch', 'daily-digest', 'derived-summary', 'draft-writer', 'feed-monitor', 'feed-triage',
  'github-poll', 'metrics-rollup', 'note-intake',
]

/** Examples that carry a credential in a shape this file does not drive, each with the reason. */
const EXCLUDED: Readonly<Record<string, string>> = {
  'link-enrich': 'three secrets, one per source, so the one-token shape above does not fit; its own handler.test.ts sends each token to its own source\'s authorization header and checks the result and the written file for all three',
  'anomaly-issue': 'reads GITHUB_TOKEN without declaring it on secrets, under the exemption examples-declared-reads.test.ts holds with its reason, so the runtime has no secret to pre-flight and the refusal cases here cannot apply',
}

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
 * authorization header each one carried, and everything else it carried: the
 * URL and the body, so "nowhere else" is checked where a token could go. The
 * success body satisfies every carrier at once: `rows` for search-console,
 * `value` for ledger-runner, and the other two read no body.
 */
function stub(status: 200 | 401) {
  const seen: (string | null)[] = []
  const elsewhere: string[] = []
  const impl = async (input: unknown, init?: RequestInit) => {
    seen.push(new Headers(init?.headers).get('authorization'))
    elsewhere.push(String(input), String(init?.body ?? ''))
    return { ok: status === 200, status, json: async () => (status === 200 ? { rows: [], value: 1 } : {}), text: async () => '' }
  }
  return { seen, elsewhere, impl }
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
    return { res, seen: recorder.seen, elsewhere: recorder.elsewhere }
  } finally {
    globalThis.fetch = real
  }
}

const tokenFor = (c: Carrier) => `credential-shape-${c.plugin}-5e1b`

describe('the credential shape, over every token-carrying example', () => {
  for (const c of CARRIERS) {
    test(`${c.plugin}: the declared secret reaches the API as a Bearer header`, async () => {
      await inHome(async (home) => {
        const { res, seen, elsewhere } = await invoke(c, home, 200, tokenFor(c))
        expect(res.result.status).toBe('success')
        // Non-empty first, so the header check below can't pass over no requests.
        expect(seen.length).toBeGreaterThan(0)
        for (const header of seen) expect(header).toBe(`Bearer ${tokenFor(c)}`)
        // And nowhere else: not in any URL, not in any request body.
        for (const part of elsewhere) expect(part).not.toContain(tokenFor(c))
        // Written here, so its absence after a 401 is the handler's doing and not a path that never existed.
        if (c.ledger !== undefined) expect(existsSync(join(home, c.ledger))).toBe(true)
      })
    })

    test(`${c.plugin}: a 401 stops the run naming the secret, never its value`, async () => {
      await inHome(async (home) => {
        const { res, seen } = await invoke(c, home, 401, tokenFor(c))
        expect(seen.length).toBeGreaterThan(0)
        expect(res.result.status).toBe('failed')
        expect(res.result.errors[0]?.code).toBe('auth_failure')
        expect(res.result.errors[0]?.message).toContain(c.secret)
        expect(JSON.stringify(res)).not.toContain(tokenFor(c))
        if (c.ledger !== undefined) expect(existsSync(join(home, c.ledger))).toBe(false)
      })
    })

    // WR-05. One mistyped `api_base` must not put the token on the wire in clear.
    test(`${c.plugin}: the token goes over cleartext http to loopback only`, async () => {
      const cases = [
        ['http://api.example.com/v1', false],
        ['http://127.0.0.1:8080/v1', true],
        ['http://localhost/v1', true],
        ['http://[::1]/v1', true],
      ] as const
      for (const [api_base, allowed] of cases) {
        await inHome(async (home) => {
          const { res, seen } = await invoke({ ...c, args: { ...c.args, api_base } }, home, 200, tokenFor(c))
          if (allowed) {
            expect(res.result.status).toBe('success')
            expect(seen.length).toBeGreaterThan(0)
          } else {
            expect(res.result.status).toBe('failed')
            expect(res.result.errors[0]?.code).toBe('parse_error')
            expect(res.result.summary).toContain("'api_base'")
            expect(seen).toHaveLength(0)
          }
        })
      }
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

  test('each carrier declares exactly its one _TOKEN, and the non-carriers declare none', async () => {
    const secretsOf = async (plugin: string): Promise<unknown> =>
      ((await import(join(EXAMPLES, plugin, 'manifest.ts'))) as { manifest: { secrets: unknown } }).manifest.secrets
    for (const c of CARRIERS) {
      expect(c.secret).toMatch(/_TOKEN$/)
      expect(await secretsOf(c.plugin)).toEqual([c.secret])
    }
    for (const plugin of NON_CARRIERS) {
      expect(await secretsOf(plugin)).toEqual([])
      expect(readFileSync(join(EXAMPLES, plugin, 'handler.ts'), 'utf-8')).not.toContain('process.env')
    }
  })

  // WR-08. The lists above are hand-kept, so the claim "every token-carrying
  // example" holds only if nothing on disk escapes all of them.
  test('every example directory is a carrier, a non-carrier or excluded with a reason, exactly once', () => {
    const dirs = readdirSync(EXAMPLES, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
    const listed = [...CARRIERS.map((c) => c.plugin), ...NON_CARRIERS, ...Object.keys(EXCLUDED)].sort()
    expect(listed).toEqual(dirs)
    for (const reason of Object.values(EXCLUDED)) expect(reason.length).toBeGreaterThan(40)
  })
})
