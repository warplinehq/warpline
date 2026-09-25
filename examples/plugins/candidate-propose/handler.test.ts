import { describe, test, expect } from 'bun:test'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CapabilityContext } from 'warpline/unstable-capabilities'
import { OutputRecordSchema } from 'warpline/schemas/skill-result'
import { handler, MAX_PROPOSED, propose, type Candidate } from './handler.js'
import { manifest } from './manifest.js'

/** The handler declares no dependency, so the fourth parameter is never read. */
const CONTEXT = {} as CapabilityContext

/**
 * A throwaway home. `warpline/lib/paths` exports only `warplineHome`, which
 * resolves `WARPLINE_HOME` per call, so re-rooting the env var is the seam.
 */
async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'candidate-propose-'))
  const real = process.env.WARPLINE_HOME
  process.env.WARPLINE_HOME = home
  try {
    return await fn(home)
  } finally {
    if (real === undefined) delete process.env.WARPLINE_HOME
    else process.env.WARPLINE_HOME = real
    await rm(home, { recursive: true, force: true })
  }
}

/**
 * The whole home as `path|contents`, sorted. A full walk with no exclusion
 * list: naming a path as "expected to change" would stop this proving that
 * nothing changed.
 */
async function snapshot(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(`${rel}/`, ...(await snapshot(join(dir, entry.name), rel)))
    else out.push(`${rel}|${(await readFile(join(dir, entry.name))).toString('base64')}`)
  }
  return out.sort()
}

/** `n` candidates `cand-01`… scored 1…n. */
function pool(n: number): Candidate[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `cand-${String(i + 1).padStart(2, '0')}`,
    title: `Example candidate ${i + 1}`,
    score: i + 1,
  }))
}

async function seed(home: string, content: unknown, rel = 'state/candidates.json'): Promise<void> {
  await mkdir(join(home, rel, '..'), { recursive: true })
  await writeFile(join(home, rel), typeof content === 'string' ? content : JSON.stringify(content))
}

function invoke(args: Record<string, unknown> = {}) {
  return handler(manifest, args, new AbortController().signal, CONTEXT)
}

/** The one Output, schema-checked, and its body parsed. */
function proposalOf(result: Awaited<ReturnType<typeof invoke>>): { body: string; candidates: Candidate[] } {
  expect(result.artifacts_produced).toHaveLength(1)
  const record = OutputRecordSchema.parse(result.artifacts_produced?.[0])
  expect(record.type).toBe('proposal')
  expect(typeof record.body).toBe('string')
  return { body: record.body!, candidates: (JSON.parse(record.body!) as { candidates: Candidate[] }).candidates }
}

describe('candidate-propose caps the proposal at three', () => {
  test('a pool of ten gives the three highest scores, highest first', async () => {
    await withHome(async (home) => {
      await seed(home, { candidates: pool(10) })
      const result = await invoke()
      expect(result.status).toBe('success')
      expect(proposalOf(result).candidates.map((c) => c.id)).toEqual(['cand-10', 'cand-09', 'cand-08'])
      expect(result.summary).toBe('candidate-propose: proposed 3 of 10 candidates')
    })
  })

  test('a pool of two gives two and an empty pool gives none', async () => {
    await withHome(async (home) => {
      await seed(home, { candidates: pool(2) })
      expect(proposalOf(await invoke()).candidates.map((c) => c.id)).toEqual(['cand-02', 'cand-01'])
      await seed(home, { candidates: [] })
      const empty = await invoke()
      expect(empty.status).toBe('success')
      expect(proposalOf(empty).body).toBe('{"candidates":[]}')
    })
  })

  test('ties on score go to the lower id', () => {
    const tied = [
      { id: 'd', title: 'D', score: 5 },
      { id: 'c', title: 'C', score: 9 },
      { id: 'b', title: 'B', score: 9 },
      { id: 'a', title: 'A', score: 1 },
    ]
    expect(propose(tied).map((c) => c.id)).toEqual(['b', 'c', 'd'])
  })

  test('a pool of fifty still gives three, and the cap is the constant three', async () => {
    expect(MAX_PROPOSED).toBe(3)
    await withHome(async (home) => {
      await seed(home, { candidates: pool(50) })
      expect(proposalOf(await invoke()).candidates).toHaveLength(3)
    })
  })
})

describe('candidate-propose replaces, never accumulates, and never writes', () => {
  test('two runs over two pools each hold only their own proposal, and the home is untouched', async () => {
    await withHome(async (home) => {
      await seed(home, { candidates: pool(10) })
      const before1 = await snapshot(home)
      const first = await invoke()
      expect(await snapshot(home)).toEqual(before1)

      await seed(home, { candidates: [{ id: 'other-1', title: 'Other', score: 1 }] })
      const before2 = await snapshot(home)
      const second = await invoke()
      expect(await snapshot(home)).toEqual(before2)

      expect(proposalOf(first).candidates.map((c) => c.id)).toEqual(['cand-10', 'cand-09', 'cand-08'])
      expect(proposalOf(second).candidates.map((c) => c.id)).toEqual(['other-1'])
    })
  })

  test('a missing pool file emits an empty proposal, so the last one does not stay approvable', async () => {
    await withHome(async () => {
      const result = await invoke()
      expect(result.status).toBe('success')
      expect(proposalOf(result).body).toBe('{"candidates":[]}')
      expect(result.summary).toContain('proposing nothing, which replaces the last proposal')
    })
  })

  test('the same pool in two file orders gives byte-identical bodies', async () => {
    await withHome(async (home) => {
      const shuffled = pool(10).map((c) => ({ score: c.score, title: c.title, id: c.id, note: 'dropped' }))
      await seed(home, { candidates: pool(10) })
      const a = proposalOf(await invoke()).body
      await seed(home, { candidates: [...shuffled].reverse() })
      const b = proposalOf(await invoke()).body
      expect(b).toBe(a)
      expect(a).toBe(JSON.stringify({ candidates: pool(10).reverse().slice(0, 3) }))
    })
  })

  test('the handler source names no writer and nothing promoted', async () => {
    const source = await readFile(join(import.meta.dir, 'handler.ts'), 'utf8')
    expect(source).not.toContain('atomicWriteJson')
    expect(source).not.toContain('atomicWriteText')
    expect(source).not.toContain('promoted')
  })
})

describe('candidate-propose refuses what it cannot read', () => {
  test('an entry without a string id and a non-numeric score are each refused by position', async () => {
    await withHome(async (home) => {
      await seed(home, { candidates: [pool(1)[0], { title: 'No id', score: 2 }] })
      const noId = await invoke()
      expect(noId.status).toBe('failed')
      expect(noId.errors?.[0]?.code).toBe('parse_error')
      expect(noId.summary).toContain('candidate 2 in the pool')

      await seed(home, { candidates: [{ id: 'x', title: 'X', score: '7' }] })
      const badScore = await invoke()
      expect(badScore.status).toBe('failed')
      expect(badScore.errors?.[0]?.code).toBe('parse_error')
      expect(badScore.summary).toContain('candidate 1 in the pool')
      expect(badScore.artifacts_produced ?? []).toEqual([])
    })
  })

  test('a path out of the home and a file that is not JSON are each refused by key', async () => {
    await withHome(async (home) => {
      const outside = await invoke({ pool_path: '../p.json' })
      expect(outside.status).toBe('failed')
      expect(outside.errors?.[0]?.code).toBe('parse_error')
      expect(outside.summary).toContain("input 'pool_path'")

      await seed(home, 'not json {')
      const garbled = await invoke()
      expect(garbled.status).toBe('failed')
      expect(garbled.errors?.[0]?.code).toBe('parse_error')
      expect(garbled.summary).toContain("input 'pool_path'")
    })
  })
})

describe('candidate-propose manifest', () => {
  test('one input, no side effects, weekly with a one-week TTL', () => {
    expect(Object.keys(manifest.inputs)).toEqual(['pool_path'])
    expect(manifest.side_effects).toEqual([])
    expect(manifest.schedule).toBe('weekly')
    expect(manifest.ttl_hours).toBe(168)
    expect(manifest.llm_handoff).toBe(false)
  })
})

/**
 * The pool path arrives from `<home>/config/candidate-propose.json` and every
 * summary lands in the run log, so no arm names the value it was handed.
 */
describe('candidate-propose config value disclosure', () => {
  const SENTINEL = 'do-not-echo-5c2a91'

  test('a configured pool path never reaches the result, whether refused, garbled, absent or read', async () => {
    await withHome(async (home) => {
      const rel = `state/${SENTINEL}.json`
      const results = [await invoke({ pool_path: `../${SENTINEL}.json` }), await invoke({ pool_path: rel })]
      await seed(home, 'not json {', rel)
      results.push(await invoke({ pool_path: rel }))
      await seed(home, { candidates: pool(4) }, rel)
      results.push(await invoke({ pool_path: rel }))

      expect(results.map((r) => r.status)).toEqual(['failed', 'success', 'failed', 'success'])
      for (const result of results) expect(JSON.stringify(result)).not.toContain(SENTINEL)
    })
  })
})
