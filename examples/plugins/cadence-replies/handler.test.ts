import { describe, test, expect } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
