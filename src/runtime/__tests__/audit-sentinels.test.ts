/**
 * Nothing erasable reaches the audit store.
 *
 * The store is never pruned, so anything that enters it stays. Approved
 * content, a secret value, a config value, an operator's note and a principal's
 * key must all stay out. One home runs every verb that could carry one of them,
 * in process, with a distinct sentinel on each path. Then every byte under
 * `<home>/audit/` is searched for each sentinel, raw and JSON-escaped.
 *
 * An absence proves nothing unless the sentinel was really on the path, so
 * each one is first shown present where it belongs: in the state document, the
 * registry, or seen by the handler it was meant for. The content sentinel rides
 * a real producer's Output that a content approval covers and a fire consumes,
 * never the cheap expired-window fixture, which never puts approved bytes on
 * any path at all.
 *
 * Everything this file writes goes under temp dirs (AGENTS.md Rule 2).
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { _setHome } from '../../lib/paths.js'
import { _getPaths, _setPaths, pathsForStateFile } from '../../board/state-manager.js'
import { main } from '../../cli/warpline.js'

const CONTENT = 'SENTINEL_APPROVED_CONTENT_7f3a'
const SECRET = 'SENTINEL_SECRET_VALUE_9c21'
const CONFIG = 'SENTINEL_CONFIG_VALUE_4b88'
const NOTE = 'SENTINEL_DENY_NOTE_1d05'
const KEY = 'SENTINEL_PRINCIPAL_KEY_6e70'
const SENTINELS = [CONTENT, SECRET, CONFIG, NOTE, KEY]

const SECRET_ENV = 'WARPLINE_TEST_AUDIT_SENTINEL_SECRET'

const REAL_PATHS = _getPaths()

let home: string

const statePath = (): string => join(home, 'state', 'engine-state.json')
const marks = (): string => join(home, 'marks')

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'warpline-audit-sentinels-'))
  mkdirSync(join(home, 'state'), { recursive: true })
  mkdirSync(join(home, 'plugins'), { recursive: true })
  writeFileSync(join(home, 'preferences.json'), JSON.stringify({ review_gate: false }))
  _setHome(home)
  _setPaths(pathsForStateFile(statePath(), { eventsPath: join(home, 'state', 'events.jsonl') }))
})

afterEach(() => {
  _setHome(null)
  rmSync(home, { recursive: true, force: true })
})

afterAll(() => {
  _setPaths(REAL_PATHS)
})

function manifest(name: string, overrides: Record<string, unknown>): string {
  return `export const manifest = ${JSON.stringify({
    name,
    version: '1.0.0',
    description: `${name} sentinel fixture`,
    inputs: {},
    outputs: {},
    capabilities: [],
    secrets: [],
    schedule: 'on_run',
    autonomy_level: 'autonomous',
    approval_class: 'session',
    side_effects: ['sends_email'],
    // Near zero, so the plugin is always due.
    ttl_hours: 0.001,
    dependencies: [],
    timeout_ms: 5000,
    max_parallelism: 1,
    min_tier: 'normal',
    max_retries: 1,
    retry_delay_ms: 1,
    ...overrides,
  })}`
}

/** A handler that writes `marker` under `<home>/marks/` when `check(args)` holds, then succeeds. */
function handler(name: string, check: string, body: string | null = null): string {
  const artifacts = body === null ? '[]' : `[{ type: 'brief', format: 'json', body: ${JSON.stringify(body)} }]`
  return `
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MARKS = ${JSON.stringify(marks())}

export async function handler(_manifest, args) {
  mkdirSync(MARKS, { recursive: true })
  writeFileSync(join(MARKS, ${JSON.stringify(`${name}-ran`)}), 'yes')
  ${check}
  return {
    status: 'success',
    phases_completed: [${JSON.stringify(name)}],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: ${JSON.stringify(`${name} completed`)},
    artifacts_produced: ${artifacts},
    schema_version: 1,
  }
}
`
}

function writePlugin(name: string, overrides: Record<string, unknown>, source: string): void {
  const dir = join(home, 'plugins', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'manifest.ts'), manifest(name, overrides))
  writeFileSync(join(dir, 'handler.ts'), source)
}

/**
 * `builder` produces an Output whose body holds the content sentinel. `sender`
 * is its content-class consumer. `mailer` is a granted session plugin that
 * declares a secret and takes its one input from its config file, and marks
 * each value's arrival without echoing it.
 */
function writePlugins(): void {
  writePlugin(
    'builder',
    { side_effects: [], outputs: { brief: { type: 'json' } }, ttl_hours: 24 },
    handler('builder', '', JSON.stringify({ batch: CONTENT })),
  )
  writePlugin('sender', { approval_class: 'content', dependencies: ['builder'] }, handler('sender', ''))
  writePlugin(
    'mailer',
    { secrets: [SECRET_ENV], inputs: { token: { type: 'string' } } },
    handler(
      'mailer',
      `if (process.env[${JSON.stringify(SECRET_ENV)}] === ${JSON.stringify(SECRET)}) writeFileSync(join(MARKS, 'secret-arrived'), 'yes')
  if (args.token === ${JSON.stringify(CONFIG)}) writeFileSync(join(MARKS, 'config-arrived'), 'yes')`,
    ),
  )
  mkdirSync(join(home, 'config'), { recursive: true })
  writeFileSync(join(home, 'config', 'mailer.json'), JSON.stringify({ token: CONFIG }))
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

/** Every file under `dir`, recursively, as bytes, keyed by path relative to `home`. */
function filesUnder(dir: string): Record<string, Buffer> {
  const out: Record<string, Buffer> = {}
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const child = join(current, entry.name)
      if (entry.isDirectory()) walk(child)
      else if (entry.isFile()) out[relative(home, child)] = readFileSync(child)
    }
  }
  if (existsSync(dir)) walk(dir)
  return out
}

/** The sentinel as it would sit inside a JSON string. */
const escaped = (s: string): string => JSON.stringify(s).slice(1, -1)

function holds(bytes: Buffer, sentinel: string): boolean {
  return bytes.includes(sentinel) || bytes.includes(escaped(sentinel))
}

type Line = { type: string; data: Record<string, unknown> }

function records(): Line[] {
  return Object.values(filesUnder(join(home, 'audit'))).flatMap((bytes) =>
    bytes
      .toString('utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Line),
  )
}

describe('nothing erasable reaches the audit store', () => {
  test('approved content, a secret, a config value, a note and a key travel their paths and none lands in audit/', async () => {
    writePlugins()
    const had = Object.hasOwn(process.env, SECRET_ENV)
    const previous = process.env[SECRET_ENV]
    process.env[SECRET_ENV] = SECRET
    try {
      expect((await capture(['approve', 'mailer'])).code).toBe(0)
      // builder's Output appears; sender is refused for want of an approval; mailer fires.
      await capture(['advance'])
      expect((await capture(['approve', 'sender', '--content', '--not-after', '2099-01-01T00:00'])).code).toBe(0)
      // sender fires on the approved bytes.
      await capture(['advance'])
    } finally {
      if (had) process.env[SECRET_ENV] = previous
      else delete process.env[SECRET_ENV]
    }
    expect((await capture(['deny', 'sender', '--note', NOTE])).code).toBe(0)
    expect((await capture(['principal', 'add', 'k', '--type', 'machine', '--key', KEY])).code).toBe(0)
    expect((await capture(['prefs', 'set', 'max_sends_per_day', '7'])).code).toBe(0)

    // Each sentinel was on its path.
    const outside = Object.entries(filesUnder(home)).filter(([path]) => !path.startsWith('audit/'))
    const where = (sentinel: string): string[] =>
      outside.filter(([path, bytes]) => !path.startsWith('plugins/') && holds(bytes, sentinel)).map(([path]) => path)
    expect(where(CONTENT)).toContain('state/engine-state.json')
    expect(existsSync(join(marks(), 'sender-ran'))).toBe(true)
    expect(existsSync(join(marks(), 'secret-arrived'))).toBe(true)
    expect(existsSync(join(marks(), 'config-arrived'))).toBe(true)
    expect(where(CONFIG)).toContain('config/mailer.json')
    expect(where(NOTE)).toContain('state/engine-state.json')
    expect(where(KEY)).toContain('principals.json')

    // The store holds the records those paths wrote.
    const lines = records()
    const types = new Set(lines.map((l) => l.type))
    const intents = lines.filter((l) => l.type === 'warpline.audit.fire.intent').map((l) => [l.data.plugin, l.data.class])
    expect(intents).toContainEqual(['sender', 'content'])
    expect(intents).toContainEqual(['mailer', 'session'])
    for (const kind of [
      'content_approval.issued',
      'fire.intent',
      'fire.outcome',
      'denial.recorded',
      'principal.added',
      'preference.set',
      'checkpoint.recorded',
    ]) {
      expect(types).toContain(`warpline.audit.${kind}`)
    }

    // And no byte of it holds any sentinel.
    const stored = filesUnder(join(home, 'audit'))
    expect(Object.keys(stored).length).toBeGreaterThan(0)
    for (const [path, bytes] of Object.entries(stored)) {
      for (const sentinel of SENTINELS) expect(`${path}: ${sentinel} ${holds(bytes, sentinel)}`).toBe(`${path}: ${sentinel} false`)
    }
  })
})
