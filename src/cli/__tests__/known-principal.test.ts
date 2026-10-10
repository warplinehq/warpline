/**
 * "Is this principal id known?" has one answer, `knownPrincipal`, and every
 * verb that asks uses it.
 *
 * Each row below builds a home where exactly one source names `ci`, or where
 * none does, or where one source cannot be read and none names it. Each caller
 * then runs against each row. A source is isolated by keeping the store's
 * carried registry digest equal to the file on disk, so the caller's own
 * observation of `principals.json` records nothing and cannot add a second
 * source behind the row's back. The audit store gets one row per way it can
 * name an id: a `principal.added`, a hand edit's `principal_registry.observed`,
 * and only the registry a later `segment.opened` carries, after the segment
 * that recorded the add was moved aside.
 *
 * Callers:
 * - `principal add ci` widens authority, so a known id is refused, and so is
 *   every add while any source cannot be read.
 * - `revoke --holder ci` narrows it. A known holder goes ahead, and a holder
 *   the standing grants file names is always known, so a revoke with anything
 *   to remove is never refused for want of a registry.
 *
 * Temp homes only (AGENTS.md Rule 2).
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendAudit, observeAuthorityFile } from '../../lib/audit-log.js'
import { _setHome, engineStatePath, principalsPath, standingGrantsPath } from '../../lib/paths.js'
import { writeStandingStore, type StandingGrant } from '../../runtime/approval-gate.js'
import { capture } from './helpers/verb-home.js'

const sha = (data: string): string => createHash('sha256').update(data).digest('hex')
const digest = (id: string, type: string): string => sha(JSON.stringify({ id, type, status: 'active' }))

/** Write principals.json as the verb writes it and return its text. */
function writeRegistry(entries: Array<{ id: string; type: 'human' | 'machine' }>): string {
  const text = JSON.stringify({ principals: entries.map((e) => ({ ...e, status: 'active' })) }, null, 2)
  writeFileSync(principalsPath(), text)
  return text
}

/** A `principal.added` for `id` whose registry digest is `fileText`'s, so the file reads as already seen. */
async function recordAdd(id: string, type: 'human' | 'machine', fileText: string): Promise<void> {
  await appendAudit(engineStatePath(), 'principal.added', {
    id,
    type,
    key_sha256: null,
    sha256: sha(fileText),
    entry_sha256: digest(id, type),
  })
}

/** Rotate onto a second segment, with a line that names no principal. */
async function rotate(): Promise<void> {
  await appendAudit(engineStatePath(), 'denial.lifted', { plugin: 'p', fingerprint: null, principal: null }, { maxSegmentBytes: 1 })
}

const segments = (home: string): string[] => readdirSync(join(home, 'audit')).filter((n) => n.endsWith('.jsonl')).sort()

function grant(holder: string, issuer: string): StandingGrant {
  const now = new Date().toISOString()
  return {
    id: holder === 'ci' ? 'c1c1c1c1c1c1' : 'b0b0b0b0b0b0',
    holder,
    issuer,
    scopes: ['p'],
    issued_at: now,
    period_start: now,
    period_ms: 86_400_000,
    hard_max_ms: 30 * 86_400_000,
  }
}

const writeGrants = (grants: StandingGrant[]): Promise<void> => writeStandingStore({ min_reader_version: 1, grants })

type Expect = { code: number; stdout?: string; stderr?: string }
type Row = {
  name: string
  build: (home: string) => Promise<void>
  add: Expect
  revoke: Expect
}

const IN_USE = (why: string): Expect => ({
  code: 1,
  stdout: '',
  stderr: `principal add: ci ${why}, and ids are never reused. Nothing was written.\n`,
})
const HOLDS_NONE: Expect = { code: 0, stdout: 'ci holds no standing grant. Nothing was revoked.\n', stderr: '' }
const REVOKED: Expect = { code: 0, stdout: 'Revoked 1 standing grant(s) held by ci: c1c1c1c1c1c1.\n' }
const CANNOT_ADD = (what: string): Expect => ({
  code: 1,
  stdout: '',
  stderr: `principal add: ${what} could not be read, so no id can be checked unused. Nothing was written.\n`,
})
const CANNOT_REVOKE = (what: string): Expect => ({
  code: 1,
  stdout: '',
  stderr: `revoke: --holder: ${what} could not be read, and nothing else names that id. Nothing was revoked.\n`,
})

const ROWS: Row[] = [
  {
    name: 'principals.json alone names it',
    build: async () => {
      const text = writeRegistry([
        { id: 'ci', type: 'machine' },
        { id: 'ops', type: 'human' },
      ])
      // The store has seen this file, and names only ops.
      await recordAdd('ops', 'human', text)
    },
    add: IN_USE('is already in the registry'),
    revoke: HOLDS_NONE,
  },
  {
    name: 'the audit store alone names it, on a principal.added',
    build: async () => recordAdd('ci', 'machine', writeRegistry([])),
    add: IN_USE('was registered before'),
    revoke: HOLDS_NONE,
  },
  {
    name: 'the audit store alone names it, on a hand edit it observed',
    build: async () => {
      const text = writeRegistry([])
      await observeAuthorityFile(engineStatePath(), 'principal_registry.observed', Buffer.from(text), {
        ci: digest('ci', 'machine'),
      })
    },
    add: IN_USE('was registered before'),
    revoke: HOLDS_NONE,
  },
  {
    name: 'the audit store alone names it, in a later segment.opened, the add moved aside',
    build: async (home) => {
      await recordAdd('ci', 'machine', writeRegistry([]))
      await rotate()
      const [first, second] = segments(home)
      expect(second).toBeDefined()
      expect(readFileSync(join(home, 'audit', second!), 'utf-8')).toContain('"ci"')
      rmSync(join(home, 'audit', first!))
    },
    add: IN_USE('was registered before'),
    revoke: HOLDS_NONE,
  },
  {
    name: 'the standing grants file alone names it, as holder, and principals.json is missing',
    build: async () => writeGrants([grant('ci', 'boss')]),
    add: IN_USE('is named by a standing grant'),
    revoke: REVOKED,
  },
  {
    name: 'the standing grants file alone names it, as issuer',
    build: async () => writeGrants([grant('bot', 'ci')]),
    add: IN_USE('is named by a standing grant'),
    revoke: HOLDS_NONE,
  },
  {
    name: 'no source names it',
    build: async () => recordAdd('ops', 'human', writeRegistry([{ id: 'ops', type: 'human' }])),
    add: { code: 0, stdout: 'Added ci (machine). The change is on the audit record.\n', stderr: '' },
    revoke: { code: 1, stdout: '', stderr: 'revoke: --holder: no principal has that id. Nothing was revoked.\n' },
  },
  {
    name: 'principals.json cannot be read, and nothing names it',
    build: async () => writeFileSync(principalsPath(), '{not json'),
    add: { code: 1, stdout: '', stderr: 'principals.json is not JSON. Nothing was written.\n' },
    revoke: CANNOT_REVOKE('principals.json'),
  },
  {
    name: 'an audit segment cannot be read, and nothing names it',
    build: async (home) => {
      await recordAdd('ops', 'human', writeRegistry([{ id: 'ops', type: 'human' }]))
      await rotate()
      // A directory where the older segment was: the newest one still reads, every full read fails.
      const first = join(home, 'audit', segments(home)[0]!)
      rmSync(first)
      mkdirSync(first)
    },
    add: CANNOT_ADD('the audit store'),
    revoke: CANNOT_REVOKE('the audit store'),
  },
  {
    name: 'the standing grants file cannot be read, and nothing names it',
    build: async () => writeFileSync(standingGrantsPath(), '{not json'),
    add: CANNOT_ADD('the standing grants file'),
    revoke: {
      code: 1,
      stdout: '',
      stderr:
        'revoke: the standing grants file cannot be read: it is not valid JSON or one of its grants is malformed, and one bad grant makes the whole file unreadable. Moving the file aside drops every standing grant in it at once. Nothing was revoked.\n',
    },
  },
  {
    name: 'the standing grants file names it as holder, and principals.json cannot be read',
    build: async () => {
      writeFileSync(principalsPath(), '{not json')
      await writeGrants([grant('ci', 'boss')])
    },
    add: { code: 1, stdout: '', stderr: 'principals.json is not JSON. Nothing was written.\n' },
    revoke: REVOKED,
  },
]

const CALLERS: Array<[keyof Pick<Row, 'add' | 'revoke'>, string[]]> = [
  ['add', ['principal', 'add', 'ci', '--type', 'machine']],
  ['revoke', ['revoke', '--holder', 'ci']],
]

let home: string | undefined
afterEach(() => {
  _setHome(null)
  if (home !== undefined) rmSync(home, { recursive: true, force: true })
  home = undefined
})

describe('one answer to "is this principal id known?"', () => {
  for (const row of ROWS) {
    for (const [caller, argv] of CALLERS) {
      test(`${argv.slice(0, 2).join(' ')}: ${row.name}`, async () => {
        home = mkdtempSync(join(tmpdir(), 'warpline-known-principal-'))
        mkdirSync(join(home, 'state'), { recursive: true })
        _setHome(home)
        await row.build(home)
        const registryBefore = existsSync(principalsPath()) ? readFileSync(principalsPath(), 'utf-8') : null

        const r = await capture(argv)
        const want = row[caller]

        expect(r.code).toBe(want.code)
        if (want.stdout !== undefined) expect(r.stdout).toBe(want.stdout)
        if (want.stderr !== undefined) expect(r.stderr).toBe(want.stderr)
        // A refused add writes nothing to the registry.
        if (caller === 'add' && want.code !== 0) {
          expect(existsSync(principalsPath()) ? readFileSync(principalsPath(), 'utf-8') : null).toBe(registryBefore)
        }
      })
    }
  }
})
