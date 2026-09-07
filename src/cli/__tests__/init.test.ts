/**
 * `warpline init` — in-process tests.
 *
 * The claim under test is the first-run one: an operator with an EMPTY home
 * runs one command and the next `warpline plan` renders an advance, with no
 * file authored by hand. Its negative control lives here too: the same
 * `plan` on a home nobody initialised renders a page but no advance.
 *
 * Both verbs are called through their exported `run` and never through a
 * spawned process. `init` resolves every path through `src/lib/paths.ts`, so
 * `_setHome` on a fresh temp home per test is most of the injection story.
 * The rest is the streams: `init` prompts on a terminal, so EVERY call to it
 * in this file goes through `runInit`, which injects its input and output.
 * The default input is an empty Readable that is not a terminal, never the
 * process stdin — under `bun test` from an interactive shell that stdin can
 * be a TTY, and a case that let init reach it would block on the developer's
 * keyboard. The walk is driven the way configure.test.ts drives it: injected
 * streams, in-process, with every answer in one chunk.
 *
 * Every invocation is bracketed by a snapshot of the process working
 * directory and the temp root that CONTAINS the home, so a write that
 * escaped the home by one level, or landed in the repository, fails the
 * test that made it.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { run as init, SEED_EXAMPLE } from '../init.js'
import { run as plan } from '../plan.js'
import { _setHome, pluginConfigPath, pluginsDir } from '../../lib/paths.js'
import { snapshotHome } from '../../runtime/__tests__/helpers/snapshot-home.js'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

// ---------------------------------------------------------------------------
// Home, capture, containment
// ---------------------------------------------------------------------------

let root: string
let home: string

beforeEach(() => {
  // A fresh random root per test: the manifest loader imports plugin files,
  // and a rewritten file at a reused path would be served from the module
  // cache. The home exists and is EMPTY — nothing else is created for it.
  root = mkdtempSync(join(tmpdir(), 'warpline-init-'))
  home = join(root, 'home')
  mkdirSync(home)
  _setHome(home)
})

afterEach(() => {
  _setHome(null)
  rmSync(root, { recursive: true, force: true })
})

interface Outcome {
  code: number
  stdout: string
  stderr: string
}

// ---------------------------------------------------------------------------
// Stream helpers, the shape configure.test.ts uses
// ---------------------------------------------------------------------------

/** A writable that keeps everything written to it. */
class Sink extends Writable {
  text = ''
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.text += chunk.toString()
    cb()
  }
}

/** Every line in ONE chunk: what a fast pipe delivers. Not a terminal. */
function fastPipe(lines: string[]): Readable & { isTTY?: boolean } {
  return Readable.from([lines.map((l) => `${l}\n`).join('')])
}

/** An injected stdin that claims to be a terminal, so init is allowed to prompt. */
function tty(lines: string[]): Readable & { isTTY?: boolean } {
  return Object.assign(fastPipe(lines), { isTTY: true })
}

/** What init wrote to the process streams and to the injected output. */
interface InitOutcome extends Outcome {
  /** Everything the walk wrote to the injected output stream. */
  out: string
}

/**
 * The cwd, one level deep, as name, size and mtime: a file created or removed
 * directly in the repository shows as a new entry or a changed directory
 * mtime.
 */
function cwdListing(): string[] {
  const cwd = process.cwd()
  return readdirSync(cwd)
    .sort()
    .map((name) => {
      const s = statSync(join(cwd, name))
      return `${name}|${s.size}|${s.mtimeMs}`
    })
}

/**
 * Containment: the cwd and the temp root before and after, with the resolved
 * home the ONLY place anything may appear or change. The root is the mkdtemp
 * parent that contains `home/`, not the system temp dir, so other tests
 * writing there cannot flake this and a write beside the home is caught.
 */
async function contained<T>(fn: () => Promise<T>): Promise<T> {
  const cwdBefore = cwdListing()
  const rootBefore = await snapshotHome(root)
  const result = await fn()
  const rootAfter = await snapshotHome(root)
  expect(cwdListing()).toEqual(cwdBefore)
  const changed = [
    ...rootAfter.filter((line) => !rootBefore.includes(line)),
    ...rootBefore.filter((line) => !rootAfter.includes(line)),
  ]
  expect(changed.filter((line) => !line.startsWith('home/'))).toEqual([])
  return result
}

/** Run a verb in-process with the process streams captured, inside the bracket. */
async function capture(fn: () => Promise<number>): Promise<Outcome> {
  return contained(async () => {
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
      return { code: await fn(), stdout, stderr }
    } finally {
      process.stdout.write = realOut
      process.stderr.write = realErr
    }
  })
}

/**
 * The ONLY call site of init in this file. The streams are always injected:
 * an omitted `input` is an EMPTY Readable that is not a terminal, so the
 * default is the piped path, and no case can reach the process stdin.
 */
async function runInit(argv: string[] = [], input: Readable & { isTTY?: boolean } = Readable.from([])): Promise<InitOutcome> {
  const sink = new Sink()
  const outcome = await capture(() => init(argv, { input, output: sink }))
  return { ...outcome, out: sink.text }
}

const seedDir = () => join(pluginsDir(), SEED_EXAMPLE)
const configFile = () => pluginConfigPath(SEED_EXAMPLE)
const readConfig = () => JSON.parse(readFileSync(configFile(), 'utf8')) as Record<string, unknown>

/** Anything left beside the seed's config file: a temp sibling that was never renamed away. */
function configSiblings(): string[] {
  const dir = dirname(configFile())
  return existsSync(dir) ? readdirSync(dir).filter((f) => f !== `${SEED_EXAMPLE}.json`) : []
}

/** The seed's manifest fields that are not under test, so a fixture manifest differs only in its inputs. */
const FIXTURE_REST = {
  version: '1.0.0',
  outputs: {},
  capabilities: [],
  schedule: 'on_run',
  autonomy_level: 'autonomous',
  side_effects: [],
  ttl_hours: 24,
  dependencies: [],
  timeout_ms: 5000,
  max_parallelism: 1,
  min_tier: 'normal',
  max_retries: 1,
  retry_delay_ms: 2000,
}

/**
 * Pre-place a manifest at the seed's own name, so init skips the copy and
 * writes config for what it finds: the path an operator hits after editing
 * the seeded plugin's manifest.
 */
function placeSeedManifest(description: string, inputs: Record<string, unknown>, secrets: string[] = []): void {
  mkdirSync(seedDir(), { recursive: true })
  writeFileSync(
    join(seedDir(), 'manifest.ts'),
    `export const manifest = ${JSON.stringify({ name: SEED_EXAMPLE, description, inputs, secrets, ...FIXTURE_REST })}`,
  )
}

// ---------------------------------------------------------------------------
// The claim and its control
// ---------------------------------------------------------------------------

describe('warpline init', () => {
  test('1: init in an empty home, then plan, renders an advance — nothing hand-authored', async () => {
    expect(readdirSync(home)).toEqual([])

    const initialised = await runInit()
    expect(initialised.code).toBe(0)
    expect(initialised.stderr).toBe('')

    const previewed = await capture(() => plan([]))
    expect(previewed.code).toBe(0)
    expect(previewed.stdout).toMatch(/^Due \(/m)
    expect(previewed.stdout).toContain('Due (1):')
    expect(previewed.stdout).toContain(`${SEED_EXAMPLE} (level 0)`)
    expect(previewed.stdout).not.toContain('No plugins installed.')
  })

  test('2: plan in a home nobody initialised exits 0 and renders a page but no advance', async () => {
    const before = await snapshotHome(home)
    const previewed = await capture(() => plan([]))
    expect(previewed.code).toBe(0)
    // The absence of the advance block is the claim; the string is the
    // secondary signal, brittle to a wording change where the absence is not.
    expect(previewed.stdout).not.toMatch(/^Due \(/m)
    expect(previewed.stdout).not.toContain('Due (')
    expect(previewed.stdout).toContain('No plugins installed.')
    expect(await snapshotHome(home)).toEqual(before)
  })

  test('3: a second init leaves the whole home byte-identical', async () => {
    expect((await runInit()).code).toBe(0)
    const first = await snapshotHome(home)
    expect(first.length).toBeGreaterThan(0)

    const again = await runInit()
    expect(again.code).toBe(0)
    expect(await snapshotHome(home)).toEqual(first)
  })

  test('4: init over an operator-edited config leaves that file byte-identical', async () => {
    expect((await runInit()).code).toBe(0)
    const configPath = pluginConfigPath(SEED_EXAMPLE)
    expect(existsSync(configPath)).toBe(true)

    const edited = '{\n  "retention_days": 7\n}\n'
    writeFileSync(configPath, edited)
    const editedBytes = readFileSync(configPath)

    const again = await runInit()
    expect(again.code).toBe(0)
    expect(readFileSync(configPath).equals(editedBytes)).toBe(true)
  })

  test('5: init creates the home artifacts a plugin needs to load, plus config/ and the seed', async () => {
    expect((await runInit()).code).toBe(0)

    const link = join(home, 'node_modules', 'warpline')
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(existsSync(join(link, 'package.json'))).toBe(true)

    const marker = JSON.parse(readFileSync(join(home, 'package.json'), 'utf8')) as { type?: string }
    expect(marker.type).toBe('module')

    expect(statSync(join(home, 'config')).isDirectory()).toBe(true)
    expect(existsSync(join(seedDir(), 'manifest.ts'))).toBe(true)
    expect(existsSync(join(seedDir(), 'handler.ts'))).toBe(true)
  })

  test('6: a required input with no default is reported, not fatal: exit 0, the defaulted keys written, the rest named', async () => {
    placeSeedManifest('fixture with one undefaulted required input', {
      address: { type: 'string', required: true, description: 'No default on purpose.' },
      limit: { type: 'number', required: false, default: 10, description: 'Defaulted.' },
    })

    const initialised = await runInit()
    expect(initialised.code).toBe(0)
    expect(readConfig()).toEqual({ limit: 10 })

    expect(initialised.stdout).toContain('address')
    expect(initialised.stdout).toContain(`warpline configure ${SEED_EXAMPLE}`)
  })

  test('7: the containment bracket has teeth — a write beside the home fails the test that made it', async () => {
    await expect(
      contained(async () => {
        writeFileSync(join(root, 'escaped.txt'), 'x')
      }),
    ).rejects.toThrow()
    rmSync(join(root, 'escaped.txt'))
  })

  test('8: a positional or an unknown flag is a usage error that writes nothing', async () => {
    for (const argv of [['extra'], ['--nope']]) {
      const refused = await runInit(argv)
      expect(refused.code).toBe(1)
      expect(refused.stdout).toBe('')
      expect(refused.stderr).toContain('Usage: warpline init')
    }
    expect(readdirSync(home)).toEqual([])
  })

  test('9: the seed is a shipped example that declares no side effect and carries a working default', async () => {
    const shipped = join(REPO_ROOT, 'examples', 'plugins', SEED_EXAMPLE)
    expect(existsSync(join(shipped, 'manifest.ts'))).toBe(true)
    const { manifest } = (await import(join(shipped, 'manifest.ts'))) as {
      manifest: { side_effects: string[]; dependencies: string[]; inputs: Record<string, { default?: unknown }> }
    }
    expect(manifest.side_effects).toEqual([])
    expect(manifest.dependencies).toEqual([])
    expect(Object.values(manifest.inputs).some((input) => input.default !== undefined)).toBe(true)
  })

  // -------------------------------------------------------------------------
  // The terminal branch: the seed's declared inputs are asked for, through
  // the same walk configure runs. Off a terminal nothing below changes.
  // -------------------------------------------------------------------------

  test('10: on a terminal, a fresh home is asked for each declared input in declaration order, and the answers become the config', async () => {
    // `e` + COMBINING ACUTE ACCENT stays decomposed: a comparison of decoded
    // strings can pass while a normalisation has happened, so compare bytes.
    const path = 'caf\u00e9 e\u0301 \u65e5\u672c \u{1f4a1}/metrics.json'
    const { code, stdout, stderr, out } = await runInit([], tty([path, '30']))
    expect(code).toBe(0)
    expect(stderr).toBe('')

    const first = out.indexOf('metrics_path>')
    const second = out.indexOf('retention_days>')
    expect(first).toBeGreaterThanOrEqual(0)
    expect(second).toBeGreaterThan(first)
    expect(out).toContain('default 90')
    expect(out).toContain('Path to a metrics JSON file')
    expect(out).toContain('Rows older than this many days')

    const written = readConfig()
    expect(Object.keys(written)).toEqual(['metrics_path', 'retention_days'])
    expect(written).toEqual({ metrics_path: path, retention_days: 30 })
    expect(typeof written.retention_days).toBe('number')
    expect(readFileSync(configFile()).includes(Buffer.from('e\u0301', 'utf8'))).toBe(true)

    expect(stdout).toContain('Wrote')
    expect(stdout).not.toContain('Still needed')

    const previewed = await capture(() => plan([]))
    expect(previewed.code).toBe(0)
    expect(previewed.stdout).toContain('Due (1):')
    expect(previewed.stdout).toContain(`${SEED_EXAMPLE} (level 0)`)
  })

  test('11: on a terminal, Enter at every prompt writes the same bytes the piped path writes', async () => {
    expect((await runInit([], tty(['', '']))).code).toBe(0)
    const fromTerminal = readFileSync(configFile())
    rmSync(configFile())

    expect((await runInit()).code).toBe(0)
    const fromPipe = readFileSync(configFile())

    expect(fromTerminal.equals(fromPipe)).toBe(true)
    expect(readConfig()).toEqual({ retention_days: 90 })
  })

  test('12: a second init on a terminal asks nothing and leaves the whole home byte-identical', async () => {
    expect((await runInit([], tty(['', '']))).code).toBe(0)
    const first = await snapshotHome(home)

    const sentinel = 'do-not-read-me'
    const again = await runInit([], tty([sentinel, '1']))
    expect(again.code).toBe(0)
    expect(again.out).toBe('')
    expect(await snapshotHome(home)).toEqual(first)
    expect(readFileSync(configFile(), 'utf8')).not.toContain(sentinel)
  })

  test('13: a piped stdin with answers on it is not read: the defaults are written and nothing is asked', async () => {
    const { code, stderr, out } = await runInit([], fastPipe(['state/x.json', '7']))
    expect(code).toBe(0)
    expect(stderr).toBe('')
    expect(out).toBe('')
    expect(readConfig()).toEqual({ retention_days: 90 })
    expect(readFileSync(configFile(), 'utf8')).not.toContain('state/x.json')
  })

  test('14: input ending mid-walk is a refusal that writes no config and leaves the home usable; a rerun asks again', async () => {
    const refused = await runInit([], tty(['only-one']))
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain('No config was written')
    expect(existsSync(configFile())).toBe(false)
    expect(configSiblings()).toEqual([])
    expect(existsSync(seedDir())).toBe(true)
    expect(existsSync(join(home, 'node_modules', 'warpline'))).toBe(true)

    const again = await runInit([], tty(['', '']))
    expect(again.code).toBe(0)
    expect(existsSync(configFile())).toBe(true)
  })

  test('15: a declared secret is never asked for by init: the env var is named, the key is absent from the file', async () => {
    placeSeedManifest(
      'fixture with a secret among its inputs',
      {
        token: { type: 'string', description: 'An API token.' },
        limit: { type: 'number', required: false, default: 10, description: 'Defaulted.' },
      },
      ['token'],
    )
    // The sentinel is supplied anyway, as the last line; a walk that asked for
    // the token would consume it.
    const sentinel = 'do-not-persist-init'
    const { code, stdout, stderr, out } = await runInit([], tty(['', sentinel]))
    expect(code).toBe(0)
    expect(out).not.toContain('token>')
    expect(out).toContain('token')
    expect(out).toMatch(/environment variable/)

    expect(Object.keys(readConfig())).toEqual(['limit'])
    const raw = readFileSync(configFile(), 'utf8')
    for (const text of [raw, stdout, stderr, out]) expect(text).not.toContain(sentinel)
  })
})
