/**
 * `warpline deny` — in-process CLI tests, mirroring `approve.test.ts`.
 *
 * Same injection story: the subcommand resolves every path through
 * `src/lib/paths.ts` accessors, so `_setHome()` is the whole of it — no
 * argument plumbing, no subprocess. The fixture `manifest.ts` files are a bare
 * `export const manifest = {…}` with ZERO imports, which keeps them out of the
 * `warpline/schemas/*` resolution path entirely.
 *
 * The property this file exists to pin, above the individual behaviours: a
 * denial never touches the session approval file, and no gesture can mute more
 * than the plugins the operator named.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { _setHome, engineStatePath, sessionApprovalPath } from '../../lib/paths.js'
import { mergeGrant } from '../../runtime/approval-gate.js'
import { denialFingerprint } from '../../runtime/engine.js'
import type { PluginManifest } from '../../schemas/plugin-manifest.js'

let root: string
let statePath: string

function makeManifest(name: string, sideEffects: string[]): PluginManifest {
  return {
    name,
    version: '1.0.0',
    description: `${name} fixture plugin`,
    inputs: {},
    outputs: {},
    capabilities: [],
    schedule: 'on_run',
    autonomy_level: 'supervised',
    side_effects: sideEffects as PluginManifest['side_effects'],
    ttl_hours: 24,
    dependencies: [],
    timeout_ms: 5000,
    max_parallelism: 1,
    min_tier: 'normal',
    max_retries: 1,
    retry_delay_ms: 2000,
  }
}

const FIXTURES = [
  makeManifest('render-issue', ['creates_issue']),
  makeManifest('digest-sender', ['sends_email', 'external_api']),
  makeManifest('quiet-plugin', []),
]

/** Run `deny`'s `run(argv)` with stdout/stderr captured. */
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
    const { run } = await import('../deny.js')
    const code = await run(argv)
    return { code, stdout, stderr }
  } finally {
    process.stdout.write = realOut
    process.stderr.write = realErr
  }
}

const readState = async () => JSON.parse(await readFile(statePath, 'utf-8'))
const rawState = () => readFile(statePath, 'utf-8').catch(() => '(absent)')

/** Every file under `dir` with its bytes — the whole-home snapshot. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const found: Record<string, string> = {}
  async function walk(current: string, prefix: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const child = join(current, entry.name)
      const rel = prefix ? join(prefix, entry.name) : entry.name
      if (entry.isDirectory()) await walk(child, rel)
      else found[rel] = await readFile(child, 'utf-8')
    }
  }
  await walk(dir, '')
  return found
}

beforeEach(async () => {
  root = join(tmpdir(), `warpline-deny-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  const pluginsDir = join(root, 'plugins')
  await mkdir(pluginsDir, { recursive: true })
  for (const m of FIXTURES) {
    const dir = join(pluginsDir, m.name)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'manifest.ts'), `export const manifest = ${JSON.stringify(m)}`)
  }
  _setHome(root)
  statePath = engineStatePath()
  await mkdir(join(root, 'state'), { recursive: true })
})

afterEach(async () => {
  _setHome(null)
  await rm(root, { recursive: true, force: true })
})

describe('warpline deny', () => {
  test('1: `deny <name>` writes exactly one denials entry carrying the current fingerprint', async () => {
    const { code, stderr, stdout } = await capture(['render-issue'])

    expect(code).toBe(0)
    expect(stderr).toBe('')
    expect(stdout).toContain('render-issue')

    const state = await readState()
    expect(Object.keys(state.denials)).toEqual(['render-issue'])
    expect(state.denials['render-issue'].fingerprint).toBe(
      denialFingerprint('render-issue', ['creates_issue'], []),
    )
    expect(state.denials['render-issue'].note).toBeNull()
  })

  test('2: `--note` records the operator\'s own words', async () => {
    await capture(['digest-sender', '--note', 'too chatty this week'])
    expect((await readState()).denials['digest-sender'].note).toBe('too chatty this week')
  })

  test('3: one unknown name aborts the whole command and writes nothing', async () => {
    await capture(['render-issue'])
    const before = await rawState()

    const { code, stderr } = await capture(['digest-sender', 'digest-sendr'])

    expect(code).toBe(1)
    expect(stderr).toContain('digest-sendr')
    expect(stderr).toContain("did you mean 'digest-sender'")
    expect(stderr).toContain('Nothing was denied.')
    // The state file is unchanged byte for byte — the stronger claim than
    // "digest-sender has no denial", which an aborted write could also satisfy.
    expect(await rawState()).toBe(before)
  })

  test('4: an unknown name with nothing close prints the known plugins', async () => {
    const { code, stderr } = await capture(['zzzzzzzzzz'])

    expect(code).toBe(1)
    expect(stderr).toContain('Known plugins:')
    expect(stderr).toContain('render-issue')
    expect(existsSync(statePath)).toBe(false)
  })

  test('5: `--list` prints the live denials and writes nothing', async () => {
    await capture(['render-issue', '--note', 'not this week'])
    const before = await rawState()

    const { code, stdout } = await capture(['--list'])

    expect(code).toBe(0)
    expect(stdout).toContain('render-issue')
    expect(stdout).toContain('not this week')
    expect(await rawState()).toBe(before)
  })

  test('5b: repeated `--list` over a stub gate does not re-emit the discard notice', async () => {
    // The discard happens on every read and is never persisted by `--list`, so
    // the notice fired again on the next `--list`, and the next, for as long as
    // the stub sat there. `deny.test.ts` compared only the state file, so it
    // did not see the growing event log.
    //
    // The policy stays fail-closed. `readEngineStateReadOnly` would suppress
    // the notice too, and would also turn an unusable document into "No
    // denials" — silently telling an operator nothing is denied is a worse
    // failure than a repeated notice.
    const eventsPath = join(root, 'state', 'events.jsonl')
    await mkdir(join(root, 'state'), { recursive: true })
    await writeFile(
      statePath,
      JSON.stringify({
        schema_version: 1,
        plugin_runs: {},
        denials: {},
        // Neither clock: the pre-Phase-8 shape `isStubGate` recognises.
        pending_gates: [
          {
            plugin: 'render-issue',
            run_id: 'run-old',
            created_at: '2026-08-01T00:00:00.000Z',
            payload_summary: 'a gate from an older build',
            plugin_result: {
              status: 'success',
              phases_completed: [],
              phases_failed: [],
              errors: [],
              data_freshness: {},
              summary: 'a gate from an older build',
              artifacts_produced: [],
              schema_version: 2,
            },
            run_started_at: null,
            run_completed_at: null,
            applied_at: null,
          },
        ],
      }),
    )

    for (let i = 0; i < 3; i += 1) expect((await capture(['--list'])).code).toBe(0)

    const lines = await readFile(eventsPath, 'utf-8').catch(() => '')
    expect(lines).toBe('')
  })

  test('6: `--list` with no denials says so rather than printing an empty block', async () => {
    const { code, stdout } = await capture(['--list'])
    expect(code).toBe(0)
    expect(stdout).toContain('No denials')
  })

  test('7: `--remove <plugin>` removes exactly that entry and returns 0', async () => {
    await capture(['render-issue'])
    await capture(['digest-sender'])

    const { code, stdout } = await capture(['--remove', 'render-issue'])

    expect(code).toBe(0)
    expect(stdout).toContain('render-issue')
    expect(Object.keys((await readState()).denials)).toEqual(['digest-sender'])
  })

  /**
   * Validated against the denials record, not the manifests: a plugin
   * uninstalled after it was denied must still be removable, or its denial
   * would be unreachable from the CLI forever.
   */
  test('8: removing a plugin with no denial says so and writes nothing', async () => {
    await capture(['render-issue'])
    const before = await rawState()

    const { code, stderr } = await capture(['--remove', 'digest-sender'])

    expect(code).toBe(1)
    expect(stderr).toContain('digest-sender')
    expect(stderr).toContain('Nothing was removed.')
    expect(await rawState()).toBe(before)
  })

  /**
   * The no-wildcard prohibition, and `strict: true` is what delivers it: an
   * undeclared all-plugins flag is rejected by argument parsing before any
   * code of ours runs. The record keyed by plugin name has no key that could
   * express one either, so this is the second of two independent controls.
   */
  test('9: an all-plugins flag is rejected by the parser and nothing is written', async () => {
    const { code, stderr } = await capture(['--all'])

    expect(code).toBe(1)
    expect(stderr).toContain('--all')
    expect(stderr).toContain('Usage: warpline deny')
    expect(existsSync(statePath)).toBe(false)
  })

  /**
   * `denials` is a plain object, so every inherited member of
   * `Object.prototype` answers a bare `denials[name]` lookup with something
   * that is not a denial. The removal path is where this reaches the operator:
   * its names are deliberately validated against the record and not against
   * the manifests, so any string arrives here.
   */
  test('9b: `--remove` of a prototype member is refused, and the state file is untouched', async () => {
    await capture(['render-issue'])
    const before = await rawState()

    for (const name of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      const { code, stderr } = await capture(['--remove', name])

      expect(code).toBe(1)
      expect(stderr).toContain(`No denial recorded for ${name}.`)
      // The state document is byte-identical: the removal reported success and
      // rewrote the file while deleting nothing.
      expect(await rawState()).toBe(before)
    }

    // Non-vacuity: the same path DOES remove a name that really is there.
    expect((await capture(['--remove', 'render-issue'])).code).toBe(0)
  })

  /**
   * The explicit evidence for "denying twice is a no-op". The record's key
   * makes it structurally true; this makes it observable — the second command
   * writes nothing at all, so the state file is byte-identical.
   */
  /**
   * The reason string is read back in three places — `deny --list`, the
   * `denial_recorded` notice in `events.jsonl`, and the skip detail the
   * evaluator writes on every suppressed advance — so a false one is not
   * cosmetic. `findPendingGate` returns already-applied markers on purpose, and
   * a marker means the operator ACCEPTED that result. Markers now live up to 24
   * hours, so this window is not a corner.
   */
  async function seedGateFor(plugin: string, appliedAt: string | null): Promise<void> {
    const at = new Date(Date.now() - 30_000).toISOString()
    await mkdir(join(root, 'state'), { recursive: true })
    await writeFile(
      statePath,
      JSON.stringify({
        schema_version: 1,
        plugin_runs: {},
        denials: {},
        pending_gates: [
          {
            plugin,
            run_id: 'run-a',
            created_at: at,
            payload_summary: 'sent the weekly digest',
            plugin_result: {
              status: 'success',
              phases_completed: [plugin],
              phases_failed: [],
              errors: [],
              data_freshness: {},
              summary: 'sent the weekly digest',
              artifacts_produced: [],
              schema_version: 2,
            },
            run_started_at: at,
            run_completed_at: at,
            applied_at: appliedAt,
          },
        ],
      }),
    )
  }

  test('9c: a denial against a spent marker does not claim the operator declined a result they applied', async () => {
    await seedGateFor('render-issue', new Date(Date.now() - 10_000).toISOString())

    const { code } = await capture(['render-issue'])

    expect(code).toBe(0)
    // The standing proposal is what is being answered. The applied result was
    // accepted, and no record may say otherwise.
    expect((await readState()).denials['render-issue'].reason).toBe(
      'the operator declined this proposal',
    )
  })

  test('9d: a denial against a LIVE parked gate still names the run it declined', async () => {
    // Non-vacuity for 9c: same path, same seed shape, and the only difference
    // is `applied_at`. Without this the fix would read as "never name a run".
    await seedGateFor('render-issue', null)

    expect((await capture(['render-issue'])).code).toBe(0)

    expect((await readState()).denials['render-issue'].reason).toBe(
      'the operator declined the parked result from run run-a',
    )
  })

  test('10: denying the same plugin twice against an unchanged proposal writes nothing the second time', async () => {
    await capture(['render-issue'])
    const before = await rawState()

    const { code, stdout } = await capture(['render-issue'])

    expect(code).toBe(0)
    expect(stdout).toContain('already denied')
    expect(await rawState()).toBe(before)
    expect(Object.keys((await readState()).denials)).toEqual(['render-issue'])
  })

  test('11: denying again after the proposal moved replaces the entry rather than adding one', async () => {
    await capture(['render-issue'])

    // The plugin produced an Output since. The proposal has moved, so the old
    // answer no longer applies and a fresh denial is a real write.
    const state = await readState()
    state.plugin_runs = {
      'render-issue': {
        last_run_at: new Date().toISOString(),
        status: 'gated',
        last_output: { type: 'brief', format: 'markdown', path: 'brief.md' },
      },
    }
    await writeFile(statePath, JSON.stringify(state))

    const { code, stdout } = await capture(['render-issue'])

    expect(code).toBe(0)
    expect(stdout).not.toContain('already denied')
    const after = await readState()
    expect(Object.keys(after.denials)).toEqual(['render-issue'])
    expect(after.denials['render-issue'].fingerprint).toBe(
      denialFingerprint('render-issue', ['creates_issue'], [
        { type: 'brief', format: 'markdown', path: 'brief.md' },
      ]),
    )
  })

  /**
   * A denial never touches the session approval file — saying no to an outcome
   * must not move side-effect authority in either direction. The structural
   * guarantee is that `deny.ts` names no symbol from `approval-gate.ts`; this
   * whole-home snapshot is the backstop, on both variants: with no grant file
   * present, and with one that already exists.
   */
  test('12: denying creates no session approval file', async () => {
    const before = await snapshot(root)

    await capture(['render-issue'])

    expect(existsSync(sessionApprovalPath())).toBe(false)
    const after = await snapshot(root)
    const added = Object.keys(after)
      .filter((f) => !(f in before))
      .map((f) => f.split('/').at(-1))
      .sort()
    // The state document and the denial notice, and nothing else. Listing what
    // IS allowed rather than asserting the grant file is absent: a new write
    // the operator did not ask for fails this, whatever it is called.
    expect(added).toEqual(['engine-state.json', 'events.jsonl'])
  })

  test('13: denying touches a session approval file that already exists', async () => {
    await mergeGrant(['digest-sender'], {}, sessionApprovalPath())
    const grantBefore = await readFile(sessionApprovalPath(), 'utf-8')

    await capture(['digest-sender'])

    expect(await readFile(sessionApprovalPath(), 'utf-8')).toBe(grantBefore)
  })

  /**
   * The transitive version of the prohibition, replacing a grep of `deny.ts`
   * alone.
   *
   * The single-file grep asserted something that was already false: `deny.ts`
   * imports `../runtime/engine.js`, which statically imports the approval gate
   * for its reader, so the writers live in the graph. Worse, it gated nothing
   * that matters — a grant write added to a helper inside `engine.ts` would
   * have broken the prohibition with this test still green.
   *
   * What is scanned is CALL shape, not mere mention: `suggest.ts` names a
   * writer in a comment explaining why it exists, and a comment is not a call.
   * The module that DEFINES the writers is skipped for the same reason it is in
   * the closure at all — being reachable is not the defect, being called is.
   */
  test('14: no module on the denial path calls anything that writes the grant file', async () => {
    const GRANT_WRITERS = ['mergeGrant', 'grantApproval', 'revokeApproval']
    const DEFINER = join('runtime', 'approval-gate.ts')
    const srcRoot = fileURLToPath(new URL('../../', import.meta.url))

    const closure = new Map<string, string>()
    async function visit(file: string): Promise<void> {
      if (closure.has(file)) return
      const source = await readFile(file, 'utf-8')
      closure.set(file, source)
      for (const m of source.matchAll(/from\s+'(\.[^']+)'/g)) {
        await visit(resolve(dirname(file), (m[1] as string).replace(/\.js$/, '.ts')))
      }
    }
    await visit(fileURLToPath(new URL('../deny.ts', import.meta.url)))

    // Vacuity guards. Without them a walker that resolved nothing would pass,
    // and so would one that never reached the module which made the original
    // claim false.
    expect(closure.size).toBeGreaterThan(5)
    expect([...closure.keys()].some((f) => f.endsWith(DEFINER))).toBe(true)

    const callers = [...closure.entries()]
      .filter(
        ([file, source]) =>
          !file.endsWith(DEFINER) &&
          GRANT_WRITERS.some((w) => new RegExp(`\\b${w}\\s*\\(`).test(source)),
      )
      .map(([file]) => relative(srcRoot, file))

    expect(callers).toEqual([])
  })
})
