import { describe, test, expect } from 'bun:test'
import { mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { CapabilityContext } from 'warpline/unstable-capabilities'
import { SkillResultSchema } from 'warpline/schemas/skill-result'
import { handler } from './handler.js'
import { manifest } from './manifest.js'

/** The handler is four-parameter; a test hands it a context it never reads. */
const CONTEXT = {} as CapabilityContext

function invoke(args: Record<string, unknown>) {
  return handler(manifest, args, new AbortController().signal, CONTEXT)
}

/**
 * `warpline/lib/paths` exports only `warplineHome`, which resolves
 * `WARPLINE_HOME` per call — the same seam a plugin author has. Each case
 * gets its own home and restores the suite's afterwards.
 */
async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'announce-fanout-'))
  const realHome = process.env.WARPLINE_HOME
  process.env.WARPLINE_HOME = home
  try {
    return await fn(home)
  } finally {
    if (realHome === undefined) delete process.env.WARPLINE_HOME
    else process.env.WARPLINE_HOME = realHome
  }
}

/** Write a file at a home-relative path, creating the parent. */
async function seed(home: string, rel: string, content: string): Promise<void> {
  await mkdir(dirname(join(home, rel)), { recursive: true })
  await writeFile(join(home, rel), content)
}

/** The shipped default for the draft input. */
const DRAFT_PATH = manifest.inputs.draft_path?.default as string
const DRAFT = { title: 'An example announcement', body: 'Placeholder body text.' }

async function seedDraft(home: string, rel = DRAFT_PATH, draft: unknown = DRAFT): Promise<void> {
  await seed(home, rel, JSON.stringify(draft))
}

/**
 * The whole home as `path|bytes|contents`, sorted: a full recursive walk with
 * no exclusion list, so "nothing written" is a statement about the whole
 * tree. Inline rather than hashed — `examples/` may not reach for
 * `node:crypto`.
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

/** Fixture channels: invented, and plainly so. */
const CHANNELS = ['town-crier', 'carrier-pigeon', 'semaphore-tower']
const CALLS = {
  'town-crier': 'Hear the whole announcement at the example square',
  'carrier-pigeon': 'Reply by return pigeon to the example loft',
  'semaphore-tower': 'Signal back to the example tower',
}
const CONFIGURED = { channels: CHANNELS, calls_to_action: CALLS }

interface Payload {
  draft_path: string
  channels: Record<string, { call_to_action: string }>
  unconfigured: string[]
  held: string[]
}

async function readPayload(result: { summary: string }): Promise<{ text: string; payload: Payload }> {
  const text = await readFile(result.summary.split('Context: ')[1]!, 'utf8')
  return { text, payload: JSON.parse(text) as Payload }
}

describe('announce-fanout fans one draft out to every configured channel', () => {
  test('a channel list and a mapping configured: a [needs-llm] handoff naming every channel, with each call to action in the payload', async () => {
    await withHome(async (home) => {
      await seedDraft(home)
      const result = await invoke(CONFIGURED)

      expect(result.status).toBe('skipped')
      expect(result.summary.startsWith('[needs-llm]')).toBe(true)
      expect(result.needs_llm).toBeDefined()
      expect(/[.!?]$/.test(result.needs_llm?.task ?? '.')).toBe(false)
      for (const channel of CHANNELS) expect(result.needs_llm?.task).toContain(channel)
      expect(result.needs_llm?.task).toContain('3')
      expect(() => SkillResultSchema.parse(result)).not.toThrow()

      const [, tail] = result.summary.split('Context: ')
      expect(tail).toBe(join(home, result.needs_llm!.context_path))
      const { payload } = await readPayload(result)
      expect(payload.draft_path).toBe(DRAFT_PATH)
      expect(Object.keys(payload.channels)).toEqual(CHANNELS)
      for (const channel of CHANNELS) {
        expect(payload.channels[channel]).toEqual({ call_to_action: CALLS[channel as keyof typeof CALLS] })
      }
      expect(payload.unconfigured).toEqual([])
      expect(payload.held).toEqual([])
    })
  })

  test('an EMPTY channel list — the shipped default — is a prefixed skip naming the key and the configuring invocation, not a failure and not a success that sent nothing', async () => {
    await withHome(async (home) => {
      await seedDraft(home)
      const before = await snapshot(home)
      const result = await invoke({})

      expect(result.status).not.toBe('skipped')
      expect(result.status).toBe('success')
      expect(result.summary.startsWith(`${manifest.name}:`)).toBe(true)
      expect(result.summary).toContain("'channels'")
      expect(result.summary).toContain('warpline configure announce-fanout')
      expect(result.summary.startsWith('[needs-llm]')).toBe(false)
      expect(await snapshot(home)).toEqual(before)
    })
  })

  test('a channel in the list but absent from the mapping is reported as unconfigured while the others proceed', async () => {
    await withHome(async (home) => {
      await seedDraft(home)
      const { 'semaphore-tower': _dropped, ...partial } = CALLS
      const result = await invoke({ channels: CHANNELS, calls_to_action: partial })

      // The act. A loop with a shared failure path would have failed here.
      expect(result.status).toBe('skipped')
      expect(result.summary.startsWith('[needs-llm]')).toBe(true)
      expect(result.needs_llm?.task).toContain('2')
      expect(result.needs_llm?.task).toMatch(/unconfigured.*semaphore-tower/)
      expect(result.needs_llm?.task).toContain('town-crier')
      expect(result.needs_llm?.task).toContain('carrier-pigeon')

      const { payload } = await readPayload(result)
      expect(Object.keys(payload.channels)).toEqual(['town-crier', 'carrier-pigeon'])
      expect(payload.unconfigured).toEqual(['semaphore-tower'])

      // Every channel unconfigured: nothing to fan out, by key, not a failure.
      const none = await invoke({ channels: CHANNELS, calls_to_action: {} })
      expect(none.status).toBe('success')
      expect(none.summary.startsWith(`${manifest.name}:`)).toBe(true)
      expect(none.summary).toContain("'calls_to_action'")
      expect(none.summary).toContain('warpline configure announce-fanout')
    })
  })

  test('the cadence holds a channel handed off within the window, and releases it when the window is shorter', async () => {
    await withHome(async (home) => {
      await seedDraft(home)
      const first = await invoke(CONFIGURED)
      expect(first.status).toBe('skipped')

      // Inside the default window every channel is held: a prefixed success
      // that names the hold, not a second hand-off of the same draft.
      const again = await invoke(CONFIGURED)
      expect(again.status).toBe('success')
      expect(again.summary.startsWith(`${manifest.name}:`)).toBe(true)
      expect(again.summary).toContain('cadence')
      expect(again.summary).toContain('3')

      // A fourth channel that was never handed off is due while the three are held.
      const fourth = await invoke({
        channels: [...CHANNELS, 'message-in-a-bottle'],
        calls_to_action: { ...CALLS, 'message-in-a-bottle': 'Write back to the example shore' },
      })
      expect(fourth.status).toBe('skipped')
      expect(fourth.needs_llm?.task).toMatch(/message-in-a-bottle/)
      expect(fourth.needs_llm?.task).toMatch(/3 held within cadence/)
      const { payload } = await readPayload(fourth)
      expect(Object.keys(payload.channels)).toEqual(['message-in-a-bottle'])
      expect(payload.held).toEqual(CHANNELS)

      // A zero-hour cadence releases everything.
      const released = await invoke({ ...CONFIGURED, cadence_hours: 0 })
      expect(released.status).toBe('skipped')
      for (const channel of CHANNELS) expect(released.needs_llm?.task).toContain(channel)
    })
  })

  test('no draft at the configured path is a prefixed skip; a draft path outside the home is refused before any read', async () => {
    await withHome(async (home) => {
      const before = await snapshot(home)
      const none = await invoke(CONFIGURED)
      expect(none.status).toBe('success')
      expect(none.summary.startsWith(`${manifest.name}:`)).toBe(true)
      expect(none.summary).toContain('nothing to fan out')

      for (const outside of ['/tmp/elsewhere/draft.json', 'C:\\elsewhere\\draft.json', 'state/../../elsewhere/draft.json']) {
        const result = await invoke({ ...CONFIGURED, draft_path: outside })
        expect(result.status).toBe('failed')
        expect(result.summary).toContain("'draft_path'")
        expect(result.summary).not.toContain('elsewhere')
      }
      expect(await snapshot(home)).toEqual(before)

      await seedDraft(home, DRAFT_PATH, undefined)
      await seed(home, DRAFT_PATH, '{"title": ')
      const broken = await invoke(CONFIGURED)
      expect(broken.status).toBe('failed')
      expect(broken.errors?.[0]?.code).toBe('parse_error')
      expect(broken.summary).toContain("'draft_path'")
    })
  })
})

/**
 * No channel, call to action or cadence ships in the handler. Structurally:
 * the source reads exactly the declared inputs, and none of the fixture
 * configuration above appears in it.
 */
describe('announce-fanout carries no configuration of its own', () => {
  test('the handler reads every declared input and nothing else, and no fixture channel or call to action appears in its source', async () => {
    const source = await readFile(join(import.meta.dir, 'handler.ts'), 'utf8')
    const read = new Set<string>()
    for (const m of source.matchAll(/configured\(manifest, args, '(\w+)'\)/g)) read.add(m[1]!)
    for (const m of source.matchAll(/\bargs\.(\w+)/g)) read.add(m[1]!)
    for (const m of source.matchAll(/\bargs\[['"](\w+)['"]\]/g)) read.add(m[1]!)
    const declared = Object.keys(manifest.inputs).sort()
    // Both directions: an undeclared read is config the manifest hides, and a
    // declared input nobody reads is decoration.
    expect([...read].sort()).toEqual(declared)

    for (const channel of CHANNELS) expect(source).not.toContain(channel)
    for (const call of Object.values(CALLS)) expect(source).not.toContain(call)
    // The cadence default lives in the manifest, not here.
    expect(source).not.toMatch(/\b24\b/)
    expect(source).toContain('Object.create(null)')
  })

  test('the manifest says where array and object values come from, and both defaults are empty', async () => {
    expect(manifest.inputs.channels?.type).toBe('array')
    expect(manifest.inputs.channels?.default).toEqual([])
    expect(manifest.inputs.calls_to_action?.type).toBe('object')
    expect(manifest.inputs.calls_to_action?.default).toEqual({})
    expect(manifest.side_effects).toEqual([])

    const source = await readFile(join(import.meta.dir, 'manifest.ts'), 'utf8')
    expect(source).toContain('command line')
    expect(source).toContain('warpline configure announce-fanout')
  })
})

/**
 * A call to action is operator configuration and every summary lands in the
 * run log, so no arm names a mapping VALUE. Channels are named — the plan
 * for a fan-out has to say where it went — and the values stay in the
 * config file and the payload under the home.
 */
describe('announce-fanout never echoes a mapping value', () => {
  const SENTINEL = 'do-not-echo-7b3d'

  test('a sentinel in a configured call to action never appears in the result, on any arm', async () => {
    await withHome(async (home) => {
      await seedDraft(home)
      const calls = { ...CALLS, 'town-crier': `Hear it at ${SENTINEL}` }
      const handed = await invoke({ channels: CHANNELS, calls_to_action: calls })
      expect(handed.status).toBe('skipped')
      expect(JSON.stringify(handed)).not.toContain(SENTINEL)
      const { text } = await readPayload(handed)
      expect(text).toContain(SENTINEL)

      const held = await invoke({ channels: CHANNELS, calls_to_action: calls })
      expect(held.status).toBe('success')
      expect(JSON.stringify(held)).not.toContain(SENTINEL)

      const unconfigured = await invoke({ channels: ['town-crier'], calls_to_action: { 'carrier-pigeon': SENTINEL } })
      expect(JSON.stringify(unconfigured)).not.toContain(SENTINEL)
    })
  })
})
