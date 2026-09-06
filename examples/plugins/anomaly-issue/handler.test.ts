import { describe, test, expect } from 'bun:test'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginManifest } from 'warpline/schemas/plugin-manifest'
import { SkillResultSchema } from 'warpline/schemas/skill-result'
import { pending, issueFor, fileIssues, handler, type Anomaly } from './handler.js'

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
  })

  test('a response without html_url still records the issue as created', async () => {
    const { impl } = fakeFetch([{ ok: true, status: 201 }])
    const out = await fileIssues('o/r', [errors], 'tok-123', impl, signal)
    expect(out.created).toHaveLength(1)
    expect(out.error?.code).toBe('parse_error')
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

    const anomaliesPath = join(home, 'anomalies.json')
    await mkdir(home, { recursive: true })
    await writeFile(anomaliesPath, JSON.stringify({ anomalies: [errors, signups] }))

    let n = 0
    globalThis.fetch = (async () => {
      if (n++ === 0) return { ok: true, status: 201, json: async () => ({ html_url: 'https://github.com/o/r/issues/1' }) }
      throw new Error('ECONNRESET')
    }) as unknown as typeof fetch

    try {
      const result = await handler(
        {} as PluginManifest,
        { repo: 'o/r', anomalies_path: anomaliesPath },
        new AbortController().signal,
      )
      expect(result.status).toBe('partial')
      // The partial arm is built on the result builder too: no builder emits
      // `partial`, so the status is set over `skillOk`'s result, and the
      // handler still writes no schema_version of its own.
      expect(result.schema_version).toBeUndefined()
      expect(result.errors?.[0]?.code).toBe('dependency_unavailable')
      const ledger = JSON.parse(await readFile(join(home, 'state', 'anomaly-issue.filed.json'), 'utf-8'))
      expect(ledger.filed).toEqual({ errors: 'https://github.com/o/r/issues/1' })
    } finally {
      globalThis.fetch = realFetch
      if (realToken === undefined) delete process.env.GITHUB_TOKEN
      else process.env.GITHUB_TOKEN = realToken
      if (realHome === undefined) delete process.env.WARPLINE_HOME
      else process.env.WARPLINE_HOME = realHome
    }
  })

  test('a corrupt anomalies file fails rather than reporting "no anomalies file"', async () => {
    const home = await mkdtemp(join(tmpdir(), 'anomaly-issue-'))
    const realToken = process.env.GITHUB_TOKEN
    const realHome = process.env.WARPLINE_HOME
    process.env.WARPLINE_HOME = home
    process.env.GITHUB_TOKEN = 'tok-123'

    const anomaliesPath = join(home, 'anomalies.json')
    await writeFile(anomaliesPath, '{"anomalies": [')

    try {
      const result = await handler(
        {} as PluginManifest,
        { repo: 'o/r', anomalies_path: anomaliesPath },
        new AbortController().signal,
      )
      expect(result.status).toBe('failed')
      expect(result.errors[0]?.code).toBe('parse_error')
    } finally {
      if (realToken === undefined) delete process.env.GITHUB_TOKEN
      else process.env.GITHUB_TOKEN = realToken
      if (realHome === undefined) delete process.env.WARPLINE_HOME
      else process.env.WARPLINE_HOME = realHome
    }
  })

  test('refuses to file when the ledger exists but cannot be parsed', async () => {
    const home = await mkdtemp(join(tmpdir(), 'anomaly-issue-'))
    const realFetch = globalThis.fetch
    const realToken = process.env.GITHUB_TOKEN
    const realHome = process.env.WARPLINE_HOME
    process.env.WARPLINE_HOME = home
    process.env.GITHUB_TOKEN = 'tok-123'

    const anomaliesPath = join(home, 'anomalies.json')
    await writeFile(anomaliesPath, JSON.stringify({ anomalies: [errors] }))
    await mkdir(join(home, 'state'), { recursive: true })
    await writeFile(join(home, 'state', 'anomaly-issue.filed.json'), '{"filed": {truncat')

    globalThis.fetch = (async () => {
      throw new Error('fetch must not be called')
    }) as unknown as typeof fetch

    try {
      const result = await handler(
        {} as PluginManifest,
        { repo: 'o/r', anomalies_path: anomaliesPath },
        new AbortController().signal,
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
    }
  })
})

describe('anomaly-issue handler result construction', () => {
  test('an invalid repo is a failure built by the result builder, with no schema_version written by the handler', async () => {
    const result = await handler({} as PluginManifest, { repo: 'not-a-repo' }, new AbortController().signal)
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
      const result = await handler({} as PluginManifest, { repo: 'o/r' }, new AbortController().signal)
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

  test('a missing anomalies file is a success built by the result builder, never a bare skipped', async () => {
    await withHomeAndToken(async home => {
      const result = await handler(
        {} as PluginManifest,
        { repo: 'o/r', anomalies_path: join(home, 'absent.json') },
        new AbortController().signal,
      )
      expect(result.status).toBe('success')
      expect(result.summary).toContain('nothing to file')
      expect(result.schema_version).toBeUndefined()
    })
  })

  test('filing every anomaly is a success with the undo instruction and no schema_version', async () => {
    await withHomeAndToken(async home => {
      const anomaliesPath = join(home, 'anomalies.json')
      await writeFile(anomaliesPath, JSON.stringify({ anomalies: [errors] }))
      const impl = (async () => ({
        ok: true,
        status: 201,
        json: async () => ({ html_url: 'https://github.com/o/r/issues/1' }),
      })) as unknown as typeof fetch

      const result = await withFetch(impl, () =>
        handler({} as PluginManifest, { repo: 'o/r', anomalies_path: anomaliesPath }, new AbortController().signal))

      expect(result.status).toBe('success')
      expect(result.reversible).toBe(false)
      expect(result.undo_instruction).toContain('https://github.com/o/r/issues/1')
      expect(result.schema_version).toBeUndefined()
      expect(SkillResultSchema.parse(result).status).toBe('success')
    })
  })

  test('a second run in the same home reads the ledger and files nothing', async () => {
    await withHomeAndToken(async home => {
      const anomaliesPath = join(home, 'anomalies.json')
      await writeFile(anomaliesPath, JSON.stringify({ anomalies: [errors] }))
      let calls = 0
      const impl = (async () => {
        calls++
        return { ok: true, status: 201, json: async () => ({ html_url: 'https://github.com/o/r/issues/1' }) }
      }) as unknown as typeof fetch
      const args = { repo: 'o/r', anomalies_path: anomaliesPath }

      const first = await withFetch(impl, () => handler({} as PluginManifest, args, new AbortController().signal))
      const second = await withFetch(impl, () => handler({} as PluginManifest, args, new AbortController().signal))

      expect(first.status).toBe('success')
      expect(calls).toBe(1)
      expect(second.status).toBe('success')
      expect(second.summary).toBe('no new anomalies (1 already filed)')
      expect(second.schema_version).toBeUndefined()
    })
  })

  test('a __proto__ anomaly name lands in the ledger as an own property, not on the prototype', async () => {
    await withHomeAndToken(async home => {
      const anomaliesPath = join(home, 'anomalies.json')
      const proto: Anomaly = { name: '__proto__', latest: 1, threshold: 0, direction: 'above' }
      await writeFile(anomaliesPath, JSON.stringify({ anomalies: [proto] }))
      const impl = (async () => ({
        ok: true,
        status: 201,
        json: async () => ({ html_url: 'https://github.com/o/r/issues/9' }),
      })) as unknown as typeof fetch
      const args = { repo: 'o/r', anomalies_path: anomaliesPath }

      const first = await withFetch(impl, () => handler({} as PluginManifest, args, new AbortController().signal))
      expect(first.status).toBe('success')

      // Serialised as an own key — a plain object would have set the prototype
      // and written `{}`, re-filing the anomaly on every run.
      const raw = await readFile(join(home, 'state', 'anomaly-issue.filed.json'), 'utf-8')
      expect(raw).toContain('"__proto__": "https://github.com/o/r/issues/9"')
      expect(Object.hasOwn(Object.prototype, 'filed')).toBe(false)
      expect(({} as Record<string, unknown>).__proto__).toBe(Object.prototype)

      const second = await withFetch(impl, () => handler({} as PluginManifest, args, new AbortController().signal))
      expect(second.summary).toBe('no new anomalies (1 already filed)')
    })
  })
})

/**
 * `repo` and `anomalies_path` both arrive from `<home>/config/anomaly-issue.json`,
 * and every `SkillResult` field this handler returns is written to a run log —
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
    )

    expect(result.status).toBe('failed')
    expect(result.errors[0]?.code).toBe('parse_error')
    // The whole result, not one field: summary and errors[].message both reach
    // the run log, and so does whatever a later edit adds beside them.
    expect(JSON.stringify(result)).not.toContain(SENTINEL)
    expect(result.errors[0]?.message).toContain('repo')
    expect(result.errors[0]?.message).toContain('owner/name')
  })

  test('a missing anomalies file reports nothing to file without naming the path', async () => {
    await withToken(async () => {
      const result = await handler(
        {} as PluginManifest,
        { repo: sentinelRepo, anomalies_path: join(tmpdir(), SENTINEL, 'anomalies.json') },
        new AbortController().signal,
      )

      expect(result.status).toBe('success')
      expect(JSON.stringify(result)).not.toContain(SENTINEL)
    })
  })

  test('an unreadable anomalies file names the input key, not the path or the OS error', async () => {
    await withToken(async () => {
      // A directory reaches the non-ENOENT arm; a Node fs error embeds the full
      // path, so forwarding its message re-opens the leak the key naming closes.
      const dir = await mkdtemp(join(tmpdir(), `${SENTINEL}-`))
      const result = await handler(
        {} as PluginManifest,
        { repo: sentinelRepo, anomalies_path: dir },
        new AbortController().signal,
      )

      expect(result.status).toBe('failed')
      expect(result.errors[0]?.code).toBe('parse_error')
      expect(JSON.stringify(result)).not.toContain(SENTINEL)
      expect(result.errors[0]?.message).toContain('anomalies_path')
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
    const anomaliesPath = join(dir, 'anomalies.json')
    await writeFile(anomaliesPath, JSON.stringify({ anomalies: [errors] }))
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
        { repo: sentinelRepo, anomalies_path: anomaliesPath },
        new AbortController().signal,
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
    }
  })
})
