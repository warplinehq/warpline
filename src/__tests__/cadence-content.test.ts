/**
 * END-TO-END: the cadence example sends only the outbox an operator approved.
 *
 * The three real example directories, `cadence-replies`, `cadence-plan` and
 * `cadence-send`, run through the real `runAdvance`, and the approval is given
 * through the real `approve --content` verb. Fixture plugins cannot stand in
 * here: what this file proves is that the shipped manifests declare the
 * content class correctly and that the shipped send handler ships exactly the
 * approved bytes, once per recipient.
 *
 * The negative half is evidence only beside the positive one. With no content
 * approval, `cadence-send` is skipped, the mail stub is never called and no
 * send ledger exists, even though `cadence-plan` ran and an outbox of five is
 * sitting in state. On its own that could mean the trio never wired up at all.
 * The positive half rules that out: after `approve --content` the same five
 * emails go out, one call each, in contact-id order, carrying the token.
 *
 * The retry is the third case. The stub fails the fourth call, so the run is
 * `partial` and the approval is spent. Re-approving the unchanged outbox and
 * advancing again sends exactly the two emails the ledger has not recorded.
 * That advance passes `force`: freshness is evaluated before approval, so
 * without it `cadence-send` is skipped as fresh inside its one-hour TTL and
 * the approval gate is never reached.
 *
 * Both home instances are re-rooted. The examples import `warpline/lib/paths`
 * through the package exports into `dist/`, while the engine and the approve
 * verb use `src/`. `_setHome` reaches only the second, so `WARPLINE_HOME` is
 * set for the first; without it the send ledger lands in the preload's home
 * and the assertions read the wrong directory.
 *
 * The three directories are symlinked, never copied: each manifest opens with
 * a `warpline/...` self-reference resolved from the file's real location.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runAdvance, type AdvanceOptions } from '../runtime/engine.js'
import { createTestHome, type TestHome } from '../runtime/__tests__/helpers/create-test-home.js'
import { _setHome } from '../lib/paths.js'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const EXAMPLES = ['cadence-replies', 'cadence-plan', 'cadence-send']

/** A wall clock far enough out that no test run reaches it. */
const FAR_FUTURE = '2099-01-01T00:00'
const TOKEN = 'cadence-content-token-8d1a'
/** cadence-send's shipped `api_base` default. */
const API_BASE = 'https://mail.example.com/v1'
const DAY_MS = 24 * 60 * 60 * 1000
const RECIPIENTS = [1, 2, 3, 4, 5].map((n) => `c-${n}@example.com`)

interface Call {
  url: string
  method: string | undefined
  authorization: string | undefined
  to: string
}

let ctx: TestHome
let savedHome: string | undefined
let savedToken: string | undefined
const realFetch = globalThis.fetch

beforeEach(async () => {
  ctx = await createTestHome()
  _setHome(ctx.root)
  savedHome = process.env.WARPLINE_HOME
  process.env.WARPLINE_HOME = ctx.root
  savedToken = process.env.CADENCE_MAIL_TOKEN
  process.env.CADENCE_MAIL_TOKEN = TOKEN
  for (const name of EXAMPLES) {
    symlinkSync(join(REPO_ROOT, 'examples', 'plugins', name), join(ctx.pluginsDir, name))
  }
  seed()
})

afterEach(async () => {
  globalThis.fetch = realFetch
  _setHome(null)
  if (savedHome === undefined) delete process.env.WARPLINE_HOME
  else process.env.WARPLINE_HOME = savedHome
  if (savedToken === undefined) delete process.env.CADENCE_MAIL_TOKEN
  else process.env.CADENCE_MAIL_TOKEN = savedToken
  await ctx.cleanup()
})

/** Five contacts enrolled three days ago, two steps, nobody replied. */
function seed(): void {
  const stateDir = join(ctx.root, 'state')
  mkdirSync(stateDir, { recursive: true })
  const enrolled = new Date(Date.now() - 3 * DAY_MS).toISOString()
  const contacts = RECIPIENTS.map((email, i) => ({ id: `c-${i + 1}`, email, enrolled_at: enrolled }))
  writeFileSync(join(stateDir, 'contacts.json'), JSON.stringify({ contacts }))
  writeFileSync(join(stateDir, 'steps.json'), JSON.stringify({
    steps: [
      { offset_days: 0, subject: 'Hello', body: 'First note' },
      { offset_days: 30, subject: 'Again', body: 'Second note' },
    ],
  }))
  writeFileSync(join(stateDir, 'replies.json'), JSON.stringify({ replies: [] }))
}

function advance(options: Pick<AdvanceOptions, 'force'> = {}) {
  return runAdvance({
    pluginsDir: ctx.pluginsDir,
    // Full path to the state document, despite the option's name.
    stateDir: join(ctx.stateDir, 'engine-state.json'),
    runsDir: ctx.runsDir,
    eventsPath: join(ctx.runsDir, 'events.jsonl'),
    approvalPath: join(ctx.root, '.session-approval'),
    ...options,
  })
}

/** `warpline approve cadence-send --content`, in-process, stdout captured. */
async function approveByContent(): Promise<string> {
  const realOut = process.stdout.write
  let stdout = ''
  process.stdout.write = ((chunk: string) => {
    stdout += chunk
    return true
  }) as typeof process.stdout.write
  try {
    const { run } = await import('../cli/approve.js')
    const code = await run(['cadence-send', '--content', '--not-after', FAR_FUTURE])
    expect(code).toBe(0)
  } finally {
    process.stdout.write = realOut
  }
  return stdout
}

/**
 * Swaps `globalThis.fetch` for a recorder; call number `failOn` answers 500.
 * With `delayMs`, every call answers that late and honours its abort signal,
 * the way a real fetch does.
 */
function mailStub(failOn?: number, delayMs = 0): Call[] {
  const calls: Call[] = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({
      url: String(input),
      method: init?.method,
      authorization: headers.authorization,
      to: (JSON.parse(String(init?.body)) as { to: string }).to,
    })
    const n = calls.length
    if (delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs)
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(new DOMException('The operation was aborted', 'AbortError'))
        }, { once: true })
      })
    }
    if (n === failOn) return { ok: false, status: 500 } as Response
    return { ok: true, status: 202, json: async () => ({}) } as unknown as Response
  }) as typeof fetch
  return calls
}

/**
 * Replaces the cadence-send symlink with a copy that re-exports the shipped
 * handler under the shipped manifest with a short `timeout_ms`, so a test can
 * reach the runtime's timeout without waiting a minute.
 */
function shortTimeoutSend(timeoutMs: number): void {
  const dir = join(ctx.pluginsDir, 'cadence-send')
  const shipped = join(REPO_ROOT, 'examples', 'plugins', 'cadence-send')
  unlinkSync(dir)
  mkdirSync(dir)
  writeFileSync(join(dir, 'handler.ts'), `export { handler } from ${JSON.stringify(join(shipped, 'handler.ts'))}\n`)
  writeFileSync(join(dir, 'manifest.ts'), [
    `import { manifest as shipped } from ${JSON.stringify(join(shipped, 'manifest.ts'))}`,
    `export const manifest = { ...shipped, timeout_ms: ${timeoutMs} }`,
    '',
  ].join('\n'))
}

interface PluginRun {
  status?: string
  last_output?: { body?: string }
}

function pluginRuns(): Record<string, PluginRun> {
  const state = JSON.parse(readFileSync(join(ctx.stateDir, 'engine-state.json'), 'utf-8')) as {
    plugin_runs: Record<string, PluginRun>
  }
  return state.plugin_runs
}

const ledgerPath = () => join(ctx.root, 'state', 'cadence-send.sent.json')

function ledger(): [string, string][] {
  return (JSON.parse(readFileSync(ledgerPath(), 'utf-8')) as { sent: [string, string][] }).sent
}

describe('the cadence example under runAdvance', () => {
  test('without a content approval cadence-send is not due and nothing is sent', async () => {
    const calls = mailStub()

    const result = await advance()

    expect(calls).toHaveLength(0)
    expect(result.plugin_states.get('cadence-send')).toBe('skipped')
    expect(existsSync(ledgerPath())).toBe(false)
    const runs = pluginRuns()
    expect(runs['cadence-replies']?.status).toBe('success')
    expect(runs['cadence-plan']?.status).toBe('success')
    const body = runs['cadence-plan']?.last_output?.body
    expect(typeof body).toBe('string')
    const outbox = (JSON.parse(body!) as { outbox: { to: string }[] }).outbox
    expect(outbox.map((e) => e.to)).toEqual(RECIPIENTS)
  })

  test('after approve --content the approved outbox is sent', async () => {
    await advance()
    await approveByContent()
    const calls = mailStub()

    await advance()

    expect(calls).toHaveLength(5)
    for (const call of calls) {
      expect(call.url).toBe(`${API_BASE}/send`)
      expect(call.method).toBe('POST')
      expect(call.authorization).toBe(`Bearer ${TOKEN}`)
    }
    expect(calls.map((c) => c.to)).toEqual(RECIPIENTS)
    expect(pluginRuns()['cadence-send']?.status).toBe('success')
    expect(ledger()).toEqual(RECIPIENTS.map((to, i) => [`c-${i + 1}:1`, to]))
  })

  test('a partial send retries at the same bytes to exactly the unrecorded recipients', async () => {
    await advance()
    await approveByContent()
    const approvedBody = pluginRuns()['cadence-plan']?.last_output?.body

    const first = mailStub(4)
    await advance()

    expect(first).toHaveLength(4)
    expect(pluginRuns()['cadence-send']?.status).toBe('partial')
    expect(ledger()).toEqual(RECIPIENTS.slice(0, 3).map((to, i) => [`c-${i + 1}:1`, to]))

    // The partial run spent the approval. Approving the unchanged outbox again
    // re-arms it, and `force` lifts cadence-send's TTL so the gate is reached.
    await approveByContent()
    const retry = mailStub()
    await advance({ force: true })

    expect(pluginRuns()['cadence-plan']?.last_output?.body).toBe(approvedBody)
    expect(retry.map((c) => c.to)).toEqual(['c-4@example.com', 'c-5@example.com'])
    expect(pluginRuns()['cadence-send']?.status).toBe('success')
    expect(ledger()).toEqual(RECIPIENTS.map((to, i) => [`c-${i + 1}:1`, to]))
  })

  // CR-01. A plan run with nothing to plan used to return no Output, so the
  // runtime carried the approved outbox forward and cadence-send shipped it,
  // to a contact who had just replied. The reply must win, and must stick.
  test('a plan run with no contacts file replaces the approved outbox, so a contact who replied is not emailed', async () => {
    await advance()
    await approveByContent()
    const stateDir = join(ctx.root, 'state')
    writeFileSync(join(stateDir, 'replies.json'), JSON.stringify({ replies: [{ contact_id: 'c-1' }] }))
    rmSync(join(stateDir, 'contacts.json'))
    const calls = mailStub()

    await advance({ force: true })

    expect(calls.map((c) => c.to)).not.toContain('c-1@example.com')
    expect(calls).toHaveLength(0)
    expect(pluginRuns()['cadence-plan']?.status).toBe('success')
    const body = pluginRuns()['cadence-plan']?.last_output?.body
    expect(JSON.parse(body!)).toEqual({ outbox: [], review_tasks: [] })
    const stopped = JSON.parse(readFileSync(join(stateDir, 'cadence-plan.stopped.json'), 'utf-8')) as { stopped: string[] }
    expect(stopped.stopped).toEqual(['c-1'])
  })

  // The reply reader fails, so the plan is held back and writes no record. Its
  // last success, and the outbox under the live approval, are still on file.
  // The approval is unmarked and the bytes still match it, so the only thing
  // between those five emails and their recipients is the hold reaching the
  // send, two hops down. Zero calls, and an unmarked approval, prove it did.
  test('a failing reply reader holds the send back, so a contact who replied is not emailed', async () => {
    await advance()
    await approveByContent()
    const approvedBody = pluginRuns()['cadence-plan']?.last_output?.body
    // A reply the reader cannot read: the file is not JSON.
    writeFileSync(join(ctx.root, 'state', 'replies.json'), '{"replies": [{"contact_id": "c-1"}')
    const calls = mailStub()

    const result = await advance({ force: true })

    expect(calls).toHaveLength(0)
    expect(pluginRuns()['cadence-replies']?.status).toBe('failed')
    expect(pluginRuns()['cadence-plan']?.status).toBe('success')
    expect(pluginRuns()['cadence-plan']?.last_output?.body).toBe(approvedBody)
    expect(result.plugin_states.get('cadence-send')).toBe('skipped')
    const log = JSON.parse(readFileSync(result.run_log_path, 'utf-8')) as {
      plugin_entries: { plugin: string; status: string; result_summary: string }[]
    }
    const entry = log.plugin_entries.find((e) => e.plugin === 'cadence-send')
    expect(entry?.status).toBe('skipped')
    expect(entry?.result_summary).toBe(
      "skipped: dependency failed — 'cadence-plan' held back by a failed dependency",
    )
    expect(existsSync(ledgerPath())).toBe(false)
    const state = JSON.parse(readFileSync(join(ctx.stateDir, 'engine-state.json'), 'utf-8')) as {
      approvals: Record<string, { marked_at: string | null }>
    }
    expect(state.approvals['cadence-send']?.marked_at).toBeNull()
  })

  // WR-01. The runtime's timeout wins its race against the handler and records
  // the run `failed`, whatever went out first, and a failed content fire reads
  // `indeterminate` for good. cadence-send has to stop itself before that.
  test('a send that runs out of time stops itself first: partial, and the rest go on a re-approved retry', async () => {
    shortTimeoutSend(2_000)
    await advance()
    await approveByContent()
    const first = mailStub(undefined, 500)

    await advance()

    expect(pluginRuns()['cadence-send']?.status).toBe('partial')
    const sentFirst = ledger().length
    expect(sentFirst).toBeGreaterThan(0)
    expect(sentFirst).toBeLessThan(5)
    expect(first.length).toBeLessThan(5)

    await approveByContent()
    const retry = mailStub()
    await advance({ force: true })

    expect(retry.map((c) => c.to)).toEqual(RECIPIENTS.slice(sentFirst))
    expect(ledger()).toEqual(RECIPIENTS.map((to, i) => [`c-${i + 1}:1`, to]))
  })

  // WR-02. A `failed` content fire reads `indeterminate`, and nothing clears
  // that. A non-2xx answer on the first email means nothing went out, so the
  // run must spend the approval and leave a re-approved retry open.
  test('a refused first email spends the approval, and a re-approved retry sends all five', async () => {
    await advance()
    await approveByContent()
    const first = mailStub(1)

    await advance()

    expect(first).toHaveLength(1)
    expect(pluginRuns()['cadence-send']?.status).toBe('partial')
    expect(existsSync(ledgerPath())).toBe(false)

    await approveByContent()
    const retry = mailStub()
    await advance({ force: true })

    expect(retry.map((c) => c.to)).toEqual(RECIPIENTS)
    expect(pluginRuns()['cadence-send']?.status).toBe('success')
  })
})
