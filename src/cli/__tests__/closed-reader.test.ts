/**
 * Every verb, seen from outside the process, against a reader that has gone
 * away, and `run` against a reader that is slow.
 *
 * The spec promises that a reader that has gone away (`| head`) ends every
 * verb quietly, with the verb's own exit code, and that `run` drains plugin
 * output still queued on stderr before it exits. There is no in-process seam
 * for either half. The policy sits on the real process streams and in the
 * exit, so this file launches the built `dist/bin/warpline.js`.
 *
 * It launches it under node and under bun. Node runs the published bin, and
 * with no 'error' listener on the stream a closed reader crashes it with exit
 * 1. Bun prints a stack and carries on. `bun run test` builds first. A bare
 * `bun test` runs whatever dist holds.
 *
 * `(exit 0)` closes the read end long before the bin has started, so the
 * bin's first stdout write meets a closed pipe every time.
 *
 * Each row has a control: the same command with stdout into a file. A verb
 * that writes nothing to stdout never meets the closed reader, so it would
 * pass with no guard at all, and the control is what shows it wrote something.
 *
 * The rows are checked against the dispatcher's switch, so a verb added later
 * can't sit outside this file's reach.
 *
 * The ticker case is `run` with a plugin still printing to stderr as run
 * exits. Those late writes must not cut what was queued before them. Its
 * pipeline runs under a deadline that kills the whole process group, so a
 * drain that never settles is a named failure here, never a hung runner.
 *
 * The closed-stderr case sends stderr, not stdout, into the closed pipe. On
 * node, a stderr with no 'error' listener crashes the bin with exit 1. Bun
 * carries on, with its stack written to nowhere. So that case can only go red
 * on node.
 *
 * The child env drops NODE_ENV. bun test sets it to `test`, and run-plugin.ts
 * skips its process tail under that value, so an inherited NODE_ENV makes
 * `run` exit 1 through the dispatcher's fallback.
 *
 * Everything this file writes goes under temp dirs (AGENTS.md Rule 2).
 */
import { test, expect } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { testFixturesDir } from '../../../test-utils/fixtures.js'

const ROOT = testFixturesDir(import.meta.url, '../../..')

/** The built bin, the path a real consumer runs. */
const BIN = join(ROOT, 'dist/bin/warpline.js')

/** Not `process.execPath`: under `bun test` that is bun. */
const NODE = process.env.NODE ?? 'node'

const RUNTIMES: [string, string][] = [
  ['node', NODE],
  ['bun', process.execPath],
]

/** How many 499-character lines `chatty` prints: 200,000 bytes, over a 64 KiB pipe buffer. */
const CHATTY_LINES = 400

/** Stands in for the effect id `resolve` needs, read from each home's state at launch. */
const EFFECT_ID = '<effect-id>'

const RESULT = (summary: string, artifacts = '[]'): string => `{
    status: 'success',
    phases_completed: ['run'],
    phases_failed: [],
    errors: [],
    data_freshness: {},
    summary: ${JSON.stringify(summary)},
    artifacts_produced: ${artifacts},
    schema_version: 1,
  }`

/**
 * Every field spelled out. The loader validates manifests, and naming each one
 * keeps the fixtures off the schema defaults.
 */
function manifest(fields: Record<string, unknown>): string {
  return `export const manifest = ${JSON.stringify({
    version: '1.0.0',
    description: `${String(fields.name)} fixture`,
    inputs: {},
    outputs: {},
    capabilities: [],
    secrets: [],
    schedule: 'manual',
    autonomy_level: 'autonomous',
    side_effects: [],
    ttl_hours: 24,
    dependencies: [],
    timeout_ms: 30_000,
    max_parallelism: 1,
    max_retries: 0,
    retry_delay_ms: 10,
    min_tier: 'normal',
    ...fields,
  })}\n`
}

function plugin(home: string, name: string, manifestSource: string, handlerSource: string): void {
  const dir = join(home, 'plugins', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'manifest.ts'), manifestSource)
  writeFileSync(join(dir, 'handler.ts'), handlerSource)
}

/**
 * A home with five plugins. `mailer` takes a session approval. `chatty` floods
 * stdout, which the runtime redirects to stderr while a handler runs. `ticker`
 * floods the same way, then keeps printing to stderr after its handler has
 * returned. `builder` and `sender` are a content producer and its consumer.
 * `sender` fails while a `fail` file exists in this home.
 */
function buildHome(dir: string): string {
  mkdirSync(dir, { recursive: true })
  // Home-level: `advance` resolves preferences through the home default.
  // Without this the shipped review gate stops every plugin.
  writeFileSync(join(dir, 'preferences.json'), JSON.stringify({ review_gate: false }))

  plugin(
    dir,
    'mailer',
    manifest({ name: 'mailer', side_effects: ['sends_email'], approval_class: 'session' }),
    `export async function handler() {\n  return ${RESULT('mailed')}\n}\n`,
  )
  plugin(
    dir,
    'chatty',
    manifest({ name: 'chatty' }),
    `export async function handler() {
  for (let i = 0; i < ${CHATTY_LINES}; i++) console.log('z'.repeat(499))
  return ${RESULT('chatted')}
}\n`,
  )
  // `process.stderr.write`, not console.log: the redirect is off once the
  // handler has returned, and a console.log would then go to stdout, which
  // the run cases send to /dev/null. The cap of 150 ticks lets a drain that
  // never settles end on node with exit 13, instead of printing forever.
  plugin(
    dir,
    'ticker',
    manifest({ name: 'ticker' }),
    `export async function handler() {
  for (let i = 0; i < ${CHATTY_LINES}; i++) console.log('z'.repeat(499))
  let ticks = 0
  const timer = setInterval(() => {
    process.stderr.write('tick\\n')
    if (++ticks >= 150) clearInterval(timer)
  }, 20)
  return ${RESULT('ticked')}
}\n`,
  )
  plugin(
    dir,
    'builder',
    manifest({
      name: 'builder',
      schedule: 'on_run',
      min_tier: 'suspended',
      outputs: { brief: { type: 'json' } },
      approval_class: 'session',
      ttl_hours: 24,
    }),
    `export async function handler() {
  return ${RESULT('built', `[{ type: 'brief', format: 'json', body: ${JSON.stringify('{"batch":"four invoices"}')} }]`)}
}\n`,
  )
  plugin(
    dir,
    'sender',
    manifest({
      name: 'sender',
      schedule: 'on_run',
      min_tier: 'suspended',
      approval_class: 'content',
      dependencies: ['builder'],
      side_effects: ['sends_email'],
      // Near zero, so sender is stale on every advance and reaches the content gate.
      ttl_hours: 0.001,
    }),
    `import { existsSync } from 'node:fs'
export async function handler() {
  if (existsSync(${JSON.stringify(join(dir, 'fail'))})) {
    return {
      status: 'failed',
      phases_completed: [],
      phases_failed: ['run'],
      errors: [{ phase: 'run', message: 'the sink answered 500', recoverable: false }],
      data_freshness: {},
      summary: 'the send reported a failure',
      artifacts_produced: [],
      schema_version: 1,
    }
  }
  return ${RESULT('sent')}
}\n`,
  )
  return dir
}

const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/** The env every launch gets, spelled out: a bun child spawned with the default env sees a startup snapshot. */
function childEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, WARPLINE_HOME: home }
  delete env.NODE_ENV
  return env
}

type Mode = 'control' | 'closed' | 'closed-stderr'

/**
 * One launch of the bin under `sh -c`. `control` sends stdout to a file.
 * `closed` pipes it into `(exit 0)`. `closed-stderr` pipes stderr into
 * `(exit 0)` and sends stdout to the file. Scratch files sit beside the home,
 * under the test's temp root.
 */
function launch(runtime: string, home: string, argv: string[], mode: Mode): { code: number; out: string; err: string } {
  const io = `${home}.io`
  mkdirSync(io, { recursive: true })
  const [out, err, rc] = ['out', 'err', 'rc'].map(f => join(io, f))
  for (const f of [out, err, rc]) rmSync(f, { force: true })
  const command = [runtime, BIN, ...argv].map(q).join(' ')
  const script =
    mode === 'control'
      ? `${command} > ${q(out)} 2> ${q(err)}; echo $? > ${q(rc)}`
      : mode === 'closed'
        ? `{ ${command} 2> ${q(err)}; echo $? > ${q(rc)}; } | (exit 0)`
        : `{ ${command} 2>&1 > ${q(out)}; echo $? > ${q(rc)}; } | (exit 0)`
  spawnSync('sh', ['-c', script], { env: childEnv(home), stdio: 'ignore', timeout: 60_000 })
  const read = (f: string): string => (existsSync(f) ? readFileSync(f, 'utf8') : '')
  const code = Number.parseInt(read(rc).trim(), 10)
  return { code: Number.isNaN(code) ? -1 : code, out: mode === 'closed' ? '' : read(out), err: read(err) }
}

type Row = {
  argv: string[]
  code: number
  /** Runs on its own fresh, empty home per mode, not the shared one. */
  freshHome?: true
  /** Setup that runs on a home before the row. Returns problems. */
  before?: (runtime: string, home: string) => string[]
}

function effectId(home: string): string {
  const path = join(home, 'state', 'engine-state.json')
  if (!existsSync(path)) return ''
  const state = JSON.parse(readFileSync(path, 'utf8')) as { approvals?: Record<string, { effect_id?: string }> }
  return state.approvals?.sender?.effect_id ?? ''
}

/** In order. Each row was measured on the bin to exit with its code and an empty stderr in control mode. */
const ROWS: Row[] = [
  { argv: ['--help'], code: 0 },
  { argv: ['init'], code: 0, freshHome: true },
  { argv: ['plan'], code: 0 },
  // builder runs, and sender waits at the content gate.
  { argv: ['advance', '--json'], code: 0 },
  { argv: ['configure', 'mailer', '--from', '{}'], code: 0 },
  { argv: ['run', 'mailer', 'go', '--json'], code: 0 },
  { argv: ['approve', 'mailer'], code: 0 },
  { argv: ['revoke'], code: 0 },
  { argv: ['deny', 'mailer'], code: 0 },
  { argv: ['deny', '--remove', 'mailer'], code: 0 },
  { argv: ['approve', 'sender', '--content', '--not-after', '2099-01-01T00:00'], code: 0 },
  {
    argv: ['resolve', 'sender', '--not-shipped', EFFECT_ID],
    code: 0,
    // Not a row of its own: sender fails after its approval was marked, so
    // there is an unconfirmed fire to resolve.
    before: (runtime, home) => {
      writeFileSync(join(home, 'fail'), '')
      const { code } = launch(runtime, home, ['advance'], 'control')
      const problems = code === 1 ? [] : [`setup advance: rc ${code}, expected 1`]
      if (!effectId(home)) problems.push('setup advance: no approvals.sender.effect_id in engine-state.json')
      return problems
    },
  },
  { argv: ['approve', 'sender', '--content', '--remove'], code: 0 },
  { argv: ['audit', 'head'], code: 0 },
  { argv: ['prefs', 'set', 'max_sends_per_day', '20'], code: 0 },
  { argv: ['principal', 'add', 'ops', '--type', 'human'], code: 0 },
  {
    argv: ['audit', 'export', '--after', '0'],
    code: 0,
    // A store over 64 KiB, so the export fills the pipe and has to wait on a
    // reader that has gone away. A small one never waits, and passes with no
    // wait handling at all.
    before: (_runtime, home) => {
      const io = `${home}.io`
      mkdirSync(io, { recursive: true })
      const script = join(io, 'grow.ts')
      writeFileSync(
        script,
        [
          `import { appendAudit } from ${JSON.stringify(join(ROOT, 'src/lib/audit-log.ts'))}`,
          `const statePath = ${JSON.stringify(join(home, 'state', 'engine-state.json'))}`,
          `for (let i = 0; i < 300; i++) await appendAudit(statePath, 'denial.lifted', { plugin: 'grow-' + i, fingerprint: null })`,
          '',
        ].join('\n'),
      )
      const { status } = spawnSync(process.execPath, [script], { env: childEnv(home), stdio: 'ignore', timeout: 60_000 })
      const audit = join(home, 'audit')
      const bytes = existsSync(audit)
        ? readdirSync(audit)
            .filter(n => /^\d{16}\.jsonl$/.test(n))
            .reduce((sum, n) => sum + statSync(join(audit, n)).size, 0)
        : 0
      const problems: string[] = []
      if (status !== 0) problems.push(`setup grow: status ${status}, expected 0`)
      if (bytes < 65_536) problems.push(`setup grow: store is ${bytes} bytes, under 65536`)
      return problems
    },
  },
  // Last, so no later advance loads the scaffolded plugin.
  { argv: ['scaffold', 'newbie'], code: 0 },
]

for (const [name, runtime] of RUNTIMES) {
  test(`every verb ends quietly with its own exit code when the reader has gone away (${name})`, () => {
    const root = mkdtempSync(join(tmpdir(), `warpline-closed-reader-${name}-`))
    const problems: string[] = []
    try {
      const homes: Record<'control' | 'closed', string> = {
        control: buildHome(join(root, 'control')),
        closed: buildHome(join(root, 'closed')),
      }
      ROWS.forEach((row, i) => {
        for (const mode of ['control', 'closed'] as const) {
          const home = row.freshHome ? join(root, `fresh-${i}-${mode}`) : homes[mode]
          mkdirSync(home, { recursive: true })
          for (const p of row.before?.(runtime, home) ?? []) problems.push(`${name} ${row.argv.join(' ')} [${mode}] ${p}`)
        }
        for (const mode of ['control', 'closed'] as const) {
          const home = row.freshHome ? join(root, `fresh-${i}-${mode}`) : homes[mode]
          const argv = row.argv.map(a => (a === EFFECT_ID ? effectId(home) : a))
          const tag = `${name} ${argv.join(' ')} [${mode}]`
          const r = launch(runtime, home, argv, mode)
          if (r.code !== row.code) problems.push(`${tag}: rc ${r.code}, expected ${row.code}`)
          if (mode === 'control' && r.out === '') problems.push(`${tag}: empty stdout, so the closed run proves nothing`)
          if (r.err !== '') problems.push(`${tag}: stderr ${JSON.stringify(r.err.slice(0, 200))}`)
        }
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
    expect(problems).toEqual([])
  }, 120_000)
}

test('every dispatched command has a row', () => {
  const dispatcher = readFileSync(join(ROOT, 'src/cli/warpline.ts'), 'utf8')
  const labels = [...dispatcher.matchAll(/^\s*case '([^']+)':/gm)]
    .map(m => m[1] as string)
    .filter(c => !c.startsWith('-'))
  // A parse that finds nothing must fail here, not pass over an empty list.
  expect(labels.length).toBeGreaterThan(0)
  expect(labels).toEqual(expect.arrayContaining(['advance', 'run', 'approve', 'deny', 'resolve']))

  const firstWords = new Set(ROWS.map(r => r.argv[0]))
  expect(labels.filter(l => !firstWords.has(l))).toEqual([])
})

/**
 * Runs `script` under `sh` in its own process group and collects its stdout.
 * After `ms` it kills the whole group. spawnSync's timeout signals only `sh`,
 * which would leave a bin that never exits running behind the test, still
 * printing. The group kill ends the bin and the reader with it.
 */
function pipeline(script: string, env: NodeJS.ProcessEnv, ms: number): Promise<{ out: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', script], { env, detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    let timedOut = false
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      out += chunk
    })
    const timer = setTimeout(() => {
      timedOut = true
      try {
        process.kill(-(child.pid as number), 'SIGKILL')
      } catch {
        // The group has already gone.
      }
    }, ms)
    child.on('error', reject)
    child.on('close', () => {
      clearTimeout(timer)
      resolve({ out, timedOut })
    })
  })
}

for (const [name, runtime] of RUNTIMES) {
  for (const [pluginName, title] of [
    ['chatty', 'run drains plugin output still queued on stderr before it exits'],
    ['ticker', 'run keeps the queued plugin output whole while the plugin is still printing'],
  ] as const) {
    test(`${title} (${name})`, async () => {
      // The fixture must stay larger than a pipe buffer, or this passes with no drain at all.
      expect(CHATTY_LINES * 500).toBeGreaterThan(65_536)

      const root = mkdtempSync(join(tmpdir(), `warpline-run-drain-${name}-`))
      try {
        const home = buildHome(join(root, 'home'))
        const rc = join(root, 'rc')
        const command = [runtime, BIN, 'run', pluginName, 'go', '--json'].map(q).join(' ')
        // The reader sleeps before it reads, so the pipe fills and the rest of
        // the plugin's output is still queued in the process when run finishes.
        const { out, timedOut } = await pipeline(
          `{ ${command} 2>&1 >/dev/null; echo $? > ${q(rc)}; } | (sleep 1; cat)`,
          childEnv(home),
          20_000,
        )
        expect(timedOut).toBe(false)
        expect(readFileSync(rc, 'utf8').trim()).toBe('0')
        expect(out.split('\n').filter(line => line === 'z'.repeat(499))).toHaveLength(CHATTY_LINES)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }, 30_000)
  }
}

for (const [name, runtime] of RUNTIMES) {
  test(`run ends quietly with its own exit code when the stderr reader has gone away (${name})`, () => {
    const root = mkdtempSync(join(tmpdir(), `warpline-closed-stderr-${name}-`))
    try {
      const home = buildHome(join(root, 'home'))
      const argv = ['run', 'chatty', 'go', '--json']
      const control = launch(runtime, home, argv, 'control')
      const closed = launch(runtime, home, argv, 'closed-stderr')

      expect(control.code).toBe(0)
      // The control really meets the stderr reader, or the closed run proves nothing.
      expect(control.err.length).toBeGreaterThanOrEqual(CHATTY_LINES * 500)
      expect(() => JSON.parse(control.out)).not.toThrow()
      expect(closed.code).toBe(control.code)
      expect(() => JSON.parse(closed.out)).not.toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)
}
