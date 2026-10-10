/**
 * Every authority verb's record says who acted, and with no `--principal`
 * that is nobody: `principal: null`.
 *
 * The process carries `WARPLINE_PRINCIPAL=ops` and `USER=ops`, and `ops` is a
 * registered active human, so a verb that took its actor from the environment
 * or the account running it would record `ops` here. None may (SPEC R5).
 *
 * The approve and revoke records also say which kind of grant they are about:
 * `kind: 'session'`.
 *
 * Every case gets its own temp home through the shared verb-home helper
 * (AGENTS.md Rule 2).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join, relative } from 'node:path'
import { codeLines, walkImports } from '../../../test-utils/import-walk.js'
import * as audit from '../../lib/audit-log.js'
import { principalsPath, sessionApprovalPath } from '../../lib/paths.js'
import { pathsForStateFile, withStateLockAt } from '../../board/state-manager.js'
import {
  auditRecords,
  capture,
  makeVerbHome,
  restoreSpies,
  seedPrincipals,
  snapshotHome,
  type VerbHome,
} from './helpers/verb-home.js'

let vh: VerbHome
let saved: { principal: string | undefined; user: string | undefined }

beforeEach(async () => {
  vh = makeVerbHome()
  // Every principal is in place before any snapshot, so a later observe of the
  // registry has nothing to record (P10): `alice` is the disabled one.
  await seedPrincipals([
    ['ops', 'human'],
    ['ci', 'machine'],
    ['alice', 'human'],
  ])
  const disabled = await capture(['principal', 'disable', 'alice'])
  if (disabled.code !== 0) throw new Error(`principal disable alice exited ${disabled.code}: ${disabled.stderr}`)
  saved = { principal: process.env.WARPLINE_PRINCIPAL, user: process.env.USER }
  process.env.WARPLINE_PRINCIPAL = 'ops'
  process.env.USER = 'ops'
})

afterEach(() => {
  if (saved.principal === undefined) delete process.env.WARPLINE_PRINCIPAL
  else process.env.WARPLINE_PRINCIPAL = saved.principal
  if (saved.user === undefined) delete process.env.USER
  else process.env.USER = saved.user
  restoreSpies()
  vh.cleanup()
})

/** Run a verb that must succeed. */
async function ok(argv: string[]): Promise<void> {
  const r = await capture(argv)
  if (r.code !== 0) throw new Error(`${argv.join(' ')} exited ${r.code}: ${r.stderr}`)
}

/** The newest record of `kind`, which must exist. */
function newest(kind: string): Record<string, unknown> {
  const records = auditRecords(vh.home, kind)
  expect(records.length).toBeGreaterThan(0)
  return records.at(-1)!
}

/** A key's value, or `'absent'` when the record has no such key, so a missing field never reads as null. */
const field = (record: Record<string, unknown>, key: string): unknown =>
  Object.hasOwn(record, key) ? record[key] : 'absent'

/** builder's Output on the record, then sender approved over it. */
async function contentApproved(): Promise<void> {
  await capture(['advance'])
  await ok(['approve', 'sender', '--content', '--not-after', '2099-01-01T00:00'])
}

describe('no --principal records principal null', () => {
  test('approve p', async () => {
    await ok(['approve', 'p'])

    const record = newest('grant.issued')
    expect({ kind: field(record, 'kind'), principal: field(record, 'principal') }).toEqual({
      kind: 'session',
      principal: null,
    })
  })

  test('approve --all', async () => {
    await ok(['approve', '--all'])

    const record = newest('grant.issued')
    expect({ kind: field(record, 'kind'), principal: field(record, 'principal') }).toEqual({
      kind: 'session',
      principal: null,
    })
  })

  test('approve --content', async () => {
    await contentApproved()

    expect(field(newest('content_approval.issued'), 'principal')).toBeNull()
  })

  test('approve --content --remove', async () => {
    await contentApproved()
    await ok(['approve', 'sender', '--content', '--remove'])

    expect(field(newest('content_approval.withdrawn'), 'principal')).toBeNull()
  })

  test('deny', async () => {
    await ok(['deny', 'p'])

    expect(field(newest('denial.recorded'), 'principal')).toBeNull()
  })

  test('deny --remove', async () => {
    await ok(['deny', 'p'])
    await ok(['deny', '--remove', 'p'])

    expect(field(newest('denial.lifted'), 'principal')).toBeNull()
  })

  test('resolve --intent', async () => {
    const { seq } = await audit.appendAudit(vh.statePath, 'fire.intent', {
      plugin: 'p',
      run_id: 'run-1',
      class: 'session',
      effect_id: null,
      fingerprint: null,
      grants: [],
    })
    await ok(['resolve', '--intent', String(seq), '--not-shipped'])

    expect(field(newest('fire.resolved'), 'principal')).toBeNull()
  })

  test('resolve by plugin', async () => {
    writeFileSync(join(vh.home, 'fail'), '')
    await contentApproved()
    await capture(['advance'])
    const state = JSON.parse(readFileSync(vh.statePath, 'utf-8')) as {
      approvals: Record<string, { effect_id: string | null }>
    }
    const effectId = state.approvals.sender!.effect_id
    expect(effectId).toMatch(/^[0-9a-f]{64}$/)
    await ok(['resolve', 'sender', '--not-shipped', effectId!])

    expect(field(newest('fire.resolved'), 'principal')).toBeNull()
  })

  test('revoke', async () => {
    await ok(['approve', 'p'])
    await ok(['revoke'])

    const record = newest('grant.revoked')
    expect({ kind: field(record, 'kind'), principal: field(record, 'principal') }).toEqual({
      kind: 'session',
      principal: null,
    })
  })
})

/** An open `fire.intent` for p, whose seq `resolve --intent` answers. */
async function openIntent(): Promise<number> {
  const { seq } = await audit.appendAudit(vh.statePath, 'fire.intent', {
    plugin: 'p',
    run_id: 'run-1',
    class: 'session',
    effect_id: null,
    fingerprint: null,
    grants: [],
  })
  return seq
}

/** sender's indeterminate fire, after a failed send, and its effect id. */
async function indeterminateSend(): Promise<string> {
  writeFileSync(join(vh.home, 'fail'), '')
  await contentApproved()
  await capture(['advance'])
  const state = JSON.parse(readFileSync(vh.statePath, 'utf-8')) as {
    approvals: Record<string, { effect_id: string | null }>
  }
  const effectId = state.approvals.sender!.effect_id
  expect(effectId).toMatch(/^[0-9a-f]{64}$/)
  return effectId!
}

describe('a named principal is recorded', () => {
  const ops = ['--principal', 'ops']

  test('approve p', async () => {
    await ok(['approve', 'p', ...ops])

    expect(field(newest('grant.issued'), 'principal')).toBe('ops')
  })

  test('approve p, naming a machine', async () => {
    await ok(['approve', 'p', '--principal', 'ci'])

    expect(field(newest('grant.issued'), 'principal')).toBe('ci')
  })

  test('approve --all', async () => {
    await ok(['approve', '--all', ...ops])

    expect(field(newest('grant.issued'), 'principal')).toBe('ops')
  })

  test('approve --content', async () => {
    await capture(['advance'])
    await ok(['approve', 'sender', '--content', '--not-after', '2099-01-01T00:00', ...ops])

    expect(field(newest('content_approval.issued'), 'principal')).toBe('ops')
  })

  test('approve --content --remove', async () => {
    await contentApproved()
    await ok(['approve', 'sender', '--content', '--remove', ...ops])

    expect(field(newest('content_approval.withdrawn'), 'principal')).toBe('ops')
  })

  test('deny', async () => {
    await ok(['deny', 'p', ...ops])

    expect(field(newest('denial.recorded'), 'principal')).toBe('ops')
  })

  test('deny --remove', async () => {
    await ok(['deny', 'p'])
    await ok(['deny', '--remove', 'p', ...ops])

    expect(field(newest('denial.lifted'), 'principal')).toBe('ops')
  })

  test('resolve --intent', async () => {
    const seq = await openIntent()
    await ok(['resolve', '--intent', String(seq), '--not-shipped', ...ops])

    expect(field(newest('fire.resolved'), 'principal')).toBe('ops')
  })

  test('resolve by plugin', async () => {
    const effectId = await indeterminateSend()
    await ok(['resolve', 'sender', '--not-shipped', effectId, ...ops])

    expect(field(newest('fire.resolved'), 'principal')).toBe('ops')
  })
})

describe('a principal that names nobody writes nothing', () => {
  // Three verbs by three values. Each row asserts its reason, so it can only
  // pass for that reason: an unknown `--principal` option also exits 1 with
  // nothing written.
  const verbs: ReadonlyArray<readonly [string, () => Promise<string[]>]> = [
    ['approve p', async () => ['approve', 'p']],
    ['deny p', async () => ['deny', 'p']],
    ['resolve --intent', async () => ['resolve', '--intent', String(await openIntent()), '--not-shipped']],
  ]
  const values: ReadonlyArray<readonly [string, string, string]> = [
    ['nobody', 'an id no principal has', '--principal: no principal has that id'],
    ['alice', 'a disabled principal', '--principal: that principal is disabled'],
    ['', 'an empty id', '--principal: an empty id names no principal'],
  ]

  for (const [verb, argv] of verbs) {
    for (const [value, what, reason] of values) {
      test(`${verb} --principal naming ${what} exits non-zero, says why, and leaves the home unchanged`, async () => {
        const args = await argv()
        const before = await snapshotHome(vh.home)

        const r = await capture([...args, '--principal', value])

        expect(r.code).not.toBe(0)
        expect(r.stderr).toContain(reason)
        expect(await snapshotHome(vh.home)).toEqual(before)
      })
    }
  }

  test('approve p --principal with no value is a usage error', async () => {
    const before = await snapshotHome(vh.home)

    const r = await capture(['approve', 'p', '--principal'])

    expect(r.code).toBe(1)
    expect(r.stderr).toContain('argument missing')
    expect(await snapshotHome(vh.home)).toEqual(before)
  })
})

describe('the window remembers its issuer', () => {
  type Windows = Record<string, { issuer?: string }>
  const windows = (): Windows =>
    (JSON.parse(readFileSync(sessionApprovalPath(), 'utf-8')) as { scope_windows: Windows }).scope_windows

  test('approve p --principal ops writes p\'s issuer', async () => {
    await ok(['approve', 'p', '--principal', 'ops'])

    expect(windows().p!.issuer).toBe('ops')
  })

  test('approve of another scope by another principal leaves p\'s issuer', async () => {
    // The home has no plugin `q`; `builder` is the other installed scope.
    await ok(['approve', 'p', '--principal', 'ops'])
    await ok(['approve', 'builder', '--principal', 'ci'])

    expect(windows().p!.issuer).toBe('ops')
    expect(windows().builder!.issuer).toBe('ci')
  })

  test('approve p with no --principal removes p\'s issuer', async () => {
    await ok(['approve', 'p', '--principal', 'ops'])
    await ok(['approve', 'p'])

    expect(Object.hasOwn(windows().p!, 'issuer')).toBe(false)
  })
})

describe('the flag is refused where nothing would record it', () => {
  test('approve p --principal ops with a parked result waiting applies nothing and writes nothing', async () => {
    const at = new Date(Date.now() - 30_000).toISOString()
    writeFileSync(
      vh.statePath,
      JSON.stringify({
        schema_version: 1,
        plugin_runs: { p: { last_run_at: at, status: 'gated' } },
        denials: {},
        approvals: {},
        pending_gates: [
          {
            plugin: 'p',
            run_id: 'run-a',
            created_at: at,
            payload_summary: 'p did the thing',
            plugin_result: {
              status: 'success',
              phases_completed: ['p'],
              phases_failed: [],
              errors: [],
              data_freshness: {},
              summary: 'p did the thing',
              artifacts_produced: [],
              schema_version: 2,
            },
            run_started_at: new Date(Date.now() - 60_000).toISOString(),
            run_completed_at: at,
            applied_at: null,
          },
        ],
      }),
    )
    const before = await snapshotHome(vh.home)

    const r = await capture(['approve', 'p', '--principal', 'ops'])

    expect(r.code).toBe(1)
    expect(r.stderr).toContain('applying a parked result is not recorded with a principal')
    expect(await snapshotHome(vh.home)).toEqual(before)
  })

  test('deny --list --principal ops is refused, because --list records nothing', async () => {
    const before = await snapshotHome(vh.home)

    const r = await capture(['deny', '--list', '--principal', 'ops'])

    expect(r.code).toBe(1)
    expect(r.stderr).toContain('--list records nothing')
    expect(await snapshotHome(vh.home)).toEqual(before)
  })
})

test('approve p --principal ops: a principal disabled while approve waits on the state lock is refused', async () => {
  let open!: () => void
  const gate = new Promise<void>((resolve) => {
    open = resolve
  })
  const held = withStateLockAt(pathsForStateFile(vh.statePath).lockPath, () => gate)

  const pending = capture(['approve', 'p', '--principal', 'ops'])
  // Long enough for approve to reach the lock and wait on it.
  await new Promise((resolve) => setTimeout(resolve, 200))
  const registry = JSON.parse(readFileSync(principalsPath(), 'utf-8')) as {
    principals: { id: string; status: string }[]
  }
  for (const p of registry.principals) if (p.id === 'ops') p.status = 'disabled'
  writeFileSync(principalsPath(), JSON.stringify(registry))
  open()
  await held

  const r = await pending

  expect(r.code).toBe(1)
  expect(r.stderr).toContain('--principal: that principal is disabled')
  expect(auditRecords(vh.home, 'grant.issued').filter((g) => g.principal === 'ops')).toEqual([])
  expect(existsSync(sessionApprovalPath())).toBe(false)
})

/**
 * The guard is behavioural first. Every verb that takes or records a
 * principal runs as its own process, the bin a user runs, with every account
 * and principal variable a verb could plausibly read set to a registered
 * principal: `poisonh`, an active human, or `poisonm`, an active machine. A
 * verb that took its actor, holder or issuer from any of them would record it,
 * or would succeed where it must refuse. So `poison` must appear in no stdout,
 * no stderr, and no byte the run added under the home, and every exit code is
 * the one the flags alone give. The account's real name, from the password
 * database rather than the environment, is held to the same rule on the bytes
 * the run wrote, as a JSON string, the shape a recorded id takes.
 *
 * The static scan after it is a secondary tripwire. It reads the whole import
 * closure of every such verb, through the walker the other source guards
 * share, so a read moved into a helper is still in reach.
 */
describe('no verb reads the account running it', () => {
  const BIN = join(import.meta.dir, '..', '..', '..', 'dist', 'bin', 'warpline.js')
  const POISON = 'poison'
  const ACCOUNT_VARS = ['USER', 'LOGNAME', 'USERNAME', 'SUDO_USER', 'WARPLINE_PRINCIPAL', 'WARPLINE_USER', 'WARPLINE_ACTOR', 'WARPLINE_ISSUER']
  const HOLDER_VARS = ['WARPLINE_HOLDER', 'WARPLINE_MACHINE']
  const STANDING = ['--standing', '--hard-max', '30d']

  /** Every file under `dir`, as its bytes. */
  function files(dir: string, prefix = ''): Map<string, Buffer> {
    const out = new Map<string, Buffer>()
    for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) for (const [k, v] of files(dir, rel)) out.set(k, v)
      else if (entry.isFile()) out.set(rel, readFileSync(join(dir, rel)))
    }
    return out
  }

  /**
   * What the run wrote: a new file whole, and every line of a changed file
   * that the file did not hold before, so an appended record and a rewritten
   * entry are both read, and the registry's existing entries are not.
   */
  function written(before: Map<string, Buffer>, after: Map<string, Buffer>): string {
    let out = ''
    for (const [rel, bytes] of after) {
      const old = before.get(rel)
      if (old !== undefined && bytes.equals(old)) continue
      const had = new Set((old ?? Buffer.alloc(0)).toString('utf-8').split('\n'))
      const fresh = bytes.toString('utf-8').split('\n').filter((line) => !had.has(line))
      out += `${rel}\n${fresh.join('\n')}\n`
    }
    return out
  }

  function launch(argv: string[]): { code: number | null; stdout: string; stderr: string } {
    const env: NodeJS.ProcessEnv = { ...process.env, WARPLINE_HOME: vh.home }
    delete env.NODE_ENV
    for (const v of ACCOUNT_VARS) env[v] = 'poisonh'
    for (const v of HOLDER_VARS) env[v] = 'poisonm'
    const r = spawnSync(process.execPath, [BIN, ...argv], { env, encoding: 'utf-8', timeout: 60_000 })
    return { code: r.status, stdout: r.stdout, stderr: r.stderr }
  }

  const standingId = (): string =>
    (JSON.parse(readFileSync(join(vh.home, 'standing-grants.json'), 'utf-8')) as { grants: { id: string }[] }).grants[0]!.id

  type Case = { argv: () => string[]; code: number; setup?: () => Promise<void> }
  const CASES: Record<string, Case> = {
    'approve p': { argv: () => ['approve', 'p'], code: 0 },
    'approve --all': { argv: () => ['approve', '--all'], code: 0 },
    'approve p --principal ops': { argv: () => ['approve', 'p', '--principal', 'ops'], code: 0 },
    'approve --content': {
      setup: async () => void (await capture(['advance'])),
      argv: () => ['approve', 'sender', '--content', '--not-after', '2099-01-01T00:00'],
      code: 0,
    },
    'approve --content --remove': {
      setup: contentApproved,
      argv: () => ['approve', 'sender', '--content', '--remove'],
      code: 0,
    },
    'approve --standing with no --principal': { argv: () => ['approve', 'p', '--holder', 'ci', ...STANDING], code: 1 },
    'approve --standing with no --holder': { argv: () => ['approve', 'p', '--principal', 'ops', ...STANDING], code: 1 },
    'renew with no --principal': {
      setup: () => ok(['approve', 'p', '--holder', 'ci', '--principal', 'ops', ...STANDING]),
      argv: () => ['renew', standingId()],
      code: 1,
    },
    'revoke': { setup: () => ok(['approve', 'p']), argv: () => ['revoke'], code: 0 },
    'revoke --holder': {
      setup: () => ok(['approve', 'p', '--holder', 'ci', '--principal', 'ops', ...STANDING]),
      argv: () => ['revoke', '--holder', 'ci'],
      code: 0,
    },
    'revoke --standing': {
      setup: () => ok(['approve', 'p', '--holder', 'ci', '--principal', 'ops', ...STANDING]),
      argv: () => ['revoke', '--standing', standingId()],
      code: 0,
    },
    'deny': { argv: () => ['deny', 'p'], code: 0 },
    'deny --remove': { setup: () => ok(['deny', 'p']), argv: () => ['deny', '--remove', 'p'], code: 0 },
    'resolve --intent': {
      setup: async () => void (seq = await openIntent()),
      argv: () => ['resolve', '--intent', String(seq), '--not-shipped'],
      code: 0,
    },
    'resolve by plugin': {
      setup: async () => void (effectId = await indeterminateSend()),
      argv: () => ['resolve', 'sender', '--not-shipped', effectId],
      code: 0,
    },
    'principal add': { argv: () => ['principal', 'add', 'newbot', '--type', 'machine'], code: 0 },
    'principal disable': { argv: () => ['principal', 'disable', 'ci'], code: 0 },
  }
  let seq = 0
  let effectId = ''

  for (const [name, c] of Object.entries(CASES)) {
    test(`${name}: no account or principal variable reaches its output or its record`, async () => {
      await seedPrincipals([
        ['poisonh', 'human'],
        ['poisonm', 'machine'],
      ])
      await c.setup?.()
      const before = files(vh.home)

      const r = launch(c.argv())
      const wrote = written(before, files(vh.home))

      expect({ code: r.code, stderr: r.code === c.code ? '' : r.stderr }).toEqual({ code: c.code, stderr: '' })
      expect(r.stdout).not.toContain(POISON)
      expect(r.stderr).not.toContain(POISON)
      expect(wrote).not.toContain(POISON)
      expect(wrote).not.toContain(JSON.stringify(userInfo().username))
      // The run wrote something, or refused: a check over nothing proves nothing.
      if (c.code === 0) expect(wrote).not.toBe('')
    })
  }

  // Each alternative is one shape a read of the environment or the account takes.
  const OS_USER = new RegExp(
    [
      String.raw`\b(process|Bun)\s*(\?\.|\.|\[)\s*['"` + '`' + String.raw`]?env\b`,
      String.raw`['"` + '`' + String.raw`]env['"` + '`' + ']',
      String.raw`\{[^}]*\benv\b[^}]*\}\s*=\s*(globalThis\s*\.\s*)?process\b`,
      String.raw`\bimport\.meta\.env\b`,
      String.raw`\buserInfo\b`,
      String.raw`['"` + '`' + String.raw`](node:)?(os|process)['"` + '`' + ']',
      String.raw`\b(USER|LOGNAME|USERNAME|WARPLINE_PRINCIPAL)\b`,
      // A held reference: process passed, assigned or returned as a value.
      String.raw`(?:[=(,:?]|\breturn)\s*(globalThis\s*\.\s*)?process\b(?!\s*(?:\?\.|\.|\[))`,
    ].join('|'),
  )

  /** `<file>:<line>: <code>` for every code line in the closure of `entries` that matches `re`. */
  async function readsOfTheAccount(entries: string[], root: string, re: RegExp): Promise<string[]> {
    const closure = new Map<string, string>()
    for (const entry of entries) for (const [file, source] of await walkImports(entry)) closure.set(file, source)
    const out: string[] = []
    for (const [file, source] of closure) {
      for (const [n, code] of codeLines(source)) if (re.test(code)) out.push(`${relative(root, file)}:${n}: ${code.trim()}`)
    }
    return out.sort()
  }

  /**
   * The reads the closure holds on purpose, each pinned by its whole code line,
   * so a second read added to one of these lines changes it and fails.
   */
  const KNOWN_READS = [
    'lib/paths.ts: const env = process.env.WARPLINE_HOME',
    'lib/paths.ts: const env = process.env.WARPLINE_PLUGINS_DIR',
    'runtime/secrets.ts: env: Record<string, string | undefined> = process.env,',
  ]

  test('the import closure of every verb taking --principal or --holder reads the environment only where pinned', async () => {
    const src = join(import.meta.dir, '..', '..')
    const verbs = ['approve', 'deny', 'resolve', 'renew', 'revoke', 'principal'].map((v) => join(src, 'cli', `${v}.ts`))
    const found = await readsOfTheAccount(verbs, src, OS_USER)
    expect(found.map((line) => line.replace(/:\d+:/, ':'))).toEqual(KNOWN_READS)
    // The closure reaches the registry module and past it, so a helper is in reach.
    const closure = await walkImports(verbs[0]!)
    expect(closure.size).toBeGreaterThan(20)
    expect([...closure.keys()].some((f) => f.endsWith(join('lib', 'principals.ts')))).toBe(true)
  })

  test('the scan finds a planted read in every shape, a module away, and after a block comment', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warpline-principal-flag-fixture-'))
    const planted: Record<string, string> = {
      'dot.ts': 'const who = process.env.USER ?? null',
      'bracket-key.ts': "const who = process.env['USER'] ?? null",
      'destructure-key.ts': 'const { USER: who } = process.env',
      'principal-var.ts': 'const who = process.env.WARPLINE_PRINCIPAL',
      'bun-env.ts': 'const who = Bun.env.LOGNAME',
      'user-info.ts': "import { userInfo } from 'node:os'",
      'process-module.ts': "import { env } from 'node:process'",
      'double-quoted-env.ts': 'const who = process["env"].USER',
      'single-quoted-env.ts': "const who = process['env'].USER",
      'template-env.ts': 'const who = process[`env`].USER',
      'destructure-env.ts': 'const { env } = process',
      'import-meta.ts': 'const who = import.meta.env.USER',
      'held-reference.ts': 'const p = process',
      'reflect.ts': "const e = Reflect.get(process, 'env')",
      'template-import.ts': 'const os = await import(`node:os`)',
      'block-comment.ts': '/* note */ const who = process.env.LOGNAME',
      'doc-close.ts': '/**\n * a doc comment\n */ const who = process.env.USERNAME',
    }
    const root = [
      ...Object.keys(planted).map((f, i) => `import * as m${i} from './${f.replace(/\.ts$/, '.js')}'`),
      "import { h } from './helper.js'",
      '',
    ].join('\n')
    try {
      writeFileSync(join(dir, 'root.ts'), root)
      writeFileSync(join(dir, 'helper.ts'), "import { deep } from './deep.js'\nexport const h = deep\n")
      writeFileSync(join(dir, 'deep.ts'), 'export const deep = process.env.USER\n')
      for (const [f, body] of Object.entries(planted)) writeFileSync(join(dir, f), `${body}\n// a comment naming process.env.USER only\n`)

      const found = await readsOfTheAccount([join(dir, 'root.ts')], dir, OS_USER)
      expect([...new Set(found.map((line) => line.split(':')[0]))].sort()).toEqual([...Object.keys(planted), 'deep.ts'].sort())
      // Each file once: the comment line under every plant is never reported.
      expect(found).toHaveLength(Object.keys(planted).length + 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
