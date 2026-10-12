/**
 * `warpline approvals` — what is waiting on a human, read from the terminal.
 *
 * In-process through `capture`, one temp home per case (AGENTS.md Rule 2).
 * The list cases write `asks.json` by hand around the real clock, because the
 * verb filters on `Date.now()`. The `show` cases raise their Asks through a
 * real advance with an `ok` notify stub, so each Ask on disk is one the engine
 * wrote.
 *
 * Every nonce a case can see is checked against stdout: neither form ever
 * prints one.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { notifyStub, setNotify } from '../../../test-utils/notify-stub.js'
import { capture, makeVerbHome, type VerbHome } from './helpers/verb-home.js'

let vh: VerbHome

beforeEach(() => {
  vh = makeVerbHome()
})

afterEach(() => {
  vh.cleanup()
})

const HOUR = 60 * 60 * 1000
const asksFile = (): string => join(vh.home, 'state', 'asks.json')
const prefsPath = (): string => join(vh.home, 'preferences.json')

type StoredAsk = {
  id: string
  nonce: string
  kind: string
  scope: string
  plugin: string | null
  digest: string
  summary: string
  raised_at: string
  expires_at: string
  state: string
}

function storedAsks(): StoredAsk[] {
  return (JSON.parse(readFileSync(asksFile(), 'utf-8')) as { asks: StoredAsk[] }).asks
}

/** The one open Ask of `kind` on `scope`, which must exist. */
function openAsk(kind: string, scope: string): StoredAsk {
  const found = storedAsks().filter((a) => a.state === 'open' && a.kind === kind && a.scope === scope)
  expect(found).toHaveLength(1)
  return found[0]!
}

/** Every manifest field spelled out, so no fixture leans on a schema default. */
function writePlugin(name: string, overrides: Record<string, unknown>, handler: string): void {
  const dir = join(vh.home, 'plugins', name)
  mkdirSync(dir, { recursive: true })
  const manifest = {
    name,
    version: '1.0.0',
    description: `${name} fixture plugin`,
    inputs: {},
    outputs: {},
    capabilities: [],
    secrets: [],
    schedule: 'on_run',
    autonomy_level: 'autonomous',
    approval_class: 'session',
    llm_handoff: false,
    side_effects: [],
    ttl_hours: 24,
    dependencies: [],
    timeout_ms: 5000,
    max_parallelism: 1,
    min_tier: 'normal',
    max_retries: 1,
    retry_delay_ms: 2000,
    ...overrides,
  }
  writeFileSync(join(dir, 'manifest.ts'), `export const manifest = ${JSON.stringify(manifest)}`)
  writeFileSync(join(dir, 'handler.ts'), handler)
}

/** A handler returning one Output, built at call time from `artifact`, a JS expression. */
function outputHandler(artifact: string, prelude = ''): string {
  return `${prelude}
export async function handler() {
  return {
    status: 'success',
    phases_completed: ['make'],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: 'made',
    artifacts_produced: [${artifact}],
    schema_version: 1,
  }
}
`
}

async function ok(argv: string[]): Promise<void> {
  const r = await capture(argv)
  if (r.code !== 0) throw new Error(`${argv.join(' ')} exited ${r.code}: ${r.stderr}`)
}

/** `notify` set to an `ok` stub, so an advance raises and sends its Asks. */
async function withNotify(): Promise<void> {
  const stub = await notifyStub(vh.home, 'ok')
  setNotify(prefsPath(), { argv: stub.argv })
}

/** Every nonce in the store, none of which may reach stdout. */
function expectNoNonce(stdout: string): void {
  const nonces = storedAsks().map((a) => a.nonce)
  expect(nonces.length).toBeGreaterThan(0)
  for (const nonce of nonces) expect(stdout).not.toContain(nonce)
}

describe('warpline approvals', () => {
  test('with nothing waiting it prints Nothing waiting. and exits 0', async () => {
    const absent = await capture(['approvals'])
    expect(absent).toEqual({ code: 0, stdout: 'Nothing waiting.\n', stderr: '' })

    writeFileSync(asksFile(), JSON.stringify({ min_reader_version: 1, asks: [] }))
    const empty = await capture(['approvals'])
    expect(empty).toEqual({ code: 0, stdout: 'Nothing waiting.\n', stderr: '' })
  })

  test('an unreadable store exits 1 naming the file, and prints nothing on stdout', async () => {
    writeFileSync(asksFile(), '{')
    const list = await capture(['approvals'])
    expect(list.code).toBe(1)
    expect(list.stdout).toBe('')
    expect(list.stderr).toContain(asksFile())
    expect(list.stderr).toContain('corrupt')

    const show = await capture(['approvals', 'show', 'aaaaaaaaaaaa'])
    expect(show.code).toBe(1)
    expect(show.stdout).toBe('')
    expect(show.stderr).toContain(asksFile())
  })

  test('open Asks print by severity, then oldest first, and never a nonce', async () => {
    const now = Date.now()
    const iso = (ms: number): string => new Date(ms).toISOString()
    const hex = (c: string, n: number): string => c.repeat(n)
    const ask = (
      id: string,
      kind: string,
      scope: string,
      raisedAgoMs: number,
      over: Record<string, unknown> = {},
    ): Record<string, unknown> => ({
      id,
      nonce: hex(id[0]!, 32),
      kind,
      scope,
      plugin: kind === 'renewal' ? null : scope,
      digest: hex(id[0]!, 4) + 'f'.repeat(60),
      summary: `${kind} fixture`,
      raised_at: iso(now - raisedAgoMs),
      expires_at: iso(now + 20 * HOUR),
      state: 'open',
      closed_at: null,
      answer: null,
      events: [{ seq: 1, event: 'raised', at: iso(now - raisedAgoMs) }],
      tries: [],
      ...over,
    })
    const asks = [
      ask('111111111111', 'missing_grant', 'mailer', 3 * HOUR),
      ask('222222222222', 'parked_result', 'reviewed', 1 * HOUR),
      ask('333333333333', 'renewal', 'abcdefabcdef', 2 * HOUR),
      ask('444444444444', 'content', 'sender', 4 * HOUR),
      ask('555555555555', 'missing_grant', 'old', 5 * HOUR, { state: 'superseded', closed_at: iso(now - HOUR) }),
      ask('666666666666', 'missing_grant', 'lapsed', 6 * HOUR, { expires_at: iso(now - HOUR) }),
    ]
    writeFileSync(asksFile(), JSON.stringify({ min_reader_version: 1, asks }))

    const r = await capture(['approvals'])
    expect(r.code).toBe(0)
    expect(r.stderr).toBe('')
    const lines = r.stdout.trimEnd().split('\n')
    expect(lines.map((l) => l.slice(0, 12))).toEqual(['333333333333', '222222222222', '444444444444', '111111111111'])

    const severity: Record<string, string> = {
      renewal: 'warning',
      parked_result: 'warning',
      content: 'info',
      missing_grant: 'info',
    }
    for (const line of lines) {
      const a = asks.find((x) => x.id === line.slice(0, 12))!
      for (const part of [
        a.id as string,
        severity[a.kind as string]!,
        a.kind as string,
        a.scope as string,
        a.raised_at as string,
        a.expires_at as string,
        (a.digest as string).slice(0, 12),
      ]) {
        expect(line).toContain(part)
      }
    }
    for (const a of asks) expect(r.stdout).not.toContain(a.nonce as string)
  })
})

describe('warpline approvals show', () => {
  test('an unknown id refuses with its reason', async () => {
    const unknown = await capture(['approvals', 'show', 'aaaaaaaaaaaa'])
    expect(unknown.code).toBe(1)
    expect(unknown.stdout).toBe('')
    expect(unknown.stderr).toContain('no Ask has id aaaaaaaaaaaa')

    const malformed = await capture(['approvals', 'show', 'zz'])
    expect(malformed.code).toBe(1)
    expect(malformed.stdout).toBe('')
    expect(malformed.stderr).toContain('is not an Ask id')
  })

  test('show prints the Ask and never its nonce', async () => {
    await withNotify()
    await capture(['advance'])
    const a = openAsk('missing_grant', 'p')

    const r = await capture(['approvals', 'show', a.id])
    expect(r.code).toBe(0)
    for (const part of [a.id, 'missing_grant', 'p', a.summary, a.digest, a.raised_at, a.expires_at, 'creates_issue']) {
      expect(r.stdout).toContain(part)
    }
    expect(r.stdout).toContain('no earlier approved content')
    expectNoNonce(r.stdout)
  })

  test('show on a content Ask with an earlier approved Output prints the diff', async () => {
    const body = join(vh.home, 'body.txt')
    writeFileSync(body, 'line one\nline two\nline three\n')
    writePlugin(
      'report',
      { outputs: { body: { type: 'text' } } },
      outputHandler(
        `{ type: 'body', format: 'text', body: readFileSync(${JSON.stringify(body)}, 'utf-8') }`,
        `import { readFileSync } from 'node:fs'`,
      ),
    )
    // The shared home's sender, re-pointed at report before anything loads it.
    writePlugin(
      'sender',
      {
        approval_class: 'content',
        dependencies: ['report'],
        side_effects: ['sends_email'],
        ttl_hours: 0.000001,
      },
      outputHandler(''),
    )

    await ok(['prefs', 'set', 'review_gate', 'true'])
    await capture(['advance'])
    await ok(['approve', 'report'])
    await ok(['approve', 'sender', '--content', '--not-after', '2099-01-01T00:00'])

    // A day later: report's run is past its 24 h TTL, so the next advance runs
    // it again. Backdated by hand, because a TTL short enough to lapse here
    // would also expire the parked gate before approve could apply it.
    const doc = JSON.parse(readFileSync(vh.statePath, 'utf-8')) as {
      plugin_runs: Record<string, { last_run_at: string }>
    }
    doc.plugin_runs.report!.last_run_at = new Date(Date.now() - 25 * HOUR).toISOString()
    writeFileSync(vh.statePath, JSON.stringify(doc))

    await ok(['prefs', 'set', 'review_gate', 'false'])
    writeFileSync(body, 'line one\nline TWO\nline three\n')
    await withNotify()
    await capture(['advance'])
    const a = openAsk('content', 'sender')

    const r = await capture(['approvals', 'show', a.id])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('line TWO')
    expect(r.stdout).not.toContain('no earlier approved content')
    const lines = r.stdout.split('\n')
    expect(lines.filter((l) => l.startsWith('-'))).toEqual(['-line two'])
    expect(lines.filter((l) => l.startsWith('+'))).toEqual(['+line TWO'])
    expectNoNonce(r.stdout)
  })

  test('show on a content Ask with no earlier approval says so and prints no diff', async () => {
    await withNotify()
    await capture(['advance'])
    const a = openAsk('content', 'sender')

    const r = await capture(['approvals', 'show', a.id])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('four invoices')
    expect(r.stdout).toContain('no earlier approved content')
    expect(r.stdout.split('\n').filter((l) => l.startsWith('-') || l.startsWith('+'))).toEqual([])
    expectNoNonce(r.stdout)
  })

  test('content that is not UTF-8 prints its digest, size and path, never its bytes', async () => {
    const blob = join(vh.home, 'blob.bin')
    const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x41])
    writeFileSync(blob, bytes)
    writePlugin(
      'blob',
      { autonomy_level: 'supervised', outputs: { blob: { type: 'text' } } },
      outputHandler(`{ type: 'blob', format: 'text', path: ${JSON.stringify(blob)} }`),
    )
    await withNotify()
    await capture(['advance'])
    const a = openAsk('parked_result', 'blob')

    const r = await capture(['approvals', 'show', a.id])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain(createHash('sha256').update(bytes).digest('hex'))
    expect(r.stdout).toContain('4 bytes')
    expect(r.stdout).toContain(blob)
    expect(r.stdout).not.toContain('ÿ')
    expect(r.stdout).not.toContain('�')
    expect(r.stdout).not.toContain('\u0000')
    expectNoNonce(r.stdout)
  })

  test('control characters a plugin wrote are escaped', async () => {
    writePlugin(
      'painter',
      { autonomy_level: 'supervised', outputs: { note: { type: 'text' } } },
      outputHandler(`{ type: 'note', format: 'text', body: ${JSON.stringify('\u001b[31mred\u001b[0m')} }`),
    )
    await withNotify()
    await capture(['advance'])
    const a = openAsk('parked_result', 'painter')

    const r = await capture(['approvals', 'show', a.id])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('\\x1b[31mred\\x1b[0m')
    expect(r.stdout).not.toContain('\u001b')
    expectNoNonce(r.stdout)
  })
})
