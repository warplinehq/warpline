/**
 * The claim on one Handoff, pinned at the module.
 *
 * A claim is `handoffs/<id>.claim`, made by exclusive create: a symbolic link
 * whose text names its holder, `{ token, pid, host, at }`, the audit lock's
 * form. It is never waited on. A claim already there is broken only when its
 * holder names a token, a pid and this host, and no such process runs, and
 * then only through the break file `<id>.claim.break`. The identity rule is
 * the one the audit lock uses, so a claim from another host or pid namespace,
 * or one whose holder cannot be read, is never broken and reads as foreign.
 *
 * Claim, lock and break files are invisible to the record reader, and a claim
 * held when the process ends through `process.exit` is released by the exit
 * hook.
 *
 * Every case gets its own temp dir (AGENTS.md Rule 2).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as handoffs from '../../lib/handoffs.js'
import * as pidLock from '../../lib/pid-lock.js'
// The module this file pins before it exists, read through the namespace so
// each export is named where it is used.
import * as claim from '../claim.js'

const ID = 'run-1.prod'

let root: string
let dir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'warpline-claim-'))
  dir = join(root, 'handoffs')
  mkdirSync(dir)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const claimPath = (id = ID) => join(dir, `${id}.claim`)

// A claim is a link whose text names no file, so `existsSync` reads it as absent even while held.
const present = (p: string) => lstatSync(p, { throwIfNoEntry: false }) !== undefined

/** A pid that ran here and has exited. */
function deadPid(): number {
  const { pid } = spawnSync('/usr/bin/true', [], { env: {} })
  try {
    process.kill(pid!, 0)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return pid!
  }
  throw new Error(`pid ${pid} is still running`)
}

/** Plant a claim whose link text is `text`, and return that text. */
function plant(text: string): string {
  symlinkSync(text, claimPath())
  return readlinkSync(claimPath(), 'utf8')
}

describe('a claim', () => {
  test('is taken by exclusive create, names this process, and is released', () => {
    const r = claim.claimHandoff(dir, ID)
    expect(r).toMatchObject({ claimed: true, broke: false })
    if (!r.claimed) throw new Error('not claimed')
    const named = JSON.parse(readlinkSync(claimPath(), 'utf8')) as Record<string, unknown>
    expect(named).toMatchObject({ token: r.token, pid: process.pid, host: pidLock.ourHost() })

    claim.releaseClaim(dir, ID, r.token)
    expect(present(claimPath())).toBe(false)
  })

  test('a second claim while the first is held is refused as held, and the link is unchanged', () => {
    const first = claim.claimHandoff(dir, ID)
    if (!first.claimed) throw new Error('not claimed')
    const text = readlinkSync(claimPath(), 'utf8')
    try {
      expect(claim.claimHandoff(dir, ID)).toEqual({ claimed: false, why: 'held' })
      expect(readlinkSync(claimPath(), 'utf8')).toBe(text)
    } finally {
      claim.releaseClaim(dir, ID, first.token)
    }
  })
})

describe('breaking a claim', () => {
  test.skipIf(pidLock.ourHost() === null)(
    'a holder on this host whose pid is dead is broken, the claim taken with broke: true, and no .claim.break remains',
    () => {
      plant(JSON.stringify({ token: 'gone', pid: deadPid(), host: pidLock.ourHost(), at: Date.now() }))
      const r = claim.claimHandoff(dir, ID)
      expect(r).toMatchObject({ claimed: true, broke: true })
      if (!r.claimed) throw new Error('not claimed')
      expect((JSON.parse(readlinkSync(claimPath(), 'utf8')) as { token: string }).token).toBe(r.token)
      expect(present(join(dir, `${ID}.claim.break`))).toBe(false)
      claim.releaseClaim(dir, ID, r.token)
    },
  )

  test.skipIf(pidLock.ourHost() === null)(
    'a dead holder on this host beside a .claim.break already present is held, and the claim is untouched',
    () => {
      const text = plant(JSON.stringify({ token: 'gone', pid: deadPid(), host: pidLock.ourHost(), at: Date.now() }))
      symlinkSync(JSON.stringify({ token: 'breaker', pid: process.pid, host: pidLock.ourHost(), at: Date.now() }), join(dir, `${ID}.claim.break`))
      expect(claim.claimHandoff(dir, ID)).toEqual({ claimed: false, why: 'held' })
      expect(readlinkSync(claimPath(), 'utf8')).toBe(text)
    },
  )
})

describe("a claim this host cannot judge is never broken: why: 'foreign'", () => {
  test('another host or pid namespace, with a dead pid', () => {
    const text = plant(JSON.stringify({ token: 'far', pid: deadPid(), host: 'elsewhere:4026531836:boot', at: Date.now() }))
    expect(claim.claimHandoff(dir, ID)).toEqual({ claimed: false, why: 'foreign' })
    expect(readlinkSync(claimPath(), 'utf8')).toBe(text)
  })

  test('a plain file', () => {
    writeFileSync(claimPath(), 'not a link')
    expect(claim.claimHandoff(dir, ID)).toEqual({ claimed: false, why: 'foreign' })
    expect(readdirSync(dir)).toEqual([`${ID}.claim`])
  })

  test('link text that is not JSON', () => {
    const text = plant('not json at all')
    expect(claim.claimHandoff(dir, ID)).toEqual({ claimed: false, why: 'foreign' })
    expect(readlinkSync(claimPath(), 'utf8')).toBe(text)
  })

  test('a link that names no host', () => {
    const text = plant(JSON.stringify({ token: 'no-host', pid: deadPid(), at: Date.now() }))
    expect(claim.claimHandoff(dir, ID)).toEqual({ claimed: false, why: 'foreign' })
    expect(readlinkSync(claimPath(), 'utf8')).toBe(text)
  })

  test('a link that names no pid', () => {
    const text = plant(JSON.stringify({ token: 'no-pid', host: pidLock.ourHost(), at: Date.now() }))
    expect(claim.claimHandoff(dir, ID)).toEqual({ claimed: false, why: 'foreign' })
    expect(readlinkSync(claimPath(), 'utf8')).toBe(text)
  })
})

describe('claim, lock and break files are invisible to the record reader', () => {
  test('one open record beside .claim, .lock and .claim.break siblings reads as one open record', async () => {
    await handoffs.writeHandoff(dir, { run_id: 'run-1', plugin: 'prod', task: 't', context_path: null })
    const r = claim.claimHandoff(dir, ID)
    if (!r.claimed) throw new Error('not claimed')
    symlinkSync('{}', join(dir, `${ID}.lock`))
    symlinkSync('{}', join(dir, `${ID}.claim.break`))
    try {
      const read = await handoffs.readOpenHandoffs(dir)
      expect(read.open.map((h) => h.id)).toEqual([ID])
      expect(read.unreadable).toEqual([])
    } finally {
      claim.releaseClaim(dir, ID, r.token)
    }
  })
})

describe('the exit hook', () => {
  test('a claim held when the process ends through process.exit(0) is released', () => {
    const mod = join(import.meta.dir, '..', 'claim.ts')
    const script = [
      `const { claimHandoff } = await import(${JSON.stringify(mod)})`,
      `const r = claimHandoff(${JSON.stringify(dir)}, ${JSON.stringify(ID)})`,
      `process.stdout.write(JSON.stringify(r))`,
      `process.exit(0)`,
    ].join('\n')
    const child = spawnSync(process.execPath, ['-e', script], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' })
    expect(child.status).toBe(0)
    expect(JSON.parse(child.stdout)).toMatchObject({ claimed: true, broke: false })
    expect(present(claimPath())).toBe(false)
  })
})
