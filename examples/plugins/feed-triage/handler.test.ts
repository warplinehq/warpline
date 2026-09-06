import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { tmpdir } from 'node:os'
import type { CapabilityContext } from 'warpline/unstable-capabilities'
import { SkillResultSchema } from 'warpline/schemas/skill-result'
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

/** The handler is four-parameter; a test hands it a context it never reads. */
const CONTEXT = {} as CapabilityContext

function invoke(args: Record<string, unknown>) {
  return handler(manifest, args, new AbortController().signal, CONTEXT)
}

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
    await withHome(async () => {
      const root = await tempRoot()
      const path = join(root, 'feed-entries.json')
      await writeFile(path, JSON.stringify({ new_entries: [entryA, entryB] }))

      const result = await invoke({ entries_path: path })

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
      const root = await tempRoot()
      const path = join(root, 'feed-entries.json')
      await writeFile(path, JSON.stringify({ new_entries: [entryA, entryB] }))

      const result = await invoke({ entries_path: path })

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

  test('zero entries do not hand off', async () => {
    await withHome(async () => {
      const root = await tempRoot()
      const path = join(root, 'feed-entries.json')
      await writeFile(path, JSON.stringify({ new_entries: [] }))

      const result = await invoke({ entries_path: path })

      // `deriveRunStatus` returns 'success' for any success result before it
      // ever tests the prefix, so this is sufficient to prove the run is not
      // delegated.
      expect(result.status).toBe('success')
      expect(result.summary.startsWith('[needs-llm]')).toBe(false)
      expect(result.schema_version).toBeUndefined()
    })
  })

  test('a missing input file is quiet, not red, and keeps its prefix', async () => {
    await withHome(async () => {
      const root = await tempRoot()
      const path = join(root, 'never-created', 'feed-entries.json')

      const result = await invoke({ entries_path: path })

      // NOT a bare 'skipped': a prefix-less skipped maps to `failed`, and
      // `warpline run` persists the artifact — "no data yet" must not paint a
      // red run. The summary keeps the plugin-name prefix its other quiet arm
      // carries.
      expect(result.status).toBe('success')
      expect(result.summary.startsWith('[needs-llm]')).toBe(false)
      expect(result.summary.startsWith('feed-triage:')).toBe(true)
    })
  })

  test('an entries file that exists but is not JSON is a failure, not a quiet first run', async () => {
    await withHome(async () => {
      const root = await tempRoot()
      const path = join(root, 'feed-entries.json')
      await writeFile(path, '{"new_entries": [')

      const result = await invoke({ entries_path: path })

      expect(result.status).toBe('failed')
      expect(result.errors?.[0]?.code).toBe('parse_error')
    })
  })

  test('declares no side effects', () => {
    expect(manifest.side_effects).toEqual([])
  })
})

// The config channel reaches this handler through `entries_path`, a declared
// manifest input an operator sets in `<home>/config/feed-triage.json`. Every
// arm below drives a sentinel-bearing path through a different exit and asks
// where it ended up. The sentinel lives in the DIRECTORY name, so it rides the
// resolved path into whatever an arm interpolates.
//
// No arm may echo it — the handoff included. The handoff summary names a path
// after `Context: `, but that path is the payload file this plugin writes
// under the home, never the path it was configured to read from.
describe('feed-triage handler input guard', () => {
  const sentinel = 'do-not-echo-6f8b40'

  async function sentinelRoot(): Promise<string> {
    return tempRoot(`${sentinel}-`)
  }

  test('a missing feed state names the input, not the path it was configured with', async () => {
    await withHome(async () => {
      const path = join(tmpdir(), sentinel, 'feed-entries.json')

      const result = await invoke({ entries_path: path })

      expect(result.status).toBe('success')
      // The whole result, not just the summary: errors[] is a field too, and
      // so is anything a later edit adds beside them.
      expect(JSON.stringify(result)).not.toContain(sentinel)
      expect(result.summary).toContain('no feed state')
    })
  })

  test('zero new entries names the input, not the path it read', async () => {
    await withHome(async () => {
      const root = await sentinelRoot()
      const path = join(root, 'feed-entries.json')
      await writeFile(path, JSON.stringify({ new_entries: [] }))

      const result = await invoke({ entries_path: path })

      expect(result.status).toBe('success')
      expect(JSON.stringify(result)).not.toContain(sentinel)
      expect(result.summary).toContain('no new entries')
    })
  })

  test('an unreadable feed state names the input key, not the path or the OS error', async () => {
    await withHome(async () => {
      const root = await sentinelRoot()
      const path = join(root, 'feed-entries.json')
      await writeFile(path, '{"new_entries": [')

      const result = await invoke({ entries_path: path })

      expect(result.status).toBe('failed')
      expect(JSON.stringify(result)).not.toContain(sentinel)
      expect(result.errors?.[0]?.message).toContain('entries_path')
    })
  })

  test('the handoff carries the payload it wrote under the home, never the path it read from', async () => {
    await withHome(async home => {
      const root = await sentinelRoot()
      const path = join(root, 'feed-entries.json')
      await writeFile(path, JSON.stringify({ new_entries: [entryA, entryB] }))

      const result = await invoke({ entries_path: path })

      expect(result.status).toBe('skipped')
      expect(result.errors ?? []).toEqual([])
      expect(JSON.stringify(result)).not.toContain(sentinel)
      // The tail is still a payload the scanner can open, inside the home.
      const tail = result.summary.split('Context: ')[1] ?? ''
      expect(tail.startsWith(home)).toBe(true)
      expect(JSON.parse(await readFile(tail, 'utf-8'))).toEqual({ new_entries: [entryA, entryB] })
    })
  })
})
