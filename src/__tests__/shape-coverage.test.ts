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
 * No act reaches the network. Three examples make outbound requests, and each
 * act over one of them stubs `globalThis.fetch` and restores it in the same
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
import { handler as linkEnrich } from '../../examples/plugins/link-enrich/handler.js'
import { manifest as linkEnrichManifest } from '../../examples/plugins/link-enrich/manifest.js'
import { handler as metricsRollup } from '../../examples/plugins/metrics-rollup/handler.js'
import { manifest as metricsRollupManifest } from '../../examples/plugins/metrics-rollup/manifest.js'
import { handler as noteIntake } from '../../examples/plugins/note-intake/handler.js'
import { manifest as noteIntakeManifest } from '../../examples/plugins/note-intake/manifest.js'

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
 * `mintContext` instead, inside the act — see `anomaly-issue` below.
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
/** A date `days` ago as YYYY-MM-DD, in UTC. */
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)

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
    partial: 'polls a feed and reports what is new, but persists no snapshot — github-poll carries the full act',
    act: async () => {
      const result = await withFetch(okText(RSS), () =>
        feedMonitor(feedMonitorManifest, { feed_url: 'https://feeds.example.test/feed.xml' }, signal(), CONTEXT))
      return result.status === 'success' && result.summary.includes('First')
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
    // What is asserted: aggregation over two declared dependencies — both
    // upstream results present, one digest naming both, exactly one Output.
    // What is NOT asserted: reading a dependency's produced Output through a
    // runtime-supplied reader. No handler here is handed one, so the digest
    // reads the two files a chaining host drops under the home. This act seeds
    // those files; when the runtime hands a plugin a reader, the seeding here
    // becomes a run of the producers instead.
    act: async (home) => {
      seed(home, 'state/anomalies.json', { anomalies: METRICS.series })
      seed(home, 'state/github-issues.json', { observed_at: daysAgo(0), open_count: 2, newest_number: 12 })
      const result = await dailyDigest(dailyDigestManifest, {}, signal(), CONTEXT)
      return result.status === 'success'
        && result.summary.includes('anomaly-watch') && result.summary.includes('github-poll')
        && (result.artifacts_produced?.length ?? 0) === 1
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
    shape: 4,
    example: 'feed-triage',
    // The structured arm proves the builder wrote the handoff; the prefix is
    // what the shipped scanner reads.
    act: async (home) => {
      seed(home, 'state/feed-entries.json', { new_entries: [{ title: 'A post', link: 'https://feeds.example.test/a', published: null }] })
      const result = await feedTriage(feedTriageManifest, {}, signal(), CONTEXT)
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
        { manifest: anomalyIssueManifest, dependencyOutputs: { 'anomaly-watch': record } },
        { granted: false, reason: 'manual-run' },
      ).context
      const result = await withEnv('GITHUB_TOKEN', 'placeholder-token', () =>
        withFetch(okJson({ html_url: ISSUE_URL }), () => anomalyIssue(anomalyIssueManifest, { repo: REPO }, signal(), context)))
      const ledger = readJson<{ filed: Record<string, string> }>(join(home, 'state', 'anomaly-issue.filed.json'))
      return result.status === 'success' && ledger.filed.errors === ISSUE_URL
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
 * The roster is closed at twelve. A thirteenth directory is a deliberate edit
 * to this number, with its registry entry beside it, never a silent drift.
 */
const EXAMPLE_COUNT = 12

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
    // Coverage, not distinctness: twelve examples cannot carry seven distinct
    // ids, so shapes are shared and a superset check is the right shape — an
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
