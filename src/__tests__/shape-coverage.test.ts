/**
 * Every bundled example declares which recurring shape it demonstrates, and
 * proves it by doing the shape's defining act.
 *
 * The registry is test-side, not a manifest field: the manifest is the one
 * contract surface the pre-1.0 stability promise covers, and a number only a
 * test reads has no business there. An example added without an entry here
 * fails by omission, and the failure names the directory.
 *
 * The assertion is over the ACT, never the label. A plugin may say it diffs
 * against history; this file runs it twice in one home and checks that the
 * second run read what the first wrote. Coverage by declaration is what let
 * the tree carry six examples and one demonstrated shape for a year.
 *
 * Why this lives under `src/__tests__/` and not `examples/`: an act needs a
 * controlled home, the handlers import `warpline/lib/paths` through the
 * exports map into `dist/`, and `import-direction.test.ts` refuses any reach
 * from `examples/` into `src/`. The home is swapped through the env var,
 * because that is the seam the `dist/` copy of `paths.ts` actually reads —
 * `_setHome` from `src/lib/paths.js` mutates a different module instance and
 * was measured not to reach a handler (a run under it wrote into the preload's
 * home, not the swapped one).
 *
 * No act reaches the network. The examples that make outbound requests are
 * each run under a stub of `globalThis.fetch`, restored in the same
 * `finally` — the mechanism their own `handler.test.ts` files use.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mintContext, type CapabilityContext } from '../runtime/capabilities.js'
import { SkillResultSchema } from '../schemas/skill-result.js'
import { snapshotHome } from '../runtime/__tests__/helpers/snapshot-home.js'
import { handler as announceFanout } from '../../examples/plugins/announce-fanout/handler.js'
import { manifest as announceFanoutManifest } from '../../examples/plugins/announce-fanout/manifest.js'
import { handler as anomalyIssue } from '../../examples/plugins/anomaly-issue/handler.js'
import { manifest as anomalyIssueManifest } from '../../examples/plugins/anomaly-issue/manifest.js'
import { handler as anomalyWatch } from '../../examples/plugins/anomaly-watch/handler.js'
import { manifest as anomalyWatchManifest } from '../../examples/plugins/anomaly-watch/manifest.js'
import { handler as cadencePlan } from '../../examples/plugins/cadence-plan/handler.js'
import { manifest as cadencePlanManifest } from '../../examples/plugins/cadence-plan/manifest.js'
import { handler as cadenceReplies } from '../../examples/plugins/cadence-replies/handler.js'
import { manifest as cadenceRepliesManifest } from '../../examples/plugins/cadence-replies/manifest.js'
import { handler as cadenceSend } from '../../examples/plugins/cadence-send/handler.js'
import { manifest as cadenceSendManifest } from '../../examples/plugins/cadence-send/manifest.js'
import { handler as candidatePromote } from '../../examples/plugins/candidate-promote/handler.js'
import { manifest as candidatePromoteManifest } from '../../examples/plugins/candidate-promote/manifest.js'
import { handler as candidatePropose } from '../../examples/plugins/candidate-propose/handler.js'
import { manifest as candidateProposeManifest } from '../../examples/plugins/candidate-propose/manifest.js'
import { handler as changeWatch } from '../../examples/plugins/change-watch/handler.js'
import { manifest as changeWatchManifest } from '../../examples/plugins/change-watch/manifest.js'
import { handler as dailyDigest } from '../../examples/plugins/daily-digest/handler.js'
import { manifest as dailyDigestManifest } from '../../examples/plugins/daily-digest/manifest.js'
import { handler as derivedSummary } from '../../examples/plugins/derived-summary/handler.js'
import { manifest as derivedSummaryManifest } from '../../examples/plugins/derived-summary/manifest.js'
import { handler as draftWriter } from '../../examples/plugins/draft-writer/handler.js'
import { manifest as draftWriterManifest } from '../../examples/plugins/draft-writer/manifest.js'
import { handler as feedMonitor } from '../../examples/plugins/feed-monitor/handler.js'
import { manifest as feedMonitorManifest } from '../../examples/plugins/feed-monitor/manifest.js'
import { handler as feedTriage } from '../../examples/plugins/feed-triage/handler.js'
import { manifest as feedTriageManifest } from '../../examples/plugins/feed-triage/manifest.js'
import { handler as githubPoll } from '../../examples/plugins/github-poll/handler.js'
import { manifest as githubPollManifest } from '../../examples/plugins/github-poll/manifest.js'
import { handler as graphSync } from '../../examples/plugins/graph-sync/handler.js'
import { manifest as graphSyncManifest } from '../../examples/plugins/graph-sync/manifest.js'
import { handler as ledgerRunner } from '../../examples/plugins/ledger-runner/handler.js'
import { manifest as ledgerRunnerManifest } from '../../examples/plugins/ledger-runner/manifest.js'
import { handler as linkEnrich } from '../../examples/plugins/link-enrich/handler.js'
import { manifest as linkEnrichManifest } from '../../examples/plugins/link-enrich/manifest.js'
import { handler as metricsRollup } from '../../examples/plugins/metrics-rollup/handler.js'
import { manifest as metricsRollupManifest } from '../../examples/plugins/metrics-rollup/manifest.js'
import { handler as noteIntake } from '../../examples/plugins/note-intake/handler.js'
import { manifest as noteIntakeManifest } from '../../examples/plugins/note-intake/manifest.js'
import { handler as searchConsole } from '../../examples/plugins/search-console/handler.js'
import { manifest as searchConsoleManifest } from '../../examples/plugins/search-console/manifest.js'

const EXAMPLES = join(import.meta.dir, '..', '..', 'examples', 'plugins')

type Shape = 1 | 2 | 3 | 4 | 5 | 6 | 7

interface ShapeEntry {
  readonly shape: Shape
  /** The directory under examples/plugins. */
  readonly example: string
  /**
   * Set when the act proves only part of the shape. A partial entry keeps the
   * directory registered and its act honest, and does NOT discharge its shape:
   * the completeness assertion owed at the bottom of this file must not count
   * it as covering the number it carries.
   */
  readonly partial?: string
  /** Runs the real handler in `home` and returns true only if the defining act happened. */
  readonly act: (home: string) => Promise<boolean>
}

// ── Act plumbing ─────────────────────────────────────────────────────────

/**
 * The handler is four-parameter. This constant serves the acts whose handlers
 * read no member: the cast satisfies the compiler and produces an empty object
 * at run time, which is enough right up until something dereferences a member.
 * The acts whose handlers DO reach one build a real context through
 * `mintContext` instead, inside the act — see `daily-digest` and
 * `anomaly-issue` below. Both still pass this constant to the PRODUCERS they
 * run first, which read no member either.
 */
const CONTEXT = {} as CapabilityContext
const signal = () => new AbortController().signal

/** Write a fixture under the home, creating the parent: a string as text, anything else as JSON. */
function seed(home: string, rel: string, value: unknown): void {
  mkdirSync(join(home, rel, '..'), { recursive: true })
  writeFileSync(join(home, rel), typeof value === 'string' ? value : JSON.stringify(value))
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

/** Swap `globalThis.fetch` for the duration of `fn`; restore whatever happens. */
async function withFetch<T>(impl: (input: unknown, init?: RequestInit) => Promise<unknown>, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch
  globalThis.fetch = impl as unknown as typeof fetch
  try {
    return await fn()
  } finally {
    globalThis.fetch = real
  }
}

/** Set one env var for the duration of `fn`; restore whatever happens. */
async function withEnv<T>(name: string, value: string, fn: () => Promise<T>): Promise<T> {
  const real = process.env[name]
  process.env[name] = value
  try {
    return await fn()
  } finally {
    if (real === undefined) delete process.env[name]
    else process.env[name] = real
  }
}

/** Several env vars at once, each restored by its own `withEnv`. */
function withEnvs<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  return Object.entries(vars).reduceRight<() => Promise<T>>(
    (inner, [name, value]) => () => withEnv(name, value, inner),
    fn,
  )()
}

/**
 * A fresh temp home for one act: created, exported as `WARPLINE_HOME`, and
 * removed in the `finally` along with everything the handler wrote there.
 * Nothing an act does lands outside it.
 */
async function inFreshHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'warpline-shape-'))
  try {
    return await withEnv('WARPLINE_HOME', home, () => fn(home))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

// ── The registry ─────────────────────────────────────────────────────────

/** Fixtures, all placeholder-shaped; none of them is anyone's real value. */
const REPO = 'example-owner/example-repo'
const ISSUES = [
  { number: 12, title: 'newest', labels: [{ name: 'bug' }] },
  { number: 11, title: 'older', labels: [] },
]
const RSS = '<rss><channel><item><title>First</title><link>https://feeds.example.test/1</link></item></channel></rss>'
const METRICS = { series: [{ name: 'errors', latest: 42, threshold: 10, direction: 'above' }] }
const ISSUE_URL = `https://github.com/${REPO}/issues/1`

const okJson = (body: unknown) => async () => ({ ok: true, status: 201, json: async () => body })
const okText = (body: string) => async () => ({ ok: true, status: 200, text: async () => body })
/**
 * The last Output's inline body, read as JSON. Parsed at the boundary the
 * engine parses at, and `undefined` when there is no Output or it carries a
 * path, so an act narrows on it before it reads a field.
 */
function lastBody<T>(result: unknown): T | undefined {
  const record = lastRecord(result)
  return record?.body === undefined ? undefined : JSON.parse(record.body) as T
}
/**
 * The last Output record, parsed at the boundary the engine parses at:
 * `artifacts_produced` also admits a bare string, which normalises to a path
 * Output there. `undefined` when there is none, which is also the narrowing a
 * `mintContext` call needs before it can deliver the record.
 */
function lastRecord(result: unknown) {
  return SkillResultSchema.parse(result).artifacts_produced.at(-1)
}
/** A date `days` ago as YYYY-MM-DD, in UTC. */
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)

/**
 * The cadence fixtures at their manifests' default paths: three contacts
 * enrolled three days ago, one step due on enrolment, and `c-2` has replied.
 */
function seedCadence(home: string): void {
  const enrolled_at = new Date(Date.now() - 3 * 86_400_000).toISOString()
  seed(home, 'state/replies.json', { replies: [{ contact_id: 'c-2' }] })
  seed(home, 'state/contacts.json', {
    contacts: [1, 2, 3].map((n) => ({ id: `c-${n}`, email: `c-${n}@example.com`, enrolled_at })),
  })
  seed(home, 'state/steps.json', { steps: [{ offset_days: 0, subject: 'Hello', body: 'Registry note' }] })
}

/**
 * cadence-replies run for real, its record minted into cadence-plan's
 * context, and cadence-plan run for real on it. `undefined` when the producer
 * returned no Output, so a consumer act cannot run on nothing.
 */
async function runCadencePlan() {
  const replied = lastRecord(await cadenceReplies(cadenceRepliesManifest, {}, signal(), CONTEXT))
  if (replied === undefined) return undefined
  const context = mintContext(
    {
      manifest: cadencePlanManifest,
      dependencyRuns: { 'cadence-replies': { status: 'success', last_output: replied } },
    },
    { granted: false, reason: 'manual-run' },
  ).context
  return cadencePlan(cadencePlanManifest, {}, signal(), context)
}

/** Ten candidates, `cand-01`..`cand-10`, each scored by its number. */
const POOL = {
  candidates: Array.from({ length: 10 }, (_, i) => ({
    id: `cand-${String(i + 1).padStart(2, '0')}`,
    title: `Example candidate ${i + 1}`,
    score: i + 1,
  })),
}

const REGISTRY: readonly ShapeEntry[] = [
  {
    shape: 1,
    example: 'github-poll',
    // Polls, and leaves a snapshot of what it saw under the home.
    act: async (home) => {
      const result = await withFetch(okJson(ISSUES), () => githubPoll(githubPollManifest, { repo: REPO }, signal(), CONTEXT))
      return result.status === 'success' && existsSync(join(home, 'state', 'github-poll.last.json'))
    },
  },
  {
    shape: 1,
    example: 'feed-monitor',
    partial: 'polls a feed, persists what it found and publishes a path Output naming it, but never reads that file back — the diff against the last run is what shape 1 turns on, and github-poll carries it',
    act: async (home) => {
      const result = await withFetch(okText(RSS), () =>
        feedMonitor(feedMonitorManifest, { feed_url: 'https://feeds.example.test/feed.xml' }, signal(), CONTEXT))
      // Parsed at the boundary the engine parses at: `artifacts_produced` also
      // admits a bare string, which normalises to a path Output there and
      // never reaches `last_output` in the handler's own shape.
      const [output] = SkillResultSchema.parse(result).artifacts_produced
      if (result.status !== 'success' || output?.path === undefined || output.body !== undefined) return false
      const written = readJson<{ new_entries: { title: string }[] }>(join(home, 'state', 'feed-monitor.entries.json'))
      return output.path === join(home, 'state', 'feed-monitor.entries.json')
        && written.new_entries.map((e) => e.title).includes('First')
    },
  },
  {
    shape: 2,
    example: 'anomaly-watch',
    // Twice in ONE home: the second run reads the observation the first wrote,
    // and says so by quoting its timestamp. A handler that stopped looking
    // back makes this false.
    act: async (home) => {
      seed(home, 'state/metrics.json', METRICS)
      const first = await anomalyWatch(anomalyWatchManifest, {}, signal(), CONTEXT)
      const prior = readJson<{ observed_at: string }>(join(home, 'state', 'anomaly-watch.last.json'))
      const second = await anomalyWatch(anomalyWatchManifest, {}, signal(), CONTEXT)
      return second.summary !== first.summary && second.summary.includes(prior.observed_at)
    },
  },
  {
    shape: 2,
    example: 'change-watch',
    // Twice in ONE home, the page growing a line in between. The first run
    // keeps a snapshot; the second compares against it and reports the new
    // line as a diff. A handler that stopped reading its snapshot back would
    // call the target `new` again, and this is false.
    act: async (home) => {
      const pages = ['first line', 'first line\nsecond line']
      let served = 0
      const run = () => withFetch(async () => okText(pages[served++] ?? '')(), () =>
        changeWatch(changeWatchManifest, { targets: ['https://watch.example.test/one'] }, signal(), CONTEXT))
      const first = await run()
      const kept = existsSync(join(home, 'state', 'change-watch.last.json'))
      const second = await run()
      const report = lastBody<{ targets: { status: string; diff?: string[] }[] }>(second)
      if (report === undefined) return false
      return first.status === 'success' && kept && second.status === 'success'
        && report.targets[0]?.status === 'changed' && (report.targets[0].diff ?? []).includes('+ second line')
    },
  },
  {
    shape: 3,
    example: 'metrics-rollup',
    partial: 'aggregates rows it retained itself, not a declared dependency\'s Output — the digest example carries the full act',
    // A row older than the retention window is folded into a weekly rollup.
    act: async (home) => {
      seed(home, 'state/metrics.json', { series: [{ name: 'errors', latest: 4 }] })
      seed(home, 'state/metrics-rollup.json', { rows: [{ date: daysAgo(100), name: 'errors', value: 1 }], rollups: [] })
      const result = await metricsRollup(metricsRollupManifest, {}, signal(), CONTEXT)
      const state = readJson<{ rows: unknown[]; rollups: unknown[] }>(join(home, 'state', 'metrics-rollup.json'))
      return result.status === 'success' && state.rollups.length > 0 && state.rows.length === 1
    },
  },
  {
    shape: 3,
    example: 'daily-digest',
    // Aggregation over two declared dependencies, end to end: BOTH producers
    // run for real, each given the input it actually needs, and the digest is
    // built from the Output records they returned rather than from files this
    // test wrote. Seeding those two bodies by hand was the shortcut this act
    // used to take, and it proved the fold while assuming the delivery.
    //
    // `state/metrics.json` is anomaly-watch's own INPUT, not anyone's Output —
    // bare, that producer finds no metrics, takes its no-data arm and returns
    // nothing for the digest to name. github-poll needs both its `repo` input
    // and a stubbed fetch for the same reason, which is why this act borrows
    // the github-poll act's exact call shape.
    act: async (home) => {
      seed(home, 'state/metrics.json', METRICS)
      // Parsed at the boundary the engine parses at: `artifacts_produced` also
      // admits a bare string, which normalises to a path Output there and never
      // reaches `last_output` in either handler's own shape.
      const watched = SkillResultSchema.parse(await anomalyWatch(anomalyWatchManifest, {}, signal(), CONTEXT))
      const polled = SkillResultSchema.parse(
        await withFetch(okJson(ISSUES), () => githubPoll(githubPollManifest, { repo: REPO }, signal(), CONTEXT)))
      const anomaliesRecord = watched.artifacts_produced.at(-1)
      const issuesRecord = polled.artifacts_produced.at(-1)
      // Asserted, not assumed — and it is the narrowing too: `undefined` is not
      // assignable to the option's value type, so an act that skips this check
      // does not compile.
      if (anomaliesRecord === undefined || issuesRecord === undefined) return false
      // The records the runtime would deliver, delivered by the runtime's own
      // mint. This file may reach `src/`; an example test may not.
      const context = mintContext(
        {
          manifest: dailyDigestManifest,
          // The two-field shape the engine projects: what each dependency last
          // produced, and how its last run ended. Both producers just ran here
          // and both succeeded, so `success` is the honest status for each.
          dependencyRuns: {
            'anomaly-watch': { status: 'success', last_output: anomaliesRecord },
            'github-poll': { status: 'success', last_output: issuesRecord },
          },
        },
        { granted: false, reason: 'manual-run' },
      ).context
      const result = await dailyDigest(dailyDigestManifest, {}, signal(), context)
      return result.status === 'success'
        && result.summary.includes('anomaly-watch') && result.summary.includes('github-poll')
        && (result.artifacts_produced?.length ?? 0) === 1
    },
  },
  {
    shape: 3,
    example: 'cadence-plan',
    // Built from a declared dependency's Output, delivered by the runtime's own
    // mint: cadence-replies runs first and for real, and its record is the only
    // way the plan learns who replied. True only if the replier is stopped and
    // turned into a review task, and the other two get their due step. A plan
    // that ignored the reply list would queue c-2 too, and this is false.
    act: async (home) => {
      seedCadence(home)
      const result = await runCadencePlan()
      if (result === undefined || result.status !== 'success') return false
      const plan = lastBody<{ outbox: { id: string }[]; review_tasks: { contact_id: string }[] }>(result)
      if (plan === undefined) return false
      return plan.outbox.map((e) => e.id).join(',') === 'c-1:1,c-3:1'
        && plan.review_tasks.map((t) => t.contact_id).join(',') === 'c-2'
    },
  },
  {
    shape: 3,
    example: 'cadence-send',
    // The chain end to end: cadence-replies and cadence-plan run for real,
    // each record minted into the next, and cadence-send is minted under the
    // content witness, the arm an operator's `approve --content` produces.
    // True only if the stub saw one send per email in the outbox, and the
    // ledger marks each one. A sender that read anything but the approved
    // outbox, or skipped the ledger, makes this false.
    act: async (home) => {
      seedCadence(home)
      const planned = await runCadencePlan()
      const record = planned === undefined ? undefined : lastRecord(planned)
      if (record?.body === undefined) return false
      const emails = (JSON.parse(record.body) as { outbox: unknown[] }).outbox.length
      const context = mintContext(
        {
          manifest: cadenceSendManifest,
          dependencyRuns: { 'cadence-plan': { status: 'success', last_output: record } },
        },
        { granted: true, via: 'content-approval', fingerprint: 'act-fingerprint', effectId: 'act-effect' },
      ).context
      let calls = 0
      const accepted = async () => {
        calls += 1
        return { ok: true, status: 202 }
      }
      const result = await withEnv('CADENCE_MAIL_TOKEN', 'placeholder-token', () =>
        withFetch(accepted, () => cadenceSend(cadenceSendManifest, {}, signal(), context)))
      if (result.status !== 'success') return false
      const ledger = readJson<{ sent: unknown[] }>(join(home, 'state', 'cadence-send.sent.json'))
      return emails === 2 && calls === emails && ledger.sent.length === emails
    },
  },
  {
    shape: 3,
    example: 'candidate-promote',
    // The proposal candidate-propose returned, run for real and minted under
    // the content witness, is exactly what lands in the promoted file, in
    // proposal order. A promoter that read the pool itself, or appended
    // nothing, makes this false.
    act: async (home) => {
      seed(home, 'state/candidates.json', POOL)
      const record = lastRecord(await candidatePropose(candidateProposeManifest, {}, signal(), CONTEXT))
      if (record?.body === undefined) return false
      const proposed = (JSON.parse(record.body) as { candidates: { id: string }[] }).candidates.map((c) => c.id)
      const context = mintContext(
        {
          manifest: candidatePromoteManifest,
          dependencyRuns: { 'candidate-propose': { status: 'success', last_output: record } },
        },
        { granted: true, via: 'content-approval', fingerprint: 'act-fingerprint', effectId: 'act-effect' },
      ).context
      const result = await candidatePromote(candidatePromoteManifest, {}, signal(), context)
      if (result.status !== 'success') return false
      const promoted = readJson<{ promoted: { id: string }[] }>(join(home, 'state', 'promoted.json'))
      return proposed.length === 3 && promoted.promoted.map((c) => c.id).join(',') === proposed.join(',')
    },
  },
  {
    shape: 5,
    example: 'derived-summary',
    // Derives its answer from a source already under the home and keeps
    // NOTHING: a success, and a whole-home snapshot identical before and
    // after. A handler that merely returned something would pass over a
    // plugin that stored everything, which is the failure this act refuses.
    act: async (home) => {
      seed(home, 'state/metrics.json', METRICS)
      const before = await snapshotHome(home)
      const result = await derivedSummary(derivedSummaryManifest, {}, signal(), CONTEXT)
      const after = await snapshotHome(home)
      return result.status === 'success' && after.join('\n') === before.join('\n')
    },
  },
  {
    shape: 5,
    example: 'search-console',
    // Derived from an API and kept nowhere: the manifest's own defaults
    // configure the run, the stubbed rows come back as the report, and the
    // home is byte-for-byte what it was. A handler that cached its answer
    // under the home would still report, and this is false.
    act: async (home) => {
      const rows = { rows: [{ key: 'example query', clicks: 3, impressions: 9 }] }
      const before = await snapshotHome(home)
      const result = await withEnv('SEARCH_CONSOLE_TOKEN', 'placeholder-token', () =>
        withFetch(okJson(rows), () => searchConsole(searchConsoleManifest, {}, signal(), CONTEXT)))
      const after = await snapshotHome(home)
      const report = lastBody<{ queries: { key: string }[] }>(result)
      if (report === undefined) return false
      return result.status === 'success' && report.queries[0]?.key === 'example query'
        && after.join('\n') === before.join('\n')
    },
  },
  {
    shape: 5,
    example: 'cadence-replies',
    // Derived from a file already under the home and kept nowhere: the reply
    // list comes back as the Output and the home is byte-for-byte what it was.
    // A stub that cached what it read would still report, and this is false.
    act: async (home) => {
      seed(home, 'state/replies.json', { replies: [{ contact_id: 'c-2' }] })
      const before = await snapshotHome(home)
      const result = await cadenceReplies(cadenceRepliesManifest, {}, signal(), CONTEXT)
      const after = await snapshotHome(home)
      const report = lastBody<{ replied: string[] }>(result)
      if (report === undefined) return false
      return result.status === 'success' && report.replied.join(',') === 'c-2'
        && after.join('\n') === before.join('\n')
    },
  },
  {
    shape: 5,
    example: 'candidate-propose',
    // Ten in the pool, three out, nothing kept: the proposal is capped and the
    // home is byte-for-byte what it was. A proposer that kept a history of
    // what it proposed, or flooded past the cap, makes this false.
    act: async (home) => {
      seed(home, 'state/candidates.json', POOL)
      const before = await snapshotHome(home)
      const result = await candidatePropose(candidateProposeManifest, {}, signal(), CONTEXT)
      const after = await snapshotHome(home)
      const proposal = lastBody<{ candidates: unknown[] }>(result)
      if (proposal === undefined) return false
      return result.status === 'success' && proposal.candidates.length === 3
        && after.join('\n') === before.join('\n')
    },
  },
  {
    shape: 4,
    example: 'feed-triage',
    // The structured arm proves the builder wrote the handoff; the prefix is
    // what the shipped scanner reads.
    //
    // The producer runs FIRST, and for real. Seeding a file for the consumer
    // to read was the shortcut this act used to take, and it proved the
    // handoff while assuming the delivery — over a path the consumer computed
    // itself, from an input nothing produced. `feed-monitor` fetches, over the
    // global fetch with no injection seam, so the response is stubbed with the
    // helpers already here; that is the github-poll act's call shape, borrowed
    // the same way the daily-digest act borrows it.
    act: async () => {
      // Parsed at the boundary the engine parses at: `artifacts_produced` also
      // admits a bare string, which normalises to a path Output there and never
      // reaches `last_output` in the handler's own shape.
      const produced = SkillResultSchema.parse(await withFetch(okText(RSS), () =>
        feedMonitor(feedMonitorManifest, { feed_url: 'https://feeds.example.test/feed.xml' }, signal(), CONTEXT)))
      const record = produced.artifacts_produced.at(-1)
      // Asserted, not assumed — and it is the narrowing too: `undefined` is not
      // assignable to the option's value type, so an act that skips this check
      // does not compile.
      if (record === undefined) return false
      // The record the runtime would deliver, delivered by the runtime's own
      // mint. This file may reach `src/`; an example test may not — which is
      // why the plugin's own test hand-builds a context and this one does not,
      // and why both are kept: they prove different halves.
      const context = mintContext(
        {
          manifest: feedTriageManifest,
          dependencyRuns: { 'feed-monitor': { status: 'success', last_output: record } },
        },
        { granted: false, reason: 'manual-run' },
      ).context
      const result = await feedTriage(feedTriageManifest, {}, signal(), context)
      // The handoff arm, not the nothing-to-triage arm: a broken edge would
      // take the second one and still be a `success`, which is exactly the
      // quiet failure this act exists to refuse.
      return result.needs_llm !== undefined && result.summary.startsWith('[needs-llm]')
    },
  },
  {
    shape: 4,
    example: 'draft-writer',
    // The same act as feed-triage's, on the config-heavy subject: the three
    // reference files present at the manifest's own defaults (where a
    // `scaffold --from` copy puts them) and one topic configured. True only if
    // the structured arm is set, the summary carries the prefix, and it names
    // a context path. The shipped defaults alone (no topics) are a skip, so
    // the act has to configure the one thing the plugin will not invent.
    act: async (home) => {
      const defaultOf = (key: string) => draftWriterManifest.inputs[key]?.default as string
      seed(home, defaultOf('voice_rules_path'), '# Example voice rules for the registry act\n- an example rule\n')
      seed(home, defaultOf('blocklist_path'), { terms: ['example-term'] })
      seed(home, defaultOf('frontmatter_schema_path'), { fields: { title: 'string' } })
      const result = await draftWriter(draftWriterManifest, { topics: ['a registry topic'] }, signal(), CONTEXT)
      return result.needs_llm !== undefined && result.summary.startsWith('[needs-llm]') && result.summary.includes('Context: ')
    },
  },
  {
    shape: 4,
    example: 'announce-fanout',
    // A draft at the manifest's own default path, two invented channels and
    // a call to action for each. True only if the structured handoff arm is
    // set, the summary carries the prefix, AND it names each configured
    // channel. The shipped defaults (an empty list) are a skip with no
    // prefix, so running the handler bare cannot satisfy this: fanning out to
    // nobody is not a fan-out.
    act: async (home) => {
      seed(home, announceFanoutManifest.inputs.draft_path?.default as string, { title: 'A registry draft', body: 'Body' })
      const channels = ['registry-channel-one', 'registry-channel-two']
      const result = await announceFanout(
        announceFanoutManifest,
        { channels, calls_to_action: { 'registry-channel-one': 'An example call', 'registry-channel-two': 'Another example call' } },
        signal(),
        CONTEXT,
      )
      return result.needs_llm !== undefined && result.summary.startsWith('[needs-llm]')
        && channels.every((c) => result.summary.includes(c))
    },
  },
  {
    shape: 6,
    example: 'note-intake',
    // Operator text for ONE run, in the shape `--input note=<text>` delivers
    // (a string under the action positional), reaches the file it was
    // routed to. A handler that took the text and dropped it makes this false.
    act: async (home) => {
      const note = 'registry-act-note-7c1'
      const result = await noteIntake(noteIntakeManifest, { note, action: 'default' }, signal(), CONTEXT)
      const inbox = join(home, 'notes', 'note-intake')
      if (result.status !== 'success' || !existsSync(inbox)) return false
      return readdirSync(inbox).some((name) => readFileSync(join(inbox, name), 'utf8').includes(note))
    },
  },
  {
    shape: 7,
    example: 'link-enrich',
    // Three sources, ONE of them refusing: true only if the run is a
    // non-failure AND the summary names a contributing source and the
    // refused one. A handler that merely returned would be satisfied by a
    // loop with no isolation at all, which is the whole thing this shape
    // demonstrates.
    act: async (home) => {
      seed(home, 'state/links.json', { links: ['https://links.example.test/one'] })
      const urls = {
        metadata_url: 'https://metadata.example.test/lookup',
        preview_url: 'https://preview.example.test/lookup',
        reputation_url: 'https://reputation.example.test/lookup',
      }
      const perSource = async (url: unknown) =>
        String(url) === urls.reputation_url
          ? { ok: false, status: 503, json: async () => ({}) }
          : { ok: true, status: 200, json: async () => ({ 'https://links.example.test/one': { field: 'value' } }) }
      const result = await withEnvs(
        {
          LINK_ENRICH_METADATA_TOKEN: 'placeholder-token',
          LINK_ENRICH_PREVIEW_TOKEN: 'placeholder-token',
          LINK_ENRICH_REPUTATION_TOKEN: 'placeholder-token',
        },
        () => withFetch(perSource, () => linkEnrich(linkEnrichManifest, urls, signal(), CONTEXT)),
      )
      return result.status !== 'failed'
        && result.summary.includes('metadata') && result.summary.includes('refused') && result.summary.includes('reputation')
    },
  },
  {
    shape: 7,
    example: 'anomaly-issue',
    // The write-back case: one upstream source, one external system written
    // to, and a ledger so a retry never files twice. Registered under 7
    // because writing back is where a fan-in ends up, and kept partial
    // because the shape's defining act — several sources, each isolated — is
    // link-enrich's, above.
    partial: 'writes back to one external system from one source, with a ledger against duplicates; the fan-in act itself is link-enrich\'s',
    act: async (home) => {
      // The producer runs FIRST, and for real: bare, it finds no metrics, takes
      // its own no-data arm and produces no Output at all, and the consumer
      // would then take the "produced nothing" arm with everything else here
      // done right. `state/metrics.json` is the producer's own INPUT, not
      // anyone's Output — seeding it is not the seeding this act tore out.
      seed(home, 'state/metrics.json', METRICS)
      // Parsed at the boundary the engine parses at: `artifacts_produced` also
      // admits a bare string, which normalises to a path Output there and never
      // reaches `last_output` in the handler's own shape.
      const produced = SkillResultSchema.parse(await anomalyWatch(anomalyWatchManifest, {}, signal(), CONTEXT))
      const record = produced.artifacts_produced.at(-1)
      // Asserted, not assumed — and it is the narrowing too: `undefined` is not
      // assignable to the option's value type, so an act that skips this check
      // does not compile.
      if (record === undefined) return false
      // The record the runtime would deliver, delivered by the runtime's own
      // mint. This file may reach `src/`; an example test may not.
      const context = mintContext(
        {
          manifest: anomalyIssueManifest,
          dependencyRuns: { 'anomaly-watch': { status: 'success', last_output: record } },
        },
        { granted: false, reason: 'manual-run' },
      ).context
      const result = await withEnv('GITHUB_TOKEN', 'placeholder-token', () =>
        withFetch(okJson({ html_url: ISSUE_URL }), () => anomalyIssue(anomalyIssueManifest, { repo: REPO }, signal(), context)))
      const ledger = readJson<{ filed: Record<string, string> }>(join(home, 'state', 'anomaly-issue.filed.json'))
      return result.status === 'success' && ledger.filed.errors === ISSUE_URL
    },
  },
  {
    shape: 7,
    example: 'graph-sync',
    // Three records, the API refusing the second: true only if the run is a
    // success AND the counts say three tried, two landed, one failed. A loop
    // that let one refusal take the rest down, or failed the whole run over
    // it, makes this false.
    act: async (home) => {
      seed(home, 'state/records.json', { records: [{ id: 'r-1' }, { id: 'r-2' }, { id: 'r-3' }] })
      const perRecord = async (url: unknown) =>
        String(url).endsWith('/records/r-2') ? { ok: false, status: 500 } : { ok: true, status: 200 }
      const result = await withEnv('GRAPH_SYNC_TOKEN', 'placeholder-token', () =>
        withFetch(perRecord, () => graphSync(graphSyncManifest, {}, signal(), CONTEXT)))
      const report = lastBody<{ attempted: number; succeeded: number; failed: number }>(result)
      if (report === undefined) return false
      return result.status === 'success' && report.attempted === 3 && report.succeeded === 2 && report.failed === 1
    },
  },
  {
    shape: 7,
    example: 'ledger-runner',
    // Three instruments, the quote API refusing the middle one: true only if
    // the run is a success AND the ledger it wrote holds exactly the two that
    // answered. A handler that dropped the write, or wrote a value for the
    // refused one, makes this false.
    act: async (home) => {
      const perQuote = async (url: unknown) =>
        String(url).endsWith('/quotes/example-b')
          ? { ok: false, status: 500, json: async () => ({}) }
          : { ok: true, status: 200, json: async () => ({ value: 1 }) }
      const result = await withEnv('LEDGER_QUOTES_TOKEN', 'placeholder-token', () =>
        withFetch(perQuote, () =>
          ledgerRunner(ledgerRunnerManifest, { instruments: ['example-a', 'example-b', 'example-c'] }, signal(), CONTEXT)))
      if (result.status !== 'success') return false
      const ledger = readJson<{ values: Record<string, unknown> }>(join(home, 'state', 'ledger.json'))
      return Object.keys(ledger.values).sort().join(',') === 'example-a,example-c'
    },
  },
]

// ── The assertions ───────────────────────────────────────────────────────

const exampleDirs = () =>
  readdirSync(EXAMPLES, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()

/** Every act, each in its own fresh home; the example name beside its verdict so a red names the entry. */
async function performAll(): Promise<Map<string, boolean>> {
  const performed = new Map<string, boolean>()
  for (const entry of REGISTRY) performed.set(entry.example, await inFreshHome((home) => entry.act(home)))
  return performed
}

/**
 * The roster is closed at this number. One more directory is a deliberate edit
 * to it, with its registry entry beside it, never a silent drift.
 */
const EXAMPLE_COUNT = 21

describe('the shape registry', () => {
  test('at least three example directories exist, so an empty glob cannot pass the checks below', () => {
    expect(exampleDirs().length).toBeGreaterThanOrEqual(3)
  })

  test(`examples/plugins holds exactly ${EXAMPLE_COUNT} directories`, () => {
    expect(exampleDirs().length).toBe(EXAMPLE_COUNT)
  })

  test('every example directory appears in the registry', () => {
    // Over the NAMES, never a count: a red here has to say which directory
    // was added without declaring what it demonstrates.
    const registered = new Set(REGISTRY.map((e) => e.example))
    expect(exampleDirs().filter((dir) => !registered.has(dir))).toEqual([])
  })

  test('every registry entry names a directory that exists, once, with one shape in 1..7', () => {
    const dirs = new Set(exampleDirs())
    expect(REGISTRY.filter((e) => !dirs.has(e.example)).map((e) => e.example)).toEqual([])
    const names = REGISTRY.map((e) => e.example)
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([])
    expect(REGISTRY.filter((e) => !Number.isInteger(e.shape) || e.shape < 1 || e.shape > 7).map((e) => e.example)).toEqual([])
  })

  test('every registry entry performs its act in a fresh home', async () => {
    for (const [example, performed] of await performAll()) {
      // The example name in the assertion, so a red names the entry.
      expect({ example, performed }).toEqual({ example, performed: true })
    }
  })

  test('every shape from 1 to 7 is covered by an example whose act was performed', async () => {
    // Coverage, not distinctness: more examples than shapes means shapes are
    // shared, and a superset check is the right shape — an
    // equality on a sorted array would also go red on an unrelated shape 8.
    // Computed only from acts that returned TRUE and only over non-partial
    // entries, so neither a declared label nor a partial act can cover a
    // number. Shape 3 is covered by the half of the aggregate act a handler
    // can perform — several declared dependencies, ordered by the engine, one
    // aggregated Output — and not by reading a dependency's Output through a
    // runtime reader, which no handler is handed a way to do; its entry above
    // says so.
    const performed = await performAll()
    const covered = new Set(REGISTRY.filter((e) => !e.partial && performed.get(e.example) === true).map((e) => e.shape))
    const shapes: Shape[] = [1, 2, 3, 4, 5, 6, 7]
    expect(shapes.filter((s) => !covered.has(s))).toEqual([])
  })
})

// ── The surface every handler is written against ─────────────────────────
//
// Two assertions that used to live only in a plan's verify command. The
// specifier allowlist in import-direction.test.ts still admits
// `node:fs/promises`, because the example TEST files legitimately import it;
// this is the narrower rule for the handlers themselves.

describe('the example handlers', () => {
  const handlers = () => exampleDirs().map((dir) => ({ dir, source: readFileSync(join(EXAMPLES, dir, 'handler.ts'), 'utf8') }))

  test('at least one handler exists, so an empty glob cannot pass the checks below', () => {
    expect(handlers().length).toBeGreaterThanOrEqual(1)
  })

  test('no handler imports node:fs/promises', () => {
    expect(handlers().filter(({ source }) => source.includes('node:fs/promises')).map(({ dir }) => dir)).toEqual([])
  })

  test('every handler imports at least one warpline/unstable-* subpath', () => {
    expect(handlers().filter(({ source }) => !source.includes('warpline/unstable-')).map(({ dir }) => dir)).toEqual([])
  })
})
