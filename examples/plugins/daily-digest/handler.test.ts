import { describe, test, expect } from 'bun:test'
import type { CapabilityContext, DependenciesHandle } from 'warpline/unstable-capabilities'
import { OutputRecordSchema, type OutputRecord } from 'warpline/schemas/skill-result'
import { handler } from './handler.js'
import { manifest } from './manifest.js'

/**
 * The fourth parameter, carrying the two members this handler reads.
 *
 * A hand-written literal and not the runtime's mint: an example may import
 * only the three `warpline/unstable-*` specifiers, so `src/` is out of reach
 * from here on purpose. What that costs is stated rather than hidden — this
 * file proves the HANDLER folds each combination of upstream states into the
 * right digest, and the runtime's DELIVERY of those records is proven under
 * `src/`.
 *
 * Both members throw for any name this plugin does not declare, mirroring the
 * runtime's shared refusal, so the handler is never written against a `null` it
 * would not receive.
 *
 * A source with a record and no stated status models a producer that
 * succeeded; a source with neither models one that has never run. Every case
 * that means something else states its status.
 */
const RECORDS = ['anomaly-watch', 'github-poll'] as const

type Dependency = (typeof RECORDS)[number]
/** The closed status vocabulary, named through the published handle type. */
type RunStatus = ReturnType<DependenciesHandle['lastRun']>

function contextWith(
  records: Partial<Record<Dependency, OutputRecord | null>>,
  runs: Partial<Record<Dependency, RunStatus>> = {},
): CapabilityContext {
  const declared = (name: string): name is Dependency => {
    if (name !== 'anomaly-watch' && name !== 'github-poll') {
      throw new Error(`daily-digest does not declare '${name}' in manifest.dependencies`)
    }
    return true
  }
  return {
    caller: { plugin: 'daily-digest' },
    secrets: { resolvedNames: () => [] },
    dependencies: {
      lastOutput: (_caller: unknown, name: string) => (declared(name) ? records[name] ?? null : null),
      // `name in runs`, not `runs[name] ?? …`: a case stating `null` on purpose
      // means it, and `??` would silently promote that to the default instead.
      lastRun: (_caller: unknown, name: string) =>
        declared(name) ? (name in runs ? runs[name] ?? null : records[name] ? 'success' : null) : null,
    },
  } as CapabilityContext
}

function invoke(
  records: Partial<Record<Dependency, OutputRecord | null>>,
  runs: Partial<Record<Dependency, RunStatus>> = {},
) {
  return handler(manifest, {}, new AbortController().signal, contextWith(records, runs))
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
    // nothing is named, AND the state it is in is named — a source that has
    // never run is a different thing to chase from one that runs and returns
    // nothing, so the digest no longer answers both with one word.
    expect(result.status).toBe('success')
    expect(result.summary).toContain('2 breached')
    expect(result.summary).toContain('github-poll: no data from it yet')
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

  test('a record whose body is not JSON reads as produced-nothing-usable for that source, never as a failed run', async () => {
    // A body is a string another plugin authored. The parse is caught and the
    // per-source shape guard reads the result as "that source has nothing
    // usable", because a throw out of a handler is a failed run with no
    // structure — and one unparseable upstream must not lose the other one.
    const result = await invoke({
      'anomaly-watch': { type: 'anomalies', format: 'json', body: 'not json' },
      'github-poll': ISSUES,
    })

    expect(result.status).toBe('success')
    // The source HAS run — the fixture handed over a record — so the line says
    // so and names what the digest could not use it for. That conflation with
    // a shape-guard rejection is honest at this tier: either way there is no
    // line to write from the record.
    expect(result.summary).toContain('anomaly-watch: has run and produced nothing this digest can use')
    expect(result.summary).toContain('7 open issues')
  })

  test('a record in a shape this digest does not read is produced-nothing-usable for that source alone', async () => {
    const result = await invoke({
      'anomaly-watch': ANOMALIES,
      'github-poll': outputOf('issues-snapshot', { unexpected: true }),
    })

    expect(result.status).toBe('success')
    expect(result.summary).toContain('2 breached')
    expect(result.summary).toContain('github-poll: has run and produced nothing this digest can use')
  })

  test('a dependency this plugin does not declare throws rather than reading null', async () => {
    const context = contextWith({})

    expect(() => context.dependencies.lastOutput(context.caller, 'feed-monitor')).toThrow(/manifest.dependencies/)
    // Per member, because the obligation is: an arm asserting only the first
    // stays green over a second member that answers for anything asked of it.
    expect(() => context.dependencies.lastRun(context.caller, 'feed-monitor')).toThrow(/manifest.dependencies/)
    expect(RECORDS.every(name => context.dependencies.lastOutput(context.caller, name) === null)).toBe(true)
    expect(RECORDS.every(name => context.dependencies.lastRun(context.caller, name) === null)).toBe(true)
  })
})

/**
 * The four states each source can be in, and the one sentence that used to
 * cover three of them.
 *
 * This digest publishes an Output, so its wording is not a log line: the
 * per-source lines are joined into `digest.digest`, which becomes this
 * plugin's own `last_output` and travels to whatever reads it next. That is
 * where the claim "nothing yet" about a source that produced last week did its
 * damage, and it is where every assertion below looks — the PUBLISHED BODY,
 * read back out of `artifacts_produced`. An assertion on the summary alone
 * would let the body keep the false claim and stay green.
 */
describe('daily-digest names the state each source is in', () => {
  /** The two per-source lines, read back out of the published Output. */
  function publishedLines(artifacts: readonly unknown[] | undefined): string[] {
    const output = OutputRecordSchema.parse(artifacts?.at(-1))
    return (JSON.parse(output.body!) as { digest: string }).digest.split('; ')
  }

  test('both sources never run: each is named, and neither is claimed to have produced nothing', async () => {
    const result = await invoke({})

    expect(result.status).toBe('success')
    expect(result.summary).toContain('anomaly-watch: no data from it yet')
    expect(result.summary).toContain('github-poll: no data from it yet')
    // The early return used to answer for both at once. Two sources can be in
    // two different states, so it reports each by name.
    expect(result.summary).not.toContain('neither dependency has produced anything')
    // The arm's refusals are unchanged: no Output from a digest with nothing
    // to digest, and never a bare `skipped`.
    expect(result.artifacts_produced ?? []).toHaveLength(0)
    expect(result.status).not.toBe('skipped')
  })

  test('never-run and ran-and-produced-nothing are two different sentences', async () => {
    const result = await invoke({}, { 'github-poll': 'success' })

    expect(result.summary).toContain('anomaly-watch: no data from it yet')
    expect(result.summary).toContain('github-poll: has run and produced nothing this digest can use')
    expect(result.artifacts_produced ?? []).toHaveLength(0)
  })

  test('a record preserved across a failed run is marked stale IN THE PUBLISHED BODY, and its healthy neighbour is not', async () => {
    const result = await invoke({ 'anomaly-watch': ANOMALIES, 'github-poll': ISSUES }, { 'anomaly-watch': 'failed' })

    const [anomalyLine, issuesLine] = publishedLines(result.artifacts_produced)
    // The record IS still described — it is real work that was really
    // produced — and it is described as older than the run that followed it.
    expect(anomalyLine).toContain('2 breached')
    expect(anomalyLine).toContain('its latest run failed')
    // The negative control: the marker is not a decoration every line wears.
    expect(issuesLine).toContain('7 open issues')
    expect(issuesLine).not.toContain('its latest run failed')
    // Same lines, so the summary cannot describe a state the body does not.
    expect(result.summary).toContain('its latest run failed')
  })

  test('the raw upstream records under `sources` are untouched by the marker', async () => {
    const result = await invoke({ 'anomaly-watch': ANOMALIES, 'github-poll': ISSUES }, { 'anomaly-watch': 'failed' })

    const output = OutputRecordSchema.parse(result.artifacts_produced?.at(-1))
    const body = JSON.parse(output.body!) as { sources: Record<string, { anomalies?: unknown[]; open_count?: number }> }
    // A consumer that wants the facts reads `sources`; the line is the
    // sentence an operator reads. The marker belongs to the second only.
    expect(body.sources['anomaly-watch']?.anomalies).toHaveLength(2)
    expect(body.sources['github-poll']?.open_count).toBe(7)
    expect(JSON.stringify(body.sources)).not.toContain('its latest run failed')
  })

  test('a source parked at a gate keeps its record and is not called stale', async () => {
    const result = await invoke({ 'anomaly-watch': ANOMALIES, 'github-poll': ISSUES }, { 'anomaly-watch': 'gated' })

    const [anomalyLine] = publishedLines(result.artifacts_produced)
    // A supervised producer waiting for an approval has not failed, and the
    // record it produced is the current one.
    expect(anomalyLine).toContain('2 breached')
    expect(anomalyLine).not.toContain('its latest run failed')
  })
})
