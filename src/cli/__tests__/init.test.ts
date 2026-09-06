/**
 * `warpline init` — in-process tests.
 *
 * The claim under test is the first-run one: an operator with an EMPTY home
 * runs one command and the next `warpline plan` renders an advance, with no
 * file authored by hand. Its negative control lives here too: the same
 * `plan` on a home nobody initialised renders a page but no advance.
 *
 * Both verbs are called through their exported `run(argv)` and never through
 * a spawned process. `init` resolves every path through `src/lib/paths.ts`,
 * so `_setHome` on a fresh temp home per test is the whole injection story.
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

const seedDir = () => join(pluginsDir(), SEED_EXAMPLE)

// ---------------------------------------------------------------------------
// The claim and its control
// ---------------------------------------------------------------------------

describe('warpline init', () => {
  test('1: init in an empty home, then plan, renders an advance — nothing hand-authored', async () => {
    expect(readdirSync(home)).toEqual([])

    const initialised = await capture(() => init([]))
    expect(initialised.code).toBe(0)
    expect(initialised.stderr).toBe('')

    const previewed = await capture(() => plan([]))
    expect(previewed.code).toBe(0)
    expect(previewed.stdout).toMatch(/^Due \(/m)
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
    expect(previewed.stdout).toContain('No plugins installed.')
    expect(await snapshotHome(home)).toEqual(before)
  })

  test('3: a second init leaves the whole home byte-identical', async () => {
    expect((await capture(() => init([]))).code).toBe(0)
    const first = await snapshotHome(home)
    expect(first.length).toBeGreaterThan(0)

    const again = await capture(() => init([]))
    expect(again.code).toBe(0)
    expect(await snapshotHome(home)).toEqual(first)
  })

  test('4: init over an operator-edited config leaves that file byte-identical', async () => {
    expect((await capture(() => init([]))).code).toBe(0)
    const configPath = pluginConfigPath(SEED_EXAMPLE)
    expect(existsSync(configPath)).toBe(true)

    const edited = '{\n  "retention_days": 7\n}\n'
    writeFileSync(configPath, edited)
    const editedBytes = readFileSync(configPath)

    const again = await capture(() => init([]))
    expect(again.code).toBe(0)
    expect(readFileSync(configPath).equals(editedBytes)).toBe(true)
  })

  test('5: init creates the home artifacts a plugin needs to load, plus config/ and the seed', async () => {
    expect((await capture(() => init([]))).code).toBe(0)

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
    // Pre-placed at the seed's own name, so init skips the copy and writes
    // config for what it finds: the path an operator hits after editing the
    // seeded plugin's manifest.
    mkdirSync(seedDir(), { recursive: true })
    writeFileSync(
      join(seedDir(), 'manifest.ts'),
      `export const manifest = ${JSON.stringify({
        name: SEED_EXAMPLE,
        version: '1.0.0',
        description: 'fixture with one undefaulted required input',
        inputs: {
          address: { type: 'string', required: true, description: 'No default on purpose.' },
          limit: { type: 'number', required: false, default: 10, description: 'Defaulted.' },
        },
        outputs: {},
        capabilities: [],
        secrets: [],
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
      })}`,
    )

    const initialised = await capture(() => init([]))
    expect(initialised.code).toBe(0)

    const written = JSON.parse(readFileSync(pluginConfigPath(SEED_EXAMPLE), 'utf8')) as Record<string, unknown>
    expect(written).toEqual({ limit: 10 })

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
      const refused = await capture(() => init(argv))
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
})
