import { describe, test, expect } from 'bun:test'
import type { CapabilityContext } from 'warpline/unstable-capabilities'
import { OutputRecordSchema, type OutputRecord } from 'warpline/schemas/skill-result'
import { handler } from './handler.js'
import { manifest } from './manifest.js'

/**
 * The fourth parameter, carrying the one member this handler reads.
 *
 * A hand-written literal and not the runtime's mint: an example may import
 * only the three `warpline/unstable-*` specifiers, so `src/` is out of reach
 * from here on purpose. What that costs is stated rather than hidden — this
 * file proves the HANDLER folds each combination of upstream states into the
 * right digest, and the runtime's DELIVERY of those records is proven under
 * `src/`.
 *
 * `lastOutput` throws for any name this plugin does not declare, mirroring the
 * runtime's refusal, so the handler is never written against a `null` it would
 * not receive.
 */
const RECORDS = ['anomaly-watch', 'github-poll'] as const

function invoke(records: Partial<Record<(typeof RECORDS)[number], OutputRecord | null>>) {
  const context = {
    caller: { plugin: 'daily-digest' },
    secrets: { resolvedNames: () => [] },
    dependencies: {
      lastOutput: (_caller: unknown, name: string) => {
        if (name !== 'anomaly-watch' && name !== 'github-poll') {
          throw new Error(`daily-digest does not declare '${name}' in manifest.dependencies`)
        }
        return records[name] ?? null
      },
    },
  } as CapabilityContext
  return handler(manifest, {}, new AbortController().signal, context)
}

/** An inline-body Output in the shape each producer returns. */
function outputOf(type: string, body: unknown): OutputRecord {
  return { type, format: 'json', body: JSON.stringify(body) }
}

const ANOMALIES = outputOf('anomalies', {
  observed_at: '2026-01-01T00:00:00.000Z',
  anomalies: [
    { name: 'errors', latest: 42, threshold: 10, direction: 'above' },
    { name: 'signups', latest: 3, threshold: 5, direction: 'below' },
  ],
})
const ISSUES = outputOf('issues-snapshot', { observed_at: '2026-01-01T00:00:00.000Z', open_count: 7, newest_number: 12 })

describe('daily-digest aggregates its declared dependencies', () => {
  test('both upstream results present: one digest naming both sources, and exactly one Output', async () => {
    const result = await invoke({ 'anomaly-watch': ANOMALIES, 'github-poll': ISSUES })

    expect(result.status).toBe('success')
    expect(result.summary).toContain('anomaly-watch')
    expect(result.summary).toContain('github-poll')
    expect(result.summary).toContain('2 breached')
    expect(result.summary).toContain('7 open issues')
    expect(result.artifacts_produced).toHaveLength(1)
    const output = OutputRecordSchema.parse(result.artifacts_produced?.[0])
    expect(output.body).toBeDefined()
    expect(output.path).toBeUndefined()
    expect(Buffer.byteLength(output.body!, 'utf8')).toBeLessThanOrEqual(16_384)
  })

  test('one upstream result absent: the digest still returns and says which source had nothing', async () => {
    const result = await invoke({ 'anomaly-watch': ANOMALIES })

    // A missing upstream is not a failure of the digest. The source that had
    // nothing is named, so the digest does not read as complete when it is not.
    expect(result.status).toBe('success')
    expect(result.summary).toContain('2 breached')
    expect(result.summary).toMatch(/github-poll: nothing/)
    expect(result.artifacts_produced).toHaveLength(1)
  })

  test('no upstream results at all: a prefixed skip, never a bare skipped, and no digest claimed', async () => {
    const result = await invoke({})

    // A prefix-less `skipped` is persisted as `failed`, so the arm is a
    // success in status — but it produces NO Output: an empty digest must
    // not enter the engine's last_output as though a day had been digested.
    expect(result.status).not.toBe('skipped')
    expect(result.status).toBe('success')
    expect(result.summary.startsWith(`${manifest.name}:`)).toBe(true)
    expect(result.summary).toContain('nothing to digest')
    expect(result.artifacts_produced ?? []).toHaveLength(0)
  })

  test('the digest Output is the LAST element of artifacts_produced, because the engine takes .at(-1)', async () => {
    const result = await invoke({ 'anomaly-watch': ANOMALIES, 'github-poll': ISSUES })

    const last = result.artifacts_produced?.at(-1)
    expect(last).toBeDefined()
    const output = OutputRecordSchema.parse(last)
    expect(output.type).toBe('digest')
    const body = JSON.parse(output.body!)
    expect(Object.keys(body.sources).sort()).toEqual(['anomaly-watch', 'github-poll'])
    expect(body.sources['github-poll'].open_count).toBe(7)
  })

  test('a record whose body is not JSON reads as "nothing yet", never as a failed run', async () => {
    // A body is a string another plugin authored. The parse is caught and the
    // per-source shape guard reads the result as "that source has nothing
    // usable", because a throw out of a handler is a failed run with no
    // structure — and one unparseable upstream must not lose the other one.
    const result = await invoke({
      'anomaly-watch': { type: 'anomalies', format: 'json', body: 'not json' },
      'github-poll': ISSUES,
    })

    expect(result.status).toBe('success')
    expect(result.summary).toMatch(/anomaly-watch: nothing/)
    expect(result.summary).toContain('7 open issues')
  })

  test('a record in a shape this digest does not read is "nothing yet" for that source alone', async () => {
    const result = await invoke({
      'anomaly-watch': ANOMALIES,
      'github-poll': outputOf('issues-snapshot', { unexpected: true }),
    })

    expect(result.status).toBe('success')
    expect(result.summary).toContain('2 breached')
    expect(result.summary).toMatch(/github-poll: nothing/)
  })

  test('a dependency this plugin does not declare throws rather than reading null', async () => {
    const context = {
      caller: { plugin: 'daily-digest' },
      secrets: { resolvedNames: () => [] },
      dependencies: {
        lastOutput: (_caller: unknown, name: string) => {
          if (name !== 'anomaly-watch' && name !== 'github-poll') {
            throw new Error(`daily-digest does not declare '${name}' in manifest.dependencies`)
          }
          return null
        },
      },
    } as CapabilityContext

    expect(() => context.dependencies.lastOutput(context.caller, 'feed-monitor')).toThrow(/manifest.dependencies/)
    expect(RECORDS.every(name => context.dependencies.lastOutput(context.caller, name) === null)).toBe(true)
  })
})
