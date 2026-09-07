import { describe, test, expect } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginManifest } from 'warpline/schemas/plugin-manifest'
import type { CapabilityContext, DependenciesHandle } from 'warpline/unstable-capabilities'
import { SkillResultSchema, type OutputRecord } from 'warpline/schemas/skill-result'
import { pending, issueFor, fileIssues, handler, type Anomaly } from './handler.js'

/**
 * The closed status vocabulary, named through the published handle type rather
 * than restated here — a second copy of an enum is a second thing that can go
 * out of date.
 */
type RunStatus = ReturnType<DependenciesHandle['lastRun']>

/**
 * The fourth parameter, carrying the two members this handler reads.
 *
 * A hand-written literal and not the runtime's mint: an example may import
 * only the three `warpline/unstable-*` specifiers, so `src/` is out of reach
 * from here on purpose. What that costs is stated rather than hidden — this
 * file proves the HANDLER does the right thing with each of the four states,
 * and the runtime's DELIVERY of them is proven under `src/`.
 *
 * Both members throw for any name but `anomaly-watch`, mirroring the runtime's
 * shared refusal, so the handler is never written against a `null` it would
 * not receive.
 *
 * The default pairs the two facts coherently: a fixture handing over a record
 * without saying how the last run ended models a producer that succeeded, and
 * one handing over nothing models a producer that has never run. Every case
 * that means something else says so.
 */
function contextWith(record: OutputRecord | null, run: RunStatus = record === null ? null : 'success'): CapabilityContext {
  const declared = (name: string): void => {
    if (name !== 'anomaly-watch') {
      throw new Error(`anomaly-issue does not declare '${name}' in manifest.dependencies`)
    }
  }
  return {
    caller: { plugin: 'anomaly-issue' },
    secrets: { resolvedNames: () => [] },
    dependencies: {
      lastOutput: (_caller, name: string) => {
        declared(name)
        return record
      },
      lastRun: (_caller, name: string) => {
        declared(name)
        return run
      },
    },
  } as CapabilityContext
}

/** An inline-body Output in the shape `anomaly-watch` returns. */
function outputOf(body: unknown): OutputRecord {
  return { type: 'anomalies', format: 'json', body: JSON.stringify(body) }
}

/**
 * Runs `fn` against a throwaway home with a token set. `warpline/lib/paths`
 * exports only `warplineHome`, which resolves `WARPLINE_HOME` per call — the
 * seam a plugin author has. Every arm below the token check needs both.
 */
async function withHomeAndToken<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'anomaly-issue-'))
  const realHome = process.env.WARPLINE_HOME
  const realToken = process.env.GITHUB_TOKEN
  process.env.WARPLINE_HOME = home
  process.env.GITHUB_TOKEN = 'tok-123'
  try {
    return await fn(home)
  } finally {
    if (realHome === undefined) delete process.env.WARPLINE_HOME
    else process.env.WARPLINE_HOME = realHome
    if (realToken === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = realToken
    await rm(home, { recursive: true, force: true })
  }
}

/** Swaps `globalThis.fetch` for the duration of `fn`. */
async function withFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch
  globalThis.fetch = impl
  try {
    return await fn()
  } finally {
    globalThis.fetch = real
  }
}

const errors: Anomaly = { name: 'errors', latest: 42, threshold: 10, direction: 'above' }
const signups: Anomaly = { name: 'signups', latest: 3, threshold: 5, direction: 'below' }

describe('anomaly-issue pending', () => {
  test('drops anomalies already in the ledger', () => {
    expect(pending([errors, signups], { errors: 'https://github.com/o/r/issues/1' })).toEqual([signups])
  })

  test('returns all anomalies for an empty ledger', () => {
    expect(pending([errors, signups], {})).toEqual([errors, signups])
  })

  test('does not treat Object.prototype keys as already filed', () => {
    const proto: Anomaly = { name: 'constructor', latest: 1, threshold: 0, direction: 'above' }
    expect(pending([proto], {})).toEqual([proto])
  })
})

describe('anomaly-issue issueFor', () => {
  test('renders the fixed title and a four-row table body', () => {
    const { title, body } = issueFor(errors)
    expect(title).toBe('[anomaly] errors: 42 above threshold 10')
    expect(body).toContain('| name | errors |')
    expect(body).toContain('| latest | 42 |')
    expect(body).toContain('| threshold | 10 |')
    expect(body).toContain('| direction | above |')
  })
})

type Call = { url: string; init: RequestInit }

function fakeFetch(responses: { ok: boolean; status: number; html_url?: string }[]) {
  const calls: Call[] = []
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    const r = responses[calls.length - 1] ?? { ok: false, status: 500 }
    return { ok: r.ok, status: r.status, json: async () => ({ html_url: r.html_url }) }
  }) as unknown as typeof fetch
  return { calls, impl }
}

describe('anomaly-issue fileIssues', () => {
  const signal = new AbortController().signal

  test('POSTs one issue per anomaly with the token in the authorization header', async () => {
    const { calls, impl } = fakeFetch([
      { ok: true, status: 201, html_url: 'https://github.com/o/r/issues/1' },
      { ok: true, status: 201, html_url: 'https://github.com/o/r/issues/2' },
    ])
    const out = await fileIssues('o/r', [errors, signups], 'tok-123', impl, signal)

    expect(calls).toHaveLength(2)
    expect(calls[0]?.url).toBe('https://api.github.com/repos/o/r/issues')
    expect(calls[0]?.init.method).toBe('POST')
    expect(calls[0]?.init.signal).toBe(signal)
    expect(calls[0]?.init.headers).toEqual({
      accept: 'application/vnd.github+json',
      authorization: 'Bearer tok-123',
      'user-agent': 'warpline-example',
      'content-type': 'application/json',
    })
    expect(calls[0]?.init.body).toBe(JSON.stringify(issueFor(errors)))
    expect(out).toEqual({
      created: [
        { name: 'errors', url: 'https://github.com/o/r/issues/1' },
        { name: 'signups', url: 'https://github.com/o/r/issues/2' },
      ],
      error: null,
      stoppedAt: null,
    })
  })

  test('stops at the first non-ok response with a non-retryable error', async () => {
    const { calls, impl } = fakeFetch([
      { ok: true, status: 201, html_url: 'https://github.com/o/r/issues/1' },
      { ok: false, status: 500 },
    ])
    const third: Anomaly = { name: 'latency', latest: 9, threshold: 1, direction: 'above' }
    const out = await fileIssues('o/r', [errors, signups, third], 'tok-123', impl, signal)

    expect(calls).toHaveLength(2)
    expect(out.created).toHaveLength(1)
    expect(out.error?.code).toBe('dependency_unavailable')
    expect(out.error?.retryable).toBe(false)
    expect(out.error?.message).toContain('500')
    expect(out.error?.message).toContain('signups')
    expect(out.stoppedAt).toBe('signups')
  })

  test('401 and 403 are auth failures', async () => {
    const { impl } = fakeFetch([{ ok: false, status: 401 }])
    const out = await fileIssues('o/r', [errors], 'tok-123', impl, signal)
    expect(out.created).toEqual([])
    expect(out.error?.code).toBe('auth_failure')
    expect(out.error?.retryable).toBe(false)
  })

  test('a rejected fetch returns what was created instead of throwing', async () => {
    let n = 0
    const impl = (async () => {
      if (n++ === 0) return { ok: true, status: 201, json: async () => ({ html_url: 'https://github.com/o/r/issues/1' }) }
      throw new Error('ECONNRESET')
    }) as unknown as typeof fetch

    const out = await fileIssues('o/r', [errors, signups], 'tok-123', impl, signal)
    expect(out.created).toEqual([{ name: 'errors', url: 'https://github.com/o/r/issues/1' }])
    expect(out.error?.code).toBe('dependency_unavailable')
    // The thrown error's own message is NOT forwarded: a failed fetch reports
    // the request URL, which embeds the configured repo.
    expect(out.error?.message).toContain('request failed')
    expect(out.error?.message).toContain('signups')
    expect(out.stoppedAt).toBe('signups')
  })

  test('a response without html_url still records the issue as created, and names it as where the loop stopped', async () => {
    const { impl } = fakeFetch([{ ok: true, status: 201 }])
    const out = await fileIssues('o/r', [errors], 'tok-123', impl, signal)
    expect(out.created).toHaveLength(1)
    expect(out.error?.code).toBe('parse_error')
    // This arm pushes to `created` AND returns an error, so a count-derived
    // name would point one past it: at the next anomaly, or at nothing.
    expect(out.stoppedAt).toBe('errors')
  })
})

describe('anomaly-issue handler ledger', () => {
  test('writes the ledger for issues filed before a fetch throws', async () => {
    // `warpline/lib/paths` exports only `warplineHome`, which resolves
    // `WARPLINE_HOME` per call — the same seam a plugin author has.
    const home = await mkdtemp(join(tmpdir(), 'anomaly-issue-'))
    const realFetch = globalThis.fetch
    const realToken = process.env.GITHUB_TOKEN
    const realHome = process.env.WARPLINE_HOME
    process.env.WARPLINE_HOME = home
    process.env.GITHUB_TOKEN = 'tok-123'

    let n = 0
    globalThis.fetch = (async () => {
      if (n++ === 0) return { ok: true, status: 201, json: async () => ({ html_url: 'https://github.com/o/r/issues/1' }) }
      throw new Error('ECONNRESET')
    }) as unknown as typeof fetch

    try {
      const result = await handler(
        {} as PluginManifest,
        { repo: 'o/r' },
        new AbortController().signal,
        contextWith(outputOf({ anomalies: [errors, signups] })),
      )
      expect(result.status).toBe('partial')
      // The partial arm is built on the result builder too: no builder emits
      // `partial`, so the status is set over `skillOk`'s result, and the
      // handler still writes no schema_version of its own.
      expect(result.schema_version).toBeUndefined()
      expect(result.errors?.[0]?.code).toBe('dependency_unavailable')
      expect(result.summary).toContain('filed 1 issues: errors')
      expect(result.summary).toContain('stopped at signups')
      const ledger = JSON.parse(await readFile(join(home, 'state', 'anomaly-issue.filed.json'), 'utf-8'))
      expect(ledger.filed).toEqual({ errors: 'https://github.com/o/r/issues/1' })
    } finally {
      globalThis.fetch = realFetch
      if (realToken === undefined) delete process.env.GITHUB_TOKEN
      else process.env.GITHUB_TOKEN = realToken
      if (realHome === undefined) delete process.env.WARPLINE_HOME
      else process.env.WARPLINE_HOME = realHome
      await rm(home, { recursive: true, force: true })
    }
  })

  test('refuses to file when the ledger exists but cannot be parsed', async () => {
    const home = await mkdtemp(join(tmpdir(), 'anomaly-issue-'))
    const realFetch = globalThis.fetch
    const realToken = process.env.GITHUB_TOKEN
    const realHome = process.env.WARPLINE_HOME
    process.env.WARPLINE_HOME = home
    process.env.GITHUB_TOKEN = 'tok-123'

    await mkdir(join(home, 'state'), { recursive: true })
    await writeFile(join(home, 'state', 'anomaly-issue.filed.json'), '{"filed": {truncat')

    globalThis.fetch = (async () => {
      throw new Error('fetch must not be called')
    }) as unknown as typeof fetch

    try {
      const result = await handler(
        {} as PluginManifest,
        { repo: 'o/r' },
        new AbortController().signal,
        contextWith(outputOf({ anomalies: [errors] })),
      )
      expect(result.status).toBe('failed')
      expect(result.errors?.[0]?.code).toBe('parse_error')
      expect(result.summary).toContain('would duplicate')
      // The home path and the parser's words both land in the run log if
      // forwarded; the refusal names neither.
      expect(JSON.stringify(result)).not.toContain(home)
      expect(JSON.stringify(result)).not.toContain('JSON')
      expect(await readFile(join(home, 'state', 'anomaly-issue.filed.json'), 'utf-8')).toBe('{"filed": {truncat')
    } finally {
      globalThis.fetch = realFetch
      if (realToken === undefined) delete process.env.GITHUB_TOKEN
      else process.env.GITHUB_TOKEN = realToken
      if (realHome === undefined) delete process.env.WARPLINE_HOME
      else process.env.WARPLINE_HOME = realHome
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('anomaly-issue handler result construction', () => {
  test('an invalid repo is a failure built by the result builder, with no schema_version written by the handler', async () => {
    const result = await handler({} as PluginManifest, { repo: 'not-a-repo' }, new AbortController().signal, contextWith(null))
    expect(result.status).toBe('failed')
    expect(result.errors?.[0]?.code).toBe('parse_error')
    expect(result.schema_version).toBeUndefined()
    // The schema's own default applies at the boundary, not a literal here.
    expect(SkillResultSchema.parse(result).schema_version).toBe(2)
  })

  test('a missing GITHUB_TOKEN is an auth failure that names the variable and never a token value', async () => {
    const real = process.env.GITHUB_TOKEN
    delete process.env.GITHUB_TOKEN
    try {
      const result = await handler({} as PluginManifest, { repo: 'o/r' }, new AbortController().signal, contextWith(null))
      expect(result.status).toBe('failed')
      expect(result.errors?.[0]?.code).toBe('auth_failure')
      expect(result.errors?.[0]?.message).toContain('GITHUB_TOKEN')
      expect(JSON.stringify(result)).not.toContain('Bearer')
      expect(result.schema_version).toBeUndefined()
    } finally {
      if (real === undefined) delete process.env.GITHUB_TOKEN
      else process.env.GITHUB_TOKEN = real
    }
  })

  test('a dependency that has produced nothing is a success built by the result builder, never a bare skipped', async () => {
    await withHomeAndToken(async () => {
      const result = await handler(
        {} as PluginManifest,
        { repo: 'o/r' },
        new AbortController().signal,
        contextWith(null),
      )
      expect(result.status).toBe('success')
      expect(result.summary).toContain('anomaly-watch')
      expect(result.summary).toContain('nothing to file')
      expect(result.schema_version).toBeUndefined()
    })
  })

  test('filing every anomaly is a success with the undo instruction and no schema_version', async () => {
    await withHomeAndToken(async () => {
      const impl = (async () => ({
        ok: true,
        status: 201,
        json: async () => ({ html_url: 'https://github.com/o/r/issues/1' }),
      })) as unknown as typeof fetch

      const result = await withFetch(impl, () =>
        handler({} as PluginManifest, { repo: 'o/r' }, new AbortController().signal, contextWith(outputOf({ anomalies: [errors] }))))

      expect(result.status).toBe('success')
      expect(result.reversible).toBe(false)
      expect(result.undo_instruction).toContain('https://github.com/o/r/issues/1')
      expect(result.schema_version).toBeUndefined()
      expect(SkillResultSchema.parse(result).status).toBe('success')
    })
  })

  test('an issue created without an html_url is a partial run whose summary names THAT anomaly as where it stopped', async () => {
    await withHomeAndToken(async home => {
      // The failing anomaly is the LAST one, so a count-derived name is
      // `undefined` rather than merely the wrong neighbour.
      const { impl } = fakeFetch([
        { ok: true, status: 201, html_url: 'https://github.com/o/r/issues/1' },
        { ok: true, status: 201 },
      ])

      const result = await withFetch(impl, () =>
        handler({} as PluginManifest, { repo: 'o/r' }, new AbortController().signal, contextWith(outputOf({ anomalies: [errors, signups] }))))

      expect(result.status).toBe('partial')
      expect(result.summary).toContain('filed 2 issues: errors, signups')
      expect(result.summary).toContain('stopped at signups')
      expect(result.summary).not.toContain('undefined')
      // Both are in the ledger: the second issue exists on GitHub too.
      const ledger = JSON.parse(await readFile(join(home, 'state', 'anomaly-issue.filed.json'), 'utf-8'))
      expect(Object.keys(ledger.filed)).toEqual(['errors', 'signups'])
    })
  })

  test('a second run in the same home reads the ledger and files nothing', async () => {
    await withHomeAndToken(async () => {
      let calls = 0
      const impl = (async () => {
        calls++
        return { ok: true, status: 201, json: async () => ({ html_url: 'https://github.com/o/r/issues/1' }) }
      }) as unknown as typeof fetch
      const args = { repo: 'o/r' }
      const context = contextWith(outputOf({ anomalies: [errors] }))

      const first = await withFetch(impl, () => handler({} as PluginManifest, args, new AbortController().signal, context))
      const second = await withFetch(impl, () => handler({} as PluginManifest, args, new AbortController().signal, context))

      expect(first.status).toBe('success')
      expect(calls).toBe(1)
      expect(second.status).toBe('success')
      expect(second.summary).toBe('no new anomalies (1 already filed)')
      expect(second.schema_version).toBeUndefined()
    })
  })

  test('a __proto__ anomaly name lands in the ledger as an own property, not on the prototype', async () => {
    await withHomeAndToken(async home => {
      const proto: Anomaly = { name: '__proto__', latest: 1, threshold: 0, direction: 'above' }
      const impl = (async () => ({
        ok: true,
        status: 201,
        json: async () => ({ html_url: 'https://github.com/o/r/issues/9' }),
      })) as unknown as typeof fetch
      const args = { repo: 'o/r' }
      const context = contextWith(outputOf({ anomalies: [proto] }))

      const first = await withFetch(impl, () => handler({} as PluginManifest, args, new AbortController().signal, context))
      expect(first.status).toBe('success')

      // Serialised as an own key — a plain object would have set the prototype
      // and written `{}`, re-filing the anomaly on every run.
      const raw = await readFile(join(home, 'state', 'anomaly-issue.filed.json'), 'utf-8')
      expect(raw).toContain('"__proto__": "https://github.com/o/r/issues/9"')
      expect(Object.hasOwn(Object.prototype, 'filed')).toBe(false)
      expect(({} as Record<string, unknown>).__proto__).toBe(Object.prototype)

      const second = await withFetch(impl, () => handler({} as PluginManifest, args, new AbortController().signal, context))
      expect(second.summary).toBe('no new anomalies (1 already filed)')
    })
  })
})

/**
 * `repo` arrives from `<home>/config/anomaly-issue.json`, and every
 * `SkillResult` field this handler returns is written to a run log —
 * `engine.ts` copies `summary` into `plugin_entries[].result_summary` on every
 * run, success included. So an arm that quotes the value it was handed is a
 * disclosure path from the operator's config file to a document that gets
 * pasted into issues.
 *
 * Each sentinel below is shaped to PASS the guard above the arm it targets.
 * A sentinel that stops at the first input check proves nothing about the arms
 * beneath it, which is exactly how the success-path leak shipped green.
 */
describe('anomaly-issue config value disclosure', () => {
  const SENTINEL = 'do-not-echo-a1b2c3'
  const sentinelRepo = `sentinel-owner/${SENTINEL}`

  /** Sets GITHUB_TOKEN so the arms below the token check are reachable. */
  async function withToken<T>(fn: () => Promise<T>): Promise<T> {
    const real = process.env.GITHUB_TOKEN
    process.env.GITHUB_TOKEN = 'tok-123'
    try {
      return await fn()
    } finally {
      if (real === undefined) delete process.env.GITHUB_TOKEN
      else process.env.GITHUB_TOKEN = real
    }
  }

  test('an invalid repo is rejected without the value appearing anywhere in the result', async () => {
    const result = await handler(
      {} as PluginManifest,
      { repo: SENTINEL },
      new AbortController().signal,
      contextWith(null),
    )

    expect(result.status).toBe('failed')
    expect(result.errors?.[0]?.code).toBe('parse_error')
    // The whole result, not one field: summary and errors[].message both reach
    // the run log, and so does whatever a later edit adds beside them.
    expect(JSON.stringify(result)).not.toContain(SENTINEL)
    expect(result.errors?.[0]?.message).toContain('repo')
    expect(result.errors?.[0]?.message).toContain('owner/name')
  })

  test('a dependency that produced nothing reports it without naming the configured repo', async () => {
    await withToken(async () => {
      const result = await handler(
        {} as PluginManifest,
        { repo: sentinelRepo },
        new AbortController().signal,
        contextWith(null),
      )

      expect(result.status).toBe('success')
      // The dependency IS named — a green run that filed nothing has to be
      // legible in the run log — and the configured value still is not.
      expect(result.summary).toContain('anomaly-watch')
      expect(JSON.stringify(result)).not.toContain(SENTINEL)
    })
  })

  test('a filing failure names the anomaly and the status, not the repo', async () => {
    const { impl } = fakeFetch([{ ok: false, status: 500 }])
    const out = await fileIssues(sentinelRepo, [errors], 'tok-123', impl, new AbortController().signal)

    expect(out.error?.code).toBe('dependency_unavailable')
    expect(JSON.stringify(out)).not.toContain(SENTINEL)
    expect(out.error?.message).toContain('500')
    expect(out.error?.message).toContain('errors')
  })

  test('a created issue with no html_url records a placeholder, not a repo URL', async () => {
    // This url reaches `undo_instruction`, a SkillResult field, and the ledger.
    const { impl } = fakeFetch([{ ok: true, status: 201 }])
    const out = await fileIssues(sentinelRepo, [errors], 'tok-123', impl, new AbortController().signal)

    expect(out.created).toHaveLength(1)
    expect(JSON.stringify(out.created)).not.toContain(SENTINEL)
  })

  // The second carve-out from the never-echo rule, and the only other one.
  // A filed issue's URL contains the configured repo, and it has to: an undo
  // instruction that does not name what to close cannot be acted on. The bound
  // is the same shape as the handoff exception — one field, and every other
  // field stays value-free. This test is what holds it to one field.
  test('a filed issue URL reaches undo_instruction and nothing else', async () => {
    const realFetch = globalThis.fetch
    const dir = await mkdtemp(join(tmpdir(), 'anomaly-issue-undo-'))
    const priorToken = process.env.GITHUB_TOKEN
    const priorHome = process.env.WARPLINE_HOME
    process.env.GITHUB_TOKEN = 'tok-123'
    // The ledger is written under the warpline home; re-root it so this test
    // writes nothing outside its temp dir (CLAUDE.md rule 2).
    process.env.WARPLINE_HOME = join(dir, 'home')
    const issueUrl = `https://github.com/${sentinelRepo}/issues/7`

    try {
      globalThis.fetch = (async () => ({
        ok: true,
        status: 201,
        json: async () => ({ html_url: issueUrl }),
      })) as unknown as typeof fetch

      const result = await handler(
        {} as PluginManifest,
        { repo: sentinelRepo },
        new AbortController().signal,
        contextWith(outputOf({ anomalies: [errors] })),
      )

      // The carve-out itself: the URL is here, because a human needs it.
      expect(result.undo_instruction).toContain(issueUrl)

      // And it is here ONLY. Strip the one excepted field and the rest of the
      // result must be free of the configured value — the same strong form the
      // feed-triage handoff test uses when it splits on `Context: `.
      const { undo_instruction: _excepted, ...rest } = result
      expect(JSON.stringify(rest)).not.toContain(SENTINEL)
      expect(result.summary).not.toContain(SENTINEL)
    } finally {
      globalThis.fetch = realFetch
      if (priorToken === undefined) delete process.env.GITHUB_TOKEN
      else process.env.GITHUB_TOKEN = priorToken
      if (priorHome === undefined) delete process.env.WARPLINE_HOME
      else process.env.WARPLINE_HOME = priorHome
      await rm(dir, { recursive: true, force: true })
    }
  })
})

/**
 * The negative control: the same handler, the same home, the same injected
 * `fetch` — and four different answers from the one member it reads.
 *
 * Every case asserts the ACT, never the status. The handler returns `skillOk`
 * on BOTH "the dependency produced nothing" and "nothing new to file", so a
 * test asserting only `status === 'success'` is green over a handler that
 * reads nothing at all and calls out to nothing. What tells those apart is the
 * `fetch` count and the ledger: three negatives asserting zero prove nothing
 * on their own, which is why the positive asserts the count went up.
 *
 * What this file cannot do is prove the RUNTIME delivers these three states —
 * an example may import only the three `warpline/unstable-*` specifiers, so
 * the mint is out of reach from here. That tier lives under `src/`.
 */
describe('anomaly-issue against what its dependency produced', () => {
  const ISSUE = 'https://github.com/o/r/issues/1'
  const OBSERVED_AT = '2026-01-01T00:00:00.000Z'

  /** A fetch that always creates an issue, and says how many times it was asked. */
  const creates = (bump: () => void): typeof fetch =>
    (async () => {
      bump()
      return { ok: true, status: 201, json: async () => ({ html_url: ISSUE }) }
    }) as unknown as typeof fetch

  /** The ledger as bytes, or `null` when the handler never wrote one. */
  const ledgerOf = (home: string): Promise<string | null> =>
    readFile(join(home, 'state', 'anomaly-issue.filed.json'), 'utf-8').catch(() => null)

  test('an Output carrying anomalies files one issue per anomaly', async () => {
    await withHomeAndToken(async home => {
      let calls = 0
      const result = await withFetch(creates(() => { calls++ }), () =>
        handler(
          {} as PluginManifest,
          { repo: 'o/r' },
          new AbortController().signal,
          contextWith(outputOf({ observed_at: OBSERVED_AT, anomalies: [errors, signups] })),
        ))

      expect(calls).toBeGreaterThanOrEqual(1)
      expect(result.status).toBe('success')
      const ledger = await ledgerOf(home)
      expect(ledger).not.toBeNull()
      expect(Object.keys(JSON.parse(ledger!).filed)).toEqual(['errors', 'signups'])
    })
  })

  test('no Output at all files nothing, and says which dependency produced none', async () => {
    await withHomeAndToken(async home => {
      let calls = 0
      const result = await withFetch(creates(() => { calls++ }), () =>
        handler({} as PluginManifest, { repo: 'o/r' }, new AbortController().signal, contextWith(null)))

      expect(calls).toBe(0)
      expect(await ledgerOf(home)).toBeNull()
      expect(result.status).toBe('success')
      // Named, so a green run that filed nothing is legible in the run log
      // rather than indistinguishable from a run with nothing new.
      expect(result.summary).toContain('anomaly-watch')
    })
  })

  test('an Output carrying an empty anomalies array files nothing', async () => {
    await withHomeAndToken(async home => {
      let calls = 0
      const result = await withFetch(creates(() => { calls++ }), () =>
        handler(
          {} as PluginManifest,
          { repo: 'o/r' },
          new AbortController().signal,
          contextWith(outputOf({ observed_at: OBSERVED_AT, anomalies: [] })),
        ))

      expect(calls).toBe(0)
      expect(await ledgerOf(home)).toBeNull()
      expect(result.status).toBe('success')
    })
  })

  test('an Output in the pre-rename shape files nothing and does not throw', async () => {
    // The one-advance upgrade window: a home where the producer last ran under
    // 0.3.x holds a body keyed for the series-name-list concept. It self-heals
    // on the producer's next run. Asserting this is also what proves no
    // tolerance branch accepts both keys — one that did would file here.
    await withHomeAndToken(async home => {
      let calls = 0
      const result = await withFetch(creates(() => { calls++ }), () =>
        handler(
          {} as PluginManifest,
          { repo: 'o/r' },
          new AbortController().signal,
          contextWith(outputOf({ observed_at: OBSERVED_AT, breached: [errors, signups] })),
        ))

      expect(calls).toBe(0)
      expect(await ledgerOf(home)).toBeNull()
      expect(result.status).toBe('success')
    })
  })

  test('a name the manifest does not declare throws rather than reading as null', () => {
    const context = contextWith(outputOf({ observed_at: OBSERVED_AT, anomalies: [errors] }))
    // The runtime's refusal, mirrored: a typo in `manifest.dependencies` and a
    // dependency that has not run are two unrelated fixes, and returning `null`
    // for both would make the wrong one look like waiting.
    expect(() => context.dependencies.lastOutput(context.caller, 'anomaly-wach')).toThrow('anomaly-wach')
    // Per member, because the obligation is: an arm asserting only the first
    // stays green over a second member that answers for anything asked of it.
    expect(() => context.dependencies.lastRun(context.caller, 'anomaly-wach')).toThrow('anomaly-wach')
    expect(context.dependencies.lastOutput(context.caller, 'anomaly-watch')).not.toBeNull()
    expect(context.dependencies.lastRun(context.caller, 'anomaly-watch')).toBe('success')
  })
})

/**
 * The four states the pair names, and the three the handler used to answer
 * with one sentence.
 *
 * Reading `lastOutput` alone cannot tell a producer that has never started
 * from one that ran and produced nothing, and it cannot tell a current record
 * from one that predates a failed run. Each case below asserts the SENTENCE,
 * because the sentence is what reaches the run log and, for the digest one
 * tier down, what reaches a downstream reader.
 */
describe('anomaly-issue names the state its dependency is in', () => {
  const ISSUE = 'https://github.com/o/r/issues/1'
  const OBSERVED_AT = '2026-01-01T00:00:00.000Z'

  const creates = (bump: () => void): typeof fetch =>
    (async () => {
      bump()
      return { ok: true, status: 201, json: async () => ({ html_url: ISSUE }) }
    }) as unknown as typeof fetch

  /** Writes the ledger under an existing home, without creating a temp dir of its own. */
  async function seedLedger(home: string, filed: Record<string, string>): Promise<string> {
    const path = join(home, 'state', 'anomaly-issue.filed.json')
    await mkdir(join(home, 'state'), { recursive: true })
    await writeFile(path, JSON.stringify({ filed }))
    return path
  }

  test('a producer that has never run reads differently from one that ran and produced nothing', async () => {
    await withHomeAndToken(async () => {
      const args = { repo: 'o/r' }
      const signal = new AbortController().signal
      const never = await handler({} as PluginManifest, args, signal, contextWith(null, null))
      const ranAndProducedNone = await handler({} as PluginManifest, args, signal, contextWith(null, 'success'))

      expect(never.status).toBe('success')
      expect(ranAndProducedNone.status).toBe('success')
      // The distinction is the whole reason the second fact is read. Two
      // states, two sentences — and the second one names the status it read,
      // because "ran and produced nothing" is a different thing to chase than
      // "has not started".
      expect(never.summary).not.toBe(ranAndProducedNone.summary)
      expect(never.summary).toContain('has not run yet')
      expect(ranAndProducedNone.summary).not.toContain('has not run yet')
      expect(ranAndProducedNone.summary).toContain('success')
      // Both keep the arm's existing properties: named dependency, no Output.
      for (const result of [never, ranAndProducedNone]) {
        expect(result.summary).toContain('anomaly-watch')
        expect(result.artifacts_produced ?? []).toHaveLength(0)
        expect(result.status).not.toBe('skipped')
      }
    })
  })

  test('a producer parked at a gate is reported as gated, not as never having run', async () => {
    await withHomeAndToken(async () => {
      const result = await handler(
        {} as PluginManifest,
        { repo: 'o/r' },
        new AbortController().signal,
        contextWith(null, 'gated'),
      )
      // A supervised producer waiting for an approval is a real state to
      // report, not an error and not silence.
      expect(result.status).toBe('success')
      expect(result.summary).toContain('gated')
      expect(result.summary).not.toContain('has not run yet')
    })
  })

  test('a record preserved across a failed producer run still files, re-files nothing, and is reported as stale', async () => {
    await withHomeAndToken(async home => {
      const path = await seedLedger(home, { errors: ISSUE })
      const before = await readFile(path, 'utf-8')
      let calls = 0

      const result = await withFetch(creates(() => { calls++ }), () =>
        handler(
          {} as PluginManifest,
          { repo: 'o/r' },
          new AbortController().signal,
          contextWith(outputOf({ observed_at: OBSERVED_AT, anomalies: [errors] }), 'failed'),
        ))

      // Filing is NOT gated on the run status: the record is real work the
      // producer really produced, and the ledger dedupes by anomaly name, so
      // a carried-forward record re-files nothing. Both halves are asserted —
      // the sentence names the staleness, and the ledger proves the arm is
      // safe by the property that already existed.
      expect(result.status).toBe('success')
      expect(calls).toBe(0)
      expect(await readFile(path, 'utf-8')).toBe(before)
      expect(result.summary).toContain('whose latest run failed')
      expect(result.summary).toContain('anomaly-watch')
    })
  })

  test('a healthy producer is reported with no staleness marker at all', async () => {
    await withHomeAndToken(async home => {
      await seedLedger(home, { errors: ISSUE })
      let calls = 0
      const result = await withFetch(creates(() => { calls++ }), () =>
        handler(
          {} as PluginManifest,
          { repo: 'o/r' },
          new AbortController().signal,
          contextWith(outputOf({ observed_at: OBSERVED_AT, anomalies: [errors] }), 'success'),
        ))

      expect(calls).toBe(0)
      // The negative control for the marker: the healthy path's wording is
      // unchanged, so the marker cannot be a decoration every run carries.
      expect(result.summary).toBe('no new anomalies (1 already filed)')
    })
  })
})
