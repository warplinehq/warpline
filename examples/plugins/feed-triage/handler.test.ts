import { describe, test, expect, afterEach } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { tmpdir } from 'node:os'
import type { CapabilityContext, DependenciesHandle } from 'warpline/unstable-capabilities'
import { SkillResultSchema, type OutputRecord } from 'warpline/schemas/skill-result'
import { newEntries, handler } from './handler.js'
import { manifest } from './manifest.js'

// CLAUDE.md rule 2: every fixture lives under tmpdir() and is removed after.
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(r => rm(r, { recursive: true, force: true })))
})

async function tempRoot(prefix = 'warpline-feed-triage-'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

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
 * and the runtime's DELIVERY of them is proven under `src/`, by the
 * `feed-triage` act in `shape-coverage.test.ts` which runs the real producer
 * and mints this context through the runtime itself.
 *
 * Both members throw for any name but `feed-monitor`, mirroring the runtime's
 * shared refusal, so a case can never pass against a coupling the manifest
 * does not declare.
 *
 * The default pairs the two facts coherently: a fixture handing over a record
 * without saying how the last run ended models a producer that succeeded, and
 * one handing over nothing models a producer that has never run. Every case
 * that means something else says so.
 */
function contextWith(record: OutputRecord | null, run: RunStatus = record === null ? null : 'success'): CapabilityContext {
  const declared = (name: string): void => {
    if (name !== 'feed-monitor') {
      throw new Error(`feed-triage does not declare '${name}' in manifest.dependencies`)
    }
  }
  return {
    caller: { plugin: 'feed-triage' },
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

/**
 * A `path`-form Output over a file written at `rel` inside the test's own home
 * — the form `feed-monitor` publishes, because an entry list grows with the
 * feed and the body cap is 16 KiB.
 */
async function recordAt(home: string, rel: string, payload: unknown): Promise<OutputRecord> {
  const path = join(home, rel)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, typeof payload === 'string' ? payload : JSON.stringify(payload))
  return { type: 'feed-entries', format: 'json', path }
}

const ENTRIES_REL = join('state', 'feed-monitor.entries.json')

/**
 * `warpline/lib/paths` exports only `warplineHome`, which resolves
 * `WARPLINE_HOME` per call — the same seam a plugin author has. The handoff
 * arm writes its payload under the home, so every call gets its own.
 */
async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await tempRoot('warpline-feed-triage-home-')
  const realHome = process.env.WARPLINE_HOME
  process.env.WARPLINE_HOME = home
  try {
    return await fn(home)
  } finally {
    if (realHome === undefined) delete process.env.WARPLINE_HOME
    else process.env.WARPLINE_HOME = realHome
  }
}

function invoke(context: CapabilityContext) {
  return handler(manifest, {}, new AbortController().signal, context)
}

const entryA = { title: 'A post', link: 'https://example.com/a', published: '2026-08-20T09:00:00Z' }
const entryB = { title: 'B post', link: 'https://example.com/b', published: null }

describe('feed-triage newEntries', () => {
  test('extracts the new_entries array', () => {
    expect(newEntries({ new_entries: [entryA, entryB] })).toEqual([entryA, entryB])
  })

  test('degrades to [] for a missing, non-array, or null payload', () => {
    expect(newEntries({})).toEqual([])
    expect(newEntries({ new_entries: 'nope' })).toEqual([])
    expect(newEntries(null)).toEqual([])
  })
})

describe('feed-triage handler', () => {
  test('at least one entry hands off through the builder: the prefix, one Context marker, and the structured arm', async () => {
    await withHome(async home => {
      const record = await recordAt(home, ENTRIES_REL, { fetched_at: entryA.published, new_entries: [entryA, entryB] })

      const result = await invoke(contextWith(record))

      expect(result.status).toBe('skipped')
      expect(result.summary.startsWith('[needs-llm]')).toBe(true)
      expect(result.summary.split('Context: ')).toHaveLength(2)
      expect(result.summary).toContain('2')
      // The structured arm is what proves the builder wrote this, not a
      // literal: a hand-assembled summary carries no `needs_llm` field.
      expect(result.needs_llm).toBeDefined()
      expect(result.needs_llm?.task).toBe('Triage 2 new feed entries')
      expect(/[.!?]$/.test(result.needs_llm?.task ?? '.')).toBe(false)
      // The builder leaves schema_version to the schema's own default.
      expect(result.schema_version).toBeUndefined()
    })
  })

  test('the payload is written under the home and the handoff names it relative to the home', async () => {
    await withHome(async home => {
      const record = await recordAt(home, ENTRIES_REL, { new_entries: [entryA, entryB] })

      const result = await invoke(contextWith(record))

      const contextPath = result.needs_llm?.context_path ?? ''
      expect(contextPath.length).toBeGreaterThan(0)
      expect(isAbsolute(contextPath)).toBe(false)
      expect(contextPath.split(/[\\/]/)).not.toContain('..')
      // The parse boundary refuses any other shape, so this is the real check.
      expect(() => SkillResultSchema.parse(result)).not.toThrow()

      // The summary carries the path RESOLVED, because that is the only
      // channel the shipped scanner reads; the file it names is the payload.
      const resolved = join(home, contextPath)
      expect(result.summary.split('Context: ')[1]).toBe(resolved)
      expect(JSON.parse(await readFile(resolved, 'utf-8'))).toEqual({ new_entries: [entryA, entryB] })
    })
  })

  test('an empty entry list does not hand off', async () => {
    await withHome(async home => {
      // The producer writes on its quiet day too, so an empty list is an
      // observation and not the absence of one. This is not the same state as
      // no record at all, and it does not take the same arm.
      const record = await recordAt(home, ENTRIES_REL, { new_entries: [] })

      const result = await invoke(contextWith(record))

      // `deriveRunStatus` returns 'success' for any success result before it
      // ever tests the prefix, so this is sufficient to prove the run is not
      // delegated.
      expect(result.status).toBe('success')
      expect(result.summary.startsWith('[needs-llm]')).toBe(false)
      expect(result.summary).toContain('no new entries from feed-monitor')
      expect(result.schema_version).toBeUndefined()
    })
  })

  test('no Output and no recorded producer run is quiet, not red, and keeps its prefix', async () => {
    await withHome(async () => {
      const result = await invoke(contextWith(null, null))

      // NOT a bare 'skipped': a prefix-less skipped maps to `failed`, and
      // `warpline run` persists the artifact — "no data yet" must not paint a
      // red run. Nor a dependency failure: the runtime carries that gate, and
      // a host supplying no dependency state at all reaches here too.
      expect(result.status).toBe('success')
      expect(result.summary.startsWith('[needs-llm]')).toBe(false)
      expect(result.summary.startsWith('feed-triage:')).toBe(true)
      expect(result.summary).toContain('no data from feed-monitor yet')
    })
  })

  test('no Output from a producer that HAS run says so, rather than repeating the first-run sentence', async () => {
    await withHome(async () => {
      const result = await invoke(contextWith(null, 'success'))

      expect(result.status).toBe('success')
      expect(result.summary).toContain('feed-monitor has run (last run: success)')
      expect(result.summary).toContain('has never produced an Output')
      // The two never-produced states are distinguishable, which is the whole
      // reason both members are read: one waits for a schedule, the other
      // wants somebody to look at a producer that runs and returns nothing.
      const firstRun = await invoke(contextWith(null, null))
      expect(result.summary).not.toBe(firstRun.summary)
    })
  })

  test('a record whose file is unreadable or not JSON degrades to nothing to triage, never a throw', async () => {
    await withHome(async home => {
      // The payload is a string another plugin authored over content it
      // fetched from a remote feed. A throw out of a handler is a failed run
      // with no structure, which the runtime tells you not to return.
      const record = await recordAt(home, ENTRIES_REL, '{"new_entries": [')

      const result = await invoke(contextWith(record))

      expect(result.status).toBe('success')
      expect(result.summary.startsWith('[needs-llm]')).toBe(false)
    })
  })

  test('a name the manifest does not declare throws from both members, exactly as the real member does', () => {
    const context = contextWith(null)
    // Tied to the manifest, not to a literal repeated here: a test that passed
    // against a coupling the manifest never declared would prove nothing.
    expect(manifest.dependencies).toEqual(['feed-monitor'])
    expect(() => context.dependencies.lastOutput(context.caller, 'anomaly-watch')).toThrow()
    expect(() => context.dependencies.lastRun(context.caller, 'anomaly-watch')).toThrow()
  })

  test('declares no side effects', () => {
    expect(manifest.side_effects).toEqual([])
  })
})

// The config channel that used to reach this handler — a declared
// `entries_path` input naming a file the handler computed a default for — is
// gone with the code that read it. What arrives instead is a path on a record
// the RUNTIME delivered, written by another plugin; it is not operator
// configuration, and it still must not reach the run log.
//
// The sentinel lives in the DIRECTORY name of that path, so it rides into
// whatever an arm interpolates. No arm may echo it — the handoff included. The
// handoff summary names a path after `Context: `, but that path is the payload
// file this plugin writes under the home, never the one it read from.
describe('feed-triage handler does not echo the path it read', () => {
  const sentinel = 'do-not-echo-6f8b40'
  const sentinelRel = join('state', sentinel, 'feed-monitor.entries.json')

  test('the handoff carries the payload it wrote under the home, never the record it read from', async () => {
    await withHome(async home => {
      const record = await recordAt(home, sentinelRel, { new_entries: [entryA, entryB] })

      const result = await invoke(contextWith(record))

      expect(result.status).toBe('skipped')
      expect(result.errors ?? []).toEqual([])
      // The whole result, not just the summary: errors[] is a field too, and
      // so is anything a later edit adds beside them.
      expect(JSON.stringify(result)).not.toContain(sentinel)
      // The tail is still a payload the scanner can open, inside the home.
      const tail = result.summary.split('Context: ')[1] ?? ''
      expect(tail.startsWith(home)).toBe(true)
      expect(JSON.parse(await readFile(tail, 'utf-8'))).toEqual({ new_entries: [entryA, entryB] })
    })
  })

  test('an empty entry list names the producer, not the record it read', async () => {
    await withHome(async home => {
      const record = await recordAt(home, sentinelRel, { new_entries: [] })

      const result = await invoke(contextWith(record))

      expect(result.status).toBe('success')
      expect(JSON.stringify(result)).not.toContain(sentinel)
      expect(result.summary).toContain('no new entries')
    })
  })

  test('an unreadable record names neither the path nor the parser words', async () => {
    await withHome(async home => {
      const record = await recordAt(home, sentinelRel, '{"new_entries": [')

      const result = await invoke(contextWith(record))

      expect(result.status).toBe('success')
      expect(JSON.stringify(result)).not.toContain(sentinel)
    })
  })
})
