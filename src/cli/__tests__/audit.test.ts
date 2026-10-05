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
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { appendAudit, readHead } from '../../lib/audit-log.js'
import { _setHome } from '../../lib/paths.js'
import { forge, walkChain, type ForgeOp } from '../../lib/__tests__/helpers/audit-chain.js'
import { snapshotHome } from '../../runtime/__tests__/helpers/snapshot-home.js'
import { testFixturesDir } from '../../../test-utils/fixtures.js'
import { main } from '../warpline.js'

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
    expect(existsSync(join(home, 'audit'))).toBe(false)
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
  for (let i = 0; !existsSync(auditDir()) || segmentFiles().length < 2; i++) {
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
    expect(existsSync(join(auditDir(), '.lock'))).toBe(false)
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
    expect(existsSync(auditDir())).toBe(false)
  })

  test('--c2sp takes no lock and adds no byte to the store', async () => {
    await grow(3)
    const before = await snapshotHome(auditDir())

    const { code } = await capture(['audit', 'head', '--c2sp'])

    expect(code).toBe(0)
    expect(await snapshotHome(auditDir())).toEqual(before)
  })
})
