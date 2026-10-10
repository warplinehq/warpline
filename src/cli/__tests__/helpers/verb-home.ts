/**
 * A test helper shared by the CLI verb tests of standing grants and
 * principals. Temp homes only (AGENTS.md Rule 2).
 *
 * Lifted from the helpers `audit-effects.test.ts` carries, so the verb tests of
 * this work share one copy rather than four. The whole-home snapshot is the
 * existing walk, imported and re-exported here, never written a second time.
 * Existing test files keep their own helpers.
 *
 * Spies installed through `failAppendOnce` and `recordedBefore` are kept in one
 * list; call `restoreSpies()` in `afterEach`.
 */
import { spyOn } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as audit from '../../../lib/audit-log.js'
import { _setHome } from '../../../lib/paths.js'
import { snapshotHome } from '../../../runtime/__tests__/helpers/snapshot-home.js'
import { main } from '../../warpline.js'

export { snapshotHome }

/** The append spy's error message. It must never reach a file. */
export const SENTINEL = 'WARPLINE_AUDIT_APPEND_SPY_SENTINEL'

/** Every field spelled out, so the fixture never leans on a schema default. */
function manifest(name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
    ...overrides,
  }
}

function writePlugin(home: string, name: string, overrides: Record<string, unknown>, handler?: string): void {
  const dir = join(home, 'plugins', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'manifest.ts'), `export const manifest = ${JSON.stringify(manifest(name, overrides))}`)
  if (handler !== undefined) writeFileSync(join(dir, 'handler.ts'), handler)
}

export interface VerbHome {
  home: string
  statePath: string
  cleanup: () => void
}

/**
 * A temp home, set as the warpline home, holding:
 * - `p`, a supervised session-class plugin that declares a side effect;
 * - `builder`, which declares none and emits one json Output;
 * - `sender`, a content-class consumer of it, which reports `failed` while
 *   `<home>/fail` exists, so a failed send leaves its approval indeterminate.
 *
 * `preferences.json` turns the review gate off, since `main(['advance'])`
 * reads the home default.
 */
export function makeVerbHome(): VerbHome {
  const home = mkdtempSync(join(tmpdir(), 'warpline-verb-home-'))
  writePlugin(home, 'p', {})
  writePlugin(
    home,
    'builder',
    { side_effects: [], autonomy_level: 'autonomous', outputs: { brief: { type: 'json' } } },
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
  writePlugin(
    home,
    'sender',
    {
      approval_class: 'content',
      autonomy_level: 'autonomous',
      dependencies: ['builder'],
      side_effects: ['sends_email'],
      // Near zero, so sender is stale on every advance and reaches the content gate.
      ttl_hours: 0.001,
    },
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
  mkdirSync(join(home, 'state'), { recursive: true })
  writeFileSync(join(home, 'preferences.json'), JSON.stringify({ review_gate: false }))
  _setHome(home)
  return {
    home,
    statePath: join(home, 'state', 'engine-state.json'),
    cleanup: () => {
      _setHome(null)
      rmSync(home, { recursive: true, force: true })
    },
  }
}

/** Run main(argv) in this process with stdout/stderr captured, always restoring the originals. */
export async function capture(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
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

export type AuditLine = { type: string; warplineseq: number; data: Record<string, unknown> }

/**
 * Every stored line under `<home>/audit/`, segments in name order. Given a
 * kind, only that kind's lines, each mapped to its data.
 */
export function auditRecords(home: string): AuditLine[]
export function auditRecords(home: string, kind: string): Record<string, unknown>[]
export function auditRecords(home: string, kind?: string): AuditLine[] | Record<string, unknown>[] {
  const dir = join(home, 'audit')
  const lines: AuditLine[] = !existsSync(dir)
    ? []
    : readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl'))
        .sort()
        .flatMap((f) =>
          readFileSync(join(dir, f), 'utf-8')
            .split('\n')
            .filter((l) => l.length > 0)
            .map((l) => JSON.parse(l) as AuditLine),
        )
  if (kind === undefined) return lines
  return lines.filter((l) => l.type === `warpline.audit.${kind}`).map((l) => l.data)
}

let installed: ReturnType<typeof spyOn>[] = []

/** Restore every spy installed through this helper. */
export function restoreSpies(): void {
  for (const spy of installed) spy.mockRestore()
  installed = []
}

/**
 * Make the append of `kind` throw once, before anything is written. Every
 * other call goes to the real append.
 */
export function failAppendOnce(kind: string): { trips: () => number } {
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
 * A pass-through spy on `fn` of `mod` that notes, at its first call, whether a
 * record of `kind` is already on disk under `home`.
 */
export function recordedBefore(
  mod: Record<string, unknown>,
  fn: string,
  home: string,
  kind: string,
): () => boolean | undefined {
  const real = mod[fn] as (...args: unknown[]) => unknown
  let seen: boolean | undefined
  installed.push(
    spyOn(mod as Record<string, (...args: unknown[]) => unknown>, fn).mockImplementation((...args: unknown[]) => {
      seen ??= auditRecords(home, kind).length > 0
      return real(...args)
    }),
  )
  return () => seen
}

/**
 * Add each principal through `warpline principal add`, so the store has seen
 * the registry before a test measures the head (P10). Throws on a refusal.
 */
export async function seedPrincipals(list: ReadonlyArray<readonly [string, 'human' | 'machine']>): Promise<void> {
  for (const [id, type] of list) {
    const r = await capture(['principal', 'add', id, '--type', type])
    if (r.code !== 0) throw new Error(`principal add ${id} exited ${r.code}: ${r.stderr}`)
  }
}
