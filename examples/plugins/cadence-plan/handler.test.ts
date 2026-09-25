import { describe, test, expect } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CapabilityContext, DependenciesHandle } from 'warpline/unstable-capabilities'
import { OutputRecordSchema, type OutputRecord } from 'warpline/schemas/skill-result'
import { handler, planOutbox, type Contact, type Step } from './handler.js'
import { manifest } from './manifest.js'

type RunStatus = ReturnType<DependenciesHandle['lastRun']>

/**
 * The fourth parameter, hand-built. An example may not import `src/`, so the
 * runtime's mint is out of reach on purpose: this file proves the handler does
 * the right thing with what it is handed, and the delivery is proven under
 * `src/`. Both members throw for any name but `cadence-replies`, the way the
 * runtime refuses an undeclared name.
 */
function contextWith(record: OutputRecord | null, run: RunStatus = record === null ? null : 'success'): CapabilityContext {
  const declared = (name: string): void => {
    if (name !== 'cadence-replies') throw new Error(`cadence-plan does not declare '${name}' in manifest.dependencies`)
  }
  return {
    caller: { plugin: 'cadence-plan' },
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

/** An inline-body Output in the shape `cadence-replies` returns. */
const repliesOf = (replied: string[]): OutputRecord => ({ type: 'replies', format: 'json', body: JSON.stringify({ replied }) })

async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'cadence-plan-'))
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

const DAY_MS = 86_400_000
const STARTED = Date.now()
const ENROLLED = new Date(STARTED - 3 * DAY_MS).toISOString()

/** Five contacts enrolled three days before the test started. */
const CONTACTS = [1, 2, 3, 4, 5].map((n) => ({ id: `c-${n}`, email: `c-${n}@example.com`, enrolled_at: ENROLLED }))
const STEPS = [
  { offset_days: 0, subject: 'Hello', body: 'First note' },
  { offset_days: 30, subject: 'Again', body: 'Second note' },
]

async function seed(home: string, contacts: unknown = CONTACTS, steps: unknown = STEPS): Promise<void> {
  await mkdir(join(home, 'state'), { recursive: true })
  await writeFile(join(home, 'state', 'contacts.json'), JSON.stringify({ contacts }))
  await writeFile(join(home, 'state', 'steps.json'), JSON.stringify({ steps }))
}

function invoke(context: CapabilityContext, args: Record<string, unknown> = {}) {
  return handler(manifest, args, new AbortController().signal, context)
}

describe('cadence-plan works out the outbox', () => {
  test('a replies body and five due contacts become a five-email outbox', async () => {
    await withHome(async (home) => {
      await seed(home)
      const result = await invoke(contextWith(repliesOf([])))

      expect(result.status).toBe('success')
      expect(result.artifacts_produced).toHaveLength(1)
      const output = OutputRecordSchema.parse(result.artifacts_produced![0])
      expect(output.type).toBe('outbox')
      const { outbox, review_tasks } = JSON.parse(output.body!)
      expect(outbox.map((e: { id: string }) => e.id)).toEqual(['c-1:1', 'c-2:1', 'c-3:1', 'c-4:1', 'c-5:1'])
      expect(outbox.map((e: { to: string }) => e.to)).toEqual(CONTACTS.map((c) => c.email))
      for (const email of outbox) {
        expect(email.step).toBe(1)
        expect(email.subject).toBe('Hello')
      }
      expect(review_tasks).toEqual([])
    })
  })
})

const T = Date.parse('2026-03-02T10:00:00.000Z')
const at = (ms: number) => new Date(ms)
const contact = (id: string, enrolled = T): Contact => ({ id, email: `${id}@example.com`, enrolled_at: new Date(enrolled).toISOString() })
const step = (offset_days: number, n: number): Step => ({ offset_days, subject: `Subject ${n}`, body: `Body ${n}` })

describe('cadence-plan planOutbox', () => {
  test('a step whose due instant equals now to the millisecond is due', () => {
    const now = at(T + 2 * DAY_MS)
    const { outbox } = planOutbox([contact('c-1')], [step(0, 1), step(2, 2)], [], [], now)
    expect(outbox).toHaveLength(1)
    expect(outbox[0]!.step).toBe(2)
    expect(outbox[0]!.id).toBe('c-1:2')
    expect(outbox[0]!.due_at).toBe(now.toISOString())
  })

  test('one millisecond before that instant the earlier step is the due one', () => {
    const { outbox } = planOutbox([contact('c-1')], [step(0, 1), step(2, 2)], [], [], at(T + 2 * DAY_MS - 1))
    expect(outbox.map((e) => e.step)).toEqual([1])
  })

  test('the latest due step is the one queued, never an earlier one beside it', () => {
    const { outbox } = planOutbox([contact('c-1')], [step(0, 1), step(3, 2), step(7, 3)], [], [], at(T + 5 * DAY_MS))
    expect(outbox.map((e) => e.id)).toEqual(['c-1:2'])
  })

  test('a reply in the same run as a due step stops the contact and emits a review task instead', () => {
    const contacts = [contact('c-1'), contact('c-2'), contact('c-3')]
    const { outbox, review_tasks, stop } = planOutbox(contacts, [step(0, 1)], ['c-2'], [], at(T))
    expect(outbox.map((e) => e.contact_id)).toEqual(['c-1', 'c-3'])
    expect(review_tasks).toEqual([{ contact_id: 'c-2', email: 'c-2@example.com', task: 'replied: review the thread and decide the next touch by hand' }])
    expect(stop).toContain('c-2')
  })

  test('a contact already stopped gets no email and no review task', () => {
    const contacts = [contact('c-1'), contact('c-3')]
    const { outbox, review_tasks, stop } = planOutbox(contacts, [step(0, 1)], [], ['c-3'], at(T))
    expect(outbox.map((e) => e.contact_id)).toEqual(['c-1'])
    expect(review_tasks).toEqual([])
    expect(stop).toEqual(['c-3'])
  })

  test('the outbox is sorted by contact id whatever the order of the contacts file', () => {
    const { outbox } = planOutbox([contact('c-3'), contact('c-1'), contact('c-2')], [step(0, 1)], [], [], at(T))
    expect(outbox.map((e) => e.id)).toEqual(['c-1:1', 'c-2:1', 'c-3:1'])
  })

  test('with nobody due the outbox is empty', () => {
    const future = T + 10 * DAY_MS
    const { outbox, review_tasks } = planOutbox([contact('c-1', future), contact('c-2', future)], [step(0, 1)], [], [], at(T))
    expect(outbox).toEqual([])
    expect(review_tasks).toEqual([])
  })
})

const STOPPED = (home: string) => join(home, 'state', 'cadence-plan.stopped.json')

const bodyOf = (result: Awaited<ReturnType<typeof invoke>>): string =>
  OutputRecordSchema.parse(result.artifacts_produced![0]).body!

describe('cadence-plan keeps a replied contact stopped', () => {
  test('a reply is written to the stopped list, and a later run without it still leaves the contact out', async () => {
    await withHome(async (home) => {
      await seed(home)
      const first = await invoke(contextWith(repliesOf(['c-2'])))
      expect(first.status).toBe('success')
      expect(JSON.parse(await readFile(STOPPED(home), 'utf-8'))).toEqual({ stopped: ['c-2'] })
      expect(JSON.parse(bodyOf(first)).outbox.map((e: { id: string }) => e.id)).toEqual(['c-1:1', 'c-3:1', 'c-4:1', 'c-5:1'])

      const second = await invoke(contextWith(repliesOf([])))
      expect(second.status).toBe('success')
      const { outbox, review_tasks } = JSON.parse(bodyOf(second))
      expect(outbox.map((e: { contact_id: string }) => e.contact_id)).not.toContain('c-2')
      expect(review_tasks).toEqual([])
    })
  })

  test('a stopped list that is not this plugin\'s shape is refused, never read as empty', async () => {
    await withHome(async (home) => {
      await seed(home)
      await writeFile(STOPPED(home), JSON.stringify({ stopped: 'c-1' }))
      const result = await invoke(contextWith(repliesOf([])))
      expect(result.status).toBe('failed')
      expect(result.errors?.[0]?.code).toBe('parse_error')
      expect(result.summary).toContain('stopped list')
      expect(result.artifacts_produced ?? []).toHaveLength(0)
    })
  })
})

describe('cadence-plan outputs the same bytes for the same inputs', () => {
  test('two runs over identical inputs return byte-identical bodies with exactly the published keys', async () => {
    await withHome(async (home) => {
      await seed(home)
      const a = bodyOf(await invoke(contextWith(repliesOf(['c-4']))))
      const b = bodyOf(await invoke(contextWith(repliesOf(['c-4']))))
      expect(a).toBe(b)

      const parsed = JSON.parse(a)
      expect(Object.keys(parsed)).toEqual(['outbox', 'review_tasks'])
      expect(parsed.outbox.length).toBeGreaterThan(0)
      for (const email of parsed.outbox) {
        expect(Object.keys(email)).toEqual(['id', 'contact_id', 'step', 'to', 'subject', 'body', 'due_at'])
      }
    })
  })
})

describe('cadence-plan refuses what it cannot plan from', () => {
  test('no Output from cadence-replies yet plans nothing and writes nothing', async () => {
    await withHome(async (home) => {
      await seed(home)
      const result = await invoke(contextWith(null))
      expect(result.status).toBe('success')
      expect(result.summary).toContain('no data from cadence-replies')
      expect(result.artifacts_produced ?? []).toHaveLength(0)
      await expect(stat(STOPPED(home))).rejects.toThrow()
    })
  })

  test('a replies body that is not a replies list fails rather than planning without reply detection', async () => {
    await withHome(async (home) => {
      await seed(home)
      const result = await invoke(contextWith({ type: 'replies', format: 'json', body: '{"replied": 3}' }))
      expect(result.status).toBe('failed')
      expect(result.errors?.[0]?.code).toBe('parse_error')
      expect(result.artifacts_produced ?? []).toHaveLength(0)
    })
  })

  test('a contacts path that climbs out of the home is refused by its key', async () => {
    await withHome(async (home) => {
      await seed(home)
      const result = await invoke(contextWith(repliesOf([])), { contacts_path: '../c.json' })
      expect(result.status).toBe('failed')
      expect(result.errors?.[0]?.code).toBe('parse_error')
      expect(result.summary).toContain("'contacts_path'")
    })
  })

  test('a missing contacts file plans nothing, on the success arm, and still records the reply', async () => {
    await withHome(async (home) => {
      await mkdir(join(home, 'state'), { recursive: true })
      await writeFile(join(home, 'state', 'steps.json'), JSON.stringify({ steps: STEPS }))
      const result = await invoke(contextWith(repliesOf(['c-2'])))
      expect(result.status).toBe('success')
      expect(result.summary).toContain("'contacts_path'")
      // An empty outbox, not no Output: no Output would leave an approved one live.
      expect(JSON.parse(bodyOf(result))).toEqual({ outbox: [], review_tasks: [] })
      expect(JSON.parse(await readFile(STOPPED(home), 'utf-8'))).toEqual({ stopped: ['c-2'] })
    })
  })

  test('a contact with no email is refused by its position', async () => {
    await withHome(async (home) => {
      await seed(home, [CONTACTS[0], { id: 'c-9', enrolled_at: ENROLLED }])
      const result = await invoke(contextWith(repliesOf([])))
      expect(result.status).toBe('failed')
      expect(result.summary).toContain("entry 2 of the file named by input 'contacts_path'")
    })
  })

  test('a contact id listed twice is refused by name', async () => {
    await withHome(async (home) => {
      await seed(home, [CONTACTS[0], CONTACTS[0]])
      const result = await invoke(contextWith(repliesOf([])))
      expect(result.status).toBe('failed')
      expect(result.summary).toContain('contact c-1 appears twice')
    })
  })

  test('an outbox over the Output cap fails by name rather than truncating', async () => {
    await withHome(async (home) => {
      const many = Array.from({ length: 400 }, (_, i) => ({
        id: `c-${String(i).padStart(3, '0')}`,
        email: `c-${i}@example.com`,
        enrolled_at: ENROLLED,
      }))
      await seed(home, many, [{ offset_days: 0, subject: 'Hello', body: 'x'.repeat(60) }])
      const result = await invoke(contextWith(repliesOf([])))
      expect(result.status).toBe('failed')
      expect(result.summary).toContain('Output cap')
      expect(result.artifacts_produced ?? []).toHaveLength(0)
    })
  })
})

describe('cadence-plan hands nothing off and never reads the send ledger', () => {
  test('the handler source names no send ledger and builds no handoff', async () => {
    const source = await readFile(new URL('./handler.ts', import.meta.url), 'utf-8')
    expect(source).not.toContain('sent.json')
    expect(source).not.toMatch(/\bskillHandoff\s*\(/)
    expect(source).not.toMatch(/\bneeds_llm\s*:/)
    expect(manifest.llm_handoff).toBe(false)
  })
})

/**
 * Both paths are configured values and every summary lands in the run log, so
 * no arm names the value it was handed.
 */
describe('cadence-plan config value disclosure', () => {
  const CONTACTS_SENTINEL = 'state/do-not-echo-4c1b-contacts.json'
  const STEPS_SENTINEL = 'state/do-not-echo-7e2a-steps.json'
  const args = { contacts_path: CONTACTS_SENTINEL, steps_path: STEPS_SENTINEL }

  test('a configured path never reaches the result, whether the file was missing, broken or read', async () => {
    await withHome(async (home) => {
      const missing = await invoke(contextWith(repliesOf([])), args)
      expect(missing.status).toBe('success')

      await mkdir(join(home, 'state'), { recursive: true })
      await writeFile(join(home, CONTACTS_SENTINEL), 'not json')
      const broken = await invoke(contextWith(repliesOf([])), args)
      expect(broken.status).toBe('failed')

      await writeFile(join(home, CONTACTS_SENTINEL), JSON.stringify({ contacts: CONTACTS }))
      await writeFile(join(home, STEPS_SENTINEL), JSON.stringify({ steps: STEPS }))
      const read = await invoke(contextWith(repliesOf(['c-1'])), args)
      expect(read.status).toBe('success')

      for (const result of [missing, broken, read]) expect(JSON.stringify(result)).not.toContain('do-not-echo')
    })
  })
})
