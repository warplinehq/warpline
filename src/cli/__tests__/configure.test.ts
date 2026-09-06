/**
 * `warpline configure` and the line-reader seam under it — in-process tests.
 *
 * The reader is driven by INJECTED streams, never by a spawned process with
 * answers piped to it. Piping is the path the research measured as unreliable
 * for the naive primitive, and a test that fed answers slowly would pass with
 * that primitive too. The fast-pipe case below is the one that discriminates.
 *
 * `configure` resolves every path through `src/lib/paths.ts`, so `_setHome`
 * on a fresh temp home per test is the whole injection story. Fixture
 * manifests are zero-import `export const manifest = {…}` files, the shape
 * approve.test.ts uses, so they stay out of the `warpline/*` resolution path.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { isInteractive, lineReader } from '../prompt.js'
import { run, writePluginConfig } from '../configure.js'
import { _setHome, pluginConfigPath, pluginsDir } from '../../lib/paths.js'
import { loadPluginConfig } from '../../lib/plugin-config.js'
import { snapshotHome } from '../../runtime/__tests__/helpers/snapshot-home.js'

// ---------------------------------------------------------------------------
// Stream helpers
// ---------------------------------------------------------------------------

/** A writable that keeps everything written to it. */
class Sink extends Writable {
  text = ''
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.text += chunk.toString()
    cb()
  }
}

/** Every line in ONE chunk: what a fast pipe delivers. */
function fastPipe(lines: string[]): Readable {
  return Readable.from([lines.map((l) => `${l}\n`).join('')])
}

/** One line per chunk with a pause between: what a human, or a slow pipe, delivers. */
function slowFeed(lines: string[], gapMs = 5): Readable {
  return Readable.from(
    (async function* () {
      for (const l of lines) {
        yield `${l}\n`
        await new Promise((r) => setTimeout(r, gapMs))
      }
    })(),
  )
}

const HUNG = '<hung>'

/**
 * A hang is the failure mode under test, so every ask races a deadline and a
 * hang lands as the sentinel in the collected array — an assertion failure
 * that names what happened, rather than a suite timeout that does not.
 */
async function askAll(input: Readable, output: Writable, prompts: string[]): Promise<unknown[]> {
  const reader = lineReader(input, output)
  const got: unknown[] = []
  try {
    for (const p of prompts) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const deadline = new Promise<string>((r) => {
        timer = setTimeout(() => r(HUNG), 2000)
      })
      const answer = reader.ask(p).catch((err: unknown) => `threw: ${err instanceof Error ? err.name : String(err)}`)
      got.push(await Promise.race([answer, deadline]))
      clearTimeout(timer)
    }
  } finally {
    reader.close()
  }
  return got
}

// ---------------------------------------------------------------------------
// lineReader
// ---------------------------------------------------------------------------

describe('lineReader', () => {
  test('fast pipe: three questions over two lines delivered in ONE chunk return both values then null, with no hang', async () => {
    const out = new Sink()
    const got = await askAll(fastPipe(['alpha', 'beta']), out, ['q1? ', 'q2? ', 'q3? '])
    expect(got).toEqual(['alpha', 'beta', null])
  })

  test('slow feed: the same three questions return the same result', async () => {
    const out = new Sink()
    const got = await askAll(slowFeed(['alpha', 'beta']), out, ['q1? ', 'q2? ', 'q3? '])
    expect(got).toEqual(['alpha', 'beta', null])
  })

  test('EOF: asking past the end returns null rather than hanging, and keeps returning null', async () => {
    const out = new Sink()
    const got = await askAll(Readable.from([]), out, ['q1? ', 'q2? '])
    expect(got).toEqual([null, null])
  })

  test('empty answer: a blank line returns the empty string, which is distinct from null', async () => {
    const out = new Sink()
    const got = await askAll(fastPipe(['']), out, ['q1? ', 'q2? '])
    expect(got).toEqual(['', null])
  })

  test('encoding: a non-ASCII, non-normalised line comes back byte for byte', async () => {
    // `e` + COMBINING ACUTE ACCENT, spelled as escapes so no editor can
    // normalise it away; NFC would fold it to U+00E9.
    const line = 'caf\u00e9 e\u0301 \u65e5\u672c \u{1f4a1}'
    const out = new Sink()
    const got = await askAll(Readable.from([Buffer.from(`${line}\n`, 'utf8')]), out, ['q? '])
    expect(got).toEqual([line])
    expect(Buffer.from(got[0] as string, 'utf8').equals(Buffer.from(line, 'utf8'))).toBe(true)
  })

  test('output: the prompt text is written to the injected output stream', async () => {
    const out = new Sink()
    await askAll(fastPipe(['a', 'b']), out, ['first> ', 'second> ', 'third> '])
    expect(out.text).toBe('first> second> third> ')
  })
})

describe('isInteractive', () => {
  test('a piped stdin reports isTTY as undefined, and that is not interactive', () => {
    expect(isInteractive({ isTTY: undefined })).toBe(false)
    expect(isInteractive({})).toBe(false)
    expect(isInteractive({ isTTY: false })).toBe(false)
    expect(isInteractive({ isTTY: true })).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// configure — fixtures
// ---------------------------------------------------------------------------

type Input = { type: string; required?: boolean; default?: unknown; description?: string }

function makeManifest(name: string, inputs: Record<string, Input>, secrets: string[] = []) {
  return {
    name,
    version: '1.0.0',
    description: `${name} fixture plugin`,
    inputs,
    outputs: {},
    capabilities: [],
    secrets,
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
}

/** Four inputs whose declaration order is not alphabetical, so sorting would show. */
const FOUR: Record<string, Input> = {
  zulu: { type: 'string', description: 'The first one declared.' },
  alpha: { type: 'string', description: 'The second.' },
  mike: { type: 'string', required: false, description: 'The third, optional.' },
  bravo: { type: 'string', description: 'The fourth.' },
}
const FOUR_ANSWERS = ['one', 'two', 'three', 'four']
const FOUR_BODY = { zulu: 'one', alpha: 'two', mike: 'three', bravo: 'four' }

let root: string
let home: string

beforeEach(() => {
  // A fresh random root per test: the manifest loader imports fixtures, and a
  // rewritten file at a reused path would be served from the module cache.
  root = mkdtempSync(join(tmpdir(), 'warpline-configure-'))
  home = join(root, 'home')
  mkdirSync(join(home, 'plugins'), { recursive: true })
  _setHome(home)
})

afterEach(() => {
  _setHome(null)
  rmSync(root, { recursive: true, force: true })
})

async function seed(manifest: { name: string }): Promise<void> {
  const dir = join(pluginsDir(), manifest.name)
  mkdirSync(dir, { recursive: true })
  await writeFile(join(dir, 'manifest.ts'), `export const manifest = ${JSON.stringify(manifest)}`)
}

/** An injected stdin that claims to be a terminal, so the walk is allowed to prompt. */
function tty(lines: string[]): Readable & { isTTY?: boolean } {
  return Object.assign(fastPipe(lines), { isTTY: true })
}

interface Outcome {
  code: number
  stdout: string
  stderr: string
  /** Everything the walk wrote to the injected output stream. */
  out: string
}

/**
 * Containment: the process working directory and the temp root, before and
 * after, with the resolved home the ONLY place anything may appear or change.
 *
 * The temp root is the mkdtemp parent that CONTAINS the home, not the
 * system temp dir: other test files and other processes write there and a
 * walk over it would flake. The root's sibling area beside `home/` is what
 * catches a write that escaped the home by one level. The cwd is listed one
 * level deep as name, size and mtime: a file created or removed directly in
 * the repository shows as a new entry or a changed directory mtime.
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

/**
 * Run `configure` in-process with the process streams captured. Every
 * invocation in this file goes through here, so every one — the refusals
 * included — is inside the containment bracket.
 */
async function capture(argv: string[], input?: Readable & { isTTY?: boolean }): Promise<Outcome> {
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
    const out = new Sink()
    try {
      const code = input ? await run(argv, { input, output: out }) : await run(argv)
      return { code, stdout, stderr, out: out.text }
    } finally {
      process.stdout.write = realOut
      process.stderr.write = realErr
    }
  })
}

/** The bytes the atomic writer emits for `value`: pretty-printed, no trailing newline. */
const jsonBytes = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2), 'utf8')

/** Anything left beside `<plugin>.json` in the config directory: a temp sibling that was never renamed away. */
function configSiblings(name: string): string[] {
  const dir = dirname(pluginConfigPath(name))
  return existsSync(dir) ? readdirSync(dir).filter((f) => f !== `${name}.json`) : []
}

const readConfig = async (name: string) => JSON.parse(await readFile(pluginConfigPath(name), 'utf8')) as Record<string, unknown>

// ---------------------------------------------------------------------------
// configure — the walk
// ---------------------------------------------------------------------------

describe('configure — the walk', () => {
  test('1: prompts for declared inputs in DECLARATION order, and the written file carries the same key order', async () => {
    await seed(makeManifest('four', FOUR))
    const { code, out } = await capture(['four'], tty(FOUR_ANSWERS))
    expect(code).toBe(0)

    const positions = Object.keys(FOUR).map((k) => out.indexOf(`${k}>`))
    expect(positions.every((p) => p >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)

    // Each prompt shows the description, the type and whether it is required.
    expect(out).toContain('The first one declared.')
    expect(out).toContain('string')
    expect(out).toContain('required')
    expect(out).toContain('optional')

    expect(Object.keys(await readConfig('four'))).toEqual(['zulu', 'alpha', 'mike', 'bravo'])
    expect(await readConfig('four')).toEqual(FOUR_BODY)
  })

  test('2: a plugin declaring zero inputs prompts nothing, exits 0, and writes a file loadPluginConfig parses', async () => {
    await seed(makeManifest('bare', {}))
    const { code, out } = await capture(['bare'], tty([]))
    expect(code).toBe(0)
    expect(out).not.toContain('>')
    expect(existsSync(pluginConfigPath('bare'))).toBe(true)
    expect(await loadPluginConfig(pluginConfigPath('bare'))).toEqual({})
  })

  test('3: a name in BOTH inputs and secrets is not prompted for, the env var is named, and the key is ABSENT from the file', async () => {
    await seed(
      makeManifest(
        'sec',
        {
          repo: { type: 'string' },
          token: { type: 'string', description: 'An API token.' },
          label: { type: 'string' },
        },
        ['token'],
      ),
    )
    // The sentinel is supplied anyway, as the last line; a walk that asked for
    // the token would consume it.
    const sentinel = 'do-not-persist-walk'
    const { code, out, stdout, stderr } = await capture(['sec'], tty(['acme/widgets', 'bugs', sentinel]))
    expect(code).toBe(0)
    expect(out).not.toContain('token>')
    expect(out).toContain('token')
    expect(out).toMatch(/environment variable/)

    const parsed = await readConfig('sec')
    expect(Object.keys(parsed)).toEqual(['repo', 'label'])
    expect('token' in parsed).toBe(false)
    const raw = await readFile(pluginConfigPath('sec'), 'utf8')
    for (const text of [raw, out, stdout, stderr]) expect(text).not.toContain(sentinel)
  })

  test('6: a non-ASCII, non-normalised answer round-trips through the written file byte for byte', async () => {
    await seed(makeManifest('uni', { note: { type: 'string' } }))
    // `e` + COMBINING ACUTE ACCENT stays decomposed: a comparison of decoded
    // strings can pass while a normalisation has happened, so compare bytes.
    const line = 'caf\u00e9 e\u0301 \u65e5\u672c \u{1f4a1}'
    const { code } = await capture(['uni'], tty([line]))
    expect(code).toBe(0)
    const written = await readFile(pluginConfigPath('uni'))
    expect(written.equals(jsonBytes({ note: line }))).toBe(true)
    expect(written.includes(Buffer.from('é', 'utf8'))).toBe(true)
    expect(written.includes(Buffer.from('\u00e9 \u65e5', 'utf8'))).toBe(false)
  })

  test('7: input ending before every question is answered is a refusal: no file where none existed, an existing file byte-identical, no temp sibling', async () => {
    await seed(makeManifest('four', FOUR))
    const { code, stderr } = await capture(['four'], tty(['one']))
    expect(code).toBe(1)
    expect(stderr).toMatch(/[Nn]othing was written/)
    expect(existsSync(pluginConfigPath('four'))).toBe(false)
    expect(configSiblings('four')).toEqual([])

    // Now with a config already on disk: the refusal leaves it byte-identical.
    const seeded = await capture(['four', '--from', JSON.stringify(FOUR_BODY)])
    expect(seeded.code).toBe(0)
    const before = await readFile(pluginConfigPath('four'))
    const refused = await capture(['four'], tty(['changed']))
    expect(refused.code).toBe(1)
    expect((await readFile(pluginConfigPath('four'))).equals(before)).toBe(true)
    expect(configSiblings('four')).toEqual([])
  })

  test('9: an empty answer takes the default; a required input with no default and no answer is reported, not written as undefined', async () => {
    await seed(
      makeManifest('def', {
        a: { type: 'string', required: true, default: 'placeholder-a' },
        b: { type: 'string', required: true },
        c: { type: 'string', required: false },
      }),
    )
    const { code, stdout, out } = await capture(['def'], tty(['', '', '']))
    expect(code).toBe(0)
    expect(out).toContain('placeholder-a')
    expect(await readConfig('def')).toEqual({ a: 'placeholder-a' })
    expect(await readFile(pluginConfigPath('def'), 'utf8')).not.toContain('undefined')
    expect(stdout).toContain('b')
    expect(stdout).toContain('warpline configure def')
    expect(stdout).not.toMatch(/\bc\b/)
  })

  test('a typed answer for a number input is validated by the resolver, reported, and asked again; the accepted value is a number', async () => {
    await seed(makeManifest('typed', { n: { type: 'number' } }))
    const { code, out } = await capture(['typed'], tty(['abc', '42']))
    expect(code).toBe(0)
    expect(out).toContain("input 'n' must be a number")
    expect(out).not.toContain('abc')
    expect((await readConfig('typed')).n).toBe(42)
  })

  test('a stdin that is not a terminal is refused before any prompt, pointing at --from', async () => {
    await seed(makeManifest('four', FOUR))
    const { code, stderr, out } = await capture(['four'], fastPipe(FOUR_ANSWERS))
    expect(code).toBe(1)
    expect(stderr).toContain('--from')
    expect(out).toBe('')
    expect(existsSync(pluginConfigPath('four'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// configure — --from <json>
// ---------------------------------------------------------------------------

describe('configure — --from <json>', () => {
  test('4: writes the same config as the equivalent walk with no prompt and no TTY, and refuses a body the resolver rejects', async () => {
    await seed(makeManifest('four', FOUR))
    const walked = await capture(['four'], tty(FOUR_ANSWERS))
    expect(walked.code).toBe(0)
    const walkedBytes = await readFile(pluginConfigPath('four'))
    rmSync(pluginConfigPath('four'))

    const { code, out, stdout } = await capture(['four', '--from', JSON.stringify(FOUR_BODY)])
    expect(code).toBe(0)
    expect(out).toBe('')
    expect(stdout).not.toContain('>')
    expect((await readFile(pluginConfigPath('four'))).equals(walkedBytes)).toBe(true)
    rmSync(pluginConfigPath('four'))

    // A wrong type: refused through the resolver's own problem string, naming
    // the key and the shape and never the value.
    const bad = await capture(['four', '--from', JSON.stringify({ ...FOUR_BODY, zulu: 7 })])
    expect(bad.code).toBe(1)
    expect(bad.stderr).toContain("input 'zulu' must be a string")
    expect(bad.stderr).not.toContain('7')
    expect(existsSync(pluginConfigPath('four'))).toBe(false)
    expect(configSiblings('four')).toEqual([])

    // The same refusal against a config already on disk leaves it byte-identical.
    const seeded = await capture(['four', '--from', JSON.stringify(FOUR_BODY)])
    expect(seeded.code).toBe(0)
    const before = await readFile(pluginConfigPath('four'))
    const badAgain = await capture(['four', '--from', JSON.stringify({ ...FOUR_BODY, alpha: ['no'] })])
    expect(badAgain.code).toBe(1)
    expect((await readFile(pluginConfigPath('four'))).equals(before)).toBe(true)
    expect(configSiblings('four')).toEqual([])
    rmSync(pluginConfigPath('four'))

    // A key no input declares.
    const extra = await capture(['four', '--from', JSON.stringify({ ...FOUR_BODY, extra: 'e' })])
    expect(extra.code).toBe(1)
    expect(extra.stderr).toContain("'extra'")
    expect(existsSync(pluginConfigPath('four'))).toBe(false)

    // Not JSON, and not an object: refused without echoing the body.
    const broken = await capture(['four', '--from', '{"zulu": "secret-looking-value'])
    expect(broken.code).toBe(1)
    expect(broken.stderr).not.toContain('secret-looking-value')
    const array = await capture(['four', '--from', '["one"]'])
    expect(array.code).toBe(1)
    expect(existsSync(pluginConfigPath('four'))).toBe(false)
  })

  test('3b: a secret value supplied through --from is refused, the env var is named, and the value reaches neither the file nor a stream', async () => {
    await seed(makeManifest('sec', { repo: { type: 'string' }, token: { type: 'string' } }, ['token']))
    const sentinel = 'do-not-persist-from'
    const { code, stdout, stderr } = await capture(['sec', '--from', JSON.stringify({ repo: 'acme/widgets', token: sentinel })])
    expect(code).toBe(1)
    expect(stderr).toContain('token')
    expect(stderr).toMatch(/environment variable/)
    expect(existsSync(pluginConfigPath('sec'))).toBe(false)
    for (const text of [stdout, stderr]) expect(text).not.toContain(sentinel)

    // Without the value the write goes ahead, the key is absent, and the note names the variable.
    const ok = await capture(['sec', '--from', JSON.stringify({ repo: 'acme/widgets' })])
    expect(ok.code).toBe(0)
    expect(ok.stdout).toContain('token')
    expect(ok.stdout).toMatch(/environment variable/)
    expect(Object.keys(await readConfig('sec'))).toEqual(['repo'])
  })

  test('5: a __proto__ key in the body is refused and Object.prototype is unpolluted afterwards', async () => {
    await seed(makeManifest('four', FOUR))
    const body = `{"__proto__": {"polluted": true}, ${JSON.stringify(FOUR_BODY).slice(1)}`
    const { code, stderr } = await capture(['four', '--from', body])
    expect(code).toBe(1)
    expect(stderr).toContain('Object.prototype')
    expect(existsSync(pluginConfigPath('four'))).toBe(false)
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false)
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined()
  })

  test('6b: a non-ASCII, non-normalised value round-trips through --from byte for byte', async () => {
    await seed(makeManifest('uni', { note: { type: 'string' } }))
    const line = 'caf\u00e9 e\u0301 \u65e5\u672c \u{1f4a1}'
    const { code } = await capture(['uni', '--from', JSON.stringify({ note: line })])
    expect(code).toBe(0)
    const written = await readFile(pluginConfigPath('uni'))
    expect(written.equals(jsonBytes({ note: line }))).toBe(true)
    expect(written.includes(Buffer.from('é', 'utf8'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// configure — refusals before any path is built, and containment
// ---------------------------------------------------------------------------

describe('configure — refusals', () => {
  test('a plugin name outside [a-z][a-z0-9-]* is refused before any path is built', async () => {
    for (const name of ['../four', 'Four', 'four/x', '4our']) {
      const { code, stderr } = await capture([name])
      expect(code).toBe(1)
      expect(stderr).toContain('Invalid plugin name')
      const viaFrom = await capture([name, '--from', '{}'])
      expect(viaFrom.code).toBe(1)
      expect(viaFrom.stderr).toContain('Invalid plugin name')
    }
    expect(existsSync(join(home, 'config'))).toBe(false)
  })

  test('a missing plugin is refused with a message naming it and where it was looked for', async () => {
    await seed(makeManifest('four', FOUR))
    const { code, stderr } = await capture(['fuor', '--from', '{}'])
    expect(code).toBe(1)
    expect(stderr).toContain('fuor')
    expect(stderr).toContain(pluginsDir())
    expect(existsSync(join(home, 'config'))).toBe(false)
  })

  test('8: every invocation above ran inside the containment bracket, and the bracket has teeth', async () => {
    // `capture` brackets every call, refusals included. This case proves the
    // bracket itself: a write that lands beside the home, not under it, fails.
    await seed(makeManifest('four', FOUR))
    const { code } = await capture(['four', '--from', JSON.stringify(FOUR_BODY)])
    expect(code).toBe(0)
    expect(pluginConfigPath('four').startsWith(`${home}/`)).toBe(true)

    let caught: unknown
    try {
      await contained(async () => {
        await writeFile(join(root, 'escaped.json'), '{}')
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeDefined()
  })
})

describe('writePluginConfig — the non-interactive core', () => {
  test('fills declared defaults, reports required keys with no value, skips secrets, and writes once', async () => {
    await seed(
      makeManifest(
        'core',
        {
          a: { type: 'string', default: 'placeholder-a' },
          b: { type: 'number' },
          token: { type: 'string' },
          c: { type: 'boolean', required: false },
        },
        ['token'],
      ),
    )
    const result = await contained(() => writePluginConfig('core', {}))
    expect(result.written).toEqual(['a'])
    expect(result.needed).toEqual(['b'])
    expect(result.secrets).toEqual(['token'])
    expect(await readConfig('core')).toEqual({ a: 'placeholder-a' })

    const again = await contained(() => writePluginConfig('core', { b: 3, c: true }))
    expect(again.written).toEqual(['a', 'b', 'c'])
    expect(again.needed).toEqual([])
    expect(await readConfig('core')).toEqual({ a: 'placeholder-a', b: 3, c: true })
    expect(configSiblings('core')).toEqual([])
  })

  test('refuses a wrong-typed value through the resolver and leaves an existing file untouched', async () => {
    await seed(makeManifest('core', { a: { type: 'number' } }))
    await contained(() => writePluginConfig('core', { a: 1 }))
    const before = await readFile(pluginConfigPath('core'))
    await contained(async () => {
      await expect(writePluginConfig('core', { a: 'one' })).rejects.toThrow("input 'a' must be a number")
    })
    expect((await readFile(pluginConfigPath('core'))).equals(before)).toBe(true)
    expect(configSiblings('core')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// configure — every shipped example, from its own declared inputs
// ---------------------------------------------------------------------------

const EXAMPLES_DIR = join(import.meta.dir, '..', '..', '..', 'examples', 'plugins')

/** One declared input as the manifest schema emits it. */
type ShippedInput = { type?: string; required?: boolean; default?: unknown }
type ShippedManifest = { name: string; inputs?: Record<string, ShippedInput>; secrets?: string[] }

/** A shipped example's manifest, loaded the way the runtime loads it. */
async function shippedManifest(name: string): Promise<ShippedManifest> {
  const mod = (await import(join(EXAMPLES_DIR, name, 'manifest.ts'))) as { manifest: ShippedManifest }
  return mod.manifest
}

/**
 * The body `--from` takes, built from the manifest's OWN declared inputs:
 * every input carrying a default, at that default. A name in `secrets` is
 * left out even when it carries one — the verb refuses to persist a secret,
 * and a loop that fed it one would be testing the refusal, not the walk.
 */
function bodyFromDefaults(manifest: ShippedManifest): Record<string, unknown> {
  const secrets = new Set(manifest.secrets ?? [])
  const body: Record<string, unknown> = {}
  for (const [key, input] of Object.entries(manifest.inputs ?? {})) {
    if (input.default !== undefined && !secrets.has(key)) body[key] = input.default
  }
  return body
}

/**
 * Seed the manifest as parsed data — the fixture form this file already
 * uses — run `configure <name> --from <its own defaults>` against the temp
 * home, and read back what was written through the runtime's own loader.
 */
async function configureFromOwnInputs(manifest: ShippedManifest) {
  await seed(manifest)
  const { code, stdout, stderr } = await capture([manifest.name, '--from', JSON.stringify(bodyFromDefaults(manifest))])
  const config = code === 0 ? await loadPluginConfig(pluginConfigPath(manifest.name)) : null
  return { code, stdout, stderr, config }
}

describe('configure — every shipped example, from its own declared inputs', () => {
  test('for EVERY directory under examples/plugins, --from built from the manifest\'s own defaults exits 0 and the written file parses through loadPluginConfig', async () => {
    // What this loop proves, and what it does NOT. It proves that a config
    // built from each example's declared defaults PARSES: the resolver
    // accepts it and `loadPluginConfig` reads it back. It does not prove
    // where those defaults came from. A default copied out of somebody's
    // real deployment parses exactly as well as a placeholder, and this loop
    // is green over it. Provenance is `src/__tests__/example-defaults.test.ts`'s
    // job — the guard to read before trusting a default. Two checks, two
    // properties; neither stands in for the other.
    const dirs = readdirSync(EXAMPLES_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
    // Iterated over the directory, never a roster, and guarded against an
    // empty glob: fewer directories than the tree is known to hold is a
    // wrong path, not a shorter roster.
    expect(dirs.length).toBeGreaterThanOrEqual(12)

    for (const name of dirs) {
      const manifest = await shippedManifest(name)
      const body = bodyFromDefaults(manifest)
      const { code, stderr, config } = await configureFromOwnInputs(manifest)
      // The example name in the assertion, so a red names the directory.
      expect({ name, code, stderr }).toEqual({ name, code: 0, stderr: '' })
      expect(config).not.toBeNull()
      // Every defaulted input made it to the file, at its declared value.
      expect(Object.fromEntries(Object.keys(body).map((k) => [k, config![k]]))).toEqual(body)
    }
  })

  test('a plugin declaring a name in both inputs and secrets: the same loop still omits the key from the written file', async () => {
    // No shipped example declares this shape — a credential is declared in
    // `secrets` alone — so the case is a fixture, driven through the same
    // body builder and the same invocation the loop above uses.
    const manifest = makeManifest(
      'both',
      {
        repo: { type: 'string', default: 'example-owner/example-repo' },
        token: { type: 'string', default: 'your-token', description: 'An API token.' },
      },
      ['token'],
    )
    const { code, stdout, config } = await configureFromOwnInputs(manifest)
    expect(code).toBe(0)
    expect(config).toEqual({ repo: 'example-owner/example-repo' })
    expect(Object.hasOwn(config!, 'token')).toBe(false)
    expect(await readFile(pluginConfigPath('both'), 'utf8')).not.toContain('your-token')
    expect(stdout).toContain('token')
    expect(stdout).toMatch(/environment variable/)
  })
})
