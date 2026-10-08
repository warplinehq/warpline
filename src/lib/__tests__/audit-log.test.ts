/**
 * The audit store's own rules, pinned at the module.
 *
 * Every case gets its own temp home and passes the state file path the way a
 * caller does. The file need not exist: the store is the state file's
 * grandparent plus `audit`, so `<tmp>/state/engine-state.json` puts it at
 * `<tmp>/audit`.
 *
 * Expected hashes are computed here with `node:crypto`, never with a helper
 * from the module under test. A check that borrowed the writer's hashing would
 * agree with it by construction.
 *
 * Everything this file writes goes under temp dirs (AGENTS.md Rule 2).
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { open } from 'node:fs/promises'
import { spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as audit from '../audit-log.js'
import { deriveHost } from '../host-identity.js'
import * as hostIdentity from '../host-identity.js'
import { appendRelinked } from './helpers/audit-chain.js'
import { snapshotHome } from '../../runtime/__tests__/helpers/snapshot-home.js'
import { testFixturesDir } from '../../../test-utils/fixtures.js'

const ZEROS = '0'.repeat(64)
const HEX_A = 'a'.repeat(64)
const PACKAGE_VERSION = (
  JSON.parse(readFileSync(testFixturesDir(import.meta.url, '../../../package.json'), 'utf-8')) as {
    version: string
  }
).version

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

let tmp: string
let statePath: string
let auditDir: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'warpline-audit-log-'))
  statePath = join(tmp, 'state', 'engine-state.json')
  auditDir = join(tmp, 'audit')
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

/** The active segment's lines, split on newline, the empty tail dropped. */
function segmentLines(): string[] {
  const text = readFileSync(join(auditDir, '0000000000000001.jsonl'), 'utf-8')
  expect(text.endsWith('\n')).toBe(true)
  return text.slice(0, -1).split('\n')
}

const lift = () => audit.appendAudit(statePath, 'denial.lifted', { plugin: 'p', fingerprint: HEX_A })

describe('audit store: genesis and the chain', () => {
  test('readHead on a home with no store is seq 0 and 64 zeros, and creates nothing', async () => {
    expect(await audit.readHead(statePath)).toEqual({ seq: 0, head: '0'.repeat(64) })
    expect(present(auditDir)).toBe(false)
  })

  test('the first append writes genesis then the record, chained over the written bytes', async () => {
    const result = await lift()

    expect(readdirSync(auditDir)).toEqual(['0000000000000001.jsonl'])
    const lines = segmentLines()
    expect(lines).toHaveLength(2)

    const genesis = JSON.parse(lines[0]!)
    expect(Object.keys(genesis)).toEqual([
      'specversion',
      'id',
      'source',
      'type',
      'time',
      'datacontenttype',
      'warplineseq',
      'warplineprev',
      'data',
    ])
    expect(genesis.specversion).toBe('1.0')
    expect(genesis.id).toBe('1')
    expect(genesis.type).toBe('warpline.audit.segment.opened')
    expect(genesis.datacontenttype).toBe('application/json')
    expect(genesis.warplineseq).toBe(1)
    expect(genesis.warplineprev).toBe(ZEROS)
    expect(genesis.source).toMatch(/^urn:uuid:[0-9a-f-]{36}$/)
    expect(genesis.data.home).toBe(genesis.source)
    expect(genesis.data.version).toBe(PACKAGE_VERSION)
    expect(genesis.data.fragment).toBeNull()
    expect(genesis.data.authority).toEqual({ preferences: null, principals: null })
    expect(genesis.data.open_intents).toEqual([])

    const record = JSON.parse(lines[1]!)
    expect(Object.keys(record)).toEqual(Object.keys(genesis))
    expect(record.id).toBe('2')
    expect(record.warplineseq).toBe(2)
    expect(record.type).toBe('warpline.audit.denial.lifted')
    expect(record.source).toBe(genesis.source)
    expect(record.warplineprev).toBe(sha256(lines[0]!))
    expect(Number.isNaN(Date.parse(record.time))).toBe(false)
    expect(record.data).toEqual({ plugin: 'p', fingerprint: HEX_A })

    expect(result).toEqual({ seq: 2, head: sha256(lines[1]!) })
    expect(await audit.readHead(statePath)).toEqual(result)
  })
})

describe('audit store: what it refuses writes nothing and echoes nothing', () => {
  /** Refuse, and prove the refusal wrote nothing and named the right error. */
  async function refuses(append: () => Promise<unknown>): Promise<Error> {
    await lift()
    const before = await snapshotHome(tmp)
    let caught: unknown
    try {
      await append()
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).name).toBe('AuditAppendError')
    expect(await snapshotHome(tmp)).toEqual(before)
    return caught as Error
  }

  const anyAppend = audit.appendAudit as (s: string, k: string, d: unknown) => Promise<unknown>

  test('a kind outside the closed set', async () => {
    await refuses(() => anyAppend(statePath, 'bogus.kind', {}))
  })

  for (const kind of ['segment.opened', 'segment.sealed', 'checkpoint.recorded']) {
    test(`the internal kind ${kind}`, async () => {
      await refuses(() => anyAppend(statePath, kind, {}))
    })
  }

  for (const kind of ['grant.renewed', 'ask.raised', 'ask.answered', 'handoff.tried']) {
    test(`the pending kind ${kind}, whose schema admits nothing yet`, async () => {
      await refuses(() => anyAppend(statePath, kind, {}))
    })
  }

  test('data with a key its kind does not declare', async () => {
    await refuses(() => anyAppend(statePath, 'denial.lifted', { plugin: 'p', fingerprint: HEX_A, extra: 1 }))
  })

  test('a digest that is not hex, without echoing it', async () => {
    const err = await refuses(() =>
      anyAppend(statePath, 'denial.lifted', { plugin: 'p', fingerprint: 'NOT-HEX-SENTINEL-1234' }),
    )
    expect(err.message).not.toContain('NOT-HEX-SENTINEL-1234')
  })

  test('a line over 16384 bytes', async () => {
    const scopes = Array.from({ length: 200 }, (_, i) => `${String(i).padStart(3, '0')}${'s'.repeat(97)}`)
    await refuses(() =>
      anyAppend(statePath, 'grant.issued', { scopes, ttl_ms: null, replace: false, long: false }),
    )
  })
})

/**
 * The audit lock as a case sees it. A held lock is a symbolic link whose text
 * names its holder, and whose target does not exist. So every presence check
 * on it uses lstat: a check that follows the link reads a held lock as absent,
 * and every 'no lock left' assertion would then pass whatever the store did.
 */
const lockPath = () => join(auditDir, '.lock')
const breakPath = () => join(auditDir, '.lock.break')
const segmentPath = () => join(auditDir, '0000000000000001.jsonl')
const sixtySecondsAgo = () => new Date(Date.now() - 60_000)
const present = (path: string): boolean => lstatSync(path, { throwIfNoEntry: false }) !== undefined
const lockText = (path: string): string => readlinkSync(path, 'utf8')
const plantLock = (path: string, holder: object): void => symlinkSync(JSON.stringify(holder), path)

/**
 * This machine as the store names it in a lock: the machine identifier, and on
 * Linux that joined to the pid namespace and the boot id, or null when any part
 * is missing. Computed here from the identity module and `/proc`, not borrowed
 * from the store.
 */
const HOST: string | null = (() => {
  const base = deriveHost()
  if (base === null || process.platform !== 'linux') return base
  try {
    const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf-8').trim()
    return boot === '' ? null : `${base}:${readlinkSync('/proc/self/ns/pid')}:${boot}`
  } catch {
    return null
  }
})()

/** The pid of a process that has already exited, checked gone before use. */
function deadPid(): number {
  const { pid } = spawnSync(process.execPath, ['-e', '0'])
  try {
    process.kill(pid, 0)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return pid
  }
  throw new Error(`pid ${pid} is still running`)
}

/** A process idling until killed. Kill it in `finally`. */
const liveChild = () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })

type Settled = { settled: 'resolved'; value: { seq: number } } | { settled: 'rejected'; error: unknown } | { settled: 'pending' }

/** The append with a 300 ms lock timeout, raced against 3000 ms, so a spin fails the case instead of hanging the suite. */
function oddAppend(): { append: Promise<{ seq: number }>; settled: Promise<Settled> } {
  const append = audit.appendAudit(statePath, 'denial.lifted', { plugin: 'p', fingerprint: null }, { lockTimeoutMs: 300 })
  let timer: ReturnType<typeof setTimeout> | undefined
  const settled = Promise.race<Settled>([
    append.then(
      (value) => ({ settled: 'resolved' as const, value }),
      (error: unknown) => ({ settled: 'rejected' as const, error }),
    ),
    new Promise<Settled>((r) => (timer = setTimeout(() => r({ settled: 'pending' }), 3000))),
  ]).finally(() => clearTimeout(timer))
  return { append, settled }
}

/** Remove the odd lock and any break file, then let the append settle, so the in-process queue is clear for the next case. */
async function clear(append: Promise<unknown>): Promise<void> {
  rmSync(lockPath(), { recursive: true, force: true })
  rmSync(breakPath(), { force: true })
  await append.catch(() => {})
}

const rejected = (out: Settled): unknown => {
  expect(out.settled).toBe('rejected')
  return out.settled === 'rejected' ? out.error : undefined
}

/** The rejection's message, or undefined when the append did not reject. */
const refusal = async (out: Promise<Settled>): Promise<string | undefined> =>
  (rejected(await out) as Error | undefined)?.message

describe('audit store: the lock', () => {
  test('a lock held by a live holder makes the append reject once its timeout passes, and the lock stays', async () => {
    await lift()
    const lockPath = join(auditDir, '.lock')
    writeFileSync(lockPath, JSON.stringify({ token: 'held-by-other', at: Date.now() }))
    const segment = readFileSync(join(auditDir, '0000000000000001.jsonl'))

    const started = Date.now()
    let caught: unknown
    try {
      await audit.appendAudit(statePath, 'denial.lifted', { plugin: 'p', fingerprint: null }, { lockTimeoutMs: 200 })
    } catch (err) {
      caught = err
    }
    expect(Date.now() - started).toBeLessThan(2000)
    expect((caught as Error | undefined)?.name).toBe('AuditAppendError')
    expect(readFileSync(join(auditDir, '0000000000000001.jsonl'))).toEqual(segment)
    expect(readFileSync(lockPath, 'utf-8')).toContain('held-by-other')
  })

  test('a lock older than 30 s is never broken for its age, whether its holder is alive here or it cannot be read as a holder', async () => {
    await lift()
    const live = liveChild()
    try {
      plantLock(lockPath(), { token: 'aged-live', pid: live.pid, host: HOST, at: Date.now() - 31_000 })
      const text = lockText(lockPath())
      const linked = oddAppend()
      try {
        expect((rejected(await linked.settled) as Error | undefined)?.name).toBe('AuditAppendError')
        expect(lockText(lockPath())).toBe(text)
        expect(present(breakPath())).toBe(false)
      } finally {
        await clear(linked.append)
      }
    } finally {
      live.kill('SIGKILL')
    }

    writeFileSync(lockPath(), JSON.stringify({ token: 'aged', at: Date.now() - 31_000 }))
    const bytes = readFileSync(lockPath())
    const plain = oddAppend()
    try {
      expect((rejected(await plain.settled) as Error | undefined)?.name).toBe('AuditAppendError')
      expect(readFileSync(lockPath())).toEqual(bytes)
      expect(present(breakPath())).toBe(false)
    } finally {
      await clear(plain.append)
    }
  })

  test('20 appends issued at once from one process come out contiguous and whole', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => lift()))

    expect(new Set(results.map((r) => r.seq)).size).toBe(20)
    const lines = segmentLines()
    expect(lines).toHaveLength(21)
    expect(lines.map((l) => (JSON.parse(l) as { warplineseq: number }).warplineseq)).toEqual(
      Array.from({ length: 21 }, (_, i) => i + 1),
    )
  })
})

describe('the lock when its file is odd', () => {
  const root = process.getuid?.() === 0

  test('a lock that is a directory makes the append fail in time and writes nothing', async () => {
    await lift()
    mkdirSync(lockPath())
    const segment = readFileSync(segmentPath())
    const { append, settled } = oddAppend()
    try {
      expect((rejected(await settled) as Error | undefined)?.name).toBe('AuditAppendError')
      expect(readFileSync(segmentPath())).toEqual(segment)
    } finally {
      await clear(append)
    }
  })

  test('a lock that is a directory older than 30 s cannot be broken, and the append fails in time', async () => {
    await lift()
    mkdirSync(lockPath())
    utimesSync(lockPath(), sixtySecondsAgo(), sixtySecondsAgo())
    const segment = readFileSync(segmentPath())
    const { append, settled } = oddAppend()
    try {
      expect((rejected(await settled) as Error | undefined)?.name).toBe('AuditAppendError')
      expect(statSync(lockPath()).isDirectory()).toBe(true)
      expect(present(breakPath())).toBe(false)
      expect(readFileSync(segmentPath())).toEqual(segment)
    } finally {
      await clear(append)
    }
  })

  test('a lock that is a dangling symlink makes the append fail in time', async () => {
    await lift()
    symlinkSync(join(tmp, 'nothing-here'), lockPath())
    const segment = readFileSync(segmentPath())
    const { append, settled } = oddAppend()
    try {
      expect((rejected(await settled) as Error | undefined)?.name).toBe('AuditAppendError')
      expect(present(breakPath())).toBe(false)
      expect(readFileSync(segmentPath())).toEqual(segment)
    } finally {
      await clear(append)
    }
  })

  test.skipIf(root)(
    'a lock file the writer cannot read, older than 30 s, is never broken, and the append fails in time and the file stays',
    async () => {
      await lift()
      writeFileSync(lockPath(), JSON.stringify({ token: 'crashed', at: Date.now() - 60_000 }))
      chmodSync(lockPath(), 0o000)
      utimesSync(lockPath(), sixtySecondsAgo(), sixtySecondsAgo())
      const segment = readFileSync(segmentPath())
      const { append, settled } = oddAppend()
      try {
        expect((rejected(await settled) as Error | undefined)?.name).toBe('AuditAppendError')
        expect(present(lockPath())).toBe(true)
        expect(present(breakPath())).toBe(false)
        expect(readFileSync(segmentPath())).toEqual(segment)
      } finally {
        await clear(append)
      }
    },
  )

  test.skipIf(root)('a lock file the writer cannot read, and fresh, makes the append fail in time and stays', async () => {
    await lift()
    writeFileSync(lockPath(), JSON.stringify({ token: 'held-by-other', at: Date.now() }))
    chmodSync(lockPath(), 0o000)
    const segment = readFileSync(segmentPath())
    const { append, settled } = oddAppend()
    try {
      expect((rejected(await settled) as Error | undefined)?.name).toBe('AuditAppendError')
      expect(present(lockPath())).toBe(true)
      expect(readFileSync(segmentPath())).toEqual(segment)
    } finally {
      await clear(append)
    }
  })

  test.skipIf(HOST === null)(
    'a lock whose holder is gone on this machine, beside a break file that names no holder, fails in time naming the break file, and both stay',
    async () => {
      await lift()
      plantLock(lockPath(), { token: 'gone', pid: deadPid(), host: HOST, at: Date.now() })
      writeFileSync(breakPath(), '')
      utimesSync(breakPath(), sixtySecondsAgo(), sixtySecondsAgo())
      const text = lockText(lockPath())
      const segment = readFileSync(segmentPath())
      const { append, settled } = oddAppend()
      try {
        const message = await refusal(settled)
        expect(message).toContain('.lock.break')
        expect(message).toContain('remove audit/.lock.break by hand')
        expect(lockText(lockPath())).toBe(text)
        expect(present(breakPath())).toBe(true)
        expect(readFileSync(breakPath(), 'utf8')).toBe('')
        expect(readFileSync(segmentPath())).toEqual(segment)
      } finally {
        await clear(append)
      }
    },
  )
})

const STORE = join(import.meta.dir, '..', 'audit-log.ts')

type ChildMode =
  | 'exit'
  | 'replaced'
  | 'linux-boot'
  | 'linux-noboot'
  | 'linux-nons'
  | 'nolink-EPERM'
  | 'nolink-ENOTSUP'
  | 'nolink-ENOSYS'
  | 'nolink-EIO'
  | 'break-EACCES'
  | 'plain'
  | 'unlink-EACCES'
  | 'rejudge-retaken'
  | 'rejudge-released'
  | 'rejudge-alive'
  | 'break-EACCES-retaken'
  | 'break-EACCES-released'
  | 'break-EACCES-alive'
  | 'breakheld-retaken'
  | 'breakheld-stays'

/**
 * Runs a child that imports the store by absolute path and appends once, with a
 * `now` that acts inside the hold. `exit` exits 130 there. `replaced` puts
 * another holder's lock in place first, then exits 130.
 *
 * The three `linux-` modes claim the Linux platform and spy on `node:fs` before
 * they import the store, because a spy reaches the store's named imports only
 * when it is in place before the store loads. `linux-boot` serves a namespace
 * link and a boot id, `linux-noboot` fails the boot id read, and `linux-nons`
 * fails the namespace read. Every other path calls through. Their `now` prints
 * the lock's text.
 *
 * The `nolink-` modes and `break-EACCES` spy on `fs.symlinkSync` the same way,
 * before the store loads. In a `nolink-` mode every call throws an error whose
 * `code` is the mode's suffix, as a mount without symbolic links answers. In
 * `break-EACCES` only a call that makes `.lock.break` throws, with `EACCES`, and
 * every other call goes to the real function. These modes wait 300 ms for the
 * lock.
 *
 * The modes below change the lock after the store judged it, from inside the
 * store's first call that makes `.lock.break`. Each spies before the store
 * loads too. A live holder is `{ token: 'live' }` naming this test process,
 * which is the child's parent, and this machine. An alive one names token
 * 'gone' with that same pid.
 * - `rejudge-retaken`, `rejudge-released` and `rejudge-alive` make the break
 *   file, then put a live holder in the lock, leave no lock, or put an alive
 *   one in it, so the store judges it again under the break file.
 * - `break-EACCES-retaken`, `break-EACCES-released` and `break-EACCES-alive`
 *   change the lock the same way, then fail to make the break file with `EACCES`.
 * - `breakheld-retaken` puts a live holder in the lock, then answers `EEXIST`,
 *   as when another breaker holds the break file, and makes none.
 * - `breakheld-stays` answers `EEXIST` the same way and leaves the lock as it is.
 * - `unlink-EACCES` fails only the removal of the lock, with `EACCES`.
 * - `plain` changes nothing.
 * Every later call goes to the real function.
 *
 * `timeoutMs`, when given, is the wait for the lock. Without it every mode
 * keeps the wait above. The child is killed after 4 s, so one that never
 * settles fails its case instead of hanging the file. In every mode a rejected
 * append prints its message to stdout and exits 1.
 */
function childAppend(mode: ChildMode, timeoutMs?: number): ReturnType<typeof spawnSync> & { stdout: string } {
  const script = join(tmp, 'child-append.ts')
  writeFileSync(
    script,
    `import * as fs from 'node:fs'
import { spyOn } from 'bun:test'
const [statePath, mode, timeout] = process.argv.slice(2)
const lockPath = ${JSON.stringify(lockPath())}
const HOST = ${JSON.stringify(HOST)}
if (mode.startsWith('linux-')) {
  const realReadFileSync = fs.readFileSync
  const realReadlinkSync = fs.readlinkSync
  const missing = () => Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
  Object.defineProperty(process, 'platform', { value: 'linux' })
  spyOn(fs, 'readlinkSync').mockImplementation((path, ...rest) => {
    if (path === '/proc/self/ns/pid') {
      if (mode === 'linux-nons') throw missing()
      return 'pid:[4026531836]'
    }
    return realReadlinkSync(path, ...rest)
  })
  spyOn(fs, 'readFileSync').mockImplementation((path, ...rest) => {
    if (path === '/proc/sys/kernel/random/boot_id') {
      if (mode === 'linux-noboot') throw missing()
      return 'b0b0b0b0-1111-2222-3333-444455556666\\n'
    }
    return realReadFileSync(path, ...rest)
  })
}
const failsLinks = mode.startsWith('nolink-') || mode === 'break-EACCES'
const realSymlinkSync = fs.symlinkSync
const realUnlinkSync = fs.unlinkSync
const failing = (code) => Object.assign(new Error(code), { code })
if (failsLinks) {
  spyOn(fs, 'symlinkSync').mockImplementation((target, path, ...rest) => {
    if (mode.startsWith('nolink-')) throw failing(mode.slice('nolink-'.length))
    if (String(path).endsWith('.lock.break')) throw failing('EACCES')
    return realSymlinkSync(target, path, ...rest)
  })
}
// What the lock becomes after it was judged: a live holder, no lock, or the judged token with a live holder.
const changeTo = /^(rejudge|break-EACCES|breakheld)-(retaken|released|alive)$/.exec(mode)?.[2]
if (changeTo !== undefined) {
  const relock = () => {
    realUnlinkSync(lockPath)
    if (changeTo === 'released') return
    const token = changeTo === 'retaken' ? 'live' : 'gone'
    realSymlinkSync(JSON.stringify({ token, pid: process.ppid, host: HOST, at: Date.now() }), lockPath)
  }
  let first = true
  spyOn(fs, 'symlinkSync').mockImplementation((target, path, ...rest) => {
    if (!first || !String(path).endsWith('.lock.break')) return realSymlinkSync(target, path, ...rest)
    first = false
    if (mode.startsWith('rejudge-')) {
      const made = realSymlinkSync(target, path, ...rest)
      relock()
      return made
    }
    relock()
    throw failing(mode.startsWith('breakheld-') ? 'EEXIST' : 'EACCES')
  })
}
if (mode === 'breakheld-stays') {
  let first = true
  spyOn(fs, 'symlinkSync').mockImplementation((target, path, ...rest) => {
    if (!first || !String(path).endsWith('.lock.break')) return realSymlinkSync(target, path, ...rest)
    first = false
    throw failing('EEXIST')
  })
}
if (mode === 'unlink-EACCES') {
  spyOn(fs, 'unlinkSync').mockImplementation((path, ...rest) => {
    if (String(path) === lockPath) throw failing('EACCES')
    return realUnlinkSync(path, ...rest)
  })
}
const { appendAudit } = await import(${JSON.stringify(STORE)})
try {
  await appendAudit(statePath, 'denial.lifted', { plugin: 'p', fingerprint: null }, {
    ...(timeout !== undefined ? { lockTimeoutMs: Number(timeout) } : failsLinks ? { lockTimeoutMs: 300 } : {}),
    now: () => {
      if (mode === 'exit') process.exit(130)
      if (mode === 'replaced') {
        fs.unlinkSync(lockPath)
        fs.symlinkSync(JSON.stringify({ token: 'next-holder', pid: 1, host: null, at: Date.now() }), lockPath)
        process.exit(130)
      }
      process.stdout.write(fs.readlinkSync(lockPath, 'utf8'))
      return Date.now()
    },
  })
} catch (err) {
  process.stdout.write(err.message)
  process.exit(1)
}
`,
  )
  const args = timeoutMs === undefined ? [script, statePath, mode] : [script, statePath, mode, String(timeoutMs)]
  return spawnSync(process.execPath, args, { env: { ...process.env }, encoding: 'utf8', timeout: 4000 })
}

describe('the lock names its holder', () => {
  test('a held lock is a symbolic link that names its token, this process, this machine and its time', async () => {
    let linked = false
    let text = ''
    await audit.appendAudit(
      statePath,
      'denial.lifted',
      { plugin: 'p', fingerprint: null },
      {
        now: () => {
          linked = lstatSync(lockPath()).isSymbolicLink()
          if (linked) text = lockText(lockPath())
          return Date.now()
        },
      },
    )
    expect(linked).toBe(true)
    const lock = JSON.parse(text) as Record<string, unknown>
    expect(typeof lock.token).toBe('string')
    expect(lock.pid).toBe(process.pid)
    expect(lock.host).toBe(HOST)
    expect(typeof lock.at).toBe('number')
    expect(present(lockPath())).toBe(false)
  })

  test.skipIf(HOST === null)('a lock whose holder is gone on this machine is taken at once', async () => {
    await lift()
    plantLock(lockPath(), { token: 'gone', pid: deadPid(), host: HOST, at: Date.now() })
    const started = Date.now()
    const append = audit.appendAudit(statePath, 'denial.lifted', { plugin: 'p', fingerprint: null }, { lockTimeoutMs: 2000 })
    try {
      const out = await append.then(
        (value) => ({ settled: 'resolved' as const, value }),
        (error: unknown) => ({ settled: 'rejected' as const, error }),
      )
      expect(out.settled).toBe('resolved')
      expect(Date.now() - started).toBeLessThan(1000)
      expect(segmentLines()).toHaveLength(3)
      expect(present(lockPath())).toBe(false)
      expect(present(breakPath())).toBe(false)
    } finally {
      await clear(append)
    }
  })

  test.skipIf(HOST === null)(
    'a lock whose holder is alive on this machine is not taken, and the refusal names its pid, this machine and removal by hand',
    async () => {
      await lift()
      const live = liveChild()
      try {
        plantLock(lockPath(), { token: 'live', pid: live.pid, host: HOST, at: Date.now() })
        const text = lockText(lockPath())
        const segment = readFileSync(segmentPath())
        const { append, settled } = oddAppend()
        try {
          const message = await refusal(settled)
          expect(message).toContain('audit lock not acquired in time')
          expect(message).toContain(`pid ${live.pid} on this machine`)
          expect(message).toContain('remove audit/.lock by hand')
          expect(lockText(lockPath())).toBe(text)
          expect(readFileSync(segmentPath())).toEqual(segment)
        } finally {
          await clear(append)
        }
      } finally {
        live.kill('SIGKILL')
      }
    },
  )

  test('a lock that names no machine or no process is never broken, however old', async () => {
    await lift()
    const dead = deadPid()
    const holders: [object, string[]][] = [
      [{ token: 'nameless', pid: dead, host: null }, [`pid ${dead}`, 'not on this machine']],
      [{ token: 'nameless', pid: dead }, [`pid ${dead}`, 'not on this machine']],
      [{ token: 'nameless' }, ['names no process']],
    ]
    for (const [holder, words] of holders) {
      for (const at of [Date.now(), Date.now() - 31_000]) {
        plantLock(lockPath(), { ...holder, at })
        const text = lockText(lockPath())
        const { append, settled } = oddAppend()
        try {
          const message = await refusal(settled)
          for (const word of words) expect(message).toContain(word)
          expect(lockText(lockPath())).toBe(text)
        } finally {
          await clear(append)
        }
      }
    }
  })

  test('a lock from another machine, pid namespace or boot is never broken, however old, whatever its pid', async () => {
    await lift()
    const dead = deadPid()
    const ns = process.platform === 'linux' ? readlinkSync('/proc/self/ns/pid') : 'pid:[4026531836]'
    const hosts = [
      'f'.repeat(64),
      `${deriveHost()}:pid:[1]`,
      `${deriveHost()}:${ns}:00000000-0000-0000-0000-000000000000`,
    ]
    for (const host of hosts) {
      for (const at of [Date.now(), Date.now() - 31_000]) {
        plantLock(lockPath(), { token: 'foreign', pid: dead, host, at })
        const text = lockText(lockPath())
        const { append, settled } = oddAppend()
        try {
          expect(await refusal(settled)).toContain('not on this machine')
          expect(lockText(lockPath())).toBe(text)
        } finally {
          await clear(append)
        }
      }
    }
  })

  test.skipIf(HOST === null)(
    'a break file is never cleared, even one whose holder is gone on this machine or one older than 30 s, and the append refuses naming it',
    async () => {
      await lift()
      const dead = deadPid()
      const dead2 = deadPid()
      for (const breaker of [
        { token: 'breaker', pid: dead2, host: HOST, at: Date.now() },
        { token: 'breaker', pid: dead2, host: null, at: Date.now() - 31_000 },
      ]) {
        plantLock(lockPath(), { token: 'gone', pid: dead, host: HOST, at: Date.now() })
        plantLock(breakPath(), breaker)
        const lock = lockText(lockPath())
        const brk = lockText(breakPath())
        const { append, settled } = oddAppend()
        try {
          const message = await refusal(settled)
          expect(message).toContain('.lock.break')
          expect(message).toContain('remove audit/.lock.break by hand')
          expect(lockText(lockPath())).toBe(lock)
          expect(lockText(breakPath())).toBe(brk)
        } finally {
          await clear(append)
        }
      }
    },
  )

  test('a process that exits holding the lock removes it on the way out', async () => {
    await lift()
    const segment = readFileSync(segmentPath())
    const child = childAppend('exit')
    expect(child.status).toBe(130)
    expect(present(lockPath())).toBe(false)
    expect(readFileSync(segmentPath())).toEqual(segment)
  })

  test('the exit hook leaves a lock that holds another token', async () => {
    await lift()
    try {
      const child = childAppend('replaced')
      expect(child.status).toBe(130)
      expect(lockText(lockPath())).toContain('next-holder')
    } finally {
      rmSync(lockPath(), { force: true })
    }
  })

  test('on Linux the lock names the pid namespace and the boot id, and names no machine when either cannot be read', async () => {
    await lift()
    const base = deriveHost()
    const cases: [ChildMode, string | null][] = [
      ['linux-boot', base === null ? null : `${base}:pid:[4026531836]:b0b0b0b0-1111-2222-3333-444455556666`],
      ['linux-noboot', null],
      ['linux-nons', null],
    ]
    for (const [mode, host] of cases) {
      const child = childAppend(mode)
      expect(child.status).toBe(0)
      const lock = JSON.parse(child.stdout) as Record<string, unknown>
      expect(lock.pid).toBe(child.pid)
      expect(lock.host).toBe(host)
    }
  })

  test.skipIf(HOST === null)('a lock replaced between its judgment and the break is kept until it is judged itself', async () => {
    await lift()
    const dead = deadPid()
    const dead2 = deadPid()
    const real = hostIdentity.isProcessAlive
    let calls = 0
    let sightings = 0
    const spy = spyOn(hostIdentity, 'isProcessAlive').mockImplementation((pid: number) => {
      calls++
      if (calls === 1) {
        unlinkSync(lockPath())
        plantLock(lockPath(), { token: 'next', pid: dead2, host: HOST, at: Date.now() })
        return false
      }
      try {
        if (lockText(lockPath()).includes('"next"')) sightings++
      } catch {}
      return real(pid)
    })
    try {
      plantLock(lockPath(), { token: 'gone', pid: dead, host: HOST, at: Date.now() })
      const append = audit.appendAudit(statePath, 'denial.lifted', { plugin: 'p', fingerprint: null }, { lockTimeoutMs: 2000 })
      try {
        const out = await append.then(
          () => 'resolved',
          () => 'rejected',
        )
        expect(out).toBe('resolved')
        expect(sightings).toBeGreaterThanOrEqual(2)
        expect(present(lockPath())).toBe(false)
        expect(present(breakPath())).toBe(false)
      } finally {
        await clear(append)
      }
    } finally {
      spy.mockRestore()
    }
  })

  test.skipIf(HOST === null)(
    'a lock judged gone is judged again under the break file, and kept when its holder reads alive there',
    async () => {
      await lift()
      const dead = deadPid()
      let calls = 0
      const spy = spyOn(hostIdentity, 'isProcessAlive').mockImplementation(() => ++calls > 1)
      try {
        plantLock(lockPath(), { token: 'gone', pid: dead, host: HOST, at: Date.now() })
        const text = lockText(lockPath())
        const { append, settled } = oddAppend()
        try {
          expect(await refusal(settled)).toContain(`pid ${dead} on this machine`)
          expect(calls).toBeGreaterThanOrEqual(2)
          expect(lockText(lockPath())).toBe(text)
          expect(present(breakPath())).toBe(false)
        } finally {
          await clear(append)
        }
      } finally {
        spy.mockRestore()
      }
    },
  )

  test('a home that refuses the lock as a symbolic link gets a refusal naming the error and the likely cause, and nothing is written', async () => {
    await lift()
    const segment = readFileSync(segmentPath())
    for (const code of ['EPERM', 'ENOTSUP', 'ENOSYS']) {
      const child = childAppend(`nolink-${code}` as ChildMode)
      expect({ code, status: child.status }).toEqual({ code, status: 1 })
      expect(child.stdout).toBe(
        `audit store: could not append denial.lifted: audit lock not acquired: making its symbolic link failed with ${code}; the filesystem under the home might not hold one (docs/runtime-spec.md § 14)`,
      )
      expect(present(lockPath())).toBe(false)
      expect(readFileSync(segmentPath())).toEqual(segment)
    }
    // Any other failure to make the link keeps the bare reason.
    const other = childAppend('nolink-EIO')
    expect(other.status).toBe(1)
    expect(other.stdout).toBe('audit store: could not append denial.lifted: audit lock not acquired')
    expect(readFileSync(segmentPath())).toEqual(segment)
  })

  test.skipIf(HOST === null)(
    'a lock whose holder is gone but which cannot be removed refuses saying its holder is gone, and to remove the lock by hand',
    async () => {
      await lift()
      plantLock(lockPath(), { token: 'gone', pid: deadPid(), host: HOST, at: Date.now() })
      try {
        const text = lockText(lockPath())
        const segment = readFileSync(segmentPath())
        const child = childAppend('break-EACCES')
        expect(child.status).toBe(1)
        expect(child.stdout).toBe(
          'audit store: could not append denial.lifted: audit lock not acquired in time: its holder is gone, and the lock could not be removed; remove audit/.lock by hand',
        )
        expect(lockText(lockPath())).toBe(text)
        expect(present(breakPath())).toBe(false)
        expect(readFileSync(segmentPath())).toEqual(segment)
      } finally {
        rmSync(lockPath(), { force: true })
      }
    },
  )
})

describe.skipIf(HOST === null)('the lock as it stands when the wait ends', () => {
  const said = (reason: string) => `audit store: could not append denial.lifted: ${reason}`
  const LIVE = () =>
    said(`audit lock not acquired in time: pid ${process.pid} on this machine holds it; remove audit/.lock by hand only once that process is gone`)
  const NAMELESS = said(
    'audit lock not acquired in time: its holder names no process; remove audit/.lock by hand only once no warpline process is running',
  )
  const UNREMOVED = said('audit lock not acquired in time: its holder is gone, and the lock could not be removed; remove audit/.lock by hand')
  const gone = () => plantLock(lockPath(), { token: 'gone', pid: deadPid(), host: HOST })

  /**
   * One lock state at the deadline. `stdout` null means the append goes
   * through. `lock` is what is at the lock's path afterwards: the planted text,
   * nothing, the planted directory, or a holder the child put there.
   */
  type Row = {
    title: string
    plant: () => void
    mode: ChildMode
    stdout: () => string | null
    lock: 'unchanged' | 'none' | 'directory' | { token: string; pid: number }
    breakFile: 'none' | 'unchanged'
  }

  const rows: Row[] = [
    {
      title: 'live on this machine: the refusal names its pid and this machine, and removal only once it is gone',
      plant: () => plantLock(lockPath(), { token: 'live', pid: process.pid, host: HOST }),
      mode: 'plain',
      stdout: LIVE,
      lock: 'unchanged',
      breakFile: 'none',
    },
    {
      title: 'live elsewhere or on a machine that cannot be told: the refusal names its pid, and removal only once it is gone',
      plant: () => plantLock(lockPath(), { token: 'foreign', pid: deadPid(), host: 'f'.repeat(64) }),
      mode: 'plain',
      stdout: () => {
        const { pid } = JSON.parse(lockText(lockPath())) as { pid: number }
        return said(
          `audit lock not acquired in time: pid ${pid} holds it, not on this machine or on one that cannot be told; remove audit/.lock by hand only once that process is gone`,
        )
      },
      lock: 'unchanged',
      breakFile: 'none',
    },
    {
      title: 'naming no process: the refusal says so, and removal only once no warpline process runs',
      plant: () => plantLock(lockPath(), { token: 'nameless' }),
      mode: 'plain',
      stdout: () => NAMELESS,
      lock: 'unchanged',
      breakFile: 'none',
    },
    {
      title: 'a directory: the refusal says it names no process',
      plant: () => mkdirSync(lockPath()),
      mode: 'plain',
      stdout: () => NAMELESS,
      lock: 'directory',
      breakFile: 'none',
    },
    {
      title: 'gone, and removable: the append takes the lock',
      plant: gone,
      mode: 'plain',
      stdout: () => null,
      lock: 'none',
      breakFile: 'none',
    },
    {
      title: 'gone, where the break file cannot be made: the refusal says the holder is gone and the lock could not be removed',
      plant: gone,
      mode: 'break-EACCES',
      stdout: () => UNREMOVED,
      lock: 'unchanged',
      breakFile: 'none',
    },
    {
      title: 'gone, where removing it is refused: the refusal says the holder is gone and the lock could not be removed',
      plant: gone,
      mode: 'unlink-EACCES',
      stdout: () => UNREMOVED,
      lock: 'unchanged',
      breakFile: 'none',
    },
    {
      title: 'gone, beside a break file: the refusal names the break file',
      plant: () => {
        gone()
        plantLock(breakPath(), { token: 'breaker', pid: deadPid(), host: HOST })
      },
      mode: 'plain',
      stdout: () =>
        said(
          'audit lock not acquired in time: its holder is gone, and .lock.break exists; remove audit/.lock.break by hand only once no warpline process is running',
        ),
      lock: 'unchanged',
      breakFile: 'unchanged',
    },
    {
      title: 'live on this machine, beside a break file: the refusal names its pid and not the break file',
      plant: () => {
        plantLock(lockPath(), { token: 'live', pid: process.pid, host: HOST })
        plantLock(breakPath(), { token: 'breaker', pid: deadPid(), host: HOST })
      },
      mode: 'plain',
      stdout: LIVE,
      lock: 'unchanged',
      breakFile: 'unchanged',
    },
    {
      title: 'gone, where another breaker held the break file and left none: the refusal names its pid on this machine and not the break file',
      plant: gone,
      mode: 'breakheld-stays',
      stdout: () => {
        const { pid } = JSON.parse(lockText(lockPath())) as { pid: number }
        return said(`audit lock not acquired in time: pid ${pid} on this machine holds it; remove audit/.lock by hand only once that process is gone`)
      },
      lock: 'unchanged',
      breakFile: 'none',
    },
    {
      title: 'changed after it was judged, under the break file, to a live holder: the refusal names that pid, and removal only once it is gone',
      plant: gone,
      mode: 'rejudge-retaken',
      stdout: LIVE,
      lock: { token: 'live', pid: process.pid },
      breakFile: 'none',
    },
    {
      title: 'changed after it was judged, under the break file, to no lock: the append takes the lock',
      plant: gone,
      mode: 'rejudge-released',
      stdout: () => null,
      lock: 'none',
      breakFile: 'none',
    },
    {
      title:
        'changed after it was judged, under the break file, to the same token with a live holder: the refusal names that pid, and removal only once it is gone',
      plant: gone,
      mode: 'rejudge-alive',
      stdout: LIVE,
      lock: { token: 'gone', pid: process.pid },
      breakFile: 'none',
    },
    {
      title: 'changed after it was judged, as the break file failed, to a live holder: the refusal names that pid, and removal only once it is gone',
      plant: gone,
      mode: 'break-EACCES-retaken',
      stdout: LIVE,
      lock: { token: 'live', pid: process.pid },
      breakFile: 'none',
    },
    {
      title: 'changed after it was judged, as the break file failed, to no lock: the refusal names no holder',
      plant: gone,
      mode: 'break-EACCES-released',
      stdout: () => said('audit lock not acquired in time'),
      lock: 'none',
      breakFile: 'none',
    },
    {
      title:
        'changed after it was judged, as the break file failed, to the same token with a live holder: the refusal names that pid, and removal only once it is gone',
      plant: gone,
      mode: 'break-EACCES-alive',
      stdout: LIVE,
      lock: { token: 'gone', pid: process.pid },
      breakFile: 'none',
    },
    {
      title:
        'changed after it was judged, while another breaker held the break file, to a live holder: the refusal names that pid and not the break file',
      plant: gone,
      mode: 'breakheld-retaken',
      stdout: LIVE,
      lock: { token: 'live', pid: process.pid },
      breakFile: 'none',
    },
  ]

  for (const row of rows) {
    test(row.title, async () => {
      await lift()
      row.plant()
      try {
        const segment = readFileSync(segmentPath())
        const text = row.lock === 'unchanged' ? lockText(lockPath()) : undefined
        const brk = row.breakFile === 'unchanged' ? lockText(breakPath()) : undefined
        const want = row.stdout()

        const child = childAppend(row.mode, 0)

        if (want === null) {
          expect(child.status).toBe(0)
          const after = readFileSync(segmentPath())
          expect(after.subarray(0, segment.length).equals(segment)).toBe(true)
          const added = after.subarray(segment.length).toString('utf8')
          expect(added.endsWith('\n') && added.indexOf('\n') === added.length - 1).toBe(true)
        } else {
          expect({ status: child.status, stdout: child.stdout }).toEqual({ status: 1, stdout: want })
          expect(readFileSync(segmentPath()).equals(segment)).toBe(true)
        }
        if (row.lock === 'unchanged') expect(lockText(lockPath())).toBe(text!)
        else if (row.lock === 'none') expect(present(lockPath())).toBe(false)
        else if (row.lock === 'directory') expect(lstatSync(lockPath()).isDirectory()).toBe(true)
        else {
          const holder = JSON.parse(lockText(lockPath())) as Record<string, unknown>
          expect({ token: holder.token, pid: holder.pid, host: holder.host }).toEqual({ ...row.lock, host: HOST })
        }
        if (row.breakFile === 'unchanged') expect(lockText(breakPath())).toBe(brk!)
        else expect(present(breakPath())).toBe(false)
      } finally {
        rmSync(lockPath(), { recursive: true, force: true })
        rmSync(breakPath(), { force: true })
      }
    })
  }
})

describe('audit store: every append is synced before it resolves', () => {
  let spy: ReturnType<typeof spyOn> | undefined

  beforeEach(async () => {
    // The FileHandle class is not exported, so take its prototype off a handle.
    const probe = join(tmp, 'probe')
    mkdirSync(tmp, { recursive: true })
    const handle = await open(probe, 'w')
    const proto = Object.getPrototypeOf(handle) as { datasync: () => Promise<void> }
    await handle.close()
    spy = spyOn(proto, 'datasync')
  })

  afterEach(() => {
    spy?.mockRestore()
    spy = undefined
  })

  test('genesis and the record are each followed by datasync, and so is every later append', async () => {
    await lift()
    const afterFirst = spy!.mock.calls.length
    expect(afterFirst).toBeGreaterThanOrEqual(2)

    await lift()
    expect(spy!.mock.calls.length).toBeGreaterThanOrEqual(afterFirst + 1)
  })
})

describe('segments', () => {
  type Line = { raw: string; obj: Record<string, any> }
  type Opts = { now?: () => number; maxSegmentBytes?: number; maxSegmentAgeMs?: number }
  const append = audit.appendAudit as unknown as (
    s: string,
    k: string,
    d: unknown,
    o?: Opts,
  ) => Promise<{ seq: number; head: string }>

  const T = Date.parse('2026-01-01T00:00:00.000Z')
  const OPENED = 'warpline.audit.segment.opened'
  const SEALED = 'warpline.audit.segment.sealed'
  const CHECKPOINT = 'warpline.audit.checkpoint.recorded'
  const LIFTED = 'warpline.audit.denial.lifted'
  const name = (seq: number) => `${String(seq).padStart(16, '0')}.jsonl`

  /** The segment files, in name order. */
  const segments = (): string[] => readdirSync(auditDir).filter((n) => /^\d{16}\.jsonl$/.test(n)).sort()

  /** A segment's complete lines, raw and parsed. A partial last line is left out. */
  function lines(file: string): Line[] {
    const raw = readFileSync(join(auditDir, file), 'utf-8').split('\n').slice(0, -1)
    return raw.map((r) => ({ raw: r, obj: JSON.parse(r) }))
  }

  /** Every segment file's bytes, so a later check can hold each as a prefix. */
  function snap(): Map<string, Buffer> {
    return new Map(segments().map((n) => [n, readFileSync(join(auditDir, n))]))
  }

  /** Each file that existed before still starts with its old bytes. */
  function expectPrefix(before: Map<string, Buffer>): void {
    for (const [n, old] of before) {
      expect(readFileSync(join(auditDir, n)).subarray(0, old.length).equals(old)).toBe(true)
    }
  }

  /** An append that also proves no existing byte moved. */
  async function kept(kind: string, data: unknown, opts?: Opts) {
    const before = present(auditDir) ? snap() : new Map<string, Buffer>()
    const result = await append(statePath, kind, data, opts)
    expectPrefix(before)
    return result
  }

  const liftKept = (opts?: Opts) => kept('denial.lifted', { plugin: 'p', fingerprint: HEX_A }, opts)

  /** Whole store: no partial line, contiguous seq, unbroken chain, name order is seq order. */
  function expectWholeChain(): Line[] {
    const names = segments()
    const all: Line[] = []
    for (const n of names) {
      expect(readFileSync(join(auditDir, n), 'utf-8').endsWith('\n')).toBe(true)
      const ls = lines(n)
      expect(n).toBe(name(ls[0]!.obj.warplineseq))
      all.push(...ls)
    }
    expect(all.map((l) => l.obj.warplineseq)).toEqual(all.map((_, i) => i + 1))
    for (let i = 1; i < all.length; i++) expect(all[i]!.obj.warplineprev).toBe(sha256(all[i - 1]!.raw))
    return all
  }

  test('size: a segment at the threshold is sealed, and the record lands after opened and a checkpoint', async () => {
    await liftKept()
    await liftKept()
    const n = statSync(join(auditDir, name(1))).size

    const result = await liftKept({ maxSegmentBytes: n })

    const names = segments()
    expect(names).toHaveLength(2)
    const a = lines(names[0]!)
    const b = lines(names[1]!)
    const sealed = a[a.length - 1]!
    expect(sealed.obj.type).toBe(SEALED)
    expect(sealed.obj.data).toEqual({ reason: 'size', bytes: n })
    expect(names[1]).toBe(name(sealed.obj.warplineseq + 1))
    expect(b.map((l) => l.obj.type)).toEqual([OPENED, CHECKPOINT, LIFTED])

    const opened = b[0]!
    expect(opened.obj.warplineprev).toBe(sha256(sealed.raw))
    expect(opened.obj.data).toEqual({
      home: a[0]!.obj.source,
      version: PACKAGE_VERSION,
      fragment: null,
      authority: { preferences: null, principals: null },
      open_intents: [],
    })
    expect(b[1]!.obj.data).toEqual({ origin: a[0]!.obj.source, size: opened.obj.warplineseq, root: sha256(opened.raw) })
    expect([...names].sort()).toEqual(names)

    const all = expectWholeChain()
    expect(result).toEqual({ seq: all.length, head: sha256(all[all.length - 1]!.raw) })
    expect(await audit.readHead(statePath)).toEqual(result)
  })

  test('size: a segment one byte under the threshold takes the append', async () => {
    await liftKept()
    await liftKept()
    const n = statSync(join(auditDir, name(1))).size

    await liftKept({ maxSegmentBytes: n + 1 })

    expect(segments()).toEqual([name(1)])
    expect(lines(name(1)).map((l) => l.obj.type)).toEqual([OPENED, LIFTED, LIFTED, LIFTED])
  })

  test('age: a segment as old as the threshold from its opened time is sealed', async () => {
    await liftKept({ now: () => T })

    await liftKept({ now: () => T + 1000, maxSegmentAgeMs: 1000 })

    const names = segments()
    expect(names).toHaveLength(2)
    const a = lines(names[0]!)
    expect(a[a.length - 1]!.obj.type).toBe(SEALED)
    expect(a[a.length - 1]!.obj.data.reason).toBe('age')
    expect(lines(names[1]!).map((l) => l.obj.type)).toEqual([OPENED, CHECKPOINT, LIFTED])
    expectWholeChain()
  })

  test('age: a segment one ms younger than the threshold takes the append', async () => {
    await liftKept({ now: () => T })

    await liftKept({ now: () => T + 999, maxSegmentAgeMs: 1000 })

    expect(segments()).toEqual([name(1)])
  })

  test('torn: a partial last line is acknowledged in a new segment, and every old byte stays', async () => {
    await liftKept()
    await liftKept()
    const first = join(auditDir, name(1))
    const fragment = '{"specversion":"1.0","id":"9'
    appendFileSync(first, fragment)
    const old = readFileSync(first)
    const lastComplete = lines(name(1)).at(-1)!

    const result = await liftKept()

    expect(readFileSync(first).equals(old)).toBe(true)
    expect(readFileSync(first, 'utf-8').endsWith(fragment)).toBe(true)
    expect(lines(name(1)).map((l) => l.obj.type)).not.toContain(SEALED)

    const names = segments()
    expect(names).toEqual([name(1), name(lastComplete.obj.warplineseq + 1)])
    const b = lines(names[1]!)
    expect(b.map((l) => l.obj.type)).toEqual([OPENED, LIFTED])
    expect(b[0]!.obj.warplineprev).toBe(sha256(lastComplete.raw))
    expect(b[0]!.obj.data.fragment).toEqual({ bytes: Buffer.byteLength(fragment), sha256: sha256(fragment) })
    expect(b[1]!.obj.warplineprev).toBe(sha256(b[0]!.raw))
    expect(result).toEqual({ seq: b[1]!.obj.warplineseq, head: sha256(b[1]!.raw) })
  })

  test('a segment holding only a partial line refuses the append, names the file, and writes nothing', async () => {
    await liftKept()
    const orphan = name(3)
    writeFileSync(join(auditDir, orphan), '{"specversion":"1.0"')
    const before = await snapshotHome(tmp)

    let caught: unknown
    try {
      await append(statePath, 'denial.lifted', { plugin: 'p', fingerprint: HEX_A })
    } catch (err) {
      caught = err
    }

    expect((caught as Error | undefined)?.name).toBe('AuditAppendError')
    expect((caught as Error).message).toContain(orphan)
    expect(await snapshotHome(tmp)).toEqual(before)
  })

  test('heal: a sealed segment with no successor gets opened and the record, and no checkpoint', async () => {
    await liftKept()
    await liftKept()
    await liftKept()
    const first = join(auditDir, name(1))
    const prior = lines(name(1))
    const last = prior.at(-1)!
    const sealedRaw = JSON.stringify({
      specversion: '1.0',
      id: String(last.obj.warplineseq + 1),
      source: last.obj.source,
      type: SEALED,
      time: new Date().toISOString(),
      datacontenttype: 'application/json',
      warplineseq: last.obj.warplineseq + 1,
      warplineprev: sha256(last.raw),
      data: { reason: 'size', bytes: statSync(first).size },
    })
    appendFileSync(first, `${sealedRaw}\n`)

    await liftKept()

    const names = segments()
    expect(names).toEqual([name(1), name(last.obj.warplineseq + 2)])
    const b = lines(names[1]!)
    expect(b.map((l) => l.obj.type)).toEqual([OPENED, LIFTED])
    expect(b[0]!.obj.warplineprev).toBe(sha256(sealedRaw))
    expect(b[0]!.obj.data.fragment).toBeNull()
    expectWholeChain()
  })

  /** The open_intents of the newest segment.opened. */
  const lastOpened = () => lines(segments().at(-1)!)[0]!.obj
  const rotate = () => liftKept({ maxSegmentBytes: 1 })

  test('carry: authority and open intents ride every segment.opened, and a closed intent drops out', async () => {
    await kept('preference.set', { key: 'review_gate', old: null, new: 'b'.repeat(64) })
    await kept('principal.added', {
      id: 'ops',
      type: 'human',
      key_sha256: null,
      sha256: 'c'.repeat(64),
      entry_sha256: 'd'.repeat(64),
    })
    const a = await kept('fire.intent', { plugin: 'a', run_id: 'r1', class: 'session', effect_id: null, fingerprint: null })
    const b = await kept('fire.intent', {
      plugin: 'b',
      run_id: 'r1',
      class: 'content',
      effect_id: 'e'.repeat(64),
      fingerprint: HEX_A,
    })
    const authority = {
      preferences: 'b'.repeat(64),
      principals: { sha256: 'c'.repeat(64), entries: { ops: 'd'.repeat(64) } },
    }
    const A = { seq: a.seq, plugin: 'a', run_id: 'r1', effect_id: null }
    const B = { seq: b.seq, plugin: 'b', run_id: 'r1', effect_id: 'e'.repeat(64) }

    await rotate()
    expect(segments()).toHaveLength(2)
    expect(lastOpened().data.authority).toEqual(authority)
    expect(lastOpened().data.open_intents).toEqual([A, B])

    await kept('fire.outcome', { plugin: 'a', run_id: 'r1', intent_seq: a.seq, status: 'success' })
    await rotate()
    expect(segments()).toHaveLength(3)
    expect(lastOpened().data.authority).toEqual(authority)
    expect(lastOpened().data.open_intents).toEqual([B])

    await kept('fire.refused', { plugin: 'b', run_id: 'r1', reason: 'mark_uncertain', intent_seq: b.seq })
    await rotate()
    expect(segments()).toHaveLength(4)
    expect(lastOpened().data.authority).toEqual(authority)
    expect(lastOpened().data.open_intents).toEqual([])
    expectWholeChain()
  })

  test('carry: fire.resolved closes its intent, and a fire.refused with no intent_seq closes nothing', async () => {
    const a = await kept('fire.intent', { plugin: 'a', run_id: 'r1', class: 'session', effect_id: null, fingerprint: null })
    const b = await kept('fire.intent', { plugin: 'b', run_id: 'r2', class: 'session', effect_id: null, fingerprint: null })
    await kept('fire.resolved', { plugin: 'a', effect_id: 'f'.repeat(64), intent_seq: a.seq, answer: 'not_shipped' })
    await kept('fire.refused', { plugin: 'b', run_id: 'r2', reason: 'outside_window', intent_seq: null })

    await rotate()

    expect(lastOpened().data.open_intents).toEqual([{ seq: b.seq, plugin: 'b', run_id: 'r2', effect_id: null }])
    expect(lastOpened().data.authority).toEqual({ preferences: null, principals: null })
  })
})

describe('an empty newest segment the writer did not make', () => {
  test('under a name no append opens, it is refused under the lock, never written into, and read as not yet written', async () => {
    await lift()
    const head = await audit.readHead(statePath)
    const stray = join(auditDir, '0000000000000009.jsonl')
    writeFileSync(stray, '')
    const first = readFileSync(segmentPath())

    const reason = await lift().then(
      () => 'resolved',
      (err: unknown) => (err as { reason?: unknown }).reason,
    )

    expect(reason).toBe('segment 0000000000000009.jsonl holds no complete line, and this append does not open it')
    expect(readFileSync(segmentPath()).equals(first)).toBe(true)
    expect(statSync(stray).size).toBe(0)
    expect(await audit.readHead(statePath)).toEqual(head)
    expect(await audit.verifyStore(statePath, { seq: head.seq, hex: head.head }, Date.now())).toMatchObject({
      verdict: 'tampered',
      reason: `segment 0000000000000009.jsonl is not named by its first seq ${head.seq + 1}`,
      intents_unreadable: null,
    })
  })
})

describe('authority files', () => {
  const REGISTRY = 'warpline.audit.principal_registry.observed'
  const bytesA = Buffer.from('{"principals":[{"id":"ops"}]}')
  const bytesB = Buffer.from('{"principals":[{"id":"ops"},{"id":"ci"}]}')
  const digestA = createHash('sha256').update(bytesA).digest('hex')
  const digestB = createHash('sha256').update(bytesB).digest('hex')
  const observedLines = () =>
    readdirSync(auditDir)
      .filter((n) => /^\d{16}\.jsonl$/.test(n))
      .sort()
      .flatMap((n) => readFileSync(join(auditDir, n), 'utf-8').split('\n').filter((l) => l !== ''))
      .map((l) => JSON.parse(l) as { type: string; warplineseq: number; data: Record<string, unknown> })
      .filter((r) => r.type === REGISTRY)

  test('the registry is recorded by entry: ids added or changed are named, and a repeat of the same bytes records nothing, across a rotation too', async () => {
    expect(typeof audit.observeAuthorityFile).toBe('function')
    const first = await audit.observeAuthorityFile(statePath, 'principal_registry.observed', bytesA, { ops: 'a'.repeat(64) })

    expect(first).not.toBeNull()
    expect(observedLines()).toHaveLength(1)
    expect(observedLines()[0]!.warplineseq).toBe(first!.seq)
    expect(observedLines()[0]!.data).toEqual({
      old: null,
      new: digestA,
      changed_ids: ['ops'],
      editor: 'unknown',
      changed_entries: { ops: 'a'.repeat(64) },
    })

    const second = await audit.observeAuthorityFile(statePath, 'principal_registry.observed', bytesB, {
      ops: 'b'.repeat(64),
      ci: 'c'.repeat(64),
    })

    expect(second).not.toBeNull()
    expect(observedLines()).toHaveLength(2)
    expect(observedLines()[1]!.data).toEqual({
      old: digestA,
      new: digestB,
      changed_ids: ['ci', 'ops'],
      editor: 'unknown',
      changed_entries: { ci: 'c'.repeat(64), ops: 'b'.repeat(64) },
    })

    const entriesB = { ops: 'b'.repeat(64), ci: 'c'.repeat(64) }
    expect(await audit.observeAuthorityFile(statePath, 'principal_registry.observed', bytesB, entriesB)).toBeNull()
    expect(observedLines()).toHaveLength(2)

    await audit.appendAudit(statePath, 'denial.lifted', { plugin: 'p', fingerprint: HEX_A }, { maxSegmentBytes: 1 })
    expect(readdirSync(auditDir).filter((n) => /^\d{16}\.jsonl$/.test(n))).toHaveLength(2)

    expect(await audit.observeAuthorityFile(statePath, 'principal_registry.observed', bytesB, entriesB)).toBeNull()
    expect(observedLines()).toHaveLength(2)
  })

  test('an id that leaves the registry is named as changed', async () => {
    expect(typeof audit.observeAuthorityFile).toBe('function')
    await audit.observeAuthorityFile(statePath, 'principal_registry.observed', bytesB, {
      ops: 'b'.repeat(64),
      ci: 'c'.repeat(64),
    })

    await audit.observeAuthorityFile(statePath, 'principal_registry.observed', bytesA, { ci: 'c'.repeat(64) })

    expect(observedLines()[1]!.data.changed_ids).toEqual(['ops'])
    expect(observedLines()[1]!.data.changed_entries).toEqual({ ops: null })
  })
})

describe('a segment.opened over 64 KiB', () => {
  const OPENED = 'warpline.audit.segment.opened'
  const SEALED = 'warpline.audit.segment.sealed'
  const segmentNames = () => readdirSync(auditDir).filter((n) => /^\d{16}\.jsonl$/.test(n)).sort()
  const rawLines = (name: string) => readFileSync(join(auditDir, name), 'utf-8').split('\n').slice(0, -1)
  const liftWith = (opts?: { now?: () => number; maxSegmentBytes?: number }) =>
    audit.appendAudit(statePath, 'denial.lifted', { plugin: 'p', fingerprint: HEX_A }, opts)

  /**
   * 600 open intents, each carried at about 150 bytes, then a rotation, so the
   * active segment opens with a line well past 64 KiB. Returns that line raw.
   */
  async function bigOpened(): Promise<string> {
    for (let i = 0; i < 600; i++) {
      await audit.appendAudit(statePath, 'fire.intent', {
        plugin: `${String(i).padStart(4, '0')}${'p'.repeat(60)}`,
        run_id: 'r'.repeat(40),
        class: 'session',
        effect_id: null,
        fingerprint: null,
      })
    }
    await liftWith({ maxSegmentBytes: 1 })
    const opened = rawLines(segmentNames().at(-1)!)[0]!
    const rec = JSON.parse(opened) as { type: string; data: { open_intents: unknown[] } }
    expect(rec.type).toBe(OPENED)
    expect(rec.data.open_intents).toHaveLength(600)
    expect(Buffer.byteLength(opened)).toBeGreaterThan(65_536)
    return opened
  }

  test('the segment it opens still rotates by age', async () => {
    const opened = await bigOpened()
    const active = segmentNames().at(-1)!
    const openedAt = Date.parse((JSON.parse(opened) as { time: string }).time)

    await liftWith({ now: () => openedAt + audit.SEGMENT_MAX_AGE_MS })

    const last = JSON.parse(rawLines(active).at(-1)!) as { type: string; data: { reason?: string } }
    expect(last.type).toBe(SEALED)
    expect(last.data.reason).toBe('age')
    expect(segmentNames()).toHaveLength(3)
  }, 60_000)

  test('a crash right after it still leaves a last line the next append and readHead can read', async () => {
    const opened = await bigOpened()
    const active = segmentNames().at(-1)!
    // The crash: the active segment ends just after its segment.opened line.
    writeFileSync(join(auditDir, active), `${opened}\n`)
    const seq = (JSON.parse(opened) as { warplineseq: number }).warplineseq

    expect(await audit.readHead(statePath)).toEqual({ seq, head: sha256(opened) })
    const next = await liftWith()
    expect(next.seq).toBe(seq + 1)
    expect(rawLines(active)).toHaveLength(2)
  }, 60_000)
})

describe('the walk reads only what it carries', () => {
  /** A control character no writer lets into a plugin name, and a marker to look for in every output. */
  const BAD = 'bad\u0007WALK_SENTINEL_5d1'
  const PREFS = 'b'.repeat(64)
  const intent = (plugin: string, run_id: string) =>
    audit.appendAudit(statePath, 'fire.intent', { plugin, run_id, class: 'session', effect_id: null, fingerprint: null })
  const segmentNames = () => readdirSync(auditDir).filter((n) => /^\d{16}\.jsonl$/.test(n)).sort()

  /** The rejection of a promise, which must reject. */
  async function refusal(p: Promise<unknown>): Promise<Error> {
    const err = await p.then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(Error)
    return err as Error
  }

  /**
   * A writer-built store with an authority digest and one intent, then two
   * foreign lines: an intent with an extra `principal` key, and an outcome with
   * an extra `note` key that closes the writer's intent.
   */
  async function extraKeys(): Promise<{ open: number; shut: number }> {
    await audit.appendAudit(statePath, 'preference.set', { key: 'review_gate', old: null, new: PREFS })
    const shut = (await intent('shut', 'run-1')).seq
    const open = appendRelinked(auditDir, 'warpline.audit.fire.intent', {
      plugin: 'mailer',
      run_id: 'run-77',
      class: 'session',
      effect_id: null,
      fingerprint: null,
      principal: 'ops',
    })
    appendRelinked(auditDir, 'warpline.audit.fire.outcome', {
      plugin: 'shut',
      run_id: 'run-1',
      intent_seq: shut,
      status: 'success',
      note: 'x',
    })
    return { open, shut }
  }

  test('an extra key on a kind the walk reads is passed over, and reaches no output', async () => {
    const { open } = await extraKeys()

    expect(await audit.openIntents(statePath)).toStrictEqual([{ seq: open, plugin: 'mailer', run_id: 'run-77', effect_id: null }])
  })

  test('a record of a kind this build does not know is passed over', async () => {
    const { seq } = await intent('mailer', 'run-77')
    appendRelinked(auditDir, 'warpline.audit.grant.extended', { plugin: BAD, scopes: [{ deep: [1, 2] }], until: 'later' })

    expect(await audit.openIntents(statePath)).toStrictEqual([{ seq, plugin: 'mailer', run_id: 'run-77', effect_id: null }])
  })

  test('a pending kind carrying data is passed over', async () => {
    const { seq } = await intent('mailer', 'run-77')
    appendRelinked(auditDir, 'warpline.audit.ask.raised', { plugin: 'mailer', question: 'send it?' })

    expect(await audit.openIntents(statePath)).toStrictEqual([{ seq, plugin: 'mailer', run_id: 'run-77', effect_id: null }])
  })

  test('a carried field no writer writes stops the walk, and the refusal names the seq and the kind and nothing from the line', async () => {
    await intent('mailer', 'run-77')
    const seq = appendRelinked(auditDir, 'warpline.audit.fire.intent', {
      plugin: BAD,
      run_id: 'run-78',
      class: 'session',
      effect_id: null,
      fingerprint: null,
    })

    const err = await refusal(audit.openIntents(statePath))
    expect(err.message).toContain(`seq ${seq} `)
    expect(err.message).toContain('fire.intent')
    expect(err.message).not.toContain('WALK_SENTINEL_5d1')
  })

  test('a rotation over a passed-over line carries the open intent and the authority, and copies no extra key', async () => {
    const { open } = await extraKeys()

    await audit.appendAudit(statePath, 'denial.lifted', { plugin: 'p', fingerprint: HEX_A }, { maxSegmentBytes: 1 })

    const names = segmentNames()
    expect(names).toHaveLength(2)
    const openedLine = readFileSync(join(auditDir, names[1]!), 'utf-8').split('\n')[0]!
    const opened = JSON.parse(openedLine) as { type: string; data: Record<string, unknown> }
    expect(opened.type).toBe('warpline.audit.segment.opened')
    expect(opened.data.open_intents).toStrictEqual([{ seq: open, plugin: 'mailer', run_id: 'run-77', effect_id: null }])
    expect(opened.data.authority).toStrictEqual({ preferences: PREFS, principals: null })
    expect(openedLine).not.toContain('"principal":')
    expect(openedLine).not.toContain('"note":')
  })

  test('an authority observation over a passed-over line records nothing for unchanged bytes', async () => {
    const bytes = Buffer.from('{"review_gate":false}')
    expect(await audit.observeAuthorityFile(statePath, 'preferences.observed', bytes)).not.toBeNull()
    appendRelinked(auditDir, 'warpline.audit.grant.issued', { scopes: ['p'], ttl_ms: null, replace: false, long: false, note: 'x' })
    const before = readFileSync(join(auditDir, '0000000000000001.jsonl'))

    expect(await audit.observeAuthorityFile(statePath, 'preferences.observed', bytes)).toBeNull()

    expect(segmentNames()).toEqual(['0000000000000001.jsonl'])
    expect(readFileSync(join(auditDir, '0000000000000001.jsonl'))).toEqual(before)
  })

  test('a segment.opened carrying an open intent no writer writes stops the walk, and the refusal names the seq and nothing from the line', async () => {
    const { seq } = await intent('mailer', 'run-77')
    const first = JSON.parse(readFileSync(join(auditDir, '0000000000000001.jsonl'), 'utf-8').split('\n')[0]!) as {
      data: { home: string; version: string }
    }
    // Every value but the plugin is one a writer would write.
    const planted = appendRelinked(
      auditDir,
      'warpline.audit.segment.opened',
      {
        home: first.data.home,
        version: first.data.version,
        fragment: null,
        authority: { preferences: null, principals: null },
        open_intents: [{ seq, plugin: BAD, run_id: 'run-77', effect_id: null }],
      },
      { opens: true },
    )
    expect(segmentNames()).toHaveLength(2)

    const err = await refusal(audit.openIntents(statePath))
    expect(err.message).toContain(`seq ${planted} `)
    expect(err.message).toContain('segment.opened')
    expect(err.message).not.toContain('WALK_SENTINEL_5d1')
  })
})

describe('a Checkpoint the walk cannot summarise', () => {
  test('recordCheckpoint over a line the walk stops at resolves with the Checkpoint seq, and bytes, segments and indeterminate null', async () => {
    await lift()
    // Chain-valid, so the append under the Checkpoint takes it. Only the walk
    // that reads the store back afterwards stops at it.
    appendRelinked(auditDir, 'warpline.audit.fire.intent', {
      plugin: 'bad\u0007CHECKPOINT_SENTINEL_2e4',
      run_id: 'run-78',
      class: 'session',
      effect_id: null,
      fingerprint: null,
    })

    const summary: unknown = await audit.recordCheckpoint(statePath)

    const last = JSON.parse(segmentLines().at(-1)!) as { type: string; warplineseq: number }
    expect(last.type).toBe('warpline.audit.checkpoint.recorded')
    expect(summary).toStrictEqual({
      seq: last.warplineseq,
      bytes: null,
      segments: null,
      checkpoint_seq: last.warplineseq,
      indeterminate: null,
    })
    expect(JSON.stringify(summary)).not.toContain('CHECKPOINT_SENTINEL_2e4')
  })
})
