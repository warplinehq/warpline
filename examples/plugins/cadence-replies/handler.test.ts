import { describe, test, expect } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CapabilityContext } from 'warpline/unstable-capabilities'
import { OutputRecordSchema } from 'warpline/schemas/skill-result'
import { handler } from './handler.js'
import { manifest } from './manifest.js'

/** The handler declares no dependency, so the fourth parameter is never read. */
const CONTEXT = {} as CapabilityContext

/**
 * A throwaway home. `warpline/lib/paths` exports only `warplineHome`, which
 * resolves `WARPLINE_HOME` per call, so re-rooting the env var is the seam.
 */
async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'cadence-replies-'))
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

async function seed(home: string, content: string, rel = 'state/replies.json'): Promise<void> {
  await mkdir(join(home, rel, '..'), { recursive: true })
  await writeFile(join(home, rel), content)
}

function invoke(args: Record<string, unknown> = {}) {
  return handler(manifest, args, new AbortController().signal, CONTEXT)
}

describe('cadence-replies reports who replied', () => {
  test('a replies file becomes the sorted list of who replied', async () => {
    await withHome(async (home) => {
      await seed(home, JSON.stringify({ replies: [] }))
      const result = await invoke()

      expect(result.status).toBe('success')
      expect(result.artifacts_produced).toHaveLength(1)
      const output = OutputRecordSchema.parse(result.artifacts_produced![0])
      expect(output.type).toBe('replies')
      expect(output.format).toBe('json')
      expect(output.body).toBe('{"replied":[]}')
    })
  })
})

describe('cadence-replies reads the declared file and nothing else', () => {
  test('repeated and unsorted contact ids come out sorted and unique', async () => {
    await withHome(async (home) => {
      await seed(home, JSON.stringify({ replies: [{ contact_id: 'c-3' }, { contact_id: 'c-1' }, { contact_id: 'c-3' }] }))
      const result = await invoke()
      expect(result.status).toBe('success')
      expect(OutputRecordSchema.parse(result.artifacts_produced![0]).body).toBe('{"replied":["c-1","c-3"]}')
      expect(result.summary).toBe('cadence-replies: 2 contacts replied')
    })
  })

  test('a missing file reports nothing, which is not the same as nobody replying', async () => {
    await withHome(async () => {
      const result = await invoke()
      expect(result.status).toBe('success')
      expect(result.summary.startsWith(`${manifest.name}:`)).toBe(true)
      expect(result.artifacts_produced ?? []).toHaveLength(0)
    })
  })

  test('a file that is not JSON is refused by its key', async () => {
    await withHome(async (home) => {
      await seed(home, '{ not json')
      const result = await invoke()
      expect(result.status).toBe('failed')
      expect(result.errors?.[0]?.code).toBe('parse_error')
      expect(result.summary).toContain("'replies_path'")
    })
  })

  test('a path that climbs out of the home is refused by its key before any read', async () => {
    await withHome(async () => {
      const result = await invoke({ replies_path: '../replies.json' })
      expect(result.status).toBe('failed')
      expect(result.errors?.[0]?.code).toBe('parse_error')
      expect(result.summary).toContain("'replies_path'")
    })
  })

  test('an entry with no contact_id is refused by its position', async () => {
    await withHome(async (home) => {
      await seed(home, JSON.stringify({ replies: [{ contact_id: 'c-1' }, { id: 'c-2' }] }))
      const result = await invoke()
      expect(result.status).toBe('failed')
      expect(result.summary).toContain("entry 2 of the file named by input 'replies_path'")
    })
  })

  test('a run writes nothing under the home', async () => {
    await withHome(async (home) => {
      await seed(home, JSON.stringify({ replies: [{ contact_id: 'c-1' }] }))
      const before = (await readdir(home, { recursive: true })).sort()
      const result = await invoke()
      expect(result.status).toBe('success')
      expect((await readdir(home, { recursive: true })).sort()).toEqual(before)
    })
  })
})

/** `replies_path` is a configured value and every summary lands in the run log. */
describe('cadence-replies config value disclosure', () => {
  const SENTINEL = 'state/do-not-echo-2f9d-replies.json'

  test('the configured path never reaches the result, whether the file was missing, broken or read', async () => {
    await withHome(async (home) => {
      const missing = await invoke({ replies_path: SENTINEL })
      await seed(home, 'not json', SENTINEL)
      const broken = await invoke({ replies_path: SENTINEL })
      await seed(home, JSON.stringify({ replies: [{ contact_id: 'c-1' }] }), SENTINEL)
      const read = await invoke({ replies_path: SENTINEL })

      expect([missing.status, broken.status, read.status]).toEqual(['success', 'failed', 'success'])
      for (const result of [missing, broken, read]) expect(JSON.stringify(result)).not.toContain('do-not-echo')
    })
  })
})
