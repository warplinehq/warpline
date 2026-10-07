/**
 * Every CLI effect is on the audit record before it happens, and an effect
 * whose record cannot be written does not happen.
 *
 * Each effect gets two cases at least. One proves the order: a pass-through
 * spy on the state write looks at the store at the moment the write is called,
 * and the record must already be there. The other forces the append to fail
 * once, through a namespace spy, and requires the verb to refuse with the
 * whole home byte-identical. A spawned case covers the path no spy can reach:
 * the real bin against a store it cannot write.
 *
 * The append spy is read before `spyOn` and calls through for every other
 * kind, so a verb that appends several records only loses the one named. Its
 * trip count is asserted, so a spy that never fired cannot pass a case.
 *
 * Everything this file writes goes under temp dirs (AGENTS.md Rule 2).
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import * as audit from '../../lib/audit-log.js'
import * as store from '../../runtime/engine-state-store.js'
import * as gate from '../../runtime/approval-gate.js'
import { approvalStanding, loadPluginManifests } from '../../runtime/engine.js'
import { _setHome, lockPath as runLockPath } from '../../lib/paths.js'
import { acquireLock, releaseLock } from '../../runtime/lock.js'
import { snapshotHome } from '../../runtime/__tests__/helpers/snapshot-home.js'
import { appendRelinked } from '../../lib/__tests__/helpers/audit-chain.js'
import { testFixturesDir } from '../../../test-utils/fixtures.js'
import { main } from '../warpline.js'

/** The built bin, the path a real consumer runs. */
const BIN = testFixturesDir(import.meta.url, '../../../dist/bin/warpline.js')

/** The spy's error message. It must never reach a file. */
const SENTINEL = 'WARPLINE_AUDIT_APPEND_SPY_SENTINEL'

/** Every field spelled out, so the fixture never leans on a schema default. */
function manifest(name: string): Record<string, unknown> {
  return {
    name,
    version: '1.0.0',
    description: `${name} fixture plugin`,
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
}

/** A home holding one plugin, `p`, and an empty state directory. */
function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'warpline-audit-effects-'))
  mkdirSync(join(home, 'plugins', 'p'), { recursive: true })
  writeFileSync(join(home, 'plugins', 'p', 'manifest.ts'), `export const manifest = ${JSON.stringify(manifest('p'))}`)
  mkdirSync(join(home, 'state'), { recursive: true })
  return home
}

/** Run main(argv) with stdout/stderr captured, always restoring the originals. */
async function capture(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const realOut = process.stdout.write
  const realErr = process.stderr.write
  let stdout = ''
  let stderr = ''
  process.stdout.write = ((chunk: string) => {
    stdout += chunk
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

type Line = { type: string; warplineseq: number; data: Record<string, unknown> }

/** Every stored line under `<home>/audit/`, segments in name order. */
function auditLines(home: string): Line[] {
  const dir = join(home, 'audit')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .flatMap((f) =>
      readFileSync(join(dir, f), 'utf-8')
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as Line),
    )
}

/** Every file under `dir`, recursively, as text, keyed by path relative to `dir`. */
function filesUnder(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const child = join(current, entry.name)
      if (entry.isDirectory()) walk(child)
      else if (entry.isFile()) out[relative(dir, child)] = readFileSync(child, 'utf-8')
    }
  }
  walk(dir)
  return out
}

let home: string
let installed: ReturnType<typeof spyOn>[] = []

beforeEach(() => {
  home = makeHome()
  _setHome(home)
})

afterEach(() => {
  for (const spy of installed) spy.mockRestore()
  installed = []
  _setHome(null)
  rmSync(home, { recursive: true, force: true })
})

/**
 * Make the append of `kind` throw once, before anything is written. Every
 * other call goes to the real append.
 */
function failAppend(kind: string): { trips: () => number } {
  // Read BEFORE `spyOn`: afterwards the namespace property is the mock.
  const real = audit.appendAudit
  let trips = 0
  const spy = spyOn(audit, 'appendAudit').mockImplementation((async (
    statePath: string,
    k: string,
    data: unknown,
    opts?: unknown,
  ) => {
    if (k === kind && trips === 0) {
      trips += 1
      throw new Error(SENTINEL)
    }
    return (real as (...args: unknown[]) => Promise<unknown>)(statePath, k, data, opts)
  }) as typeof audit.appendAudit)
  installed.push(spy)
  return { trips: () => trips }
}

/**
 * Make the first state-document write throw, as a full disk would, before
 * anything is written. Every later call goes to the real write.
 */
function failStateWriteOnce(): { trips: () => number } {
  // Read BEFORE `spyOn`, as in `failAppend`.
  const real = store.writeEngineState
  let trips = 0
  const spy = spyOn(store, 'writeEngineState').mockImplementation(async (payload, path) => {
    if (trips === 0) {
      trips += 1
      throw Object.assign(new Error(SENTINEL), { code: 'ENOSPC' })
    }
    return real(payload, path)
  })
  installed.push(spy)
  return { trips: () => trips }
}

/** `capture`, with a rejection read as `undefined` rather than failing the case. */
async function captureOrThrown(argv: string[]): Promise<{ code: number; stdout: string; stderr: string } | undefined> {
  try {
    return await capture(argv)
  } catch {
    return undefined
  }
}

describe('deny', () => {
  test('deny p writes its record before the state write', async () => {
    const realWrite = store.writeEngineState
    let recordedFirst: boolean | undefined
    installed.push(
      spyOn(store, 'writeEngineState').mockImplementation(async (payload, path) => {
        recordedFirst ??= auditLines(home).some((l) => l.type === 'warpline.audit.denial.recorded')
        return realWrite(payload, path)
      }),
    )

    const { code } = await capture(['deny', 'p'])

    expect(code).toBe(0)
    expect(recordedFirst).toBe(true)
    const state = JSON.parse(readFileSync(join(home, 'state', 'engine-state.json'), 'utf-8')) as {
      denials: Record<string, { fingerprint: string }>
    }
    const records = auditLines(home).filter((l) => l.type === 'warpline.audit.denial.recorded')
    expect(records).toHaveLength(1)
    expect(records[0]!.data).toEqual({
      plugin: 'p',
      fingerprint: state.denials.p!.fingerprint,
      discarded_gate_run_id: null,
    })
  })

  test('deny p refuses with the home byte-identical when its record cannot be written', async () => {
    const before = await snapshotHome(home)
    const spy = failAppend('denial.recorded')

    const { code, stderr } = await capture(['deny', 'p'])

    expect(code).toBe(1)
    expect(stderr).toContain('Nothing was denied')
    expect(spy.trips()).toBe(1)
    expect(await snapshotHome(home)).toEqual(before)
    for (const [path, text] of Object.entries(filesUnder(home))) {
      expect(`${path}: ${text.includes(SENTINEL)}`).toBe(`${path}: false`)
    }
  })

  test.skipIf(process.getuid?.() === 0)(
    'deny p through the real bin refuses when the audit directory is read-only (skipped as root: chmod cannot deny root)',
    () => {
      const auditDir = join(home, 'audit')
      mkdirSync(auditDir)
      chmodSync(auditDir, 0o500)
      const statePath = join(home, 'state', 'engine-state.json')
      const stateBefore = existsSync(statePath) ? readFileSync(statePath) : null
      try {
        const env: NodeJS.ProcessEnv = { ...process.env, WARPLINE_HOME: home }
        delete env.NODE_ENV
        const r = spawnSync(process.execPath, [BIN, 'deny', 'p'], { env, encoding: 'utf-8', timeout: 60_000 })

        expect(r.status).toBe(1)
        if (stateBefore === null) expect(existsSync(statePath)).toBe(false)
        else expect(readFileSync(statePath)).toEqual(stateBefore)
      } finally {
        chmodSync(auditDir, 0o700)
      }
    },
  )
})

// -- Grant, revoke, content approval and denial lift (25-04) -----------------

/** Write one plugin into the home, the fixture manifest with `overrides` on top. */
function addPlugin(name: string, overrides: Record<string, unknown> = {}): void {
  mkdirSync(join(home, 'plugins', name), { recursive: true })
  writeFileSync(
    join(home, 'plugins', name, 'manifest.ts'),
    `export const manifest = ${JSON.stringify({ ...manifest(name), ...overrides })}`,
  )
}

/** No file under the home holds the spy's sentinel. */
function expectNoSentinel(): void {
  for (const [path, text] of Object.entries(filesUnder(home))) {
    expect(`${path}: ${text.includes(SENTINEL)}`).toBe(`${path}: false`)
  }
}

/** The data of every stored record of `kind`, in seq order. */
function recordsOf(kind: string): Record<string, unknown>[] {
  return auditLines(home)
    .filter((l) => l.type === `warpline.audit.${kind}`)
    .map((l) => l.data)
}

/**
 * A pass-through spy on `fn` of `mod` that notes, at its first call, whether a
 * record of `kind` is already on disk.
 */
function recordedBefore(mod: Record<string, unknown>, fn: string, kind: string): () => boolean | undefined {
  const real = mod[fn] as (...args: unknown[]) => unknown
  let seen: boolean | undefined
  installed.push(
    spyOn(mod as Record<string, (...args: unknown[]) => unknown>, fn).mockImplementation((...args: unknown[]) => {
      seen ??= recordsOf(kind).length > 0
      return real(...args)
    }),
  )
  return () => seen
}

const grantPath = (): string => join(home, '.session-approval')
const statePathOf = (): string => join(home, 'state', 'engine-state.json')

describe('grant issue and revoke', () => {
  beforeEach(() => {
    addPlugin('mailer')
  })

  test('approve mailer writes grant.issued before mergeGrant runs', async () => {
    const seen = recordedBefore(gate, 'mergeGrant', 'grant.issued')

    const { code } = await capture(['approve', 'mailer'])

    expect(code).toBe(0)
    expect(seen()).toBe(true)
    expect(recordsOf('grant.issued')).toEqual([{ scopes: ['mailer'], ttl_ms: null, replace: false, long: false }])
  })

  test('approve mailer --ttl 30m --replace records the requested ttl and the replace flag', async () => {
    const { code } = await capture(['approve', 'mailer', '--ttl', '30m', '--replace'])

    expect(code).toBe(0)
    expect(recordsOf('grant.issued')).toEqual([{ scopes: ['mailer'], ttl_ms: 1_800_000, replace: true, long: false }])
  })

  test('approve --all records the wildcard grant', async () => {
    const { code } = await capture(['approve', '--all'])

    expect(code).toBe(0)
    expect(recordsOf('grant.issued')).toEqual([{ scopes: ['*'], ttl_ms: null, replace: false, long: false }])
  })

  test('a grant whose record cannot be written grants nothing', async () => {
    const spy = failAppend('grant.issued')

    const { code, stderr } = await capture(['approve', 'mailer'])

    expect(code).toBe(1)
    expect(stderr).toContain('nothing was granted')
    expect(spy.trips()).toBe(1)
    expect(existsSync(grantPath())).toBe(false)
    expectNoSentinel()
  })

  test('a grant whose record cannot be written leaves an existing grant file byte-identical, mtime included', async () => {
    await gate.mergeGrant('p', {}, grantPath())
    const before = await snapshotHome(home)
    expect(before.some((l) => l.startsWith('.session-approval|'))).toBe(true)
    const spy = failAppend('grant.issued')

    const { code, stderr } = await capture(['approve', 'mailer', '--replace'])

    expect(code).toBe(1)
    expect(stderr).toContain('nothing was granted')
    expect(spy.trips()).toBe(1)
    expect(await snapshotHome(home)).toEqual(before)
    expectNoSentinel()
  })

  test('revoke writes grant.revoked naming the live scopes before revokeApproval runs', async () => {
    expect((await capture(['approve', 'mailer'])).code).toBe(0)
    const seen = recordedBefore(gate, 'revokeApproval', 'grant.revoked')

    const { code } = await capture(['revoke'])

    expect(code).toBe(0)
    expect(seen()).toBe(true)
    expect(recordsOf('grant.revoked')).toEqual([{ scopes: ['mailer'] }])
    expect(existsSync(grantPath())).toBe(false)
  })

  test('a revoke whose record cannot be written still revokes, and exits 70', async () => {
    expect((await capture(['approve', 'mailer'])).code).toBe(0)
    const spy = failAppend('grant.revoked')

    const { code, stderr } = await capture(['revoke'])

    expect(code).toBe(70)
    expect(stderr).toContain('no audit record')
    expect(spy.trips()).toBe(1)
    expect(existsSync(grantPath())).toBe(false)
    expect(recordsOf('grant.revoked')).toEqual([])
    expectNoSentinel()
  })

  test('a revoke with no grant file writes no record and exits 0', async () => {
    const { code } = await capture(['revoke'])

    expect(code).toBe(0)
    expect(existsSync(join(home, 'audit'))).toBe(false)
  })
})

/** A 64-hex digest of `s`, for seeded fingerprints. */
const hex = (s: string): string => createHash('sha256').update(s).digest('hex')

/**
 * `builder` produced one inline Output in run `run-b1`; `sender` is a
 * content-class consumer of it. `approvals` seeds the state's approvals table.
 */
function seedContentHome(approvals: Record<string, unknown> = {}): void {
  addPlugin('builder', { side_effects: [], outputs: { brief: { type: 'text' } } })
  addPlugin('sender', {
    approval_class: 'content',
    autonomy_level: 'autonomous',
    dependencies: ['builder'],
    side_effects: ['sends_email'],
  })
  writeFileSync(
    statePathOf(),
    JSON.stringify({
      plugin_runs: {
        builder: {
          last_run_at: '2026-10-01T00:00:00.000Z',
          status: 'success',
          run_id: 'run-b1',
          last_output: { type: 'brief', format: 'text', run_id: 'run-b1', body: 'four invoices' },
        },
      },
      approvals,
    }),
  )
}

/** An open, unmarked content approval of `sender`, bound to `producer`. */
function sealedApproval(producer: string, fingerprint: string): Record<string, unknown> {
  return {
    plugin: 'sender',
    producer,
    fingerprint,
    run_id: 'run-old',
    approved_at: '2026-10-01T00:00:00.000Z',
    not_before: null,
    not_after: '2099-01-01T00:00',
    zone: 'UTC',
    effect_id: null,
    marked_at: null,
    confirmed_at: null,
  }
}

describe('content approval issue and withdrawal', () => {
  test('approve sender --content writes content_approval.issued before the state write', async () => {
    seedContentHome()
    const seen = recordedBefore(store, 'writeEngineState', 'content_approval.issued')

    const { code, stdout } = await capture(['approve', 'sender', '--content', '--not-after', '2099-01-01T00:00'])

    expect(code).toBe(0)
    expect(seen()).toBe(true)
    const state = JSON.parse(readFileSync(statePathOf(), 'utf-8')) as {
      approvals: Record<string, { fingerprint: string }>
    }
    const window = /^ {2}(\S+) to (\S+)$/m.exec(stdout)
    expect(window).not.toBeNull()
    const records = recordsOf('content_approval.issued')
    expect(records).toEqual([
      {
        plugin: 'sender',
        producer: 'builder',
        fingerprint: state.approvals.sender!.fingerprint,
        run_id: 'run-b1',
        opens_at: window![1]!,
        closes_at: window![2]!,
        replaced_fingerprint: null,
      },
    ])
    expect(records[0]!.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(records[0]!.closes_at).toBe('2099-01-01T00:00:00.000Z')
  })

  test('a content re-approve onto another producer carries the replaced fingerprint and writes no withdrawal', async () => {
    const earlier = hex('the courier bytes')
    seedContentHome({ sender: sealedApproval('courier', earlier) })

    const { code, stdout } = await capture(['approve', 'sender', '--content', '--not-after', '2099-01-01T00:00'])

    expect(code).toBe(0)
    expect(stdout).toContain('Withdrew the earlier content approval for sender')
    const records = recordsOf('content_approval.issued')
    expect(records).toHaveLength(1)
    expect(records[0]!.replaced_fingerprint).toBe(earlier)
    expect(recordsOf('content_approval.withdrawn')).toEqual([])
  })

  test('a content approval whose record cannot be written writes nothing', async () => {
    seedContentHome()
    const before = await snapshotHome(home)
    const stateBefore = readFileSync(statePathOf())
    const spy = failAppend('content_approval.issued')

    const { code } = await capture(['approve', 'sender', '--content', '--not-after', '2099-01-01T00:00'])

    expect(code).toBe(1)
    expect(spy.trips()).toBe(1)
    expect(readFileSync(statePathOf())).toEqual(stateBefore)
    expect(await snapshotHome(home)).toEqual(before)
    expectNoSentinel()
  })

  test('approve sender --content --remove writes content_approval.withdrawn before the state write', async () => {
    const fingerprint = hex('the builder bytes')
    seedContentHome({ sender: sealedApproval('builder', fingerprint) })
    const seen = recordedBefore(store, 'writeEngineState', 'content_approval.withdrawn')

    const { code } = await capture(['approve', 'sender', '--content', '--remove'])

    expect(code).toBe(0)
    expect(seen()).toBe(true)
    expect(recordsOf('content_approval.withdrawn')).toEqual([{ plugin: 'sender', fingerprint }])
  })

  test('a content withdrawal whose record cannot be written removes nothing', async () => {
    seedContentHome({ sender: sealedApproval('builder', hex('the builder bytes')) })
    const stateBefore = readFileSync(statePathOf())
    const spy = failAppend('content_approval.withdrawn')

    const { code, stderr } = await capture(['approve', 'sender', '--content', '--remove'])

    expect(code).toBe(1)
    expect(stderr).toContain('Nothing was removed.')
    expect(spy.trips()).toBe(1)
    expect(readFileSync(statePathOf())).toEqual(stateBefore)
    const state = JSON.parse(stateBefore.toString('utf-8')) as { approvals: Record<string, unknown> }
    expect(Object.keys(state.approvals)).toEqual(['sender'])
    expectNoSentinel()
  })
})

describe('denial lift', () => {
  beforeEach(async () => {
    addPlugin('a')
    addPlugin('b')
    expect((await capture(['deny', 'a', 'b'])).code).toBe(0)
  })

  test('deny --remove a b writes one denial.lifted per plugin, in order, before the state write', async () => {
    const stored = JSON.parse(readFileSync(statePathOf(), 'utf-8')) as {
      denials: Record<string, { fingerprint: string }>
    }
    const realWrite = store.writeEngineState
    let liftedAtWrite: number | undefined
    installed.push(
      spyOn(store, 'writeEngineState').mockImplementation(async (payload, path) => {
        liftedAtWrite ??= recordsOf('denial.lifted').length
        return realWrite(payload, path)
      }),
    )

    const { code } = await capture(['deny', '--remove', 'a', 'b'])

    expect(code).toBe(0)
    expect(liftedAtWrite).toBe(2)
    expect(recordsOf('denial.lifted')).toEqual([
      { plugin: 'a', fingerprint: stored.denials.a!.fingerprint },
      { plugin: 'b', fingerprint: stored.denials.b!.fingerprint },
    ])
  })

  test('a denial lift whose record cannot be written removes nothing', async () => {
    const stateBefore = readFileSync(statePathOf())
    const spy = failAppend('denial.lifted')

    const { code, stderr } = await capture(['deny', '--remove', 'a', 'b'])

    expect(code).toBe(1)
    expect(stderr).toContain('Nothing was removed.')
    expect(spy.trips()).toBe(1)
    expect(readFileSync(statePathOf())).toEqual(stateBefore)
    const state = JSON.parse(stateBefore.toString('utf-8')) as { denials: Record<string, unknown> }
    expect(Object.keys(state.denials).sort()).toEqual(['a', 'b'])
    expectNoSentinel()
  })
})

// -- Resolve closes the intent it answers (25-06) ----------------------------

/**
 * A home where `builder` emits one json Output and `sender`, a content-class
 * consumer of it, reports `failed` while `<home>/fail` exists. A failed send
 * leaves the mark unconfirmed, so the approval reads indeterminate.
 */
function seedFiringHome(): void {
  // `main(['advance'])` reads the home default, and the shipped `review_gate:
  // true` is not what these cases are about.
  writeFileSync(join(home, 'preferences.json'), JSON.stringify({ review_gate: false }))
  addPlugin('builder', { side_effects: [], autonomy_level: 'autonomous', outputs: { brief: { type: 'json' } } })
  writeFileSync(
    join(home, 'plugins', 'builder', 'handler.ts'),
    `export async function handler() {
  return {
    status: 'success',
    phases_completed: ['build'],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: 'built',
    artifacts_produced: [{ type: 'brief', format: 'json', body: ${JSON.stringify('{"batch":"four invoices"}')} }],
    schema_version: 1,
  }
}
`,
  )
  addPlugin('sender', {
    approval_class: 'content',
    autonomy_level: 'autonomous',
    dependencies: ['builder'],
    side_effects: ['sends_email'],
    // Near zero, so sender is stale on every advance and reaches the content gate.
    ttl_hours: 0.001,
  })
  writeFileSync(
    join(home, 'plugins', 'sender', 'handler.ts'),
    `import { existsSync } from 'node:fs'
export async function handler() {
  const failed = existsSync(${JSON.stringify(join(home, 'fail'))})
  return {
    status: failed ? 'failed' : 'success',
    phases_completed: failed ? [] : ['send'],
    phases_failed: failed ? ['send'] : [],
    errors: failed ? [{ phase: 'send', message: 'the sink answered 500', recoverable: false }] : [],
    data_freshness: {},
    summary: failed ? 'the send reported a failure' : 'sent',
    artifacts_produced: [],
    schema_version: 1,
  }
}
`,
  )
  writeFileSync(join(home, 'fail'), '')
}

/**
 * builder's Output, sender approved over it, then a fire whose handler reports
 * failed. With `dropOutcome` the outcome append trips, so the intent stays open.
 */
async function fireAndFail(dropOutcome: boolean): Promise<void> {
  seedFiringHome()
  await capture(['advance'])
  expect((await capture(['approve', 'sender', '--content', '--not-after', '2099-01-01T00:00'])).code).toBe(0)
  const spy = dropOutcome ? failAppend('fire.outcome') : undefined
  await capture(['advance'])
  if (spy !== undefined) expect(spy.trips()).toBe(1)
  expect(await senderStanding()).toBe('indeterminate')
}

async function senderStanding(): Promise<string> {
  const state = await store.readEngineState(statePathOf())
  const { manifests } = await loadPluginManifests(join(home, 'plugins'))
  return approvalStanding(state, 'sender', manifests, Date.now()).standing
}

/** The effect id the mark recorded for sender. */
function senderEffectId(): string {
  const state = JSON.parse(readFileSync(statePathOf(), 'utf-8')) as {
    approvals: Record<string, { effect_id: string | null }>
  }
  const id = state.approvals.sender!.effect_id
  expect(id).toMatch(/^[0-9a-f]{64}$/)
  return id!
}

/** sender's content fire intent, which must exist. */
function senderIntent(): Line {
  const intents = auditLines(home).filter(
    (l) => l.type === 'warpline.audit.fire.intent' && l.data.plugin === 'sender',
  )
  expect(intents).toHaveLength(1)
  return intents[0]!
}

describe('resolve', () => {
  test('resolve --not-shipped closes the open intent it answers, on the record before the state write', async () => {
    await fireAndFail(true)
    const effectId = senderEffectId()
    const intent = senderIntent()
    expect(intent.data.effect_id).toBe(effectId)
    expect((await audit.openIntents(statePathOf())).map((i) => i.seq)).toContain(intent.warplineseq)
    const seen = recordedBefore(store, 'writeEngineState', 'fire.resolved')

    const { code } = await capture(['resolve', 'sender', '--not-shipped', effectId])

    expect(code).toBe(0)
    expect(seen()).toBe(true)
    expect(recordsOf('fire.resolved')).toEqual([
      { plugin: 'sender', effect_id: effectId, intent_seq: intent.warplineseq, answer: 'not_shipped' },
    ])
    expect((await audit.openIntents(statePathOf())).filter((i) => i.plugin === 'sender')).toEqual([])
  })

  test('resolve --not-shipped over an intent its outcome already closed records no seq', async () => {
    await fireAndFail(false)
    const effectId = senderEffectId()
    const intent = senderIntent()
    expect(recordsOf('fire.outcome').map((d) => d.intent_seq)).toContain(intent.warplineseq)

    const { code } = await capture(['resolve', 'sender', '--not-shipped', effectId])

    expect(code).toBe(0)
    expect(recordsOf('fire.resolved')).toEqual([{ plugin: 'sender', effect_id: effectId, intent_seq: null, answer: 'not_shipped' }])
  })

  test('a resolve whose record cannot be written answers nothing', async () => {
    await fireAndFail(false)
    const effectId = senderEffectId()
    const stateBefore = readFileSync(statePathOf())
    const spy = failAppend('fire.resolved')

    const { code, stderr } = await capture(['resolve', 'sender', '--not-shipped', effectId])

    expect(spy.trips()).toBe(1)
    expect(code).toBe(1)
    expect(stderr.trimEnd().endsWith('Nothing was written.')).toBe(true)
    expect(readFileSync(statePathOf())).toEqual(stateBefore)
    expect(await senderStanding()).toBe('indeterminate')
    expect(recordsOf('fire.resolved')).toEqual([])
    expectNoSentinel()
  })

  test('resolve --shipped answers a still-marked content fire on the record before the state write, and the approval reads spent', async () => {
    await fireAndFail(true)
    const effectId = senderEffectId()
    const intent = senderIntent()
    const seen = recordedBefore(store, 'writeEngineState', 'fire.resolved')

    const { code, stderr } = await capture(['resolve', 'sender', '--shipped', effectId])

    expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
    expect(seen()).toBe(true)
    expect(recordsOf('fire.resolved')).toEqual([
      { plugin: 'sender', effect_id: effectId, intent_seq: intent.warplineseq, answer: 'shipped' },
    ])
    expect((await audit.openIntents(statePathOf())).filter((i) => i.plugin === 'sender')).toEqual([])
    expect(await senderStanding()).toBe('spent')
    const record = (JSON.parse(readFileSync(statePathOf(), 'utf-8')) as {
      approvals: Record<string, Record<string, unknown>>
    }).approvals.sender!
    expect(typeof record.shipped_at).toBe('string')
    expect(new Date(record.shipped_at as string).toISOString()).toBe(record.shipped_at as string)
    expect(Object.hasOwn(record, 'not_shipped_at')).toBe(false)
    expect(record.confirmed_at).toBeNull()
  })

  for (const [first, second] of [
    ['--shipped', '--not-shipped'],
    ['--not-shipped', '--shipped'],
  ] as const) {
    test(`a second answer to one fire is refused and writes nothing: ${first} then ${second}`, async () => {
      await fireAndFail(false)
      const effectId = senderEffectId()
      expect((await capture(['resolve', 'sender', first, effectId])).code).toBe(0)
      const before = await snapshotHome(home)

      const { code, stderr } = await capture(['resolve', 'sender', second, effectId])

      expect(code).toBe(1)
      expect(stderr).toContain('has no fire waiting on an answer')
      expect(stderr.trimEnd().endsWith('Nothing was written.')).toBe(true)
      expect(await snapshotHome(home)).toEqual(before)
      expect(recordsOf('fire.resolved')).toEqual([
        { plugin: 'sender', effect_id: effectId, intent_seq: null, answer: first === '--shipped' ? 'shipped' : 'not_shipped' },
      ])
    })
  }

  test('the content form refuses both answers at once, for one effect id or two, and writes nothing', async () => {
    await fireAndFail(true)
    const effectId = senderEffectId()
    const before = await snapshotHome(home)

    for (const other of [effectId, 'd'.repeat(64)]) {
      const { code, stderr } = await capture(['resolve', 'sender', '--shipped', effectId, '--not-shipped', other])

      expect(code).toBe(1)
      expect(stderr).toContain('not both. Nothing was written.')
    }
    expect(await snapshotHome(home)).toEqual(before)
    expect(recordsOf('fire.resolved')).toEqual([])
  })
})

describe('resolve when its state write does not land', () => {
  test('a failed state write after the answer is on the record exits 1, says the answer is there, names the command that finishes it, and prints none of the error', async () => {
    await fireAndFail(true)
    const effectId = senderEffectId()
    const intent = senderIntent()
    const spy = failStateWriteOnce()

    const r = await captureOrThrown(['resolve', 'sender', '--shipped', effectId])

    expect(r).toBeDefined()
    expect(r!.code).toBe(1)
    expect(r!.stderr).toContain('is on the audit record')
    expect(r!.stderr).toContain(`warpline resolve sender --shipped ${effectId}`)
    expect(r!.stderr).not.toContain(SENTINEL)
    expect(spy.trips()).toBe(1)
    expect(recordsOf('fire.resolved')).toEqual([
      { plugin: 'sender', effect_id: effectId, intent_seq: intent.warplineseq, answer: 'shipped' },
    ])
    expect(await senderStanding()).toBe('indeterminate')
  })

  for (const [first, second] of [
    ['--shipped', '--not-shipped'],
    ['--not-shipped', '--shipped'],
  ] as const) {
    test(`the other answer is refused naming the one on the record, and the store keeps one answer: ${first} then ${second}`, async () => {
      await fireAndFail(true)
      const effectId = senderEffectId()
      const intent = senderIntent()
      const spy = failStateWriteOnce()
      await captureOrThrown(['resolve', 'sender', first, effectId])
      expect(spy.trips()).toBe(1)
      expect(await senderStanding()).toBe('indeterminate')
      const before = await snapshotHome(home)
      const firstAnswer = first === '--shipped' ? 'shipped' : 'not_shipped'

      const { code, stderr } = await capture(['resolve', 'sender', second, effectId])

      expect(code).toBe(1)
      expect(stderr).toContain(`already answered ${firstAnswer === 'shipped' ? 'shipped' : 'not shipped'} on the audit record`)
      expect(stderr.trimEnd().endsWith('Nothing was written.')).toBe(true)
      expect(await snapshotHome(home)).toEqual(before)
      expect(recordsOf('fire.resolved')).toEqual([
        { plugin: 'sender', effect_id: effectId, intent_seq: intent.warplineseq, answer: firstAnswer },
      ])
    })
  }

  for (const flag of ['--shipped', '--not-shipped'] as const) {
    test(`the same answer again writes only the state document and no second record: ${flag}`, async () => {
      await fireAndFail(true)
      const effectId = senderEffectId()
      const intent = senderIntent()
      const spy = failStateWriteOnce()
      await captureOrThrown(['resolve', 'sender', flag, effectId])
      expect(spy.trips()).toBe(1)
      const answer = flag === '--shipped' ? 'shipped' : 'not_shipped'

      const { code, stdout, stderr } = await capture(['resolve', 'sender', flag, effectId])

      expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
      expect(stdout).toContain('already on the audit record')
      expect(recordsOf('fire.resolved')).toEqual([
        { plugin: 'sender', effect_id: effectId, intent_seq: intent.warplineseq, answer },
      ])
      expect(await senderStanding()).toBe('spent')
      const record = (JSON.parse(readFileSync(statePathOf(), 'utf-8')) as {
        approvals: Record<string, Record<string, unknown>>
      }).approvals.sender!
      const field = flag === '--shipped' ? 'shipped_at' : 'not_shipped_at'
      const otherField = flag === '--shipped' ? 'not_shipped_at' : 'shipped_at'
      expect(typeof record[field]).toBe('string')
      expect(new Date(record[field] as string).toISOString()).toBe(record[field] as string)
      expect(Object.hasOwn(record, otherField)).toBe(false)
      expect(record.confirmed_at).toBeNull()
    })
  }

  test('an audit store that cannot be read for an earlier answer refuses the answer and writes nothing', async () => {
    await fireAndFail(true)
    const effectId = senderEffectId()
    const stateBefore = readFileSync(statePathOf())
    // Read BEFORE `spyOn`, as in `failAppend`.
    const real = audit.readCompleteLines
    let trips = 0
    installed.push(
      spyOn(audit, 'readCompleteLines').mockImplementation((statePath: string, afterSeq: number) => {
        if (trips === 0) {
          trips += 1
          throw new Error(SENTINEL)
        }
        return real(statePath, afterSeq)
      }),
    )

    const r = await captureOrThrown(['resolve', 'sender', '--not-shipped', effectId])

    expect(r).toBeDefined()
    expect(r!.code).toBe(1)
    expect(r!.stderr.trimEnd().endsWith('Nothing was written.')).toBe(true)
    expect(r!.stderr).not.toContain(SENTINEL)
    expect(trips).toBe(1)
    expect(recordsOf('fire.resolved')).toEqual([])
    expect(readFileSync(statePathOf())).toEqual(stateBefore)
  })
})

describe('resolve and lines that hold no answer', () => {
  test('a line shaped like an answer that is not a record is no answer: resolve refuses with the walk until it is passed over, then records the answer', async () => {
    await fireAndFail(true)
    const effectId = senderEffectId()
    const intent = senderIntent()
    const dir = join(home, 'audit')
    const active = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort().at(-1)!
    const n = (await audit.readHead(statePathOf())).seq + 1
    // No `warplineseq` and no `source`: shaped like an answer, and not a record.
    appendFileSync(
      join(dir, active),
      `${JSON.stringify({ type: 'warpline.audit.fire.resolved', data: { plugin: 'sender', effect_id: effectId, answer: 'shipped' } })}\n`,
    )
    const stateBefore = readFileSync(statePathOf())

    const refused = await capture(['resolve', 'sender', '--shipped', effectId])

    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain('is not a record')
    expect(refused.stdout).not.toContain('already on the audit record')
    expect(readFileSync(statePathOf())).toEqual(stateBefore)

    expect((await capture(['audit', 'pass-over', String(n)])).code).toBe(0)
    const { code, stdout, stderr } = await capture(['resolve', 'sender', '--shipped', effectId])

    expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
    expect(stdout).not.toContain('already on the audit record')
    expect(
      auditLines(home)
        .filter((l) => l.type === 'warpline.audit.fire.resolved' && typeof l.warplineseq === 'number')
        .map((l) => l.data),
    ).toEqual([{ plugin: 'sender', effect_id: effectId, intent_seq: intent.warplineseq, answer: 'shipped' }])
    expect(await senderStanding()).toBe('spent')
  })

  test('an answer the walk stopped on and the operator passed over is no answer, and the other answer is recorded', async () => {
    await fireAndFail(true)
    const effectId = senderEffectId()
    const intent = senderIntent()
    // A chain-valid record whose intent seq the walk refuses, so it stops here.
    const n = appendRelinked(join(home, 'audit'), 'warpline.audit.fire.resolved', {
      plugin: 'sender',
      effect_id: effectId,
      intent_seq: 0,
      answer: 'shipped',
    })
    expect((await capture(['audit', 'pass-over', String(n)])).code).toBe(0)

    const { code, stderr } = await capture(['resolve', 'sender', '--not-shipped', effectId])

    expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
    expect(
      auditLines(home)
        .filter((l) => l.type === 'warpline.audit.fire.resolved' && l.warplineseq !== n)
        .map((l) => l.data),
    ).toEqual([{ plugin: 'sender', effect_id: effectId, intent_seq: intent.warplineseq, answer: 'not_shipped' }])
    expect(await senderStanding()).toBe('spent')
  })
})

// -- Resolve by seq: any open intent ------------------------------------------

/**
 * `mailer`, a session plugin, granted and fired, with its `fire.outcome`
 * append failed once so its intent stays open. The spy is removed before this
 * returns, so a case can install its own. Returns the open intent.
 */
async function sessionIntentLeftOpen(): Promise<Line> {
  writeFileSync(join(home, 'preferences.json'), JSON.stringify({ review_gate: false }))
  addPlugin('mailer', { autonomy_level: 'autonomous', ttl_hours: 0.001 })
  writeFileSync(
    join(home, 'plugins', 'mailer', 'handler.ts'),
    `export async function handler() {
  return {
    status: 'success',
    phases_completed: ['send'],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: 'sent',
    artifacts_produced: [],
    schema_version: 1,
  }
}
`,
  )
  expect((await capture(['approve', 'mailer'])).code).toBe(0)
  const spy = failAppend('fire.outcome')
  const { code } = await capture(['advance'])
  expect(spy.trips()).toBe(1)
  installed.pop()!.mockRestore()
  expect(code).toBe(70)
  const intents = auditLines(home).filter((l) => l.type === 'warpline.audit.fire.intent' && l.data.plugin === 'mailer')
  expect(intents).toHaveLength(1)
  expect((await audit.openIntents(statePathOf())).map((i) => i.seq)).toEqual([intents[0]!.warplineseq])
  return intents[0]!
}

/** The by-seq form's usage line, which every malformed form prints. */
const BY_SEQ_USAGE = 'warpline resolve --intent <seq> --shipped|--not-shipped'

/** The whole-home snapshot without the audit store, for a case that appends one record. */
async function snapshotOutsideStore(): Promise<string[]> {
  return (await snapshotHome(home)).filter((l) => !l.startsWith('audit/'))
}

describe('resolve --intent', () => {
  test('a session intent whose outcome could not be written is closed as shipped, by seq, with nothing else written', async () => {
    const intent = await sessionIntentLeftOpen()
    const seq = intent.warplineseq
    const outside = await snapshotOutsideStore()
    const linesBefore = auditLines(home).length

    const { code, stdout, stderr } = await capture(['resolve', '--intent', String(seq), '--shipped'])

    expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
    expect(stdout).toContain(`fire intent ${seq} for mailer (run ${intent.data.run_id as string})`)
    const added = auditLines(home).slice(linesBefore)
    expect(added.map((l) => l.type)).toEqual(['warpline.audit.fire.resolved'])
    expect(added[0]!.data).toEqual({ plugin: 'mailer', effect_id: null, intent_seq: seq, answer: 'shipped' })
    expect((await audit.openIntents(statePathOf())).map((i) => i.seq)).not.toContain(seq)
    expect(await snapshotOutsideStore()).toEqual(outside)
  })

  test('a content fire whose handler succeeded but whose outcome could not be written is closed by seq with its effect id', async () => {
    seedFiringHome()
    rmSync(join(home, 'fail'))
    await capture(['advance'])
    expect((await capture(['approve', 'sender', '--content', '--not-after', '2099-01-01T00:00'])).code).toBe(0)
    const spy = failAppend('fire.outcome')
    await capture(['advance'])
    expect(spy.trips()).toBe(1)
    expect(await senderStanding()).not.toBe('indeterminate')
    const effectId = senderEffectId()
    const intent = senderIntent()
    expect((await audit.openIntents(statePathOf())).map((i) => i.seq)).toContain(intent.warplineseq)
    const stateBefore = readFileSync(statePathOf())

    const { code } = await capture(['resolve', '--intent', String(intent.warplineseq), '--shipped'])

    expect(code).toBe(0)
    expect(recordsOf('fire.resolved')).toEqual([
      { plugin: 'sender', effect_id: effectId, intent_seq: intent.warplineseq, answer: 'shipped' },
    ])
    expect((await audit.openIntents(statePathOf())).filter((i) => i.plugin === 'sender')).toEqual([])
    expect(readFileSync(statePathOf())).toEqual(stateBefore)
  })

  test('a content fire still marked and unconfirmed refuses --not-shipped by seq and points at the content form', async () => {
    await fireAndFail(true)
    const intent = senderIntent()
    const before = await snapshotHome(home)

    const { code, stderr } = await capture(['resolve', '--intent', String(intent.warplineseq), '--not-shipped'])

    expect(code).toBe(1)
    expect(stderr).toContain('warpline resolve sender --not-shipped')
    expect(stderr.trimEnd().endsWith('Nothing was written.')).toBe(true)
    expect(await snapshotHome(home)).toEqual(before)
  })

  test('a content fire still marked and unconfirmed refuses --shipped by seq too, names both answers of the content form, and writes nothing', async () => {
    await fireAndFail(true)
    const intent = senderIntent()
    const effectId = senderEffectId()
    const before = await snapshotHome(home)

    const { code, stderr } = await capture(['resolve', '--intent', String(intent.warplineseq), '--shipped'])

    expect(code).toBe(1)
    expect(stderr).toContain(`warpline resolve sender --shipped ${effectId}`)
    expect(stderr).toContain(`warpline resolve sender --not-shipped ${effectId}`)
    expect(stderr.trimEnd().endsWith('Nothing was written.')).toBe(true)
    expect(await snapshotHome(home)).toEqual(before)
    expect((await audit.openIntents(statePathOf())).map((i) => i.seq)).toContain(intent.warplineseq)
  })

  test('a seq that is not an open intent is refused, names nothing typed, and writes nothing', async () => {
    await fireAndFail(false)
    const closed = senderIntent().warplineseq
    expect(recordsOf('fire.outcome').map((d) => d.intent_seq)).toContain(closed)
    expect((await capture(['deny', 'p'])).code).toBe(0)
    const denial = auditLines(home).find((l) => l.type === 'warpline.audit.denial.recorded')!.warplineseq
    const pastHead = (await audit.readHead(statePathOf())).seq + 1
    const before = await snapshotHome(home)

    for (const seq of [closed, denial, pastHead]) {
      const { code, stderr } = await capture(['resolve', '--intent', String(seq), '--shipped'])

      expect(`${seq}: ${code}`).toBe(`${seq}: 1`)
      expect(stderr).toContain('No open fire intent has that seq')
      expect(stderr).not.toContain(String(seq))
      expect(await snapshotHome(home)).toEqual(before)
    }
  })

  test('a malformed by-seq answer is a usage error that writes nothing', async () => {
    const before = await snapshotHome(home)

    for (const argv of [
      ['--intent', '5', 'sender', '--shipped'],
      ['--intent', '5', '--shipped', '--not-shipped'],
      ['--intent', '5'],
      ['--intent', '0', '--shipped'],
      ['--intent', '01', '--shipped'],
      ['--intent', '1e3', '--shipped'],
      ['--intent', 'abc', '--shipped'],
      ['--intent=-1', '--shipped'],
    ]) {
      const { code, stderr } = await capture(['resolve', ...argv])

      expect(`${argv.join(' ')}: ${code}`).toBe(`${argv.join(' ')}: 1`)
      expect(stderr).toContain(BY_SEQ_USAGE)
      expect(await snapshotHome(home)).toEqual(before)
    }
  })

  test('a repeated --intent is refused and writes nothing, even when the last seq is a real open intent', async () => {
    const intent = await sessionIntentLeftOpen()
    const seq = String(intent.warplineseq)
    const pastHead = String((await audit.readHead(statePathOf())).seq + 1)
    const before = await snapshotHome(home)

    for (const argv of [
      ['--intent', pastHead, '--intent', seq, '--shipped'],
      ['--intent', seq, '--intent', seq, '--shipped'],
      [`--intent=${pastHead}`, '--intent', seq, '--not-shipped'],
    ]) {
      const { code, stderr } = await capture(['resolve', ...argv])

      expect(`${argv.join(' ')}: ${code}`).toBe(`${argv.join(' ')}: 1`)
      expect(stderr).toContain(BY_SEQ_USAGE)
      expect(recordsOf('fire.resolved')).toEqual([])
      expect(await snapshotHome(home)).toEqual(before)
    }
    expect((await audit.openIntents(statePathOf())).map((i) => i.seq)).toContain(intent.warplineseq)
  })

  test('a live advance refuses the by-seq answer as it refuses the content form', async () => {
    const intent = await sessionIntentLeftOpen()
    const held = await acquireLock(runLockPath())
    try {
      const before = await snapshotHome(home)

      const { code, stderr } = await capture(['resolve', '--intent', String(intent.warplineseq), '--not-shipped'])

      expect(code).toBe(1)
      expect(stderr).toContain('An advance is running')
      expect(stderr.trimEnd().endsWith('Nothing was written.')).toBe(true)
      expect(await snapshotHome(home)).toEqual(before)
    } finally {
      await releaseLock(runLockPath(), held.run_id)
    }
  })

  test('a by-seq answer whose record cannot be written answers nothing', async () => {
    const intent = await sessionIntentLeftOpen()
    const stateBefore = readFileSync(statePathOf())
    const spy = failAppend('fire.resolved')

    const { code, stderr } = await capture(['resolve', '--intent', String(intent.warplineseq), '--shipped'])

    expect(code).toBe(1)
    expect(stderr.trimEnd().endsWith('Nothing was written.')).toBe(true)
    expect(spy.trips()).toBe(1)
    expect((await audit.openIntents(statePathOf())).map((i) => i.seq)).toContain(intent.warplineseq)
    expect(recordsOf('fire.resolved')).toEqual([])
    expect(readFileSync(statePathOf())).toEqual(stateBefore)
    expectNoSentinel()
  })
})
