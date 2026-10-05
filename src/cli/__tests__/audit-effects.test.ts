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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import * as audit from '../../lib/audit-log.js'
import * as store from '../../runtime/engine-state-store.js'
import { _setHome } from '../../lib/paths.js'
import { snapshotHome } from '../../runtime/__tests__/helpers/snapshot-home.js'
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
