import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { newEntries, handler } from './handler.js'
import { manifest } from './manifest.js'

// CLAUDE.md rule 2: every fixture lives under tmpdir() and is removed after.
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(r => rm(r, { recursive: true, force: true })))
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'warpline-feed-triage-'))
  roots.push(root)
  return root
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
  test('at least one entry hands off with the [needs-llm] prefix and a Context path', async () => {
    const root = await tempRoot()
    const path = join(root, 'feed-entries.json')
    await writeFile(path, JSON.stringify({ new_entries: [entryA, entryB] }))

    const result = await handler(manifest, { entries_path: path })

    expect(result.status).toBe('skipped')
    expect(result.summary.startsWith('[needs-llm]')).toBe(true)
    expect(result.summary).toContain('2')
    // The path after `Context:` is the entire payload channel — RunArtifact
    // persists `summary` and drops `artifacts_produced`.
    expect(result.summary).toContain(path)
  })

  test('zero entries do not hand off', async () => {
    const root = await tempRoot()
    const path = join(root, 'feed-entries.json')
    await writeFile(path, JSON.stringify({ new_entries: [] }))

    const result = await handler(manifest, { entries_path: path })

    // `deriveRunStatus` returns 'success' for any success result before it ever
    // tests the prefix, so this is sufficient to prove the run is not delegated.
    expect(result.status).toBe('success')
    expect(result.summary.startsWith('[needs-llm]')).toBe(false)
  })

  test('a missing input file is quiet, not red', async () => {
    const root = await tempRoot()
    const path = join(root, 'never-created', 'feed-entries.json')

    const result = await handler(manifest, { entries_path: path })

    // NOT 'skipped': a prefix-less skipped maps to `failed`, and `warpline run`
    // persists the artifact — "no data yet" must not paint a red run.
    expect(result.status).toBe('success')
    expect(result.summary.startsWith('[needs-llm]')).toBe(false)
  })

  test('declares no side effects', () => {
    expect(manifest.side_effects).toEqual([])
  })
})

// The config channel reaches this handler through `entries_path`, a declared
// manifest input an operator sets in `<home>/config/feed-triage.json`. Every
// arm below drives a sentinel-bearing path through a different exit and asks
// where it ended up. The sentinel lives in the DIRECTORY name, so it rides the
// resolved path into whatever the arm interpolates.
//
// Two of the three arms must not echo it at all. The third — the `[needs-llm]`
// handoff — must echo it, and only after the `Context: ` marker: the handoff
// contract defines that field as a path the scanner resolves and reads, so the
// value is the payload channel rather than a leak. Splitting on the marker is
// what keeps that exception exactly one field wide.
describe('feed-triage handler input guard', () => {
  const sentinel = 'do-not-echo-6f8b40'

  async function sentinelRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), `${sentinel}-`))
    roots.push(root)
    return root
  }

  test('a missing feed state names the input, not the path it was configured with', async () => {
    const path = join(tmpdir(), sentinel, 'feed-entries.json')

    const result = await handler(manifest, { entries_path: path })

    expect(result.status).toBe('success')
    // The whole result, not just the summary: errors[] is a field too, and so
    // is anything a later edit adds beside them.
    expect(JSON.stringify(result)).not.toContain(sentinel)
    expect(result.summary).toContain('no feed state')
  })

  test('zero new entries names the input, not the path it read', async () => {
    const root = await sentinelRoot()
    const path = join(root, 'feed-entries.json')
    await writeFile(path, JSON.stringify({ new_entries: [] }))

    const result = await handler(manifest, { entries_path: path })

    expect(result.status).toBe('success')
    expect(JSON.stringify(result)).not.toContain(sentinel)
    expect(result.summary).toContain('no new entries')
  })

  test('the handoff carries the path only after Context:, never before it', async () => {
    const root = await sentinelRoot()
    const path = join(root, 'feed-entries.json')
    await writeFile(path, JSON.stringify({ new_entries: [entryA, entryB] }))

    const result = await handler(manifest, { entries_path: path })

    expect(result.status).toBe('skipped')
    expect(result.errors).toEqual([])

    const marker = 'Context: '
    const at = result.summary.indexOf(marker)
    expect(at).toBeGreaterThan(-1)
    const head = result.summary.slice(0, at)
    const tail = result.summary.slice(at + marker.length)

    // The head is the part a human reads in a board event or a run listing.
    expect(head).not.toContain(sentinel)
    expect(head.startsWith('[needs-llm]')).toBe(true)
    // The tail is the payload channel, and it must still resolve.
    expect(tail).toBe(path)
  })
})
