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
import { join } from 'node:path'
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
   * The explicit evidence for "denying twice is a no-op". The record's key
   * makes it structurally true; this makes it observable — the second command
   * writes nothing at all, so the state file is byte-identical.
   */
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
    const added = Object.keys(after).filter((f) => !(f in before))
    // Only the state document is new.
    expect(added.map((f) => f.split('/').at(-1))).toEqual(['engine-state.json'])
  })

  test('13: denying touches a session approval file that already exists', async () => {
    await mergeGrant(['digest-sender'], {}, sessionApprovalPath())
    const grantBefore = await readFile(sessionApprovalPath(), 'utf-8')

    await capture(['digest-sender'])

    expect(await readFile(sessionApprovalPath(), 'utf-8')).toBe(grantBefore)
  })

  test('14: the module names no symbol from the approval gate', async () => {
    const source = await readFile(new URL('../deny.ts', import.meta.url), 'utf-8')
    expect(source).not.toContain('approval-gate')
    expect(source).not.toContain('mergeGrant')
    expect(source).not.toContain('sessionApprovalPath')
  })
})
