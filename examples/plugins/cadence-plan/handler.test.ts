import { describe, test, expect } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CapabilityContext, DependenciesHandle } from 'warpline/unstable-capabilities'
import { OutputRecordSchema, type OutputRecord } from 'warpline/schemas/skill-result'
import { handler } from './handler.js'
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
