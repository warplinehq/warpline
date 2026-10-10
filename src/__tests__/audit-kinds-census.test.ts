/**
 * Every audit record kind is accounted for: the store writes it itself, a
 * production call emits it, or it waits on the pending list.
 *
 * The record kinds are a closed set. Each one has a production emit site, or
 * sits on the pending list below naming the roadmap work that wires it. That
 * work removes its entry in the same commit that wires the kind, and the list
 * is empty when the milestone closes. Entries name the work by its title,
 * because a tracked file may not carry a phase number.
 *
 * An emit site is a call, not a mention. A kind's quoted name also lives in
 * type unions, failure records and stderr branches that outlive the append
 * they describe, so only the quoted kind on the line that names an
 * `appendAudit(` or `observeAuthorityFile(` call counts. The rule is a blunt
 * line rule, the way the mint call-site guard is blunt: outside the store
 * module, a line naming either function is a one-line plain import or such a
 * call, and anything else is an offender. A helper that takes the kind as a
 * variable, an alias, or a call split across lines is a site the census cannot
 * read, and it must say so rather than read zero.
 */
import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendAudit, AUDIT_KINDS, INTERNAL_KINDS } from '../lib/audit-log.js'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const STORE = 'src/lib/audit-log.ts'

const EXPECTED_KINDS = [
  'grant.issued',
  'grant.renewed',
  'grant.revoked',
  'content_approval.issued',
  'content_approval.withdrawn',
  'denial.recorded',
  'denial.lifted',
  'fire.intent',
  'fire.outcome',
  'fire.refused',
  'fire.resolved',
  'principal.added',
  'principal.disabled',
  'principal_registry.observed',
  'preference.set',
  'preferences.observed',
  'ask.raised',
  'ask.answered',
  'handoff.tried',
  'segment.opened',
  'segment.sealed',
  'checkpoint.recorded',
]

const INTERNAL = ['segment.opened', 'segment.sealed', 'checkpoint.recorded']

/** Kinds with no emit call yet, each naming the roadmap work that wires it. */
const PENDING: Record<string, string> = {
  'ask.raised': 'asks out of band',
  'ask.answered': 'asks out of band',
  'handoff.tried': 'warpline consume',
}

// By absolute path: the bare names resolve here to a tool that honours ignore
// files, and it has returned a false zero over this repository before.
const FIND = '/usr/bin/find'
const GREP = '/usr/bin/grep'

/** A call with its first argument and quoted kind on one line. Group 2 is the kind. */
const CALL = /\b(appendAudit|observeAuthorityFile)\([^,]*, '([a-z_.]+)'/g
const NAME = /\b(appendAudit|observeAuthorityFile)\b/g
const IMPORT = /^import (type )?\{[^}]*\} from '[^']+'/
const ALIAS = /\b(appendAudit|observeAuthorityFile)\s+as\b/

type Sites = Record<string, string[]>

/** Every non-test `.ts` file under `src/`. Empty throws: that did not look. */
function sourceFiles(): string[] {
  const out = execFileSync(
    FIND,
    [join(REPO_ROOT, 'src'), '-name', '*.ts', '-not', '-path', '*__tests__*', '-not', '-name', '*.test.ts'],
    { encoding: 'utf8' },
  )
  const files = out.split('\n').filter(Boolean)
  if (files.length === 0) throw new Error('blind: no non-test source file enumerated under src')
  return files
}

/**
 * The kinds each file emits, and every line naming the store's functions that
 * is neither a one-line plain import nor a one-line call with its quoted kind.
 * Takes the file list, so the same code runs on the real tree and on fixtures.
 */
function emitSites(files: string[], root: string): { sites: Sites; offenders: string[] } {
  let out: string
  try {
    out = execFileSync(GREP, ['-nH', '-e', 'appendAudit', '-e', 'observeAuthorityFile', ...files], {
      encoding: 'utf8',
    })
  } catch (err) {
    if ((err as { status?: number }).status === 1) return { sites: {}, offenders: [] }
    throw err
  }
  const found = new Map<string, Set<string>>()
  const offenders: string[] = []
  for (const hit of out.split('\n').filter(Boolean)) {
    const m = /^(.*?):(\d+):(.*)$/.exec(hit)
    if (m === null) throw new Error(`unparsed grep line: ${hit}`)
    const [, file, line, raw] = m as unknown as [string, string, string, string]
    const rel = file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file
    // The store passes a variable kind internally, by design.
    if (rel === STORE) continue
    const trimmed = raw.trimStart()
    if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue
    const text = raw.replace(/\s\/\/.*$/, '')
    const names = [...text.matchAll(NAME)].map((n) => n.index)
    if (names.length === 0) continue
    if (IMPORT.test(trimmed) && !ALIAS.test(text)) continue
    const calls = [...text.matchAll(CALL)]
    const heads = new Set(calls.map((c) => c.index))
    if (names.every((i) => heads.has(i))) {
      for (const c of calls) {
        const kind = c[2] as string
        if (!found.has(kind)) found.set(kind, new Set())
        found.get(kind)?.add(rel)
      }
    } else {
      offenders.push(`${rel}:${line}`)
    }
  }
  const sites: Sites = {}
  for (const kind of [...found.keys()].sort()) sites[kind] = [...(found.get(kind) ?? [])].sort()
  return { sites, offenders }
}

/** What breaks the rule that each kind is exactly one of internal, sited or pending. */
function census(
  kinds: readonly string[],
  internal: readonly string[],
  sites: Sites,
  pending: Record<string, string>,
  offenders: string[],
): string[] {
  const out: string[] = []
  for (const kind of kinds) {
    const at = sites[kind]
    if (internal.includes(kind)) {
      if (at !== undefined) out.push(`${kind}: written by the store itself, yet has an emit call in ${at.join(', ')}`)
      continue
    }
    if (kind in pending && at !== undefined) {
      out.push(`${kind}: pending (${pending[kind]}), yet has an emit call in ${at.join(', ')}`)
    } else if (!(kind in pending) && at === undefined) {
      out.push(`${kind}: no emit call and no pending entry`)
    }
  }
  for (const key of Object.keys(pending)) {
    if (!kinds.includes(key)) out.push(`${key}: pending, but not a record kind`)
  }
  for (const [kind, at] of Object.entries(sites)) {
    if (!kinds.includes(kind)) out.push(`${kind}: an emit call for a kind outside the set, in ${at.join(', ')}`)
  }
  for (const line of offenders) out.push(`${line}: names the store's functions in a line the census cannot read`)
  return out
}

function fixture(files: Record<string, string>): { dir: string; paths: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'warpline-audit-census-'))
  const paths = Object.entries(files).map(([name, body]) => {
    const p = join(dir, name)
    writeFileSync(p, body)
    return p
  })
  return { dir, paths }
}

function withFixture<T>(files: Record<string, string>, fn: (dir: string, paths: string[]) => T): T {
  const { dir, paths } = fixture(files)
  try {
    return fn(dir, paths)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const real = () => emitSites(sourceFiles(), REPO_ROOT)

describe('the record kinds are a closed set', () => {
  test('the store lists exactly the expected kinds, in order, three of them its own', () => {
    expect<string[]>([...AUDIT_KINDS]).toEqual(EXPECTED_KINDS)
    expect<string[]>([...INTERNAL_KINDS]).toEqual(INTERNAL)
  })

  test('the store writes its own kinds: a rotation leaves opened, sealed and a checkpoint', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'warpline-audit-census-store-'))
    try {
      const statePath = join(tmp, 'state', 'engine-state.json')
      for (const plugin of ['a', 'b', 'c']) {
        await appendAudit(statePath, 'denial.lifted', { plugin, fingerprint: null, principal: null }, { maxSegmentBytes: 1 })
      }
      const dir = join(tmp, 'audit')
      const types = new Set<string>()
      for (const name of readdirSync(dir).filter((n) => n.endsWith('.jsonl'))) {
        for (const line of readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean)) {
          types.add((JSON.parse(line) as { type: string }).type)
        }
      }
      for (const kind of INTERNAL) expect(types).toContain(`warpline.audit.${kind}`)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('every record kind has an emit call or a pending entry', () => {
  test('the real tree: no offender, the three pending kinds, and every other kind called', () => {
    const { sites, offenders } = real()
    expect(offenders).toEqual([])
    expect(census(EXPECTED_KINDS, INTERNAL, sites, PENDING, offenders)).toEqual([])
    expect(Object.keys(PENDING)).toEqual(['ask.raised', 'ask.answered', 'handoff.tried'])
    const wired = EXPECTED_KINDS.filter((k) => !INTERNAL.includes(k) && !(k in PENDING))
    for (const kind of wired) expect(sites[kind]?.length ?? 0).toBeGreaterThan(0)
    expect(INTERNAL.length + wired.length + Object.keys(PENDING).length).toBe(EXPECTED_KINDS.length)
    expect(Object.keys(sites)).toContain('preferences.observed')
    expect(Object.keys(sites)).toContain('principal_registry.observed')
  })

  test('a kind named in a union, a failure record, a branch or a comment, with no call, is not a site', () => {
    const body = [
      "export interface Failure { kind: 'fire.intent' | 'fire.outcome' | 'fire.refused' }",
      "audit_failures.push({ plugin, kind: 'fire.outcome' })",
      "if (f.kind === 'fire.refused') process.stderr.write('x')",
      "// appendAudit(stateDir, 'fire.outcome', {})",
      "/** appendAudit(stateDir, 'fire.refused', {}) */",
      " * appendAudit(stateDir, 'fire.refused', {})",
      "audit_failures.push({ plugin, kind: 'fire.refused' }) // appendAudit(stateDir, 'fire.refused', {})",
      "await appendAudit(stateDir, 'fire.intent', { plugin })",
      '',
    ].join('\n')
    withFixture({ 'names.ts': body }, (dir, paths) => {
      const { sites, offenders } = emitSites(paths, dir)
      expect(sites).toEqual({ 'fire.intent': ['names.ts'] })
      expect(offenders).toEqual([])
      expect(census(['fire.intent', 'fire.outcome', 'fire.refused'], [], sites, {}, offenders)).toEqual([
        'fire.outcome: no emit call and no pending entry',
        'fire.refused: no emit call and no pending entry',
      ])
    })
  })

  test('a one-line import, a call whose data continues below, and an observe call each count', () => {
    const body = [
      "import { appendAudit, observeAuthorityFile, type AuditKind } from '../lib/audit-log.js'",
      "await appendAudit(statePath, 'grant.issued', {",
      "  scopes: ['*'],",
      '  ttl_ms: null,',
      '  replace: false,',
      '})',
      "await observeAuthorityFile(engineStatePath(), 'principal_registry.observed', bytes, entries(current))",
      '',
    ].join('\n')
    withFixture({ 'counts.ts': body }, (dir, paths) => {
      const { sites, offenders } = emitSites(paths, dir)
      expect(sites).toEqual({ 'grant.issued': ['counts.ts'], 'principal_registry.observed': ['counts.ts'] })
      expect(offenders).toEqual([])
    })
  })

  test('a helper, an alias, a bare reference and a split call are offenders, and a comma in the first argument misreads the kind', () => {
    const body = [
      'function record(kind: EmitKind, data: unknown) { return appendAudit(statePath, kind, data) }',
      "import { appendAudit as rec } from '../lib/audit-log.js'",
      "rec(p, 'fire.outcome', {})",
      'const writer = observeAuthorityFile',
      'await appendAudit(',
      '  statePath,',
      "  'fire.outcome',",
      '  {},',
      ')',
      "await appendAudit(join(home, 'state'), 'grant.issued', {})",
      '',
    ].join('\n')
    withFixture({ 'offenders.ts': body }, (dir, paths) => {
      const { sites, offenders } = emitSites(paths, dir)
      expect(offenders).toEqual(['offenders.ts:1', 'offenders.ts:2', 'offenders.ts:4', 'offenders.ts:5'])
      expect(sites).toEqual({ state: ['offenders.ts'] })
      const found = census(EXPECTED_KINDS, INTERNAL, sites, PENDING, offenders)
      for (const line of offenders) {
        expect(found).toContain(`${line}: names the store's functions in a line the census cannot read`)
      }
      expect(found).toContain('state: an emit call for a kind outside the set, in offenders.ts')
    })
  })

  test('a kind added to the set with no emit call and no pending entry is reported', () => {
    const { sites } = real()
    expect(census([...EXPECTED_KINDS, 'grant.extended'], INTERNAL, sites, PENDING, [])).toEqual([
      'grant.extended: no emit call and no pending entry',
    ])
    expect(census(EXPECTED_KINDS, INTERNAL, sites, { ...PENDING, 'grant.extended': 'standing grants' }, [])).toEqual([
      'grant.extended: pending, but not a record kind',
    ])
  })

  test('a pending kind that gains an emit call is reported, so its entry has to go', () => {
    const { sites } = real()
    withFixture({ 'wired.ts': "await appendAudit(p, 'ask.raised', {})\n" }, (dir, paths) => {
      const planted = emitSites(paths, dir)
      expect(planted.offenders).toEqual([])
      const merged = { ...sites, ...planted.sites }
      expect(census(EXPECTED_KINDS, INTERNAL, merged, PENDING, [])).toEqual([
        'ask.raised: pending (asks out of band), yet has an emit call in wired.ts',
      ])
    })
  })

  test('the search binaries are absolute paths', () => {
    expect([FIND, GREP]).toEqual(['/usr/bin/find', '/usr/bin/grep'])
  })
})
