/**
 * `warpline principal` — the registry of who may act, and its only writer.
 *
 * `<home>/principals.json` holds one entry per principal: an id the operator
 * chose, a type, a status and an optional key. Every add and disable is on the
 * audit store before the file changes, the file is owner-only after every
 * write, and no entry ever leaves it: disable is the only way out, and an id
 * once used is never used again. Later records name principals by id, so an id
 * that could be deleted or reused would make those records name someone else.
 *
 * No principal is ever taken from the account running the command. Two static
 * checks read principal.ts for a removal and for the OS user, and each is shown
 * red on a planted fixture in the same test, so a check that can't fail can't
 * pass here.
 *
 * Digests are computed here with `node:crypto` over bytes read back from disk,
 * never with a helper from the code under test, so the check cannot agree with
 * the writer by construction.
 *
 * Every case gets its own home through `_setHome`, and everything this file
 * writes goes under temp dirs (AGENTS.md Rule 2).
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as audit from '../../lib/audit-log.js'
import * as fsAtomic from '../../lib/fs-atomic.js'
import { appendRelinked } from '../../lib/__tests__/helpers/audit-chain.js'
import { _setHome, engineStatePath } from '../../lib/paths.js'
import { snapshotHome } from '../../runtime/__tests__/helpers/snapshot-home.js'
import { run } from '../principal.js'

const SOURCE = join(import.meta.dir, '..', 'principal.ts')
const ADDED = 'warpline.audit.principal.added'
const DISABLED = 'warpline.audit.principal.disabled'
const OBSERVED = 'warpline.audit.principal_registry.observed'
/** A key value. It may sit in principals.json and nowhere under `audit/`. */
const KEY = 'PRINCIPAL-KEY-SENTINEL ssh-ed25519 AAAA'
/** The spy's error message. It must never reach the operator. */
const APPEND_SENTINEL = 'WARPLINE_AUDIT_APPEND_SPY_SENTINEL'

let home: string
let installed: ReturnType<typeof spyOn>[] = []

const file = (): string => join(home, 'principals.json')
const storeDir = (): string => join(home, 'audit')
const mode = (): number => statSync(file()).mode & 0o777
const sha = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex')

/** An entry's digest: `{ id, type, status }` plus `key` when set, in that order. */
function entryDigest(e: { id: string; type: string; status: string; key?: string }): string {
  const shape: Record<string, string> = { id: e.id, type: e.type, status: e.status }
  if (e.key !== undefined) shape.key = e.key
  return sha(JSON.stringify(shape))
}

type Entry = { id: string; type: string; status: string; key?: string }
const registry = (): { principals: Entry[] } => JSON.parse(readFileSync(file(), 'utf-8')) as { principals: Entry[] }

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'warpline-principal-'))
  _setHome(home)
})

afterEach(() => {
  for (const spy of installed) spy.mockRestore()
  installed = []
  _setHome(null)
  rmSync(home, { recursive: true, force: true })
})

/**
 * Run the verb with stdout/stderr captured, always restoring the originals.
 * `onFirstStdout` runs once, at the first stdout write, before it is kept.
 */
async function principal(
  argv: string[],
  onFirstStdout?: () => void,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const realOut = process.stdout.write
  const realErr = process.stderr.write
  let stdout = ''
  let stderr = ''
  process.stdout.write = ((chunk: string) => {
    if (stdout === '' && onFirstStdout) onFirstStdout()
    stdout += chunk
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string) => {
    stderr += chunk
    return true
  }) as typeof process.stderr.write
  try {
    return { code: await run(argv), stdout, stderr }
  } finally {
    process.stdout.write = realOut
    process.stderr.write = realErr
  }
}

type Line = { type: string; warplineseq: number; data: Record<string, unknown> }

/** Every stored line under `<home>/audit/`, segments in name order. */
function lines(): Line[] {
  if (!existsSync(storeDir())) return []
  return readdirSync(storeDir())
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .flatMap((f) =>
      readFileSync(join(storeDir(), f), 'utf-8')
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as Line),
    )
}

const ofType = (type: string): Line[] => lines().filter((l) => l.type === type)

/** Every byte under `<home>/audit/`, as one string. */
function storeText(): string {
  if (!existsSync(storeDir())) return ''
  return readdirSync(storeDir())
    .map((f) => readFileSync(join(storeDir(), f), 'utf-8'))
    .join('\n')
}

/**
 * Make the append of `kind` throw once, before anything is written. Every
 * other call goes to the real append.
 */
function failAppend(kind: string): () => number {
  // Read BEFORE `spyOn`: afterwards the namespace property is the mock.
  const real = audit.appendAudit
  let trips = 0
  installed.push(
    spyOn(audit, 'appendAudit').mockImplementation((async (statePath: string, k: string, data: unknown, opts?: unknown) => {
      if (k === kind && trips === 0) {
        trips += 1
        throw new Error(APPEND_SENTINEL)
      }
      return (real as (...args: unknown[]) => Promise<unknown>)(statePath, k, data, opts)
    }) as typeof audit.appendAudit),
  )
  return () => trips
}

/** The code lines of a source file, comment lines dropped, that match `re`. */
function offending(path: string, re: RegExp): string[] {
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((text) => !/^\s*(\*|\/\/|\/\*)/.test(text))
    .filter((text) => re.test(text))
}

/** A temp source file holding `body`, for showing a static check red. */
function fixture(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'warpline-principal-fixture-'))
  const path = join(dir, 'principal.ts')
  writeFileSync(path, `/**\n * A planted offender.\n */\nexport function f(next: { principals: { id: string }[] }, id: string) {\n${body}\n}\n`)
  return path
}

const REMOVAL = /\.(splice|pop|shift|filter)\(|\bdelete\s/
const OS_USER = /process\.env\.(USER|LOGNAME|USERNAME)|userInfo\(|os\.userInfo/

describe('warpline principal', () => {
  test('add, disable and list work end to end, each change on the record before the file, the file at 0600 every time', async () => {
    const realWrite = fsAtomic.atomicWriteJson
    const addedAtWrite: number[] = []
    installed.push(
      spyOn(fsAtomic, 'atomicWriteJson').mockImplementation(async (path, value, opts) => {
        addedAtWrite.push(ofType(ADDED).length + ofType(DISABLED).length)
        return realWrite(path, value, opts)
      }),
    )

    const human = await principal(['add', 'ops', '--type', 'human'])
    expect(human.code).toBe(0)
    expect(human.stderr).toBe('')
    expect(human.stdout.split('\n').filter(Boolean)).toHaveLength(1)
    expect(registry()).toEqual({ principals: [{ id: 'ops', type: 'human', status: 'active' }] })
    expect(mode()).toBe(0o600)
    const opsActive = entryDigest({ id: 'ops', type: 'human', status: 'active' })
    expect(ofType(ADDED).map((l) => l.data)).toEqual([
      { id: 'ops', type: 'human', key_sha256: null, sha256: sha(readFileSync(file())), entry_sha256: opsActive },
    ])

    const machine = await principal(['add', 'ci-bot', '--type', 'machine', '--key', KEY])
    expect(machine.code).toBe(0)
    expect(registry().principals[1]).toEqual({ id: 'ci-bot', type: 'machine', status: 'active', key: KEY })
    expect(mode()).toBe(0o600)
    const bot = entryDigest({ id: 'ci-bot', type: 'machine', status: 'active', key: KEY })
    expect(ofType(ADDED)[1]!.data).toEqual({
      id: 'ci-bot',
      type: 'machine',
      key_sha256: sha(KEY),
      sha256: sha(readFileSync(file())),
      entry_sha256: bot,
    })
    expect(storeText()).not.toContain('PRINCIPAL-KEY-SENTINEL')

    const disabled = await principal(['disable', 'ops'])
    expect(disabled.code).toBe(0)
    expect(disabled.stdout.split('\n').filter(Boolean)).toHaveLength(1)
    expect(registry().principals[0]!.status).toBe('disabled')
    expect(mode()).toBe(0o600)
    expect(ofType(DISABLED).map((l) => l.data)).toEqual([
      {
        id: 'ops',
        sha256: sha(readFileSync(file())),
        entry_sha256: entryDigest({ id: 'ops', type: 'human', status: 'disabled' }),
      },
    ])

    // Each write found its own record already on the store.
    expect(addedAtWrite).toEqual([1, 2, 3])

    const listed = await principal(['list'])
    expect(listed.code).toBe(0)
    expect(listed.stderr).toBe('')
    expect(listed.stdout.split('\n').filter(Boolean)).toEqual(['ops\thuman\tdisabled\tno key', 'ci-bot\tmachine\tactive\tkey'])
    expect(listed.stdout).not.toContain('PRINCIPAL-KEY-SENTINEL')
    expect(storeText()).not.toContain('PRINCIPAL-KEY-SENTINEL')
  })

  test('a registry file that was 0o644 is 0o600 after the next write', async () => {
    writeFileSync(file(), '{ "principals": [] }')
    chmodSync(file(), 0o644)
    expect(mode()).toBe(0o644)

    expect((await principal(['add', 'ops', '--type', 'human'])).code).toBe(0)

    expect(mode()).toBe(0o600)
  })

  test('an id already used, active or disabled, is refused, and so is disabling one twice or one that was never added', async () => {
    expect((await principal(['add', 'ops', '--type', 'human'])).code).toBe(0)
    expect((await principal(['add', 'ci-bot', '--type', 'machine'])).code).toBe(0)
    expect((await principal(['disable', 'ops'])).code).toBe(0)

    for (const argv of [
      ['add', 'ops', '--type', 'human'],
      ['add', 'ops', '--type', 'machine'],
      ['add', 'ci-bot', '--type', 'machine'],
      ['disable', 'ops'],
      ['disable', 'ghost'],
    ]) {
      const bytes = readFileSync(file())
      const count = lines().length

      const { code, stdout, stderr } = await principal(argv)

      expect(code).toBe(1)
      expect(stdout).toBe('')
      expect(stderr).not.toBe('')
      expect(lines()).toHaveLength(count)
      expect(readFileSync(file()).equals(bytes)).toBe(true)
    }
  })

  // A standing grant held by an id reads live again once the id is back, so an
  // id that left the file, by a hand edit or with the whole file, stays used.
  test('an id that left principals.json, by hand or with the whole file, is refused and nothing is written', async () => {
    expect((await principal(['add', 'ops', '--type', 'human'])).code).toBe(0)
    expect((await principal(['add', 'ci', '--type', 'machine'])).code).toBe(0)
    expect((await principal(['add', 'bot', '--type', 'machine'])).code).toBe(0)

    writeFileSync(file(), JSON.stringify({ principals: registry().principals.filter((p) => p.id !== 'ci') }))
    expect((await principal(['list'])).code).toBe(0)
    let bytes = readFileSync(file())
    let count = lines().length

    const handEdit = await principal(['add', 'ci', '--type', 'machine'])

    expect(handEdit.code).toBe(1)
    expect(handEdit.stdout).toBe('')
    expect(handEdit.stderr).toBe('principal add: ci was registered before, and ids are never reused. Nothing was written.\n')
    expect(lines()).toHaveLength(count)
    expect(readFileSync(file()).equals(bytes)).toBe(true)

    rmSync(file())
    count = lines().length

    const wholeFile = await principal(['add', 'bot', '--type', 'machine'])

    expect(wholeFile.code).toBe(1)
    expect(wholeFile.stderr).toBe('principal add: bot was registered before, and ids are never reused. Nothing was written.\n')
    expect(existsSync(file())).toBe(false)
    // The missing file is on the record; no add is.
    expect(ofType(ADDED)).toHaveLength(3)
    expect(lines()).toHaveLength(count + 1)
    expect(lines().at(-1)!.type).toBe(OBSERVED)

    // An id the store never named is still added.
    expect((await principal(['add', 'ci2', '--type', 'machine'])).code).toBe(0)
    bytes = readFileSync(file())
    expect(JSON.parse(bytes.toString('utf-8'))).toEqual({ principals: [{ id: 'ci2', type: 'machine', status: 'active' }] })
  })

  test('with no registry file, list prints nothing, exits 0 and creates nothing', async () => {
    const before = await snapshotHome(home)

    const { code, stdout, stderr } = await principal(['list'])

    expect(code).toBe(0)
    expect(stdout).toBe('')
    expect(stderr).toBe('')
    expect(existsSync(file())).toBe(false)
    expect(existsSync(storeDir())).toBe(false)
    expect(await snapshotHome(home)).toEqual(before)
  })

  test('no entry ever leaves the registry: a disabled principal stays where it was', async () => {
    expect((await principal(['add', 'a', '--type', 'human'])).code).toBe(0)
    expect((await principal(['add', 'b', '--type', 'machine'])).code).toBe(0)
    expect((await principal(['disable', 'a'])).code).toBe(0)

    expect(registry().principals.map((p) => p.id)).toEqual(['a', 'b'])
  })

  test('principal.ts has no code line that removes an entry, and the check finds one in a planted fixture', () => {
    expect(readFileSync(SOURCE, 'utf-8').split('\n').length).toBeGreaterThan(20)
    expect(offending(SOURCE, REMOVAL)).toEqual([])

    const planted = fixture('  next.principals = next.principals.filter((p) => p.id !== id)')
    try {
      expect(offending(planted, REMOVAL)).not.toEqual([])
    } finally {
      rmSync(join(planted, '..'), { recursive: true, force: true })
    }
  })

  test('principal.ts never reads the OS user, the check finds it in a planted fixture, and add with no id is a usage error', async () => {
    expect(readFileSync(SOURCE, 'utf-8').split('\n').length).toBeGreaterThan(20)
    expect(offending(SOURCE, OS_USER)).toEqual([])

    const planted = fixture("  const id = process.env.USER ?? 'me'")
    try {
      expect(offending(planted, OS_USER)).not.toEqual([])
    } finally {
      rmSync(join(planted, '..'), { recursive: true, force: true })
    }

    const before = await snapshotHome(home)
    const { code, stdout, stderr } = await principal(['add', '--type', 'human'])

    expect(code).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toContain('warpline principal add <id>')
    expect(await snapshotHome(home)).toEqual(before)
  })

  test('an id outside the charset and a type outside human and machine are refused and write nothing', async () => {
    for (const argv of [
      ['add', 'Bad Id', '--type', 'human'],
      ['add', '../x', '--type', 'human'],
      ['add', 'ops', '--type', 'robot'],
      ['add', 'ops'],
    ]) {
      const before = await snapshotHome(home)

      const { code, stdout, stderr } = await principal(argv)

      expect(code).toBe(1)
      expect(stdout).toBe('')
      expect(stderr).not.toBe('')
      expect(await snapshotHome(home)).toEqual(before)
    }
  })

  test('a hand edit of the registry is recorded with the changed ids before the verb acts', async () => {
    expect((await principal(['add', 'ops', '--type', 'human'])).code).toBe(0)
    expect((await principal(['add', 'ci-bot', '--type', 'machine'])).code).toBe(0)
    const oldBytes = readFileSync(file())
    const edited = registry()
    edited.principals[0]!.type = 'machine'
    writeFileSync(file(), JSON.stringify(edited))
    const newBytes = readFileSync(file())
    let observedAtPrint: number | undefined

    const { code, stdout } = await principal(['list'], () => {
      observedAtPrint = ofType(OBSERVED).length
    })

    expect(code).toBe(0)
    expect(stdout.split('\n').filter(Boolean)).toHaveLength(2)
    expect(observedAtPrint).toBe(1)
    const observed = ofType(OBSERVED)
    expect(observed).toHaveLength(1)
    expect(observed[0]!.data).toEqual({
      old: sha(oldBytes),
      new: sha(newBytes),
      changed_ids: ['ops'],
      editor: 'unknown',
      changed_entries: { ops: entryDigest({ id: 'ops', type: 'machine', status: 'active' }) },
    })
  })

  describe('when the hand-edit check cannot be recorded', () => {
    test('list refuses with exit 1 and prints nothing', async () => {
      expect((await principal(['add', 'ops', '--type', 'human'])).code).toBe(0)
      let trips = 0
      installed.push(
        spyOn(audit, 'observeAuthorityFile').mockImplementation(async () => {
          trips += 1
          throw new Error(APPEND_SENTINEL)
        }),
      )

      const { code, stdout, stderr } = await principal(['list'])

      expect(trips).toBe(1)
      expect(code).toBe(1)
      expect(stdout).toBe('')
      expect(stderr).not.toContain(APPEND_SENTINEL)
    })
  })

  test('an add followed by a list records no hand edit', async () => {
    expect((await principal(['add', 'ops', '--type', 'human', '--key', KEY])).code).toBe(0)

    expect((await principal(['list'])).code).toBe(0)

    expect(ofType(OBSERVED)).toHaveLength(0)
  })

  test('an add whose record cannot be written exits 1 and leaves no file where there was none', async () => {
    const trips = failAppend('principal.added')

    const { code, stdout, stderr } = await principal(['add', 'ops', '--type', 'human'])

    expect(trips()).toBe(1)
    expect(code).toBe(1)
    expect(existsSync(file())).toBe(false)
    expect(ofType(ADDED)).toHaveLength(0)
    expect(stderr).toContain('The audit store could not record this change. Nothing was written.')
    expect(stdout + stderr).not.toContain(APPEND_SENTINEL)
  })

  test('an add or a disable whose record cannot be written exits 1 and leaves the file byte-identical', async () => {
    expect((await principal(['add', 'ops', '--type', 'human'])).code).toBe(0)
    const bytes = readFileSync(file())

    const addTrips = failAppend('principal.added')
    const added = await principal(['add', 'ci-bot', '--type', 'machine'])
    expect(addTrips()).toBe(1)
    expect(added.code).toBe(1)
    expect(readFileSync(file()).equals(bytes)).toBe(true)
    expect(ofType(ADDED)).toHaveLength(1)

    const disableTrips = failAppend('principal.disabled')
    const disabled = await principal(['disable', 'ops'])
    expect(disableTrips()).toBe(1)
    expect(disabled.code).toBe(1)
    expect(readFileSync(file()).equals(bytes)).toBe(true)
    expect(ofType(DISABLED)).toHaveLength(0)
    expect(added.stdout + added.stderr + disabled.stdout + disabled.stderr).not.toContain(APPEND_SENTINEL)
  })

  test('a principal with a key and one without go through the same add, list and disable, and their records differ only in their own fields', async () => {
    expect((await principal(['add', 'alpha', '--type', 'machine', '--key', KEY])).code).toBe(0)
    expect((await principal(['add', 'beta', '--type', 'machine'])).code).toBe(0)

    const listed = await principal(['list'])
    expect(listed.code).toBe(0)
    expect(listed.stdout.split('\n').filter(Boolean)).toEqual(['alpha\tmachine\tactive\tkey', 'beta\tmachine\tactive\tno key'])

    expect((await principal(['disable', 'alpha'])).code).toBe(0)
    expect((await principal(['disable', 'beta'])).code).toBe(0)
    expect(registry().principals.map((p) => p.status)).toEqual(['disabled', 'disabled'])

    const [withKey, without] = ofType(ADDED).map((l) => l.data)
    expect(Object.keys(withKey!)).toEqual(Object.keys(without!))
    expect(Object.keys(withKey!)).toEqual(['id', 'type', 'key_sha256', 'sha256', 'entry_sha256'])
    expect(withKey!.key_sha256).toBe(sha(KEY))
    expect(without!.key_sha256).toBeNull()
    expect(ofType(DISABLED).map((l) => Object.keys(l.data))).toEqual([
      ['id', 'sha256', 'entry_sha256'],
      ['id', 'sha256', 'entry_sha256'],
    ])
  })
})

describe('a registry past the size one record could carry', () => {
  /** A 64-character id, the longest allowed, unique by its first three characters. */
  const long = (i: number): string => `${String(i).padStart(3, '0')}${'x'.repeat(61)}`
  const active = (id: string, type = 'machine'): Entry => ({ id, type, status: 'active' })

  /** The raw stored lines of one type, as they sit on disk. */
  function raw(type: string): string[] {
    return readdirSync(storeDir())
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
      .flatMap((f) => readFileSync(join(storeDir(), f), 'utf-8').split('\n'))
      .filter((l) => l.length > 0 && (JSON.parse(l) as Line).type === type)
  }

  /** principals.json written by hand, as atomicWriteJson would format it. Returns its bytes. */
  function handWrite(principals: Entry[]): Buffer {
    writeFileSync(file(), JSON.stringify({ principals }, null, 2))
    return readFileSync(file())
  }

  /** A store with one record in it, so a test can plant a line after it. */
  async function seededStore(): Promise<void> {
    await audit.appendAudit(engineStatePath(), 'denial.lifted', { plugin: 'p', fingerprint: 'a'.repeat(64), principal: null })
  }

  test('160 principals with 64-character ids are each added on the record, and no record grows with the registry', async () => {
    const codes: number[] = []
    for (let i = 0; i < 160; i++) codes.push((await principal(['add', long(i), '--type', 'machine'])).code)

    // The index of the first add refused, if any: add number index + 1.
    expect(codes.findIndex((c) => c !== 0)).toBe(-1)
    const listed = await principal(['list'])
    expect(listed.code).toBe(0)
    expect(listed.stdout.split('\n').filter(Boolean)).toHaveLength(160)
    expect(ofType(OBSERVED)).toHaveLength(0)
    const added = raw(ADDED)
    expect(added).toHaveLength(160)
    expect(Math.max(...added.map((l) => Buffer.byteLength(l)))).toBeLessThanOrEqual(1024)
  }, 60_000)

  test('a hand edit that changes more entries than one record can name is refused with that reason, and a smaller one is recorded', async () => {
    expect((await principal(['add', 'ops', '--type', 'human'])).code).toBe(0)
    const ops = active('ops', 'human')

    const big = handWrite([ops, ...Array.from({ length: 120 }, (_, i) => active(long(i)))])
    const storeBefore = storeText()
    const refused = await principal(['list'])
    expect(refused.code).toBe(1)
    expect(refused.stdout).toBe('')
    expect(refused.stderr).toContain('than one audit record can name')
    expect(refused.stderr.trimEnd().endsWith('Nothing was written.')).toBe(true)
    expect(storeText()).toBe(storeBefore)
    expect(readFileSync(file()).equals(big)).toBe(true)

    const forty = Array.from({ length: 40 }, (_, i) => active(long(i)))
    handWrite([ops, ...forty])
    const recorded = await principal(['list'])
    expect(recorded.code).toBe(0)
    const observed = ofType(OBSERVED)
    expect(observed).toHaveLength(1)
    expect(observed[0]!.data.changed_ids).toEqual(forty.map((e) => e.id))
    expect(observed[0]!.data.changed_entries).toEqual(Object.fromEntries(forty.map((e) => [e.id, entryDigest(e)])))
  })

  test('a record written with the whole map and one written with one entry fold into the same carried registry', async () => {
    await seededStore()
    const ops = active('ops', 'human')
    const bytes = handWrite([ops])
    appendRelinked(storeDir(), ADDED, {
      id: 'ops',
      type: 'human',
      key_sha256: null,
      sha256: sha(bytes),
      entries: { ops: entryDigest(ops) },
    })

    expect((await principal(['add', 'ci', '--type', 'machine'])).code).toBe(0)
    const last = ofType(ADDED).at(-1)!.data
    expect(last.entry_sha256).toBe(entryDigest(active('ci')))
    expect(Object.hasOwn(last, 'entries')).toBe(false)

    expect((await principal(['list'])).code).toBe(0)
    expect(ofType(OBSERVED)).toHaveLength(0)

    await audit.appendAudit(engineStatePath(), 'denial.lifted', { plugin: 'p', fingerprint: 'a'.repeat(64), principal: null }, { maxSegmentBytes: 1 })
    const opened = ofType('warpline.audit.segment.opened').at(-1)!.data as {
      authority: { principals: { sha256: string; entries: Record<string, string> } }
    }
    expect(opened.authority.principals).toEqual({
      sha256: sha(readFileSync(file())),
      entries: { ops: entryDigest(ops), ci: entryDigest(active('ci')) },
    })
  })

  test('a record holding both the whole map and one entry is refused by the walk, naming its seq and kind', async () => {
    await seededStore()
    const ops = active('ops', 'human')
    const bytes = handWrite([ops])
    const seq = appendRelinked(storeDir(), ADDED, {
      id: 'ops',
      type: 'human',
      key_sha256: null,
      sha256: sha(bytes),
      entries: { ops: entryDigest(ops) },
      entry_sha256: entryDigest(ops),
    })
    const storeBefore = storeText()

    const { code, stdout, stderr } = await principal(['list'])

    expect(code).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toContain(`seq ${seq} `)
    expect(stderr).toContain('principal.added')
    expect(stderr.trimEnd().endsWith('Nothing was written.')).toBe(true)
    expect(storeText()).toBe(storeBefore)
  })
})

describe('concurrent principal add', () => {
  /** Both calls run under one capture, so neither restores the other's stream. */
  async function both(a: string[], b: string[]): Promise<number[]> {
    const realOut = process.stdout.write
    const realErr = process.stderr.write
    process.stdout.write = (() => true) as typeof process.stdout.write
    process.stderr.write = (() => true) as typeof process.stderr.write
    try {
      return await Promise.all([run(a), run(b)])
    } finally {
      process.stdout.write = realOut
      process.stderr.write = realErr
    }
  }

  test('one id added twice at once: one succeeds, one is refused, one record', async () => {
    const codes = await both(['add', 'alice', '--type', 'human'], ['add', 'alice', '--type', 'human'])

    expect(codes.sort()).toEqual([0, 1])
    expect(ofType(ADDED).map((l) => l.data.id)).toEqual(['alice'])
    expect(registry().principals.map((p) => p.id)).toEqual(['alice'])
  })

  test('two ids added at once: both entries kept, two records', async () => {
    const codes = await both(['add', 'alice', '--type', 'human'], ['add', 'bob', '--type', 'machine'])

    expect(codes).toEqual([0, 0])
    expect(registry().principals.map((p) => p.id).sort()).toEqual(['alice', 'bob'])
    expect(ofType(ADDED).map((l) => l.data.id).sort()).toEqual(['alice', 'bob'])
  })
})
