/**
 * Two writers at once on a lock another process left behind.
 *
 * The first case plants a lock older than 30 s whose holder is alive here,
 * names no machine, or cannot be read as a holder at all. Both writers refuse
 * in time and neither breaks it, so age alone never lets a writer in. The
 * second case plants a lock whose holder is gone on this machine. Both writers
 * append, and the chain stays one.
 *
 * Neither case depends on how the two writers interleave. Each claims only an
 * outcome that holds in every order, which retires the earlier race test and
 * its timing: the padded lock, the staggered start and the long segment.
 *
 * A held lock is a symbolic link whose target does not exist, so presence is
 * checked with lstat.
 *
 * Everything this file writes goes under temp dirs (AGENTS.md Rule 2).
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import {
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendAudit } from '../audit-log.js'
import { deriveHost } from '../host-identity.js'
import { walkChain } from './helpers/audit-chain.js'

const STORE = join(import.meta.dir, '..', 'audit-log.ts')
const NAME = /^\d{16}\.jsonl$/

const present = (path: string): boolean => lstatSync(path, { throwIfNoEntry: false }) !== undefined

/**
 * This machine as the store names it in a lock: the machine identifier, and on
 * Linux that joined to the pid namespace and the boot id, or null when any part
 * is missing. Computed from the identity module and `/proc`, never from the store.
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

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'warpline-audit-lock-break-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

/** A writer that appends once, and on a rejection prints its message to stderr and exits 1. */
function writerScript(): string {
  const script = join(tmp, 'writer.ts')
  writeFileSync(
    script,
    [
      `import { appendAudit } from ${JSON.stringify(STORE)}`,
      `const [statePath, name, timeout] = process.argv.slice(2)`,
      `try {`,
      `  await appendAudit(statePath, 'denial.lifted', { plugin: name, fingerprint: null, principal: null }, { lockTimeoutMs: Number(timeout) })`,
      `} catch (err) {`,
      `  process.stderr.write(String(err instanceof Error ? err.message : err))`,
      `  process.exit(1)`,
      `}`,
      '',
    ].join('\n'),
  )
  return script
}

/** Two writers spawned together on one home, each with the given lock timeout. */
function twoWriters(statePath: string, timeoutMs: number): Promise<{ code: number | null; stderr: string }[]> {
  const script = writerScript()
  const run = (name: string) =>
    new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [script, statePath, name, String(timeoutMs)], { env: { ...process.env } })
      let stderr = ''
      child.stderr.on('data', (d) => (stderr += d))
      child.on('close', (code) => resolve({ code, stderr }))
    })
  return Promise.all([run('alpha'), run('beta')])
}

/** A fresh home with a seeded store: the genesis line and one record. */
async function seeded(name: string): Promise<{ statePath: string; auditDir: string; segment: string }> {
  const home = join(tmp, name)
  const statePath = join(home, 'state', 'engine-state.json')
  const auditDir = join(home, 'audit')
  await appendAudit(statePath, 'denial.lifted', { plugin: 'seed', fingerprint: null, principal: null })
  return { statePath, auditDir, segment: join(auditDir, '0000000000000001.jsonl') }
}

test(
  'two writers on a lock older than 30 s whose holder is alive here, names no machine or cannot be read as a holder both refuse in time, and neither breaks it',
  async () => {
    const live = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    try {
      const at = Date.now() - 31_000
      const forms: [string, (lock: string) => void, (lock: string) => string | Buffer][] = [
        [
          'alive',
          (lock) => symlinkSync(JSON.stringify({ token: 'aged-live', pid: live.pid, host: HOST, at }), lock),
          (lock) => readlinkSync(lock, 'utf8'),
        ],
        [
          'nameless',
          (lock) => symlinkSync(JSON.stringify({ token: 'nameless', pid: deadPid(), host: null, at }), lock),
          (lock) => readlinkSync(lock, 'utf8'),
        ],
        [
          'unreadable',
          (lock) => writeFileSync(lock, JSON.stringify({ token: 'aged', at })),
          (lock) => readFileSync(lock),
        ],
      ]
      for (const [name, plant, read] of forms) {
        const { statePath, auditDir, segment } = await seeded(name)
        const lock = join(auditDir, '.lock')
        plant(lock)
        const lockBefore = read(lock)
        const segmentBefore = readFileSync(segment)

        const results = await twoWriters(statePath, 500)

        for (const { code, stderr } of results) {
          expect(code).toBe(1)
          expect(stderr).toContain('audit lock not acquired in time')
        }
        expect(read(lock)).toEqual(lockBefore)
        expect(readFileSync(segment)).toEqual(segmentBefore)
        expect(present(join(auditDir, '.lock.break'))).toBe(false)
      }
    } finally {
      live.kill('SIGKILL')
    }
  },
  30_000,
)

test.skipIf(HOST === null)(
  'two writers on a lock whose holder is gone on this machine both append, and the chain stays one',
  async () => {
    const { statePath, auditDir } = await seeded('gone')
    symlinkSync(JSON.stringify({ token: 'gone', pid: deadPid(), host: HOST, at: Date.now() }), join(auditDir, '.lock'))

    const results = await twoWriters(statePath, 2000)

    expect(results).toEqual([
      { code: 0, stderr: '' },
      { code: 0, stderr: '' },
    ])
    const walk = walkChain(auditDir)
    if (!walk.ok) throw new Error(`walk failed at ${walk.at}: ${walk.why}`)
    expect(walk.lines).toBe(4)
    const seqs = readdirSync(auditDir)
      .filter((n) => NAME.test(n))
      .flatMap((n) => readFileSync(join(auditDir, n), 'utf-8').split('\n').filter(Boolean))
      .map((l) => (JSON.parse(l) as { warplineseq: number }).warplineseq)
    expect(seqs).toHaveLength(4)
    expect(new Set(seqs).size).toBe(seqs.length)
    expect(present(join(auditDir, '.lock'))).toBe(false)
    expect(present(join(auditDir, '.lock.break'))).toBe(false)
  },
  30_000,
)
