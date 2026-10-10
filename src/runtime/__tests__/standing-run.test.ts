/**
 * A standing grant authorises a run, and `plan` agrees with the run.
 *
 * A side-effecting session-class plugin `p` with no session grant fires when a
 * live standing grant held by an active machine covers it, and is skipped with
 * the unchanged session detail when every grant covering it is lapsed, or when
 * the standing grants file or `principals.json` cannot be read. Nothing here
 * writes the standing grants file but the gate's own writer, called by the
 * test before the advance.
 *
 * The engine reads `principals.json` once per advance, and only when the
 * standing grants file holds a grant, so a home without one gains no audit
 * line. A registry record the store cannot take stops the advance before
 * anything fires.
 *
 * Every case gets its own home through `_setHome` (AGENTS.md Rule 2). The
 * registry is seeded by observing it once before the advance, unless the case
 * is about the advance observing a hand edit.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as audit from '../../lib/audit-log.js'
import * as gate from '../approval-gate.js'
import { loadRegistry } from '../../lib/principals.js'
import { _setHome } from '../../lib/paths.js'
import { _getPaths, _setPaths, pathsForStateFile } from '../../board/state-manager.js'
import { runAdvance } from '../engine.js'
import { buildPlanModel } from '../../cli/plan.js'
import { main } from '../../cli/warpline.js'
import type { PluginManifest } from '../../schemas/plugin-manifest.js'

const REAL_PATHS = _getPaths()
const DAY = 24 * 60 * 60 * 1000
const REGISTRY_OBSERVED = 'warpline.audit.principal_registry.observed'
const UNAPPROVED_BOARD_SUMMARY = 'p: skipped — unapproved: side effects require session approval'

let home: string
let installed: ReturnType<typeof spyOn>[] = []

const statePath = (): string => join(home, 'state', 'engine-state.json')
const eventsPath = (): string => join(home, 'runs', 'events.jsonl')
const marker = (name: string): string => join(home, 'fired-' + name)

function sideEffectManifest(name: string): PluginManifest {
  return {
    name,
    version: '1.0.0',
    description: `${name} fixture plugin`,
    inputs: {},
    outputs: {},
    capabilities: [],
    secrets: [],
    schedule: 'on_run',
    autonomy_level: 'autonomous',
    approval_class: 'session',
    llm_handoff: false,
    side_effects: ['sends_email'],
    ttl_hours: 24,
    dependencies: [],
    timeout_ms: 5000,
    max_parallelism: 1,
    min_tier: 'normal',
    max_retries: 1,
    retry_delay_ms: 2000,
  }
}

/** A side-effecting plugin whose handler leaves `fired-<name>` in the home, so "it ran" is a file, not a guess. */
function writePlugin(name: string): void {
  const dir = join(home, 'plugins', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'manifest.ts'), `export const manifest = ${JSON.stringify(sideEffectManifest(name))}`)
  writeFileSync(
    join(dir, 'handler.ts'),
    `import { writeFileSync } from 'node:fs'

export async function handler(_manifest, _args) {
  writeFileSync(${JSON.stringify(marker(name))}, 'x')
  return {
    status: 'success',
    phases_completed: [],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: 'fixture ok',
    artifacts_produced: [],
    schema_version: 1,
  }
}
`,
  )
}

type Entry = { id: string; type: 'human' | 'machine'; status: 'active' | 'disabled' }

const OPS: Entry = { id: 'ops', type: 'human', status: 'active' }
const CI: Entry = { id: 'ci', type: 'machine', status: 'active' }

function writeRegistry(principals: Entry[]): void {
  writeFileSync(join(home, 'principals.json'), JSON.stringify({ principals }))
}

/** The registry written and observed once, so an advance reads it unchanged. */
async function seedRegistry(principals: Entry[] = [OPS, CI]): Promise<void> {
  writeRegistry(principals)
  const loaded = await loadRegistry(statePath())
  expect('refused' in loaded).toBe(false)
}

/** A standing grant held by `ci`, issued by `ops`, over `p`, written through the gate's own writer. */
async function issueGrant(issuedAt: number, terms: { periodMs?: number; hardMaxMs?: number } = {}): Promise<void> {
  const read = await gate.readStandingStore()
  if (!read.readable) throw new Error(`standing grants file unreadable: ${read.cause}`)
  const next = gate.issueStanding(
    read.store,
    {
      id: gate.newStandingId(),
      holder: 'ci',
      issuer: 'ops',
      scopes: ['p'],
      periodMs: terms.periodMs ?? DAY,
      hardMaxMs: terms.hardMaxMs ?? 30 * DAY,
    },
    issuedAt,
  )
  if ('refused' in next) throw new Error(`issue refused: ${next.refused.code}`)
  await gate.writeStandingStore(next.store)
}

function advance(now: number): ReturnType<typeof runAdvance> {
  return runAdvance({
    pluginsDir: join(home, 'plugins'),
    stateDir: statePath(),
    runsDir: join(home, 'runs'),
    eventsPath: eventsPath(),
    preferencesPath: join(home, 'state', 'preferences.json'),
    now,
  })
}

/** Every record type in the audit store, segments in name order. */
function auditTypes(): string[] {
  const dir = join(home, 'audit')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .flatMap((f) =>
      readFileSync(join(dir, f), 'utf-8')
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => (JSON.parse(l) as { type: string }).type),
    )
}

const registryRecords = (): number => auditTypes().filter((t) => t === REGISTRY_OBSERVED).length

/** What the board read for `p` on the last event that named it. */
function boardSummary(): string | undefined {
  return readFileSync(eventsPath(), 'utf-8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as { type: string; source: string; summary: string })
    .filter((e) => e.type === 'plugin_result' && e.source === 'p')
    .pop()?.summary
}

/**
 * `observeAuthorityFile` rejects once, as the store would on a failed append,
 * but only for the registry record. The preferences record goes through.
 */
function failRegistryObserveOnce(): () => number {
  const real = audit.observeAuthorityFile
  let trips = 0
  installed.push(
    spyOn(audit, 'observeAuthorityFile').mockImplementation((async (...args: unknown[]) => {
      if (trips === 0 && args[1] === 'principal_registry.observed') {
        trips += 1
        throw new audit.AuditAppendError('principal_registry.observed', 'write failed')
      }
      return (real as (...a: unknown[]) => Promise<unknown>)(...args)
    }) as typeof audit.observeAuthorityFile),
  )
  return () => trips
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
    return { code: await main(argv), stdout, stderr }
  } finally {
    process.stdout.write = realOut
    process.stderr.write = realErr
  }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'warpline-standing-run-'))
  _setHome(home)
  mkdirSync(join(home, 'state'), { recursive: true })
  mkdirSync(join(home, 'runs'), { recursive: true })
  _setPaths(pathsForStateFile(statePath(), { eventsPath: eventsPath() }))
  writePlugin('p')
  writeFileSync(join(home, 'state', 'preferences.json'), JSON.stringify({ review_gate: false }))
})

afterEach(() => {
  for (const spy of installed) spy.mockRestore()
  installed = []
  _setHome(null)
  rmSync(home, { recursive: true, force: true })
})

afterAll(() => {
  _setPaths(REAL_PATHS)
})

describe('a standing grant in a run', () => {
  test('a plugin only a live standing grant covers fires', async () => {
    const now = Date.now()
    await seedRegistry()
    await issueGrant(now - DAY / 2)
    expect(existsSync(join(home, '.session-approval'))).toBe(false)

    const result = await advance(now)

    expect(result.plugin_states.get('p')).toBe('completed')
    expect(existsSync(marker('p'))).toBe(true)
  })

  test('a lapsed standing grant fires nothing', async () => {
    const now = Date.now()
    await seedRegistry()
    await issueGrant(now - 3 * DAY, { periodMs: DAY, hardMaxMs: 30 * DAY })

    const result = await advance(now)

    expect(result.plugin_states.get('p')).toBe('skipped')
    expect(existsSync(marker('p'))).toBe(false)
    expect(boardSummary()).toBe(UNAPPROVED_BOARD_SUMMARY)
  })

  test("a disabled holder's grant fires nothing", async () => {
    const now = Date.now()
    await seedRegistry()
    await issueGrant(now - DAY / 2)
    // A hand edit the advance itself observes.
    writeRegistry([OPS, { ...CI, status: 'disabled' }])

    const result = await advance(now)

    expect(result.plugin_states.get('p')).toBe('skipped')
    expect(existsSync(marker('p'))).toBe(false)
  })

  test('a corrupt store fires nothing and the advance completes', async () => {
    const now = Date.now()
    await seedRegistry()
    writeFileSync(join(home, 'standing-grants.json'), '{not json')

    const result = await advance(now)

    expect(result.plugin_states.get('p')).toBe('skipped')
    expect(existsSync(marker('p'))).toBe(false)
  })

  test('an unusable registry fires nothing and the advance completes', async () => {
    const now = Date.now()
    await seedRegistry()
    await issueGrant(now - DAY / 2)
    writeFileSync(join(home, 'principals.json'), '{not json')

    const result = await advance(now)

    expect(result.plugin_states.get('p')).toBe('skipped')
    expect(existsSync(marker('p'))).toBe(false)
  })
})

/**
 * A library host runs another home by handing `runAdvance` that home. Every
 * home-derived file is that home's, never the process home's: the standing
 * grants file, `principals.json`, `preferences.json`, `config/<p>.json`, state,
 * runs and the audit store. The process home is left byte-identical.
 */
describe('an advance given another home', () => {
  let other: string
  beforeEach(() => {
    other = mkdtempSync(join(tmpdir(), 'warpline-standing-other-'))
    writeFileSync(join(other, 'preferences.json'), JSON.stringify({ review_gate: false }))
  })
  afterEach(() => rmSync(other, { recursive: true, force: true }))

  const advanceOther = (now: number): ReturnType<typeof runAdvance> =>
    runAdvance({ home: other, pluginsDir: join(home, 'plugins'), now })

  /** Every file and directory under `root`, with each file's bytes. */
  function snapshot(root: string): Record<string, string | null> {
    const out: Record<string, string | null> = {}
    for (const rel of readdirSync(root, { recursive: true }) as string[]) {
      const abs = join(root, rel)
      out[rel] = statSync(abs).isDirectory() ? null : readFileSync(abs, 'base64')
    }
    return out
  }

  /** A standing grant held by `ci` over `scopes`, written into `root`'s own file. */
  async function issueGrantAt(root: string, scopes: string[], issuedAt: number): Promise<void> {
    const next = gate.issueStanding(
      { min_reader_version: gate.STANDING_READER_VERSION, grants: [] },
      { id: gate.newStandingId(), holder: 'ci', issuer: 'ops', scopes, periodMs: DAY, hardMaxMs: 30 * DAY },
      issuedAt,
    )
    if ('refused' in next) throw new Error(`issue refused: ${next.refused.code}`)
    await gate.writeStandingStore(next.store, join(root, 'standing-grants.json'))
  }

  /** A side-effecting plugin under `root/plugins` whose handler marks `root`. */
  function writePluginAt(root: string, name: string): void {
    const dir = join(root, 'plugins', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'manifest.ts'), `export const manifest = ${JSON.stringify(sideEffectManifest(name))}`)
    writeFileSync(
      join(dir, 'handler.ts'),
      `import { writeFileSync } from 'node:fs'
export async function handler() {
  await new Promise((r) => setTimeout(r, 20))
  writeFileSync(${JSON.stringify(join(root, 'fired-' + name))}, 'x')
  return { status: 'success', phases_completed: [], phases_failed: [], errors: [], data_freshness: {},
    summary: 'fixture ok', artifacts_produced: [], schema_version: 1 }
}
`,
    )
  }

  test("the process home's live standing grant does not authorise it", async () => {
    const now = Date.now()
    await seedRegistry()
    await issueGrant(now - DAY / 2)

    const result = await advanceOther(now)

    expect(result.plugin_states.get('p')).toBe('skipped')
    expect(existsSync(marker('p'))).toBe(false)
  })

  test('its own standing grant and registry authorise it, and its own store records the registry', async () => {
    const now = Date.now()
    writeFileSync(join(other, 'principals.json'), JSON.stringify({ principals: [OPS, CI] }))
    await issueGrantAt(other, ['p'], now - DAY / 2)

    const result = await advanceOther(now)

    expect(result.plugin_states.get('p')).toBe('completed')
    expect(existsSync(join(home, 'standing-grants.json'))).toBe(false)
    expect(registryRecords()).toBe(0)
    const otherTypes = readdirSync(join(other, 'audit'))
      .flatMap((f) => readFileSync(join(other, 'audit', f), 'utf-8').split('\n').filter((l) => l.length > 0))
      .map((l) => (JSON.parse(l) as { type: string }).type)
    expect(otherTypes).toContain(REGISTRY_OBSERVED)
  })

  test("it leaves the process home byte-identical and reads the other home's config and preferences", async () => {
    const dir = join(other, 'plugins', 'cfg')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'manifest.ts'),
      `export const manifest = ${JSON.stringify({
        ...sideEffectManifest('cfg'),
        side_effects: [],
        approval_class: undefined,
        inputs: { token: { type: 'string', required: true } },
      })}`,
    )
    writeFileSync(
      join(dir, 'handler.ts'),
      `import { writeFileSync } from 'node:fs'
export async function handler(_m, args) {
  if (args.token !== 'other-home') throw new Error('wrong config')
  writeFileSync(${JSON.stringify(join(other, 'fired-cfg'))}, 'x')
  return { status: 'success', phases_completed: [], phases_failed: [], errors: [], data_freshness: {},
    summary: 'fixture ok', artifacts_produced: [], schema_version: 1 }
}
`,
    )
    mkdirSync(join(other, 'config'), { recursive: true })
    writeFileSync(join(other, 'config', 'cfg.json'), JSON.stringify({ token: 'other-home' }))
    const before = snapshot(home)

    const result = await runAdvance({ home: other, now: Date.now() })

    expect(result.plugin_states.get('cfg')).toBe('completed')
    expect(existsSync(join(other, 'fired-cfg'))).toBe(true)
    expect(existsSync(join(other, 'state', 'engine-state.json'))).toBe(true)
    expect(snapshot(home)).toEqual(before)

    // The other home's preferences.json is the one read: a broken one refuses.
    writeFileSync(join(other, 'preferences.json'), '{not json')
    const refusedBefore = snapshot(home)
    await expect(runAdvance({ home: other, now: Date.now() })).rejects.toThrow()
    expect(snapshot(home)).toEqual(refusedBefore)
  })

  test('home with a home-derived override refuses before any write', async () => {
    const before = snapshot(home)
    const otherBefore = snapshot(other)
    for (const key of ['stateDir', 'runsDir', 'logsDir', 'eventsPath', 'preferencesPath', 'approvalPath', 'lockPath']) {
      await expect(
        runAdvance({
          home: other,
          pluginsDir: join(home, 'plugins'),
          [key]: join(other, 'x'),
          now: Date.now(),
        } as Parameters<typeof runAdvance>[0]),
      ).rejects.toThrow(key)
    }
    expect(snapshot(home)).toEqual(before)
    expect(snapshot(other)).toEqual(otherBefore)
  })

  test("an empty home refuses before any write", async () => {
    const before = snapshot(home)
    await expect(runAdvance({ home: '', pluginsDir: join(home, 'plugins'), now: Date.now() })).rejects.toThrow(
      'home is an empty string',
    )
    expect(snapshot(home)).toEqual(before)
  })

  test('two concurrent advances on two homes are each authorised only by their own standing grant', async () => {
    const now = Date.now()
    const second = mkdtempSync(join(tmpdir(), 'warpline-standing-second-'))
    try {
      for (const root of [other, second]) {
        writeFileSync(join(root, 'preferences.json'), JSON.stringify({ review_gate: false }))
        writeFileSync(join(root, 'principals.json'), JSON.stringify({ principals: [OPS, CI] }))
        writePluginAt(root, 'p')
        writePluginAt(root, 'q')
      }
      await issueGrantAt(other, ['p'], now - DAY / 2)
      await issueGrantAt(second, ['q'], now - DAY / 2)

      const [a, b] = await Promise.all([runAdvance({ home: other, now }), runAdvance({ home: second, now })])

      expect([a.plugin_states.get('p'), a.plugin_states.get('q')]).toEqual(['completed', 'skipped'])
      expect([b.plugin_states.get('p'), b.plugin_states.get('q')]).toEqual(['skipped', 'completed'])
      expect(existsSync(join(other, 'fired-p'))).toBe(true)
      expect(existsSync(join(other, 'fired-q'))).toBe(false)
      expect(existsSync(join(second, 'fired-p'))).toBe(false)
      expect(existsSync(join(second, 'fired-q'))).toBe(true)
    } finally {
      rmSync(second, { recursive: true, force: true })
    }
  })
})

describe('the registry is read once an advance, and only when a standing grant exists', () => {
  test('a home with no standing grant gains no registry record', async () => {
    writeRegistry([OPS, CI])
    expect(existsSync(join(home, 'standing-grants.json'))).toBe(false)

    await advance(Date.now())

    expect(registryRecords()).toBe(0)
  })

  test('a home holding a standing grant records a registry hand edit once', async () => {
    const now = Date.now()
    writeRegistry([OPS, CI])
    await issueGrant(now - DAY / 2)
    expect(registryRecords()).toBe(0)

    await advance(now)
    expect(registryRecords()).toBe(1)

    await advance(now + 1000)
    expect(registryRecords()).toBe(1)
  })

  test('a registry observation the store cannot take stops the advance before anything fires', async () => {
    const now = Date.now()
    writeRegistry([OPS, CI])
    await issueGrant(now - DAY / 2)
    const trips = failRegistryObserveOnce()

    await expect(advance(now)).rejects.toThrow()

    expect(trips()).toBe(1)
    expect(existsSync(marker('p'))).toBe(false)
  })

  test('warpline advance reports that refusal as 75', async () => {
    writeRegistry([OPS, CI])
    await issueGrant(Date.now() - DAY / 2)
    const trips = failRegistryObserveOnce()

    const { code, stdout } = await capture(['advance', '--json'])

    expect(trips()).toBe(1)
    expect(code).toBe(75)
    expect(stdout).toBe('')
    expect(existsSync(marker('p'))).toBe(false)
  })
})

describe('plan', () => {
  test('plan agrees: a plugin only a standing grant covers is due and approved', async () => {
    const now = Date.now()
    await seedRegistry()
    await issueGrant(now - DAY / 2)

    const model = await buildPlanModel(now)

    const entry = model.due.find((e) => e.plugin === 'p')
    expect(entry).toBeDefined()
    expect(entry!.approved).toBe(true)
  })
})
