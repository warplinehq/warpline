/**
 * Every bundled example declares which recurring shape it demonstrates, and
 * proves it by doing the shape's defining act.
 *
 * The registry is test-side, not a manifest field: the manifest is the one
 * contract surface the pre-1.0 stability promise covers, and a number only a
 * test reads has no business there. An example added without an entry here
 * fails by omission, and the failure names the directory.
 *
 * The assertion is over the ACT, never the label. A plugin may say it diffs
 * against history; this file runs it twice in one home and checks that the
 * second run read what the first wrote. Coverage by declaration is what let
 * the tree carry six examples and one demonstrated shape for a year.
 *
 * Why this lives under `src/__tests__/` and not `examples/`: an act needs a
 * controlled home, the handlers import `warpline/lib/paths` through the
 * exports map into `dist/`, and `import-direction.test.ts` refuses any reach
 * from `examples/` into `src/`. The home is swapped through the env var,
 * because that is the seam the `dist/` copy of `paths.ts` actually reads —
 * `_setHome` from `src/lib/paths.js` mutates a different module instance and
 * was measured not to reach a handler (a run under it wrote into the preload's
 * home, not the swapped one).
 *
 * No act reaches the network. Three examples make outbound requests, and each
 * act over one of them stubs `globalThis.fetch` and restores it in the same
 * `finally` — the mechanism their own `handler.test.ts` files use.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CapabilityContext } from '../runtime/capabilities.js'

const EXAMPLES = join(import.meta.dir, '..', '..', 'examples', 'plugins')

type Shape = 1 | 2 | 3 | 4 | 5 | 6 | 7

interface ShapeEntry {
  readonly shape: Shape
  /** The directory under examples/plugins. */
  readonly example: string
  /**
   * Set when the act proves only part of the shape. A partial entry keeps the
   * directory registered and its act honest, and does NOT discharge its shape:
   * the completeness assertion owed at the bottom of this file must not count
   * it as covering the number it carries.
   */
  readonly partial?: string
  /** Runs the real handler in `home` and returns true only if the defining act happened. */
  readonly act: (home: string) => Promise<boolean>
}

// ── Act plumbing ─────────────────────────────────────────────────────────

/** The handler is four-parameter; no act reads a member, so an empty context is enough. */
const CONTEXT = {} as CapabilityContext
const signal = () => new AbortController().signal

/** Write a JSON fixture under the home, creating the parent. */
function seed(home: string, rel: string, value: unknown): void {
  mkdirSync(join(home, rel, '..'), { recursive: true })
  writeFileSync(join(home, rel), JSON.stringify(value))
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

/** Swap `globalThis.fetch` for the duration of `fn`; restore whatever happens. */
async function withFetch<T>(impl: (input: unknown, init?: RequestInit) => Promise<unknown>, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch
  globalThis.fetch = impl as unknown as typeof fetch
  try {
    return await fn()
  } finally {
    globalThis.fetch = real
  }
}

/** Set one env var for the duration of `fn`; restore whatever happens. */
async function withEnv<T>(name: string, value: string, fn: () => Promise<T>): Promise<T> {
  const real = process.env[name]
  process.env[name] = value
  try {
    return await fn()
  } finally {
    if (real === undefined) delete process.env[name]
    else process.env[name] = real
  }
}

/**
 * A fresh temp home for one act: created, exported as `WARPLINE_HOME`, and
 * removed in the `finally` along with everything the handler wrote there.
 * Nothing an act does lands outside it.
 */
async function inFreshHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'warpline-shape-'))
  try {
    return await withEnv('WARPLINE_HOME', home, () => fn(home))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

// ── The registry ─────────────────────────────────────────────────────────

const REGISTRY: readonly ShapeEntry[] = []

// ── The assertions ───────────────────────────────────────────────────────

const exampleDirs = () =>
  readdirSync(EXAMPLES, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()

describe('the shape registry', () => {
  test('at least three example directories exist, so an empty glob cannot pass the checks below', () => {
    expect(exampleDirs().length).toBeGreaterThanOrEqual(3)
  })

  test('every example directory appears in the registry', () => {
    // Over the NAMES, never a count: a red here has to say which directory
    // was added without declaring what it demonstrates.
    const registered = new Set(REGISTRY.map((e) => e.example))
    expect(exampleDirs().filter((dir) => !registered.has(dir))).toEqual([])
  })

  test('every registry entry names a directory that exists, once, with one shape in 1..7', () => {
    const dirs = new Set(exampleDirs())
    expect(REGISTRY.filter((e) => !dirs.has(e.example)).map((e) => e.example)).toEqual([])
    const names = REGISTRY.map((e) => e.example)
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([])
    expect(REGISTRY.filter((e) => !Number.isInteger(e.shape) || e.shape < 1 || e.shape > 7).map((e) => e.example)).toEqual([])
  })

  test('every registry entry performs its act in a fresh home', async () => {
    for (const entry of REGISTRY) {
      const performed = await inFreshHome((home) => entry.act(home))
      // The example name in the assertion, so a red names the entry.
      expect({ example: entry.example, performed }).toEqual({ example: entry.example, performed: true })
    }
  })
})

// Still owed: the completeness assertion, `[...new Set(REGISTRY.filter(e =>
// !e.partial).map(e => e.shape))].sort()` equal to `[1, 2, 3, 4, 5, 6, 7]`.
// It cannot be green until a dedicated example exists for each of the shapes
// that today have none or only a partial entry (aggregate a dependency's
// Output, derive without storing, take operator input, fan in with per-source
// isolation). Add it in the plan that lands the last of those, not before:
// a red assertion for work that is not this file's would make every
// intervening change red for a reason unrelated to its own.
