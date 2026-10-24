/**
 * The Handoff record's write lock, pinned at the module.
 *
 * Every rewrite of a record (supersede in `writeHandoff`, `withdrawHandoff`,
 * and `settleTry`) takes `handoffs/<id>.lock`, re-reads the record under it,
 * and writes only from what it re-read. So a try that settles inside
 * supersede's read-write window lands after it and reads the record closed,
 * instead of being written over. A try settles `answered` only on a record
 * the re-read finds `open`; on any other state it is appended `discarded` and
 * the state is left as it is. Tries are only appended.
 *
 * A record lock whose holder is gone on this machine is broken through
 * `<id>.lock.break`. A live holder, or one this writer cannot judge, is
 * waited on and then refused with `EBUSY`, never broken.
 *
 * Every case gets its own temp dir (AGENTS.md Rule 2), and every spy is
 * restored after it.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as fsAtomic from '../fs-atomic.js'
import * as lib from '../handoffs.js'
import * as pidLock from '../pid-lock.js'

const T0 = Date.parse('2026-10-14T08:00:00.000Z')

let root: string
let dir: string
let spies: ReturnType<typeof spyOn>[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'warpline-handoffs-lock-'))
  dir = join(root, 'handoffs')
})

afterEach(() => {
  for (const s of spies) s.mockRestore()
  spies = []
  rmSync(root, { recursive: true, force: true })
})

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function raw(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, name), 'utf-8')) as Record<string, unknown>
}

function bytes(name: string): string {
  return readFileSync(join(dir, name), 'utf-8')
}

/** One try, as the writer's type has it. */
function T(outcome: lib.TryOutcome, at = T0 + 3000): lib.Try {
  return {
    at: new Date(at).toISOString(),
    reservation_id: 'urn:uuid:00000000-0000-4000-8000-000000000001',
    requested: 'm',
    served: 'm',
    cost_micro_usd: 0,
    cost_basis: 'reported',
    outcome,
    reason: null,
  }
}

function write(runId: string, at: number): ReturnType<typeof lib.writeHandoff> {
  return lib.writeHandoff(dir, { run_id: runId, plugin: 'prod', task: 't', context_path: null }, at)
}

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

const lockPath = (id = 'run-1.prod') => join(dir, `${id}.lock`)

describe('a try that settles inside supersede\'s window', () => {
  test('lands after the supersede, reads the record closed, and is kept as discarded', async () => {
    await write('run-1', T0)

    // Read BEFORE `spyOn`: afterwards the namespace property is the mock.
    const real = fsAtomic.atomicWriteJson
    let settle: Promise<{ state: string; try: lib.Try }> | undefined
    spies.push(
      spyOn(fsAtomic, 'atomicWriteJson').mockImplementation((async (path: string, value: unknown, opts?: unknown) => {
        const state = (value as { state?: unknown } | null)?.state
        if (settle === undefined && path.endsWith('/run-1.prod.json') && state === 'superseded') {
          // Supersede has read the record and is about to write it: a try settles now.
          settle = lib.settleTry(
            dir,
            'run-1.prod',
            async () => ({ try: T('answered'), close: true }),
            async () => T('discarded'),
            T0 + 3000,
          )
          await Promise.race([settle, sleep(300)])
        }
        return (real as (...a: unknown[]) => Promise<void>)(path, value, opts)
      }) as typeof fsAtomic.atomicWriteJson),
    )

    await write('run-2', T0 + 1000)

    expect(settle).toBeDefined()
    const settled = await settle!
    expect(settled.try.outcome).toBe('discarded')
    const record = raw('run-1.prod.json')
    expect(record.state).toBe('superseded')
    expect(record.tries).toEqual([T('discarded')])
  })
})

describe('withdraw takes the record lock', () => {
  test('a withdraw waits on a held record lock, withdraws once it is released, and a later settle is discarded', async () => {
    await write('run-1', T0)
    const token = 'held-by-test'
    expect(pidLock.takeHeld(lockPath(), token)).toBe(true)

    const closedAt = new Date(T0 + 2000).toISOString()
    let done = false
    const withdraw = lib.withdrawHandoff(dir, 'run-1', 'prod', closedAt).finally(() => {
      done = true
    })
    await sleep(200)
    expect(done).toBe(false)
    expect(raw('run-1.prod.json').state).toBe('open')

    expect(pidLock.releaseHeld(lockPath(), token)).toBe(true)
    expect(await withdraw).toBe(true)
    expect(raw('run-1.prod.json')).toMatchObject({ state: 'withdrawn', closed_at: closedAt })

    const settled = await lib.settleTry(
      dir,
      'run-1.prod',
      async () => ({ try: T('answered'), close: true }),
      async () => T('discarded'),
      T0 + 5000,
    )
    expect(settled.try.outcome).toBe('discarded')
    const record = raw('run-1.prod.json')
    expect(record.state).toBe('withdrawn')
    expect(record.closed_at).toBe(closedAt)
    expect(record.tries).toEqual([T('discarded')])
  })

  test('a live holder past the wait makes withdraw refuse with EBUSY, and the record is untouched', async () => {
    await write('run-1', T0)
    const before = bytes('run-1.prod.json')
    const token = 'live-holder'
    expect(pidLock.takeHeld(lockPath(), token)).toBe(true)
    try {
      const err = await lib
        .withdrawHandoff(dir, 'run-1', 'prod', new Date(T0 + 2000).toISOString(), 300)
        .then(() => null, (e: unknown) => e)
      expect((err as NodeJS.ErrnoException | null)?.code).toBe('EBUSY')
      expect(bytes('run-1.prod.json')).toBe(before)
    } finally {
      pidLock.releaseHeld(lockPath(), token)
    }
  })

  test('a holder from another machine is never broken, even a dead pid, and withdraw refuses with EBUSY', async () => {
    await write('run-1', T0)
    const before = bytes('run-1.prod.json')
    symlinkSync(JSON.stringify({ token: 'foreign', pid: deadPid(), host: 'f'.repeat(64), at: Date.now() }), lockPath())
    const text = readlinkSync(lockPath(), 'utf8')

    const err = await lib
      .withdrawHandoff(dir, 'run-1', 'prod', new Date(T0 + 2000).toISOString(), 300)
      .then(() => null, (e: unknown) => e)
    expect((err as NodeJS.ErrnoException | null)?.code).toBe('EBUSY')
    expect(bytes('run-1.prod.json')).toBe(before)
    expect(readlinkSync(lockPath(), 'utf8')).toBe(text)
  })

  test.skipIf(pidLock.ourHost() === null)(
    'a holder gone on this machine is broken through the break file, and no lock or break file remains',
    async () => {
      await write('run-1', T0)
      symlinkSync(JSON.stringify({ token: 'gone', pid: deadPid(), host: pidLock.ourHost(), at: Date.now() }), lockPath())

      expect(await lib.withdrawHandoff(dir, 'run-1', 'prod', new Date(T0 + 2000).toISOString(), 2000)).toBe(true)
      expect(raw('run-1.prod.json').state).toBe('withdrawn')
      expect(readdirSync(dir).sort()).toEqual(['run-1.prod.json'])
      expect(readdirSync(dir).some((n) => n.endsWith('.lock') || n.endsWith('.lock.break'))).toBe(false)
    },
  )
})

describe('settleTry', () => {
  test('an answered try on an open record closes it answered, and a key a later build added survives', async () => {
    await write('run-1', T0)
    writeFileSync(join(dir, 'run-1.prod.json'), JSON.stringify({ ...raw('run-1.prod.json'), later_key: 'kept' }, null, 2))

    const settled = await lib.settleTry(
      dir,
      'run-1.prod',
      async () => ({ try: T('answered'), close: true }),
      async () => T('discarded'),
      T0 + 5000,
    )
    expect(settled).toEqual({ state: 'answered', try: T('answered') })
    const record = raw('run-1.prod.json')
    expect(record.state).toBe('answered')
    expect(record.closed_at).toBe(new Date(T0 + 5000).toISOString())
    expect(record.later_key).toBe('kept')
    expect(record.tries).toEqual([T('answered')])
    expect(readdirSync(dir)).toEqual(['run-1.prod.json'])
  })

  test('a failed try leaves the record open, and an answered one after it appends without touching it', async () => {
    await write('run-1', T0)

    await lib.settleTry(dir, 'run-1.prod', async () => ({ try: T('failed'), close: false }), async () => T('discarded'), T0 + 4000)
    const afterFailed = raw('run-1.prod.json')
    expect(afterFailed.state).toBe('open')
    expect(afterFailed.closed_at).toBeNull()
    const first = JSON.stringify((afterFailed.tries as unknown[])[0])

    await lib.settleTry(
      dir,
      'run-1.prod',
      async () => ({ try: T('answered', T0 + 6000), close: true }),
      async () => T('discarded'),
      T0 + 6000,
    )
    const tries = raw('run-1.prod.json').tries as unknown[]
    expect(tries).toHaveLength(2)
    expect(JSON.stringify(tries[0])).toBe(first)
    expect(tries[1]).toEqual(T('answered', T0 + 6000))
  })

  test('an onOpen that throws writes nothing and leaves no lock', async () => {
    await write('run-1', T0)
    const before = bytes('run-1.prod.json')

    const err = await lib
      .settleTry(
        dir,
        'run-1.prod',
        async () => {
          throw new Error('renderer gone')
        },
        async () => T('discarded'),
        T0 + 5000,
      )
      .then(() => null, (e: unknown) => e)
    expect((err as Error | null)?.message).toBe('renderer gone')
    expect(bytes('run-1.prod.json')).toBe(before)
    expect(readdirSync(dir)).toEqual(['run-1.prod.json'])
  })
})
