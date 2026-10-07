/**
 * `warpline audit`, in process, through the dispatcher.
 *
 * Each case sets its own home. The preload's home is shared by every
 * in-process CLI test in a `bun test` run, and a head read off a store other
 * files also append to would depend on file order.
 *
 * The expected head is read off disk and hashed here with `node:crypto`, so the
 * check never borrows the writer's own hashing.
 *
 * Everything this file writes goes under temp dirs (AGENTS.md Rule 2).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { appendAudit, passOver as passOverLib, readHead } from '../../lib/audit-log.js'
import { _setHome } from '../../lib/paths.js'
import { appendRelinked, forge, walkChain, type ForgeOp } from '../../lib/__tests__/helpers/audit-chain.js'
import { snapshotHome } from '../../runtime/__tests__/helpers/snapshot-home.js'
import { testFixturesDir } from '../../../test-utils/fixtures.js'
import { main } from '../warpline.js'

/** Whether `path` exists, by lstat: a held audit lock is a symbolic link whose target does not exist. */
const present = (path: string): boolean => lstatSync(path, { throwIfNoEntry: false }) !== undefined

/** The built bin, for the one case that feeds stdin. */
const BIN = testFixturesDir(import.meta.url, '../../../dist/bin/warpline.js')

/** Run main(argv) with stdout/stderr captured, always restoring the originals. */
async function capture(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const realOut = process.stdout.write
  const realErr = process.stderr.write
  let stdout = ''
  let stderr = ''
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string) => {
    stderr += chunk
    return true
  }) as typeof process.stderr.write
  try {
    const code = await main(argv)
    return { code, stdout, stderr }
  } finally {
    process.stdout.write = realOut
    process.stderr.write = realErr
  }
}

/** Every field spelled out, so the fixture never leans on a schema default. */
const MANIFEST = {
  name: 'p',
  version: '1.0.0',
  description: 'p fixture plugin',
  inputs: {},
  outputs: {},
  capabilities: [],
  secrets: [],
  schedule: 'on_run',
  autonomy_level: 'supervised',
  approval_class: 'session',
  llm_handoff: false,
  side_effects: ['creates_issue'],
  ttl_hours: 24,
  dependencies: [],
  timeout_ms: 5000,
  max_parallelism: 1,
  min_tier: 'normal',
  max_retries: 1,
  retry_delay_ms: 2000,
}

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'warpline-audit-cli-'))
  mkdirSync(join(home, 'plugins', 'p'), { recursive: true })
  writeFileSync(join(home, 'plugins', 'p', 'manifest.ts'), `export const manifest = ${JSON.stringify(MANIFEST)}`)
  mkdirSync(join(home, 'state'), { recursive: true })
  _setHome(home)
})

afterEach(() => {
  _setHome(null)
  rmSync(home, { recursive: true, force: true })
})

/** The last stored line of the last segment, as written. */
function lastLine(): string {
  const dir = join(home, 'audit')
  const segments = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()
  const text = readFileSync(join(dir, segments.at(-1)!), 'utf-8')
  return text.slice(0, -1).split('\n').at(-1)!
}

describe('warpline audit', () => {
  test('audit head on an empty home prints 0 and 64 zeros and creates no store', async () => {
    const { code, stdout, stderr } = await capture(['audit', 'head'])

    expect(code).toBe(0)
    expect(stdout).toBe(`0 ${'0'.repeat(64)}\n`)
    expect(stderr).toBe('')
    expect(present(join(home, 'audit'))).toBe(false)
  })

  test("audit head after a deny prints the last line's seq and the hash of its bytes", async () => {
    const denied = await capture(['deny', 'p'])
    expect(denied.code).toBe(0)

    const { code, stdout, stderr } = await capture(['audit', 'head'])

    const line = lastLine()
    const seq = (JSON.parse(line) as { warplineseq: number }).warplineseq
    expect(code).toBe(0)
    expect(stderr).toBe('')
    expect(stdout).toBe(`${seq} ${createHash('sha256').update(line).digest('hex')}\n`)
  })

  test('audit with no sub-verb exits 1 with usage on stderr and nothing on stdout', async () => {
    const { code, stdout, stderr } = await capture(['audit'])

    expect(code).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toContain('warpline audit head')
  })

  test('audit with an unknown sub-verb exits 1 with usage on stderr and nothing on stdout', async () => {
    const { code, stdout, stderr } = await capture(['audit', 'bogus'])

    expect(code).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toContain('warpline audit head')
  })
})

// -- export, verify and --c2sp ------------------------------------------------

const SEGMENT = /^\d{16}\.jsonl$/
const sha = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex')
const statePath = (): string => join(home, 'state', 'engine-state.json')
const auditDir = (): string => join(home, 'audit')
const segmentFiles = (): string[] => readdirSync(auditDir()).filter((n) => SEGMENT.test(n)).sort()

/** Every complete line of every segment, in name order, newline excluded. */
function storeLines(): string[] {
  return segmentFiles().flatMap((n) => {
    const text = readFileSync(join(auditDir(), n), 'utf8')
    return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').slice(0, -1)
  })
}

const seqOf = (line: string): number => (JSON.parse(line) as { warplineseq: number }).warplineseq

/** `n` records through the real writer. Distinct plugin names, so a leak of one into stdout is findable. */
async function grow(n: number, opts: { maxSegmentBytes?: number } = {}): Promise<void> {
  for (let i = 0; i < n; i++) {
    await appendAudit(statePath(), 'denial.lifted', { plugin: `plugin-${i}-zq`, fingerprint: null }, opts)
  }
}

/** Appends over 2048-byte segments until there are exactly two. */
async function twoSegments(): Promise<void> {
  for (let i = 0; !present(auditDir()) || segmentFiles().length < 2; i++) {
    if (i > 50) throw new Error('no second segment after 50 appends')
    await grow(1, { maxSegmentBytes: 2048 })
  }
  expect(segmentFiles()).toHaveLength(2)
}

/** The head as `audit head` prints it, written to `<home>/anchor`. */
async function anchorFile(text?: string): Promise<string> {
  const path = join(home, 'anchor')
  writeFileSync(path, text ?? (await capture(['audit', 'head'])).stdout)
  return path
}

const verify = (anchor: string) => capture(['audit', 'verify', '--checkpoint', anchor])

/** A CloudEvents 1.0 structured-mode envelope, as the store writes it. */
const Envelope = z.strictObject({
  specversion: z.literal('1.0'),
  id: z.string().regex(/^[1-9][0-9]*$/),
  source: z.string().regex(/^urn:uuid:[0-9a-f-]{36}$/),
  type: z.string().startsWith('warpline.audit.'),
  time: z.iso.datetime(),
  datacontenttype: z.literal('application/json'),
  warplineseq: z.number().int().positive(),
  warplineprev: z.string().regex(/^[0-9a-f]{64}$/),
  data: z.record(z.string(), z.unknown()),
})

describe('audit export', () => {
  test('--after 0 prints every line in seq order, each a valid envelope, equal to the segment files concatenated', async () => {
    await grow(30, { maxSegmentBytes: 2048 })
    expect(segmentFiles().length).toBeGreaterThanOrEqual(3)
    const { seq: head } = await readHead(statePath())

    const { code, stdout, stderr } = await capture(['audit', 'export', '--after', '0'])

    expect(code).toBe(0)
    expect(stderr).toBe('')
    const lines = stdout.slice(0, -1).split('\n')
    for (const line of lines) Envelope.parse(JSON.parse(line))
    expect(lines.map(seqOf)).toEqual(Array.from({ length: head }, (_, i) => i + 1))
    expect(stdout).toBe(Buffer.concat(segmentFiles().map((n) => readFileSync(join(auditDir(), n)))).toString('utf8'))
  })

  test('--after the head prints nothing and exits 0; one past the head is refused as beyond head', async () => {
    await grow(5)
    const { seq: head } = await readHead(statePath())

    const at = await capture(['audit', 'export', '--after', String(head)])
    expect(at.code).toBe(0)
    expect(at.stdout).toBe('')
    expect(at.stderr).toBe('')

    const past = await capture(['audit', 'export', '--after', String(head + 1)])
    expect(past.code).toBe(1)
    expect(past.stdout).toBe('')
    expect(past.stderr).toContain('beyond head')
  })

  test('--after a seq in the middle prints exactly the lines after it, from the file that holds it', async () => {
    await grow(30, { maxSegmentBytes: 2048 })
    const firstText = readFileSync(join(auditDir(), segmentFiles()[0]!), 'utf8')
    const lastOfFirst = seqOf(firstText.slice(0, -1).split('\n').at(-1)!)
    const all = storeLines()

    for (const n of [lastOfFirst - 1, lastOfFirst, lastOfFirst + 1]) {
      const { code, stdout } = await capture(['audit', 'export', '--after', String(n)])
      expect(code).toBe(0)
      expect(seqOf(stdout.split('\n')[0]!)).toBe(n + 1)
      expect(stdout).toBe(all.filter((l) => seqOf(l) > n).map((l) => `${l}\n`).join(''))
    }
  })

  test('a torn fragment is never exported: every line parses and its bytes are absent', async () => {
    await grow(4)
    const fragment = '{"specversion":"1.0","id":"torn-fragment-qq'
    appendFileSync(join(auditDir(), segmentFiles().at(-1)!), fragment)
    await grow(1)
    expect(segmentFiles()).toHaveLength(2)

    const { code, stdout } = await capture(['audit', 'export', '--after', '0'])

    expect(code).toBe(0)
    const lines = stdout.slice(0, -1).split('\n')
    for (const line of lines) Envelope.parse(JSON.parse(line))
    expect(lines).toEqual(storeLines())
    expect(stdout.includes(fragment)).toBe(false)
  })

  test('export takes no lock and adds no byte to the store', async () => {
    await grow(8, { maxSegmentBytes: 2048 })
    const before = await snapshotHome(auditDir())

    const { code, stdout } = await capture(['audit', 'export', '--after', '0'])

    expect(code).toBe(0)
    expect(stdout.length).toBeGreaterThan(0)
    expect(await snapshotHome(auditDir())).toEqual(before)
    expect(present(join(auditDir(), '.lock'))).toBe(false)
  })

  test('a bad or missing --after is refused with usage on stderr and nothing on stdout', async () => {
    await grow(3)
    for (const argv of [
      ['--after', '-1'],
      ['--after', '01'],
      ['--after', '1e3'],
      ['--after', 'abc'],
      [],
    ]) {
      const { code, stdout, stderr } = await capture(['audit', 'export', ...argv])
      expect({ argv, code, stdout }).toEqual({ argv, code: 1, stdout: '' })
      expect(stderr).toContain('export --after <seq>')
    }
  })
})

describe('audit verify', () => {
  /** Eleven appends after genesis: twelve lines in one segment. */
  async function twelve(): Promise<void> {
    await grow(11)
    expect(segmentFiles()).toEqual(['0000000000000001.jsonl'])
    expect((await readHead(statePath())).seq).toBe(12)
  }

  const FORGERIES: [string, ForgeOp, string, number][] = [
    ['an edited record', { edit: 4 }, 'tampered', 4],
    ['two reordered records', { swap: 4 }, 'tampered', 4],
    ['an inserted record', { insert: 4 }, 'tampered', 4],
    ['a store truncated below the anchor', { truncate: 3 }, 'tampered', 4],
    ['a torn tail', { tear: '{"specversion":"1.0","id":' }, 'torn', 3],
  ]

  for (const [what, op, verdict, exit] of FORGERIES) {
    test(`${what}, which the link-only walker accepts, is ${verdict} against the anchor`, async () => {
      await twelve()
      const anchor = await anchorFile()

      forge(auditDir(), op)
      expect(walkChain(auditDir()).ok).toBe(true)

      const { code, stdout } = await verify(anchor)
      expect(stdout).toContain(`verdict: ${verdict}\n`)
      expect(code).toBe(exit)
    })
  }

  test('the untouched store is clean against its own head, 0 records stale', async () => {
    await twelve()
    const { code, stdout } = await verify(await anchorFile())

    expect(stdout).toContain('verdict: clean\n')
    expect(stdout).toContain('stale: 0 records')
    expect(code).toBe(0)
  })

  test('a partial line by hand at the end of a segment that has a successor is tampered', async () => {
    await twoSegments()
    const anchor = await anchorFile()
    appendFileSync(join(auditDir(), segmentFiles()[0]!), '{"specversion":"1.0","id":')

    const { code, stdout } = await verify(anchor)
    expect(stdout).toContain('verdict: tampered\n')
    expect(code).toBe(4)
  })

  test('a fragment a later segment acknowledges is torn', async () => {
    await grow(4)
    const anchor = await anchorFile()
    appendFileSync(join(auditDir(), segmentFiles()[0]!), '{"specversion":"1.0","id":')
    await grow(1)
    expect(segmentFiles()).toHaveLength(2)

    const { code, stdout } = await verify(anchor)
    expect(stdout).toContain('verdict: torn\n')
    expect(code).toBe(3)
  })

  test('a store whose last line is a correctly chained seal with no successor is torn', async () => {
    await twoSegments()
    const anchor = await anchorFile()
    const path = join(auditDir(), segmentFiles().at(-1)!)
    const last = readFileSync(path, 'utf8').slice(0, -1).split('\n').at(-1)!
    const rec = JSON.parse(last) as { warplineseq: number; source: string }
    const seq = rec.warplineseq + 1
    const sealed = JSON.stringify({
      specversion: '1.0',
      id: String(seq),
      source: rec.source,
      type: 'warpline.audit.segment.sealed',
      time: new Date().toISOString(),
      datacontenttype: 'application/json',
      warplineseq: seq,
      warplineprev: sha(last),
      data: { reason: 'size', bytes: statSync(path).size },
    })
    appendFileSync(path, `${sealed}\n`)
    expect(walkChain(auditDir()).ok).toBe(true)

    const { code, stdout } = await verify(anchor)
    expect(stdout).toContain('verdict: torn\n')
    expect(code).toBe(3)
  })

  test('the --c2sp note body verifies clean, and the same body naming another home is wrong log', async () => {
    await twelve()
    const note = (await capture(['audit', 'head', '--c2sp'])).stdout

    const clean = await verify(await anchorFile(note))
    expect(clean.stdout).toContain('verdict: clean\n')
    expect(clean.code).toBe(0)

    const other = ['urn:uuid:00000000-0000-4000-8000-000000000000', ...note.split('\n').slice(1)].join('\n')
    const wrong = await verify(await anchorFile(other))
    expect(wrong.stdout).toContain('verdict: wrong log\n')
    expect(wrong.code).toBe(5)
  })

  test('the plain anchor on stdin with --checkpoint - verifies clean', async () => {
    await twelve()
    const anchor = (await capture(['audit', 'head'])).stdout
    const env: NodeJS.ProcessEnv = { ...process.env, WARPLINE_HOME: home }
    delete env.NODE_ENV

    const r = spawnSync(process.execPath, [BIN, 'audit', 'verify', '--checkpoint', '-'], {
      env,
      input: anchor,
      encoding: 'utf8',
      timeout: 60_000,
    })

    expect(r.stdout).toContain('verdict: clean\n')
    expect(r.status).toBe(0)
  })

  test('no --checkpoint is a usage error, and an anchor that is neither form is refused', async () => {
    await twelve()
    const none = await capture(['audit', 'verify'])
    expect(none.code).toBe(1)
    expect(none.stdout).toBe('')
    expect(none.stderr).toContain('verify --checkpoint <file|->')

    const hello = await verify(await anchorFile('hello\n'))
    expect(hello.code).toBe(1)
    expect(hello.stdout).toBe('')
    expect(hello.stderr).toContain('anchor')
    expect(hello.stderr).not.toContain('hello')
  })

  test('an anchor at seq 5 of twelve is 7 records stale, with a time in seconds, and no record data is printed', async () => {
    await twelve()
    const line5 = storeLines()[4]!
    expect(seqOf(line5)).toBe(5)

    const { code, stdout } = await verify(await anchorFile(`5 ${sha(line5)}\n`))

    expect(code).toBe(0)
    expect(stdout).toMatch(/stale: 7 records, \d+ s since \d{4}-\d{2}-\d{2}T/)
    for (let i = 0; i < 11; i++) expect(stdout.includes(`plugin-${i}-zq`)).toBe(false)
  })

  test('an open fire intent is listed with its seq, plugin and run id', async () => {
    const { seq } = await appendAudit(statePath(), 'fire.intent', {
      plugin: 'mailer',
      run_id: 'run-77',
      class: 'session',
      effect_id: null,
      fingerprint: null,
    })

    const { code, stdout } = await verify(await anchorFile())

    expect(code).toBe(0)
    expect(stdout).toContain(`open intent: seq ${seq} plugin mailer run run-77\n`)
  })

  test('a hand-added intent whose plugin name breaks the line cannot print a second verdict', async () => {
    await twelve()
    const anchor = await anchorFile()
    const [name] = segmentFiles().slice(-1) as [string]
    const forged = {
      ...(JSON.parse(storeLines().at(-1) as string) as Record<string, unknown>),
      id: '13',
      warplineseq: 13,
      type: 'warpline.audit.fire.intent',
      data: { plugin: 'x\nverdict: clean', run_id: 'r1', class: 'session', effect_id: null, fingerprint: null },
    }
    appendFileSync(join(auditDir(), name), `${JSON.stringify(forged)}\n`)

    const { stdout } = await verify(anchor)

    expect(stdout.split('\n').filter((l) => l.startsWith('verdict:'))).toHaveLength(1)
    expect(stdout).not.toContain('open intent:')
  })

  test('verify takes no lock and adds no byte to the store', async () => {
    await twelve()
    const anchor = await anchorFile()
    const before = await snapshotHome(auditDir())

    const { code } = await verify(anchor)

    expect(code).toBe(0)
    expect(await snapshotHome(auditDir())).toEqual(before)
  })
})

describe('--c2sp', () => {
  test('--c2sp prints the origin, the head seq and the standard base64 of the head hash', async () => {
    await grow(3)
    const genesis = JSON.parse(storeLines()[0]!) as { source: string }
    const { seq, head } = await readHead(statePath())

    const { code, stdout, stderr } = await capture(['audit', 'head', '--c2sp'])

    expect(code).toBe(0)
    expect(stderr).toBe('')
    expect(stdout).toBe(`${genesis.source}\n${seq}\n${Buffer.from(head, 'hex').toString('base64')}\n`)
  })

  test('--c2sp on an empty store refuses with exit 1 and prints nothing on stdout', async () => {
    const { code, stdout, stderr } = await capture(['audit', 'head', '--c2sp'])

    expect(code).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toContain('no records yet')
    expect(present(auditDir())).toBe(false)
  })

  test('--c2sp takes no lock and adds no byte to the store', async () => {
    await grow(3)
    const before = await snapshotHome(auditDir())

    const { code } = await capture(['audit', 'head', '--c2sp'])

    expect(code).toBe(0)
    expect(await snapshotHome(auditDir())).toEqual(before)
  })
})

// -- A line the walk passes over, or stops at ----------------------------------

/** A control character no writer lets into a plugin name, and a marker to look for in every output. */
const BAD_PLUGIN = 'bad\u0007WALK_SENTINEL_5d1'

/** The open intent the cases below look for. */
const mailer = () =>
  appendAudit(statePath(), 'fire.intent', { plugin: 'mailer', run_id: 'run-77', class: 'session', effect_id: null, fingerprint: null })

/** A chain-valid `grant.issued` whose data is the writer's plus one key. */
const grantWithExtraKey = (): number =>
  appendRelinked(auditDir(), 'warpline.audit.grant.issued', { scopes: ['p'], ttl_ms: null, replace: false, long: false, note: 'x' })

/** A chain-valid `fire.intent` whose plugin no writer writes. */
const badIntent = (): number =>
  appendRelinked(auditDir(), 'warpline.audit.fire.intent', {
    plugin: BAD_PLUGIN,
    run_id: 'run-78',
    class: 'session',
    effect_id: null,
    fingerprint: null,
  })

const unreadableLines = (stdout: string): string[] => stdout.split('\n').filter((l) => l.startsWith('open intents unreadable: '))

describe('verify when the walk passes over or stops at a line', () => {
  test('a chain-valid line of a known kind with one extra key leaves the verdict clean and the open intent listed', async () => {
    const { seq } = await mailer()
    grantWithExtraKey()

    const { code, stdout } = await verify(await anchorFile())

    expect(stdout).toContain('verdict: clean\n')
    expect(stdout).toContain(`open intent: seq ${seq} plugin mailer run run-77\n`)
    expect(code).toBe(0)
  })

  test('a carried field no writer writes gives verdict unreadable, exit 6 and a line naming the seq', async () => {
    await mailer()
    const anchor = await anchorFile()
    const bad = badIntent()

    const stopped = await verify(anchor)

    expect(stopped.stdout).toContain('verdict: unreadable\n')
    expect(stopped.code).toBe(6)
    const named = unreadableLines(stopped.stdout)
    expect(named).toHaveLength(1)
    expect(named[0]).toContain(`seq ${bad} `)
    expect(named[0]).toContain('fire.intent')
    expect(stopped.stdout).not.toContain('open intent:')
    expect(stopped.stdout).not.toContain('WALK_SENTINEL_5d1')
  })

  test('tampered outranks unreadable, and the unreadable line still prints', async () => {
    await grow(11)
    const anchor = await anchorFile()
    const [name] = segmentFiles().slice(-1) as [string]
    // The hand-added forgery: its warplineprev is the line before's, so it does not link.
    const forged = {
      ...(JSON.parse(storeLines().at(-1) as string) as Record<string, unknown>),
      id: '13',
      warplineseq: 13,
      type: 'warpline.audit.fire.intent',
      data: { plugin: 'x\nverdict: clean', run_id: 'r1', class: 'session', effect_id: null, fingerprint: null },
    }
    appendFileSync(join(auditDir(), name), `${JSON.stringify(forged)}\n`)

    const { code, stdout } = await verify(anchor)

    expect(stdout.split('\n').filter((l) => l.startsWith('verdict:'))).toEqual(['verdict: tampered'])
    expect(code).toBe(4)
    const named = unreadableLines(stdout)
    expect(named).toHaveLength(1)
    expect(named[0]).toContain('seq 13 ')
    expect(named[0]).toContain('fire.intent')
    expect(stdout).not.toContain('open intent:')
  })

  test('an active segment that holds no complete line reads unreadable, exit 6, naming the file and that it is moved aside by hand', async () => {
    await mailer()
    await grow(1)
    const h0 = await headText()
    const { seq: s } = await readHead(statePath())
    const path = join(auditDir(), nameOf(s + 1))

    // Empty, then only a partial line: the walk has no opening line to start from either way.
    for (const bytes of ['', '{"specversion":"1.0","id":']) {
      writeFileSync(path, bytes)
      const { code, stdout } = await verifyAt(h0)

      expect(stdout).toContain('verdict: unreadable\n')
      expect(code).toBe(6)
      const why = reasons(stdout)
      expect(why).toHaveLength(1)
      expect(why[0]).toContain(`segment ${nameOf(s + 1)} holds no complete line`)
      expect(why[0]).toContain('move it aside by hand')
      const named = unreadableLines(stdout)
      expect(named).toHaveLength(1)
      expect(named[0]).toContain(`segment ${nameOf(s + 1)} holds no complete line`)
      expect(named[0]).toContain('move it aside by hand')
    }
  })

  test('an active segment that holds no complete line refuses every append, the walk and pass-over naming the file, and once it is moved out of the store the next append goes through and verify reads clean', async () => {
    await mailer()

    // Empty, as a crash between creating the file and its first write leaves it, then only a partial line.
    for (const [i, bytes] of ['', '{"specversion":"1.0","id":'].entries()) {
      await grow(1)
      const h0 = await headText()
      const { seq: s } = await readHead(statePath())
      const name = nameOf(s + 1)
      writeFileSync(join(auditDir(), name), bytes)
      const WANT = `segment ${name} holds no complete line; move it aside by hand (docs/runtime-spec.md § 14)`

      let reason: unknown
      try {
        await appendAudit(statePath(), 'denial.lifted', { plugin: 'plugin-x-zq', fingerprint: null })
      } catch (err) {
        reason = (err as { reason?: unknown }).reason
      }
      expect(reason).toBe(WANT)

      const passed = await passOver(s)
      expect(passed.code).toBe(1)
      expect(passed.stderr).toContain(WANT)

      const listed = await capture(['principal', 'list'])
      expect(listed.code).toBe(1)
      expect(listed.stderr).toContain(WANT)

      // The hand step the refusal names. The file holds no record, so nothing on the chain goes with it.
      renameSync(join(auditDir(), name), join(home, `aside-${i}.jsonl`))
      await grow(1)
      expect(segmentFiles()).not.toContain(name)
      const v = await verifyAt(h0)
      expect(v.stdout).toContain('verdict: clean\n')
      expect(v.code).toBe(0)
    }
  })
})

describe('a line the walk passes over wedges nothing', () => {
  test('advance, principal list, principal add and prefs set all go through, and each records as usual', async () => {
    // The shipped default is review_gate true, which a set to true would leave as it is.
    writeFileSync(join(home, 'preferences.json'), JSON.stringify({ review_gate: false }))
    await mailer()
    const foreign = grantWithExtraKey()

    for (const argv of [['advance'], ['principal', 'list'], ['principal', 'add', 'ops', '--type', 'human'], ['prefs', 'set', 'review_gate', 'true']]) {
      const { code } = await capture(argv)
      expect({ argv, code }).toEqual({ argv, code: 0 })
    }

    const after = storeLines()
      .filter((l) => seqOf(l) > foreign)
      .map((l) => (JSON.parse(l) as { type: string }).type)
    expect(after).toContain('warpline.audit.checkpoint.recorded')
    expect(after).toContain('warpline.audit.principal.added')
    expect(after).toContain('warpline.audit.preference.set')
  })

  test('when the walk stops, principal list and prefs set refuse naming the seq and the kind, and nothing from the line', async () => {
    await mailer()
    const bad = badIntent()

    for (const argv of [['principal', 'list'], ['prefs', 'set', 'review_gate', 'true']]) {
      const { code, stderr } = await capture(argv)
      expect({ argv, code }).toEqual({ argv, code: 1 })
      expect(stderr).toContain('The audit store could not record this change: ')
      expect(stderr).toContain(`seq ${bad} `)
      expect(stderr).toContain('fire.intent')
      expect(stderr).not.toContain('WALK_SENTINEL_5d1')
    }
  })
})

// -- Passing over a line the walk stops on -------------------------------------

/** The head as `audit head` prints it, kept as text so an anchor can be written from it later. */
const headText = async (): Promise<string> => (await capture(['audit', 'head'])).stdout

/** Verify against a head kept earlier. */
const verifyAt = async (text: string) => verify(await anchorFile(text))

/** The stored line at `seq`, newline excluded, exactly as on disk. */
const lineAt = (seq: number): string => storeLines().find((l) => seqOf(l) === seq)!

/** The first line of the last segment, parsed. */
const openedLine = () =>
  JSON.parse(readFileSync(join(auditDir(), segmentFiles().at(-1)!), 'utf8').split('\n')[0]!) as {
    type: string
    warplineseq: number
    data: { fragment: unknown; passed_over?: { seq: number; sha256: string }[] }
  }

const passOver = (...seqs: (number | string)[]) => capture(['audit', 'pass-over', ...seqs.map(String)])

describe('audit pass-over', () => {
  test('a line the walk stops on, with records after it, is passed over in a new segment, and verify is clean against anchors taken before and after', async () => {
    const { seq: intent } = await mailer()
    const h0 = await headText()
    const bad = badIntent()
    await grow(2)
    const h1 = await headText()
    expect((await verifyAt(h1)).code).toBe(6)
    const [oldName] = segmentFiles() as [string]
    const oldBytes = readFileSync(join(auditDir(), oldName))
    const badLine = lineAt(bad)

    const r = await passOver(bad)

    expect(r.code).toBe(0)
    expect(r.stderr).toBe('')
    expect(r.stdout).not.toContain('WALK_SENTINEL_5d1')
    expect(r.stderr).not.toContain('WALK_SENTINEL_5d1')
    expect(readFileSync(join(auditDir(), oldName)).equals(oldBytes)).toBe(true)
    expect(segmentFiles()).toHaveLength(2)
    const opened = openedLine()
    expect(opened.type).toBe('warpline.audit.segment.opened')
    expect(opened.data.passed_over).toEqual([{ seq: bad, sha256: sha(Buffer.from(badLine, 'utf8')) }])

    for (const h of [h0, h1]) {
      const v = await verifyAt(h)
      expect(v.stdout).toContain('verdict: clean\n')
      expect(v.stdout).toContain(`open intent: seq ${intent} plugin mailer run run-77\n`)
      expect(unreadableLines(v.stdout)).toEqual([])
      expect(v.code).toBe(0)
    }
    const h2 = await headText()

    await grow(1)
    await grow(1, { maxSegmentBytes: 1 })
    expect((await capture(['principal', 'list'])).code).toBe(0)

    for (const h of [h0, h1, h2]) {
      const v = await verifyAt(h)
      expect(v.stdout).toContain('verdict: clean\n')
      expect(v.code).toBe(0)
    }
    expect(walkChain(auditDir()).ok).toBe(true)
  })

  test('state recorded after a passed-over line is carried into the new segment.opened: an outcome closes, a later intent opens, and preferences and principals move on', async () => {
    const { seq: intent } = await mailer()
    const bad = badIntent()
    const prefs = sha('carried preferences')
    const registry = sha('carried registry')
    const entry = sha('carried entry for ops')
    await appendAudit(statePath(), 'fire.outcome', { plugin: 'mailer', run_id: 'run-77', intent_seq: intent, status: 'success' })
    const { seq: late } = await appendAudit(statePath(), 'fire.intent', {
      plugin: 'late',
      run_id: 'run-79',
      class: 'session',
      effect_id: null,
      fingerprint: null,
    })
    await appendAudit(statePath(), 'preference.set', { key: 'review_gate', old: null, new: prefs })
    await appendAudit(statePath(), 'principal.added', { id: 'ops', type: 'human', key_sha256: null, sha256: registry, entry_sha256: entry })

    expect((await passOver(bad)).code).toBe(0)

    const first = readFileSync(join(auditDir(), segmentFiles().at(-1)!), 'utf8').split('\n')[0]!
    const opened = JSON.parse(first) as { type: string; data: { open_intents: unknown; authority: unknown } }
    expect(opened.type).toBe('warpline.audit.segment.opened')
    expect(opened.data.open_intents).toEqual([{ seq: late, plugin: 'late', run_id: 'run-79', effect_id: null }])
    expect(opened.data.authority).toEqual({ preferences: prefs, principals: { sha256: registry, entries: { ops: entry } } })
  })

  test('a passed_over entry whose sha256 or seq does not match the line it names is tampered, with a reason naming the opened seq and that entry', async () => {
    await mailer()
    const bad1 = badIntent()
    const bad2 = badIntent()
    const h1 = await headText()
    expect((await passOver(bad1, bad2)).code).toBe(0)
    const path = join(auditDir(), segmentFiles().at(-1)!)
    const original = readFileSync(path)
    const text = original.toString('utf8')
    expect(text.indexOf('\n')).toBe(text.length - 1)
    const opened = seqOf(text.slice(0, -1))
    expect(openedLine().data.passed_over?.map((e) => e.seq)).toEqual([bad1, bad2])

    type Entry = { seq: number; sha256: string }
    const named = (seq: number) => `reason: seq ${opened}'s passed_over entry for seq ${seq} does not match the segment before it`
    const edits: [string, (entries: Entry[]) => void, string][] = [
      ["the second entry's sha256 is wrong", (es) => void (es[1]!.sha256 = 'f'.repeat(64)), named(bad2)],
      ['the first entry names a real line of the segment before, with another hash', (es) => void (es[0]!.seq = bad1 - 1), named(bad1 - 1)],
      ['the second entry names a seq that is not a line of the segment before', (es) => void (es[1]!.seq = opened), named(opened)],
      ['the entries do not rise', (es) => void es.reverse(), `reason: seq ${opened}'s passed_over does not match the segment before it`],
    ]
    for (const [what, edit, reason] of edits) {
      const rec = JSON.parse(text) as { data: { passed_over: Entry[] } }
      edit(rec.data.passed_over)
      writeFileSync(path, `${JSON.stringify(rec)}\n`)

      const v = await verifyAt(h1)

      expect({ what, code: v.code }).toEqual({ what, code: 4 })
      expect(v.stdout).toContain('verdict: tampered\n')
      expect({ what, reason: v.stdout.split('\n').filter((l) => l.startsWith('reason: ')) }).toEqual({ what, reason: [reason] })
      if (what === 'the entries do not rise') expect(v.stdout).not.toContain('entry for seq')
      writeFileSync(path, original)
    }

    const v = await verifyAt(h1)
    expect(v.stdout).toContain('verdict: clean\n')
    expect(v.code).toBe(0)
  })

  test('pass-over refuses the opening line, a line outside the active segment, a line the walk carries and a store another line still stops, writing nothing, and passes over every line once all are named', async () => {
    await twoSegments()
    const { seq: intent } = await mailer()
    const bad1 = badIntent()
    await grow(1)
    const bad2 = badIntent()
    const activeFirst = Number(segmentFiles().at(-1)!.slice(0, 16))
    const { seq: head } = await readHead(statePath())
    const before = await snapshotHome(home)

    const refused = async (seqs: number[]): Promise<string> => {
      const r = await passOver(...seqs)
      expect({ seqs, code: r.code }).toEqual({ seqs, code: 1 })
      expect(r.stderr.trimEnd().endsWith('Nothing was written.')).toBe(true)
      expect(r.stderr).not.toContain('WALK_SENTINEL_5d1')
      expect(await snapshotHome(home)).toEqual(before)
      return r.stderr
    }
    expect(await refused([activeFirst])).toContain(`seq ${activeFirst} opens the active segment and cannot be passed over`)
    for (const seq of [2, head + 1, intent]) {
      expect(await refused([seq])).toContain(`seq ${seq} is not a line the walk stops on in the active segment`)
    }
    const stillStops = await refused([bad1])
    expect(stillStops).toContain(`seq ${bad2} `)
    expect(stillStops).toContain('fire.intent')

    const h = await headText()
    const r = await passOver(bad2, bad1)
    expect(r.code).toBe(0)
    expect(openedLine().data.passed_over).toEqual([
      { seq: bad1, sha256: sha(Buffer.from(lineAt(bad1), 'utf8')) },
      { seq: bad2, sha256: sha(Buffer.from(lineAt(bad2), 'utf8')) },
    ])
    const v = await verifyAt(h)
    expect(v.stdout).toContain('verdict: clean\n')
    expect(v.code).toBe(0)
  })

  test('a pass-over under a due rotation seals the active segment and writes its Checkpoint; with none due it writes only segment.opened', async () => {
    const kinds = (name: string) =>
      readFileSync(join(auditDir(), name), 'utf8').trimEnd().split('\n').map((l) => (JSON.parse(l) as { type: string }).type)

    await mailer()
    const bad = badIntent()
    const [first] = segmentFiles() as [string]
    const r = await passOverLib(statePath(), [bad])
    expect(segmentFiles()).toHaveLength(2)
    expect(kinds(first).at(-1)).not.toBe('warpline.audit.segment.sealed')
    expect(kinds(segmentFiles().at(-1)!)).toEqual(['warpline.audit.segment.opened'])
    expect(r.seq).toBe(r.opened)

    const bad2 = badIntent()
    const [, second] = segmentFiles() as [string, string]
    const due = await passOverLib(statePath(), [bad2], { maxSegmentBytes: 1 })
    expect(segmentFiles()).toHaveLength(3)
    expect(kinds(second).at(-1)).toBe('warpline.audit.segment.sealed')
    const third = readFileSync(join(auditDir(), segmentFiles().at(-1)!), 'utf8').trimEnd().split('\n')
    expect(third.map((l) => (JSON.parse(l) as { type: string }).type)).toEqual([
      'warpline.audit.segment.opened',
      'warpline.audit.checkpoint.recorded',
    ])
    const cp = JSON.parse(third[1]!) as { data: { size: number; root: string } }
    expect(cp.data.size).toBe(due.opened)
    expect(cp.data.root).toBe(sha(Buffer.from(third[0]!, 'utf8')))
    expect(openedLine().data.passed_over?.map((e) => e.seq)).toEqual([bad2])
    expect(walkChain(auditDir()).ok).toBe(true)
  })

  test('the opening line of the active segment cannot be passed over, and a walk stopped there names no pass-over', async () => {
    await grow(2)
    const [name] = segmentFiles() as [string]
    const first = Number(name.slice(0, 16))
    expect(first).toBe(1)
    const before = await snapshotHome(home)

    const r = await passOver(first)

    expect(r.code).toBe(1)
    expect(r.stderr).toContain(`seq ${first} opens the active segment and cannot be passed over`)
    expect(r.stderr.trimEnd().endsWith('Nothing was written.')).toBe(true)
    expect(await snapshotHome(home)).toEqual(before)

    // The opening line replaced by hand with one that is not a record, every other line kept.
    const path = join(auditDir(), name)
    const text = readFileSync(path, 'utf8')
    writeFileSync(path, `${GARBLED}\n${text.slice(text.indexOf('\n') + 1)}`)

    const listed = await capture(['principal', 'list'])
    expect(listed.code).toBe(1)
    expect(listed.stderr).toContain(`seq ${first} opens the active segment`)
    expect(listed.stderr).not.toContain('warpline audit pass-over')
    expect(listed.stderr).not.toContain('WALK_SENTINEL_5d1')
  })

  test('an active segment whose only line is an opening line that is not a record is refused by pass-over and by the walk, and neither names a pass-over', async () => {
    await grow(1)
    const [name] = segmentFiles() as [string]
    const first = Number(name.slice(0, 16))
    writeFileSync(join(auditDir(), name), `${GARBLED}\n`)
    const before = await snapshotHome(home)

    for (const seqs of [[first], [first + 1]]) {
      const r = await passOver(...seqs)
      expect({ seqs, code: r.code }).toEqual({ seqs, code: 1 })
      expect(r.stderr).toContain(`seq ${first} opens the active segment`)
      expect(r.stderr).not.toContain('warpline audit pass-over')
      expect(r.stderr).not.toContain('WALK_SENTINEL_5d1')
      expect(r.stderr.trimEnd().endsWith('Nothing was written.')).toBe(true)
      expect(await snapshotHome(home)).toEqual(before)
    }

    const listed = await capture(['principal', 'list'])
    expect(listed.code).toBe(1)
    expect(listed.stderr).toContain(`seq ${first} opens the active segment`)
    expect(listed.stderr).not.toContain('warpline audit pass-over')
    expect(listed.stderr).not.toContain('WALK_SENTINEL_5d1')
  })

  test('a malformed pass-over is a usage error, and a home with no store is refused without creating one', async () => {
    const none = await passOver(2)
    expect(none.code).toBe(1)
    expect(none.stderr).toContain('no segment to pass over')
    expect(present(auditDir())).toBe(false)

    await grow(3)
    const before = await snapshotHome(home)
    for (const argv of [[], ['0'], ['01'], ['1e3'], ['abc'], ['--seq', '2'], ['2', '-x']]) {
      const { code, stdout, stderr } = await capture(['audit', 'pass-over', ...argv])
      expect({ argv, code, stdout }).toEqual({ argv, code: 1, stdout: '' })
      expect(stderr).toContain('warpline audit pass-over <seq>')
    }
    expect(await snapshotHome(home)).toEqual(before)
  })

  test('a pass-over over a torn active segment acknowledges the fragment beside the line it passes over', async () => {
    await mailer()
    const bad = badIntent()
    const h1 = await headText()
    appendFileSync(join(auditDir(), segmentFiles().at(-1)!), '{"specversion":"1.0","id":')

    const r = await passOver(bad)

    expect(r.code).toBe(0)
    const opened = openedLine()
    expect(opened.data.fragment).not.toBeNull()
    expect(opened.data.passed_over?.map((e) => e.seq)).toEqual([bad])
    const v = await verifyAt(h1)
    expect(v.stdout).toContain('verdict: torn\n')
    expect(unreadableLines(v.stdout)).toEqual([])
    expect(v.code).toBe(3)
  })
})

// -- A line that is not a record -----------------------------------------------

/** The line `garble()` adds, without its newline. */
const GARBLED = 'not a record WALK_SENTINEL_5d1'

/**
 * A complete last line that is not a record, added by hand to the active
 * segment, as a write that went wrong leaves one. Resolves its positional seq,
 * one past the head, and its bytes without the newline.
 */
async function garble(): Promise<{ seq: number; bytes: Buffer }> {
  const { seq } = await readHead(statePath())
  appendFileSync(join(auditDir(), segmentFiles().at(-1)!), `${GARBLED}\n`)
  return { seq: seq + 1, bytes: Buffer.from(GARBLED, 'utf8') }
}

/** A segment's file name, from its first seq. */
const nameOf = (seq: number): string => `${String(seq).padStart(16, '0')}.jsonl`

/** Each `reason:` line verify printed. */
const reasons = (stdout: string): string[] => stdout.split('\n').filter((l) => l.startsWith('reason: '))

describe('a line that is not a record', () => {
  test('at the end of the active segment is passed over in a new segment that opens after the last record before it, and verify reads clean against anchors taken before and after', async () => {
    const { seq: intent } = await mailer()
    await grow(1)
    const h0 = await headText()
    const before = lastLine()
    const { seq: g, bytes } = await garble()
    const [oldName] = segmentFiles() as [string]
    const oldBytes = readFileSync(join(auditDir(), oldName))

    const stopped = await verifyAt(h0)
    expect(stopped.code).toBe(4)
    expect(stopped.stdout).toContain('verdict: tampered\n')
    expect(reasons(stopped.stdout)).toEqual([`reason: seq ${g} is not a record`])

    const r = await passOver(g)

    expect(r.code).toBe(0)
    expect(r.stderr).toBe('')
    expect(r.stdout).toContain(`opens at seq ${g}`)
    expect(r.stdout).not.toContain('WALK_SENTINEL_5d1')
    expect(readFileSync(join(auditDir(), oldName)).equals(oldBytes)).toBe(true)
    expect(segmentFiles()).toEqual([oldName, nameOf(g)])
    const newText = readFileSync(join(auditDir(), nameOf(g)), 'utf8')
    expect(newText).not.toContain('WALK_SENTINEL_5d1')
    const firstNew = newText.split('\n')[0]!
    const opened = JSON.parse(firstNew) as {
      type: string
      warplineseq: number
      warplineprev: string
      data: { passed_over?: unknown; open_intents: unknown[] }
    }
    expect(opened.type).toBe('warpline.audit.segment.opened')
    expect(opened.warplineseq).toBe(g)
    expect(opened.warplineprev).toBe(sha(Buffer.from(before, 'utf8')))
    expect(opened.data.passed_over).toEqual([{ seq: g, sha256: createHash('sha256').update(bytes).digest('hex') }])
    expect(opened.data.open_intents).toContainEqual({ seq: intent, plugin: 'mailer', run_id: 'run-77', effect_id: null })

    const clean = await verifyAt(h0)
    expect(clean.stdout).toContain('verdict: clean\n')
    expect(clean.stdout).toContain(`open intent: seq ${intent} plugin mailer run run-77\n`)
    expect(unreadableLines(clean.stdout)).toEqual([])
    expect(clean.code).toBe(0)

    const h2 = await headText()
    expect(h2).toBe(`${g} ${sha(Buffer.from(firstNew, 'utf8'))}\n`)
    await grow(1)
    expect((await capture(['principal', 'list'])).code).toBe(0)
    for (const h of [h0, h2]) {
      const v = await verifyAt(h)
      expect(v.stdout).toContain('verdict: clean\n')
      expect(v.code).toBe(0)
    }
  })

  test('at the end of the active segment leaves audit head refusing without a stack and export printing every line, while appends and principal list refuse until the pass-over', async () => {
    await mailer()
    const { seq: g } = await garble()
    const path = join(auditDir(), segmentFiles().at(-1)!)
    const bytes = readFileSync(path)

    for (const argv of [['audit', 'head'], ['audit', 'head', '--c2sp']]) {
      const { code, stdout, stderr } = await capture(argv)
      expect({ argv, code, stdout }).toEqual({ argv, code: 1, stdout: '' })
      expect(stderr).toContain('no head to print')
      expect(stderr).toContain('warpline audit pass-over')
      expect(stderr).not.toContain('WALK_SENTINEL_5d1')
    }

    const exported = await capture(['audit', 'export', '--after', '0'])
    expect(exported.code).toBe(0)
    expect(exported.stdout).toBe(bytes.toString('utf8'))

    let reason: unknown
    try {
      await appendAudit(statePath(), 'denial.lifted', { plugin: 'plugin-x-zq', fingerprint: null })
    } catch (err) {
      reason = (err as { reason?: unknown }).reason
    }
    expect(reason).toBe('the active segment holds no readable last line')

    const listed = await capture(['principal', 'list'])
    expect(listed.code).toBe(1)
    expect(listed.stderr).toContain(`seq ${g} is not a record`)
    expect(listed.stderr).not.toContain('WALK_SENTINEL_5d1')
    expect(readFileSync(path).equals(bytes)).toBe(true)
  })

  test('with records after it in its segment is passed over and the walk goes on, and verify still reports it tampered', async () => {
    await mailer()
    await grow(1)
    const h0 = await headText()
    const path = join(auditDir(), segmentFiles().at(-1)!)
    const text = readFileSync(path, 'utf8')
    const lastStart = text.lastIndexOf('\n', text.length - 2) + 1
    writeFileSync(path, `${text.slice(0, lastStart)}${GARBLED}\n${text.slice(lastStart)}`)
    const m = text.slice(0, lastStart).split('\n').length

    await grow(1)
    const stopped = await verifyAt(h0)
    expect(stopped.code).toBe(4)
    expect(reasons(stopped.stdout)).toEqual([`reason: seq ${m} is not a record`])
    expect((await capture(['principal', 'list'])).code).toBe(1)

    expect((await passOver(m)).code).toBe(0)
    expect((await capture(['principal', 'list'])).code).toBe(0)
    const after = await verifyAt(h0)
    expect(after.code).toBe(4)
    expect(after.stdout).toContain('verdict: tampered\n')
    expect(reasons(after.stdout)).toEqual([`reason: seq ${m} is not a record`])
  })

  test('passed over at the end of a segment is tampered when the next segment.opened does not name it', async () => {
    await mailer()
    const h0 = await headText()
    const { seq: g } = await garble()
    expect((await passOver(g)).code).toBe(0)
    const path = join(auditDir(), segmentFiles().at(-1)!)
    const original = readFileSync(path)
    const text = original.toString('utf8')
    expect(text.indexOf('\n')).toBe(text.length - 1)

    const rec = JSON.parse(text) as { data: { passed_over?: unknown } }
    delete rec.data.passed_over
    writeFileSync(path, `${JSON.stringify(rec)}\n`)
    const unnamed = await verifyAt(h0)
    expect(unnamed.code).toBe(4)
    expect(reasons(unnamed.stdout)).toEqual([`reason: seq ${g} is not a record`])

    writeFileSync(path, original)
    const v = await verifyAt(h0)
    expect(v.stdout).toContain('verdict: clean\n')
    expect(v.code).toBe(0)
  })

  test('that replaced the anchored record is passed over, and verify against that anchor is still tampered', async () => {
    await grow(1)
    const h1 = await headText()
    await grow(1)
    const hk = await headText()
    const k = Number(hk.split(' ')[0])
    const path = join(auditDir(), segmentFiles().at(-1)!)
    const text = readFileSync(path, 'utf8')
    writeFileSync(path, `${text.slice(0, text.lastIndexOf('\n', text.length - 2) + 1)}${GARBLED}\n`)

    expect((await passOver(k)).code).toBe(0)

    const anchored = await verifyAt(hk)
    expect(anchored.code).toBe(4)
    expect(anchored.stdout).toContain('verdict: tampered\n')
    expect(reasons(anchored.stdout)).toEqual([`reason: seq ${k} does not hash to the anchor`])
    const earlier = await verifyAt(h1)
    expect(earlier.stdout).toContain('verdict: clean\n')
    expect(earlier.code).toBe(0)
  })

  test('at the end of the active segment is passed over with no seal or Checkpoint, even with a rotation due', async () => {
    await mailer()
    const h0 = await headText()
    const { seq: g } = await garble()
    const [oldName] = segmentFiles() as [string]
    const oldBytes = readFileSync(join(auditDir(), oldName))

    const r = await passOverLib(statePath(), [g], { maxSegmentBytes: 1 })

    expect(r.opened).toBe(g)
    expect(readFileSync(join(auditDir(), oldName)).equals(oldBytes)).toBe(true)
    expect(segmentFiles()).toEqual([oldName, nameOf(g)])
    const newText = readFileSync(join(auditDir(), nameOf(g)), 'utf8')
    expect(newText.indexOf('\n')).toBe(newText.length - 1)
    const v = await verifyAt(h0)
    expect(v.stdout).toContain('verdict: clean\n')
    expect(v.code).toBe(0)
  })

  // A pass-over that dies between creating its segment and writing to it leaves either.
  const successors: [string, string][] = [
    ['at the end of a segment whose successor is empty is tampered, naming its seq', ''],
    ['at the end of a segment whose successor holds only a partial line is tampered, naming its seq', '{"specversion":"1.0","id":'],
  ]
  for (const [title, bytes] of successors) {
    test(title, async () => {
      await mailer()
      const h0 = await headText()
      const { seq: g } = await garble()
      writeFileSync(join(auditDir(), nameOf(g)), bytes)

      const { code, stdout } = await verifyAt(h0)

      expect(stdout).toContain('verdict: tampered\n')
      expect(code).toBe(4)
      expect(reasons(stdout)).toEqual([`reason: seq ${g} is not a record`])
      expect(unreadableLines(stdout)).toHaveLength(1)
      expect(stdout).not.toContain('WALK_SENTINEL_5d1')
    })
  }

  test('passed over at the end of a segment shares its position with the opening line after it, and export prints it only for an --after below the last record before it', async () => {
    await mailer()
    await grow(1)
    const { seq: g } = await garble()
    const [oldName] = segmentFiles() as [string]
    const oldText = readFileSync(join(auditDir(), oldName), 'utf8')
    const oldLines = oldText.split('\n').slice(0, -1)
    expect(oldLines.at(-1)).toBe(GARBLED)

    expect((await passOver(g)).code).toBe(0)
    expect(segmentFiles()).toEqual([oldName, nameOf(g)])
    const newText = readFileSync(join(auditDir(), nameOf(g)), 'utf8')
    expect(seqOf(newText.split('\n')[0]!)).toBe(g)

    const exported = async (after: number): Promise<string> => {
      const r = await capture(['audit', 'export', '--after', String(after)])
      expect(r.code).toBe(0)
      return r.stdout
    }
    expect(await exported(g - 1)).toBe(newText)
    expect(await exported(g - 2)).toBe(`${oldLines.at(-2)}\n${GARBLED}\n${newText}`)
    expect(await exported(0)).toBe(oldText + newText)
  })
})

// -- A walk that stops names the way past it -----------------------------------

describe('a walk that stops names the way past it', () => {
  const stops: [string, () => Promise<number>][] = [
    ['a line holding data the walk cannot carry', async () => badIntent()],
    ['a last line that is not a record', async () => (await garble()).seq],
  ]
  for (const [what, stop] of stops) {
    test(`every verb that needs the walk, and verify, name warpline audit pass-over: ${what}`, async () => {
      await mailer()
      const h0 = await headText()
      const s = await stop()

      const verbs: [string[], number][] = [
        [['principal', 'list'], 1],
        [['prefs', 'set', 'review_gate', 'true'], 1],
        [['advance'], 75],
        [['resolve', '--intent', String(s), '--shipped'], 1],
      ]
      for (const [argv, want] of verbs) {
        const { code, stderr } = await capture(argv)
        expect({ argv, code }).toEqual({ argv, code: want })
        expect(stderr).toContain(`seq ${s} `)
        expect(stderr).toContain('warpline audit pass-over')
        expect(stderr).not.toContain('WALK_SENTINEL_5d1')
      }

      const v = await verifyAt(h0)
      const named = unreadableLines(v.stdout)
      expect(named).toHaveLength(1)
      expect(named[0]).toContain('warpline audit pass-over')
      expect(v.stdout).not.toContain('WALK_SENTINEL_5d1')
    })
  }
})
