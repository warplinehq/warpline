import { describe, test, expect } from 'bun:test'
import { mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CapabilityContext } from 'warpline/unstable-capabilities'
import { handler } from './handler.js'
import { manifest } from './manifest.js'

/** The handler is four-parameter; a test hands it a context it never reads. */
const CONTEXT = {} as CapabilityContext

/** The shape `warpline run note-intake default --input note=<text>` delivers: strings, under the action positional. */
function invoke(args: Record<string, unknown>) {
  return handler(manifest, { ...args, action: 'default' }, new AbortController().signal, CONTEXT)
}

/**
 * `warpline/lib/paths` exports only `warplineHome`, which resolves
 * `WARPLINE_HOME` per call — the same seam a plugin author has. Each test
 * below gets its own home and restores the suite's afterwards.
 */
async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'note-intake-'))
  const realHome = process.env.WARPLINE_HOME
  process.env.WARPLINE_HOME = home
  try {
    return await fn(home)
  } finally {
    if (realHome === undefined) delete process.env.WARPLINE_HOME
    else process.env.WARPLINE_HOME = realHome
  }
}

/**
 * The whole home as `path|bytes|contents`, sorted. A full recursive walk with
 * no exclusion list, so "exactly one new file" is a statement about the
 * whole tree. Contents inline rather than hashed: a test home holds a few
 * hundred bytes, and `examples/` may not reach for `node:crypto`.
 */
async function snapshot(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      out.push(...(await snapshot(join(dir, entry.name), rel)))
    } else {
      const bytes = await readFile(join(dir, entry.name))
      out.push(`${rel}|${bytes.byteLength}|${bytes.toString('base64')}`)
    }
  }
  return out.sort()
}

const INBOX = join('notes', 'note-intake')

/** The one file the handler routed to, read as bytes. */
async function routedFile(home: string): Promise<{ name: string; bytes: Buffer }> {
  const names = await readdir(join(home, INBOX))
  expect(names).toHaveLength(1)
  return { name: names[0]!, bytes: await readFile(join(home, INBOX, names[0]!)) }
}

describe('note-intake routes operator text', () => {
  test('text in args is routed, and the summary names where it went without quoting it', async () => {
    await withHome(async (home) => {
      const result = await invoke({ note: 'remember to rotate the feed key' })

      expect(result.status).toBe('success')
      const { name, bytes } = await routedFile(home)
      expect(bytes.toString('utf8')).toBe('remember to rotate the feed key')
      expect(result.summary).toContain(`${INBOX}/${name}`)
      expect(result.summary).not.toContain('rotate')
    })
  })

  test('no text is a prefixed skip naming the key and the exact invocation, not a failure', async () => {
    await withHome(async () => {
      const result = await invoke({})

      // A prefix-less `skipped` is persisted as `failed`, which paints a red
      // run for a plugin simply waiting for a human.
      expect(result.status).not.toBe('skipped')
      expect(result.status).toBe('success')
      expect(result.summary.startsWith(`${manifest.name}:`)).toBe(true)
      expect(result.summary).toContain("'note'")
      expect(result.summary).toContain('warpline run note-intake default --input note=')
    })
  })

  test('the routed note is under the home and nowhere else: exactly one new file, nothing else touched', async () => {
    await withHome(async (home) => {
      await mkdir(join(home, 'config'), { recursive: true })
      await writeFile(join(home, 'config', 'note-intake.json'), '{}')
      const before = await snapshot(home)
      const result = await invoke({ note: 'one line' })
      const after = await snapshot(home)

      expect(result.status).toBe('success')
      expect(after).toHaveLength(before.length + 1)
      expect(before.every(line => after.includes(line))).toBe(true)
      expect(after.filter(line => !before.includes(line))[0]!.startsWith(`${INBOX}/`)).toBe(true)
    })
  })

  test('text with =, non-ASCII characters and a newline survives byte for byte', async () => {
    const text = 'key=value=again\nñ 日本 💡 second line\n'
    await withHome(async (home) => {
      const result = await invoke({ note: text })

      expect(result.status).toBe('success')
      const { bytes } = await routedFile(home)
      expect(bytes.equals(Buffer.from(text, 'utf8'))).toBe(true)
    })
  })

  test('the declared input is a string, and the manifest docstring says why', async () => {
    expect(manifest.inputs.note?.type).toBe('string')
    expect(manifest.inputs.note?.required).toBe(true)
    expect(Object.hasOwn(manifest.inputs.note ?? {}, 'default')).toBe(false)
    expect(manifest.schedule).toBe('manual')

    const source = await readFile(join(import.meta.dir, 'manifest.ts'), 'utf8')
    expect(source).toContain('--input')
    expect(source).toContain('not converted')
    expect(source).toContain("schedule: 'manual'")
  })

  test('a destination that is absolute, carries a drive letter or climbs out is refused before any write', async () => {
    await withHome(async (home) => {
      const before = await snapshot(home)
      for (const inbox of ['/tmp/elsewhere', 'C:\\elsewhere', 'notes/../../elsewhere', '..']) {
        const result = await invoke({ note: 'should not land', inbox })
        expect(result.status).toBe('failed')
        expect(result.summary).toContain("'inbox'")
        expect(result.summary).not.toContain('elsewhere')
      }
      expect(await snapshot(home)).toEqual(before)
    })
  })
})

/**
 * The note is the operator's, and this result lands in the run log. The text
 * exists in exactly one place afterwards: the file it was routed to.
 */
describe('note-intake never echoes the note', () => {
  const SENTINEL = 'do-not-echo-9f8e7d'

  test('a sentinel supplied as the note appears in the routed file and in nothing the handler returns', async () => {
    await withHome(async (home) => {
      const result = await invoke({ note: `${SENTINEL} and some more words` })

      expect(result.status).toBe('success')
      expect(JSON.stringify(result)).not.toContain(SENTINEL)
      const { bytes } = await routedFile(home)
      expect(bytes.toString('utf8')).toContain(SENTINEL)
    })
  })
})
