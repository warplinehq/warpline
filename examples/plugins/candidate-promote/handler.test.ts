import { describe, test, expect } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CapabilityContext } from 'warpline/unstable-capabilities'
import type { OutputRecord } from 'warpline/schemas/skill-result'
import { handler, type Candidate } from './handler.js'
import { manifest } from './manifest.js'

/**
 * The fourth parameter, carrying the one member this handler reads. A
 * hand-written literal, not the runtime's mint: an example may import only
 * the published subpaths. It throws for any name but `candidate-propose`,
 * as the runtime does, so the handler is never written against a `null` it
 * would not receive.
 */
function contextWith(record: OutputRecord | null): CapabilityContext {
  const declared = (name: string): void => {
    if (name !== 'candidate-propose') {
      throw new Error(`candidate-promote does not declare '${name}' in manifest.dependencies`)
    }
  }
  return {
    caller: { plugin: 'candidate-promote' },
    secrets: { resolvedNames: () => [] },
    dependencies: {
      lastOutput: (_caller, name: string) => {
        declared(name)
        return record
      },
      lastRun: (_caller, name: string) => {
        declared(name)
        return record === null ? null : 'success'
      },
    },
  } as CapabilityContext
}

/** An inline-body Output in the shape `candidate-propose` returns. */
function proposalOf(candidates: unknown): OutputRecord {
  return { type: 'proposal', format: 'json', body: JSON.stringify({ candidates }) }
}

const cand = (n: number): Candidate => ({
  id: `cand-${String(n).padStart(2, '0')}`,
  title: `Example candidate ${n}`,
  score: n,
})
const THREE = [cand(10), cand(9), cand(8)]

/** A throwaway home; `warplineHome` resolves `WARPLINE_HOME` per call. */
async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'candidate-promote-'))
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

const PROMOTED = (home: string) => join(home, 'state', 'promoted.json')

async function seedPromoted(home: string, content: unknown): Promise<string> {
  await mkdir(join(home, 'state'), { recursive: true })
  const text = typeof content === 'string' ? content : JSON.stringify(content)
  await writeFile(PROMOTED(home), text)
  return text
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false)
}

function invoke(record: OutputRecord | null, args: Record<string, unknown> = {}) {
  return handler(manifest, args, new AbortController().signal, contextWith(record))
}

describe('candidate-promote appends exactly the approved candidates, once each', () => {
  test('from no file, the three approved candidates are written in proposal order', async () => {
    await withHome(async (home) => {
      const result = await invoke(proposalOf(THREE))
      expect(result.status).toBe('success')
      expect(result.summary).toBe('candidate-promote: promoted 3 candidates (0 already promoted)')
      expect(JSON.parse(await readFile(PROMOTED(home), 'utf-8'))).toEqual({ promoted: THREE })
    })
  })

  test('candidates already promoted are skipped; existing entries keep their order and new ones follow', async () => {
    await withHome(async (home) => {
      await seedPromoted(home, { promoted: [cand(9), cand(0)] })
      const result = await invoke(proposalOf(THREE))
      expect(result.status).toBe('success')
      expect(result.summary).toBe('candidate-promote: promoted 2 candidates (1 already promoted)')
      expect(JSON.parse(await readFile(PROMOTED(home), 'utf-8'))).toEqual({
        promoted: [cand(9), cand(0), cand(10), cand(8)],
      })
    })
  })

  test('when every candidate is already promoted, the file is left byte for byte', async () => {
    await withHome(async (home) => {
      const text = await seedPromoted(home, `{ "promoted": ${JSON.stringify(THREE)} }`)
      const result = await invoke(proposalOf(THREE))
      expect(result.status).toBe('success')
      expect(result.summary).toBe('candidate-promote: nothing new to promote (3 already promoted)')
      expect(await readFile(PROMOTED(home), 'utf-8')).toBe(text)
    })
  })

  test('a candidate with id __proto__ is appended once and not again', async () => {
    await withHome(async (home) => {
      const odd = { id: '__proto__', title: 'Odd id', score: 1 }
      const first = await invoke(proposalOf([odd]))
      const second = await invoke(proposalOf([odd]))
      expect(first.summary).toBe('candidate-promote: promoted 1 candidates (0 already promoted)')
      expect(second.summary).toBe('candidate-promote: nothing new to promote (1 already promoted)')
      expect(JSON.parse(await readFile(PROMOTED(home), 'utf-8'))).toEqual({ promoted: [odd] })
    })
  })
})

describe('candidate-promote with nothing to promote writes nothing', () => {
  test('an empty proposal promotes nothing and creates no file', async () => {
    await withHome(async (home) => {
      const result = await invoke(proposalOf([]))
      expect(result.status).toBe('success')
      expect(result.summary).toBe('candidate-promote: the proposal is empty — nothing to promote')
      expect(await exists(PROMOTED(home))).toBe(false)
    })
  })

  test('no record from candidate-propose promotes nothing', async () => {
    await withHome(async (home) => {
      const result = await invoke(null)
      expect(result.status).toBe('success')
      expect(result.summary).toBe('candidate-promote: no data from candidate-propose yet — nothing to promote')
      expect(await exists(PROMOTED(home))).toBe(false)
    })
  })

  test('an erased record, with no body left, promotes nothing', async () => {
    await withHome(async (home) => {
      const result = await invoke({ type: 'proposal', format: 'json' })
      expect(result.status).toBe('success')
      expect(result.summary).toBe('candidate-promote: the approved proposal is no longer held — nothing to promote')
      expect(await exists(PROMOTED(home))).toBe(false)
    })
  })
})

describe('candidate-promote refuses what it cannot read', () => {
  test('a body that is not a proposal fails and writes nothing', async () => {
    await withHome(async (home) => {
      const result = await invoke({ type: 'proposal', format: 'json', body: '{"candidates": 1}' })
      expect(result.status).toBe('failed')
      expect(result.errors?.[0]?.code).toBe('parse_error')
      expect(await exists(PROMOTED(home))).toBe(false)
    })
  })

  test('a directory at promoted_path is refused by key', async () => {
    await withHome(async (home) => {
      await mkdir(PROMOTED(home), { recursive: true })
      const result = await invoke(proposalOf(THREE))
      expect(result.status).toBe('failed')
      expect(result.errors?.[0]?.code).toBe('parse_error')
      expect(result.summary).toContain("input 'promoted_path'")
    })
  })

  test('a file that is not a promoted list is refused by key and left as it was', async () => {
    await withHome(async (home) => {
      const text = await seedPromoted(home, '{ "promoted": {} }')
      const result = await invoke(proposalOf(THREE))
      expect(result.status).toBe('failed')
      expect(result.errors?.[0]?.code).toBe('parse_error')
      expect(result.summary).toContain("input 'promoted_path'")
      expect(await readFile(PROMOTED(home), 'utf-8')).toBe(text)
    })
  })

  test('a path out of the home is refused by key', async () => {
    await withHome(async () => {
      const result = await invoke(proposalOf(THREE), { promoted_path: '../x.json' })
      expect(result.status).toBe('failed')
      expect(result.errors?.[0]?.code).toBe('parse_error')
      expect(result.summary).toContain("input 'promoted_path'")
    })
  })
})

describe('candidate-promote manifest', () => {
  test('content class, one dependency, modifies_file, autonomous, one input', () => {
    expect(manifest.approval_class).toBe('content')
    expect(manifest.dependencies).toEqual(['candidate-propose'])
    expect(manifest.side_effects).toEqual(['modifies_file'])
    expect(manifest.autonomy_level).toBe('autonomous')
    expect(Object.keys(manifest.inputs)).toEqual(['promoted_path'])
    expect(manifest.llm_handoff).toBe(false)
  })

  test('the handler hands nothing off', async () => {
    const source = await readFile(join(import.meta.dir, 'handler.ts'), 'utf8')
    expect(source).not.toContain('skillHandoff(')
    expect(source).not.toContain('needs_llm')
  })
})

/**
 * The promoted path arrives from `<home>/config/candidate-promote.json` and
 * every summary lands in the run log, so no arm names the value it was handed.
 */
describe('candidate-promote config value disclosure', () => {
  const SENTINEL = 'do-not-echo-7f41b3'

  test('a configured promoted path never reaches the result, whether refused, unreadable or written', async () => {
    await withHome(async (home) => {
      const rel = `state/${SENTINEL}.json`
      const results = [await invoke(proposalOf(THREE), { promoted_path: `../${SENTINEL}.json` })]
      await mkdir(join(home, 'state'), { recursive: true })
      await writeFile(join(home, rel), 'not json {')
      results.push(await invoke(proposalOf(THREE), { promoted_path: rel }))
      await rm(join(home, rel))
      results.push(await invoke(proposalOf(THREE), { promoted_path: rel }))

      expect(results.map((r) => r.status)).toEqual(['failed', 'failed', 'success'])
      for (const result of results) expect(JSON.stringify(result)).not.toContain(SENTINEL)
      expect(JSON.parse(await readFile(join(home, rel), 'utf-8'))).toEqual({ promoted: THREE })
    })
  })
})
