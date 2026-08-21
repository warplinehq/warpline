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
